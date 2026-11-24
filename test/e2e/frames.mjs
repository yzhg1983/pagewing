// Frames end to end (design 6.50): a scripted fake model calls observe_page and act_on_page on loopback pages with
// frames, and the run checks what the tools return and what the frames saw. Frame lines and their labels: a frame
// declared about:blank and moved to another site (as on Gemini), a site pi has no access to, a frame in a shadow root;
// a frame listed within its ref and a nested frame within its own; clicks inside a clipped scroll box and two levels
// deep; the Act card naming the frame's site; refusals for an overlay, a hidden or 0×0 frame also one level up, a frame
// that moved between observe and act, zoom, scale, and rotate (translate acts), drag, and a key while the focus is in a
// frame; a frame line's scroll with and without a direction; the site card of a frame pi cannot reach; and a tab the
// user opens from the middle frame or a sibling frame while pi types two levels deep, which pi does not take as its own,
// also from the middle frame while pi clicks there on what takes no focus;
// a password field in a frame, which pi does not type into, and a tab pi's own click in a frame opens, which it takes.
// No request leaves the machine. Run: CHROME=<Chrome for Testing 147> npm run test:frames
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer as createHttp } from "node:http";
import { createServer } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { chromium } from "playwright-core";

if (!process.env.CHROME) throw new Error("Set CHROME to a Chrome for Testing 147 executable.");
const repo = fileURLToPath(new URL("../../", import.meta.url));
const dir = mkdtempSync(join(tmpdir(), "pi-frames-"));
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
await build({
	...common,
	entryPoints: { background: "src/background/main.ts" },
	// A test-only hook in the temporary worker bundle, not in production source.
	footer: { js: "globalThis.__piTest = { begin };" },
});
await build({ ...common, entryPoints: { panel: "src/panel/panel.ts" } });
await build({ ...common, format: "iife", entryPoints: { "hooks/console": "src/hooks/console.ts" } });
cpSync(join(repo, "static"), ext, { recursive: true });
// English labels; localization.mjs covers both catalogs.
rmSync(join(ext, "_locales/zh_CN"), { recursive: true });
const manifest = JSON.parse(readFileSync(join(ext, "manifest.json"), "utf8"));
// pi may script a.test and b.test; c.test stays a site Chrome does not let it reach.
manifest.host_permissions = ["https://openrouter.ai/*", "http://a.test/*", "http://b.test/*"];
writeFileSync(join(ext, "manifest.json"), JSON.stringify(manifest, null, "\t"));
// A disposable self-signed certificate for the loopback fake provider; no key fixture or real credentials.
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
		`${ok ? "PASS" : "FAIL"} ${name}${ok || detail === "" ? "" : `: ${typeof detail === "string" ? detail : JSON.stringify(detail).slice(0, 2000)}`}`,
	);
	if (!ok) process.exitCode = 1;
};
// The model follows `script`: each request takes the next step, `{calls: [[name, args], ...]}` or a function of the
// results so far that returns one; then it answers `final`. It records each tool result.
let script = [];
let final = "Done.";
const results = [];
let callIds = 0;
const provider = createServer(
	{ key: readFileSync(join(dir, "key.pem")), cert: readFileSync(join(dir, "cert.pem")) },
	(req, res) => {
		res.setHeader("access-control-allow-origin", "*");
		res.setHeader("access-control-allow-headers", "*");
		if (req.method === "OPTIONS") return res.end();
		if (!(req.method === "POST" && req.url.endsWith("/chat/completions"))) {
			res.writeHead(404, { "content-type": "application/json" });
			return res.end('{"error":{"message":"not found"}}');
		}
		let body = "";
		req.on("data", (data) => {
			body += data;
		});
		req.on("end", () => {
			const { messages } = JSON.parse(body);
			const names = new Map(
				messages.flatMap((message) => (message.tool_calls ?? []).map((call) => [call.id, call.function.name])),
			);
			const lastAnswer = messages.findLastIndex((message) => message.role === "assistant");
			for (const message of messages.slice(lastAnswer + 1)) {
				if (message.role !== "tool") continue;
				const text =
					typeof message.content === "string"
						? message.content
						: message.content.map((part) => part.text ?? "").join("");
				results.push({ name: names.get(message.tool_call_id), text });
			}
			let step = script.shift();
			if (typeof step === "function") {
				try {
					step = step(results);
				} catch (error) {
					console.log("STEP FAILED", error.message, JSON.stringify(results.slice(-2)).slice(0, 1500));
					process.exitCode = 1;
					step = undefined;
				}
			}
			res.writeHead(200, { "content-type": "text/event-stream" });
			const chunk = (delta, finish) =>
				`data: ${JSON.stringify({ id: "gen", object: "chat.completion.chunk", created: 1, model: "m", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
			if (step === undefined) {
				res.write(chunk({ role: "assistant", content: final }, null));
				res.write(chunk({}, "stop"));
			} else {
				const tool_calls = step.calls.map(([name, args], index) => ({
					index,
					id: `call_${++callIds}`,
					type: "function",
					function: { name, arguments: JSON.stringify(args ?? {}) },
				}));
				res.write(chunk({ role: "assistant", tool_calls }, null));
				res.write(chunk({}, "tool_calls"));
			}
			res.end("data: [DONE]\n\n");
		});
	},
);
await new Promise((resolve) => provider.listen(8443, "127.0.0.1", resolve));

const PORT = 8701;
const A = `http://a.test:${PORT}`;
const B = `http://b.test:${PORT}`;
const C = `http://c.test:${PORT}`;
// The top, on a.test. "Account" is declared about:blank and then moved to b.test, inside a scroll box that clips it;
// "Side" is a sibling on b.test, "Closed" on c.test, which pi may not script, and "Shadowed" is in a shadow root.
const TOP_PAGE = `<!doctype html><title>Frames top</title>
<style>
body { margin: 0; font: 14px sans-serif }
#box { height: 200px; overflow: auto; border: 1px solid #888; width: 460px }
#account { width: 400px; height: 240px; border: 3px solid #444; padding: 5px }
#cover { position: fixed; left: 0; top: 0; width: 100%; height: 100%; background: rgba(0, 0, 0, .3); z-index: 1 }
</style>
<div id="box"><div style="height: 300px">spacer</div>
<iframe name="account" id="account" title="Account" src="about:blank"></iframe>
<div style="height: 300px"></div></div>
<iframe id="side" title="Side" src="${B}/side" style="width: 200px; height: 80px"></iframe>
<iframe id="closed" title="Closed" src="${C}/app" style="width: 200px; height: 80px"></iframe>
<div id="host"></div>
<div id="cover" role="dialog" aria-label="Overlay" hidden></div>
<script>
frames.account.location.href = "${B}/menu";
document.getElementById("host").attachShadow({ mode: "open" }).innerHTML =
	'<iframe title="Shadowed" src="${B}/app" style="width: 80px; height: 40px"></iframe>';
</script>`;
// The middle frame, on b.test: its buttons sit below its fold; "Deep" is on a.test again.
const MENU_PAGE = `<!doctype html><title>Menu</title><style>body { margin: 0; font: 14px sans-serif }</style>
<div style="height: 300px">menu spacer</div>
<button id="acc1">Account 1</button> <button id="acc2">Account 2</button>
<button id="open" onclick="window.open('${B}/second', '_blank')">Open from menu</button>
<label>PIN <input id="pin" type="password"></label>
<iframe id="deep" title="Deep" src="${A}/deep" style="width: 300px; height: 80px"></iframe>
<div style="height: 600px"></div>
<script>
window.clicks = [];
for (const button of document.querySelectorAll("button"))
	button.addEventListener("click", (event) => clicks.push(button.id + (event.isTrusted ? ":trusted" : ":synthetic")));
</script>`;
// Two levels deep: typing into Note, or a click on Slow tile (which takes no focus), keeps the frame busy for about
// 3 s, so pi's action waits for quiet.
const DEEP_PAGE = `<!doctype html><title>Deep</title>
<label>Note <input id="note"></label><button id="deep-button">Deep button</button>
<span id="slow" role="button">Slow tile</span><p id="log"></p>
<script>
window.clicks = [];
document.getElementById("deep-button").addEventListener("click", () => clicks.push("deep"));
const busy = () => {
	let ticks = 0;
	const tick = setInterval(() => {
		document.getElementById("log").textContent = String(++ticks);
		if (ticks === 30) clearInterval(tick);
	}, 100);
};
document.getElementById("note").addEventListener("input", busy, { once: true });
document.getElementById("slow").addEventListener("click", busy, { once: true });
</script>`;
const SIDE_PAGE = `<!doctype html><title>Side</title>
<button id="open" onclick="window.open('${B}/second', '_blank')">Open from side</button>`;
const APP_PAGE = `<!doctype html><title>App</title><button id="go">Go</button>
<script>window.clicks = []; document.getElementById("go").addEventListener("click", () => clicks.push("go"));</script>`;
// One frame in a wrapper; `style` and `wrap` set their CSS.
const geoPage = (style, wrap) => `<!doctype html><title>Geometry</title><style>body { margin: 20px }</style>
<div id="wrap" style="${wrap}"><iframe id="geo" title="Geo" src="${B}/app" style="width: 200px; height: 80px; ${style}"></iframe></div>`;
const GEOMETRY = {
	zoom: ["zoom: 2", ""],
	"ancestor-zoom": ["", "zoom: 2"],
	scale: ["", "scale: 2"],
	rotate: ["", "rotate: 5deg"],
	translate: ["", "translate: 30px 10px"],
};
const pages = createHttp((req, res) => {
	const host = (req.headers.host ?? "").split(":")[0];
	const [path, query = ""] = req.url.split("?");
	res.writeHead(200, { "content-type": "text/html" });
	if (path === "/second") return res.end("<!doctype html><title>Second page</title><p>The second page.</p>");
	if (host === "a.test" && path === "/top") return res.end(TOP_PAGE);
	if (host === "a.test" && path === "/deep") return res.end(DEEP_PAGE);
	if (host === "a.test" && path === "/geo") return res.end(geoPage(...GEOMETRY[query]));
	if (host === "b.test" && path === "/menu") return res.end(MENU_PAGE);
	if (host === "b.test" && path === "/side") return res.end(SIDE_PAGE);
	res.end(APP_PAGE);
});
await new Promise((resolve) => pages.listen(PORT, "127.0.0.1", resolve));

async function poll(test, what, timeout = 10_000) {
	const end = Date.now() + timeout;
	for (;;) {
		const value = await test();
		if (value) return value;
		if (Date.now() > end) throw new Error(`timed out: ${what}`);
		await sleep(100);
	}
}
const parse = (raw) => {
	try {
		return JSON.parse(raw);
	} catch {
		return { error: raw };
	}
};
/** The line of the outline for the element named `label`, and its ref. */
const lineOf = (outline, label) => (outline ?? "").split("\n").find((each) => each.includes(`"${label}"`)) ?? "";
const refOf = (outline, label) => lineOf(outline, label).match(/"[^"]*" ([a-z]+\d+)/)?.[1];

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
			"--host-resolver-rules=MAP openrouter.ai 127.0.0.1:8443, MAP a.test 127.0.0.1:8701, MAP b.test 127.0.0.1:8701, MAP c.test 127.0.0.1:8701, MAP * ~NOTFOUND",
			"--no-proxy-server",
			"--ignore-certificate-errors",
			"--window-size=1280,900",
		],
	});
	const worker =
		context.serviceWorkers().find((w) => w.url().endsWith("/background.js")) ??
		(await context.waitForEvent("serviceworker", { predicate: (w) => w.url().endsWith("/background.js") }));
	const id = new URL(worker.url()).host;
	console.log(`chrome ${context.browser().version()}`);

	const web = context.pages()[0] ?? (await context.newPage());
	await web.goto(`${A}/top`);
	const tab = await worker.evaluate(async (url) => (await chrome.tabs.query({ url }))[0]?.id, web.url());
	const panelUrl = `chrome-extension://${id}/panel.html?tab=${tab}`;
	// In a window of its own: the web page stays in front of its window.
	await worker.evaluate((url) => chrome.windows.create({ url, width: 380, height: 760 }), panelUrl);
	const panel = await poll(async () => context.pages().find((page) => page.url() === panelUrl), "panel window");
	const problems = [];
	panel.on("pageerror", (error) => problems.push(error.message));
	await panel.waitForSelector("#setup:not([hidden])");
	await panel.click('#setup-providers label:has-text("OpenRouter")');
	await panel.fill("#setup-key .key-field input", "sk-or-e2e-fake");
	await panel.click("#setup-key button.primary");
	await panel.waitForSelector("#setup", { state: "hidden" });
	await panel.click("#model");
	await panel.fill("#model-filter", "gpt mini latest");
	await panel.click('#model-list [title="openrouter/~openai/gpt-mini-latest"]');
	await panel.waitForSelector("#model-popup", { state: "hidden" });

	/** pi attaches the tab's page, as after "Ask pi" in its context menu. */
	const attach = async () => {
		await worker.evaluate(async (url) => {
			const [tab] = await chrome.tabs.query({ url });
			await globalThis.__piTest.begin("context-menu", tab, { frameId: 0, url: tab.url, top: tab.url }).resolved;
		}, web.url());
		await panel.waitForFunction(
			(title) => document.getElementById("page-text").textContent === title,
			await web.title(),
		);
	};
	let turns = 0;
	/** Sends `text` with these model steps; `during` runs while the answer goes on. Returns the results of the turn. */
	async function turn(text, steps, during) {
		script = [...steps];
		final = `Done ${++turns}.`;
		const before = results.length;
		await panel.fill("#composer", text);
		await panel.press("#composer", "Enter");
		await during?.();
		await panel.waitForFunction(
			(done) => [...document.querySelectorAll(".msg.assistant .md")].some((node) => node.textContent.includes(done)),
			final,
			{ timeout: 45_000 },
		);
		return results.slice(before);
	}
	const call = (name, args) => ({ calls: [[name, args]] });
	const observe = (args = {}) => call("observe_page", args);
	const act = (args) => call("act_on_page", args);
	const setMode = async (tool, mode) => {
		await panel.click("#open-settings");
		await panel.locator("label", { has: panel.locator(`input[name="tool-${tool}"][value="${mode}"]`) }).click();
		await poll(
			() =>
				worker.evaluate(
					async ([tool, mode]) => (await chrome.storage.local.get("settings")).settings?.tools?.[tool] === mode,
					[tool, mode],
				),
			`${tool} saved as ${mode}`,
		);
		await panel.click("#close-settings");
	};
	const menu = () => web.frame({ url: `${B}/menu` });
	const deep = () => web.frame({ url: `${A}/deep` });
	const clicks = (frame) => frame.evaluate(() => window.clicks.slice());
	/** A new page: the top again, attached, and its outline with the frame lines. */
	const fresh = async () => {
		await web.goto(`${A}/top`);
		await poll(() => deep() !== null && deep().url() === `${A}/deep`, "the frames loaded");
		await attach();
		return parse((await turn("Look", [observe()]))[0]?.text).outline ?? "";
	};

	await setMode("act", "on");
	let outline = await fresh();
	check(
		"frame lines: the moved about:blank frame and the sibling with their sites, no access, and a shadow root",
		/^- frame "Account" a\d+ \d+×\d+ origin=http:\/\/b\.test:8701$/.test(lineOf(outline, "Account").trim()) &&
			/origin=http:\/\/b\.test:8701$/.test(lineOf(outline, "Side")) &&
			lineOf(outline, "Closed").endsWith("no access to this frame's site") &&
			/in a shadow root: not listed/.test(lineOf(outline, "Shadowed")) &&
			!outline.includes("Account 1"),
		outline,
	);
	const account = refOf(outline, "Account");
	let got = await turn("Menu", [observe({ within: account })]);
	let value = parse(got[0]?.text);
	const inMenu = value.outline ?? "";
	check(
		"within a frame's ref lists the frame's page under its line, with its site",
		inMenu.split("\n")[0] === lineOf(outline, "Account") &&
			refOf(inMenu, "Account 1") !== undefined &&
			/^ {2}- /.test(inMenu.split("\n")[1] ?? "") &&
			value.frame?.origin === B &&
			value.url === `${A}/top`,
		value,
	);
	got = await turn("Pick", [act({ action: "click", ref: refOf(inMenu, "Account 1") })]);
	check(
		"a click in the clipped, scrolled frame reaches its button, as a script's click",
		parse(got[0]?.text).done !== undefined && (await clicks(menu())).join() === "acc1:synthetic",
		got[0],
	);
	const deepRef = refOf(inMenu, "Deep");
	got = await turn("Deep", [observe({ within: deepRef })]);
	const inDeep = parse(got[0]?.text).outline ?? "";
	got = await turn("Deep click", [act({ action: "click", ref: refOf(inDeep, "Deep button") })]);
	check(
		"a nested frame lists within its own ref, and a click two levels deep reaches it",
		/origin=http:\/\/a\.test:8701$/.test(inDeep.split("\n")[0] ?? "") &&
			parse(got[0]?.text).done !== undefined &&
			(await clicks(deep())).join() === "deep",
		{ inDeep, got },
	);

	// Ask: the card names the frame's site.
	await setMode("act", "ask");
	let card;
	got = await turn("Pick", [act({ action: "click", ref: refOf(inMenu, "Account 2") })], async () => {
		const box = panel.locator(".ask");
		await box.waitFor({ timeout: 20_000 });
		card = await box.textContent();
		await box.getByRole("button", { name: "Allow", exact: true }).click();
	});
	check(
		"the Act card asks to act on the frame's site, not the page's",
		card?.includes("b.test:8701") && !card.includes("a.test") && (await clicks(menu())).includes("acc2:synthetic"),
		{ card, got },
	);
	await setMode("act", "on");

	// Refusals before anything is sent.
	got = await turn("Drag", [act({ action: "drag", ref: refOf(inMenu, "Account 1"), by: { x: 10, y: 0 } })]);
	check("drag in a frame is refused", got[0]?.text === "drag does not work inside frames yet.", got[0]);
	got = await turn("Shadowed", [observe({ within: refOf(outline, "Shadowed") })]);
	check(
		"within a frame in a shadow root is refused",
		/is a frame in a shadow root: pi cannot tell which page it shows/.test(got[0]?.text ?? ""),
		got[0],
	);
	await web.evaluate(() => {
		document.getElementById("cover").hidden = false;
	});
	got = await turn("Covered", [act({ action: "click", ref: refOf(inMenu, "Account 1") })]);
	await web.evaluate(() => {
		document.getElementById("cover").hidden = true;
	});
	check(
		"an overlay over the frame where pi would act refuses the click",
		new RegExp(`The frame ${account} is covered by dialog "Overlay"`).test(got[0]?.text ?? "") &&
			(await clicks(menu())).filter((one) => one === "acc1:synthetic").length === 1,
		got[0],
	);
	for (const [style, what] of [
		["visibility: hidden", "hidden"],
		["width: 0; height: 0; border: 0; padding: 0", "0×0"],
	]) {
		await web.evaluate((style) => document.getElementById("account").setAttribute("style", style), style);
		got = await turn("Hidden", [
			act({ action: "click", ref: refOf(inMenu, "Account 1") }),
			act({ action: "click", ref: refOf(inDeep, "Deep button") }),
			observe({ within: deepRef }),
		]);
		await web.evaluate(() => document.getElementById("account").removeAttribute("style"));
		// A 0×0 frame has no view: the check in the frame, or in its parent, refuses first.
		check(
			`a ${what} frame refuses actions in it and one level down, and within`,
			got.length === 3 &&
				got.every((one) => parse(one.text).done === undefined) &&
				got[2].text === `The frame ${account} is hidden or smaller than 2 px: observe again` &&
				(await clicks(menu())).filter((one) => one === "acc1:synthetic").length === 1 &&
				(await clicks(deep())).join() === "deep",
			got,
		);
	}
	await deep().focus("#note");
	got = await turn("Key", [act({ action: "press", key: "Enter" })]);
	check(
		"a key without a ref while the focus is in a frame is refused",
		new RegExp(`^Focus is in frame "Account" \\(${account}\\): pass a ref in it`).test(got[0]?.text ?? ""),
		got[0],
	);

	// A frame line's scroll: with a direction, the frame's page; alone, the frame in the page.
	const menuY = () => menu().evaluate(() => scrollY);
	const boxTop = () => web.evaluate(() => document.getElementById("box").scrollTop);
	outline = await fresh();
	got = await turn("Scroll", [act({ action: "scroll", ref: refOf(outline, "Account"), direction: "down" })]);
	check(
		"scroll with a frame's ref and a direction needs the frame in view: the scroll box hides it",
		got[0]?.text ===
			`Where pi would act in the frame ${refOf(outline, "Account")} is outside the view: observe again` &&
			(await menuY()) === 0,
		got[0],
	);
	got = await turn("Reveal", [act({ action: "scroll", ref: refOf(outline, "Account") })]);
	check("scroll with a frame's ref alone reveals the frame in its scroll box", (await boxTop()) > 0, got[0]);
	got = await turn("Scroll", [act({ action: "scroll", ref: refOf(outline, "Account"), direction: "down" })]);
	check("then scroll with a direction scrolls the frame's page", (await menuY()) > 0, got[0]);

	// The frame moves in the page between observe and act: Chrome orders `window.frames` as the frames were added, so a
	// new `<iframe>` goes last and moves nothing; removing an earlier one does.
	got = await turn("Side", [observe({ within: refOf(outline, "Side") })]);
	const side = parse(got[0]?.text).outline ?? "";
	await web.evaluate(() =>
		document.body.prepend(Object.assign(document.createElement("iframe"), { src: "about:blank" })),
	);
	got = await turn("Open", [observe({ within: refOf(outline, "Side") })]);
	check("a new `<iframe>` before it does not move the frame", got[0]?.text.includes("Open from side"), got[0]);
	await web.evaluate(() => document.getElementById("account").remove());
	got = await turn("Open", [act({ action: "click", ref: refOf(side, "Open from side") })]);
	check(
		"a frame that moved between observe and act is refused",
		got[0]?.text === "The page's frames changed while pi looked; observe again." &&
			!context.pages().some((page) => page.url() === `${B}/second`),
		got[0],
	);

	// A frame pi cannot reach: the site card names what the page says it shows.
	outline = await fresh();
	got = await turn("Closed", [observe({ within: refOf(outline, "Closed") })], async () => {
		const box = panel.locator(".ask");
		await box.waitFor({ timeout: 20_000 });
		card = { text: await box.textContent(), buttons: await box.getByRole("button").allTextContents() };
		await box.getByRole("button", { name: "Cancel", exact: true }).click();
	});
	check(
		"within a frame Chrome does not let pi reach shows the frame's site card; Cancel ends the call",
		card?.text.includes(
			"pi needs access to the site in a frame of this page to continue. The page says the frame shows http://c.test.",
		) &&
			card.buttons.join() === "On all sites,On http://c.test,Cancel" &&
			/The user cancelled: Chrome does not let pi reach the site in this frame/.test(got[0]?.text ?? ""),
		{ card, got },
	);

	// Geometry: zoom and transforms are refused, a translation acts.
	for (const name of Object.keys(GEOMETRY)) {
		await web.goto(`${A}/geo?${name}`);
		await poll(() => web.frame({ url: `${B}/app` }) !== null, "the frame loaded");
		await attach();
		got = await turn("Geo", [
			observe(),
			(seen) => observe({ within: refOf(parse(seen.at(-1).text).outline, "Geo") }),
			(seen) => {
				const go = refOf(parse(seen.at(-1).text).outline, "Go");
				return go === undefined ? undefined : act({ action: "click", ref: go });
			},
		]);
		const app = web.frame({ url: `${B}/app` });
		if (name === "translate")
			check(
				"a translated wrapper: the frame lists and the click reaches its button",
				parse(got[2]?.text).done !== undefined && (await clicks(app)).join() === "go",
				got,
			);
		else
			check(
				`${name}: within the frame is refused`,
				/^pi cannot map points into the frame [a-z]+\d+: it is zoomed or transformed$/.test(got[1]?.text ?? ""),
				got,
			);
	}

	// The user opens a tab from the middle frame, or from a sibling frame, while pi types two levels deep: the tab is
	// the user's (design 6.29).
	for (const [where, frame] of [
		["the middle frame", () => web.frameLocator("#account").locator("#open")],
		["a sibling frame", () => web.frameLocator("#side").locator("#open")],
	]) {
		outline = await fresh();
		got = await turn(
			"Note",
			[
				observe({ within: refOf(outline, "Account") }),
				(seen) => observe({ within: refOf(parse(seen.at(-1).text).outline, "Deep") }),
				(seen) => act({ action: "type", ref: refOf(parse(seen.at(-1).text).outline, "Note"), text: "hi" }),
			],
			async () => {
				await poll(
					async () => (await deep()?.evaluate(() => document.getElementById("log").textContent)) !== "",
					"pi typing deep",
					20_000,
				);
				await frame().click();
			},
		);
		value = parse(got.at(-1)?.text);
		check(
			`a tab the user opens from ${where} while pi acts two levels deep is not pi's`,
			/opened from the page while the user also used it, which pi does not use/.test(value.done ?? "") &&
				value.tab === undefined,
			got.at(-1),
		);
		for (const page of context.pages()) if (page.url() === `${B}/second`) await page.close();
	}
	// The same while pi clicks an element two levels deep that takes no focus, so the deep frame's window never blurs:
	// the user clicks in the middle frame, which only its own watcher sees. A click in a sibling frame inside the middle
	// frame is not checked: Chrome may drop the middle frame's focus once the opened tab comes to the front (design 6.50).
	{
		outline = await fresh();
		let deepFocused;
		got = await turn(
			"Tile",
			[
				observe({ within: refOf(outline, "Account") }),
				(seen) => observe({ within: refOf(parse(seen.at(-1).text).outline, "Deep") }),
				(seen) => act({ action: "click", ref: refOf(parse(seen.at(-1).text).outline, "Slow tile") }),
			],
			async () => {
				await poll(
					async () => (await deep()?.evaluate(() => document.getElementById("log").textContent)) !== "",
					"pi's click deep",
					20_000,
				);
				deepFocused = await deep().evaluate(() => document.hasFocus());
				await web.frameLocator("#account").locator("#open").click();
			},
		);
		value = parse(got.at(-1)?.text);
		check(
			"a tab the user opens from the middle frame while pi clicks deep on what takes no focus is not pi's",
			deepFocused === false &&
				/opened from the page while the user also used it, which pi does not use/.test(value.done ?? "") &&
				value.tab === undefined,
			{ deepFocused, result: got.at(-1) },
		);
		for (const page of context.pages()) if (page.url() === `${B}/second`) await page.close();
	}

	// In a frame, pi still does not type into a password field; its own click that opens a tab takes the tab.
	outline = await fresh();
	got = await turn("Pin", [
		observe({ within: refOf(outline, "Account") }),
		(seen) => act({ action: "type", ref: refOf(parse(seen.at(-1).text).outline, "PIN"), text: "1234" }),
	]);
	check(
		"a password field in a frame refuses typing",
		/^pi does not type into a password field \([a-z]+\d+\)$/.test(got[1]?.text ?? "") &&
			(await menu().evaluate(() => document.getElementById("pin").value)) === "",
		got,
	);
	got = await turn("Open", [
		observe({ within: refOf(outline, "Account") }),
		(seen) => act({ action: "click", ref: refOf(parse(seen.at(-1).text).outline, "Open from menu") }),
	]);
	value = parse(got.at(-1)?.text);
	check(
		"pi's own click in a frame that opens a tab takes the tab",
		typeof value.tab === "number" && value.url === `${B}/second`,
		got.at(-1),
	);
	check("no panel errors", problems.length === 0, problems);
	console.log(`${passed} checks passed.`);
} finally {
	await context?.close();
	await new Promise((resolve) => provider.close(resolve));
	await new Promise((resolve) => pages.close(resolve));
	rmSync(profile, { recursive: true, force: true });
}
