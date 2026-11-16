import { defineConfig } from "vitest/config";

// Coverage is a report (npm run coverage), not a gate. `include` lists every source file, so a file no test imports
// shows as 0% instead of being left out. The browser suites (test/e2e) run in Chrome and are not counted here.
export default defineConfig({
	test: {
		coverage: {
			provider: "v8",
			include: ["src/**/*.ts", "mcp/src/**/*.ts"],
			reporter: ["text", "html"],
			reportsDirectory: "coverage",
		},
	},
});
