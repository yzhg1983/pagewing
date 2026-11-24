// The frame steps of observe_page and act_on_page (design 6.50) against a fake tab with nested frames: labels, the
// join, the checks through every ancestor, and an action's watchers, budget, and Stop.

import { BACKGROUND_CONTEXT, withAbortSignal } from "@earendil-works/chord/context";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	actInFrame,
	actingOf,
	checkAncestors,
	FRAMES_CHANGED,
	type FrameBinding,
	type FrameCall,
	observeAt,
	refIn,
} from "../src/background/frames.ts";
import { ACT_ON_PAGE, type FrameMeta, type PageAccess, scopedPageAccess } from "../src/background/page.ts";
import type { ActRequest, FrameRequest, OwnerRequest } from "../src/background/page-agent.ts";
import type { RefMaps } from "../src/background/page-tools.ts";
import { ALL_ON, NO_AGENT, pageDeps } from "./fixtures/page-deps.ts";

afterEach(() => vi.restoreAllMocks());

const TOP = { documentId: "top", url: "https://a.test/", origin: "https://a.test", title: "Top" };

/** The top's `<iframe>` a3 at index 0 shows "mid" on b.test; mid's `<iframe>` b2 at index 1 shows "inner" on c.test. */
const MID: FrameBinding = {
	parent: "top",
	owner: { letter: "a", mapId: "top-map", number: 3 },
	frameId: 5,
	documentId: "mid",
	path: [0],
	origin: "https://b.test",
};
const INNER: FrameBinding = {
	parent: "mid",
	owner: { letter: "b", mapId: "mid-map", number: 2 },
	frameId: 6,
	documentId: "inner",
	path: [0, 1],
	origin: "https://c.test",
};
const MAPS: RefMaps = {
	next: 3,
	maps: [
		{ letter: "a", documentId: "top", mapId: "top-map", frames: [3] },
		{ letter: "b", documentId: "mid", mapId: "mid-map", frame: MID, frames: [2] },
		{ letter: "c", documentId: "inner", mapId: "inner-map", frame: INNER },
	],
};

/**
 * The fake tab. `index` gives each owner check's index of an `<iframe>` by its document (0 or 1 as above by default);
 * `owner` replaces the answer of one; `metas` the metadata pass.
 */
