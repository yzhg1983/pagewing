// Update model list end to end (design 6.43): a fake pi.dev serves catalogs to Settings' button, the picker lists a
// downloaded model and sends with it, an entry whose base URL is elsewhere is left out, a failed provider is named,
// the picker's "Not listed?" link opens Settings, the requests carry no cookie or referrer, and after Chrome stops the
// worker the downloaded model is listed and used again. No request leaves the machine.
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { chromium } from "playwright-core";

if (!process.env.CHROME) throw new Error("Set CHROME to a Chrome for Testing 140+ executable.");
const repo = fileURLToPath(new URL("../../", import.meta.url));
const dir = mkdtempSync(join(tmpdir(), "pi-model-list-"));
const ext = join(dir, "ext");
const profile = join(dir, "profile");
console.log("Artifacts:", dir);
// The installed dist/ and the user's Chrome profile are never touched.
mkdirSync(ext);
const common = {
	absWorkingDir: repo,
	bundle: true,
	format: "esm",
	platform: "browser",
	target: "chrome140",
	splitting: false,
	logLevel: "warning",
	outdir: ext,
};
await build({ ...common, entryPoints: { background: "src/background/main.ts" } });
await build({ ...common, entryPoints: { panel: "src/panel/panel.ts" } });
cpSync(join(repo, "static"), ext, { recursive: true });
// English labels; localization.mjs covers both catalogs.
rmSync(join(ext, "_locales/zh_CN"), { recursive: true });
const manifest = JSON.parse(readFileSync(join(ext, "manifest.json"), "utf8"));
manifest.host_permissions = ["https://openrouter.ai/*"];
writeFileSync(join(ext, "manifest.json"), JSON.stringify(manifest, null, "\t"));
// A disposable self-signed certificate for the loopback fakes of openrouter.ai and pi.dev; no real credentials.
execFileSync(
	"openssl",
	[
		"req",
		"-x509",
		"-newkey",
		"rsa:2048",
		"-nodes",
		"-days",
		"1",
		"-subj",
		"/CN=openrouter.ai",
		"-keyout",
		join(dir, "key.pem"),
		"-out",
		join(dir, "cert.pem"),
	],
	{ stdio: "ignore" },
);
let passed = 0;
const check = (name, ok, detail = "") => {
	if (ok) passed++;
	console.log(
		`${ok ? "PASS" : "FAIL"} ${name}${ok || detail === "" ? "" : `: ${JSON.stringify(detail).slice(0, 2000)}`}`,
	);
	if (!ok) process.exitCode = 1;
};

