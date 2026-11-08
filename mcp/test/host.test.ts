// The native host, as Chrome runs it: native messages on stdin and stdout, MCP servers on its socket.

import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdtempSync, statSync } from "node:fs";
import { connect, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readLines, readNative, writeLine, writeNative } from "../src/bridge.ts";

const CLI = join(import.meta.dirname, "..", "src", "cli.ts");

/**
 * A host started as Chrome starts it, with its home in a new folder; `fromHost` collects its native messages after
 * `ready`, which says it listens.
 */
function startHost() {
	// Short: a unix socket path must stay under about 100 bytes.
	const home = mkdtempSync(join(tmpdir(), "pa-"));
	const child = spawn(process.execPath, [CLI, "host", "chrome-extension://test/"], {
		env: { ...process.env, HOME: home },
		stdio: ["pipe", "pipe", "inherit"],
	});
	children.push(child);
	const fromHost: Record<string, unknown>[] = [];
	let ready = false;
	readNative(child.stdout!, (value) => {
		if ((value as { type: string }).type === "ready") ready = true;
		else fromHost.push(value as Record<string, unknown>);
	});
	const socketPath = join(home, ".pagewing", "bridge.sock");
	return { child, home, socketPath, fromHost, ready: () => vi.waitFor(() => expect(ready).toBe(true)) };
}

/** An MCP server stand-in on the host's socket, once it listens: `lines` collects what Pagewing sends it. */
async function agent(host: ReturnType<typeof startHost>) {
	await host.ready();
	const socket: Socket = connect(host.socketPath);
	await new Promise((resolve) => socket.once("connect", resolve));
	const lines: Record<string, unknown>[] = [];
	readLines(
		socket,
		(value) => lines.push(value as Record<string, unknown>),
		1e8,
		() => {},
	);
	return { socket, lines };
}

const children: ChildProcess[] = [];
afterEach(() => {
	for (const child of children.splice(0)) child.kill();
});

describe("routing", () => {
	it("passes each socket's messages to Chrome with its session, and Chrome's replies to that socket", async () => {
		const host = startHost();
		const a = await agent(host);
		const b = await agent(host);
		writeLine(a.socket, { type: "open", name: "a" });
		writeLine(b.socket, { type: "open", name: "b" });
		await vi.waitFor(() => expect(host.fromHost).toHaveLength(2));
		const session = (name: string) =>
			(host.fromHost.find((message) => message.name === name) as { session: string }).session;
		expect(session("a")).not.toBe(session("b"));
		writeNative(host.child.stdin!, { type: "result", session: session("b"), id: 1, result: { content: [] } });
		await vi.waitFor(() => expect(b.lines).toEqual([{ type: "result", id: 1, result: { content: [] } }]));
		expect(a.lines).toEqual([]);
		a.socket.end();
		await vi.waitFor(() => expect(host.fromHost).toContainEqual({ type: "close", session: session("a") }));
	});

	it("refuses a call too large for Chrome without passing it on", async () => {
		const host = startHost();
		const a = await agent(host);
		writeLine(a.socket, { type: "call", id: 3, tool: "run_script", args: { code: "x".repeat(1_000_100) } });
		await vi.waitFor(() => expect(a.lines).toHaveLength(1));
		expect(JSON.stringify(a.lines[0])).toContain("too large");
		expect(host.fromHost).toEqual([]);
	});

	it("ends a socket that sends another message over 1 MB in bytes, and passes nothing on", async () => {
		const host = startHost();
		const a = await agent(host);
		const closed = new Promise((resolve) => a.socket.once("close", resolve));
		// 400,000 three-byte characters: under 1 MB as a string length, 1.2 MB in UTF-8.
		writeLine(a.socket, { type: "open", name: "中".repeat(400_000) });
		writeLine(a.socket, { type: "open", name: "after" });
		await closed;
		expect(host.fromHost).toEqual([]);
	});
});

describe("the socket", () => {
	it("is readable by the user alone, and goes when Chrome closes the port", async () => {
		const host = startHost();
		await agent(host);
		expect(statSync(join(host.home, ".pagewing")).mode & 0o777).toBe(0o700);
		expect(statSync(host.socketPath).mode & 0o777).toBe(0o600);
		const exited = new Promise((resolve) => host.child.once("exit", resolve));
		host.child.stdin!.end();
		expect(await exited).toBe(0);
		expect(existsSync(host.socketPath)).toBe(false);
	});
});
