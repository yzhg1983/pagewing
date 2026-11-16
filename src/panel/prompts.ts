// Settings > Prompts: one row per prompt, in menu order. Edit opens a form in the row; Add prompt adds a row with the
// form open until it is saved. The switch at the end of a row takes the prompt out of the pi menu and the slash
// commands, and puts it back, without deleting it. A save sends one prompt, and the worker applies it to the prompts as
// saved then, so two panels that edit at once do not undo each other's change.

import { t } from "../shared/i18n.ts";
import { effectiveAnswerLanguage } from "../shared/language.ts";
import {
	ANSWER,
	MAX_PRESET_NAME,
	MAX_PRESETS,
	MAX_TEMPLATE_CHARS,
	PRESET_VARIABLES,
	PRESETS,
	type Preset,
	type PresetVariable,
	presetDisplayName,
	presetError,
	presetOn,
	unknownVariables,
} from "../shared/presets.ts";
import type { Settings, SettingsChange, SettingsSaved } from "../shared/protocol.ts";
import type { WorkerClient } from "./client.ts";
import { element, icon, node, showResult, syncChildren } from "./dom.ts";

type PromptRow = {
	node: HTMLElement;
	editing(): boolean;
	update(preset: Preset | undefined, settings: Settings): void;
	open(): void;
	close(): void;
};

/** What the section takes from the panel: the worker, the announcer, and the save its star shares with the other settings. */
export type PromptsDeps = {
	client: Pick<WorkerClient, "request">;
	announce(text: string): void;
	/** `line`: the result line that shows Saved. */
	saveSettings(change: SettingsChange, line: HTMLElement): void;
	/** The settings the worker last sent; undefined before the first state. */
	settings(): Settings | undefined;
};

