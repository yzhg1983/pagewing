// Setup (design 6.45): registers the native host with Chrome, as a manifest in each browser's NativeMessagingHosts
// folder, allowed for pi-aside's store ID and any extension IDs given, such as an unpacked install's.

import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { HOST_NAME, homeDir, STORE_ID } from "./bridge.ts";

/** The user data folders of the Chromium browsers pi-aside may run in, per platform. */
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
 * Writes the host script and the host manifest. `dataDirs`: user data folders to register in, such as a profile
 * started with --user-data-dir; by default every installed browser's. Returns the manifests written.
 */
export function install(cli: string, extensionIds: string[], dataDirs: string[] = []): string[] {
	mkdirSync(homeDir(), { recursive: true, mode: 0o700 });
	chmodSync(homeDir(), 0o700);
	// Chrome starts the host with no arguments of ours and a short PATH: the script names Node and the CLI in full.
	const script = join(homeDir(), "host.sh");
	writeFileSync(script, `#!/bin/sh\nexec ${shellQuote(process.execPath)} ${shellQuote(cli)} host "$@"\n`, {
		mode: 0o700,
	});
	const manifest = {
		name: HOST_NAME,
		description: "pi-aside local agents bridge",
		path: script,
		type: "stdio",
		allowed_origins: [...new Set([STORE_ID, ...extensionIds])].map((id) => `chrome-extension://${id}/`),
	};
	const folders = dataDirs.length > 0 ? dataDirs : browserFolders().filter((folder) => existsSync(folder));
	return folders.map((folder) => {
		const hosts = join(folder, "NativeMessagingHosts");
		mkdirSync(hosts, { recursive: true });
		const file = join(hosts, `${HOST_NAME}.json`);
		writeFileSync(file, `${JSON.stringify(manifest, null, "\t")}\n`);
		return file;
	});
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
