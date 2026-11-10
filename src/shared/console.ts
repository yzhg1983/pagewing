// What the console hook (design 6.46) keeps in the page, and the limits the worker checks it against: the hook runs in
// the page's world, so the worker treats what it returns as page data.

/** The page global, as `Symbol.for(CONSOLE_KEY)`, that holds the hook. */
export const CONSOLE_KEY = "pagewing.console";
/** Records the hook keeps; older ones go. */
export const MAX_CONSOLE_RECORDS = 300;
/** Characters kept of one record's text. */
export const MAX_CONSOLE_TEXT = 1_000;

/** A console message, an uncaught error ("exception"), or an unhandled rejection. `seq` counts from 1 in the document. */
export type ConsoleRecord = {
	seq: number;
	at: number;
	level: "log" | "info" | "warn" | "error" | "debug" | "exception" | "rejection";
	text: string;
	/** Where an uncaught error was thrown: `url:line:column`. */
	source: string | null;
};

/** The hook in the page. */
export type ConsoleHook = {
	/** When it started recording, or last restarted: in ms since the epoch. */
	startedAt: number;
	/** The records after `seq`, oldest first. */
	read(after: number): ConsoleRecord[];
	last(): number;
	/** Drops the records so far, as when the tab enters scope; returns the new `startedAt`. */
	restart(): number;
	/** Restores `console` where its wrapper is still in place, stops listening, and drops the records and itself. */
	stop(): void;
};
