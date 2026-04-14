import { describe, expect, test } from "bun:test";
import { McpError } from "@modelcontextprotocol/sdk/types.js";
import { assertGadgetShape, inspectGadgetShape } from "./gadget-shape.ts";

describe("inspectGadgetShape", () => {
	test("accepts a concise single-paragraph gadget", () => {
		expect(
			inspectGadgetShape(
				"Be maximally concise. Omit preamble, summaries, and filler. Every sentence must carry information.",
			),
		).toBeNull();
	});

	test("allows up to two markdown headings", () => {
		expect(inspectGadgetShape("# Intro\n\nBody text\n\n## Notes\n\nmore")).toBeNull();
	});

	test("rejects content with many headings", () => {
		const content = "# A\n\n## B\n\n## C\n\n## D\n";
		const issue = inspectGadgetShape(content);
		expect(issue?.reason).toBe("too-many-headings");
	});

	test("allows a single fenced code block", () => {
		const content = "Example:\n\n```ts\nconst x = 1;\n```";
		expect(inspectGadgetShape(content)).toBeNull();
	});

	test("rejects content with multiple fenced code blocks", () => {
		const content = "```ts\na\n```\n\n```ts\nb\n```";
		const issue = inspectGadgetShape(content);
		expect(issue?.reason).toBe("too-many-code-fences");
	});
});

describe("assertGadgetShape", () => {
	test("throws an InvalidGadget McpError when shape is multi-purpose", () => {
		const content = "# A\n\n## B\n\n## C\n\n## D\n";
		expect(() => assertGadgetShape(content, {})).toThrow(McpError);
	});

	test("is a no-op when GADGET_DISABLE_SHAPE_CHECK=1", () => {
		const content = "# A\n\n## B\n\n## C\n\n## D\n";
		expect(() => assertGadgetShape(content, { GADGET_DISABLE_SHAPE_CHECK: "1" })).not.toThrow();
	});
});
