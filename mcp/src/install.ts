// Setup (design 6.45): registers the native host with Chrome, as a manifest in each browser's NativeMessagingHosts
// folder, allowed for Pagewing's store ID and any extension IDs given, such as an unpacked install's. The MCP server
// does this at each start, so a user never runs it; `install --extension-id` adds an unpacked Pagewing.

import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { HOST_NAME, homeDir, STORE_ID } from "./bridge.ts";

/** The user data folders of the Chromium browsers Pagewing may run in, per platform. */
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
		return ["google-chrome", "google-chrome-beta", "chromium", "microsoft-edge", "BraveSoftware/Brave-Browser"].map(
			(name) => join(home, ".config", name),
		);
	throw new Error(`Local agents do not support ${process.platform} yet.`);
}

/**
 * Writes the host script and the host manifest, allowed for the store ID, `extensionIds`, and the IDs an earlier setup
 * allowed. `dataDirs`: user data folders to register in, such as a profile started with --user-data-dir; by default every
 * installed browser's. Writes only what changed; returns the files written, the manifests first.
 */
export function install(cli: string, extensionIds: string[], dataDirs: string[] = []): string[] {
	const folders = dataDirs.length > 0 ? dataDirs : browserFolders().filter((folder) => existsSync(folder));
	if (folders.length === 0) return [];
	mkdirSync(homeDir(), { recursive: true, mode: 0o700 });
	chmodSync(homeDir(), 0o700);
	// Chrome starts the host with no arguments of ours and a short PATH: the script names Node and the CLI in full.
	const script = join(homeDir(), "host.sh");
	const body = `#!/bin/sh\nexec ${shellQuote(stableNode())} ${shellQuote(cli)} host "$@"\n`;
	const before = readText(script);
	const scriptChanged = before !== body;
	if (scriptChanged) writeFileSync(script, body, { mode: 0o700 });
	// Two copies of the CLI, such as a source checkout and npx's, take the helper from each other at each start.
	if (scriptChanged && before !== null)
		console.error(`pagewing-mcp: Chrome's helper now runs ${cli}; it ran another copy before.`);
	const manifests = folders.flatMap((folder) => {
		const hosts = join(folder, "NativeMessagingHosts");
		const file = join(hosts, `${HOST_NAME}.json`);
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
		if (text === before) return [];
		mkdirSync(hosts, { recursive: true });
		writeFileSync(file, text);
		return [file];
	});
	return scriptChanged ? [...manifests, script] : manifests;
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

/** Removes the manifests and the host script; returns the manifests removed. */
export function uninstall(dataDirs: string[] = []): string[] {
	const folders = dataDirs.length > 0 ? dataDirs : browserFolders();
	const removed = folders
		.map((folder) => join(folder, "NativeMessagingHosts", `${HOST_NAME}.json`))
		.filter((file) => existsSync(file));
	for (const file of removed) rmSync(file);
	rmSync(join(homeDir(), "host.sh"), { force: true });
	return removed;
}
