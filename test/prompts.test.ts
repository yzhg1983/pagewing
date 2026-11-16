// @vitest-environment happy-dom
// Settings > Prompts (prompts.ts) against panel.html's own markup, with a worker that records what it is asked.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeEach, expect, it } from "vitest";
import { promptsSection } from "../src/panel/prompts.ts";
import { PRESETS, type Preset } from "../src/shared/presets.ts";
import type { Settings, SettingsChange, SettingsSaved } from "../src/shared/protocol.ts";

// happy-dom gives import.meta.url an http address, so the page is found from the repo root, where vitest runs.
const html = readFileSync(resolve("static/panel.html"), "utf8");
const markup = /<body[^>]*>([\s\S]*)<\/body>/.exec(html)?.[1] ?? "";

type Command = { type: string; [key: string]: unknown };

function settingsOf(prompts: readonly Preset[], defaultPreset = prompts[0]!.id): Settings {
	return { prompts: [...prompts], defaultPreset, language: "English" } as Settings;
}

/** The section on a fresh page. `fail` makes the worker refuse every command with that message. */
function setup(initial: Settings, fail?: string) {
	document.body.innerHTML = markup.replace(/<script[\s\S]*?<\/script>/g, "");
	const commands: Command[] = [];
	const announced: string[] = [];
	const saved: SettingsChange[] = [];
	let settings: Settings | undefined = initial;
	const section = promptsSection({
		client: {
			request: <T>(command: Command) => {
				commands.push(command);
				return fail === undefined
					? Promise.resolve({ menuError: null } satisfies SettingsSaved as T)
					: Promise.reject(new Error(fail));
			},
		} as Parameters<typeof promptsSection>[0]["client"],
		announce: (text) => announced.push(text),
		saveSettings: (change) => saved.push(change),
		settings: () => settings,
	});
	const render = (next: Settings) => {
		settings = next;
		section.render(next);
	};
	render(initial);
	return { commands, announced, saved, render };
}

