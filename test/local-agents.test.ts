// Local agents apart from the bridge: open_tab's last checks before its navigation (design 6.45, 6.46).

import { afterEach, describe, expect, it, vi } from "vitest";
import { LocalAgents } from "../src/background/local-agents.ts";
import type { PageAccess } from "../src/background/page.ts";
import { ALL_ON, NO_AGENT, pageDeps } from "./fixtures/page-deps.ts";

afterEach(() => vi.unstubAllGlobals());

/** A connected session whose open_tab holds in the recording's setup until `release()`; `posted` gets its result. */
function holdingOpen() {
	const access: PageAccess = {
		...NO_AGENT,
		frames: async () => [],
		text: async () => null,
		current: async () => null,
		timeoutMs: 1_000,
	};
	const config = { current: structuredClone(ALL_ON) };
	const { deps } = pageDeps(access, config);
	let release = () => {};
	const held = new Promise<void>((resolve) => {
		release = resolve;
	});
	const arm = vi.spyOn(deps.recording, "arm").mockImplementation(() => held);
	vi.spyOn(deps.recording, "registerOrigin").mockResolvedValue();
	const update = vi.fn(async () => ({}));
	const posted: { result: { isError?: boolean; content: { text: string }[] } }[] = [];
	let received = (_message: unknown) => {};
	const tab = { id: 7, windowId: 1, groupId: 3 };
	vi.stubGlobal("chrome", {
		runtime: {
			connectNative: () => ({
				onMessage: { addListener: (listener: (message: unknown) => void) => (received = listener) },
				onDisconnect: { addListener: () => {} },
				postMessage: (message: (typeof posted)[number]) => posted.push(message),
				disconnect: () => {},
			}),
		},
		alarms: { clear: async () => true },
		tabs: { create: async () => tab, group: async () => 3, update, get: async () => tab, query: async () => [tab] },
		tabGroups: { update: async () => ({}) },
	});
	new LocalAgents(deps, () => {}).sync(true, true);
	received({ type: "ready" });
	received({ type: "open", session: "s", name: "agent" });
	received({ type: "call", session: "s", id: 1, tool: "open_tab", args: { url: "https://a.test/" } });
	return { arm, config, posted, received, release, update };
}

describe("open_tab's navigation (design 6.46)", () => {
	it("is not sent when Act turns Off while the recording is set up", async () => {
		const open = holdingOpen();
		await vi.waitFor(() => expect(open.arm).toHaveBeenCalled());
		open.config.current = { ...open.config.current, tools: { ...open.config.current.tools, act: "off" } };
		open.release();
		await vi.waitFor(() => expect(open.posted).toHaveLength(1));
		expect(open.posted[0]!.result.isError).toBe(true);
		expect(open.update).not.toHaveBeenCalled();
	});

	it("is not sent when the agent cancels the call while the recording is set up", async () => {
		const open = holdingOpen();
		await vi.waitFor(() => expect(open.arm).toHaveBeenCalled());
		open.received({ type: "cancel", session: "s", id: 1 });
		open.release();
		await vi.waitFor(() => expect(open.posted).toHaveLength(1));
		expect(open.posted[0]!.result.content[0]!.text).toMatch(/cancelled/);
		expect(open.update).not.toHaveBeenCalled();
	});

	it("is sent once the recording is set up", async () => {
		const open = holdingOpen();
		await vi.waitFor(() => expect(open.arm).toHaveBeenCalled());
		open.release();
		await vi.waitFor(() => expect(open.update).toHaveBeenCalledWith(7, { url: "https://a.test/" }));
	});
});
