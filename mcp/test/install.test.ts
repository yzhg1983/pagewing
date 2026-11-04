// Setup: the host script and the manifest Chrome reads.

import { existsSync, mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HOST_NAME, STORE_ID } from "../src/bridge.ts";
import { install, uninstall } from "../src/install.ts";

let home = "";
const saved = process.env.HOME;
beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), "pi-aside-install-"));
	process.env.HOME = home;
});
afterEach(() => {
	process.env.HOME = saved;
});

describe("install", () => {
	it("registers the host for the store ID and the given IDs, in the given profile", () => {
		const profile = join(home, "profile");
		const [file] = install("/opt/pi-aside-mcp/cli.ts", ["abc"], [profile]);
		expect(file).toBe(join(profile, "NativeMessagingHosts", `${HOST_NAME}.json`));
		const manifest = JSON.parse(readFileSync(file!, "utf8"));
		expect(manifest).toEqual({
			name: HOST_NAME,
			description: "pi-aside local agents bridge",
			path: join(home, ".pi-aside", "host.sh"),
			type: "stdio",
			allowed_origins: [`chrome-extension://${STORE_ID}/`, "chrome-extension://abc/"],
		});
		const script = readFileSync(manifest.path, "utf8");
		expect(script).toContain(`'${process.execPath}' '/opt/pi-aside-mcp/cli.ts' host`);
		expect(statSync(manifest.path).mode & 0o777).toBe(0o700);
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
		expect(existsSync(join(home, ".pi-aside", "host.sh"))).toBe(false);
	});
});