const $ = <T extends HTMLElement = HTMLElement>(selector: string) => {
	const found = document.querySelector<T>(selector);
	if (found === null) throw new Error(`missing ${selector}`);
	return found;
};
const rows = () => [...document.querySelectorAll<HTMLElement>("#prompts > li")];
const names = () => rows().map((row) => row.querySelector(".name")?.textContent);
/** Lets the worker's reply arrive. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
	document.body.innerHTML = "";
});

it("lists the prompts in order, stars the default, and hides Reset while they are the built-in ones", () => {
	setup(settingsOf(PRESETS, "summarize"));
	expect(names()).toEqual(["Explain", "Summarize", "Translate to English", ...names().slice(3)]);
	expect(rows()).toHaveLength(PRESETS.length);
	expect(rows().map((row) => row.querySelector(".star")?.getAttribute("aria-pressed"))).toEqual(
		PRESETS.map((preset) => String(preset.id === "summarize")),
	);
	expect($("#reset-prompts").hidden).toBe(true);
	// The default stays on, so its switch is disabled; the first row cannot move up.
	expect(rows()[1]?.querySelector<HTMLButtonElement>(".switch")?.disabled).toBe(true);
	expect(rows()[0]?.querySelectorAll<HTMLButtonElement>(".icon-button:not(.star)")[0]?.disabled).toBe(true);
});

it("shows Reset once the prompts differ from the built-in ones", () => {
	setup(settingsOf(PRESETS.slice(0, 2)));
	expect($("#reset-prompts").hidden).toBe(false);
});

it("Add prompt opens a form, refuses an empty name without asking the worker, then saves", async () => {
	const { commands, announced } = setup(settingsOf(PRESETS));
	$("#add-prompt").click();
	const row = rows().at(-1)!;
	expect(rows()).toHaveLength(PRESETS.length + 1);
	const name = row.querySelector<HTMLInputElement>('input[type="text"]')!;
	const text = row.querySelector("textarea")!;
	const save = row.querySelector<HTMLButtonElement>("button.primary")!;
	expect(text.value).toContain("{{selection}}");

	save.click();
	expect(commands).toEqual([]);
	expect(row.querySelector(".result")?.className).toBe("result bad");

	name.value = "  Shorten  ";
	save.click();
	expect(commands).toHaveLength(1);
	expect(commands[0]).toMatchObject({ type: "save-prompt", prompt: { name: "Shorten", template: text.value } });
	await settle();
	// Shown as saved until the worker's prompts arrive.
	expect(row.querySelector(".name")?.textContent).toBe("Shorten");
	expect(row.querySelector<HTMLElement>(".prompt-head")?.hidden).toBe(false);
	expect($("#prompts-saved").className).toBe("result ok");
	expect(announced).toHaveLength(1);
});

it("a save the worker refuses keeps the form open with the reason", async () => {
	const { commands } = setup(settingsOf(PRESETS), "storage is full");
	$("#add-prompt").click();
	const row = rows().at(-1)!;
	row.querySelector<HTMLInputElement>('input[type="text"]')!.value = "Shorten";
	row.querySelector<HTMLButtonElement>("button.primary")!.click();
	await settle();
	expect(commands).toHaveLength(1);
	expect(row.querySelector<HTMLElement>(".prompt-head")?.hidden).toBe(true);
	expect(row.querySelector(".result")?.textContent).toContain("storage is full");
});

it("a duplicate name is refused", () => {
	const { commands } = setup(settingsOf(PRESETS));
	$("#add-prompt").click();
	const row = rows().at(-1)!;
	row.querySelector<HTMLInputElement>('input[type="text"]')!.value = "explain";
	row.querySelector<HTMLButtonElement>("button.primary")!.click();
	expect(commands).toEqual([]);
	expect(row.querySelector(".result")?.className).toBe("result bad");
});

it("an unsaved form whose prompt the worker does not have stays through a render; a closed one goes", () => {
	const { render } = setup(settingsOf(PRESETS));
	$("#add-prompt").click();
	render(settingsOf(PRESETS));
	expect(rows()).toHaveLength(PRESETS.length + 1);
	// Cancel is the form's second button.
	rows().at(-1)!.querySelectorAll<HTMLButtonElement>(".row > button")[1]!.click();
	expect(rows()).toHaveLength(PRESETS.length);
});

it("the switch turns a prompt off through the worker and shows it off before the prompts arrive", async () => {
	const { commands } = setup(settingsOf(PRESETS));
	const row = rows()[1]!;
	const toggle = row.querySelector<HTMLButtonElement>(".switch")!;
	expect(toggle.getAttribute("aria-checked")).toBe("true");
	toggle.click();
	expect(commands).toEqual([{ type: "switch-prompt", promptId: "summarize", on: false }]);
	await settle();
	expect(toggle.getAttribute("aria-checked")).toBe("false");
	expect(row.classList.contains("off")).toBe(true);
});

it("the star saves the default prompt with the other settings; the default's own star does nothing", () => {
	const { saved, commands } = setup(settingsOf(PRESETS));
	rows()[0]!.querySelector<HTMLButtonElement>(".star")!.click();
	expect(saved).toEqual([]);
	rows()[1]!.querySelector<HTMLButtonElement>(".star")!.click();
	expect(saved).toEqual([{ defaultPreset: "summarize" }]);
	expect(commands).toEqual([]);
});

it("the move buttons ask the worker to move the prompt by one", () => {
	const { commands } = setup(settingsOf(PRESETS));
	const [up, down] = rows()[1]!.querySelectorAll<HTMLButtonElement>(".icon-button:not(.star)");
	down!.click();
	up!.click();
	expect(commands).toEqual([
		{ type: "move-prompt", promptId: "summarize", by: 1 },
		{ type: "move-prompt", promptId: "summarize", by: -1 },
	]);
});

it("Delete asks first, names the next default, and removes the row when the worker agrees", async () => {
	const { commands } = setup(settingsOf(PRESETS));
	const row = rows()[0]!;
	row.querySelector<HTMLButtonElement>(".edit")!.click();
	row.querySelector<HTMLButtonElement>(".row > button.danger")!.click();
	const confirm = row.querySelector<HTMLElement>(".confirm")!;
	expect(confirm.hidden).toBe(false);
	expect(commands).toEqual([]);
	// The deleted prompt was the default: the question says which prompt takes over.
	expect(confirm.querySelector("p")?.textContent).toContain("Summarize");
	confirm.querySelector<HTMLButtonElement>("button.danger")!.click();
	expect(commands).toEqual([{ type: "delete-prompt", promptId: "explain" }]);
	await settle();
	expect(names()).not.toContain("Explain");
	expect(rows()).toHaveLength(PRESETS.length - 1);
});

it("Reset asks first, then asks the worker", async () => {
	const { commands } = setup(settingsOf(PRESETS.slice(0, 2)));
	$("#reset-prompts").click();
	expect($("#reset-confirm").hidden).toBe(false);
	expect($("#prompts-actions").hidden).toBe(true);
	$("#cancel-reset").click();
	expect($("#reset-confirm").hidden).toBe(true);
	expect(commands).toEqual([]);
	$("#reset-prompts").click();
	$("#confirm-reset").click();
	expect(commands).toEqual([{ type: "reset-prompts" }]);
	await settle();
	expect($("#reset-confirm").hidden).toBe(true);
});
