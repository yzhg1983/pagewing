// Console and network recording of the tabs the page tools use (design 6.46): the console hook's registration and
// injection, and each tab's requests as webRequest reports them, kept in a ring per tab in worker memory. A tab is
// recorded from its first use by either tool, an action, a script, or open_tab, until it closes, leaves its group, the
// row goes Off, or the worker stops.

import {
	CONSOLE_KEY,
	type ConsoleHook,
	type ConsoleRecord,
	MAX_CONSOLE_RECORDS,
	MAX_CONSOLE_TEXT,
} from "../shared/console.ts";
import { MAX_URL_CHARS } from "../shared/protocol.ts";

/** A request as Chrome reported its end: a status, a redirect's target, or a network error. */
export type NetworkRecord = {
	seq: number;
	/** Chrome's ID, which a redirect's hops share. */
	requestId: string;
	at: number;
	method: string;
	url: string;
	type: string;
	status: number | null;
	redirect: string | null;
	error: string | null;
};

/** The console of one document, as its hook gave it: `epoch` changes with the document and each restart. */
export type ConsoleState = { epoch: string; startedAt: number; records: ConsoleRecord[] };

/** A tab's requests since `startedAt` in epoch `epoch`, oldest first. */
export type NetworkState = { epoch: string; startedAt: number; records: NetworkRecord[] };

/**
 * What webRequest reports about one request, and the tab committing a URL (`tabs.onUpdated`): the events the recorder
 * listens to. `navigation` is the URL of a top document's request, null for any other.
 */
export type NetworkEvent =
	| { kind: "start"; requestId: string; navigation: string | null }
	| { kind: "commit"; url: string }
	| {
			kind: "redirect";
			requestId: string;
			at: number;
			method: string;
			url: string;
			type: string;
			status: number;
			to: string;
	  }
	| { kind: "end"; requestId: string; at: number; method: string; url: string; type: string; status: number }
	| { kind: "error"; requestId: string; at: number; method: string; url: string; type: string; error: string };

/** The Chrome calls of the recorder, replaced in tests. */
export type RecordingAccess = {
	/** Whether Chrome grants webRequest (an optional permission). */
	networkAllowed(): Promise<boolean>;
	/** Starts webRequest and tab listeners filtered to the tab; the function returned removes them. */
	listen(tabId: number, event: (event: NetworkEvent) => void): () => void;
	/** Sets the origins whose new documents get the console hook at document start; none removes the registration. */
	register(origins: string[]): Promise<void>;
	/**
	 * Runs `op` on the hook of document `documentId`, or of the tab's top document when null, after installing the hook
	 * unless `op` is "stop"; null when no hook answered.
	 */
	hook(tabId: number, documentId: string | null, op: HookOp): Promise<HookAnswer | null>;
	now(): number;
};

/** "read": the records; "restart": drop them first; "stop": restore the console and remove the hook. */
export type HookOp = "read" | "restart" | "stop";

/** What the hook answered: page data, checked by `consoleAnswer()`. */
export type HookAnswer = { startedAt: unknown; records: unknown };

/** The requests a tab keeps, the oldest out first. */
export const MAX_NETWORK_RECORDS = 300;
/** Request IDs a tab keeps open: a page that starts more without ending them loses the oldest. */
const MAX_OPEN_REQUESTS = 1_000;

type Tab = {
	/** The tab's group when it was armed (-1 for none): leaving it ends the recording. */
	groupId: number;
	/** When it was armed: console records from before are never returned, whatever the page's hook kept. */
	since: number;
	epoch: string;
	startedAt: number;
	origin: string | null;
	records: NetworkRecord[];
	last: number;
	/** The epoch each started request belongs to, by request ID. */
	open: Map<string, string>;
	/**
	 * The top document's request that started last, and its origin after redirects: it joins the next epoch if that
	 * origin commits, with what it recorded already (Chrome may report its end, or its failure, before the commit).
	 */
	navigation: { requestId: string; origin: string } | null;
	unlisten: (() => void) | null;
	/** The documents of the tab whose hook was used: stopped when the recording ends. */
	documents: Set<string>;
	/** The match patterns the tab needs: its origin's, and the one it is about to go to. */
	patterns: Set<string>;
};

