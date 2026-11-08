// Local agents (design 6.45): programs on this computer, such as a pi coding-agent session, use the page tools through
// Chrome's native messaging and the pagewing-mcp bridge. Each session works in a Chrome tab group of its own and reaches
// only the tabs in it. Turning on the Local agents switch is the user's consent, so the tools do not ask (Ask counts as
// On); Off, the page agent's refusals, and the switch going off are checked at every dispatch to Chrome.

import { BACKGROUND_CONTEXT, type Context, withCancel } from "@earendil-works/chord/context";
import { ENCODINGS, MAX_IMAGE_CHARS } from "../shared/images.ts";
import { type AgentsStatus, cut, MAX_URL_CHARS, pageTitle, type ToolModes } from "../shared/protocol.ts";
import {
	ACT_ON_PAGE,
	bounded,
	envelope,
	MAX_RESULT_BYTES,
	OBSERVE_PAGE,
	offText,
	PAGE_TIMEOUT_MS,
	type PageDeps,
	PageRefused,
	PageTimeout,
	READ_PAGE,
	RUN_SCRIPT,
	readTab,
	SCREENSHOT_PAGE,
	type Snapshot,
	scopedPageAccess,
	type TopDocument,
} from "./page.ts";
import { type ActAction, type ActRequest, type AgentTarget, stepText } from "./page-agent.ts";
import { letterOf, type RefMaps, targetOf } from "./page-tools.ts";
import { CAPTURE_GAP_MS, RETRY_GAP_MS } from "./screenshot.ts";
import { ScopeDenied, type ScopeTab } from "./tab-groups.ts";

/** The bridge's native host; pagewing-mcp install registers it under this name. */
export const HOST_NAME = "io.github.yzhg1983.pagewing";

/** What the page tools need from the worker, without a chat. */
export type AgentDeps = Pick<PageDeps, "access" | "currentSettings" | "captures">;

/** A call result as MCP's tools/call returns it. */
type ToolResult = {
	content: ({ type: "text"; text: string } | { type: "image"; data: string; mimeType: string })[];
	isError?: boolean;
};

/** What the bridge sends: that it listens, a session's start and end, its calls, and a call's cancel. */
type HostMessage =
	| { type: "ready" }
	| { type: "open"; session: string; name: string }
	| { type: "call"; session: string; id: number; tool: string; args: Record<string, unknown> }
	| { type: "cancel"; session: string; id: number }
	| { type: "close"; session: string };

/** A session: its agent's name, its tab group once it opened a tab, the tab it used last, and its refs and reads. */
type Session = {
	id: string;
	name: string;
	groupId: number | null;
	tab: number | null;
	maps: RefMaps;
	reads: Map<number, Snapshot>;
	calls: Map<number, (reason: string) => void>;
	/** The session's open_tab calls, one after another. */
	opening: Promise<unknown>;
};

type Args = Record<string, unknown>;

/** The alarm that starts the bridge again after it stopped while the switch is on: a timer dies with an idle worker. */
export const RETRY_ALARM = "local-agents-retry";
/** How long open_tab and an action wait for a page to load. */
const LOAD_MS = 10_000;
/** How long run_script waits for a script. */
const SCRIPT_MS = 30_000;
const MAX_MAPS = 50;

const text = (value: string, isError = false): ToolResult => ({
	content: [{ type: "text", text: value }],
	...(isError ? { isError } : {}),
});
const json = (value: unknown) => text(JSON.stringify(value));
const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error)).replace(/\.$/, "");
const LEFT_GROUP = "The tab left this session's tab group during the call; it may have happened in part.";
const NO_ACCESS = `Cannot reach the page: Chrome does not let Pagewing script it (a browser page, the Web Store, or a \
page still loading).`;

/** The bridge connection and its sessions. */
export class LocalAgents {
	readonly #deps: AgentDeps;
	readonly #changed: () => void;
	readonly #sessions = new Map<string, Session>();
	#port: chrome.runtime.Port | null = null;
	/** The host listens on its socket: agents can connect. */
	#ready = false;
	#on = false;
	/** The switch is on, but Chrome no longer grants native messaging, as after a removal in chrome://extensions. */
	#ungranted = false;
	#error: string | null = null;
	/** The host stopped before it listened: not registered, or registered for a CLI that is gone. */
	#missing = false;
	#reads = 0;

