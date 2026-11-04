#!/usr/bin/env node
// pi-aside-mcp (design 6.45). Without a command: the MCP server, for an MCP client such as `pi mcp add pi-aside --
// pi-aside-mcp`. `install` and `uninstall`: register the native host with Chrome. `host`: the native host, which
// Chrome starts.

import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { runHost } from "./host.ts";
import { install, uninstall } from "./install.ts";
import { serve } from "./server.ts";

const USAGE = `Usage:
  pi-aside-mcp                       the MCP server (stdio), for an MCP client
  pi-aside-mcp install [--extension-id ID]... [--user-data-dir DIR]...
                                     register the native host with Chrome
  pi-aside-mcp uninstall [--user-data-dir DIR]...`;

const [command, ...rest] = process.argv.slice(2);
// Chrome starts the host with the calling extension's origin as its first argument.
if (command === "host") runHost();
else if (command === undefined || command === "serve") serve(process.stdin, process.stdout);
else if (command === "install" || command === "uninstall") {
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
		if (written.length === 0) console.log("No Chromium browser found; pass --user-data-dir.");
		for (const file of written) console.log(`Registered: ${file}`);
		console.log("Restart Chrome, then turn on Settings > Advanced > Local agents in pi-aside.");
	} else for (const file of uninstall(dirs)) console.log(`Removed: ${file}`);
} else {
	console.error(USAGE);
	process.exit(2);
}
