// observe_page and act_on_page in frames (design 6.50), for the page tools and local agents: the labels of frame lines,
// the join that binds a frame's document to the `<iframe>` that shows it, a frame's outline under its line, and an
// action in a frame, checked through every ancestor.

import { BACKGROUND_CONTEXT, type Context } from "@earendil-works/chord/context";
import { cut } from "../shared/protocol.ts";
import {
	bounded,
	type FrameMeta,
	type PageAccess,
	PageRefused,
	type scopedPageAccess,
	type TopDocument,
} from "./page.ts";
import type {
	ActRequest,
	ActResult,
	AgentTarget,
	FrameRequest,
	ObserveRequest,
	ObserveResult,
	OwnerResult,
	Point,
} from "./page-agent.ts";
import type { RefMap, RefMaps } from "./page-tools.ts";
import { ScopeDenied } from "./tab-groups.ts";

/**
 * An expanded frame's binding: the parent's document, the frame line's ref in the parent's map (a WeakRef to the
 * `<iframe>`), and the frame's own document as the join found it.
 */
export type FrameBinding = {
	parent: string;
	owner: AgentTarget;
	frameId: number;
	documentId: string;
	path: number[];
	origin: string;
};

/**
 * A ref through its maps: the element, the document it is in, the frames above it, outermost first, and whether an
 * outline listed it as a frame line.
 */
export type Resolved = { target: AgentTarget; documentId: string; chain: FrameBinding[]; frameLine: boolean };

/** The Chrome access of one call, checked before each send. */
type Scope = ReturnType<typeof scopedPageAccess>;

/** What every frame step needs: the call's access, the tab, the call's context, and how long one step may take. */
export type FrameCall = { scope: Scope; tabId: number; context: Context; timeoutMs: number };

export const FRAMES_CHANGED = "The page's frames changed while pi looked; observe again.";
const DRAG_IN_FRAME = "drag does not work inside frames yet.";

const gone = (ref: string) => `${ref} is gone (the page changed): observe again`;

/** The element `ref` names, through the chat's maps, if the maps lead to it from top document `topDocumentId`. */
export function refIn(maps: RefMaps | undefined, ref: string, topDocumentId: string): Resolved | string {
	const parsed = /^([a-z]+)([1-9][0-9]*)$/.exec(ref.trim());
	if (parsed === null) return `"${ref}" is not a ref: pass one from observe_page, such as a12`;
	const [, letter, number] = parsed as unknown as [string, string, string];
	const map = maps?.maps.find((one) => one.letter === letter);
	if (map === undefined) return gone(ref);
	const chain: FrameBinding[] = [];
	// Up through each frame's parent map; a chain longer than the maps would be a loop.
	for (let at: RefMap | undefined = map; at !== undefined && chain.length <= (maps?.maps.length ?? 0); ) {
		const frame: FrameBinding | undefined = at.frame;
		if (frame === undefined) {
			if (at.documentId !== topDocumentId) break;
			const target = { letter, mapId: map.mapId, number: Number(number) };
			const frameLine = map.frames?.includes(target.number) ?? false;
			return { target, documentId: map.documentId, chain, frameLine };
		}
		chain.unshift(frame);
		at = maps?.maps.find((one) => one.mapId === frame.owner.mapId && one.documentId === frame.parent);
	}
	return gone(ref);
}

/** The chat's maps of document `documentId`, as the page agent takes them. */
export function knownIn(maps: RefMaps | undefined, documentId: string): { letter: string; mapId: string }[] {
	return (maps?.maps ?? [])
		.filter((map) => map.documentId === documentId)
		.map(({ letter, mapId }) => ({ letter, mapId }));
}

/** Errors that end the call: Stop, the mode, and the tab's scope. Others are Chrome's, about one document. */
function passOn(error: unknown, context: Context): boolean {
	return context.abortSignal?.aborted === true || error instanceof PageRefused || error instanceof ScopeDenied;
}

const samePath = (one: number[], other: number[]) => one.join() === other.join();

/** A frame step in document `documentId`. */
function step<R extends FrameRequest>(call: FrameCall, documentId: string, request: R) {
	const { scope, tabId, context, timeoutMs } = call;
	return scope.wait(() => scope.access.frame(tabId, documentId, request), context, timeoutMs);
}

