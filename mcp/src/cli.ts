#!/usr/bin/env node
// pagewing-mcp (design 6.45). Without a command: the MCP server, for an MCP client such as `pi mcp add pagewing --
// npx -y pagewing-mcp`; it registers the native host with Chrome first. `install --extension-id` also allows an
// unpacked Pagewing; `uninstall` removes the registration. `host`: the native host, which Chrome starts.

import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { runHost } from "./host.ts";
import { install, uninstall } from "./install.ts";
import { serve } from "./server.ts";

const USAGE = `Usage:
  pagewing-mcp                       the MCP server (stdio), for an MCP client
  pagewing-mcp install [--extension-id ID]... [--user-data-dir DIR]...
                                     register the native host with Chrome (the server does
                                     this itself; use it to allow an unpacked Pagewing)
  pagewing-mcp uninstall [--user-data-dir DIR]...`;

const [command, ...rest] = process.argv.slice(2);
// Chrome starts the host with the calling extension's origin as its first argument.
if (command === "host") runHost();
else if (command === undefined || command === "serve") {
	// Registering at each start means a user never runs setup, and a moved or updated CLI is found again.
	let written: string[] = [];
	try {
		written = install(fileURLToPath(import.meta.url), []);
	} catch (error) {
		console.error(`pagewing-mcp: cannot register with Chrome: ${error instanceof Error ? error.message : error}`);
	}
	serve(process.stdin, process.stdout, { retryUntil: written.length > 0 ? Date.now() + 40_000 : 0 });
} else if (command === "install" || command === "uninstall") {
	const { values } = parseArgs({
		args: rest,
		options: {
			"extension-id": { type: "string", multiple: true, default: [] },
			"user-data-dir": { type: "string", multiple: true, default: [] },
		},
	});
	const dirs = values["user-data-dir"];
	if (command === "install") {
		const written = install(fileURLToPath(import.meta.url), values["extension-id"], dirs);
		if (written.length === 0) console.log("Already registered, or no Chromium browser found (pass --user-data-dir).");
		for (const file of written) console.log(`Registered: ${file}`);
	} else for (const file of uninstall(dirs)) console.log(`Removed: ${file}`);
} else {
	console.error(USAGE);
	process.exit(2);
}
