// Settings > Advanced (Sites, Local agents, Data) and Settings > Shortcuts. Each control acts when it is used; the panel
// calls back in when the worker's state, the settings, or Chrome's permissions change.

import { t } from "../shared/i18n.ts";
import {
	type AgentsStatus,
	CHATGPT,
	PROVIDERS,
	type ProviderId,
	type Settings,
	type SettingsChange,
} from "../shared/protocol.ts";
import type { WorkerClient } from "./client.ts";
import { copyButton, element, icon, node, showResult } from "./dom.ts";
import { allowedSites, siteName } from "./format.ts";

/** What the sections take from the panel. */
export type AdvancedDeps = {
	client: Pick<WorkerClient, "request">;
	announce(text: string): void;
	/** `line`: the result line that shows Saved. */
	saveSettings(change: SettingsChange, line: HTMLElement): void;
	/** The settings the worker last sent; undefined before the first state. */
	settings(): Settings | undefined;
	/** Puts every Settings control back to the saved settings, after a change that was not saved. */
	resync(): void;
	/** All chats were deleted here. */
	chatsDeleted(): void;
};

export type AdvancedSection = {
	/** The Local agents switch and its network row, from the saved settings. */
	sync(settings: Settings): void;
	renderSites(): Promise<void>;
	renderAgents(status: AgentsStatus): void;
	renderShortcuts(): Promise<void>;
};