/** The frames pi may script, with their origins and paths: the metadata pass. */
function frameMap(call: FrameCall): Promise<FrameMeta[]> {
	const { scope, tabId, context, timeoutMs } = call;
	return scope.wait(() => scope.access.frameMap(tabId), context, timeoutMs);
}

/** "frame": the binding the join found. "unreachable": Chrome does not let pi script the frame's document. */
export type Joined =
	| { kind: "frame"; binding: FrameBinding; line: string }
	| { kind: "unreachable"; line: string; hint: string | null }
	| { kind: "notFrame" }
	| { kind: "refused"; error: string };

/**
 * Binds the frame the `<iframe>` of ref `owner` shows to its document (design 6.50): the owner checked in the parent,
 * the metadata pass, the owner again; on a mismatch once more, then refused.
 */
export async function joinFrame(
	parent: { documentId: string; path: number[] },
	owner: AgentTarget,
	call: FrameCall,
): Promise<Joined> {
	const ref = `${owner.letter}${owner.number}`;
	const check = (index: number | null) =>
		step(call, parent.documentId, { op: "owner", target: owner, letter: owner.letter, index, point: null });
	for (let attempt = 0; attempt < 2; attempt += 1) {
		const first = await check(null);
		if (first === null) return { kind: "refused", error: gone(ref) };
		if (first.kind === "notFrame" || first.kind === "refused") return first;
		if (first.kind === "changed") continue;
		const metas = await frameMap(call);
		const again = await check(first.index);
		if (again === null) return { kind: "refused", error: gone(ref) };
		if (again.kind === "refused") return again;
		if (again.kind !== "frame") continue;
		// The parent itself must still be where its binding says.
		const self = metas.find((meta) => meta.documentId === parent.documentId);
		if (self === undefined || !samePath(self.path, parent.path)) continue;
		const path = [...parent.path, first.index];
		const meta = metas.find((one) => samePath(one.path, path));
		if (meta === undefined) return { kind: "unreachable", line: first.line, hint: first.hint };
		return {
			kind: "frame",
			line: first.line,
			binding: {
				parent: parent.documentId,
				owner,
				frameId: meta.frameId,
				documentId: meta.documentId,
				path,
				origin: meta.origin,
			},
		};
	}
	return { kind: "refused", error: FRAMES_CHANGED };
}

/**
 * Checks each `<iframe>` of `chain`, from the innermost one's parent up to the top (design 6.50): still the frame at
 * its index, shown, not zoomed or transformed; with `point`, in the frame's view, it maps the point up and checks that
 * each `<iframe>` gets it. The point in the top's view, or why not.
 */
export async function checkAncestors(
	chain: FrameBinding[],
	point: Point | null,
	call: FrameCall,
): Promise<{ point: Point | null } | string> {
	let at = point;
	for (const binding of [...chain].reverse()) {
		const ref = `${binding.owner.letter}${binding.owner.number}`;
		let checked: OwnerResult | null;
		try {
			checked = await step(call, binding.parent, {
				op: "owner",
				target: binding.owner,
				letter: binding.owner.letter,
				index: binding.path.at(-1) ?? null,
				point: at,
			});
		} catch (error) {
			if (passOn(error, call.context)) throw error;
			return `pi cannot check whether the frame ${ref} shows: observe again`;
		}
		if (checked === null) return gone(ref);
		if (checked.kind === "refused") return checked.error;
		if (checked.kind !== "frame") return FRAMES_CHANGED;
		at = checked.point;
	}
	return { point: at };
}

/** How the metadata labels a frame line. */
function labelOf(metas: FrameMeta[], path: number[]): string {
	const meta = metas.find((one) => samePath(one.path, path));
	if (meta === undefined) return "no access to this frame's site";
	return meta.origin === "null" ? "not on a site" : `origin=${cut(meta.origin, 200)}`;
}

/**
 * The outline with its frame lines labelled (design 6.50): each by the join, the outline's index, the metadata pass,
 * and each index again, once more for those that moved; a line whose join fails stays without a label.
 */
