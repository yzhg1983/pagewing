// The console and network recorder (design 6.46): arming and disarming tabs, the epochs of a tab's requests, the
// cursor, URL stripping, the check of what the page's hook answers, and the results the tools return.

import { describe, expect, it } from "vitest";
import {
	consoleAnswer,
	consoleResult,
	MAX_NETWORK_RECORDS,
	type NetworkEvent,
	networkResult,
	pick,
	Recording,
	strippedUrl,
} from "../src/background/recording.ts";
import { MAX_CONSOLE_TEXT } from "../src/shared/console.ts";
import { FakeRecording } from "./fixtures/recording.ts";

const A = "https://a.test";

function recorder() {
	const fake = new FakeRecording();
	return { fake, recording: new Recording(fake) };
}

/** The tab's requests' URLs. */
const urls = (recording: Recording, tabId = 1) => recording.network(tabId)?.records.map((record) => record.url);

/** A request's end, as webRequest reports it. */
const end = (requestId: string, url: string, status = 200): Extract<NetworkEvent, { kind: "end" }> => ({
	kind: "end",
	requestId,
	at: 1_000,
	method: "GET",
	url,
	type: "xmlhttprequest",
	status,
});

describe("arming a tab", () => {
	it("registers the origin, listens to the tab, and restarts its document's hook: what came before is not read", async () => {
		const { fake, recording } = recorder();
		fake.log("d1", "before");
		await recording.arm(1, 5, A, "d1");
		expect(fake.registered).toEqual(["https://a.test/*"]);
		expect(fake.listeners.has(1)).toBe(true);
		fake.log("d1", "after");
		const console = await recording.console(1, "d1");
		expect(console?.records.map((record) => record.text)).toEqual(["after"]);
	});

	it("arming again keeps the document's messages, also of a document that loaded since (from its start)", async () => {
		const { fake, recording } = recorder();
		await recording.arm(1, 5, A, "d1");
		fake.log("d1", "one");
		await recording.arm(1, 5, A, "d1");
		// A new document of the tab, caught by the registration at its start.
		fake.log("d2", "from the start");
		await recording.arm(1, 5, A, "d2");
		expect((await recording.console(1, "d1"))?.records.map((record) => record.text)).toEqual(["one"]);
		expect((await recording.console(1, "d2"))?.records.map((record) => record.text)).toEqual(["from the start"]);
	});

	it("a port is no part of the registration; an origin that is not http or https is not registered", async () => {
		const { fake, recording } = recorder();
		await recording.arm(1, 5, "http://localhost:5173", "d1");
		await recording.registerOrigin(1, "file://");
		expect(fake.registered).toEqual(["http://localhost/*"]);
	});

	it("without webRequest, it records the console only; once granted, the next use listens, from then on", async () => {
		const { fake, recording } = recorder();
		fake.allowed = false;
		await recording.arm(1, 5, A, "d1");
		expect(fake.listeners.has(1)).toBe(false);
		const before = recording.network(1)!;
		fake.allowed = true;
		fake.time = 2_000;
		await recording.arm(1, 5, A, "d1");
		expect(fake.listeners.has(1)).toBe(true);
		const after = recording.network(1)!;
		expect(after.epoch).not.toBe(before.epoch);
		expect(after.startedAt).toBe(2_000);
	});

	it("a blank tab (open_tab) is armed before it loads: the navigation's request and the page's are recorded", async () => {
		const { fake, recording } = recorder();
		await recording.arm(1, 5, null, null);
		await recording.registerOrigin(1, A);
		expect(fake.registered).toEqual(["https://a.test/*"]);
		fake.fire(1, { kind: "start", requestId: "nav", navigation: `${A}/` });
		fake.fire(1, { kind: "commit", url: `${A}/` });
		fake.fire(1, { ...end("nav", `${A}/`), type: "main_frame" });
		fake.request(1, "r1", `${A}/app.js`, 200, "GET", "script");
		expect(urls(recording)).toEqual([`${A}/`, `${A}/app.js`]);
	});
});

