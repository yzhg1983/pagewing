// Update model list (design 6.43): what a pi.dev catalog may change, how a download is laid over the bundled models,
// and what is stored. `fetch` is stubbed with fabricated catalogs, so nothing reaches pi.dev.
import type { Api, Model } from "@earendil-works/pi-ai";
import { getBuiltinModelDataGeneratedAt } from "@earendil-works/pi-ai/providers/all";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BUILTIN_MODELS_DATE, catalogModels, catalogReady, catalogUpdatedAt } from "../src/background/catalog.ts";
import { credentials, models, syncPlanWindows, updateModels } from "../src/background/models.ts";

const local = new Map<string, unknown>();
let sets = 0;
(globalThis as { chrome?: unknown }).chrome = {
	storage: {
		local: {
			setAccessLevel: async () => {},
			get: async (key: string) => (local.has(key) ? { [key]: structuredClone(local.get(key)) } : {}),
			set: async (items: Record<string, unknown>) => {
				sets += 1;
				for (const [key, value] of Object.entries(items)) local.set(key, structuredClone(value));
			},
		},
	},
	permissions: { contains: async () => true },
};

const NEWER = "Fri, 30 Oct 2026 13:37:39 GMT";
const OLDER = "Tue, 20 Oct 2026 00:00:00 GMT";
const openrouter = () => models.getModels("openrouter");
const ids = (list: readonly { id: string }[]) => list.map((model) => model.id);

/** A catalog entry as pi.dev sends it. */
function entry(id: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		type: "chat",
		id,
		name: `Model ${id}`,
		api: "openai-completions",
		baseUrl: "https://openrouter.ai/api/v1",
		provider: "openrouter",
		reasoning: false,
		input: ["text"],
		cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0 },
		contextWindow: 100_000,
		maxTokens: 8_000,
		...overrides,
	};
}

/** Stubs pi.dev: each provider's catalog and Last-Modified, or a status for the ones that fail. */
function serve(catalogs: Partial<Record<string, { body: unknown; modified?: string } | number>>) {
	const fetch = vi.fn<typeof globalThis.fetch>(async (input) => {
		const provider = String(input).split("/").at(-1) ?? "";
		const answer = catalogs[provider] ?? { body: {} };
		if (typeof answer === "number") return new Response("", { status: answer });
		const headers: Record<string, string> = answer.modified ? { "last-modified": answer.modified } : {};
		return new Response(JSON.stringify(answer.body), { headers });
	});
	vi.stubGlobal("fetch", fetch);
	return fetch;
}

beforeEach(() => {
	sets = 0;
});
afterEach(() => {
	vi.unstubAllGlobals();
});

describe("the stored download", () => {
	it("is read once, and counts only where it is newer than the bundled catalog", async () => {
		local.set("downloadedModels", {
			checkedAt: 1,
			providers: {
				openrouter: {
					lastModified: Date.parse(NEWER),
					// Content scripts can write storage.local: what it holds passes the same checks as a download.
					models: [entry("stored/newer"), entry("stored/elsewhere", { baseUrl: "https://example.com/v1" })],
				},
				anthropic: { lastModified: Date.parse(NEWER), models: "not a list" },
				deepseek: {
					lastModified: Date.parse(OLDER),
					models: [entry("stored-older", { api: "openai-completions", baseUrl: "https://api.deepseek.com" })],
				},
			},
		});
		await catalogReady();
		expect(ids(openrouter())).toContain("stored/newer");
		expect(ids(openrouter())).not.toContain("stored/elsewhere");
		expect(models.getModels("anthropic").length).toBeGreaterThan(0);
		// A Pagewing update with a newer bundle drops an older download.
		expect(ids(models.getModels("deepseek"))).not.toContain("stored-older");
		expect(catalogUpdatedAt()).toBe(1);
	});
});

