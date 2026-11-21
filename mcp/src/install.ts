// Setup (design 6.45): registers the native host with Chrome, allowed for Pagewing's store ID and any extension IDs
// given, such as an unpacked install's: on macOS and Linux as a manifest in each browser's NativeMessagingHosts folder,
// on Windows as one manifest that a registry key per browser names (design 6.49). The MCP server does this at each
// start, so a user never runs it; `install --extension-id` adds an unpacked Pagewing.

import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { HOST_NAME, homeDir, STORE_ID } from "./bridge.ts";

/** The registry as setup uses it: one key's default value; reg.exe's on Windows, replaced in tests. */
export type Registry = {
	/** Whether the key's default value is `value`. */
	has(key: string, value: string): boolean;
	set(key: string, value: string): void;
	/** Deletes the key; false when there was none. */
	remove(key: string): boolean;
};

/**
 * Writes the host script and the host manifest, allowed for the store ID, `extensionIds`, and the IDs an earlier setup
 * allowed. `dataDirs`: user data folders to register in, such as a profile started with --user-data-dir; by default every
 * installed browser's. Windows ignores them: Chrome looks only in the registry there. Writes only what changed; returns
 * the files written, the manifests first.
 */
export function install(cli: string, extensionIds: string[], dataDirs: string[] = []): string[] {
	if (process.platform === "win32") return installWindows(cli, extensionIds, regExe);
	const folders = dataDirs.length > 0 ? dataDirs : browserFolders().filter((folder) => existsSync(folder));
	if (folders.length === 0) return [];
	mkdirSync(homeDir(), { recursive: true, mode: 0o700 });
	chmodSync(homeDir(), 0o700);
	// Chrome starts the host with no arguments of ours and a short PATH: the script names Node and the CLI in full.
	const script = join(homeDir(), "host.sh");
	const scriptChanged = writeScript(
		script,
		`#!/bin/sh\nexec ${shellQuote(stableNode())} ${shellQuote(cli)} host "$@"\n`,
		cli,
	);
	const manifests = folders.flatMap((folder) => {
		const file = join(folder, "NativeMessagingHosts", `${HOST_NAME}.json`);
		return writeManifest(file, script, extensionIds) ? [file] : [];
	});
	return scriptChanged ? [...manifests, script] : manifests;
}

/**
 * Setup on Windows: `host.cmd`, one manifest in ~/.pagewing, and a registry key naming it for each browser installed.
 * Returns the manifest, the keys, and the script it wrote.
 */
export function installWindows(cli: string, extensionIds: string[], registry: Registry): string[] {
	const local = process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local");
	const keys = windowsKeys(WINDOWS_BROWSERS.filter(([folder]) => existsSync(join(local, folder, "User Data"))));
	if (keys.length === 0) return [];
	const script = join(homeDir(), "host.cmd");
	// cmd.exe expands %NAME% in the command line Chrome starts the script with, before the script runs.
	if (script.includes("%"))
		throw new Error(`Local agents cannot run from a Windows user folder whose path contains %: ${script}.`);
	mkdirSync(homeDir(), { recursive: true });
	// cmd.exe reads a batch file in the console's code page, a legacy one on most PCs: the first line switches to UTF-8
	// before the second, with its paths, is read. In a batch file %% is a literal %.
	const quote = (value: string) => `"${value.replaceAll("%", "%%")}"`;
	const scriptChanged = writeScript(
		script,
		`@chcp 65001 >nul\r\n@${quote(stableNode())} ${quote(cli)} host %*\r\n`,
		cli,
	);
	const manifest = join(homeDir(), `${HOST_NAME}.json`);
	const written = writeManifest(manifest, script, extensionIds) ? [manifest] : [];
	for (const key of keys)
		if (!registry.has(key, manifest)) {
			registry.set(key, manifest);
			written.push(`HKCU\\${key}`);
		}
	return scriptChanged ? [...written, script] : written;
}

/** The user data folders of the Chromium browsers Pagewing may run in, on macOS and Linux. */
function browserFolders(): string[] {
	const home = homedir();
	if (process.platform === "darwin") {
		const support = join(home, "Library", "Application Support");
		return [
			"Google/Chrome",
			"Google/Chrome Beta",
			"Google/Chrome Canary",
			"Google/Chrome for Testing",
			"Chromium",
			"Microsoft Edge",
			"BraveSoftware/Brave-Browser",
		].map((name) => join(support, name));
	}
	if (process.platform === "linux")
		return [
			"google-chrome",
			"google-chrome-beta",
			"google-chrome-for-testing",
			"chromium",
			"microsoft-edge",
			"BraveSoftware/Brave-Browser",
		].map((name) => join(home, ".config", name));
	throw new Error(`Local agents do not support ${process.platform} yet.`);
}

/**
 * Each Windows browser's folder under %LOCALAPPDATA%, and the registry key it reads hosts from. Every Google build,
 * Chrome for Testing included, reads Chrome's key (Chromium 147, launch_context_win.cc); Brave's is untested.
 */
