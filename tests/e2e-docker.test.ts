import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { resolve } from "node:path";

// Gated so default `bun test` stays fast. CI sets GADGET_DOCKER_TESTS=1.
const ENABLED = Bun.env.GADGET_DOCKER_TESTS === "1";
const IMAGE = Bun.env.GADGET_DOCKER_IMAGE ?? "gadget-mcp:e2e";
const ENGINE = Bun.env.GADGET_DOCKER_ENGINE ?? "docker";
const REPO_ROOT = resolve(import.meta.dir, "..");
const STARTUP_DEADLINE_MS = 20_000;

async function run(
	cmd: string[],
	opts: { timeoutMs?: number } = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
	const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe", cwd: REPO_ROOT });
	const timer =
		opts.timeoutMs !== undefined
			? setTimeout(() => proc.kill("SIGKILL"), opts.timeoutMs)
			: undefined;
	const [stdout, stderr, code] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	if (timer !== undefined) clearTimeout(timer);
	return { code, stdout, stderr };
}

async function waitForReady(url: string): Promise<void> {
	const deadline = Date.now() + STARTUP_DEADLINE_MS;
	let lastErr = "";
	while (Date.now() < deadline) {
		try {
			const res = await fetch(`${url}/readyz`);
			if (res.status === 200) return;
			lastErr = `status=${res.status}`;
		} catch (err) {
			lastErr = err instanceof Error ? err.message : String(err);
		}
		await Bun.sleep(250);
	}
	throw new Error(`container /readyz never returned 200: ${lastErr}`);
}

describe.skipIf(!ENABLED)("docker image regression", () => {
	let volumeName: string;
	let containerName: string;
	let port: number;
	let baseUrl: string;
	let imageBuiltHere = false;

	beforeAll(async () => {
		// Fresh build so the test actually exercises the current Dockerfile.
		const build = await run([ENGINE, "build", "-t", IMAGE, "."], { timeoutMs: 600_000 });
		if (build.code !== 0) {
			throw new Error(`image build failed:\n${build.stderr || build.stdout}`);
		}
		imageBuiltHere = true;

		const suffix = crypto.randomUUID().slice(0, 8);
		volumeName = `gadget-mcp-e2e-${suffix}`;
		containerName = `gadget-mcp-e2e-${suffix}`;
		// Random high port so parallel runs don't collide.
		port = 40000 + Math.floor(Math.random() * 20_000);
		baseUrl = `http://127.0.0.1:${port}`;

		// Create the named volume explicitly so afterAll can always remove it
		// by name — `docker run -v` would auto-create it, but then a failed
		// run would leak the volume without us knowing to clean it up.
		const volCreate = await run([ENGINE, "volume", "create", volumeName], {
			timeoutMs: 10_000,
		});
		if (volCreate.code !== 0) {
			throw new Error(`volume create failed:\n${volCreate.stderr || volCreate.stdout}`);
		}

		// Use a named volume, not a host bind-mount: the distroless `nonroot`
		// user (UID 65532) cannot write to a tmp dir owned by the host user.
		const runRes = await run(
			[
				ENGINE,
				"run",
				"-d",
				"--name",
				containerName,
				"-p",
				`${port}:7878`,
				"-v",
				`${volumeName}:/data`,
				IMAGE,
			],
			{ timeoutMs: 30_000 },
		);
		if (runRes.code !== 0) {
			throw new Error(`container run failed:\n${runRes.stderr || runRes.stdout}`);
		}

		await waitForReady(baseUrl);
	}, 600_000);

	afterAll(async () => {
		if (containerName !== undefined) {
			await run([ENGINE, "rm", "-f", containerName], { timeoutMs: 30_000 });
		}
		if (volumeName !== undefined) {
			await run([ENGINE, "volume", "rm", "-f", volumeName], { timeoutMs: 30_000 });
		}
		if (imageBuiltHere && Bun.env.GADGET_DOCKER_KEEP_IMAGE !== "1") {
			await run([ENGINE, "image", "rm", IMAGE], { timeoutMs: 30_000 });
		}
	}, 60_000);

	test("/healthz returns 200 ok", async () => {
		const res = await fetch(`${baseUrl}/healthz`);
		expect(res.status).toBe(200);
		expect((await res.text()).trim()).toBe("ok");
	});

	test("/readyz returns 200 ready (DB is reachable inside distroless)", async () => {
		const res = await fetch(`${baseUrl}/readyz`);
		expect(res.status).toBe(200);
		expect((await res.text()).trim()).toBe("ready");
	});

	test("/metrics emits Prometheus text", async () => {
		const res = await fetch(`${baseUrl}/metrics`);
		expect(res.status).toBe(200);
		const body = await res.text();
		expect(body.includes("gadget_gadgets_total")).toBe(true);
	});

	test("POST /mcp initialize returns a session and serverInfo", async () => {
		const res = await fetch(`${baseUrl}/mcp`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				accept: "application/json, text/event-stream",
			},
			body: JSON.stringify({
				jsonrpc: "2.0",
				id: 1,
				method: "initialize",
				params: {
					protocolVersion: "2025-03-26",
					capabilities: {},
					clientInfo: { name: "e2e-docker", version: "0.0.1" },
				},
			}),
		});
		expect(res.status).toBe(200);
		expect(res.headers.get("mcp-session-id")).toBeTruthy();
		const body = await res.text();
		expect(body.includes("gadget-mcp")).toBe(true);
		expect(body.includes("protocolVersion")).toBe(true);
	});

	test("HEALTHCHECK binary self-probe succeeds", async () => {
		const res = await run(
			[ENGINE, "exec", containerName, "/usr/local/bin/gadget-mcp", "healthcheck"],
			{ timeoutMs: 10_000 },
		);
		expect(res.code).toBe(0);
	});

	test("container logs contain no unexpected errors", async () => {
		const { stdout, stderr } = await run([ENGINE, "logs", containerName], {
			timeoutMs: 10_000,
		});
		const combined = `${stdout}\n${stderr}`;
		// Bun/Node emit these at startup on some hosts — don't fail on them.
		const ignorable = /DeprecationWarning|ExperimentalWarning/;
		const offending = combined
			.split("\n")
			.filter((l) => /error|panic|uncaught|unhandled/i.test(l))
			.filter((l) => !ignorable.test(l));
		expect(offending).toEqual([]);
	});
});

if (!ENABLED) {
	test.skip("docker regression suite (set GADGET_DOCKER_TESTS=1 to enable)", () => {});
}
