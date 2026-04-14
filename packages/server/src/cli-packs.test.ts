import { describe, expect, test } from "bun:test";
import { availableGadgetPacks, parseEnabledPacks } from "./cli.ts";

describe("parseEnabledPacks", () => {
	test("empty / undefined input returns no packs", () => {
		expect(parseEnabledPacks(undefined)).toEqual({ enabled: [], unknown: [] });
		expect(parseEnabledPacks("")).toEqual({ enabled: [], unknown: [] });
		expect(parseEnabledPacks("   ")).toEqual({ enabled: [], unknown: [] });
	});

	test("recognises known pack names and reports unknowns", () => {
		const res = parseEnabledPacks("tone-caveman, bogus, tone-caveman");
		expect(res.enabled).toEqual(["tone-caveman"]);
		expect(res.unknown).toEqual(["bogus"]);
	});

	test("availableGadgetPacks lists tone-caveman", () => {
		expect(availableGadgetPacks()).toContain("tone-caveman");
	});
});
