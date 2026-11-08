// The MCP server: the MCP methods, and tool calls passed to a fake host over a socket.

import { mkdtempSync } from "node:fs";
import { connect, createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readLines, writeLine } from "../src/bridge.ts";
import { NOT_CONNECTED, serve } from "../src/server.ts";

type Response = { id: number; result?: Record<string, unknown>; error?: { code: number; message: string } };

/** An MCP client on a server: `send` writes a request; `response` waits for the answer to an ID. */
function client(path: string, retryUntil = 0) {
	const input = new PassThrough();
	const output = new PassThrough();
	serve(input, output, { connect: () => connect(path), retryUntil });
	const responses: Response[] = [];
	readLines(
		output,
		(value) => responses.push(value as Response),
		1e8,
		() => {},
	);
	return {
		send: (message: Record<string, unknown>) => writeLine(input, { jsonrpc: "2.0", ...message }),
		response: (id: number) =>
			vi.waitFor(() => {
				const found = responses.find((response) => response.id === id);
				if (found === undefined) throw new Error(`No response to ${id} yet`);
				return found;
			}),
		end: () => input.end(),
	};
}

/** A host stand-in on a socket, at `path` or a new one: records what each session sends. */
function fakeHost(path = join(mkdtempSync(join(tmpdir(), "pagewing-mcp-")), "bridge.sock")) {
	const received: Record<string, unknown>[] = [];
	const sockets: Socket[] = [];
	const server: Server = createServer((socket) => {
		sockets.push(socket);
		readLines(
			socket,
			(value) => received.push(value as Record<string, unknown>),
			1e8,
			() => {},
		);
	});
	servers.push(server);
	return new Promise<{ path: string; received: typeof received; sockets: Socket[] }>((resolve) =>
		server.listen(path, () => resolve({ path, received, sockets })),
	);
}

const servers: Server[] = [];
afterEach(() => {
	for (const server of servers.splice(0)) server.close();
});

describe("MCP methods", () => {
	it("initialize names the server and keeps a supported version; tools/list lists the tools", async () => {
		const mcp = client("/nonexistent/bridge.sock");
		mcp.send({ id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", clientInfo: { name: "pi" } } });
		const init = await mcp.response(1);
		expect(init.result).toMatchObject({ protocolVersion: "2025-03-26", serverInfo: { name: "pagewing" } });
		mcp.send({ id: 2, method: "initialize", params: { protocolVersion: "1999-01-01" } });
		expect((await mcp.response(2)).result?.protocolVersion).toBe("2025-06-18");
		mcp.send({ id: 3, method: "tools/list" });
		const names = ((await mcp.response(3)).result!.tools as { name: string }[]).map((tool) => tool.name);
		expect(names).toEqual([
			"list_tabs",
			"open_tab",
			"read_page",
			"observe_page",
			"act_on_page",
			"run_script",
			"screenshot_page",
			"close_tab",
		]);
		mcp.end();
	});

	it("an unknown tool and an unknown method are JSON-RPC errors", async () => {
		const mcp = client("/nonexistent/bridge.sock");
		mcp.send({ id: 1, method: "tools/call", params: { name: "format_disk", arguments: {} } });
		expect((await mcp.response(1)).error?.code).toBe(-32602);
		mcp.send({ id: 2, method: "resources/list" });
		expect((await mcp.response(2)).error?.code).toBe(-32601);
		mcp.end();
	});
});

describe("tool calls", () => {
	it("without a host, a call says how to connect Pagewing", async () => {
		const mcp = client("/nonexistent/bridge.sock");
		mcp.send({ id: 1, method: "tools/call", params: { name: "list_tabs", arguments: {} } });
		expect((await mcp.response(1)).result).toEqual({
			content: [{ type: "text", text: NOT_CONNECTED }],
			isError: true,
		});
		mcp.end();
	});

	it("after a new registration, a call waits for Pagewing to start the host", async () => {
		const path = join(mkdtempSync(join(tmpdir(), "pagewing-mcp-")), "bridge.sock");
		const mcp = client(path, Date.now() + 10_000);
		mcp.send({ id: 1, method: "tools/call", params: { name: "list_tabs", arguments: {} } });
		await new Promise((resolve) => setTimeout(resolve, 1500));
		const host = await fakeHost(path);
		await expect.poll(() => host.received, { timeout: 3000 }).toHaveLength(2);
		writeLine(host.sockets[0]!, { type: "result", id: 1, result: { content: [] } });
		expect((await mcp.response(1)).result).toEqual({ content: [] });
		mcp.end();
	});

	it("opens a session at the first call, with the client's name, and passes the result back", async () => {
		const host = await fakeHost();
		const mcp = client(host.path);
		mcp.send({ id: 1, method: "initialize", params: { clientInfo: { name: "pi" } } });
		await mcp.response(1);
		expect(host.sockets).toHaveLength(0);
		mcp.send({ id: 7, method: "tools/call", params: { name: "open_tab", arguments: { url: "https://a.test/" } } });
		await expect.poll(() => host.received).toHaveLength(2);
		expect(host.received[0]).toEqual({ type: "open", name: "pi" });
		const call = host.received[1] as { id: number };
		expect(call).toMatchObject({ type: "call", tool: "open_tab", args: { url: "https://a.test/" } });
		writeLine(host.sockets[0]!, { type: "result", id: call.id, result: { content: [{ type: "text", text: "ok" }] } });
		expect((await mcp.response(7)).result).toEqual({ content: [{ type: "text", text: "ok" }] });
		mcp.end();
	});

	it("calls that arrive together share one session", async () => {
		const host = await fakeHost();
		const mcp = client(host.path);
		mcp.send({ id: 1, method: "tools/call", params: { name: "list_tabs", arguments: {} } });
		mcp.send({ id: 2, method: "tools/call", params: { name: "list_tabs", arguments: {} } });
		await expect.poll(() => host.received).toHaveLength(3);
		expect(host.sockets).toHaveLength(1);
		expect(host.received.filter((message) => message.type === "open")).toHaveLength(1);
		mcp.end();
	});

	it("a cancel goes to Pagewing with the call's bridge ID", async () => {
		const host = await fakeHost();
		const mcp = client(host.path);
		mcp.send({ id: "r1", method: "tools/call", params: { name: "run_script", arguments: { code: "1" } } });
		await expect.poll(() => host.received).toHaveLength(2);
		mcp.send({ method: "notifications/cancelled", params: { requestId: "r1" } });
		const { id } = host.received[1] as { id: number };
		await expect.poll(() => host.received[2]).toEqual({ type: "cancel", id });
		mcp.end();
	});

	it("when the session ends during a call, the call says it may have happened; the next call opens a new session", async () => {
		const host = await fakeHost();
		const mcp = client(host.path);
		mcp.send({ id: 1, method: "tools/call", params: { name: "act_on_page", arguments: { action: "click" } } });
		await expect.poll(() => host.received).toHaveLength(2);
		host.sockets[0]!.destroy();
		const ended = await mcp.response(1);
		expect(ended.result?.isError).toBe(true);
		expect(JSON.stringify(ended.result)).toContain("may or may not have happened");
		mcp.send({ id: 2, method: "tools/call", params: { name: "list_tabs", arguments: {} } });
		await expect.poll(() => host.sockets).toHaveLength(2);
		await expect.poll(() => host.received[2]).toEqual({ type: "open", name: "agent" });
		mcp.end();
	});
});