/** How long a tab's hanging hook call holds the next one. */
const TURN_MS = 5_000;

/** The recording of the tabs in use. */
export class Recording {
	readonly #access: RecordingAccess;
	readonly #tabs = new Map<number, Tab>();
	/** Each tab's hook calls and arms, by tab ID, one after another (see `#turn`). */
	readonly #turns = new Map<number, Promise<void>>();
	#epochs = 0;
	/** The patterns registered, as the last write set them. */
	#registered: string[] = [];
	/** Registration writes, one after another: Chrome's unregister and register are two calls. */
	#writes: Promise<unknown>;

	constructor(access: RecordingAccess) {
		this.#access = access;
		// A registration of an earlier worker: its tabs' records are gone, so its hooks only wrap the user's tabs.
		this.#writes = access.register([]).catch(() => {});
	}

	/**
	 * Starts recording the tab if it is not yet, at document `documentId` on `origin` (both null for a blank tab before
	 * open_tab navigates it): the hook in the document, restarted so that what it logged before is never read, the
	 * tab's requests while Chrome grants webRequest, and the console hook's registration for the origin. On a tab
	 * already recorded, it checks the origin (a move found by a read) and starts listening to requests once granted.
	 */
	arm(tabId: number, groupId: number, origin: string | null, documentId: string | null): Promise<void> {
		let known = this.#tabs.get(tabId);
		// Armed in another group, as when a read beats Chrome's group event: that recording ends, a new one starts.
		if (known !== undefined && known.groupId !== groupId) {
			void this.disarm(tabId);
			known = undefined;
		}
		const tab = known ?? { ...this.#tab(origin), groupId, since: this.#access.now(), patterns: new Set<string>() };
		if (known === undefined) this.#tabs.set(tabId, tab);
		// Each await may meet a disarm (Off, the tab leaving its group): from then on the tab is not touched.
		const alive = () => this.#tabs.get(tabId) === tab;
		return this.#turn(tabId, async () => {
			if (!alive()) return;
			if (origin !== null) this.#moved(tab, origin);
			// Before the hook's restart, which a busy page can hold: the action this arm precedes may fail on a request.
			if (tab.unlisten === null && (await this.#access.networkAllowed()) && alive() && tab.unlisten === null) {
				// Requests are recorded from now on: an epoch that started before was not listening.
				if (known !== undefined) this.#restart(tab, tab.origin);
				tab.unlisten = this.#access.listen(tabId, (event) => this.#event(tab, event));
			}
			if (documentId !== null && alive()) {
				tab.documents.add(documentId);
				if (known === undefined) await this.#access.hook(tabId, documentId, "restart").catch(() => null);
			}
			const pattern = origin === null ? null : matchPattern(origin);
			if (pattern === null || !alive()) return;
			tab.patterns.add(pattern);
			// Best effort: without it, a read still installs the hook; the next write tries again.
			await this.#sync().catch(() => {});
		});
	}

	/** Registers the console hook for `origin` too, before the recorded tab goes there. */
	async registerOrigin(tabId: number, origin: string): Promise<void> {
		const pattern = matchPattern(origin);
		const tab = this.#tabs.get(tabId);
		if (pattern === null || tab === undefined) return;
		tab.patterns.add(pattern);
		await this.#sync();
	}

	/** Whether the tab is recorded. */
	armed(tabId: number): boolean {
		return this.#tabs.has(tabId);
	}

	/** Whether Chrome grants webRequest. */
	networkAllowed(): Promise<boolean> {
		return this.#access.networkAllowed();
	}

	/** The tab moved to group `groupId` (-1 for none): out of the group it was armed in, its recording ends. */
	regrouped(tabId: number, groupId: number): Promise<void> {
		const tab = this.#tabs.get(tabId);
		return tab === undefined || tab.groupId === groupId ? Promise.resolve() : this.disarm(tabId);
	}