const ROUTE = { api: "openai-completions", baseUrl: "https://openrouter.ai/api/v1", provider: "openrouter" };
const entry = (id, name, extra = {}) => ({
	type: "chat",
	id,
	name,
	...ROUTE,
	reasoning: false,
	input: ["text"],
	cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 100_000,
	maxTokens: 8_000,
	...extra,
});
/** pi.dev's answer per provider: a catalog, or a status. OpenAI fails, so the result names it. */
const catalogs = {
	openai: 503,
	anthropic: {},
	openrouter: {
		"vendor/fresh-model": entry("vendor/fresh-model", "Vendor: Fresh Model"),
		"vendor/second-model": entry("vendor/second-model", "Vendor: Second Model"),
		// Its key would go elsewhere: left out.
		"vendor/elsewhere": entry("vendor/elsewhere", "Vendor: Elsewhere", { baseUrl: "https://example.com/v1" }),
	},
	deepseek: {},
};
const catalogRequests = [];
const sentModels = [];
const server = createServer(
	{ key: readFileSync(join(dir, "key.pem")), cert: readFileSync(join(dir, "cert.pem")) },
	(req, res) => {
		res.setHeader("access-control-allow-origin", "*");
		res.setHeader("access-control-allow-headers", "*");
		if (req.method === "OPTIONS") return res.end();
		const host = req.headers.host ?? "";
		const provider = req.url.match(/^\/api\/models\/providers\/([a-z]+)$/)?.[1];
		if (host.startsWith("pi.dev") && req.method === "GET" && provider !== undefined) {
			catalogRequests.push({ provider, cookie: req.headers.cookie, referer: req.headers.referer });
			const answer = catalogs[provider];
			if (typeof answer === "number") {
				res.writeHead(answer);
				return res.end();
			}
			res.setHeader("access-control-expose-headers", "etag,last-modified");
			res.writeHead(200, { "content-type": "application/json", "last-modified": "Fri, 30 Oct 2026 13:37:39 GMT" });
			return res.end(JSON.stringify(answer ?? {}));
		}
		if (!(host.startsWith("openrouter.ai") && req.method === "POST" && req.url.endsWith("/chat/completions"))) {
			res.writeHead(404, { "content-type": "application/json" });
			return res.end('{"error":{"message":"not found"}}');
		}
		let body = "";
		req.on("data", (data) => {
			body += data;
		});
		req.on("end", () => {
			const { model } = JSON.parse(body);
			sentModels.push(model);
			const chunk = (delta, finish) =>
				`data: ${JSON.stringify({ id: "gen", object: "chat.completion.chunk", created: 1, model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
			res.writeHead(200, { "content-type": "text/event-stream" });
			res.write(chunk({ role: "assistant", content: `Answered by ${model}.` }, null));
			res.write(chunk({}, "stop"));
			res.end("data: [DONE]\n\n");
		});
	},
);
await new Promise((resolve) => server.listen(8444, "127.0.0.1", resolve));

async function poll(test, what, timeout = 10_000) {
	const end = Date.now() + timeout;
	for (;;) {
		const value = await test();
		if (value) return value;
		if (Date.now() > end) throw new Error(`timed out: ${what}`);
		await sleep(100);
	}
}

let context;
try {
	context = await chromium.launchPersistentContext(profile, {
		executablePath: process.env.CHROME,
		headless: false,
		ignoreHTTPSErrors: true,
		viewport: null,
		args: [
			"--headless=new",
			"--disable-background-networking",
			"--disable-component-update",
			"--disable-sync",
			`--disable-extensions-except=${ext}`,
			`--load-extension=${ext}`,
			"--host-resolver-rules=MAP openrouter.ai 127.0.0.1:8444, MAP pi.dev 127.0.0.1:8444, MAP * ~NOTFOUND",
			"--no-proxy-server",
			"--ignore-certificate-errors",
			"--window-size=1280,900",
		],
	});
	const isWorker = (w) => w.url().endsWith("/background.js");
	const worker =
		context.serviceWorkers().find(isWorker) ?? (await context.waitForEvent("serviceworker", { predicate: isWorker }));
	const id = new URL(worker.url()).host;
	console.log(`chrome ${context.browser().version()}`);
	const tab = await worker.evaluate(async () => (await chrome.tabs.query({}))[0]?.id);
	const panelUrl = `chrome-extension://${id}/panel.html?tab=${tab}`;
	const panel = await context.newPage();
	const problems = [];
	panel.on("pageerror", (error) => problems.push(error.message));
	await panel.goto(panelUrl);
	await panel.waitForSelector("#setup:not([hidden])");
	await panel.click('#setup-providers label:has-text("OpenRouter")');
	await panel.fill("#setup-key .key-field input", "sk-or-e2e-fake");
	await panel.click("#setup-key button.primary");
	await panel.waitForSelector("#setup", { state: "hidden" });

	await panel.click("#open-settings");
	const updated = () => panel.locator("#models-updated").textContent();
	check(
		"before an update, Settings says the list came with pi-aside",
		(await updated()).startsWith("Not updated yet"),
	);
	await panel.click("#update-models");
	const result = await poll(async () => {
		const text = await panel.locator("#update-models-result").textContent();
		return text.startsWith("Model list updated") ? text : false;
	}, "update result");
	check(
		"the result counts the new models and names the provider pi.dev failed for",
		result === "Model list updated (2 new). Not updated: OpenAI.",
		result,
	);
	check(
		"each provider's catalog is asked for, with no cookie or referrer",
		catalogRequests
			.map((request) => request.provider)
			.sort()
			.join() === "anthropic,deepseek,openai,openrouter" &&
			catalogRequests.every((request) => request.cookie === undefined && request.referer === undefined),
		catalogRequests,
	);
	check("Settings shows when the list was updated", (await updated()).startsWith("Last updated"), await updated());
	await panel.click("#close-settings");

	/** Opens the picker filtered by `text`; returns the IDs listed and whether "Not listed?" shows. */
	const listed = async (text) => {
		if (await panel.locator("#model-popup").isHidden()) await panel.click("#model");
		await panel.fill("#model-filter", text);
		return {
			ids: await panel.locator("#model-list [role=option] .id").allTextContents(),
			notListed: await panel.locator("#model-not-listed").isVisible(),
		};
	};
	let found = await listed("fresh");
	check(
		"the picker lists the downloaded model",
		found.ids.join() === "openrouter/vendor/fresh-model" && !found.notListed,
		found,
	);
	found = await listed("elsewhere");
	check(
		"an entry whose base URL is elsewhere is left out, and the picker offers Settings",
		found.ids.length === 0 && found.notListed,
		found,
	);
	await panel.click("#model-not-listed button");
	check(
		"the link opens Settings at Update model list",
		(await panel.locator("#settings").isVisible()) &&
			(await panel.evaluate(() => document.activeElement?.id)) === "update-models",
	);
	await panel.click("#close-settings");

	/** Picks `path` in the picker and sends `text`; returns the answer. */
	const sendWith = async (path, text) => {
		await listed(path.split("/").at(-1));
		await panel.click(`#model-list [title="${path}"]`);
		await panel.waitForSelector("#model-popup", { state: "hidden" });
		const answers = () => panel.locator(".msg.assistant .md").allTextContents();
		const before = (await answers()).length;
		await panel.fill("#composer", text);
		await panel.press("#composer", "Enter");
		return poll(async () => (await answers())[before], `answer to ${text}`, 30_000);
	};
	const first = await sendWith("openrouter/vendor/fresh-model", "First");
	check("a send uses the downloaded model", sentModels.at(-1) === "vendor/fresh-model" && /fresh-model/.test(first), {
		first,
		sentModels,
	});

	// Chrome stops the worker: the next one reads the stored download before it lists or sends.
	const cdp = await context.newCDPSession(panel);
	const target = (await cdp.send("Target.getTargets")).targetInfos.find(
		(item) => item.type === "service_worker" && item.url === worker.url(),
	);
	check(
		"the worker stops",
		target !== undefined && (await cdp.send("Target.closeTarget", { targetId: target.targetId })).success,
	);
	await sleep(500);
	await panel.reload();
	await panel.waitForSelector("#composer");
	found = await listed("second");
	check(
		"after the restart, the picker still lists the downloaded models",
		found.ids.join() === "openrouter/vendor/second-model",
		found,
	);
	const second = await sendWith("openrouter/vendor/second-model", "Second");
	check("after the restart, a send uses a downloaded model", /second-model/.test(second), { second, sentModels });
	check("no panel errors", problems.length === 0, problems);
	console.log(`${passed} checks passed.`);
} finally {
	await context?.close();
	await new Promise((resolve) => server.close(resolve));
	rmSync(profile, { recursive: true, force: true });
}
