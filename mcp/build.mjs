// Builds the npm package: one Node ESM file, dist/cli.js, from src/. Node does not strip types of files under
// node_modules, so the published bin must be JavaScript; esbuild keeps src/cli.ts's #! line. Run from the repo root:
// node mcp/build.mjs.

import { copyFileSync, rmSync } from "node:fs";
import { build } from "esbuild";

const root = new URL("./", import.meta.url).pathname;
rmSync(`${root}dist`, { recursive: true, force: true });
await build({
	absWorkingDir: root,
	entryPoints: { cli: "src/cli.ts" },
	outdir: "dist",
	bundle: true,
	format: "esm",
	platform: "node",
	target: "node20",
	logLevel: "warning",
});
// npm takes the licence from the package folder.
copyFileSync(`${root}../LICENSE`, `${root}LICENSE`);
console.log("built mcp/dist/cli.js");
