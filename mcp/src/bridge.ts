// What the three processes of a local agent share (design 6.45): the native host's name, the socket the MCP servers
// reach the host on, and the two framings: Chrome's native messages and newline-delimited JSON on the socket.

import { homedir } from "node:os";
import { join } from "node:path";
import type { Readable, Writable } from "node:stream";

/** The native messaging host Pagewing connects to; Chrome finds its manifest by this name. */
export const HOST_NAME = "io.github.yzhg1983.pagewing";
/** Pagewing's ID in the Chrome Web Store. */
export const STORE_ID = "eamkpenaglckggljpkdljhillecgpjlp";
/** Chrome refuses a native message to the extension over 1 MB; the host refuses a socket line over this first. */
export const MAX_MESSAGE_BYTES = 1_000_000;

/** Pagewing's folder in the user's home: the host script and the socket, readable by the user alone. */
export const homeDir = () => join(homedir(), ".pagewing");
export const socketPath = () => join(homeDir(), "bridge.sock");

/** A call result as MCP's tools/call returns it. */
export type ToolResult = {
	content: ({ type: "text"; text: string } | { type: "image"; data: string; mimeType: string })[];
	isError?: boolean;
};

/** From an MCP server to Pagewing, through the host; the host adds the session. */
export type AgentRequest =
	| { type: "open"; name: string }
	| { type: "call"; id: number; tool: string; args: Record<string, unknown> }
	| { type: "cancel"; id: number };

/** From Pagewing to an MCP server, through the host. */
export type AgentReply = { type: "result"; id: number; result: ToolResult };

/** A text result; `isError` marks a refusal or failure the agent should read. */
export const textResult = (text: string, isError = false): ToolResult => ({
	content: [{ type: "text", text }],
	...(isError ? { isError } : {}),
});

/**
 * Calls `each` with every JSON line of `stream`. A line longer than `maxBytes` ends the stream: `tooLong` is called and
 * nothing more is read.
 */
export function readLines(stream: Readable, each: (value: unknown) => void, maxBytes: number, tooLong: () => void) {
	let pending = "";
	stream.setEncoding("utf8");
	stream.on("data", (chunk: string) => {
		pending += chunk;
		for (let end = pending.indexOf("\n"); end >= 0; end = pending.indexOf("\n")) {
			const line = pending.slice(0, end).trim();
			pending = pending.slice(end + 1);
			if (Buffer.byteLength(line) > maxBytes) {
				stream.removeAllListeners("data");
				tooLong();
				return;
			}
			if (line === "") continue;
			try {
				each(JSON.parse(line));
			} catch {
				// Not JSON: the peer is not one of ours; its line is dropped.
			}
		}
		if (Buffer.byteLength(pending) > maxBytes) {
			stream.removeAllListeners("data");
			tooLong();
		}
	});
}

export const writeLine = (stream: Writable, value: unknown) => stream.write(`${JSON.stringify(value)}\n`);

/** Calls `each` with every native message Chrome writes: a 32-bit length in the machine's byte order, then JSON. */
export function readNative(stream: Readable, each: (value: unknown) => void): void {
	let pending = Buffer.alloc(0);
	stream.on("data", (chunk: Buffer) => {
		pending = Buffer.concat([pending, chunk]);
		while (pending.length >= 4) {
			const length = pending.readUInt32LE(0);
			if (pending.length < 4 + length) break;
			const body = pending.subarray(4, 4 + length).toString("utf8");
			pending = pending.subarray(4 + length);
			each(JSON.parse(body));
		}
	});
}

/** Writes one native message to Chrome. */
export function writeNative(stream: Writable, value: unknown): void {
	const body = Buffer.from(JSON.stringify(value), "utf8");
	const header = Buffer.alloc(4);
	header.writeUInt32LE(body.length, 0);
	stream.write(Buffer.concat([header, body]));
}