describe("calls at the same time", () => {
	/** webRequest's check held until `open()`, as a slow Chrome call. */
	const held = (fake: FakeRecording) => {
		const gate = Promise.withResolvers<void>();
		fake.networkAllowed = async () => {
			await gate.promise;
			return true;
		};
		return () => gate.resolve();
	};

	it("two arms of a new tab listen once, and a read between them sees nothing from before", async () => {
		const { fake, recording } = recorder();
		let listens = 0;
		const listen = fake.listen.bind(fake);
		fake.listen = (tabId, event) => {
			listens += 1;
			return listen(tabId, event);
		};
		fake.log("d1", "before");
		const open = held(fake);
		const arms = [recording.arm(1, 5, A, "d1"), recording.arm(1, 5, A, "d1")];
		const read = recording.console(1, "d1");
		open();
		await Promise.all(arms);
		expect(listens).toBe(1);
		expect((await read)?.records).toEqual([]);
		await recording.disarm(1);
		expect(fake.listeners.has(1)).toBe(false);
	});

	it("a disarm during an arm leaves no listener, registration, or hook", async () => {
		const { fake, recording } = recorder();
		const open = held(fake);
		const arm = recording.arm(1, 5, A, "d1");
		await Promise.resolve();
		const disarm = recording.disarm(1);
		open();
		await Promise.all([arm, disarm]);
		expect(recording.armed(1)).toBe(false);
		expect(fake.listeners.has(1)).toBe(false);
		expect(fake.registered).toEqual([]);
		expect(fake.hooks.has("d1")).toBe(false);
	});

	it("a registration that fails leaves the arm done, with the hook restarted; the next arm registers", async () => {
		const { fake, recording } = recorder();
		const register = fake.register.bind(fake);
		fake.register = async () => {
			throw new Error("Duplicate script ID");
		};
		fake.log("d1", "before");
		await recording.arm(1, 5, A, "d1");
		fake.log("d1", "after");
		expect((await recording.console(1, "d1"))?.records.map((record) => record.text)).toEqual(["after"]);
		fake.register = register;
		await recording.arm(1, 5, A, "d1");
		expect(fake.registered).toEqual(["https://a.test/*"]);
	});

	it("a hook the restart missed, as in a page back from the back-forward cache, gives nothing from before the arm", async () => {
		const { fake, recording } = recorder();
		fake.log("d2", "before");
		fake.time = 2_000;
		await recording.arm(1, 5, A, "d1");
		fake.log("d2", "after");
		const console = await recording.console(1, "d2");
		expect(console?.records.map((record) => record.text)).toEqual(["after"]);
		expect(console?.startedAt).toBe(2_000);
	});

	it("a disarm, then a new arm of the tab: the disarm's stop comes first, and the new hook stays", async () => {
		const { fake, recording } = recorder();
		await recording.arm(1, 5, A, "d1");
		const disarm = recording.disarm(1);
		const arm = recording.arm(1, 5, A, "d1");
		await Promise.all([disarm, arm]);
		expect(recording.armed(1)).toBe(true);
		expect(fake.hooks.has("d1")).toBe(true);
	});

	it("an arm from another group, as when a read beats Chrome's group event, starts a new recording", async () => {
		const { fake, recording } = recorder();
		await recording.arm(1, 5, A, "d1");
		fake.request(1, "r1", `${A}/one`, 200);
		await recording.arm(1, 6, A, "d1");
		expect(urls(recording)).toEqual([]);
		await recording.regrouped(1, 6);
		expect(recording.armed(1)).toBe(true);
	});

	it("a new worker removes the registration an earlier one left", async () => {
		const fake = new FakeRecording();
		fake.registered = ["https://a.test/*"];
		const recording = new Recording(fake);
		await recording.disarmAll();
		expect(fake.registered).toEqual([]);
	});
});

