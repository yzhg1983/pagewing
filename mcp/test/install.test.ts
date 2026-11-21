// Setup: the host script and the manifest Chrome reads, and on Windows the registry keys that name it.

import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HOST_NAME, STORE_ID } from "../src/bridge.ts";
import { install, installWindows, type Registry, uninstall, uninstallWindows } from "../src/install.ts";

let home = "";
const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, LOCALAPPDATA: process.env.LOCALAPPDATA };
/** Points every home Node or setup reads at `folder`, so no test touches the user's. */
function useHome(folder: string) {
	home = folder;
	process.env.HOME = folder;
	process.env.USERPROFILE = folder;
	process.env.LOCALAPPDATA = join(folder, "AppData", "Local");
}
beforeEach(() => useHome(mkdtempSync(join(tmpdir(), "pagewing-install-"))));
afterEach(() => {
	for (const [name, value] of Object.entries(saved))
		if (value === undefined) delete process.env[name];
		else process.env[name] = value;
});

describe.skipIf(process.platform === "win32")("install", () => {
	it("registers the host for the store ID and the given IDs, in the given profile", () => {
		const profile = join(home, "profile");
		const [file] = install("/opt/pagewing-mcp/cli.ts", ["abc"], [profile]);
		expect(file).toBe(join(profile, "NativeMessagingHosts", `${HOST_NAME}.json`));
		const manifest = JSON.parse(readFileSync(file!, "utf8"));
		expect(manifest).toEqual({
			name: HOST_NAME,
			description: "Pagewing local agents bridge",
			path: join(home, ".pagewing", "host.sh"),
			type: "stdio",
			allowed_origins: [`chrome-extension://${STORE_ID}/`, "chrome-extension://abc/"],
		});
		const script = readFileSync(manifest.path, "utf8");
		expect(script).toMatch(/^exec '[^']*node' '\/opt\/pagewing-mcp\/cli.ts' host "\$@"$/m);
		expect(statSync(manifest.path).mode & 0o777).toBe(0o700);
	});

	it("keeps the IDs an earlier setup allowed, and writes nothing when nothing changed", () => {
		const profile = join(home, "profile");
		const [file] = install("/old/cli.ts", ["unpacked"], [profile]);
		// The manifest stays as it was; the script names the new CLI.
		expect(install("/new/cli.ts", [], [profile])).toEqual([join(home, ".pagewing", "host.sh")]);
		const manifest = JSON.parse(readFileSync(file!, "utf8"));
		expect(manifest.allowed_origins).toEqual([`chrome-extension://${STORE_ID}/`, "chrome-extension://unpacked/"]);
		expect(readFileSync(manifest.path, "utf8")).toContain("/new/cli.ts");
		expect(install("/new/cli.ts", [], [profile])).toEqual([]);
	});

	it("by default registers in the installed browsers' folders only", () => {
		// Chrome for Testing on Linux: the browser suites and CI run in it.
		const chrome =
			process.platform === "darwin"
				? join(home, "Library", "Application Support", "Google", "Chrome")
				: join(home, ".config", "google-chrome-for-testing");
		expect(install("/cli.ts", [])).toEqual([]);
		mkdirSync(chrome, { recursive: true });
		expect(install("/cli.ts", [])).toEqual([
			join(chrome, "NativeMessagingHosts", `${HOST_NAME}.json`),
			join(home, ".pagewing", "host.sh"),
		]);
	});

	it("quotes paths for the shell", () => {
		const [file] = install(`/a "b" $c 'd'/cli.ts`, [], [join(home, "profile")]);
		const { path } = JSON.parse(readFileSync(file!, "utf8"));
		expect(readFileSync(path, "utf8")).toContain(`'/a "b" $c '\\''d'\\''/cli.ts' host`);
	});

	it("uninstall removes the manifest and the script", () => {
		const profile = join(home, "profile");
		const [file] = install("/cli.ts", [], [profile]);
		expect(uninstall([profile])).toEqual([file]);
		expect(existsSync(file!)).toBe(false);
		expect(existsSync(join(home, ".pagewing", "host.sh"))).toBe(false);
	});
});

/** A registry in memory: key to default value. */
function fakeRegistry() {
	const values = new Map<string, string>();
	const registry: Registry = {
		has: (key, value) => values.get(key) === value,
		set: (key, value) => void values.set(key, value),
		remove: (key) => values.delete(key),
	};
	return { values, registry };
}