	/**
	 * Stops recording the tab: its records go at once. Its hooks are stopped, in the documents it used and its top
	 * document, where Chrome still lets Pagewing script them; otherwise one stays until its page unloads, and a later
	 * use drops what it held.
	 */
	async disarm(tabId: number): Promise<void> {
		const tab = this.#drop(tabId);
		if (tab === undefined) return;
		// Queued at once: after an arm in progress, which may be installing the hook, and before a new one.
		const stopped = this.#turn(tabId, async () => {
			for (const documentId of [...tab.documents, null])
				await this.#access.hook(tabId, documentId, "stop").catch(() => null);
		});
		await Promise.all([this.#released(), stopped]);
	}

	/** Stops recording a tab that closed: nothing to stop in it. */
	async forget(tabId: number): Promise<void> {
		if (this.#drop(tabId) !== undefined) await this.#released();
	}

	/** Stops recording the tabs armed in group `groupId`, as when a local agent's session ends. */
	async disarmGroup(groupId: number): Promise<void> {
		const tabIds = [...this.#tabs].filter(([, tab]) => tab.groupId === groupId).map(([tabId]) => tabId);
		await Promise.all(tabIds.map((tabId) => this.disarm(tabId)));
	}

	/** Stops recording every tab, as when the row goes Off or access is lost. */
	async disarmAll(): Promise<void> {
		await Promise.all([...this.#tabs.keys()].map((tabId) => this.disarm(tabId)));
	}

	/** Stops listening to requests, as when Chrome no longer grants webRequest; the tabs keep their console. */
	unlistenAll(): void {
		for (const tab of this.#tabs.values()) {
			tab.unlisten?.();
			tab.unlisten = null;
		}
	}

	/** The tab's requests; null when the tab is not recorded. */
	network(tabId: number): NetworkState | null {
		const tab = this.#tabs.get(tabId);
		return tab === undefined ? null : { epoch: tab.epoch, startedAt: tab.startedAt, records: tab.records };
	}

	/**
	 * The console of document `documentId` since the tab was armed; null when no hook answered or the tab is not
	 * recorded. A document that loaded without the hook, as on an origin not registered yet, gets it now and records
	 * from now on.
	 */
	console(tabId: number, documentId: string): Promise<ConsoleState | null> {
		const tab = this.#tabs.get(tabId);
		if (tab === undefined) return Promise.resolve(null);
		// After an arm in progress: its restart drops what the page logged before.
		return this.#turn(tabId, async () => {
			if (this.#tabs.get(tabId) !== tab) return null;
			tab.documents.add(documentId);
			const answer = await this.#access.hook(tabId, documentId, "read");
			const state = answer === null ? null : consoleAnswer(answer, documentId);
			// A hook the restart missed (a document restored from the back-forward cache, a failed injection) may hold
			// older records.
			return state === null
				? null
				: {
						epoch: state.epoch,
						startedAt: Math.max(state.startedAt, tab.since),
						records: state.records.filter((record) => record.at >= tab.since),
					};
		});
	}

	/**
	 * Runs `work` after the tab's earlier hook calls and arms: two arms of one tab would listen twice, a read during a
	 * first arm would see what the page logged before it, and a disarm's stop after a new arm's restart would remove
	 * the new hook. A call that hangs, as on a page busy in a loop, holds the next one for `TURN_MS` at most.
	 */
	#turn<T>(tabId: number, work: () => Promise<T>): Promise<T> {
		let timer: ReturnType<typeof setTimeout> | undefined;
		// From when `work` starts: calls queued behind a hung one are released one by one, not all at once.
		const held = Promise.withResolvers<void>();
		const run = (this.#turns.get(tabId) ?? Promise.resolve()).then(() => {
			timer = setTimeout(held.resolve, TURN_MS);
			return work();
		});
		const next: Promise<void> = Promise.race([
			run.then(
				() => {},
				() => {},
			),
			held.promise,
		]).finally(() => {
			clearTimeout(timer);
			if (this.#turns.get(tabId) === next) this.#turns.delete(tabId);
		});
		this.#turns.set(tabId, next);
		return run;
	}

	/** Drops the tab's recording; the tab dropped, if it was recorded. */
	#drop(tabId: number): Tab | undefined {
		const tab = this.#tabs.get(tabId);
		if (tab === undefined) return undefined;
		this.#tabs.delete(tabId);
		tab.unlisten?.();
		tab.unlisten = null;
		return tab;
	}

	/**
	 * Removes the registrations no recorded tab needs. Best effort: a registration that stays only puts the hook in
	 * pages, and the next write tries again.
	 */
	#released(): Promise<void> {
		return this.#sync().catch(() => {});
	}

	/** Brings the registration to the patterns the recorded tabs need, after the writes before it. */
	#sync(): Promise<void> {
		const run = this.#writes.then(async () => {
			const wanted = [...new Set([...this.#tabs.values()].flatMap((tab) => [...tab.patterns]))].sort();
			if (wanted.join(" ") === this.#registered.join(" ")) return;
			// Chrome's register removes the registration first: on a failure, none is left.
			this.#registered = [];
			await this.#access.register(wanted);
			this.#registered = wanted;
		});
		this.#writes = run.catch(() => {});
		return run;
	}

	#tab(origin: string | null): Omit<Tab, "groupId" | "since" | "patterns"> {
		return {
			epoch: `n${++this.#epochs}${this.#access.now().toString(36)}`,
			startedAt: this.#access.now(),
			origin,
			records: [],
			last: 0,
			open: new Map(),
			navigation: null,
			unlisten: null,
			documents: new Set(),
		};
	}

	/** A new epoch of the tab's requests on `origin`, from now on. */
	#restart(tab: Tab, origin: string | null): void {
		const { epoch, startedAt } = this.#tab(origin);
		Object.assign(tab, { epoch, startedAt, origin, records: [], last: 0 });
	}

	/**
	 * The tab's top document is on `origin`, as the tab committed it or a read found it: on another origin, a new epoch
	 * starts, which the navigation's own request joins.
	 */
	#moved(tab: Tab, origin: string): void {
		if (origin === tab.origin) return;
		// The registrations follow: the old origin's goes unless another tab needs it.
		const pattern = matchPattern(origin);
		tab.patterns = new Set(pattern === null ? [] : [pattern]);
		void this.#released();
		const navigation = tab.navigation?.origin === origin ? tab.navigation.requestId : null;
		const carried = tab.records.filter((record) => record.requestId === navigation);
		this.#restart(tab, origin);
		if (navigation !== null && tab.open.has(navigation)) tab.open.set(navigation, tab.epoch);
		tab.records = carried.map((record) => ({ ...record, seq: ++tab.last }));
		tab.navigation = null;
	}

	#event(tab: Tab, event: NetworkEvent): void {
		switch (event.kind) {
			case "start": {
				tab.open.set(event.requestId, tab.epoch);
				if (tab.open.size > MAX_OPEN_REQUESTS) tab.open.delete(tab.open.keys().next().value!);
				// Only a navigation for now: a 204 or a download leaves the page where it is.
				const origin = event.navigation === null ? null : originOf(event.navigation);
				if (origin !== null) tab.navigation = { requestId: event.requestId, origin };
				return;
			}
			case "commit": {
				const origin = originOf(event.url);
				if (origin !== null) this.#moved(tab, origin);
				return;
			}
			default:
				this.#ended(tab, event);
		}
	}

	/** A request's end, redirect, or failure, recorded in the epoch it started in; dropped from an earlier one. */
	#ended(tab: Tab, event: Exclude<NetworkEvent, { kind: "start" | "commit" }>): void {
		// A request that started before capture, or on the origin before: dropped.
		if (tab.open.get(event.requestId) !== tab.epoch) return;
		if (event.kind === "redirect") {
			const origin = originOf(event.to);
			if (tab.navigation?.requestId === event.requestId && origin !== null) tab.navigation.origin = origin;
		} else tab.open.delete(event.requestId);
		tab.records.push({
			seq: ++tab.last,
			requestId: event.requestId,
			at: event.at,
			method: event.method,
			url: strippedUrl(event.url),
			type: event.type,
			status: event.kind === "error" ? null : event.status,
			redirect: event.kind === "redirect" ? strippedUrl(event.to) : null,
			error: event.kind === "error" ? event.error : null,
		});
		if (tab.records.length > MAX_NETWORK_RECORDS) tab.records.shift();
	}
}