describe("disarming", () => {
	it("stops the hook in every document the tab used, ignores refusals, and keeps registrations other tabs need", async () => {
		const { fake, recording } = recorder();
		await recording.arm(1, 5, A, "d1");
		await recording.arm(1, 5, A, "d2");
		await recording.arm(2, 5, "https://b.test", "d3");
		await recording.arm(3, 5, A, "d4");
		fake.refused.add("d1");
		await recording.disarm(1);
		// d1 refused; then the top document, which d2 is in Chrome but not in the fake.
		expect(fake.stopped).toEqual(["d2", "top 1"]);
		expect(recording.armed(1)).toBe(false);
		expect(fake.listeners.has(1)).toBe(false);
		expect(fake.registered).toEqual(["https://a.test/*", "https://b.test/*"]);
		await recording.disarm(3);
		expect(fake.registered).toEqual(["https://b.test/*"]);
	});

	it("a closed tab is forgotten without stopping anything", async () => {
		const { fake, recording } = recorder();
		await recording.arm(1, 5, A, "d1");
		await recording.forget(1);
		expect(recording.armed(1)).toBe(false);
		expect(fake.stopped).toEqual([]);
		expect(fake.registered).toEqual([]);
	});

	it("a tab that leaves its group, a session's group, and Off end the recording", async () => {
		const { recording } = recorder();
		await recording.arm(1, 5, A, "d1");
		await recording.arm(2, 5, A, "d2");
		await recording.arm(3, 6, A, "d3");
		await recording.regrouped(1, 5);
		expect(recording.armed(1)).toBe(true);
		await recording.regrouped(1, -1);
		expect(recording.armed(1)).toBe(false);
		await recording.disarmGroup(5);
		expect([recording.armed(2), recording.armed(3)]).toEqual([false, true]);
		await recording.disarmAll();
		expect(recording.armed(3)).toBe(false);
	});

	it("webRequest removed: the tabs stop listening and keep their console", async () => {
		const { fake, recording } = recorder();
		await recording.arm(1, 5, A, "d1");
		recording.unlistenAll();
		expect(fake.listeners.has(1)).toBe(false);
		expect(recording.armed(1)).toBe(true);
		expect(await recording.console(1, "d1")).not.toBeNull();
	});

	it("an unrecorded tab has no console or requests", async () => {
		const { recording } = recorder();
		expect(await recording.console(1, "d1")).toBeNull();
		expect(recording.network(1)).toBeNull();
	});
});

