// Step reasons in the interface language (design 6.23). pi's own checks and the page tools write why a step did not
// run or failed in English, for the model, which keeps that text; the chat shows each reason it knows in the
// interface language, and any other text (Chrome's, a page's, a script's error) as it is.

import { type MessageKey, t } from "../shared/i18n.ts";

/**
 * A tool by its name in Settings, for a step without the model's summary; another name, which the model may have made
 * up for a call pi-durable ended before it found the tool, shows as it is.
 */
export function toolLabel(name: string): string {
	switch (name) {
		case "read_page":
			return t("readPage");
		case "observe_page":
			return t("observePage");
		case "act_on_page":
			return t("actPage");
		case "run_script":
			return t("runScript");
		case "screenshot_page":
			return t("screenshotPage");
		case "wait_on_page":
			return t("waitOnPage");
		case "list_tabs":
			return t("listTabs");
		default:
			return name;
	}
}

/**
 * `reason` in the interface language when every sentence of it is one pi writes, else as it is, so a reason is never
 * half translated; Chrome's or a page's words inside one of pi's sentences stay as they are.
 */
export function localReason(reason: string): string {
	for (const [ending, key] of ENDINGS) {
		if (!reason.endsWith(` ${ending}`)) continue;
		const head = localSentence(reason.slice(0, -ending.length - 1));
		return head === null ? reason : t("reasonAnd", [head, t(key)]);
	}
	return localSentence(reason) ?? reason;
}

// Sentences pi adds after a reason: page.ts's NO_ACCESS (not imported: page.ts imports this module through
// projection.ts), and page-tools.ts's partly sent action.
const ENDINGS: readonly (readonly [string, MessageKey])[] = [
	[
		"The tab may have closed, or Chrome's access from the click ended when the tab went to another site; ask the user to allow pi on all sites in Settings > Advanced > Sites, or to click the pi toolbar button on the page.",
		"reasonNoAccess",
	],
	["The action was partly sent: observe and check before trying again.", "reasonPartlySent"],
];

/** One reason pi writes, without its final period, in the interface language; null for any other text. */
function localSentence(text: string): string | null {
	const sentence = text.replace(/\.$/, "");
	for (const [pattern, key] of REASONS) {
		const match = pattern.exec(sentence);
		if (match === null) continue;
		// pi's own texts inside a reason ("Cannot read the page: the page did not answer within 10 s"), in the same
		// language; any other text in it stays as it is.
		const values = match.slice(1).map((value) => localSentence(value)?.replace(/[.。]$/, "") ?? value);
		return key === "reasonOff" ? offReason(match[1] ?? "") : t(key, values);
	}
	return null;
}

/** Which Settings > Tools row turned `tool` off: wait_on_page follows Read page, list_tabs goes with every tool off. */
function offReason(tool: string): string {
	if (tool === "list_tabs") return t("reasonAllOff");
	return t("reasonOff", [toolLabel(tool === "wait_on_page" ? "read_page" : tool)]);
}

