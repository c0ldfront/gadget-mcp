import { describe, expect, test } from "bun:test";
import { detectBinary, parseCli, runHealthcheck } from "./cli.ts";

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

describe("detectBinary", () => {
	test("returns absolute path of a compiled binary", () => {
		expect(detectBinary("/opt/tools/gadget-mcp-bun-linux-x64")).toBe(
			"/opt/tools/gadget-mcp-bun-linux-x64",
		);
	});

	test("falls back to bare name when running under bun", () => {
		expect(detectBinary("/usr/bin/bun")).toBe("gadget-mcp");
		expect(detectBinary("bun")).toBe("gadget-mcp");
	});

	test("falls back when argv0 is empty", () => {
		expect(detectBinary("")).toBe("gadget-mcp");
	});
});

describe("runHealthcheck", () => {
	test("parseCli recognizes the healthcheck command", () => {
		expect(parseCli(["healthcheck"]).command).toBe("healthcheck");
		expect(parseCli(["healthcheck", "--port=9999"]).port).toBe(9999);
	});

	test("returns 0 against a live 200 /healthz", async () => {
		const server = Bun.serve({
			port: 0,
			hostname: "127.0.0.1",
			fetch: (req) => {
				if (new URL(req.url).pathname === "/healthz") return new Response("ok");
				return new Response("nope", { status: 404 });
			},
		});
		try {
			const code = await runHealthcheck(
				parseCli(["healthcheck", `--host=127.0.0.1`, `--port=${server.port}`]),
			);
			expect(code).toBe(0);
		} finally {
			server.stop(true);
		}
	});

	test("returns 1 when server is unreachable", async () => {
		// Port 1 is a reserved low port; nothing will be listening.
		const code = await runHealthcheck(parseCli(["healthcheck", "--host=127.0.0.1", "--port=1"]));
		expect(code).toBe(1);
	});

	test("returns 1 when endpoint responds non-200", async () => {
		const server = Bun.serve({
			port: 0,
			hostname: "127.0.0.1",
			fetch: () => new Response("not ready", { status: 503 }),
		});
		try {
			const code = await runHealthcheck(
				parseCli(["healthcheck", "--host=127.0.0.1", `--port=${server.port}`]),
			);
			expect(code).toBe(1);
		} finally {
			server.stop(true);
		}
	});
});
