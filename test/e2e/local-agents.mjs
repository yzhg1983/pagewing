// Local agents end to end (design 6.45), as a user sets them up: the switch turned on in Settings before the bridge is
// there, which shows the command that adds pi-aside to pi; then an MCP client starts pi-aside-mcp over stdio, which
// registers the bridge itself, and its first call waits until pi-aside connects. open_tab puts a loopback page in the
// session's tab group; read_page, observe_page, act_on_page (click, type, navigate), run_script, screenshot_page,
// list_tabs, and close_tab work there; a tab outside the group is refused; Off in Tools refuses its tool; the switch
// going off ends the session and leaves the tabs open, and a new client then hears how to connect. The user's home,
// Chrome profile, and ~/.pi-aside are never touched: Chrome and the bridge run with HOME in a temporary folder, and
// the profile is that HOME's Chrome for Testing folder, where pi-aside-mcp registers by default.
import { spawn } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer as createHttp } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { chromium } from "playwright-core";

if (!process.env.CHROME) throw new Error("Set CHROME to a Chrome for Testing 140+ executable.");
const repo = fileURLToPath(new URL("../../", import.meta.url));
// Short: the bridge's unix socket path, under HOME, must stay under about 100 bytes.
const dir = mkdtempSync(join(tmpdir(), "pa-"));
const ext = join(dir, "ext");
const home = join(dir, "h");
const profile = join(home, "Library", "Application Support", "Google", "Chrome for Testing");
mkdirSync(profile, { recursive: true });
console.log("Artifacts:", dir);
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
rmSync(join(ext, "_locales/zh_CN"), { recursive: true });
// Granted at install, as the switch's click asks Chrome for them: the click below then gets them without a prompt.
const manifest = JSON.parse(readFileSync(join(ext, "manifest.json"), "utf8"));
manifest.permissions.push("nativeMessaging");
manifest.optional_permissions = [];
manifest.host_permissions = ["<all_urls>"];
writeFileSync(join(ext, "manifest.json"), JSON.stringify(manifest, null, "\t"));

let passed = 0;
const check = (name, ok, detail = "") => {
	if (ok) passed++;
	console.log(
		`${ok ? "PASS" : "FAIL"} ${name}${ok || detail === "" ? "" : `: ${typeof detail === "string" ? detail : JSON.stringify(detail).slice(0, 2000)}`}`,
	);
	if (!ok) process.exitCode = 1;
};
async function poll(test, what, timeout = 10_000) {
	const end = Date.now() + timeout;
	for (;;) {
		const value = await test();
		if (value) return value;
		if (Date.now() > end) throw new Error(`timed out: ${what}`);
		await sleep(100);
	}
}

const FORM_PAGE = `<!doctype html><title>Form page</title>
<h1>Form page</h1>
<p>Readable text for the agent.</p>
<button id="add">Add item</button>
<ul id="items"></ul>
<label>Name <input id="name"></label>
<script>
window.seen = [];
document.getElementById("add").addEventListener("click", () => {
	document.getElementById("items").append(Object.assign(document.createElement("li"), { textContent: "item" }));
	seen.push("add");
});
document.getElementById("name").addEventListener("input", (event) => seen.push("input:" + event.target.value));
</script>`;
const pages = createHttp((req, res) => {
	res.setHeader("content-type", "text/html");
	if (req.url === "/form") return res.end(FORM_PAGE);
	res.end(`<!doctype html><title>Other ${req.url}</title><p>Other page ${req.url}</p>`);
});
await new Promise((resolve) => pages.listen(8702, "127.0.0.1", resolve));
const A = "http://a.test:8702";
const B = "http://b.test:8702";

/** An MCP client on a new pi-aside-mcp: `call` gives the tool result. */
function mcpClient(name) {
	const child = spawn(process.execPath, [join(repo, "mcp/src/cli.ts")], {
		env: { ...process.env, HOME: home },
		stdio: ["pipe", "pipe", "inherit"],
	});
	let buffered = "";
	const waiting = new Map();
	child.stdout.setEncoding("utf8");
	child.stdout.on("data", (chunk) => {
		buffered += chunk;
		for (let end = buffered.indexOf("\n"); end >= 0; end = buffered.indexOf("\n")) {
			const message = JSON.parse(buffered.slice(0, end));
			buffered = buffered.slice(end + 1);
			waiting.get(message.id)?.(message);
		}
	});
	let next = 0;
	const request = (method, params) =>
		new Promise((resolve) => {
			const id = ++next;
			waiting.set(id, resolve);
			child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
		});
	return {
		initialize: () =>
			request("initialize", { protocolVersion: "2025-06-18", clientInfo: { name }, capabilities: {} }),
		/** The result: `text` the first text item, parsed when it is JSON; `image` the first image item. */
		async call(tool, args = {}) {
			const { result } = await request("tools/call", { name: tool, arguments: args });
			const raw = result.content.find((item) => item.type === "text")?.text ?? "";
			let text = raw;
			try {
				text = JSON.parse(raw);
			} catch {}
			return {
				error: result.isError === true,
				text,
				raw,
				image: result.content.find((item) => item.type === "image"),
			};
		},
		end: () => child.stdin.end(),
	};
}