function tab(controller = new AbortController()) {
	const world = {
		metas: [
			{ frameId: 0, documentId: "top", origin: "https://a.test", path: [] },
			{ frameId: 5, documentId: "mid", origin: "https://b.test", path: [0] },
			{ frameId: 6, documentId: "inner", origin: "https://c.test", path: [0, 1] },
		] as FrameMeta[],
		indexes: { top: [] as number[], mid: [] as number[] },
		owner: undefined as ((documentId: string, request: OwnerRequest) => unknown) | undefined,
		/** How long the events take, by the clock the budget reads. */
		actMs: 0,
		onAim: () => {},
		steps: [] as string[],
		/** Each watch: its document, kind, and the frame it exempts. */
		watches: [] as string[],
		/** The budget each wait for quiet in the top got. */
		settles: [] as number[],
	};
	const indexOf = (documentId: string) =>
		documentId === "top" ? (world.indexes.top.shift() ?? 0) : (world.indexes.mid.shift() ?? 1);
	let now = 1_000;
	vi.spyOn(Date, "now").mockImplementation(() => now);
	const answer = (documentId: string, request: FrameRequest): unknown => {
		switch (request.op) {
			case "owner": {
				const replaced = world.owner?.(documentId, request);
				if (replaced !== undefined) return replaced;
				const index = indexOf(documentId);
				if (request.index !== null && request.index !== index) return { kind: "changed" };
				const point = request.point === null ? null : { x: request.point.x + 10, y: request.point.y + 20 };
				return { kind: "frame", index, line: `- frame "F" ${request.letter}3 300×200`, hint: null, point };
			}
			case "indexes":
				return { indexes: request.targets.map(() => indexOf(documentId)) };
			case "watch":
				world.watches.push(
					`${documentId} ${request.kind}${request.exempt === null ? "" : ` ${request.exempt.letter}${request.exempt.number}`}`,
				);
				return { ok: true };
			case "unwatch":
				return { userInput: false };
			case "settle":
				world.settles.push(request.maxWaitMs);
				return { timedOut: false };
			case "aim":
				world.onAim();
				return { ok: true, point: { x: 1, y: 2 }, path: [0, 1] };
		}
	};
	const access: PageAccess = {
		...NO_AGENT,
		frames: async () => [],
		text: async () => null,
		current: async () => null,
		frameMap: async () => world.metas,
		async frame(_tabId, documentId, request) {
			world.steps.push(`${documentId} ${request.op}`);
			// The fake answers as the page agent does: its result type follows the request's op.
			return answer(documentId, request) as never;
		},
		async observe(_tabId, documentId, request) {
			world.steps.push(`${documentId} observe`);
			const letter = request.letter;
			const frames = documentId === "mid" ? [{ line: 1, number: 2, index: 1 }] : [];
			const outline = `- button "Go" ${letter}1${frames.length > 0 ? `\n- frame "F" ${letter}2 300×200` : ""}`;
			const iframes = frames.map(({ number }) => number);
			return {
				ok: true,
				mapId: `${documentId}-new`,
				letter,
				url: "",
				title: "",
				outline,
				omitted: null,
				frames,
				iframes,
			};
		},
		async act(_tabId, documentId) {
			world.steps.push(`${documentId} act`);
			now += world.actMs;
			return {
				ok: true,
				step: { kind: "click", target: "c1" },
				url: "",
				title: "",
				timedOut: false,
				userInput: false,
			};
		},
		timeoutMs: 1_000,
	};
	const { deps } = pageDeps(access, { current: structuredClone(ALL_ON) });
	deps.groups.scope = async () => [{ id: 1, groupId: 3, windowId: 1 }];
	const context = withAbortSignal(controller.signal, BACKGROUND_CONTEXT);
	const scope = scopedPageAccess(deps, 1, 1, ACT_ON_PAGE, context);
	const call: FrameCall = { scope, tabId: 1, context, timeoutMs: 1_000 };
	return { world, access, call };
}

const BASE = {
	letter: "d",
	find: null,
	maxBytes: 10_000,
	budgetMs: 100,
	maxElements: 100,
	maxMatches: 50,
	maxUrl: 200,
};

const CLICK: ActRequest = {
	op: "act",
	action: "click",
	target: { letter: "c", mapId: "inner-map", number: 1 },
	known: [],
	text: null,
	submit: false,
	key: null,
	option: null,
	direction: null,
	to: null,
	by: null,
	summary: null,
	dragMoves: 10,
	dragMs: 2_000,
	quietMs: 500,
	maxWaitMs: 5_000,
	outlineMs: 100,
	maxUrl: 200,
	frame: null,
};

describe("refIn", () => {
	it("leads a ref through its frames' maps to the top, outermost frame first", () => {
		expect(refIn(MAPS, "c1", "top")).toEqual({
			target: { letter: "c", mapId: "inner-map", number: 1 },
			documentId: "inner",
			chain: [MID, INNER],
			frameLine: false,
		});
		// The tab shows another top document: the frames' maps lead nowhere.
		expect(refIn(MAPS, "c1", "other")).toBe("c1 is gone (the page changed): observe again");
	});

	it("ends at a loop of maps", () => {
		const loop: RefMaps = {
			next: 2,
			maps: [
				{
					letter: "b",
					documentId: "mid",
					mapId: "mid-map",
					frame: { ...MID, owner: { ...MID.owner, mapId: "mid-map" }, parent: "mid" },
				},
			],
		};
		expect(refIn(loop, "b1", "top")).toBe("b1 is gone (the page changed): observe again");
	});
});

