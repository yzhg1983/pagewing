import { afterEach, expect, it, vi } from "vitest";
import { userScriptsAllowed } from "../src/shared/user-scripts.ts";

afterEach(() => vi.unstubAllGlobals());

it("offers scripts while Chrome's switch is on", () => {
	vi.stubGlobal("chrome", { userScripts: { getScripts: () => Promise.resolve([]) } });
	expect(userScriptsAllowed()).toBe(true);
});

it("offers no scripts in a context that started with the switch off, which Chrome gives no chrome.userScripts", () => {
	vi.stubGlobal("chrome", {});
	expect(userScriptsAllowed()).toBe(false);
});

it("offers no scripts once the switch went off in a running context", () => {
	vi.stubGlobal("chrome", {
		userScripts: {
			getScripts: () => {
				throw new Error("Allow User Scripts is off");
			},
		},
	});
	expect(userScriptsAllowed()).toBe(false);
});