/** Wires the sections to their elements in panel.html. */
export function advancedSection(deps: AdvancedDeps): AdvancedSection {
	const ui = {
		agentsCommand: element("agents-command"),
		agentsNetworkRow: element("agents-network-row"),
		agentsResult: element("agents-result"),
		agentsStatus: element("agents-status"),
		allowAgentsNetwork: element<HTMLButtonElement>("allow-agents-network"),
		allowAllSites: element<HTMLButtonElement>("allow-all-sites"),
		cancelDelete: element<HTMLButtonElement>("cancel-delete"),
		confirmDelete: element<HTMLButtonElement>("confirm-delete"),
		copyAgentsCommand: element<HTMLButtonElement>("copy-agents-command"),
		deleteChats: element<HTMLButtonElement>("delete-chats"),
		deleteConfirm: element("delete-confirm"),
		deleteResult: element("delete-result"),
		editShortcuts: element<HTMLButtonElement>("edit-shortcuts"),
		shortcuts: element("shortcuts"),
		sites: element("sites"),
		sitesHeld: element("sites-held"),
		sitesProviders: element("sites-providers"),
		sitesResult: element("sites-result"),
	};

	// Settings > Advanced > Sites: the sites pi reads without a click (design 6.22), each with Remove.

	async function renderSites(): Promise<void> {
		const { origins = [] } = await chrome.permissions.getAll();
		ui.allowAllSites.hidden = origins.includes("<all_urls>");
		const kept = [
			...(Object.keys(PROVIDERS) as ProviderId[]).map((provider) => PROVIDERS[provider].origin),
			CHATGPT.auth,
			CHATGPT.loopback,
		];
		const sites = allowedSites(origins, kept);
		ui.sites.replaceChildren(...(sites.length === 0 ? [node("li", "muted", t("none"))] : sites.map(siteRow)));
		// Access pi holds for a provider or the ChatGPT sign-in lets it read those sites' pages too (design 6.22).
		const held = kept.filter((origin) => origins.includes(origin)).map(siteName);
		ui.sitesProviders.hidden = held.length === 0;
		ui.sitesHeld.replaceChildren(...held.map((name) => node("li", "", node("span", "", name))));
	}

	function siteRow(pattern: string): HTMLElement {
		const name = siteName(pattern);
		const remove = node("button", "small-button", t("remove"));
		remove.setAttribute("aria-label", t("removeSiteAria", [name]));
		remove.title = t("removeSiteTip");
		remove.addEventListener("click", () => {
			chrome.permissions.remove({ origins: [pattern] }).then(
				(removed) =>
					showResult(ui.sitesResult, removed ? t("removedSite", [name]) : t("chromeKeptSite", [name]), removed),
				(error: unknown) =>
					showResult(ui.sitesResult, error instanceof Error ? error.message : String(error), false),
			);
		});
		return node("li", "", node("span", "", name), remove);
	}

	ui.allowAllSites.addEventListener("click", () => {
		// Inside the click: Chrome asks only during a user gesture.
		chrome.permissions.request({ origins: ["<all_urls>"] }).then(
			(granted) => showResult(ui.sitesResult, granted ? t("allSitesAllowed") : t("chromeDenied"), granted),
			(error: Error) => showResult(ui.sitesResult, error.message, false),
		);
	});

	// Settings > Advanced > Local agents (design 6.45): the switch is the consent, so turning it on asks Chrome for native
	// messaging and all sites in the same click; turning it off ends the sessions and gives native messaging back.

	const agentRadios = [...document.querySelectorAll<HTMLInputElement>('input[name="local-agents"]')];

	for (const radio of agentRadios) {
		radio.addEventListener("change", () => {
			if (radio.value === "off") {
				deps.saveSettings({ localAgents: false }, ui.agentsResult);
				void chrome.permissions.remove({ permissions: ["nativeMessaging"] }).catch(() => {});
				return;
			}
			// Inside the click: Chrome asks only during a user gesture. webRequest is for the agents' read_network_requests
			// (design 6.46).
			chrome.permissions.request({ permissions: ["nativeMessaging", "webRequest"], origins: ["<all_urls>"] }).then(
				(granted) => {
					if (granted) {
						deps.saveSettings({ localAgents: true }, ui.agentsResult);
						syncAgentsNetwork();
					} else {
						showResult(ui.agentsResult, t("chromeDenied"), false);
						deps.resync();
					}
				},
				(error: Error) => {
					showResult(ui.agentsResult, error.message, false);
					deps.resync();
				},
			);
		});
	}

	/**
	 * Local agents turned on before webRequest was asked with the switch (0.4.3): an Allow gives their
	 * read_network_requests Chrome's permission, while Console and network is on (design 6.46).
	 */
	function syncAgentsNetwork(): void {
		const settings = deps.settings();
		const wanted = settings?.localAgents === true && settings.tools.diagnostics === "on";
		if (!wanted) {
			ui.agentsNetworkRow.hidden = true;
			return;
		}
		void chrome.permissions.contains({ permissions: ["webRequest"] }).then((granted) => {
			ui.agentsNetworkRow.hidden = granted;
		});
	}
	window.addEventListener("focus", syncAgentsNetwork);
	ui.allowAgentsNetwork.addEventListener("click", () => {
		// Inside the click: Chrome asks only during a user gesture.
		chrome.permissions.request({ permissions: ["webRequest"] }).then(
			(granted) => {
				if (!granted) showResult(ui.agentsResult, t("chromeDenied"), false);
				syncAgentsNetwork();
			},
			(error: Error) => showResult(ui.agentsResult, error.message, false),
		);
	});

	ui.copyAgentsCommand.append(icon("copy"));
	copyButton(ui.copyAgentsCommand, () => ui.agentsCommand.textContent ?? "", t("copyCommand"));

	function renderAgents({ state: bridge, error, agents }: AgentsStatus): void {
		ui.agentsStatus.hidden = bridge === "off";
		ui.agentsStatus.textContent =
			bridge === "connected"
				? agents.length === 0
					? t("agentsNone")
					: t("agentsConnected", [agents.join(", ")])
				: bridge === "permission"
					? t("agentsPermission")
					: bridge === "starting"
						? t("agentsStarting")
						: bridge === "missing"
							? // Chrome's own words when the host was found but stopped at start, as on a broken ~/.pagewing.
								error === null || error.includes("not found")
								? t("agentsMissing")
								: `${t("agentsMissing")} (${error})`
							: t("agentsError", [error ?? ""]);
	}

	// Settings > Shortcuts.

	/** The bindings Chrome actually assigned: a suggested key that conflicts with another extension stays unset. */
	async function renderShortcuts(): Promise<void> {
		const commands = await chrome.commands.getAll();
		ui.shortcuts.replaceChildren(
			...commands
				.filter((command) => command.name !== "_execute_action")
				.map((command) =>
					node(
						"li",
						"",
						node("span", "", command.description ?? command.name ?? ""),
						command.shortcut ? node("kbd", "key", command.shortcut) : node("span", "key muted", t("notSet")),
					),
				),
		);
	}

	// `chrome://` pages open only through the tabs API, not as links.
	ui.editShortcuts.addEventListener("click", () => void chrome.tabs.create({ url: "chrome://extensions/shortcuts" }));
	// Settings > Advanced > Data: Delete all chats, after a confirmation in place (design 6.31).
	function closeDeleteConfirm(focus: HTMLElement | undefined): void {
		ui.deleteConfirm.hidden = true;
		ui.deleteChats.hidden = false;
		focus?.focus();
	}
	ui.deleteChats.addEventListener("click", () => {
		ui.deleteConfirm.hidden = false;
		ui.deleteChats.hidden = true;
		showResult(ui.deleteResult, "", null);
		ui.cancelDelete.focus();
	});
	ui.cancelDelete.addEventListener("click", () => closeDeleteConfirm(ui.deleteChats));
	ui.deleteConfirm.addEventListener("keydown", (event) => {
		if (event.key !== "Escape" || event.isComposing) return;
		event.preventDefault();
		closeDeleteConfirm(ui.deleteChats);
	});
	ui.confirmDelete.addEventListener("click", () => {
		ui.confirmDelete.disabled = true;
		ui.cancelDelete.disabled = true;
		showResult(ui.deleteResult, t("deleting"), null);
		deps.client
			.request({ type: "delete-all-chats" })
			.then(
				() => {
					// A fresh database numbers chats from 1 again.
					deps.chatsDeleted();
					closeDeleteConfirm(ui.deleteChats);
					showResult(ui.deleteResult, t("allChatsDeleted"), true);
					deps.announce(t("allChatsDeleted"));
				},
				(error: Error) => showResult(ui.deleteResult, t("notDeleted", [error.message]), false),
			)
			.finally(() => {
				ui.confirmDelete.disabled = false;
				ui.cancelDelete.disabled = false;
			});
	});

	function sync(settings: Settings): void {
		for (const radio of agentRadios) radio.checked = (radio.value === "on") === settings.localAgents;
		syncAgentsNetwork();
	}

	return { sync, renderSites, renderAgents, renderShortcuts };
}