/** Records picked for a result: the newest that match, after the cursor of the same epoch. */
export type Picked<T> = {
	records: T[];
	/** The cursor of the newest record returned, or the one given when none is newer. */
	last: string;
	/** Records that matched but were left out by `limit` or the size bound: older than those returned. */
	omitted: number;
	/** The cursor was of another epoch (another document or origin, a restart, or Off and On): all current records. */
	reset?: true;
	/** Records after the cursor have left the ring. */
	gap?: true;
};

/**
 * The records of `state` after cursor `since` that `keep`, at most `limit`, the newest, and as many as fit in
 * `maxBytes` when `size` measures them. A cursor of another epoch reads from the start.
 */
export function pick<T extends { seq: number }>(
	state: { epoch: string; records: readonly T[] },
	since: string | undefined,
	keep: (record: T) => boolean,
	limit: number,
	size: (records: T[]) => number,
	maxBytes: number,
): Picked<T> {
	const cursor = since === undefined ? null : parseCursor(since);
	const same = cursor !== null && cursor.epoch === state.epoch;
	const after = same ? cursor.seq : 0;
	const newer = state.records.filter((record) => record.seq > after);
	const matching = newer.filter(keep);
	let records = matching.slice(-limit);
	// Oldest out first, in proportion to the excess, so a page of large records takes few measurements.
	for (let bytes = size(records); bytes > maxBytes && records.length > 0; bytes = size(records))
		records = records.slice(Math.max(1, Math.floor((records.length * (bytes - maxBytes)) / bytes)));
	return {
		records,
		last: `${state.epoch}:${records.at(-1)?.seq ?? after}`,
		omitted: matching.length - records.length,
		...(since !== undefined && !same ? { reset: true as const } : {}),
		...(same && (newer[0]?.seq ?? after + 1) > after + 1 ? { gap: true as const } : {}),
	};
}

