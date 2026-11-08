// Setup: the host script and the manifest Chrome reads.

import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HOST_NAME, STORE_ID } from "../src/bridge.ts";
import { install, uninstall } from "../src/install.ts";

let home = "";
const saved = process.env.HOME;
beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), "pagewing-install-"));
	process.env.HOME = home;
});
afterEach(() => {
	process.env.HOME = saved;
});

describe("install", () => {
	it("registers the host for the store ID and the given IDs, in the given profile", () => {
		const profile = join(home, "profile");
		const [file] = install("/opt/pagewing-mcp/cli.ts", ["abc"], [profile]);
		expect(file).toBe(join(profile, "NativeMessagingHosts", `${HOST_NAME}.json`));
		const manifest = JSON.parse(readFileSync(file!, "utf8"));
		expect(manifest).toEqual({
			name: HOST_NAME,
			description: "Pagewing local agents bridge",
			path: join(home, ".pagewing", "host.sh"),
			type: "stdio",
			allowed_origins: [`chrome-extension://${STORE_ID}/`, "chrome-extension://abc/"],
		});
		const script = readFileSync(manifest.path, "utf8");
		expect(script).toMatch(/^exec '[^']*node' '\/opt\/pagewing-mcp\/cli.ts' host "\$@"$/m);
		expect(statSync(manifest.path).mode & 0o777).toBe(0o700);
	});

	it("keeps the IDs an earlier setup allowed, and writes nothing when nothing changed", () => {
		const profile = join(home, "profile");
		const [file] = install("/old/cli.ts", ["unpacked"], [profile]);
		// The manifest stays as it was; the script names the new CLI.
		expect(install("/new/cli.ts", [], [profile])).toEqual([join(home, ".pagewing", "host.sh")]);
		const manifest = JSON.parse(readFileSync(file!, "utf8"));
		expect(manifest.allowed_origins).toEqual([`chrome-extension://${STORE_ID}/`, "chrome-extension://unpacked/"]);
		expect(readFileSync(manifest.path, "utf8")).toContain("/new/cli.ts");
		expect(install("/new/cli.ts", [], [profile])).toEqual([]);
	});

	it("by default registers in the installed browsers' folders only", () => {
		const chrome = join(home, "Library", "Application Support", "Google", "Chrome");
		if (process.platform !== "darwin") return;
		expect(install("/cli.ts", [])).toEqual([]);
		mkdirSync(chrome, { recursive: true });
		expect(install("/cli.ts", [])).toEqual([
			join(chrome, "NativeMessagingHosts", `${HOST_NAME}.json`),
			join(home, ".pagewing", "host.sh"),
		]);
	});

	it("quotes paths for the shell", () => {
		const [file] = install(`/a "b" $c 'd'/cli.ts`, [], [join(home, "profile")]);
		const { path } = JSON.parse(readFileSync(file!, "utf8"));
		expect(readFileSync(path, "utf8")).toContain(`'/a "b" $c '\\''d'\\''/cli.ts' host`);
	});

	it("uninstall removes the manifest and the script", () => {
		const profile = join(home, "profile");
		const [file] = install("/cli.ts", [], [profile]);
		expect(uninstall([profile])).toEqual([file]);
		expect(existsSync(file!)).toBe(false);
		expect(existsSync(join(home, ".pagewing", "host.sh"))).toBe(false);
	});
});
