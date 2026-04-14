import { expect, test } from "bun:test";
import { parseCli } from "./cli.ts";

test("parseCli defaults command to serve", () => {
	expect(parseCli([]).command).toBe("serve");
});

test("parseCli detects --stdio and --http", () => {
	const cli = parseCli(["--stdio", "--http"]);
	expect(cli.stdio).toBe(true);
	expect(cli.http).toBe(true);
});

test("parseCli parses backup subcommand with --out", () => {
	const cli = parseCli(["backup", "--out", "/tmp/b.db"]);
	expect(cli.command).toBe("backup");
	expect(cli.out).toBe("/tmp/b.db");
});

test("parseCli parses generate <format>", () => {
	const cli = parseCli(["generate", "claude-desktop", "--out=cfg.json"]);
	expect(cli.command).toBe("generate");
	expect(cli.format).toBe("claude-desktop");
	expect(cli.out).toBe("cfg.json");
});

test("parseCli parses audit tail N", () => {
	const cli = parseCli(["audit", "tail", "100"]);
	expect(cli.command).toBe("audit-tail");
	expect(cli.limit).toBe(100);
});

test("parseCli parses --workspace=foo", () => {
	expect(parseCli(["--workspace=foo"]).workspace).toBe("foo");
	expect(parseCli(["--workspace", "bar"]).workspace).toBe("bar");
});

test("parseCli --version and --help", () => {
	expect(parseCli(["--version"]).command).toBe("version");
	expect(parseCli(["--help"]).command).toBe("help");
});
