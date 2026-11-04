// The native host (design 6.45): Chrome starts it when pi-aside's Local agents switch is on, and it lives as long as
// pi-aside keeps the port open. It listens on a socket in ~/.pi-aside, readable by the user alone, and passes messages
// between each MCP server that connects, one session each, and pi-aside.

import { chmodSync, mkdirSync, rmSync, statSync } from "node:fs";
import { createServer, type Socket } from "node:net";
import {
	type AgentReply,
	type AgentRequest,
	homeDir,
	MAX_MESSAGE_BYTES,
	readLines,
	readNative,
	socketPath,
	textResult,
	writeLine,
	writeNative,
} from "./bridge.ts";

/** A message between the host and pi-aside: a socket's message with the session it came from or goes to. */
type Routed<T> = T & { session: string };

/** Serves sessions until Chrome closes the port, which ends stdin; then removes the socket and exits. */
export function runHost(): void {
	const sessions = new Map<string, Socket>();
	let next = 0;
	const toChrome = (message: Routed<AgentRequest> | { type: "close"; session: string }) =>
		writeNative(process.stdout, message);

	mkdirSync(homeDir(), { recursive: true, mode: 0o700 });
	// The folder may be older than this host: other users must not reach the socket in it.
	chmodSync(homeDir(), 0o700);
	// A socket left by a host that did not exit cleanly, or by another Chrome profile's host: the newest host serves.
	rmSync(socketPath(), { force: true });
	const server = createServer((socket) => {
		const session = `s${++next}`;
		sessions.set(session, socket);
		readLines(
			socket,
			(value) => {
				const routed = { ...(value as AgentRequest), session };
				// Chrome drops the port, and with it every session, on a message over 1 MB: refuse it here instead.
				if (Buffer.byteLength(JSON.stringify(routed)) > MAX_MESSAGE_BYTES) {
					if (routed.type === "call")
						writeLine(socket, {
							type: "result",
							id: routed.id,
							result: textResult("The call is too large for Chrome's native messaging (1 MB).", true),
						} satisfies AgentReply);
					else socket.destroy();
					return;
				}
				toChrome(routed);
			},
			// Longer lines than Chrome takes still get a refusal; only much longer ones end the socket.
			MAX_MESSAGE_BYTES * 2,
			() => socket.destroy(),
		);
		socket.on("close", () => {
			if (sessions.delete(session)) toChrome({ type: "close", session });
		});
		socket.on("error", () => {});
	});
	/** The socket's inode: a newer host may have replaced the socket, and this one must not remove that one's. */
	let own: number | undefined;
	server.listen(socketPath(), () => {
		chmodSync(socketPath(), 0o600);
		own = statSync(socketPath()).ino;
		// pi-aside's Settings says the bridge runs only from here: before, an agent finds no socket.
		writeNative(process.stdout, { type: "ready" });
	});

	readNative(process.stdin, (value) => {
		const { session, ...message } = value as Routed<AgentReply>;
		const socket = sessions.get(session);
		if (socket !== undefined) writeLine(socket, message);
	});
	process.stdin.on("end", () => {
		for (const socket of sessions.values()) socket.destroy();
		server.close();
		if (own !== undefined && statSync(socketPath(), { throwIfNoEntry: false })?.ino === own)
			rmSync(socketPath(), { force: true });
		process.exit(0);
	});
}