describe("a tab's requests", () => {
	it("records ends, redirects, and errors of requests that started while listening, with stripped URLs", async () => {
		const { fake, recording } = recorder();
		await recording.arm(1, 5, A, "d1");
		// Started before the tab was recorded: dropped.
		fake.fire(1, end("old", `${A}/old`));
		fake.request(1, "r1", `${A}/api?token=x#y`, 403, "POST");
		fake.fire(1, { kind: "start", requestId: "r2", navigation: null });
		fake.fire(1, { ...end("r2", `${A}/login`, 302), kind: "redirect", to: `${A}/next?a=1` });
		fake.fire(1, end("r2", `${A}/next?a=1`));
		fake.request(1, "r3", "https://cdn.test/x.js", "net::ERR_BLOCKED_BY_CLIENT");
		const records = recording.network(1)!.records;
		expect(
			records.map(({ seq, method, url, status, redirect, error }) => ({
				seq,
				method,
				url,
				status,
				redirect,
				error,
			})),
		).toEqual([
			{ seq: 1, method: "POST", url: `${A}/api`, status: 403, redirect: null, error: null },
			{ seq: 2, method: "GET", url: `${A}/login`, status: 302, redirect: `${A}/next`, error: null },
			{ seq: 3, method: "GET", url: `${A}/next`, status: 200, redirect: null, error: null },
			{
				seq: 4,
				method: "GET",
				url: "https://cdn.test/x.js",
				status: null,
				redirect: null,
				error: "net::ERR_BLOCKED_BY_CLIENT",
			},
		]);
	});

	it("a committed move to another origin starts over: late events of the old page are dropped, the navigation joins", async () => {
		const { fake, recording } = recorder();
		await recording.arm(1, 5, A, "d1");
		fake.request(1, "r1", `${A}/one`, 200);
		const before = recording.network(1)!.epoch;
		fake.fire(1, { kind: "start", requestId: "slow", navigation: null });
		fake.fire(1, { kind: "start", requestId: "nav", navigation: "https://b.test/" });
		fake.fire(1, { kind: "commit", url: "https://b.test/" });
		fake.fire(1, { ...end("nav", "https://b.test/"), type: "main_frame" });
		fake.fire(1, {
			kind: "error",
			requestId: "slow",
			at: 1_000,
			method: "GET",
			url: `${A}/slow`,
			type: "fetch",
			error: "net::ERR_ABORTED",
		});
		expect(recording.network(1)!.epoch).not.toBe(before);
		expect(urls(recording)).toEqual(["https://b.test/"]);
	});

	it("the navigation's records join the new page also when Chrome reports its end, or a redirect, before the commit", async () => {
		const { fake, recording } = recorder();
		await recording.arm(1, 5, A, "d1");
		fake.request(1, "r1", `${A}/one`, 200);
		// From a.test, redirected to b.test: the origin that commits is the redirect's.
		fake.fire(1, { kind: "start", requestId: "nav", navigation: `${A}/go` });
		fake.fire(1, { ...end("nav", `${A}/go`, 301), kind: "redirect", to: "https://b.test/" });
		fake.fire(1, { ...end("nav", "https://b.test/"), type: "main_frame" });
		fake.fire(1, { kind: "commit", url: "https://b.test/" });
		const records = recording.network(1)!.records;
		expect(records.map(({ seq, url, status }) => ({ seq, url, status }))).toEqual([
			{ seq: 1, url: `${A}/go`, status: 301 },
			{ seq: 2, url: "https://b.test/", status: 200 },
		]);
	});

	it("a navigation that fails commits Chrome's error page on its origin: the failure joins the new page", async () => {
		const { fake, recording } = recorder();
		await recording.arm(1, 5, A, "d1");
		fake.request(1, "r1", `${A}/one`, 200);
		fake.fire(1, { kind: "start", requestId: "nav", navigation: "http://localhost:5173/" });
		fake.fire(1, {
			kind: "error",
			requestId: "nav",
			at: 1_000,
			method: "GET",
			url: "http://localhost:5173/",
			type: "main_frame",
			error: "net::ERR_CONNECTION_REFUSED",
		});
		fake.fire(1, { kind: "commit", url: "http://localhost:5173/" });
		expect(recording.network(1)!.records.map(({ url, error }) => ({ url, error }))).toEqual([
			{ url: "http://localhost:5173/", error: "net::ERR_CONNECTION_REFUSED" },
		]);
	});

	it("a 204 or a download is a top document's request but leaves the page: the records stay", async () => {
		const { fake, recording } = recorder();
		await recording.arm(1, 5, A, "d1");
		fake.request(1, "r1", `${A}/one`, 200);
		const before = recording.network(1)!.epoch;
		fake.fire(1, { kind: "start", requestId: "dl", navigation: "https://b.test/file.zip" });
		fake.fire(1, { ...end("dl", "https://b.test/file.zip"), type: "main_frame" });
		fake.request(1, "r2", `${A}/two`, 200);
		expect(recording.network(1)!.epoch).toBe(before);
		expect(urls(recording)).toEqual([`${A}/one`, "https://b.test/file.zip", `${A}/two`]);
	});

	it("a read that finds the page on another origin starts over, as a commit does", async () => {
		const { fake, recording } = recorder();
		await recording.arm(1, 5, A, "d1");
		fake.request(1, "r1", `${A}/one`, 200);
		await recording.arm(1, 5, "https://b.test", "d2");
		expect(urls(recording)).toEqual([]);
		// The old origin's registration goes with the move.
		expect(fake.registered).toEqual(["https://b.test/*"]);
	});

	it("keeps the newest 300 requests", async () => {
		const { fake, recording } = recorder();
		await recording.arm(1, 5, A, "d1");
		for (let i = 1; i <= MAX_NETWORK_RECORDS + 1; i++) fake.request(1, `r${i}`, `${A}/${i}`, 200);
		const records = recording.network(1)!.records;
		expect(records).toHaveLength(MAX_NETWORK_RECORDS);
		expect(records[0]!.seq).toBe(2);
	});

	it("keeps at most 1,000 requests open: the oldest one's end is dropped", async () => {
		const { fake, recording } = recorder();
		await recording.arm(1, 5, A, "d1");
		for (let i = 0; i <= 1_000; i++) fake.fire(1, { kind: "start", requestId: `r${i}`, navigation: null });
		fake.fire(1, end("r0", `${A}/0`));
		fake.fire(1, end("r1", `${A}/1`));
		expect(urls(recording)).toEqual([`${A}/1`]);
	});
});