describe("labels", () => {
	const maps: RefMaps = { next: 2, maps: [MAPS.maps[0]!, MAPS.maps[1]!] };
	const lastLine = (observed: Awaited<ReturnType<typeof observeAt>>) =>
		observed.kind === "outline" ? observed.outline.split("\n").at(-1) : observed;

	it("labels a frame line by the metadata at the index the outline gave", async () => {
		const { call } = tab();
		const observed = await observeAt(TOP, maps, "a3", BASE, call);
		expect(observed.kind === "outline" && observed.outline.split("\n")).toEqual([
			'- frame "F" a3 300×200 origin=https://b.test',
			'- button "Go" d1',
			'- frame "F" d2 300×200 origin=https://c.test',
		]);
	});

	it("labels by the new index after one move, and leaves a line that moves twice without a label", async () => {
		const { world, call } = tab();
		// Mid's `<iframe>` moved from 1 to 0 before the first check: no frame pi may script is at [0, 0].
		world.indexes.mid.push(0, 0);
		expect(lastLine(await observeAt(TOP, maps, "a3", BASE, call))).toBe(
			`- frame "F" d2 300×200 no access to this frame's site`,
		);
		world.indexes.mid.push(0, 2);
		expect(lastLine(await observeAt(TOP, maps, "a3", BASE, call))).toBe('- frame "F" d2 300×200');
	});
});

describe("join", () => {
	it("binds a nested frame through its parent's binding, and refuses when the parent moved", async () => {
		const { world, call } = tab();
		const maps: RefMaps = { next: 2, maps: [MAPS.maps[0]!, MAPS.maps[1]!] };
		const observed = await observeAt(TOP, maps, "b2", BASE, call);
		expect(observed).toMatchObject({ kind: "outline", documentId: "inner", binding: INNER });
		// Mid now sits at another index path: its own binding is stale.
		world.metas = world.metas.map((meta) => (meta.documentId === "mid" ? { ...meta, path: [1] } : meta));
		expect(await observeAt(TOP, maps, "b2", BASE, call)).toEqual({ kind: "refused", error: FRAMES_CHANGED });
	});

	it("passes on the owner's geometry and shown refusals", async () => {
		const { world, call } = tab();
		const error = "pi cannot map points into the frame a3: it is zoomed or transformed";
		world.owner = () => ({ kind: "refused", error });
		expect(await observeAt(TOP, MAPS, "a3", BASE, call)).toEqual({ kind: "refused", error });
		// Within a ref inside a frame: the ancestor's check refuses first.
		expect(await observeAt(TOP, MAPS, "c1", BASE, call)).toEqual({ kind: "refused", error });
	});

	it("refuses drag in a frame before any step", async () => {
		const { world, call } = tab();
		expect(await actingOf(TOP, MAPS, { action: "drag", ref: "a1", to: "c1" }, call)).toEqual({
			kind: "refused",
			error: "drag does not work inside frames yet.",
		});
		expect(world.steps).toEqual([]);
	});
});

describe("frame lines only", () => {
	it("within a ref no outline listed as a frame lists it without a frame step", async () => {
		const { world, call } = tab();
		expect(await observeAt(TOP, MAPS, "a1", BASE, call)).toMatchObject({ kind: "outline", documentId: "top" });
		expect(world.steps).toEqual(["top observe"]);
		// A scroll with a direction on such a ref stays in its document, also without a frame step.
		expect(await actingOf(TOP, MAPS, { action: "scroll", ref: "a1", direction: "down" }, call)).toMatchObject({
			kind: "top",
		});
		expect(world.steps).toEqual(["top observe"]);
	});

	it("a frame that navigated: within a ref in it is gone", async () => {
		const { access, call } = tab();
		const frame = access.frame;
		access.frame = async (tabId, documentId, request) => {
			if (documentId === "mid") throw new Error("No document with id mid.");
			return frame(tabId, documentId, request);
		};
		expect(await observeAt(TOP, MAPS, "b2", BASE, call)).toEqual({
			kind: "refused",
			error: "b2 is gone (the page changed): observe again",
		});
	});

	it("a frame not on a site: labelled so, not listed, and no action in it", async () => {
		const { world, call } = tab();
		world.metas = world.metas.map((meta) => (meta.documentId === "inner" ? { ...meta, origin: "null" } : meta));
		const maps: RefMaps = { next: 2, maps: [MAPS.maps[0]!, MAPS.maps[1]!] };
		const mid = await observeAt(TOP, maps, "a3", BASE, call);
		expect(mid.kind === "outline" && mid.outline.split("\n").at(-1)).toBe('- frame "F" d2 300×200 not on a site');
		expect(await observeAt(TOP, maps, "b2", BASE, call)).toEqual({
			kind: "refused",
			error: "The frame b2 is not on a site: pi does not list what is in it.",
		});
		expect(await actingOf(TOP, maps, { action: "scroll", ref: "b2", direction: "down" }, call)).toEqual({
			kind: "refused",
			error: "The frame b2 is not on a site: pi does not act in it.",
		});
	});
});