async function labelFrames(
	documentId: string,
	path: number[],
	result: Extract<ObserveResult, { ok: true }>,
	call: FrameCall,
): Promise<string> {
	if (result.frames.length === 0) return result.outline;
	const targets = result.frames.map(({ number }) => ({ letter: result.letter, mapId: result.mapId, number }));
	const labels: (string | null)[] = result.frames.map(() => null);
	let indexes: (number | null)[] = result.frames.map(({ index }) => index);
	try {
		for (let attempt = 0; attempt < 2; attempt += 1) {
			const metas = await frameMap(call);
			const now = await step(call, documentId, { op: "indexes", targets });
			if (now === null) break;
			const self = metas.find((meta) => meta.documentId === documentId);
			const placed = self !== undefined && samePath(self.path, path);
			let moved = false;
			indexes.forEach((index, i) => {
				if (labels[i] !== null) return;
				if (placed && index !== null && index === now.indexes[i]) labels[i] = labelOf(metas, [...path, index]);
				else moved = true;
			});
			if (!moved) break;
			indexes = now.indexes;
		}
	} catch (error) {
		if (passOn(error, call.context)) throw error;
	}
	const lines = result.outline.split("\n");
	result.frames.forEach(({ line }, i) => {
		if (labels[i] !== null) lines[line] += ` ${labels[i]}`;
	});
	return lines.join("\n");
}

/** What observe_page passes for each outline, the letter of a new map included. */
export type ObserveBase = Omit<ObserveRequest, "op" | "known" | "within" | "depth">;

/**
 * An outline to show, of document `documentId` with map `mapId`, and the binding to keep for that map if it is in a
 * frame; or a frame pi cannot script; or why not.
 */
export type Observed =
	| {
			kind: "outline";
			documentId: string;
			mapId: string;
			letter: string;
			url: string;
			title: string;
			outline: string;
			omitted: string | null;
			/** The refs of the outline's frame lines, which the map keeps. */
			frames: number[];
			binding: FrameBinding | null;
	  }
	| { kind: "unreachable"; ref: string; hint: string | null }
	| { kind: "refused"; error: string };

/**
 * observe_page's outline (design 6.23, 6.50): of the top document, of a part `within` names, or of the frame a frame
 * line's ref names, under that line.
 */
export async function observeAt(
	top: TopDocument,
	maps: RefMaps | undefined,
	within: string | undefined,
	base: ObserveBase,
	call: FrameCall,
): Promise<Observed> {
	const { scope, tabId, context, timeoutMs } = call;
	const observe = async (
		documentId: string,
		path: number[],
		extra: Pick<ObserveRequest, "within" | "depth" | "maxBytes">,
		binding: FrameBinding | null,
	): Promise<Observed> => {
		const known = knownIn(maps, documentId);
		const result = await scope.wait(
			() => scope.access.observe(tabId, documentId, { op: "observe", ...base, known, ...extra }),
			context,
			timeoutMs,
		);
		if (result === null) return { kind: "refused", error: "The page went away while pi observed it; observe again." };
		if (!result.ok) return { kind: "refused", error: result.error };
		const { mapId, letter, url, title, omitted } = result;
		const outline = await labelFrames(documentId, path, result, call);
		const frames = result.iframes;
		return { kind: "outline", documentId, mapId, letter, url, title, outline, omitted, frames, binding };
	};
	if (within === undefined)
		return observe(top.documentId, [], { within: null, depth: 0, maxBytes: base.maxBytes }, null);
	const resolved = refIn(maps, within, top.documentId);
	if (typeof resolved === "string") return { kind: "refused", error: resolved };
	const { chain } = resolved;
	if (chain.length > 0) {
		const checked = await checkAncestors(chain, null, call);
		if (typeof checked === "string") return { kind: "refused", error: checked };
	}
	const inner = chain.at(-1) ?? null;
	const path = inner?.path ?? [];
	const part = () =>
		observe(resolved.documentId, path, { within: resolved.target, depth: 0, maxBytes: base.maxBytes }, inner);
	if (!resolved.frameLine) return part();
	let joined: Joined;
	try {
		joined = await joinFrame({ documentId: resolved.documentId, path }, resolved.target, call);
	} catch (error) {
		// A frame's document Chrome no longer has: the frame navigated since its outline.
		if (passOn(error, context) || inner === null) throw error;
		return { kind: "refused", error: gone(within.trim()) };
	}
	if (joined.kind === "refused") return joined;
	if (joined.kind === "unreachable") return { kind: "unreachable", ref: within.trim(), hint: joined.hint };
	if (joined.kind === "notFrame") return part();
	const { binding, line } = joined;
	if (binding.origin === "null")
		return { kind: "refused", error: `The frame ${within.trim()} is not on a site: pi does not list what is in it.` };
	const head = `${line} origin=${cut(binding.origin, 200)}`;
	// Room for the frame line, escaped, and its newline.
	const maxBytes = base.maxBytes - new TextEncoder().encode(JSON.stringify(head)).length - 16;
	const child = await observe(binding.documentId, binding.path, { within: null, depth: 1, maxBytes }, binding);
	return child.kind === "outline" ? { ...child, outline: `${head}\n${child.outline}` } : child;
}

