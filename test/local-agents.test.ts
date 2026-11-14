// Local agents apart from the bridge: open_tab's last checks before its navigation (design 6.45, 6.46), and
// screenshot_page's check of the page's visibility (6.48).

import { afterEach, describe, expect, it, vi } from "vitest";
import { LocalAgents } from "../src/background/local-agents.ts";
import type { PageAccess } from "../src/background/page.ts";
import { ALL_ON, NO_AGENT, pageDeps } from "./fixtures/page-deps.ts";

afterEach(() => vi.unstubAllGlobals());

/**
 * A connected session whose open_tab holds in the recording's setup until `release()`; `posted` gets the results.
 * `access` replaces parts of the page access.
 */
function holdingOpen(access: Partial<PageAccess> = {}) {
	const page: PageAccess = {
		...NO_AGENT,
		frames: async () => [],
		text: async () => null,
		current: async () => null,
		timeoutMs: 1_000,
		...access,
	};
	const config = { current: structuredClone(ALL_ON) };
	const { deps } = pageDeps(page, config);
	let release = () => {};
	const held = new Promise<void>((resolve) => {
		release = resolve;
	});
	const arm = vi.spyOn(deps.recording, "arm").mockImplementation(() => held);
	vi.spyOn(deps.recording, "registerOrigin").mockResolvedValue();
	const update = vi.fn(async () => ({}));
	const group = vi.fn(async () => 3);
	const posted: { result: { isError?: boolean; content: { text: string }[] } }[] = [];
	let received = (_message: unknown) => {};
	const tab = { id: 7, windowId: 1, groupId: 3, active: true };
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
		tabs: { create: async () => tab, group, update, get: async () => tab, query: async () => [tab] },
		tabGroups: { update: async () => ({}) },
	});
	new LocalAgents(deps, () => {}).sync(true, true);
	received({ type: "ready" });
	received({ type: "open", session: "s", name: "agent" });
	received({ type: "call", session: "s", id: 1, tool: "open_tab", args: { url: "https://a.test/" } });
	return { arm, config, group, posted, received, release, update };
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

	it("puts the session's first tab in a new group in the tab's own window", async () => {
		const open = holdingOpen();
		await vi.waitFor(() => expect(open.group).toHaveBeenCalled());
		// Chrome's default window for a new group is the focused one, which would move the tab there.
		expect(open.group).toHaveBeenCalledWith({ tabIds: [7], createProperties: { windowId: 1 } });
	});
});

const HIDDEN =
	"No screenshot returned: Chrome reports this page as hidden, so the image may be out of date. Bring its tab and window into view, then try again.";

/** screenshot_page's result on the session's tab, in front of window 1, with `access` replacing parts of the page access. */
async function screenshot(access: Partial<PageAccess>) {
	const open = holdingOpen({ tabState: async () => ({ windowId: 1, active: true, minimized: false }), ...access });
	open.release();
	await vi.waitFor(() => expect(open.posted).toHaveLength(1));
	open.received({ type: "call", session: "s", id: 2, tool: "screenshot_page", args: {} });
	await vi.waitFor(() => expect(open.posted).toHaveLength(2));
	return open.posted[1]!.result;
}

describe("screenshot_page and the page's visibility (design 6.48)", () => {
	it("refuses a hidden page, in a minimized window too, without capturing", async () => {
		const capture = vi.fn(async () => "data:image/png;base64,AAAA");
		const result = await screenshot({
			tabState: async () => ({ windowId: 1, active: true, minimized: true }),
			shown: async () => ({ documentId: "top", hidden: true, changes: 1 }),
			capture,
		});
		expect(result).toMatchObject({ isError: true, content: [{ text: HIDDEN }] });
		expect(capture).not.toHaveBeenCalled();
	});

	it("refuses a page whose visibility it cannot read, with its own reason", async () => {
		const result = await screenshot({ shown: async () => null });
		expect(result.content[0]!.text).toBe(
			"No screenshot returned: Pagewing could not check that the page is shown, so the image may be out of date.",
		);
	});

	it("drops the image when the page is hidden after the capture, or was hidden and shown during it", async () => {
		for (const [after, text] of [
			[{ hidden: true, changes: 1 }, HIDDEN],
			[
				{ hidden: false, changes: 2 },
				"No screenshot returned: the page was hidden during the capture, so the image may be out of date; try again.",
			],
		] as const) {
			let state = { documentId: "top", hidden: false, changes: 0 };
			const result = await screenshot({
				shown: async () => state,
				capture: async () => {
					state = { ...state, ...after };
					return "data:image/png;base64,AAAA";
				},
			});
			expect(result).toMatchObject({ isError: true, content: [{ text }] });
		}
	});

	it("drops the image when a new page loaded during the capture, though both pages were shown with no change", async () => {
		let state = { documentId: "first", hidden: false, changes: 0 };
		const result = await screenshot({
			shown: async () => state,
			capture: async () => {
				state = { documentId: "second", hidden: false, changes: 0 };
				return "data:image/png;base64,AAAA";
			},
		});
		expect(result).toMatchObject({
			isError: true,
			content: [{ text: "No screenshot returned: a new page loaded during the capture; try again." }],
		});
	});

	it("returns the image of a page shown before and after the capture", async () => {
		const result = await screenshot({
			shown: async () => ({ documentId: "top", hidden: false, changes: 3 }),
			capture: async () => "data:image/png;base64,AAAA",
			encode: async () => ({ data: "JPEG", width: 10, height: 10 }),
		});
		expect(result.isError).toBeUndefined();
		expect(result.content[0]).toMatchObject({ type: "image", data: "JPEG" });
	});
});
