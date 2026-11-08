import { afterEach, describe, expect, it, vi } from "vitest";
import { limitText, NO_ACCESS, NO_PAGE, offText } from "../src/background/page.ts";
import { localReason } from "../src/background/reasons.ts";
import { SCOPE_DENIED } from "../src/background/tab-groups.ts";
import { type MessageKey, t } from "../src/shared/i18n.ts";
import chinese from "../static/_locales/zh_CN/messages.json" with { type: "json" };

afterEach(() => vi.unstubAllGlobals());

function nativeChinese(): void {
	vi.stubGlobal("chrome", {
		i18n: {
			getMessage: (key: MessageKey, values: string[] = []) =>
				chinese[key].message.replace(/\$([1-9])/g, (_match, index: string) => values[Number(index) - 1] ?? ""),
		},
	});
}

// Each text as page.ts, page-tools.ts, page-agent.ts, and tab-groups.ts write it, and the message it shows as.
const TEXTS: readonly (readonly [string, MessageKey, string[]])[] = [
	[offText("act_on_page"), "reasonOff", ["操作页面"]],
	[
		"Chrome does not allow pi to run scripts: ask the user to turn on Allow User Scripts on pi's details page.",
		"reasonNoUserScripts",
		[],
	],
	["Skipped: an earlier step in this reply failed; observe the page and decide again.", "reasonSkipped", []],
	[
		"Skipped: pi could not find this call's reply in the chat; observe the page and decide again.",
		"reasonSkippedUnknown",
		[],
	],
	[limitText(40), "reasonLimit", ["40"]],
	[SCOPE_DENIED, "reasonScope", []],
	[
		"The user cancelled: Chrome does not let pi reach this tab. Do not try again in this answer.",
		"reasonSiteCancelled",
		[],
	],
	["The user denied this script, so nothing ran; do not try again in this answer.", "reasonScriptDenied", []],
	[
		"The user denied acting on https://example.com in this answer; do not try again in this answer.",
		"reasonActDenied",
		["https://example.com"],
	],
	["The user has not approved this script; nothing ran.", "reasonScriptNotApproved", []],
	[
		"The page changed while the user looked at the script, so nothing ran. Check the page and decide again.",
		"reasonScriptPageChanged",
		[],
	],
	[NO_PAGE, "reasonNoPage", []],
	[
		"pi can act only on a page attached at its top level; ask the user to click the pi button on the page.",
		"reasonNotTop",
		[],
	],
	["Another chat is acting on this tab; try again when it is done.", "reasonBusy", []],
	["The tab shows chrome://settings/, which the page tools cannot use.", "reasonUnusableTab", ["chrome://settings/"]],
	[
		"Cannot read the page: the tab did not answer within 20 s. Ask the user to ask again when the page has loaded.",
		"reasonReadSlow",
		["20"],
	],
	["Cannot read the page: the page has no readable text.", "reasonNoText", []],
	["Cannot read the page: Frame was removed.", "reasonCannotRead", ["Frame was removed"]],
	["the page did not answer within 10 s", "reasonPageSlow", ["10"]],
	["No readable text is selected.", "reasonNoSelection", []],
	["The page went away while pi observed it; observe again.", "reasonGoneObserving", []],
	["The page's refs changed while pi observed it; observe again.", "reasonRefsChanged", []],
	[
		"The page changed during the wait: the tab now shows https://x/2. Check the page and decide again.",
		"reasonWaitChanged",
		["https://x/2"],
	],
	["The page has no readable text to wait for.", "reasonNoTextToWait", []],
	[
		"The wait ended: pi could not check the page (the tab closed). Check the page and decide again.",
		"reasonWaitUnchecked",
		["the tab closed"],
	],
	["a12 is gone (the page changed): observe again", "reasonGone", ["a12"]],
	["a12 is not drawn (hidden, collapsed, or empty): observe again", "reasonNotDrawn", ["a12"]],
	["a12 is disabled", "reasonDisabled", ["a12"]],
	["The center of a12 is outside the window", "reasonOutside", ["a12"]],
	[
		'The center of a12 is button "Save" (a13); act on that ref instead',
		"reasonCenterOther",
		["a12", 'button "Save" (a13)'],
	],
	['a12 is covered by dialog "Cookies"', "reasonCovered", ["a12", 'dialog "Cookies"']],
	["a16 is not a text field", "reasonNotTextField", ["a16"]],
	["a16 changed when it got the focus: observe again", "reasonChangedOnFocus", ["a16"]],
	["a16 moved to another form when it got the focus: observe again", "reasonMovedForm", ["a16"]],
	["a16 is read-only", "reasonReadOnly", ["a16"]],
	["a16 is inert", "reasonInert", ["a16"]],
	["a16 is not in a form: type without submit, then click the form's button", "reasonNoForm", ["a16"]],
	["Typing into a16 failed", "reasonTypingFailed", ["a16"]],
	["The focus did not go to a16", "reasonNoFocus", ["a16"]],
	['Focus went to textbox "Name" (a2), not a16', "reasonFocusElsewhere", ['textbox "Name" (a2)', "a16"]],
	["The page has no element to press the key in", "reasonNoKeyTarget", []],
	["a4 is not a <select>: click it, then click the option", "reasonNotSelect", ["a4"]],
	["pi does not choose in Password (a4)", "reasonNoChoose", ["Password", "a4"]],
	["pi does not type into Password (a4)", "reasonNoType", ["Password", "a4"]],
	['a4 has no option "XL"; its options: S, M, L', "reasonNoOption", ["a4", "XL", "S, M, L"]],
	['The option "XL" of a4 is disabled', "reasonOptionDisabled", ["XL", "a4"]],
	["The page went away while pi scrolled it; try again.", "reasonGoneScrolling", []],
	[
		"navigate only goes to URLs on https://a.com, not https://b.com.",
		"reasonNavigateOrigin",
		["https://a.com", "https://b.com"],
	],
	["The attached page's tab is never closed by pi.", "reasonAttachedTab", []],
	["Tab 12 was not opened by pi in this chat.", "reasonNotOpened", ["12"]],
	["Cannot close tab 12: No tab with id: 12.", "reasonCannotClose", ["12", "No tab with id: 12"]],
	["The current model cannot see images; use read_page or observe_page instead.", "reasonNoVision", []],
	["The current model cannot see images.", "reasonNoVision", []],
	["The page is zoomed with a pinch; pi can only capture the whole view.", "reasonPinch", []],
	[
		"The element is in a rotated, skewed, or mirrored part of the page; pi can only capture the whole view.",
		"reasonTransformed",
		[],
	],
	["pi cannot measure where the page cuts this element off; pi can only capture the whole view.", "reasonClipped", []],
	["The element moved out of view; try again.", "reasonMovedOut", []],
	["The element moved during the capture; try again.", "reasonMovedDuring", []],
	[
		"Chrome lets pi capture this tab only with access to all sites, or after the user opens pi on it while it shows this site. Ask the user to allow pi on all sites in Settings > Advanced > Sites, or to click pi's toolbar button on this tab, then try again.",
		"reasonCaptureAccess",
		[],
	],
	["Cannot capture the tab: image readback failed.", "reasonCannotCapture", ["image readback failed"]],
	[
		"The tab is not in front, so pi cannot capture it: Chrome captures only the tab shown in its window.",
		"reasonNotInFront",
		[],
	],
	["The tab changed during the capture; try again.", "reasonTabChangedCapture", []],
	["Chrome allows only 2 captures a second, and refused this one; try again.", "reasonCaptureQuota", []],
	["Cannot encode the image within 10 s.", "reasonEncodeTimeout", ["10"]],
	["Cannot encode the image: out of memory.", "reasonCannotEncode", ["out of memory"]],
	["The view is too detailed to send as an image.", "reasonTooDetailed", []],
];

