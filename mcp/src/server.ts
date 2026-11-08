// The MCP server (design 6.45): an MCP client, such as pi, starts it over stdio, and it passes each tool call to
// Pagewing through the native host's socket. It connects at the first call, so an agent that never uses the browser
// opens no session, and again after the connection ended: a new session, with a new tab group.

import { connect as connectSocket, type Socket } from "node:net";
import type { Readable, Writable } from "node:stream";
import {
	type AgentReply,
	type AgentRequest,
	MAX_MESSAGE_BYTES,
	readLines,
	STORE_ID,
	socketPath,
	type ToolResult,
	textResult,
	writeLine,
} from "./bridge.ts";
import { TOOLS } from "./tools.ts";

const VERSION = "0.1.0";
/** The newest MCP version first; a client asking for another gets the newest. */
const PROTOCOLS = ["2025-06-18", "2025-03-26", "2024-11-05"];

const INSTRUCTIONS = `Pagewing drives the user's Chrome, with their logins, in a Chrome tab group of this session. \
Start with open_tab; then read_page for text, observe_page and act_on_page to work the page, run_script for data, \
and screenshot_page for how it looks.`;

/** What a call says when Pagewing cannot be reached. */
export const NOT_CONNECTED = `Pagewing is not connected. Ask the user to install Pagewing in Chrome \
(https://chromewebstore.google.com/detail/pagewing/${STORE_ID}), version 0.4.3 or later, open its side panel, and turn \
on Settings > Advanced > Local agents.`;

const ENDED = `The connection to Pagewing ended during the call: it may or may not have happened. Check before \
trying again.`;

type JsonRpc = { jsonrpc: "2.0"; id?: number | string; method?: string; params?: Record<string, unknown> };

/** Opens a socket to the host; replaced in tests. */
export type Connect = () => Socket;

/**
 * How the server reaches the host. `retryUntil`: until this time, a call that finds no host tries again each second:
 * after a new registration, Pagewing starts the host at its next retry, within 30 s.
 */
export type ServeOptions = { connect?: Connect; retryUntil?: number };

/** Serves MCP on `input` and `output` until `input` ends. */
export function serve(
	input: Readable,
	output: Writable,
	{ connect = () => connectSocket(socketPath()), retryUntil = 0 }: ServeOptions = {},
): void {
	const reply = (id: JsonRpc["id"], result: unknown) => writeLine(output, { jsonrpc: "2.0", id, result });
	const fail = (id: JsonRpc["id"], code: number, message: string) =>
		writeLine(output, { jsonrpc: "2.0", id, error: { code, message } });
	const bridge = new Bridge(connect, retryUntil);

	readLines(
		input,
		(value) => {
			const { id, method, params = {} } = value as JsonRpc;
			if (id === undefined) {
				if (method === "notifications/cancelled") void bridge.cancel(params.requestId as number | string);
				return;
			}
			switch (method) {
				case "initialize": {
					const asked = params.protocolVersion as string | undefined;
					bridge.name = ((params.clientInfo as { name?: string } | undefined)?.name ?? "agent").slice(0, 40);
					reply(id, {
						protocolVersion: asked !== undefined && PROTOCOLS.includes(asked) ? asked : PROTOCOLS[0],
						capabilities: { tools: {} },
						serverInfo: { name: "pagewing", version: VERSION },
						instructions: INSTRUCTIONS,
					});
					return;
				}
				case "ping":
					reply(id, {});
					return;
				case "tools/list":
					reply(id, { tools: TOOLS });
					return;
				case "tools/call": {
					const name = params.name as string;
					if (!TOOLS.some((tool) => tool.name === name)) {
						fail(id, -32602, `Unknown tool: ${name}`);
						return;
					}
					void bridge
						.call(id, name, (params.arguments as Record<string, unknown>) ?? {})
						.then((result) => reply(id, result));
					return;
				}
				default:
					fail(id, -32601, `Method not found: ${method}`);
			}
		},
		MAX_MESSAGE_BYTES,
		() => process.exit(1),
	);
	input.on("end", () => bridge.close());
}

/** One session with Pagewing: the socket, and the calls waiting for their results. */
class Bridge {
	name = "agent";
	readonly #connect: Connect;
	readonly #retryUntil: number;
	/** The session's socket, or its connect while it runs: calls that arrive together share one session. */
	#socket: Promise<Session | null> | null = null;
	#next = 0;

	constructor(connect: Connect, retryUntil: number) {
		this.#connect = connect;
		this.#retryUntil = retryUntil;
	}

	/** Sends the call to Pagewing and gives its result; a result says when Pagewing cannot be reached. */
	async call(request: number | string, tool: string, args: Record<string, unknown>): Promise<ToolResult> {
		const session = await this.#open();
		if (session === null) return textResult(NOT_CONNECTED, true);
		const id = ++this.#next;
		return new Promise((done) => {
			session.calls.set(id, { request, done });
			writeLine(session.socket, { type: "call", id, tool, args } satisfies AgentRequest);
		});
	}

	/** Asks Pagewing to stop the call the MCP request `request` made. */
	async cancel(request: number | string): Promise<void> {
		const session = await this.#socket;
		for (const [id, call] of session?.calls ?? [])
			if (call.request === request) writeLine(session!.socket, { type: "cancel", id } satisfies AgentRequest);
	}

	close(): void {
		void this.#socket?.then((session) => session?.socket.end());
	}

	/** The session, or a new one; null when the host is not there. */
	#open(): Promise<Session | null> {
		this.#socket ??= this.#attempt();
		return this.#socket;
	}

	async #attempt(): Promise<Session | null> {
		for (;;) {
			const session = await this.#try();
			if (session !== null || Date.now() >= this.#retryUntil) {
				if (session === null) this.#socket = null;
				return session;
			}
			await new Promise((resolve) => setTimeout(resolve, 1000));
		}
	}

	/** One connect: the new session, or null when the host is not there. */
	#try(): Promise<Session | null> {
		return new Promise((resolve) => {
			const socket = this.#connect();
			socket.once("error", () => resolve(null));
			socket.once("connect", () => {
				const session: Session = { socket, calls: new Map() };
				// An error closes the socket too, which ends the waiting calls.
				socket.on("error", () => {});
				socket.on("close", () => this.#ended(session));
				readLines(
					socket,
					(value) => {
						const { id, result } = value as AgentReply;
						session.calls.get(id)?.done(result);
						session.calls.delete(id);
					},
					MAX_MESSAGE_BYTES * 64,
					() => socket.destroy(),
				);
				writeLine(socket, { type: "open", name: this.name } satisfies AgentRequest);
				resolve(session);
			});
		});
	}

	/** Every waiting call of the session ends; the next call opens a new session. */
	#ended(session: Session): void {
		void this.#socket?.then((current) => {
			if (current === session) this.#socket = null;
		});
		for (const call of session.calls.values()) call.done(textResult(ENDED, true));
		session.calls.clear();
	}
}

/** A socket to the host, and its calls by their bridge ID, with the MCP request ID each answers. */
type Session = {
	socket: Socket;
	calls: Map<number, { request: number | string; done: (result: ToolResult) => void }>;
};
