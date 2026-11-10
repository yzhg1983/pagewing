// The console hook (design 6.46): runs in the page's own world before the page's scripts, and keeps the page's console
// messages, uncaught errors, and unhandled rejections in a ring that read_console_messages reads. The page can see,
// change, or remove it: what it holds is page data, checked again in the worker.

import {
	CONSOLE_KEY,
	type ConsoleHook,
	type ConsoleRecord,
	MAX_CONSOLE_RECORDS,
	MAX_CONSOLE_TEXT,
} from "../shared/console.ts";

const LEVELS = ["log", "info", "warn", "error", "debug"] as const;

install();

/** Installs the hook once per document: the registration and a later injection may both run it. */
function install(): void {
	const scope = globalThis as unknown as Record<symbol, ConsoleHook | undefined>;
	const key = Symbol.for(CONSOLE_KEY);
	if (scope[key] !== undefined) return;
	const records: ConsoleRecord[] = [];
	let last = 0;
	// The real clock: a page that fakes time (test timers) would put its records before the recording started.
	const now = Date.now;
	const add = (level: ConsoleRecord["level"], text: string, source: string | null) => {
		records.push({ seq: ++last, at: now(), level, text: text.slice(0, MAX_CONSOLE_TEXT), source });
		if (records.length > MAX_CONSOLE_RECORDS) records.shift();
	};
	const wrappers = LEVELS.map((level) => {
		const original = console[level];
		const wrapper = function (this: unknown, ...args: unknown[]) {
			// An argument can throw (a getter, a revoked Proxy): the page's own call still goes through.
			try {
				add(level, args.map(format).join(" "), null);
			} catch {}
			return original.apply(this, args);
		};
		console[level] = wrapper;
		return { level, original, wrapper };
	});
	const onError = (event: Event) => {
		// Also a failed image or script, whose error event does not bubble: the network tool reports those.
		if (!(event instanceof ErrorEvent)) return;
		const where = event.filename === "" ? null : `${event.filename}:${event.lineno}:${event.colno}`;
		const stack =
			event.error instanceof Error && typeof event.error.stack === "string" ? `\n${event.error.stack}` : "";
		add("exception", `Uncaught ${event.message}${stack}`, where);
	};
	const onRejection = (event: PromiseRejectionEvent) => {
		try {
			add("rejection", `Uncaught (in promise) ${format(event.reason)}`, null);
		} catch {}
	};
	addEventListener("error", onError, true);
	addEventListener("unhandledrejection", onRejection);
	const hook: ConsoleHook = {
		startedAt: now(),
		read: (after) => records.filter((record) => record.seq > after),
		last: () => last,
		restart() {
			records.length = 0;
			hook.startedAt = now();
			return hook.startedAt;
		},
		stop() {
			// Only where Pagewing's wrapper is still in place: the page may have put its own over it.
			for (const { level, original, wrapper } of wrappers) if (console[level] === wrapper) console[level] = original;
			removeEventListener("error", onError, true);
			removeEventListener("unhandledrejection", onRejection);
			records.length = 0;
			delete scope[key];
		},
	};
	Object.defineProperty(scope, key, { value: hook, configurable: true });
}

/**
 * One argument as the console would show it, cheaply: a page that logs a large object must not pay for all of it. A
 * getter is shown as (...), as DevTools does, and never called: it can send a request or change the page's state.
 */
function format(value: unknown): string {
	if (typeof value === "string") return value.slice(0, MAX_CONSOLE_TEXT);
	if (value instanceof Error) return `${value.name}: ${value.message}`;
	if (value === null || typeof value !== "object") return String(value);
	if (Array.isArray(value)) return `Array(${value.length})`;
	try {
		const fields = Object.keys(value)
			.slice(0, 10)
			.map((name) => {
				const field = Object.getOwnPropertyDescriptor(value, name);
				if (field === undefined || !("value" in field)) return `${name}: (...)`;
				const shown = field.value;
				return `${name}: ${shown !== null && typeof shown === "object" ? "{…}" : String(shown).slice(0, 100)}`;
			});
		return `{${fields.join(", ")}}`;
	} catch {
		return "{…}";
	}
}