/** `epoch:seq` as `last` gives it; null for anything else, which reads from the start. */
function parseCursor(since: string): { epoch: string; seq: number } | null {
	const match = /^([A-Za-z0-9.]{1,40}):(\d{1,9})$/.exec(since);
	return match === null ? null : { epoch: match[1]!, seq: Number(match[2]) };
}

/** `url` without its query, fragment, user name, and password: `/api/save?token=…#x` → `/api/save`. */
export function strippedUrl(url: string): string {
	try {
		const parsed = new URL(url);
		const kept =
			parsed.protocol === "http:" ||
			parsed.protocol === "https:" ||
			parsed.protocol === "ws:" ||
			parsed.protocol === "wss:"
				? `${parsed.protocol}//${parsed.host}${parsed.pathname}`
				: `${parsed.protocol}…`;
		return kept.slice(0, MAX_URL_CHARS);
	} catch {
		return "(not a URL)";
	}
}

function originOf(url: string): string | null {
	try {
		const { origin } = new URL(url);
		return origin === "null" ? null : origin;
	} catch {
		return null;
	}
}

/** The match pattern of an http or https origin, without its port: Chrome's patterns match every port of a host. */
function matchPattern(origin: string): string | null {
	const url = URL.parse(origin);
	return url?.protocol === "http:" || url?.protocol === "https:" ? `${url.protocol}//${url.hostname}/*` : null;
}

const LEVELS = new Set<ConsoleRecord["level"]>(["log", "info", "warn", "error", "debug", "exception", "rejection"]);
/** The largest time a `Date` holds, in milliseconds either side of 1970. */
const MAX_TIME = 8.64e15;

/**
 * The hook's answer as the tool may use it (trust boundary: page data, which the page can forge): well-formed records
 * after each other, at most `MAX_CONSOLE_RECORDS`, each text and source cut to its bound. Null when it is not a hook's
 * answer.
 */
export function consoleAnswer(answer: HookAnswer, documentId: string): ConsoleState | null {
	const { startedAt, records } = answer;
	if (typeof startedAt !== "number" || !(Math.abs(startedAt) <= MAX_TIME) || !Array.isArray(records)) return null;
	const kept: ConsoleRecord[] = [];
	for (const record of (records as unknown[]).slice(-MAX_CONSOLE_RECORDS)) {
		if (typeof record !== "object" || record === null) continue;
		const { seq, at, level, text, source } = record as Record<string, unknown>;
		if (!Number.isSafeInteger(seq) || (kept.length > 0 && (seq as number) <= kept.at(-1)!.seq)) continue;
		if (typeof at !== "number" || !(Math.abs(at) <= MAX_TIME)) continue;
		if (!LEVELS.has(level as ConsoleRecord["level"]) || typeof text !== "string") continue;
		const cut = text.slice(0, MAX_CONSOLE_TEXT).toWellFormed();
		kept.push({
			seq: seq as number,
			at,
			level: level as ConsoleRecord["level"],
			// An uncaught error's stack names script URLs: stripped as a request's.
			text: level === "exception" ? cut.replace(STACK_URL, (url) => strippedUrl(url)) : cut,
			source: typeof source === "string" ? sourceOf(source) : null,
		});
	}
	return { epoch: `${documentId.slice(0, 12)}.${startedAt.toString(36)}`, startedAt, records: kept };
}

