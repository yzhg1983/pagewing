// Model lists downloaded from pi.dev on the user's click, laid over pi-ai's bundled catalog (design 6.43).
import type { Api, Model, ModelInputLimits, Provider } from "@earendil-works/pi-ai";
import { getModelType } from "@earendil-works/pi-ai/models";
import { type ModelsUpdated, PROVIDERS, type ProviderId } from "../shared/protocol.ts";

/** The date of pi-ai's bundled catalog; `test/catalog.test.ts` checks it against pi-ai's own. */
export const BUILTIN_MODELS_DATE = Date.parse("2026-10-21T22:33:24.994Z");

const STORAGE_KEY = "downloadedModels";
const CATALOG_URL = "https://pi.dev/api/models/providers/";

type Download = { lastModified: number; models: Model<Api>[] };
/** As read back: content scripts can reach `storage.local` (7.1), so each provider's download is checked again. */
type Stored = { checkedAt: number; providers: Partial<Record<ProviderId, unknown>> };

/** Each provider's bundled chat models, whose API and base URL pairs a download may use. */
const bundled: Partial<Record<ProviderId, readonly Model<Api>[]>> = {};
/** The downloads in use, by provider: only those newer than the bundled catalog. */
let overlay: Partial<Record<ProviderId, readonly Model<Api>[]>> = {};
let stored: Stored | undefined;
let loading: Promise<void> | undefined;
let running: Promise<ModelsUpdated> | undefined;

/** Resolves once the stored download is in use; every model lookup waits for it, so a resumed chat finds its model. */
export function catalogReady(): Promise<void> {
	loading ??= chrome.storage.local
		.get(STORAGE_KEY)
		.then((items) => use(readStored(items[STORAGE_KEY])))
		.catch(() => {
			// The next lookup reads again; an update reads storage itself, so it never writes over what this missed.
			loading = undefined;
		});
	return loading;
}

/** When the model list was last updated from pi.dev, or null. */
export function catalogUpdatedAt(): number | null {
	return stored?.checkedAt ?? null;
}

/**
 * Downloads the four providers' catalogs and lays them over the bundled ones. `listed` gives the models a provider
 * offers the user now; `keyed` names the providers whose new models count. One update runs at a time: a second call
 * joins it. Rejects only when no provider could be updated.
 */
export function updateCatalog(
	listed: (provider: ProviderId) => readonly Model<Api>[],
	keyed: readonly ProviderId[],
): Promise<ModelsUpdated> {
	running ??= runUpdate(listed, keyed).finally(() => {
		running = undefined;
	});
	return running;
}

async function runUpdate(
	listed: (provider: ProviderId) => readonly Model<Api>[],
	keyed: readonly ProviderId[],
): Promise<ModelsUpdated> {
	await catalogReady();
	const providers = Object.keys(PROVIDERS) as ProviderId[];
	const ids = () => new Set(keyed.flatMap((provider) => listed(provider).map((model) => `${provider}/${model.id}`)));
	const before = ids();
	const results = await Promise.allSettled(providers.map(download));
	const failed = providers.filter((_, index) => results[index]?.status === "rejected");
	if (failed.length === providers.length) {
		throw (results[0] as PromiseRejectedResult).reason;
	}
	const previous = readStored((await chrome.storage.local.get(STORAGE_KEY))[STORAGE_KEY]);
	const next: Stored = { checkedAt: Date.now(), providers: { ...previous?.providers } };
	results.forEach((result, index) => {
		const provider = providers[index] as ProviderId;
		if (result.status === "fulfilled") next.providers[provider] = result.value;
	});
	// One write after all four settle: a worker stop mid-update leaves the previous download whole.
	await chrome.storage.local.set({ [STORAGE_KEY]: next });
	use(next);
	const after = ids();
	return { added: [...after].filter((id) => !before.has(id)).length, failed };
}

// OpenRouter, the largest, lists about 400; far more is a broken catalog that would slow every worker start.
const MAX_MODELS = 2_000;

async function download(provider: ProviderId): Promise<Download> {
	const response = await fetch(`${CATALOG_URL}${provider}`, {
		credentials: "omit",
		referrerPolicy: "no-referrer",
		signal: AbortSignal.timeout(10_000),
	});
	if (!response.ok) {
		await response.body?.cancel();
		throw new Error(`pi.dev answered ${response.status}`);
	}
	const lastModified = Date.parse(response.headers.get("last-modified") ?? "");
	const body: unknown = await response.json();
	if (entries(body).length > MAX_MODELS) throw new Error(`pi.dev listed more than ${MAX_MODELS} models`);
	return {
		lastModified: Number.isNaN(lastModified) ? 0 : lastModified,
		models: catalogModels(provider, body, bundled[provider] ?? []),
	};
}

function use(next: Stored | undefined): void {
	stored = next;
	overlay = {};
	for (const provider of Object.keys(PROVIDERS) as ProviderId[]) {
		const entry = next?.providers[provider];
		// A pi-aside update with a newer bundle drops an older download.
		if (!isRecord(entry) || !isNumber(entry.lastModified) || entry.lastModified <= BUILTIN_MODELS_DATE) continue;
		overlay[provider] = catalogModels(provider, entry.models, bundled[provider] ?? []);
	}
}

/** Storage this module wrote; anything else reads as no download. */
function readStored(value: unknown): Stored | undefined {
	if (!isRecord(value) || typeof value.checkedAt !== "number" || !isRecord(value.providers)) return undefined;
	return value as Stored;
}

/**
 * The chat models of a pi.dev catalog response that pi-aside can use for `provider`, rebuilt field by field (wire
 * input). pi-ai picks the key and the stream by `model.provider`, sends to `model.baseUrl`, and lets `model.headers`
 * override the auth headers: so `provider` is the one asked for, the API and base URL must be a pair one of the
 * bundled models has, and `headers` is dropped.
 */