describe("the cursor", () => {
	const state = (epoch: string, from: number, to: number) => ({
		epoch,
		records: Array.from({ length: to - from + 1 }, (_, i) => ({ seq: from + i })),
	});
	const all = () => true;
	const free = () => 0;

	it("since of the same epoch gives only newer records; last moves to the newest returned", () => {
		const picked = pick(state("e1", 1, 5), "e1:3", all, 100, free, 1_000);
		expect(picked).toEqual({ records: [{ seq: 4 }, { seq: 5 }], last: "e1:5", omitted: 0 });
		expect(pick(state("e1", 1, 5), "e1:5", all, 100, free, 1_000)).toEqual({ records: [], last: "e1:5", omitted: 0 });
	});

	it("since of another epoch, or not a cursor, gives all current records with reset", () => {
		expect(pick(state("e2", 1, 2), "e1:9", all, 100, free, 1_000)).toMatchObject({
			records: [{ seq: 1 }, { seq: 2 }],
			reset: true,
		});
		expect(pick(state("e2", 1, 2), "junk", all, 100, free, 1_000)).toMatchObject({ last: "e2:2", reset: true });
	});

	it("records after since that left the ring are a gap", () => {
		expect(pick(state("e1", 10, 12), "e1:5", all, 100, free, 1_000)).toMatchObject({
			records: [{ seq: 10 }, { seq: 11 }, { seq: 12 }],
			gap: true,
		});
		expect(pick(state("e1", 10, 12), "e1:9", all, 100, free, 1_000)).not.toHaveProperty("gap");
	});

	it("limit and the size bound keep the newest and count the rest as omitted", () => {
		expect(pick(state("e1", 1, 10), undefined, all, 3, free, 1_000)).toEqual({
			records: [{ seq: 8 }, { seq: 9 }, { seq: 10 }],
			last: "e1:10",
			omitted: 7,
		});
		const sized = pick(state("e1", 1, 10), undefined, all, 100, (records) => records.length * 100, 450);
		expect(sized.records.map((record) => record.seq)).toEqual([7, 8, 9, 10]);
		expect(sized.omitted).toBe(6);
	});

	it("filters count only matching records as omitted", () => {
		const even = (record: { seq: number }) => record.seq % 2 === 0;
		expect(pick(state("e1", 1, 10), undefined, even, 2, free, 1_000)).toEqual({
			records: [{ seq: 8 }, { seq: 10 }],
			last: "e1:10",
			omitted: 3,
		});
	});
});

describe("stripped URLs", () => {
	it("drops the query, fragment, user name, and password; other schemes keep only their scheme", () => {
		expect(strippedUrl("https://user:pw@a.test:8080/api/save?token=x#y")).toBe("https://a.test:8080/api/save");
		expect(strippedUrl("wss://a.test/socket?id=1")).toBe("wss://a.test/socket");
		expect(strippedUrl("data:text/plain,secret")).toBe("data:…");
		expect(strippedUrl("not a url")).toBe("(not a URL)");
	});
});