describe("localReason", () => {
	it("says each reason pi writes in the interface language", () => {
		nativeChinese();
		for (const [text, key, values] of TEXTS) expect(localReason(text), text).toBe(t(key, values));
		expect(localReason(offText("act_on_page"))).toBe("“操作页面”已在“设置 > 工具”中关闭。");
		expect(localReason("a16 is not a text field")).toBe("a16 不是文本框。");
	});

	it("names the Settings row that turned a tool off", () => {
		nativeChinese();
		expect(localReason(offText("wait_on_page"))).toBe(t("reasonOff", [t("readPage")]));
		expect(localReason(offText("list_tabs"))).toBe(t("reasonAllOff"));
	});

	it("says pi's own text inside a reason in the same language", () => {
		nativeChinese();
		expect(localReason("Cannot read the page: the page did not answer within 10 s.")).toBe(
			t("reasonCannotRead", [t("reasonPageSlow", ["10"])]),
		);
		expect(localReason(`Cannot read the page: ${offText("read_page")}`)).toBe(
			t("reasonCannotRead", [t("reasonOff", [t("readPage")]).replace(/。$/, "")]),
		);
	});

	it("says a reason and the sentence pi adds after it, each in the interface language", () => {
		nativeChinese();
		expect(localReason(`Cannot reach the page. ${NO_ACCESS}`)).toBe(
			t("reasonAnd", [t("reasonCannotReach"), t("reasonNoAccess")]),
		);
		expect(localReason(`Cannot observe the page: Frame was removed. ${NO_ACCESS}`)).toBe(
			`无法观察网页：Frame was removed。${t("reasonNoAccess")}`,
		);
		for (const [text, key, values] of [
			[`Cannot read the page: pi may not read the tab's page now. ${NO_ACCESS}`, "reasonCannotReadNow", []],
			[`Cannot find the element: Frame was removed. ${NO_ACCESS}`, "reasonCannotFind", ["Frame was removed"]],
			[
				`Cannot scroll the page: Frame was removed. It may have scrolled. ${NO_ACCESS}`,
				"reasonCannotScroll",
				["Frame was removed"],
			],
		] as const)
			expect(localReason(text)).toBe(t("reasonAnd", [t(key, [...values]), t("reasonNoAccess")]));
		expect(localReason(`a12 is disabled. The action was partly sent: observe and check before trying again.`)).toBe(
			"a12 已被禁用。这个操作已部分发送：再试之前请先检查网页。",
		);
	});

	it("keeps any other text as it is, rather than half translated", () => {
		nativeChinese();
		for (const text of [
			"rows is not defined",
			"Tool act_on_page was aborted",
			`Cannot scroll the page: x. It may have scrolled. ${NO_ACCESS} More.`,
			"a12 is disabled. The action was partly sent: observe and check before trying again.; tab 4 stays in the background",
			`Something else. ${NO_ACCESS}`,
		])
			expect(localReason(text)).toBe(text);
	});

	it("words each reason for the user in English", () => {
		expect(localReason("The user denied this script, so nothing ran; do not try again in this answer.")).toBe(
			"You declined this script, so nothing ran.",
		);
		expect(localReason(offText("list_tabs"))).toBe("Every page tool is off in Settings > Tools.");
		expect(localReason(offText("made_up"))).toBe("made_up is off in Settings > Tools.");
	});
});