/** Why pi cannot reach the frame of `ref`, for a call that shows no site card. */
export const noFrameAccess = (ref: string) =>
	`The frame ${ref} is on a site pi has no access to (no access to this frame's site).`;

/**
 * Where an action goes (design 6.50): the top document, as before; or a frame's document, for a ref in an expanded
 * frame or a frame line's ref with a scroll direction, with the frames above it, outermost first.
 */
export type Acting =
	| { kind: "top"; target: AgentTarget | null; to: AgentTarget | null }
	| { kind: "frame"; documentId: string; origin: string; chain: FrameBinding[]; target: AgentTarget | null }
	| { kind: "refused"; error: string };

/** Where the action with these arguments goes, before anything is sent. */
export async function actingOf(
	top: TopDocument,
	maps: RefMaps | undefined,
	args: { action: string; ref?: string; to?: string; direction?: string },
	call: FrameCall,
): Promise<Acting> {
	const resolve = (ref: string | undefined) => (ref === undefined ? null : refIn(maps, ref, top.documentId));
	const target = resolve(args.ref);
	if (typeof target === "string") return { kind: "refused", error: target };
	const to = resolve(args.to);
	if (typeof to === "string") return { kind: "refused", error: to };
	if (args.action === "drag" && ((target?.chain.length ?? 0) > 0 || (to?.chain.length ?? 0) > 0))
		return { kind: "refused", error: DRAG_IN_FRAME };
	if (target?.frameLine === true && args.action === "scroll" && args.direction !== undefined) {
		// A frame line's ref with a direction scrolls the frame's own page, joined without expanding it.
		const inner = target.chain.at(-1);
		const joined = await joinFrame({ documentId: target.documentId, path: inner?.path ?? [] }, target.target, call);
		if (joined.kind === "refused") return joined;
		if (joined.kind === "unreachable") return { kind: "refused", error: noFrameAccess(args.ref!.trim()) };
		if (joined.kind === "frame") {
			const { binding } = joined;
			if (binding.origin === "null")
				return { kind: "refused", error: `The frame ${args.ref!.trim()} is not on a site: pi does not act in it.` };
			const chain = [...target.chain, binding];
			return { kind: "frame", documentId: binding.documentId, origin: binding.origin, chain, target: null };
		}
	}
	const inner = target?.chain.at(-1);
	if (target !== null && inner !== undefined)
		return {
			kind: "frame",
			documentId: target.documentId,
			origin: inner.origin,
			chain: target.chain,
			target: target.target,
		};
	return { kind: "top", target: target?.target ?? null, to: to?.target ?? null };
}

/** How long the input watchers stay in a page pi cannot reach any more to remove them. */
const WATCH_MS = 30_000;

/** The refusal of an action whose frame did not answer: `where` says what the frame shows now, if pi can tell. */
function lostText(action: string, where: string): string {
	const now = where === "" ? "" : ` ${where[0]!.toUpperCase()}${where.slice(1)}.`;
	return `No answer came from the frame after the ${action} (its page may have unloaded): the ${action} may or may not have happened.${now} Observe and check before going on.`;
}