describe("checkAncestors", () => {
	it("checks from the innermost frame's parent up, mapping the point through each `<iframe>`", async () => {
		const { world, call } = tab();
		expect(await checkAncestors([MID, INNER], { x: 1, y: 2 }, call)).toEqual({ point: { x: 21, y: 42 } });
		expect(world.steps).toEqual(["mid owner", "top owner"]);
	});

	it("refuses when a nested `<iframe>` moved since the frame was expanded", async () => {
		const { world, call } = tab();
		world.indexes.mid.push(0);
		expect(await checkAncestors([MID, INNER], { x: 1, y: 2 }, call)).toBe(FRAMES_CHANGED);
	});

	it("refuses an ancestor pi cannot reach any more", async () => {
		const { access, call } = tab();
		access.frame = async () => {
			throw new Error("Cannot access contents of the page.");
		};
		expect(await checkAncestors([MID, INNER], null, call)).toBe(
			"pi cannot check whether the frame b2 shows: observe again",
		);
	});
});

describe("actInFrame", () => {
	const acting = {
		kind: "frame" as const,
		documentId: "inner",
		origin: "https://c.test",
		chain: [MID, INNER],
		target: CLICK.target,
	};

	it("gives the top the time the frame's events left of one budget", async () => {
		const { world, access, call } = tab();
		world.actMs = 1_000;
		expect(await actInFrame(TOP, acting, CLICK, access, () => () => {}, call)).toMatchObject({
			ok: true,
			timedOut: false,
		});
		expect(world.settles).toEqual([4_000]);
		// The events took all but less than a quiet period: no wait in the top, timed out.
		world.actMs = 4_600;
		expect(await actInFrame(TOP, acting, CLICK, access, () => () => {}, call)).toMatchObject({
			ok: true,
			timedOut: true,
		});
		expect(world.settles).toEqual([4_000]);
	});

	it("notes tabs once the watchers are in, the middle document's too, and stops before removing them after Stop", async () => {
		const controller = new AbortController();
		const { world, access, call } = tab(controller);
		const noting: string[] = [];
		const startNoting = () => {
			noting.push(`start after ${world.steps.join()}`);
			return () => noting.push(`stop after ${world.steps.at(-1)}`);
		};
		world.onAim = () => controller.abort();
		await expect(actInFrame(TOP, acting, CLICK, access, startNoting, call)).rejects.toMatchObject({
			name: "AbortError",
		});
		// A tab noted while a slow removal is still going would be taken without the user's input checked.
		expect(noting).toEqual(["start after top watch,mid watch,inner watch", "stop after inner aim"]);
		// Each ancestor exempts the frame pi acts through: its own child on the path.
		expect(world.watches).toEqual(["top ancestor a3", "mid ancestor b2", "inner target"]);
		expect(world.steps.slice(-3).sort()).toEqual(["inner unwatch", "mid unwatch", "top unwatch"]);
		expect(world.steps).not.toContain("inner act");
	});
});
