// Recording access for tests (design 6.46): a console hook per document kept as Chrome's would be, registrations, and
// webRequest listeners a test fires events through.

import type { HookAnswer, HookOp, NetworkEvent, RecordingAccess } from "../../src/background/recording.ts";
import type { ConsoleRecord } from "../../src/shared/console.ts";
import { MAX_CONSOLE_RECORDS } from "../../src/shared/console.ts";

/** A document's hook: its records and when it started. */
type Hook = { startedAt: number; records: ConsoleRecord[]; last: number };

export class FakeRecording implements RecordingAccess {
	allowed = true;
	time = 1_000;
	/** The origins registered, as the last `register()` set them. */
	registered: string[] = [];
	/** Each tab's listener while it listens. */
	readonly listeners = new Map<number, (event: NetworkEvent) => void>();
	/** Hooks by document; a document without one gets one at its first hook call, as an injection would. */
	readonly hooks = new Map<string, Hook>();
	/** Documents Chrome refuses to script, as after access is lost. */
	readonly refused = new Set<string>();
	readonly stopped: string[] = [];

	networkAllowed = async () => this.allowed;

	listen(tabId: number, event: (event: NetworkEvent) => void): () => void {
		this.listeners.set(tabId, event);
		return () => {
			if (this.listeners.get(tabId) === event) this.listeners.delete(tabId);
		};
	}

	async register(origins: string[]): Promise<void> {
		this.registered = origins;
	}

	/** The hook's call; the tab's top document is "top <tabId>". */
	async hook(tabId: number, document: string | null, op: HookOp): Promise<HookAnswer | null> {
		const documentId = document ?? `top ${tabId}`;
		if (this.refused.has(documentId)) throw new Error("Cannot access contents of the page.");
		if (op === "stop") {
			this.hooks.delete(documentId);
			this.stopped.push(documentId);
			return null;
		}
		const hook = this.hooks.get(documentId) ?? this.page(documentId);
		if (op === "restart") {
			hook.records = [];
			hook.startedAt = this.time;
		}
		return { startedAt: hook.startedAt, records: hook.records };
	}

	now = () => this.time;

	/** The document's hook, as the registration would have started it at its load. */
	page(documentId: string): Hook {
		const hook: Hook = { startedAt: this.time, records: [], last: 0 };
		this.hooks.set(documentId, hook);
		return hook;
	}

	/** The page logs `text` at `level`. */
	log(documentId: string, text: string, level: ConsoleRecord["level"] = "log", source: string | null = null): void {
		const hook = this.hooks.get(documentId) ?? this.page(documentId);
		hook.records.push({ seq: ++hook.last, at: this.time, level, text, source });
		if (hook.records.length > MAX_CONSOLE_RECORDS) hook.records.shift();
	}

	/** Chrome reports `event` for the tab, if it listens. */
	fire(tabId: number, event: NetworkEvent): void {
		this.listeners.get(tabId)?.(event);
	}

	/** A request from start to end on the tab: `end` a status, or a network error. */
	request(
		tabId: number,
		requestId: string,
		url: string,
		end: number | string,
		method = "GET",
		type = "xmlhttprequest",
	): void {
		this.fire(tabId, { kind: "start", requestId, navigation: type === "main_frame" ? url : null });
		this.fire(
			tabId,
			typeof end === "number"
				? { kind: "end", requestId, at: this.time, method, url, type, status: end }
				: { kind: "error", requestId, at: this.time, method, url, type, error: end },
		);
	}
}