/** Wires Settings > Prompts to its elements in panel.html. `render` shows the prompts of the worker's settings. */
export function promptsSection(deps: PromptsDeps): { render(settings: Settings): void } {
	const ui = {
		promptsSaved: element("prompts-saved"),
		prompts: element("prompts"),
		promptsActions: element("prompts-actions"),
		addPrompt: element<HTMLButtonElement>("add-prompt"),
		resetPrompts: element<HTMLButtonElement>("reset-prompts"),
		resetConfirm: element("reset-confirm"),
		confirmReset: element<HTMLButtonElement>("confirm-reset"),
		cancelReset: element<HTMLButtonElement>("cancel-reset"),
		promptsResult: element("prompts-result"),
	};

	const VARIABLE_HELP: Record<PresetVariable, string> = {
		selection: t("variableSelection"),
		title: t("variableTitle"),
		url: t("variableUrl"),
		language: t("variableLanguage"),
	};
	/** A new prompt: the instruction goes above the selection, where the cursor waits; the answer's language after it. */
	const NEW_TEMPLATE = `\n\n{{selection}}${ANSWER}`;
	const promptRows = new Map<string, PromptRow>();
	/** Numbers the forms: their labels need field IDs. */
	let promptForms = 0;
	let promptsTimer: ReturnType<typeof setTimeout> | undefined;
	/** A move button whose row moved: focus goes back to it, or to its row's other one at an end of the list. */
	let promptFocus: HTMLButtonElement | undefined;

	function renderPrompts(settings: Settings): void {
		const rows: PromptRow[] = [];
		for (const preset of settings.prompts) {
			let row = promptRows.get(preset.id);
			if (row === undefined) {
				row = promptRow(preset.id, false);
				promptRows.set(preset.id, row);
			}
			row.update(preset, settings);
			rows.push(row);
		}
		// An open form whose prompt is not saved (a new one, or one another panel deleted) stays: Save adds it.
		for (const [id, row] of promptRows) {
			if (settings.prompts.some((preset) => preset.id === id)) continue;
			if (row.editing()) {
				row.update(undefined, settings);
				rows.push(row);
			} else {
				promptRows.delete(id);
			}
		}
		syncChildren(
			ui.prompts,
			rows.map((row) => row.node),
		);
		syncAddPrompt();
		ui.resetPrompts.hidden = JSON.stringify(settings.prompts) === JSON.stringify(PRESETS);
		const moved = promptFocus;
		if (moved !== undefined && document.activeElement !== moved) {
			promptFocus = undefined;
			// Only focus the move dropped: the user may have gone on elsewhere.
			const lost = document.activeElement === null || document.activeElement === document.body;
			const other = moved.parentElement?.querySelectorAll<HTMLButtonElement>(".icon-button:not(.star)");
			const target = moved.disabled ? [...(other ?? [])].find((button) => !button.disabled) : moved;
			if (lost) target?.focus();
		}
	}

	/** The rows shown count, saved or not; a row the panel removes counts no more before the worker's prompts arrive. */
	function syncAddPrompt(): void {
		const full = ui.prompts.children.length >= MAX_PRESETS;
		ui.addPrompt.disabled = full;
		ui.addPrompt.title = full ? t("promptLimit", [MAX_PRESETS]) : "";
	}

	function promptsSaved(text: string, { menuError }: SettingsSaved): void {
		clearTimeout(promptsTimer);
		if (menuError !== null) {
			showResult(ui.promptsSaved, "", null);
			showResult(ui.promptsResult, t("promptMenuFailed", [text, menuError]), false);
			return;
		}
		showResult(ui.promptsResult, "", null);
		showResult(ui.promptsSaved, t("saved"), true);
		deps.announce(text);
		promptsTimer = setTimeout(() => showResult(ui.promptsSaved, "", null), 1500);
	}

	/** `fresh`: a prompt that is not saved yet, with its form open. */
	function promptRow(id: string, fresh: boolean): PromptRow {
		/** As the worker last sent it. */
		let preset: Preset | undefined;
		/** As saved, until the worker sends the prompts again: they follow the reply. */
		let saved: Preset | undefined;
		let settings: Settings | undefined;
		/** Counts the worker's updates, so a reply knows whether a newer one arrived before it. */
		let updates = 0;
		let mode: "idle" | "edit" | "confirm" = fresh ? "edit" : "idle";
		/** A save or delete is waiting for the worker: the form cannot change, so nothing typed meanwhile is lost. */
		let busy = false;
		/** A switch is waiting for the worker; the switch keeps focus, so it ignores clicks rather than being disabled. */
		let switching = false;
		const form = ++promptForms;

		const star = node("button", "icon-button small star", icon("star"));
		const name = node("span", "name");
		const up = node("button", "icon-button small", icon("up"));
		const down = node("button", "icon-button small", icon("down"));
		const edit = node("button", "small-button edit", t("edit"));
		const toggle = node("button", "switch");
		toggle.setAttribute("role", "switch");
		const shown = node("div", "prompt-head", star, name, up, down, edit, toggle);

		const nameInput = node("input", "");
		nameInput.id = `prompt-name-${form}`;
		nameInput.type = "text";
		nameInput.autocomplete = "off";
		nameInput.maxLength = MAX_PRESET_NAME;
		const nameLabel = node("label", "", t("name"));
		nameLabel.htmlFor = nameInput.id;
		const textInput = node("textarea", "");
		textInput.id = `prompt-text-${form}`;
		textInput.rows = 6;
		textInput.dir = "auto";
		textInput.maxLength = MAX_TEMPLATE_CHARS;
		const textLabel = node("label", "", t("prompt"));
		textLabel.htmlFor = textInput.id;
		const result = node("p", "result");
		result.setAttribute("role", "status");
		const save = node("button", "primary small-button", t("save"));
		const cancel = node("button", "small-button", t("cancel"));
		const remove = node("button", "small-button danger", t("delete"));
		const variables = PRESET_VARIABLES.map(variableButton);
		const editor = node(
			"div",
			"",
			node("div", "field", nameLabel, nameInput),
			node("div", "field", textLabel, textInput),
			node("div", "variables", node("span", "", t("insert")), ...variables),
			result,
			node("div", "row", save, cancel, node("span", "grow"), remove),
		);

		const question = node("p", "");
		const confirmDelete = node("button", "small-button danger", t("delete"));
		const cancelDelete = node("button", "small-button", t("cancel"));
		const confirm = node("div", "confirm", question, node("div", "row", confirmDelete, cancelDelete));
		const row = node("li", "", shown, editor, confirm);

		const current = () => saved ?? preset;
		const label = () => {
			const value = current();
			return value === undefined || settings === undefined
				? t("newPrompt")
				: presetDisplayName(value, effectiveAnswerLanguage(settings.language));
		};
		const changed = () =>
			nameInput.value !== (current()?.name ?? "") || textInput.value !== (current()?.template ?? NEW_TEMPLATE);

		/** Inserts `{{variable}}` at the cursor; the textarea keeps its selection while the button has focus. */
		function variableButton(variable: PresetVariable): HTMLButtonElement {
			const token = `{{${variable}}}`;
			const button = node("button", "", token);
			button.type = "button";
			button.title = VARIABLE_HELP[variable];
			button.setAttribute("aria-label", t("insertVariable", [token, VARIABLE_HELP[variable]]));
			button.addEventListener("click", () => {
				textInput.setRangeText(token, textInput.selectionStart, textInput.selectionEnd, "end");
				textInput.focus();
				check();
			});
			return button;
		}

		/** A placeholder that is not a variable is sent as written: likely a typo, so it is pointed out. */
		function check(): void {
			const unknown = unknownVariables(textInput.value).map((variable) => `{{${variable}}}`);
			showResult(result, unknown.length === 0 ? "" : t("unknownVariable", [unknown.join(", ")]), null);
		}

		function update(next: Preset | undefined, latest: Settings): void {
			preset = next;
			settings = latest;
			saved = undefined;
			updates += 1;
			render();
		}

		function render(): void {
			const value = current();
			name.textContent = label();
			const prompts = settings?.prompts ?? [];
			const index = prompts.findIndex((other) => other.id === id);
			const isDefault = value !== undefined && settings?.defaultPreset === id;
			const on = value === undefined || presetOn(value);
			row.classList.toggle("off", !on);
			star.setAttribute("aria-pressed", String(isDefault));
			star.setAttribute("aria-label", isDefault ? t("defaultPromptAria", [label()]) : t("usePromptAria", [label()]));
			star.title = !on ? t("promptOffStarTip") : isDefault ? t("defaultPromptTip") : t("usePromptTip");
			star.disabled = index < 0 || !on;
			// The default stays on: Ask pi uses it.
			toggle.setAttribute("aria-checked", String(on));
			toggle.setAttribute("aria-label", t("promptSwitchAria", [label()]));
			toggle.title = isDefault ? t("promptDefaultOn") : on ? t("promptOnTip") : t("promptOffTip");
			toggle.disabled = index < 0 || isDefault;
			up.disabled = index <= 0;
			down.disabled = index < 0 || index === prompts.length - 1;
			up.setAttribute("aria-label", t("movePromptUp", [label()]));
			down.setAttribute("aria-label", t("movePromptDown", [label()]));
			up.title = t("moveUpTip");
			down.title = t("moveDownTip");
			edit.setAttribute("aria-label", t("editPromptAria", [label()]));
			nameInput.readOnly = busy;
			textInput.readOnly = busy;
			for (const button of [save, cancel, ...variables, confirmDelete, cancelDelete]) button.disabled = busy;
			remove.hidden = value === undefined;
			remove.disabled = busy || !(settings?.prompts.some((other) => other.id !== id && presetOn(other)) ?? false);
			remove.title = !busy && remove.disabled ? t("promptKeepOne") : "";
			editor.setAttribute("aria-busy", String(busy));
			shown.hidden = mode !== "idle";
			editor.hidden = mode !== "edit";
			confirm.hidden = mode !== "confirm";
		}

		function setMode(next: typeof mode, focus: HTMLElement | undefined): void {
			mode = next;
			render();
			focus?.focus();
		}

		function open(): void {
			const value = current();
			// Edit the stored name, never the localized display name.
			nameInput.value = value?.name ?? "";
			textInput.value = value?.template ?? NEW_TEMPLATE;
			if (value === undefined) textInput.setSelectionRange(0, 0);
			setMode("edit", nameInput);
			check();
		}

		function close(focus: boolean): void {
			if (current() !== undefined) {
				setMode("idle", focus ? edit : undefined);
				return;
			}
			// Never saved, or deleted: the row goes.
			mode = "idle";
			promptRows.delete(id);
			row.remove();
			syncAddPrompt();
			if (focus) ui.addPrompt.focus();
		}

		function saveRow(): void {
			if (settings === undefined || busy) return;
			const next = { id, name: nameInput.value.trim(), template: textInput.value };
			const error = presetError(next, settings.prompts);
			if (error !== undefined) {
				showResult(result, error.text, false);
				(error.field === "name" ? nameInput : textInput).focus();
				return;
			}
			const { language } = settings;
			const seen = updates;
			const focused = document.activeElement instanceof HTMLElement ? document.activeElement : save;
			busy = true;
			render();
			deps.client.request<SettingsSaved>({ type: "save-prompt", prompt: next }).then(
				(reply) => {
					busy = false;
					// Shown until the worker's prompts arrive. Prompts that came first are newer: another panel's save shows,
					// and after another panel's delete the row goes.
					if (updates === seen) saved = next;
					close(true);
					promptsSaved(t("savedPrompt", [presetDisplayName(next, effectiveAnswerLanguage(language))]), reply);
				},
				(error: Error) => {
					busy = false;
					setMode("edit", focused);
					showResult(result, t("notSaved", [error.message]), false);
				},
			);
		}

		edit.addEventListener("click", open);
		toggle.addEventListener("click", () => {
			const value = current();
			if (value === undefined || switching) return;
			const on = !presetOn(value);
			const switched = label();
			const seen = updates;
			switching = true;
			deps.client.request<SettingsSaved>({ type: "switch-prompt", promptId: id, on }).then(
				(reply) => {
					switching = false;
					// Shown until the worker's prompts arrive, as after a save.
					if (updates === seen) {
						saved = { id, name: value.name, template: value.template, ...(on ? {} : { off: true as const }) };
						render();
					}
					promptsSaved(t(on ? "promptTurnedOn" : "promptTurnedOff", [switched]), reply);
				},
				(error: Error) => {
					switching = false;
					showResult(ui.promptsResult, t("notSwitched", [error.message]), false);
				},
			);
		});
		star.addEventListener("click", () => {
			if (settings?.defaultPreset !== id) deps.saveSettings({ defaultPreset: id }, ui.promptsSaved);
		});
		for (const [button, by] of [
			[up, -1],
			[down, 1],
		] as const) {
			button.addEventListener("click", () => {
				const moved = label();
				// The row moves in the list, which takes focus from its button: the next render gives it back.
				promptFocus = button;
				deps.client.request<SettingsSaved>({ type: "move-prompt", promptId: id, by }).then(
					(reply) => promptsSaved(t(by < 0 ? "movedPromptUp" : "movedPromptDown", [moved]), reply),
					(error: Error) => {
						promptFocus = undefined;
						showResult(ui.promptsResult, t("notMoved", [error.message]), false);
					},
				);
			});
		}
		save.addEventListener("click", saveRow);
		cancel.addEventListener("click", () => close(true));
		nameInput.addEventListener("input", check);
		textInput.addEventListener("input", check);
		nameInput.addEventListener("keydown", (event) => {
			if (event.key !== "Enter" || event.isComposing) return;
			event.preventDefault();
			saveRow();
		});
		remove.addEventListener("click", () => {
			if (settings === undefined || busy) return;
			const { language, prompts, defaultPreset } = settings;
			const heir = defaultPreset === id ? prompts.find((other) => other.id !== id && presetOn(other)) : undefined;
			question.replaceChildren(t("deletePromptQuestion", [label()]));
			if (heir !== undefined)
				question.append(
					node("span", "", t("newDefaultPrompt", [presetDisplayName(heir, effectiveAnswerLanguage(language))])),
				);
			setMode("confirm", cancelDelete);
		});
		cancelDelete.addEventListener("click", () => setMode("edit", remove));
		confirmDelete.addEventListener("click", () => {
			if (busy) return;
			const deleted = label();
			const seen = updates;
			busy = true;
			render();
			deps.client.request<SettingsSaved>({ type: "delete-prompt", promptId: id }).then(
				(reply) => {
					// Focus goes to the next prompt's Edit, as in a list after a deletion.
					const neighbor = [row.nextElementSibling, row.previousElementSibling]
						.map((sibling) => sibling?.querySelector<HTMLButtonElement>(".prompt-head > .edit"))
						.find((button) => button != null && button.closest("[hidden]") === null);
					busy = false;
					// Gone until the worker's prompts arrive. Prompts that came first are newer: after another panel saved
					// this prompt again, it stays.
					if (updates === seen) {
						preset = undefined;
						saved = undefined;
					}
					const kept = current() !== undefined;
					close(false);
					(kept ? edit : (neighbor ?? ui.addPrompt)).focus();
					promptsSaved(t("deletedPrompt", [deleted]), reply);
				},
				(error: Error) => {
					busy = false;
					setMode("edit", remove);
					showResult(result, t("notDeleted", [error.message]), false);
				},
			);
		});
		// Esc closes the confirmation or an unchanged form before it would leave Settings; changes are not dropped by it.
		row.addEventListener("keydown", (event) => {
			if (event.key !== "Escape" || event.isComposing || mode === "idle") return;
			event.preventDefault();
			if (busy) return;
			if (mode === "confirm") setMode("edit", remove);
			else if (changed()) showResult(result, t("saveOrCancel"), false);
			else close(true);
		});

		return { node: row, editing: () => mode !== "idle", update, open, close: () => close(false) };
	}

	ui.addPrompt.addEventListener("click", () => {
		const settings = deps.settings();
		if (settings === undefined) return;
		const id = crypto.randomUUID();
		const row = promptRow(id, true);
		promptRows.set(id, row);
		renderPrompts(settings);
		row.open();
	});

	function closeReset(focus: HTMLElement | undefined): void {
		ui.resetConfirm.hidden = true;
		ui.promptsActions.hidden = false;
		focus?.focus();
	}

	ui.resetPrompts.addEventListener("click", () => {
		ui.resetConfirm.hidden = false;
		ui.promptsActions.hidden = true;
		showResult(ui.promptsResult, "", null);
		ui.cancelReset.focus();
	});
	ui.cancelReset.addEventListener("click", () => closeReset(ui.resetPrompts));
	ui.confirmReset.addEventListener("click", () => {
		ui.confirmReset.disabled = true;
		deps.client
			.request<SettingsSaved>({ type: "reset-prompts" })
			.then(
				(reply) => {
					for (const row of promptRows.values()) row.close();
					closeReset(ui.addPrompt);
					promptsSaved(t("promptsRestored"), reply);
				},
				(error: Error) => showResult(ui.promptsResult, t("notReset", [error.message]), false),
			)
			.finally(() => {
				ui.confirmReset.disabled = false;
			});
	});
	ui.resetConfirm.addEventListener("keydown", (event) => {
		if (event.key !== "Escape" || event.isComposing) return;
		event.preventDefault();
		closeReset(ui.resetPrompts);
	});

	return { render: renderPrompts };
}
