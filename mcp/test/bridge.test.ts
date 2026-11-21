// The bridge's address: the Windows pipe name of a home folder (design 6.49).

import { describe, expect, it } from "vitest";
import { pipeName } from "../src/bridge.ts";

describe("pipeName", () => {
	it("gives one name to every spelling of a home folder", () => {
		const name = pipeName("C:\\Users\\alex");
		expect(name).toMatch(/^\\\\\.\\pipe\\pagewing-[0-9a-f]{16}$/);
		for (const spelling of ["c:\\users\\alex", "C:\\Users\\Alex", "C:\\Users\\alex\\", "C:/Users/alex"])
			expect(pipeName(spelling)).toBe(name);
	});

	it("keeps accounts with the same user name apart", () => {
		expect(pipeName("C:\\Users\\alex.CONTOSO")).not.toBe(pipeName("C:\\Users\\alex"));
	});

	it("has no separator for a home folder with spaces and other scripts", () => {
		expect(pipeName("D:\\Users\\张三 Li")).toMatch(/^\\\\\.\\pipe\\pagewing-[0-9a-f]{16}$/);
	});
});