let context;
try {
	context = await chromium.launchPersistentContext(profile, {
		executablePath: process.env.CHROME,
		headless: false,
		viewport: null,
		env: { ...process.env, HOME: home },
		args: [
			"--headless=new",
			"--disable-background-networking",
			"--disable-component-update",
			"--disable-sync",
			`--disable-extensions-except=${ext}`,
			`--load-extension=${ext}`,
			"--host-resolver-rules=MAP a.test 127.0.0.1:8702, MAP b.test 127.0.0.1:8702, MAP * ~NOTFOUND",
			"--no-proxy-server",
			"--window-size=1280,900",
		],
	});
	const worker =
		context.serviceWorkers().find((w) => w.url().endsWith("/background.js")) ??
		(await context.waitForEvent("serviceworker", { predicate: (w) => w.url().endsWith("/background.js") }));
	const id = new URL(worker.url()).host;
	console.log(`chrome ${context.browser().version()}`);

	// The store ID is allowed by default; this unpacked build's ID is allowed as a developer does, before anything else.
	const allow = spawn(process.execPath, [join(repo, "mcp/src/cli.ts"), "install", "--extension-id", id], {
		env: { ...process.env, HOME: home },
		stdio: "ignore",
	});
	await new Promise((resolve) => allow.once("exit", resolve));
	// As for a user who never ran setup: no helper yet.
	rmSync(join(home, ".pi-aside"), { recursive: true, force: true });

	const panel = await context.newPage();
	await panel.goto(`chrome-extension://${id}/panel.html`);
	const problems = [];
	panel.on("pageerror", (error) => problems.push(error.message));
	await panel.click("#open-settings");
	await panel.click("#settings .advanced summary");
	await panel.click('label:has(input[name="local-agents"][value="on"])');
	const waiting = await poll(
		() =>
			panel
				.locator("#agents-status")
				.textContent()
				.then((text) => (text.startsWith("Not set up yet") ? text : null)),
		"not set up",
	);
	const command = await panel.locator("#agents-command").textContent();
	check(
		"the switch on before setup says so, next to the command that adds pi-aside to pi",
		command === "pi mcp add pi-aside -- npx -y pi-aside-mcp",
		{ waiting, command },
	);
	console.log(`(status before setup: ${waiting})`);

	// The agent's server registers the helper at its start; its first call waits until pi-aside starts it.
	const agent = mcpClient("e2e-agent");
	const init = await agent.initialize();
	check("initialize names pi-aside", init.result?.serverInfo?.name === "pi-aside", init);
	const started = Date.now();
	const opened = await agent.call("open_tab", { url: `${A}/form` });
	check(
		"the first call waits for pi-aside to connect, then open_tab opens the page and waits for it",
		!opened.error && opened.text.loaded === true && opened.text.title === "Form page",
		opened,
	);
	console.log(`(first call took ${Math.round((Date.now() - started) / 1000)} s)`);
	await poll(
		() =>
			panel
				.locator("#agents-status")
				.textContent()
				.then((text) => text.includes("Bridge running")),
		"bridge running",
	);
	const tab = opened.text.tab;
	const group = await worker.evaluate(async (tab) => {
		const { groupId } = await chrome.tabs.get(tab);
		return groupId === -1 ? null : await chrome.tabGroups.get(groupId);
	}, tab);
	check("the tab is in a group named after the agent", group?.title === "e2e-agent", group);
	await poll(
		() =>
			panel
				.locator("#agents-status")
				.textContent()
				.then((text) => text.includes("e2e-agent")),
		"agent listed",
	);
	check("Settings lists the connected agent", true);

	const read = await agent.call("read_page", { tab });
	check("read_page reads the page", !read.error && read.text.text.includes("Readable text for the agent"), read);

	const observed = await agent.call("observe_page", { find: "Add item" });
	const refOf = (label) => {
		const line = observed.text.outline?.split("\n").find((each) => each.includes(`"${label}"`)) ?? "";
		return [...line.matchAll(/\b([a-z]+\d+)\b/g)].at(-1)?.[1];
	};
	check("observe_page gives refs, on the tab used last", !observed.error && refOf("Add item") !== undefined, observed);

	const clicked = await agent.call("act_on_page", { action: "click", ref: refOf("Add item") });
	const fullObserve = await agent.call("observe_page", {});
	const nameRef = (() => {
		const line = fullObserve.text.outline?.split("\n").find((each) => each.includes("Name")) ?? "";
		return [...line.matchAll(/\b([a-z]+\d+)\b/g)].at(-1)?.[1];
	})();
	const typed = await agent.call("act_on_page", { action: "type", ref: nameRef, text: "Ada" });
	const formPage = context.pages().find((page) => page.url() === `${A}/form`);
	const seen = await formPage.evaluate(() => window.seen);
	check(
		"act_on_page clicks and types without asking",
		!clicked.error && !typed.error && seen.includes("add") && seen.includes("input:Ada"),
		{ clicked, typed, seen },
	);

	// run_script needs Chrome's Allow User Scripts switch; pi-aside says so until the user turns it on.
	let script = await agent.call("run_script", { code: "return document.title" });
	if (script.error && /Allow User Scripts/.test(script.raw)) {
		check("run_script asks for Allow User Scripts while it is off", true);
		const details = await context.newPage();
		await details.goto(`chrome://extensions/?id=${id}`);
		await details.locator("#allow-user-scripts").click();
		await details.close();
		await poll(
			() =>
				worker.evaluate(() => {
					try {
						chrome.userScripts.getScripts().catch(() => {});
						return true;
					} catch {
						return false;
					}
				}),
			"Allow User Scripts on",
		);
		script = await agent.call("run_script", { tab, code: "return document.title" });
	}
	check("run_script runs without a card", !script.error && JSON.stringify(script.text).includes("Form page"), script);

	const shot = await agent.call("screenshot_page", { tab });
	check(
		"screenshot_page gives a JPEG",
		!shot.error && shot.image?.mimeType === "image/jpeg" && shot.image.data.length > 1000,
		{ ...shot, image: shot.image?.data.length },
	);

	const went = await agent.call("act_on_page", { tab, action: "navigate", url: `${B}/next` });
	check(
		"act_on_page navigates to another site",
		!went.error && went.text.navigated && went.text.url === `${B}/next`,
		went,
	);

	const outside = await worker.evaluate(async (url) => (await chrome.tabs.create({ url })).id, `${A}/outside`);
	const refused = await agent.call("read_page", { tab: outside });
	check(
		"a tab outside the session's group is refused",
		refused.error && /not in this session's tab group/.test(refused.raw),
		refused,
	);

	const second = await agent.call("open_tab", { url: `${A}/second` });
	const listed = await agent.call("list_tabs");
	check(
		"open_tab adds to the same group; list_tabs lists the group's tabs",
		!second.error &&
			listed.text.tabs
				.map((each) => each.tab)
				.sort()
				.join() === [tab, second.text.tab].sort().join(),
		listed,
	);
	const closed = await agent.call("close_tab", { tab: second.text.tab });
	check(
		"close_tab closes a tab of the group",
		!closed.error && (await agent.call("list_tabs")).text.tabs.length === 1,
		closed,
	);

	// Off in Tools refuses that tool.
	await panel.click('label:has(input[name="tool-read"][value="off"])');
	await poll(
		() => worker.evaluate(async () => (await chrome.storage.local.get("settings")).settings?.tools?.read === "off"),
		"read off",
	);
	const off = await agent.call("read_page", { tab });
	check("Off in Tools refuses the tool", off.error && /turned off/.test(off.raw), off);
	await panel.click('label:has(input[name="tool-read"][value="on"])');

	// The switch going off ends the session and keeps the tabs.
	await panel.click('label:has(input[name="local-agents"][value="off"])');
	await poll(() => panel.locator("#agents-status").isHidden(), "status hidden");
	const after = await agent.call("list_tabs");
	const kept = await worker.evaluate(async (tab) => (await chrome.tabs.get(tab).catch(() => null)) !== null, tab);
	const permission = await worker.evaluate(() => chrome.permissions.contains({ permissions: ["nativeMessaging"] }));
	check("the switch off ends the session; its tabs stay open", after.error && kept, { after, kept });
	console.log(`(nativeMessaging after Off: ${permission}; required in this test build, so Chrome keeps it)`);
	agent.end();
	const late = mcpClient("late");
	await late.initialize();
	const notConnected = await late.call("list_tabs");
	check(
		"with the switch off, a call says to turn on Local agents, at once",
		notConnected.error && /Local agents/.test(notConnected.raw),
		notConnected,
	);
	late.end();

	check("no page errors in the panel", problems.length === 0, problems);
} catch (error) {
	check("run", false, String(error?.stack ?? error));
} finally {
	await context?.close();
	pages.close();
}
console.log(`${passed} passed${process.exitCode ? ", some FAILED" : ""}`);