/** Makes a browser's user data folder under %LOCALAPPDATA%, as its installer does. */
const installBrowser = (folder: string) =>
	mkdirSync(join(process.env.LOCALAPPDATA!, folder, "User Data"), { recursive: true });

const key = (browser: string) => `Software\\${browser}\\NativeMessagingHosts\\${HOST_NAME}`;

// Setup's Windows branch with a registry in memory: it runs on every platform, so paths use the platform's separator.
describe("install on Windows", () => {
	it("writes host.cmd, one manifest in ~/.pagewing, and each installed browser's key once", () => {
		installBrowser("Google/Chrome");
		installBrowser("Google/Chrome for Testing");
		installBrowser("Microsoft/Edge");
		const { values, registry } = fakeRegistry();
		const manifest = join(home, ".pagewing", `${HOST_NAME}.json`);
		const script = join(home, ".pagewing", "host.cmd");
		expect(installWindows("C:\\Program Files\\工具 100%\\cli.js", ["abc"], registry)).toEqual([
			manifest,
			`HKCU\\${key("Google\\Chrome")}`,
			`HKCU\\${key("Microsoft\\Edge")}`,
			script,
		]);
		// Chrome for Testing reads Chrome's key.
		expect(values).toEqual(
			new Map([
				[key("Google\\Chrome"), manifest],
				[key("Microsoft\\Edge"), manifest],
			]),
		);
		expect(JSON.parse(readFileSync(manifest, "utf8"))).toEqual({
			name: HOST_NAME,
			description: "Pagewing local agents bridge",
			path: script,
			type: "stdio",
			allowed_origins: [`chrome-extension://${STORE_ID}/`, "chrome-extension://abc/"],
		});
		// UTF-8 without a BOM, CRLF, the code page switched before the line with the paths; % doubled.
		const bytes = readFileSync(script);
		expect(bytes.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf]))).toBe(false);
		expect(bytes.toString("utf8")).toMatch(
			/^@chcp 65001 >nul\r\n@"[^"\r\n]*node[^"\r\n]*" "C:\\Program Files\\工具 100%%\\cli\.js" host %\*\r\n$/,
		);
	});

	it("writes nothing when nothing changed, and rewrites a key that names another manifest", () => {
		installBrowser("Google/Chrome");
		const { values, registry } = fakeRegistry();
		installWindows("C:\\cli.js", [], registry);
		expect(installWindows("C:\\cli.js", [], registry)).toEqual([]);
		values.set(key("Google\\Chrome"), "C:\\elsewhere\\host.json");
		expect(installWindows("C:\\cli.js", [], registry)).toEqual([`HKCU\\${key("Google\\Chrome")}`]);
		expect(values.get(key("Google\\Chrome"))).toBe(join(home, ".pagewing", `${HOST_NAME}.json`));
	});

	it("does nothing without an installed browser", () => {
		const { values, registry } = fakeRegistry();
		expect(installWindows("C:\\cli.js", [], registry)).toEqual([]);
		expect(values.size).toBe(0);
		expect(existsSync(join(home, ".pagewing"))).toBe(false);
	});

	it("refuses a user folder whose path holds %, which cmd.exe would expand", () => {
		useHome(mkdtempSync(join(tmpdir(), "a%TEMP%b-")));
		installBrowser("Google/Chrome");
		const { values, registry } = fakeRegistry();
		expect(() => installWindows("C:\\cli.js", [], registry)).toThrow(
			/^Local agents cannot run from a Windows user folder whose path contains %: .*a%TEMP%b-/,
		);
		expect(values.size).toBe(0);
	});

	it("uninstall removes every key, the manifest, and host.cmd", () => {
		installBrowser("Google/Chrome");
		installBrowser("Chromium");
		const { values, registry } = fakeRegistry();
		installWindows("C:\\cli.js", [], registry);
		const manifest = join(home, ".pagewing", `${HOST_NAME}.json`);
		expect(uninstallWindows(registry)).toEqual([
			manifest,
			`HKCU\\${key("Google\\Chrome")}`,
			`HKCU\\${key("Chromium")}`,
		]);
		expect(values.size).toBe(0);
		expect(existsSync(manifest)).toBe(false);
		expect(existsSync(join(home, ".pagewing", "host.cmd"))).toBe(false);
	});
});