	/** `changed` is called when the status changes. */
	constructor(deps: AgentDeps, changed: () => void) {
		this.#deps = deps;
		this.#changed = changed;
	}

	status(): AgentsStatus {
		return {
			state: this.#ungranted
				? "permission"
				: !this.#on
					? "off"
					: this.#port !== null
						? this.#ready
							? "connected"
							: "starting"
						: this.#missing
							? "missing"
							: "error",
			error: this.#on ? this.#error : null,
			agents: [...this.#sessions.values()].map((session) => session.name),
		};
	}

	/**
	 * Starts the bridge while the switch is on and Chrome grants native messaging; otherwise ends every session and the
	 * bridge.
	 */
	sync(switchOn: boolean, granted: boolean): void {
		const on = switchOn && granted;
		this.#ungranted = switchOn && !granted;
		this.#on = on;
		void chrome.alarms.clear(RETRY_ALARM);
		if (on) {
			if (this.#port === null) this.#connect();
			return;
		}
		const port = this.#port;
		this.#port = null;
		this.#endAll("Local agents were turned off in Pagewing.");
		port?.disconnect();
		this.#error = null;
		this.#changed();
	}

	#connect(): void {
		let port: chrome.runtime.Port;
		try {
			port = chrome.runtime.connectNative(HOST_NAME);
		} catch (error) {
			this.#error = messageOf(error);
			this.#changed();
			return;
		}
		this.#port = port;
		this.#ready = false;
		this.#error = null;
		port.onMessage.addListener((message) => this.#received(message as HostMessage));
		port.onDisconnect.addListener(() => {
			const why = chrome.runtime.lastError?.message || "The bridge stopped";
			if (this.#port !== port) return;
			this.#port = null;
			this.#missing = !this.#ready;
			this.#endAll(why);
			this.#error = why;
			this.#changed();
			// Also when the host is not registered yet: the MCP server registers it at its start, and its first call waits
			// for this retry.
			if (this.#on) void chrome.alarms.create(RETRY_ALARM, { delayInMinutes: 0.5 });
		});
		this.#changed();
	}

	/** A message of the bridge: wire input, checked where it is used. */
	#received(message: HostMessage): void {
		const session = message.type === "ready" ? undefined : this.#sessions.get(message.session);
		switch (message.type) {
			case "ready":
				this.#ready = true;
				this.#changed();
				return;
			case "open":
				this.#sessions.set(message.session, {
					id: message.session,
					name: String(message.name).slice(0, 40) || "agent",
					groupId: null,
					tab: null,
					maps: { next: 0, maps: [] },
					reads: new Map(),
					calls: new Map(),
					opening: Promise.resolve(),
				});
				this.#changed();
				return;
			case "close":
				if (session !== undefined) this.#end(session, "The agent closed the session.");
				return;
			case "cancel":
				session?.calls.get(message.id)?.("The agent cancelled the call.");
				return;
			case "call": {
				const port = this.#port;
				const reply = (result: ToolResult) => {
					if (this.#port === port)
						port?.postMessage({ type: "result", session: message.session, id: message.id, result });
				};
				if (session === undefined) reply(text("The session ended; reconnect.", true));
				else void this.#call(session, message.id, message.tool, message.args ?? {}).then(reply);
			}
		}
	}

	async #call(session: Session, id: number, tool: string, args: Args): Promise<ToolResult> {
		const { context, cancel } = withCancel(BACKGROUND_CONTEXT);
		let stopped: string | null = null;
		session.calls.set(id, (reason) => {
			stopped = reason;
			cancel(new Error(reason));
		});
		try {
			return await this.#run(session, tool, args, context);
		} catch (error) {
			if (stopped !== null)
				return text(`${stopped} The call may have happened in part: check before going on.`, true);
			// Checks at a dispatch: Off, the switch, or the tab that left the group while the call ran.
			if (error instanceof PageRefused) return text(error.message, true);
			if (error instanceof ScopeDenied) return text(LEFT_GROUP, true);
			return text(`Failed: ${messageOf(error)}.`, true);
		} finally {
			session.calls.delete(id);
		}
	}

	#run(session: Session, tool: string, args: Args, context: Context): Promise<ToolResult> {
		switch (tool) {
			case "list_tabs":
				return this.#listTabs(session);
			case "open_tab": {
				// One at a time: two first calls together would each make a group, and the first one's tab would be lost.
				const opened = session.opening.then(() => this.#openTab(session, args, context));
				session.opening = opened.catch(() => {});
				return opened;
			}
			case "read_page":
				return this.#readPage(session, args, context);
			case "observe_page":
				return this.#observePage(session, args, context);
			case "act_on_page":
				return this.#actOnPage(session, args, context);
			case "run_script":
				return this.#runScript(session, args, context);
			case "screenshot_page":
				return this.#screenshot(session, args, context);
			case "close_tab":
				return this.#closeTab(session, args, context);
			default:
				return Promise.resolve(text(`Unknown tool: ${tool}`, true));
		}
	}

	#end(session: Session, reason: string): void {
		for (const stop of session.calls.values()) stop(reason);
		this.#sessions.delete(session.id);
		this.#changed();
	}