describe("the hook's answer (page data)", () => {
	it("keeps well-formed records in order, cuts text, strips sources, and names the epoch by document and start", () => {
		const records = [
			{ seq: 1, at: 1, level: "log", text: "ok", source: null },
			{ seq: 1, at: 1, level: "log", text: "repeated seq", source: null },
			{ seq: 2, at: 1, level: "nope", text: "bad level", source: null },
			{ seq: 3, at: "1", level: "log", text: "bad time", source: null },
			"not a record",
			{
				seq: 4,
				at: 2,
				level: "exception",
				text: "x".repeat(MAX_CONSOLE_TEXT + 5),
				source: "https://a.test/app.js?v=1:88:5",
			},
		];
		const state = consoleAnswer({ startedAt: 36, records }, "0123456789abcdef");
		expect(state?.epoch).toBe("0123456789ab.10");
		expect(state?.records.map((record) => record.seq)).toEqual([1, 4]);
		expect(state!.records[1]!.text).toHaveLength(MAX_CONSOLE_TEXT);
		expect(state!.records[1]!.source).toBe("https://a.test/app.js:88:5");
	});

	it("is null when it is not a hook's answer", () => {
		expect(consoleAnswer({ startedAt: "now", records: [] }, "d1")).toBeNull();
		expect(consoleAnswer({ startedAt: 1, records: "none" }, "d1")).toBeNull();
		expect(consoleAnswer({ startedAt: Number.NaN, records: [] }, "d1")).toBeNull();
		// Finite, but no Date holds it.
		expect(consoleAnswer({ startedAt: 1e300, records: [] }, "d1")).toBeNull();
	});

	it("strips the URLs of an uncaught error's stack, and cuts a long source before reading it", () => {
		const text =
			"Uncaught Error: x\nError: x\n    at f (https://a.test/app.js?v=3:10:5)\n    at https://a.test/b.js#k:1:2";
		const records = [
			{ seq: 1, at: 1, level: "exception", text, source: `https://a.test/${"p".repeat(100_000)}?q:1:2` },
			{ seq: 2, at: 1e300, level: "log", text: "bad time", source: null },
		];
		const state = consoleAnswer({ startedAt: 1, records }, "d1");
		expect(state?.records).toHaveLength(1);
		expect(state!.records[0]!.text).toBe(
			"Uncaught Error: x\nError: x\n    at f (https://a.test/app.js:10:5)\n    at https://a.test/b.js:1:2",
		);
		expect(state!.records[0]!.source!.length).toBeLessThan(2_100);
	});
});

describe("the tools' results", () => {
	it("read_console_messages filters by text or source, ignoring case, and by errors; t counts from recordingSince", () => {
		const state = {
			epoch: "d1.1",
			startedAt: 10_000,
			records: [
				{ seq: 1, at: 10_500, level: "log" as const, text: "Loaded", source: null },
				{
					seq: 2,
					at: 11_250,
					level: "exception" as const,
					text: "Uncaught TypeError",
					source: "https://a.test/app.js:88:5",
				},
				{ seq: 3, at: 12_000, level: "warn" as const, text: "app.js deprecated", source: null },
			],
		};
		const read = (query: object) => JSON.parse(consoleResult(state, `${A}/x?q=1`, query, 40_000));
		expect(read({})).toMatchObject({
			url: `${A}/x`,
			recordingSince: new Date(10_000).toISOString(),
			messages: [
				{ level: "log", text: "Loaded", t: 0.5 },
				{ level: "exception", text: "Uncaught TypeError", source: "https://a.test/app.js:88:5", t: 1.25 },
				{ level: "warn", text: "app.js deprecated", t: 2 },
			],
			last: "d1.1:3",
		});
		expect(read({ pattern: " APP.JS " }).messages).toHaveLength(2);
		expect(read({ onlyErrors: true }).messages.map((message: { text: string }) => message.text)).toEqual([
			"Uncaught TypeError",
		]);
	});

	it("read_network_requests filters by URL and stays within the size bound, the newest kept", () => {
		const records = Array.from({ length: 300 }, (_, i) => ({
			seq: i + 1,
			requestId: `r${i + 1}`,
			at: 1_000,
			method: "GET",
			url: `${A}/${"p".repeat(200)}/${i + 1}`,
			type: "image",
			status: 200,
			redirect: null,
			error: null,
		}));
		const state = { epoch: "n1", startedAt: 1_000, records };
		const text = networkResult(state, `${A}/`, { limit: 300 }, 20_000);
		expect(new TextEncoder().encode(text).length).toBeLessThanOrEqual(20_000);
		const result = JSON.parse(text);
		expect(result.requests.at(-1).url).toMatch(/\/300$/);
		expect(result.omitted).toBe(300 - result.requests.length);
		expect(result.last).toBe("n1:300");
		expect(JSON.parse(networkResult(state, `${A}/`, { urlPattern: "/299" }, 20_000)).requests).toHaveLength(1);
	});
});