// The English texts of page.ts, page-tools.ts, page-agent.ts, and tab-groups.ts, without their final period; a ref is
// a letter and a number ("a16"). More specific patterns come first.
const REF = "(\\w+)";
const REASONS: readonly (readonly [RegExp, MessageKey])[] = [
	// pi's own checks, before a step runs.
	[/^(\w+) is turned off in pi's settings; do not call it$/, "reasonOff"],
	[
		/^Chrome does not allow pi to run scripts: ask the user to turn on Allow User Scripts on pi's details page$/,
		"reasonNoUserScripts",
	],
	[/^Skipped: an earlier step in this reply failed; observe the page and decide again$/, "reasonSkipped"],
	[
		/^Skipped: pi could not find this call's reply in the chat; observe the page and decide again$/,
		"reasonSkippedUnknown",
	],
	[/^The page tools were used (\d+) times in this answer; answer now$/, "reasonLimit"],
	[
		/^Cannot use this tab: the attached tab is missing, its native group could not be checked, or the target is outside its current group$/,
		"reasonScope",
	],
	[
		/^The user cancelled: Chrome does not let pi reach this tab\. Do not try again in this answer$/,
		"reasonSiteCancelled",
	],
	[/^The user denied this script, so nothing ran; do not try again in this answer$/, "reasonScriptDenied"],
	[/^The user denied acting on (.+) in this answer; do not try again in this answer$/, "reasonActDenied"],
	[/^The user has not approved this script; nothing ran$/, "reasonScriptNotApproved"],
	[
		/^The page changed while the user looked at the script, so nothing ran\. Check the page and decide again$/,
		"reasonScriptPageChanged",
	],
	[
		/^No readable page is attached to the user's latest message\. Ask the user to open the page and click the pi toolbar button, or select text and choose Ask pi$/,
		"reasonNoPage",
	],
	[
		/^pi can act only on a page attached at its top level; ask the user to click the pi button on the page$/,
		"reasonNotTop",
	],
	[/^Another chat is acting on this tab; try again when it is done$/, "reasonBusy"],
	[/^The tab shows (.+), which the page tools cannot use$/, "reasonUnusableTab"],
	// Reading, observing, and waiting.
	[/^Cannot reach the page$/, "reasonCannotReach"],
	[/^the page did not answer within (\d+) s$/, "reasonPageSlow"],
	[/^Cannot read the page: pi may not read the tab's page now$/, "reasonCannotReadNow"],
	[/^Cannot read the page: the page has no readable text$/, "reasonNoText"],
	[
		/^Cannot read the page: the tab did not answer within (\d+) s\. Ask the user to ask again when the page has loaded$/,
		"reasonReadSlow",
	],
	[/^Cannot read the page: (.+)$/, "reasonCannotRead"],
	[/^No readable text is selected$/, "reasonNoSelection"],
	[/^Cannot observe the page: (.+)$/, "reasonCannotObserve"],
	[/^The page went away while pi observed it; observe again$/, "reasonGoneObserving"],
	[/^The page's refs changed while pi observed it; observe again$/, "reasonRefsChanged"],
	[
		/^The page changed during the wait: the tab now shows (.+)\. Check the page and decide again$/,
		"reasonWaitChanged",
	],
	[/^The page has no readable text to wait for$/, "reasonNoTextToWait"],
	[/^The wait ended: pi could not check the page \((.+)\)\. Check the page and decide again$/, "reasonWaitUnchecked"],
	// Acting on an element.
	[new RegExp(`^${REF} is gone \\(the page changed\\): observe again$`), "reasonGone"],
	[new RegExp(`^${REF} is not drawn \\(hidden, collapsed, or empty\\): observe again$`), "reasonNotDrawn"],
	[new RegExp(`^${REF} is disabled$`), "reasonDisabled"],
	[new RegExp(`^The center of ${REF} is outside the window$`), "reasonOutside"],
	[new RegExp(`^The center of ${REF} is (.+); act on that ref instead$`), "reasonCenterOther"],
	[new RegExp(`^${REF} is covered by (.+)$`), "reasonCovered"],
	[new RegExp(`^${REF} is not a text field$`), "reasonNotTextField"],
	[new RegExp(`^${REF} changed when it got the focus: observe again$`), "reasonChangedOnFocus"],
	[new RegExp(`^${REF} moved to another form when it got the focus: observe again$`), "reasonMovedForm"],
	[new RegExp(`^${REF} is read-only$`), "reasonReadOnly"],
	[new RegExp(`^${REF} is inert$`), "reasonInert"],
	[new RegExp(`^${REF} is not in a form: type without submit, then click the form's button$`), "reasonNoForm"],
	[new RegExp(`^Typing into ${REF} failed$`), "reasonTypingFailed"],
	[new RegExp(`^The focus did not go to ${REF}$`), "reasonNoFocus"],
	[new RegExp(`^Focus went to (.+), not ${REF}$`), "reasonFocusElsewhere"],
	[/^The page has no element to press the key in$/, "reasonNoKeyTarget"],
	[new RegExp(`^${REF} is not a <select>: click it, then click the option$`), "reasonNotSelect"],
	[new RegExp(`^pi does not choose in (.+) \\(${REF}\\)$`), "reasonNoChoose"],
	[new RegExp(`^pi does not type into (.+) \\(${REF}\\)$`), "reasonNoType"],
	[new RegExp(`^${REF} has no option "(.+)"; its options: (.+)$`), "reasonNoOption"],
	[new RegExp(`^The option "(.+)" of ${REF} is disabled$`), "reasonOptionDisabled"],
	[/^Cannot find the element: (.+)$/, "reasonCannotFind"],
	[/^Cannot scroll the page: (.+)\. It may have scrolled$/, "reasonCannotScroll"],
	[/^The page went away while pi scrolled it; try again$/, "reasonGoneScrolling"],
	[/^navigate only goes to URLs on (.+), not (.+)$/, "reasonNavigateOrigin"],
	// Tabs.
	[/^The attached page's tab is never closed by pi$/, "reasonAttachedTab"],
	[/^Tab (\d+) was not opened by pi in this chat$/, "reasonNotOpened"],
	[/^Cannot close tab (\d+): (.+)$/, "reasonCannotClose"],
	// Screenshots.
	[/^The current model cannot see images(?:; use .+ instead)?$/, "reasonNoVision"],
	[/^The page is zoomed with a pinch; pi can only capture the whole view$/, "reasonPinch"],
	[
		/^The element is in a rotated, skewed, or mirrored part of the page; pi can only capture the whole view$/,
		"reasonTransformed",
	],
	[/^pi cannot measure where the page cuts this element off; pi can only capture the whole view$/, "reasonClipped"],
	[/^The element moved out of view; try again$/, "reasonMovedOut"],
	[/^The element moved during the capture; try again$/, "reasonMovedDuring"],
	[
		/^Chrome lets pi capture this tab only with access to all sites, or after the user opens pi on it while it shows this site\. Ask the user to allow pi on all sites in Settings > Advanced > Sites, or to click pi's toolbar button on this tab, then try again$/,
		"reasonCaptureAccess",
	],
	[/^Cannot capture the tab: (.+)$/, "reasonCannotCapture"],
	[
		/^The tab is not in front, so pi cannot capture it: Chrome captures only the tab shown in its window$/,
		"reasonNotInFront",
	],
	[/^The tab changed during the capture; try again$/, "reasonTabChangedCapture"],
	[/^Chrome allows only 2 captures a second, and refused this one; try again$/, "reasonCaptureQuota"],
	[/^Cannot encode the image within (\d+) s$/, "reasonEncodeTimeout"],
	[/^Cannot encode the image: (.+)$/, "reasonCannotEncode"],
	[/^The view is too detailed to send as an image$/, "reasonTooDetailed"],
];