const WINDOWS_BROWSERS: [folder: string, key: string][] = [
	["Google/Chrome", "Google\\Chrome"],
	["Google/Chrome Beta", "Google\\Chrome"],
	["Google/Chrome Dev", "Google\\Chrome"],
	["Google/Chrome SxS", "Google\\Chrome"],
	["Google/Chrome for Testing", "Google\\Chrome"],
	["Chromium", "Chromium"],
	["Microsoft/Edge", "Microsoft\\Edge"],
	["BraveSoftware/Brave-Browser", "BraveSoftware\\Brave-Browser"],
];

/** The host's registry key under HKCU for each of `browsers`, each key once. */
const windowsKeys = (browsers: [string, string][]) => [
	...new Set(browsers.map(([, key]) => `Software\\${key}\\NativeMessagingHosts\\${HOST_NAME}`)),
];

/** Writes the host script when it changed; true when it did. */
function writeScript(script: string, body: string, cli: string): boolean {
	const before = readText(script);
	if (before === body) return false;
	writeFileSync(script, body, { mode: 0o700 });
	// Two copies of the CLI, such as a source checkout and npx's, take the helper from each other at each start.
	if (before !== null) console.error(`pagewing-mcp: Chrome's helper now runs ${cli}; it ran another copy before.`);
	return true;
}

/** Writes the host manifest at `file` when it changed, keeping the IDs it allowed; true when it did. */
function writeManifest(file: string, script: string, extensionIds: string[]): boolean {
	const before = readText(file);
	const manifest = {
		name: HOST_NAME,
		description: "Pagewing local agents bridge",
		path: script,
		type: "stdio",
		allowed_origins: [
			...new Set([
				...[STORE_ID, ...extensionIds].map((id) => `chrome-extension://${id}/`),
				...allowedBefore(before),
			]),
		],
	};
	const text = `${JSON.stringify(manifest, null, "\t")}\n`;
	if (text === before) return false;
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(file, text);
	return true;
}

/**
 * The running Node by a path that outlives an upgrade: Homebrew's versioned Cellar path goes with the next `brew
 * upgrade`, its bin link stays.
 */
function stableNode(): string {
	const running = realpathSync(process.execPath);
	return (
		["/opt/homebrew/bin/node", "/usr/local/bin/node", "/usr/bin/node"].find(
			(link) => existsSync(link) && realpathSync(link) === running,
		) ?? process.execPath
	);
}

/** The file's text, or null when there is none. */
function readText(file: string): string | null {
	try {
		return readFileSync(file, "utf8");
	} catch {
		return null;
	}
}

/** The extensions an earlier manifest allowed, such as an unpacked Pagewing's; none when it is missing or not ours. */
function allowedBefore(text: string | null): string[] {
	try {
		const { allowed_origins } = JSON.parse(text ?? "{}") as { allowed_origins?: unknown };
		return Array.isArray(allowed_origins)
			? allowed_origins.filter((origin) => typeof origin === "string" && origin.startsWith("chrome-extension://"))
			: [];
	} catch {
		return [];
	}
}

/** `value` as one sh word: in single quotes, each single quote closed, escaped, and opened again. */
const shellQuote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;

/**
 * The registry through reg.exe: no dependency, no administrator. `query /f /d /e` matches the value exactly, so the
 * check never decodes reg.exe's output, which is in the console's code page.
 */
const regExe: Registry = {
	has: (key, value) => {
		const { status, stdout } = reg(["query", `HKCU\\${key}`, "/f", value, "/d", "/e"]);
		return status === 0 && stdout.includes("REG_SZ");
	},
	set: (key, value) => {
		const { status, stderr } = reg(["add", `HKCU\\${key}`, "/ve", "/t", "REG_SZ", "/d", value, "/f"]);
		if (status !== 0) throw new Error(`reg.exe could not write HKCU\\${key}: ${stderr.trim()}`);
	},
	remove: (key) => reg(["delete", `HKCU\\${key}`, "/f"]).status === 0,
};

const reg = (args: string[]) => spawnSync("reg.exe", args, { encoding: "utf8", windowsHide: true });

/** Removes the registration and the host script; returns the manifests (and on Windows the keys) removed. */
export function uninstall(dataDirs: string[] = []): string[] {
	if (process.platform === "win32") return uninstallWindows(regExe);
	const folders = dataDirs.length > 0 ? dataDirs : browserFolders();
	const removed = folders
		.map((folder) => join(folder, "NativeMessagingHosts", `${HOST_NAME}.json`))
		.filter((file) => existsSync(file));
	for (const file of removed) rmSync(file);
	rmSync(join(homeDir(), "host.sh"), { force: true });
	return removed;
}

/** Uninstall on Windows: every known browser's key, the manifest, and `host.cmd`. */
export function uninstallWindows(registry: Registry): string[] {
	const manifest = join(homeDir(), `${HOST_NAME}.json`);
	const removed = existsSync(manifest) ? [manifest] : [];
	for (const key of windowsKeys(WINDOWS_BROWSERS)) if (registry.remove(key)) removed.push(`HKCU\\${key}`);
	rmSync(manifest, { force: true });
	rmSync(join(homeDir(), "host.cmd"), { force: true });
	return removed;
}