/** A URL in a stack, up to its `:line:column` or the end of the frame. */
const STACK_URL = /\b(?:https?|wss?):\/\/[^\s()]+?(?=:\d+:\d+|[\s()]|$)/g;

/** Where an error was thrown, `url:line:column`, with the URL stripped as a request's. */
function sourceOf(source: string): string {
	const [, url = "", place = ""] = /^(.*?)(:\d{1,9}:\d{1,9})?$/s.exec(source.slice(0, MAX_URL_CHARS + 20)) ?? [];
	return `${strippedUrl(url)}${place}`;
}

/** The registration's ID: one registration, its matches the origins in use. */
const HOOK_ID = "pagewing-console";

/** Chrome's recording access. */
export const chromeRecordingAccess: RecordingAccess = {
	networkAllowed: () => chrome.permissions.contains({ permissions: ["webRequest"] }),
	listen(tabId, event) {
		const filter = { urls: ["<all_urls>"], tabId };
		const start = ({ requestId, url, type }: chrome.webRequest.OnBeforeRequestDetails): undefined => {
			event({ kind: "start", requestId, navigation: type === "main_frame" ? url : null });
		};
		const committed = (id: number, { url }: chrome.tabs.OnUpdatedInfo) => {
			if (id === tabId && url !== undefined) event({ kind: "commit", url });
		};
		const redirect = (details: chrome.webRequest.OnBeforeRedirectDetails) =>
			event({ kind: "redirect", ...common(details), status: details.statusCode, to: details.redirectUrl });
		const end = (details: chrome.webRequest.OnCompletedDetails) =>
			event({ kind: "end", ...common(details), status: details.statusCode });
		const error = (details: chrome.webRequest.OnErrorOccurredDetails) =>
			event({ kind: "error", ...common(details), error: details.error });
		const { onBeforeRequest, onBeforeRedirect, onCompleted, onErrorOccurred } = chrome.webRequest;
		onBeforeRequest.addListener(start, filter);
		onBeforeRedirect.addListener(redirect, filter);
		onCompleted.addListener(end, filter);
		onErrorOccurred.addListener(error, filter);
		chrome.tabs.onUpdated.addListener(committed);
		return () => {
			chrome.tabs.onUpdated.removeListener(committed);
			onBeforeRequest.removeListener(start);
			onBeforeRedirect.removeListener(redirect);
			onCompleted.removeListener(end);
			onErrorOccurred.removeListener(error);
		};
	},
	async register(origins) {
		await chrome.scripting.unregisterContentScripts({ ids: [HOOK_ID] }).catch(() => {});
		if (origins.length === 0) return;
		await chrome.scripting.registerContentScripts([
			{
				id: HOOK_ID,
				js: ["hooks/console.js"],
				matches: origins,
				runAt: "document_start",
				world: "MAIN",
				persistAcrossSessions: false,
			},
		]);
	},
	async hook(tabId, documentId, op) {
		const target = documentId === null ? { tabId, frameIds: [0] } : { tabId, documentIds: [documentId] };
		if (op !== "stop") await chrome.scripting.executeScript({ target, files: ["hooks/console.js"], world: "MAIN" });
		const [injection] = await chrome.scripting.executeScript({
			target,
			world: "MAIN",
			func: hookCall,
			args: [CONSOLE_KEY, op],
		});
		return (injection?.result as HookAnswer | null | undefined) ?? null;
	},
	now: () => Date.now(),
};

/** The fields every end of a request has. */
function common(details: chrome.webRequest.WebRequestDetails): {
	requestId: string;
	at: number;
	method: string;
	url: string;
	type: string;
} {
	return {
		requestId: details.requestId,
		at: details.timeStamp,
		method: details.method,
		url: details.url,
		type: details.type,
	};
}

