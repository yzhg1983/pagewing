// Small DOM helpers for the side panel. Text always goes in as text nodes.

import { t } from "../shared/i18n.ts";

export function element<T extends HTMLElement>(id: string): T {
	const found = document.getElementById(id);
	if (found === null) throw new Error(`missing #${id}`);
	return found as T;
}

const SVG = "http://www.w3.org/2000/svg";

export function icon(name: string): SVGSVGElement {
	const svg = document.createElementNS(SVG, "svg");
	svg.setAttribute("class", "icon");
	svg.setAttribute("aria-hidden", "true");
	const use = document.createElementNS(SVG, "use");
	use.setAttribute("href", `#i-${name}`);
	svg.append(use);
	return svg;
}

export function node<K extends keyof HTMLElementTagNameMap>(
	tag: K,
	className: string,
	...children: (Node | string)[]
): HTMLElementTagNameMap[K] {
	const created = document.createElement(tag);
	if (className !== "") created.className = className;
	created.append(...children);
	return created;
}

/** A button that copies `text()`, and says for a moment whether it worked. */
export function copyButton(
	button: HTMLButtonElement,
	text: () => string,
	label: string,
	title = label,
): HTMLButtonElement {
	const show = (status: "idle" | "copied" | "failed") => {
		const result = status === "idle" ? label : t(status === "copied" ? "copied" : "copyFailed");
		button.title = status === "idle" ? title : result;
		button.setAttribute("aria-label", result);
		button.querySelector("use")?.setAttribute("href", status === "copied" ? "#i-check" : "#i-copy");
		const textNode = [...button.childNodes].find((child) => child.nodeType === Node.TEXT_NODE);
		if (textNode !== undefined) textNode.textContent = result;
	};
	button.addEventListener("click", () => {
		void navigator.clipboard.writeText(text()).then(
			() => show("copied"),
			() => show("failed"),
		);
		setTimeout(() => show("idle"), 1500);
	});
	show("idle");
	return button;
}

/** Puts `nodes` into `parent` in order. Nodes that stay are not moved, so a focused one keeps focus. */
export function syncChildren(parent: HTMLElement, nodes: readonly Node[]): void {
	const keep = new Set(nodes);
	for (const child of [...parent.childNodes]) if (!keep.has(child)) child.remove();
	for (const [index, child] of nodes.entries()) {
		const at = parent.childNodes[index];
		if (at !== child) parent.insertBefore(child, at ?? null);
	}
}

/** A result line: green when `ok`, red when not, muted when null. Unchanged text is not set again, so it is not re-announced. */
export function showResult(line: HTMLElement, text: string, ok: boolean | null): void {
	const className = ok === null ? "result" : ok ? "result ok" : "result bad";
	if (line.textContent === text && line.className === className) return;
	line.textContent = text;
	line.className = className;
}