describe("catalogModels", () => {
	const bundled = models.getModels("openrouter");

	it("keeps the provider asked for, and drops headers, OpenRouter's routing, and Anthropic's fallbacks", () => {
		const [model] = catalogModels(
			"openrouter",
			[
				entry("a/b", {
					provider: "anthropic",
					headers: { authorization: "Bearer someone-else" },
					compat: {
						openRouterRouting: { data_collection: "allow" },
						allowedFallbackModels: ["claude-opus-5-5"],
						supportsStore: false,
					},
				}),
			],
			bundled,
		);
		expect(model?.provider).toBe("openrouter");
		expect(model).not.toHaveProperty("headers");
		expect(model?.compat).toEqual({ supportsStore: false });
	});

	it("takes an API and base URL only as a pair a bundled model has", () => {
		const kept = catalogModels(
			"openrouter",
			[
				entry("completions"),
				entry("messages", { api: "anthropic-messages", baseUrl: "https://openrouter.ai/api" }),
				// The key would go elsewhere.
				entry("elsewhere", { baseUrl: "https://example.com/v1" }),
				// Both exist, but not together.
				entry("mixed", { api: "anthropic-messages", baseUrl: "https://openrouter.ai/api/v1" }),
				entry("unknown-api", { api: "google-generative-ai" }),
			],
			bundled,
		);
		expect(ids(kept)).toEqual(["completions", "messages"]);
	});

	it("takes chat models only, an entry without a type as one, from an array, {models}, or an object by ID", () => {
		const { type: _, ...untyped } = entry("untyped");
		const body = { chat: entry("chat"), untyped, image: entry("image", { type: "image" }) };
		expect(ids(catalogModels("openrouter", body, bundled))).toEqual(["chat", "untyped"]);
		expect(ids(catalogModels("openrouter", Object.values(body), bundled))).toEqual(["chat", "untyped"]);
		expect(ids(catalogModels("openrouter", { models: Object.values(body) }, bundled))).toEqual(["chat", "untyped"]);
		expect(catalogModels("openrouter", "not a catalog", bundled)).toEqual([]);
	});

	it("drops an entry with a missing or wrong fact", () => {
		const kept = catalogModels(
			"openrouter",
			[
				entry("ok", { cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, tiers: [] } }),
				entry("no-name", { name: 1 }),
				entry("zero-window", { contextWindow: 0 }),
				entry("no-output", { maxTokens: "8000" }),
				entry("bad-cost", { cost: { input: "1", output: 2, cacheRead: 0, cacheWrite: 0 } }),
				entry("bad-tier", { cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, tiers: [{ input: 1 }] } }),
				entry("audio", { input: ["text", "audio"] }),
				entry("no-reasoning-flag", { reasoning: "yes" }),
			],
			bundled,
		);
		expect(ids(kept)).toEqual(["ok"]);
	});

	it("keeps input limits only when every count in them is a positive whole number", () => {
		const limits = (inputLimits: unknown) =>
			catalogModels("openrouter", [entry("m", { inputLimits })], bundled)[0]?.inputLimits;
		const good = { maxRequestBytes: 1_000_000, images: { maxPerRequest: 20, resize: { maxWidth: 2_000 } } };
		expect(limits(good)).toEqual(good);
		expect(limits({ images: { maxPerRequest: 0 } })).toBeUndefined();
		expect(limits({ images: { maxPerRequest: "x" } })).toBeUndefined();
		expect(limits({ images: { resize: { jpegQuality: 0.5 } } })).toBeUndefined();
	});
});