	#endAll(reason: string): void {
		for (const session of [...this.#sessions.values()]) this.#end(session, reason);
	}

	/** A refusal when the tool is Off, else null; open_tab and close_tab follow Act. */
	#mode(key: keyof ToolModes, tool: string): string | null {
		return this.#deps.currentSettings().tools[key] === "off" ? offText(tool) : null;
	}

	/** The tabs of the session's group, now; none before its first open_tab, or after the user closed them all. */
	async #members(session: Session): Promise<ScopeTab[]> {
		if (session.groupId === null) return [];
		const tabs = await chrome.tabs.query({ groupId: session.groupId }).catch(() => []);
		return tabs.flatMap((tab) =>
			tab.id === undefined ? [] : [{ id: tab.id, windowId: tab.windowId, groupId: tab.groupId }],
		);
	}

	/** The tab a call works on: `tab` if given, else the one used last; a refusal when it is not in the group. */
	async #target(session: Session, tab: unknown): Promise<number | string> {
		const id = tab ?? session.tab;
		if (id === null) return "This session has no tab yet: open one with open_tab.";
		if (!Number.isInteger(id)) return "tab must be a tab ID from open_tab or list_tabs.";
		if (!(await this.#members(session)).some((member) => member.id === id))
			return `Tab ${id} is not in this session's tab group: open a page with open_tab, or ask the user to drag the tab into the group.`;
		session.tab = id as number;
		return id as number;
	}

	/**
	 * Chrome access for one call on `tabId`: before every request to Chrome, the tool's mode, the session, the switch,
	 * and the tab's membership in the group are checked again.
	 */
	#scoped(session: Session, tabId: number, tool: string, context: Context) {
		const groups = {
			scope: async (_anchor: number, check?: () => void) => {
				check?.();
				return this.#members(session);
			},
			group: async () => null,
		};
		const policy = () =>
			!this.#on || this.#sessions.get(session.id) !== session ? "The session ended in Pagewing." : null;
		return scopedPageAccess({ ...this.#deps, groups }, tabId, tabId, tool, context, policy);
	}

	async #listTabs(session: Session): Promise<ToolResult> {
		const tabs =
			session.groupId === null ? [] : await chrome.tabs.query({ groupId: session.groupId }).catch(() => []);
		return json({
			tabs: tabs.map((tab) => ({
				tab: tab.id,
				url: cut(tab.url ?? "", MAX_URL_CHARS),
				title: pageTitle(tab.title ?? ""),
				active: tab.active,
			})),
		});
	}

	async #openTab(session: Session, args: Args, context: Context): Promise<ToolResult> {
		const url = httpUrl(args.url);
		if (url === null) return text("url must be an http or https URL.", true);
		const group =
			session.groupId === null ? undefined : await chrome.tabGroups.get(session.groupId).catch(() => undefined);
		// The last checks before Chrome: the call, Act's mode, the switch, and the session.
		context.abortSignal?.throwIfAborted();
		const off = this.#mode("act", "open_tab");
		if (off !== null) return text(off, true);
		if (!this.#on || this.#sessions.get(session.id) !== session) return text("The session ended in Pagewing.", true);
		const created = await chrome.tabs.create({
			url,
			active: true,
			...(group === undefined ? {} : { windowId: group.windowId }),
		});
		const tabId = created.id!;
		const groupId = await chrome.tabs.group({
			tabIds: [tabId],
			...(group === undefined ? {} : { groupId: group.id }),
		});
		if (group === undefined) await chrome.tabGroups.update(groupId, { title: session.name, color: "purple" });
		session.groupId = groupId;
		session.tab = tabId;
		const loaded = await bounded(
			(signal) => this.#deps.access.loaded(tabId, LOAD_MS, signal),
			context,
			LOAD_MS + 1_000,
		).catch(() => false);
		const tab = await chrome.tabs.get(tabId);
		return json({ tab: tabId, url: tab.url ?? url, title: pageTitle(tab.title ?? ""), loaded });
	}

	async #readPage(session: Session, args: Args, context: Context): Promise<ToolResult> {
		const off = this.#mode("read", READ_PAGE);
		if (off !== null) return text(off, true);
		const tabId = await this.#target(session, args.tab);
		if (typeof tabId === "string") return text(tabId, true);
		const offset = Number.isInteger(args.offset) ? Math.max(0, args.offset as number) : 0;
		const limit = Number.isInteger(args.limit) ? Math.min(30_000, Math.max(1_000, args.limit as number)) : 12_000;
		const { access, wait } = this.#scoped(session, tabId, READ_PAGE, context);
		// Reading on: the snapshot of the first read, while the tab still shows its page.
		let snapshot = offset > 0 ? session.reads.get(tabId) : undefined;
		let changed = false;
		if (snapshot !== undefined) {
			const read = snapshot.read!;
			const now = await wait(() => access.current(tabId, read), context, PAGE_TIMEOUT_MS).catch(() => null);
			if (now !== snapshot.url) {
				snapshot = undefined;
				changed = true;
			}
		}
		if (snapshot === undefined) {
			const page = { tabId, frameId: 0, documentId: "", url: "", title: "", capturedAt: 0 };
			const read = await wait(
				(signal) => readTab(access, page, signal, async () => null, "page"),
				context,
				PAGE_TIMEOUT_MS,
			);
			if (typeof read === "string") return text(read, true);
			snapshot = {
				id: ++this.#reads,
				documentId: read.documentId,
				read: read.documentId,
				url: cut(read.url, MAX_URL_CHARS),
				title: pageTitle(read.title),
				takenAt: Date.now(),
				text: read.text,
				truncated: read.truncated,
			};
			session.reads.set(tabId, snapshot);
		}
		if (offset > snapshot.text.length)
			return text(`offset ${offset} is past the end of the page text (${snapshot.text.length} characters).`, true);
		// A page that changed since the first read is read again: the offset then points into the new text.
		const { snapshotId: _, ...result } = envelope(snapshot, offset, limit, changed);
		return json(result);
	}

	async #observePage(session: Session, args: Args, context: Context): Promise<ToolResult> {
		const off = this.#mode("observe", OBSERVE_PAGE);
		if (off !== null) return text(off, true);
		const tabId = await this.#target(session, args.tab);
		if (typeof tabId === "string") return text(tabId, true);
		const { access, wait } = this.#scoped(session, tabId, OBSERVE_PAGE, context);
		const top = await this.#top(access, wait, tabId, context);
		if (typeof top === "string") return text(top, true);
		let within: AgentTarget | null = null;
		if (typeof args.within === "string") {
			const found = targetOf(session.maps, args.within, top.documentId);
			if (typeof found === "string") return text(found, true);
			within = found;
		}
		const known = session.maps.maps
			.filter((map) => map.documentId === top.documentId)
			.map(({ letter, mapId }) => ({ letter, mapId }));
		const find = typeof args.find === "string" && args.find.trim() !== "" ? args.find.trim().slice(0, 200) : null;
		const result = await wait(
			() =>
				access.observe(tabId, top.documentId, {
					op: "observe",
					known,
					letter: letterOf(session.maps.next),
					find,
					within,
					maxBytes: MAX_RESULT_BYTES - 8 * 1024,
					budgetMs: 3_000,
					maxElements: 100_000,
					maxMatches: 50,
					maxUrl: MAX_URL_CHARS,
				}),
			context,
			PAGE_TIMEOUT_MS,
		);
		if (result === null) return text("The page went away while Pagewing observed it; observe again.", true);
		if (!result.ok) return text(result.error, true);
		if (!known.some((map) => map.mapId === result.mapId)) {
			// A new map takes the letter the page wrote, unless another call of the session took it meanwhile.
			if (letterOf(session.maps.next) !== result.letter)
				return text("The page's refs changed while Pagewing observed it; observe again.", true);
			session.maps.next += 1;
			session.maps.maps.push({ letter: result.letter, documentId: top.documentId, mapId: result.mapId });
			if (session.maps.maps.length > MAX_MAPS) session.maps.maps.splice(0, session.maps.maps.length - MAX_MAPS);
		}
		return json({
			url: result.url,
			title: pageTitle(result.title),
			outline: result.outline,
			omitted: result.omitted,
		});
	}

	async #actOnPage(session: Session, args: Args, context: Context): Promise<ToolResult> {
		const off = this.#mode("act", ACT_ON_PAGE);
		if (off !== null) return text(off, true);
		const action = args.action;
		const missing = missingArgument(action, args);
		if (missing !== null) return text(missing, true);
		const tabId = await this.#target(session, args.tab);
		if (typeof tabId === "string") return text(tabId, true);
		const { access, wait } = this.#scoped(session, tabId, ACT_ON_PAGE, context);
		session.reads.delete(tabId);
		const settled = async (before: string | null, done: string, timedOut: boolean, opened: number[]) => {
			const loaded = await wait((signal) => access.loaded(tabId, LOAD_MS, signal), context, LOAD_MS + 1_000).catch(
				() => false,
			);
			const after = await wait(() => access.top(tabId), context, PAGE_TIMEOUT_MS).catch(() => null);
			const tab = after === null ? await chrome.tabs.get(tabId).catch(() => null) : null;
			return json({
				done,
				url: after?.url ?? tab?.url ?? "(not known)",
				title: pageTitle(after?.title ?? tab?.title ?? ""),
				navigated: after?.documentId !== before,
				timedOut: timedOut || !loaded,
				...(opened.length > 0 ? { opened } : {}),
			});
		};
		if (action === "navigate") {
			const reload = args.url === "reload";
			const url = reload ? "reload" : httpUrl(args.url);
			if (url === null) return text('url must be an http or https URL, or "reload".', true);
			// Also from a page Pagewing cannot script, such as Chrome's error page.
			const before = await wait(() => access.top(tabId), context, PAGE_TIMEOUT_MS).catch(() => null);
			// The last checks before Chrome: mode, session, switch, and the tab's group.
			await wait(() => access.check(), context, PAGE_TIMEOUT_MS);
			if (reload) await chrome.tabs.reload(tabId);
			else await chrome.tabs.update(tabId, { url });
			return settled(before?.documentId ?? null, reload ? "Reloaded the page" : `Went to ${url}`, false, []);
		}
		const top = await this.#top(access, wait, tabId, context);
		if (typeof top === "string") return text(top, true);
		let target: AgentTarget | null = null;
		if (typeof args.ref === "string") {
			const found = targetOf(session.maps, args.ref, top.documentId);
			if (typeof found === "string") return text(found, true);
			target = found;
		}
		const request: ActRequest = {
			op: "act",
			action: action as ActAction,
			target,
			known: session.maps.maps
				.filter((map) => map.documentId === top.documentId)
				.map(({ letter, mapId }) => ({ letter, mapId })),
			text: typeof args.text === "string" ? args.text : null,
			submit: args.submit === true,
			key: typeof args.key === "string" ? args.key : null,
			option: typeof args.option === "string" ? args.option : null,
			direction: ["up", "down", "top", "bottom"].includes(args.direction as string)
				? (args.direction as ActRequest["direction"])
				: null,
			summary: null,
			quietMs: 300,
			maxWaitMs: 5_000,
			outlineMs: 800,
			maxUrl: MAX_URL_CHARS,
		};
		// Tabs the page opens during the action, as a link with target _blank does, join the session's group.
		const stopNoting = this.#deps.access.opened(tabId);
		let result: Awaited<ReturnType<typeof access.act>>;
		try {
			result = await wait(() => access.act(tabId, top.documentId, request), context, PAGE_TIMEOUT_MS);
		} catch (error) {
			stopNoting();
			if (context.abortSignal?.aborted) throw error;
			return text(
				`Cannot act on the page: ${messageOf(error)}. The action may still have happened: observe and check before trying again.`,
				true,
			);
		}
		const noted = stopNoting();
		// A tab that opened while the user also clicked or typed in the page may be theirs: as with the page tools
		// (6.23), Pagewing groups and reports only tabs the action alone opened. Chrome may still put the user's tab in
		// the group, as it does with any tab opened from a grouped tab; the group is the session's boundary (6.45).
		const opened = result !== null && result.userInput === false ? noted : [];
		if (opened.length > 0 && session.groupId !== null)
			// Chrome's type wants a non-empty list: the length check above guarantees it.
			await chrome.tabs.group({ tabIds: opened as [number, ...number[]], groupId: session.groupId }).catch(() => {});
		if (result === null)
			return text(
				`No answer came from the page after the ${action} (it may have unloaded): it may or may not have happened. Observe and check before going on.`,
				true,
			);
		if (!result.ok)
			return text(
				result.sent
					? `${result.error}. The action was partly sent: observe and check before trying again.`
					: result.error,
				true,
			);
		return settled(top.documentId, stepText(result.step), result.timedOut, opened);
	}

	async #runScript(session: Session, args: Args, context: Context): Promise<ToolResult> {
		const off = this.#mode("script", RUN_SCRIPT);
		if (off !== null) return text(off, true);
		if (typeof args.code !== "string" || args.code.trim() === "") return text("code is required.", true);
		const code = args.code;
		if (!this.#deps.access.scripts())
			return text(
				`Chrome does not let Pagewing run scripts: ask the user to turn on "Allow User Scripts" on Pagewing's details page (chrome://extensions).`,
				true,
			);
		const tabId = await this.#target(session, args.tab);
		if (typeof tabId === "string") return text(tabId, true);
		const { access, wait } = this.#scoped(session, tabId, RUN_SCRIPT, context);
		const top = await this.#top(access, wait, tabId, context);
		if (typeof top === "string") return text(top, true);
		session.reads.delete(tabId);
		await wait(() => access.scriptWorld(), context, PAGE_TIMEOUT_MS);
		let result: string | null;
		try {
			result = await wait(() => access.script(tabId, top.documentId, code, MAX_RESULT_BYTES), context, SCRIPT_MS);
		} catch (error) {
			if (error instanceof PageTimeout && !context.abortSignal?.aborted)
				return text(`The script did not return within ${SCRIPT_MS / 1000} s; it may still be running.`, true);
			throw error;
		}
		if (result === null)
			return text("No result came back from the page (it may have unloaded): the script may have run.", true);
		return text(result, (JSON.parse(result) as { ok?: boolean }).ok === false);
	}

	async #screenshot(session: Session, args: Args, context: Context): Promise<ToolResult> {
		const off = this.#mode("screenshot", SCREENSHOT_PAGE);
		if (off !== null) return text(off, true);
		const tabId = await this.#target(session, args.tab);
		if (typeof tabId === "string") return text(tabId, true);
		const { access, wait } = this.#scoped(session, tabId, SCREENSHOT_PAGE, context);
		const place = await wait(() => access.tabState(tabId), context, PAGE_TIMEOUT_MS);
		if (place === null) return text("The tab is gone.", true);
		if (place.minimized) return text("The tab's window is minimized: Chrome cannot capture it.", true);
		if (!place.active) {
			// Chrome captures what a window shows: the session's tab comes to the front of its window, not the window to
			// the front of the screen.
			await wait(() => access.check(), context, PAGE_TIMEOUT_MS);
			await chrome.tabs.update(tabId, { active: true });
			await new Promise((resolve) => setTimeout(resolve, 300));
		}
		const attempt = async (): Promise<string | null> => {
			const png = await wait(() => access.capture(place.windowId), context, PAGE_TIMEOUT_MS);
			const now = await chrome.tabs.get(tabId);
			// Another tab came to the front during the capture: the image would show it.
			return now.active && now.windowId === place.windowId ? png : null;
		};
		const capture = async (gap: number) =>
			this.#deps.captures.run(attempt, context, gap).catch((error: unknown) => {
				if (messageOf(error).includes("MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND")) return "quota" as const;
				throw error;
			});
		let png = await capture(CAPTURE_GAP_MS);
		if (png === "quota") png = await capture(RETRY_GAP_MS);
		if (png === "quota") return text("Chrome allows only 2 captures a second; try again.", true);
		if (png === null) return text("Another tab came to the front during the capture; try again.", true);
		const shot = png;
		const image = await bounded(
			async () => {
				for (const [longSide, quality] of ENCODINGS) {
					const encoded = await this.#deps.access.encode(shot, null, longSide, quality);
					if (encoded.data.length <= MAX_IMAGE_CHARS) return encoded;
				}
				return null;
			},
			context,
			PAGE_TIMEOUT_MS,
		);
		if (image === null) return text("The view is too detailed to send as an image.", true);
		const tab = await chrome.tabs.get(tabId);
		return {
			content: [
				{ type: "image", data: image.data, mimeType: "image/jpeg" },
				{
					type: "text",
					text: JSON.stringify({
						url: cut(tab.url ?? "", MAX_URL_CHARS),
						title: pageTitle(tab.title ?? ""),
						width: image.width,
						height: image.height,
					}),
				},
			],
		};
	}

	async #closeTab(session: Session, args: Args, context: Context): Promise<ToolResult> {
		const off = this.#mode("act", "close_tab");
		if (off !== null) return text(off, true);
		if (args.tab === undefined) return text("tab is required.", true);
		const tabId = await this.#target(session, args.tab);
		if (typeof tabId === "string") return text(tabId, true);
		const { access, wait } = this.#scoped(session, tabId, ACT_ON_PAGE, context);
		await wait(() => access.check(), context, PAGE_TIMEOUT_MS);
		const closed = await access.close(tabId);
		session.reads.delete(tabId);
		if (session.tab === tabId) session.tab = null;
		return json({ done: closed ? `Closed tab ${tabId}` : `Tab ${tabId} was already closed` });
	}

	/** The tab's top document, if Chrome lets Pagewing script it; else why not. */
	async #top(
		access: ReturnType<typeof scopedPageAccess>["access"],
		wait: typeof bounded,
		tabId: number,
		context: Context,
	): Promise<TopDocument | string> {
		const top = await wait(() => access.top(tabId), context, PAGE_TIMEOUT_MS);
		if (top === null) return NO_ACCESS;
		return top.origin === "null" ? `The tab shows ${cut(top.url, 200)}, which the page tools cannot use.` : top;
	}
}

/** `value` as an http or https URL, or null. */
function httpUrl(value: unknown): string | null {
	if (typeof value !== "string" || value.length > MAX_URL_CHARS) return null;
	try {
		const url = new URL(value);
		return url.protocol === "http:" || url.protocol === "https:" ? url.href : null;
	} catch {
		return null;
	}
}

const ACTIONS = ["click", "type", "press", "scroll", "select_option", "navigate"];

/** Why act_on_page's `action` cannot run with `args`, or null. */
function missingArgument(action: unknown, args: Args): string | null {
	if (!ACTIONS.includes(action as string)) return `action must be one of ${ACTIONS.join(", ")}.`;
	const need = (name: string, of: string) => (typeof args[name] === "string" ? null : `${of} needs ${name}.`);
	switch (action) {
		case "click":
			return need("ref", "click");
		case "type":
			return need("ref", "type") ?? need("text", "type");
		case "select_option":
			return need("ref", "select_option") ?? need("option", "select_option");
		case "press":
			return need("key", "press");
		case "scroll":
			return typeof args.direction === "string" ? null : "scroll needs direction.";
		default:
			return need("url", "navigate");
	}
}