/**
 * Acts in a frame (design 6.50): the input watchers in the top, the documents between, and the frame, then
 * `startNoting` (opened tabs are noted from here until the stop it returns), the act's checks up to its point in the
 * frame, each ancestor with that point mapped up, the events without scrolling, and the wait for quiet in the frame,
 * then in the top, within one budget. At the end, also after a refusal or Stop, the noting stops, then the watchers
 * go. `lost`: no answer came from the frame; the refusal to give.
 */
export async function actInFrame(
	top: TopDocument,
	acting: Extract<Acting, { kind: "frame" }>,
	request: ActRequest,
	raw: PageAccess,
	startNoting: () => () => void,
	call: FrameCall,
): Promise<ActResult | { lost: string }> {
	const { scope, tabId, context, timeoutMs } = call;
	const binding = acting.chain.at(-1)!;
	const refused = (error: string): ActResult => ({ ok: false, error, sent: false, userInput: false });
	// The action's own watches, apart from another call's in the same documents.
	const id = crypto.randomUUID();
	const watched: string[] = [];
	let stopNoting = () => {};
	/** What the frame shows now, for an action whose frame did not answer. */
	const whereNow = async () => {
		const metas = await frameMap(call).catch((error: unknown) => {
			if (passOn(error, context)) throw error;
			return [];
		});
		const meta = metas.find((one) => one.frameId === binding.frameId);
		const where =
			meta === undefined
				? "pi does not find the frame now"
				: meta.documentId === binding.documentId
					? ""
					: "the frame shows another page now";
		return lostText(request.action, where);
	};
	const steps = async (): Promise<ActResult | { lost: string }> => {
		let at: Point;
		try {
			// The top and every document between it and the target: a click there may take no focus from the target,
			// which then never blurs when the target itself had none (a click on an element that takes no focus).
			for (const { parent, owner } of acting.chain) {
				await step(call, parent, { op: "watch", id, kind: "ancestor", exempt: owner, ms: WATCH_MS });
				watched.push(parent);
			}
			await step(call, acting.documentId, { op: "watch", id, kind: "target", exempt: null, ms: WATCH_MS });
			watched.push(acting.documentId);
			stopNoting = startNoting();
			const { op: _, frame: __, ...rest } = request;
			const aimed = await step(call, acting.documentId, { ...rest, op: "aim" });
			if (aimed === null) return refused("The frame's page went away: observe again");
			if (!aimed.ok) return aimed;
			if (!samePath(aimed.path, binding.path)) return refused(FRAMES_CHANGED);
			const checked = await checkAncestors(acting.chain, aimed.point, call);
			if (typeof checked === "string") return refused(checked);
			at = aimed.point;
		} catch (error) {
			if (passOn(error, context)) throw error;
			return refused(`pi cannot reach the frame's page: ${error instanceof Error ? error.message : String(error)}`);
		}
		const started = Date.now();
		const result = await scope.wait(
			() => scope.access.act(tabId, acting.documentId, { ...request, frame: { at, path: binding.path } }),
			context,
			timeoutMs,
		);
		if (result === null) return { lost: await whereNow() };
		if (!result.ok) return result;
		// One wait budget for the frame and the top.
		const left = request.maxWaitMs - (Date.now() - started);
		if (left < request.quietMs) return { ...result, timedOut: true };
		try {
			const settled = await step(call, top.documentId, { op: "settle", quietMs: request.quietMs, maxWaitMs: left });
			return { ...result, timedOut: result.timedOut || settled === null || settled.timedOut };
		} catch (error) {
			if (passOn(error, context)) throw error;
			return { ...result, timedOut: true };
		}
	};
	let outcome: ActResult | { lost: string };
	let userInput = false;
	try {
		outcome = await steps();
	} finally {
		// A tab collected after a watcher went would be taken as pi's without the user's input checked: the noting
		// stops first.
		stopNoting();
		// Only pi's own listeners go, so Stop does not keep them in the page: Chrome access without the call's checks.
		const ended = await Promise.all(
			watched.map((documentId) =>
				bounded(() => raw.frame(tabId, documentId, { op: "unwatch", id }), BACKGROUND_CONTEXT, timeoutMs).then(
					(answer) => answer?.userInput ?? true,
					() => true,
				),
			),
		);
		userInput = ended.some(Boolean);
	}
	return "lost" in outcome ? outcome : { ...outcome, userInput: outcome.userInput || userInput };
}