describe("Update model list", () => {
	it("lays the download over the bundled models and counts the new ones for providers with a key", async () => {
		const haiku = openrouter().find((model) => model.id === "~anthropic/claude-haiku-latest");
		expect(haiku?.api).toBe("openai-completions");
		const fetch = serve({
			openrouter: {
				modified: NEWER,
				body: [
					entry("~anthropic/claude-haiku-latest", {
						api: "anthropic-messages",
						baseUrl: "https://openrouter.ai/api",
					}),
					entry("vendor/new-1"),
					entry("vendor/new-2"),
				],
			},
			deepseek: {
				modified: NEWER,
				body: [entry("deepseek-new", { api: "openai-completions", baseUrl: "https://api.deepseek.com" })],
			},
		});
		const before = openrouter();
		expect(await updateModels(["openrouter"], null)).toEqual({ added: 2, failed: [] });
		for (const provider of ["openai", "anthropic", "openrouter", "deepseek"]) {
			expect(fetch).toHaveBeenCalledWith(`https://pi.dev/api/models/providers/${provider}`, {
				credentials: "omit",
				referrerPolicy: "no-referrer",
				signal: expect.any(AbortSignal),
			});
		}
		// The changed entry replaces the bundled one in place; new ones follow; bundled ones stay.
		const after = openrouter();
		expect(after.find((model) => model.id === "~anthropic/claude-haiku-latest")?.api).toBe("anthropic-messages");
		expect(ids(after).slice(-2)).toEqual(["vendor/new-1", "vendor/new-2"]);
		// The earlier download's "stored/newer" is gone: this one replaces it.
		expect(after.length).toBe(before.length - 1 + 2);
		expect(ids(models.getModels("deepseek"))).toContain("deepseek-new");
		// The same arrays until the download changes.
		expect(openrouter()).toBe(after);
		expect(sets).toBe(1);
		expect(catalogUpdatedAt()).toBeGreaterThan(1);
	});

	it("keeps a failed provider's previous download, and rejects only when every provider fails", async () => {
		serve({ openrouter: 503, deepseek: { modified: NEWER, body: [] } });
		expect(await updateModels([], null)).toEqual({ added: 0, failed: ["openrouter"] });
		expect(ids(openrouter())).toContain("vendor/new-1");

		serve({ openai: 500, anthropic: 500, openrouter: 500, deepseek: 500 });
		await expect(updateModels([], null)).rejects.toThrow("pi.dev answered 500");
		expect(ids(openrouter())).toContain("vendor/new-1");
	});

	it("refuses a catalog of more models than any provider has", async () => {
		const many = Array.from({ length: 2_001 }, (_, index) => entry(`vendor/m${index}`));
		serve({ openrouter: { modified: NEWER, body: many } });
		expect(await updateModels([], null)).toEqual({ added: 0, failed: ["openrouter"] });
	});

	it("counts a new OpenAI model only if a ChatGPT plan offers it", async () => {
		const route = { api: "openai-responses", baseUrl: "https://api.openai.com/v1", provider: "openai" };
		serve({ openai: { modified: NEWER, body: [entry("gpt-plan-new", route), entry("gpt-api-only", route)] } });
		expect(await updateModels(["openai"], ["gpt-plan-new"])).toEqual({ added: 1, failed: [] });
	});

	it("leaves out a download that is not newer than the bundled catalog", async () => {
		serve({ openrouter: { modified: OLDER, body: [entry("vendor/old")] }, deepseek: { body: [entry("x")] } });
		await updateModels(["openrouter"], null);
		expect(ids(openrouter())).not.toContain("vendor/old");
		expect(ids(openrouter())).not.toContain("vendor/new-1");
	});

	it("runs one update at a time: a second click joins the first", async () => {
		const fetch = serve({ openrouter: { modified: NEWER, body: [entry("vendor/joined")] } });
		const [first, second] = await Promise.all([
			updateModels(["openrouter"], null),
			updateModels(["openrouter"], null),
		]);
		expect(second).toEqual(first);
		expect(fetch).toHaveBeenCalledTimes(4);
		expect(sets).toBe(1);
	});

	it("gives a new OpenAI model the API's window, and a known one the plan's on a ChatGPT sign-in", async () => {
		const route = { api: "openai-responses", baseUrl: "https://api.openai.com/v1", provider: "openai" };
		serve({
			openai: {
				modified: NEWER,
				body: [entry("gpt-6.1-sol", { ...route, contextWindow: 999_999 }), entry("gpt-7-new", route)],
			},
		});
		await updateModels(["openai"], null);
		await credentials.modify("openai", async () => ({
			type: "oauth",
			access: "a",
			refresh: "r",
			expires: Date.now() + 60_000,
		}));
		await syncPlanWindows();
		const window = (id: string) =>
			(models.getModels("openai") as readonly Model<Api>[]).find((model) => model.id === id)?.contextWindow;
		// The plan's window from pi-ai's Codex catalog, not the downloaded API window.
		expect(window("gpt-6.1-sol")).toBe(500_000);
		expect(window("gpt-7-new")).toBe(100_000);
		await credentials.delete("openai");
		await syncPlanWindows();
		expect(window("gpt-6.1-sol")).toBe(999_999);
	});
});

it("knows the bundled catalog's date", () => {
	expect(BUILTIN_MODELS_DATE).toBe(getBuiltinModelDataGeneratedAt());
});