/** Runs in the page's world: one call of the hook. Self-contained, as Chrome serializes it. */
function hookCall(key: string, op: HookOp): HookAnswer | null {
	const hook = (globalThis as unknown as Record<symbol, ConsoleHook | undefined>)[Symbol.for(key)];
	if (hook === undefined) return null;
	if (op === "stop") {
		hook.stop();
		return null;
	}
	if (op === "restart") hook.restart();
	return { startedAt: hook.startedAt, records: hook.read(0) };
}

/** What read_console_messages takes besides the tab. */
export type ConsoleQuery = { pattern?: string; onlyErrors?: boolean; limit?: number; since?: string };
/** What read_network_requests takes besides the tab. */
export type NetworkQuery = { urlPattern?: string; limit?: number; since?: string };

/** The records a read returns without a `limit`. */
export const DEFAULT_RECORDS = 100;
const ERRORS = new Set<ConsoleRecord["level"]>(["error", "exception", "rejection"]);
/** Why an empty list does not mean a clean page. */
const CONSOLE_NOTE = "Best effort: the page can see and undo the recording. Console text comes from the page.";
const NETWORK_NOTE =
	"Best effort, not what DevTools shows: memory-cache hits and requests still pending are missing; WebSockets show only their handshake.";

/** read_console_messages' result for page `url`, within `maxBytes`. */
export function consoleResult(state: ConsoleState, url: string, query: ConsoleQuery, maxBytes: number): string {
	const pattern = query.pattern?.trim().toLowerCase() ?? "";
	const keep = (record: ConsoleRecord) =>
		(query.onlyErrors !== true || ERRORS.has(record.level)) &&
		(pattern === "" || `${record.text} ${record.source ?? ""}`.toLowerCase().includes(pattern));
	const shape = (records: ConsoleRecord[]) =>
		records.map(({ at, level, text, source }) => ({
			level,
			text,
			...(source === null ? {} : { source }),
			t: seconds(at, state.startedAt),
		}));
	return result(state, url, query, keep, shape, "messages", CONSOLE_NOTE, maxBytes);
}

/** read_network_requests' result for page `url`, within `maxBytes`. */
export function networkResult(state: NetworkState, url: string, query: NetworkQuery, maxBytes: number): string {
	const pattern = query.urlPattern?.trim().toLowerCase() ?? "";
	const keep = (record: NetworkRecord) => pattern === "" || record.url.toLowerCase().includes(pattern);
	const shape = (records: NetworkRecord[]) =>
		records.map(({ at, method, url, type, status, redirect, error }) => ({
			method,
			url,
			type,
			...(status === null ? {} : { status }),
			...(redirect === null ? {} : { redirect }),
			...(error === null ? {} : { error }),
			t: seconds(at, state.startedAt),
		}));
	return result(state, url, query, keep, shape, "requests", NETWORK_NOTE, maxBytes);
}

function result<T extends { seq: number }>(
	state: { epoch: string; startedAt: number; records: readonly T[] },
	url: string,
	query: { limit?: number; since?: string },
	keep: (record: T) => boolean,
	shape: (records: T[]) => unknown[],
	name: string,
	note: string,
	maxBytes: number,
): string {
	const encoder = new TextEncoder();
	const envelope = (picked: Omit<Picked<T>, "records">, records: T[]) => ({
		url: strippedUrl(url),
		recordingSince: new Date(state.startedAt).toISOString(),
		[name]: shape(records),
		last: picked.last,
		...(picked.omitted > 0 ? { omitted: picked.omitted } : {}),
		...(picked.reset ? { reset: true } : {}),
		...(picked.gap ? { gap: true } : {}),
		note,
	});
	const size = (records: T[]) =>
		encoder.encode(
			JSON.stringify(envelope({ last: `${state.epoch}:0`, omitted: 1, reset: true, gap: true }, records)),
		).length;
	const { records, ...picked } = pick(state, query.since, keep, query.limit ?? DEFAULT_RECORDS, size, maxBytes);
	return JSON.stringify(envelope(picked, records));
}

/** Seconds from `start` to `at`, to the millisecond. */
const seconds = (at: number, start: number) => Math.round(at - start) / 1000;