export function catalogModels(provider: ProviderId, body: unknown, bundled: readonly Model<Api>[]): Model<Api>[] {
	const routes = new Set(bundled.map((model) => `${model.api} ${model.baseUrl}`));
	return entries(body).flatMap((entry) => {
		const model = catalogModel(provider, entry, routes);
		return model === undefined ? [] : [model];
	});
}

/** An array, `{models: [...]}` as pi's own client also reads, or an object keyed by ID. */
function entries(body: unknown): unknown[] {
	if (Array.isArray(body)) return body;
	if (!isRecord(body)) return [];
	return Array.isArray(body.models) ? body.models : Object.values(body);
}

function catalogModel(provider: ProviderId, entry: unknown, routes: ReadonlySet<string>): Model<Api> | undefined {
	if (!isRecord(entry) || (entry.type !== undefined && entry.type !== "chat")) return undefined;
	const { id, name, api, baseUrl, reasoning, input, cost, contextWindow, maxTokens } = entry;
	if (typeof id !== "string" || typeof name !== "string" || typeof api !== "string" || typeof baseUrl !== "string") {
		return undefined;
	}
	if (!routes.has(`${api} ${baseUrl}`) || typeof reasoning !== "boolean" || !isCost(cost)) return undefined;
	if (!positive(contextWindow) || !positive(maxTokens)) return undefined;
	if (!Array.isArray(input) || !input.every((each) => each === "text" || each === "image")) return undefined;
	const model: Model<Api> = { id, name, api, provider, baseUrl, reasoning, input, cost, contextWindow, maxTokens };
	if (isRecord(entry.thinkingLevelMap) && Object.values(entry.thinkingLevelMap).every(stringOrNull)) {
		model.thinkingLevelMap = entry.thinkingLevelMap;
	}
	if (isRecord(entry.promptCache) && Object.values(entry.promptCache).every(isNumber)) {
		model.promptCache = entry.promptCache;
	}
	if (isInputLimits(entry.inputLimits)) model.inputLimits = entry.inputLimits;
	if (isRecord(entry.compat)) {
		// Routing can allow data collection and choose OpenRouter's upstream providers; fallbacks let Anthropic answer
		// with another, possibly pricier model: choices for the user, not model facts.
		const { openRouterRouting: _, allowedFallbackModels: __, ...compat } = entry.compat;
		model.compat = compat;
	}
	return model;
}

const RATES = ["input", "output", "cacheRead", "cacheWrite"] as const;

function isCost(value: unknown): value is Model<Api>["cost"] {
	if (!isRecord(value) || !RATES.every((rate) => isNumber(value[rate]))) return false;
	return (
		value.tiers === undefined ||
		(Array.isArray(value.tiers) &&
			value.tiers.every(
				(tier) => isRecord(tier) && isNumber(tier.inputTokensAbove) && RATES.every((rate) => isNumber(tier[rate])),
			))
	);
}

// pi-ai and pi-aside size images and requests by these: a zero, a fraction, or text in them breaks attachments.
function isInputLimits(value: unknown): value is ModelInputLimits {
	if (!isRecord(value) || !optionalCount(value.maxRequestBytes)) return false;
	const { images } = value;
	if (images === undefined) return true;
	if (!isRecord(images) || !optionalCount(images.maxPerMessage) || !optionalCount(images.maxPerRequest)) return false;
	const { resize } = images;
	return (
		resize === undefined ||
		(isRecord(resize) &&
			["maxWidth", "maxHeight", "maxBytes", "jpegQuality"].every((key) => optionalCount(resize[key])))
	);
}

function optionalCount(value: unknown): boolean {
	return value === undefined || (Number.isInteger(value) && (value as number) > 0);
}

/** `provider` with its download laid over its bundled models, as pi-ai's own providers lay a fetched list over. */
export function withDownloads<TApi extends Api>(
	provider: Provider<TApi>,
): Provider<TApi> & Required<Pick<Provider<TApi>, "getAllModels">> {
	const id = provider.id as ProviderId;
	const bundledChat = provider.getModels();
	const bundledAll = provider.getAllModels?.() ?? bundledChat;
	bundled[id] = bundledChat;
	let source: readonly Model<Api>[] | undefined;
	let chat = bundledChat;
	let all = bundledAll;
	// Recomputed only when the download changes, so callers get the same arrays until then.
	const current = () => {
		const downloaded = overlay[id];
		if (downloaded !== source) {
			source = downloaded;
			// The API and base URL pair is one of this provider's: the download holds only its own APIs.
			const own = (downloaded ?? []) as readonly Model<TApi>[];
			chat = laidOver(bundledChat, own);
			all = laidOver(bundledAll, own);
		}
	};
	return {
		...provider,
		getModels: () => {
			current();
			return chat;
		},
		getAllModels: () => {
			current();
			return all;
		},
	};
}

/** The bundled models with each downloaded chat model in place of the bundled one with its ID, new ones after. */
function laidOver<T extends { readonly id: string }>(bundled: readonly T[], downloaded: readonly T[]): T[] {
	if (downloaded.length === 0) return [...bundled];
	const byId = new Map(downloaded.map((model) => [model.id, model]));
	const merged = bundled.map((model) => {
		const replacement = getModelType(model as never) === "chat" ? byId.get(model.id) : undefined;
		if (replacement !== undefined) byId.delete(model.id);
		return replacement ?? model;
	});
	return [...merged, ...byId.values()];
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNumber(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value);
}

function positive(value: unknown): value is number {
	return isNumber(value) && value > 0;
}

function stringOrNull(value: unknown): boolean {
	return value === null || typeof value === "string";
}
