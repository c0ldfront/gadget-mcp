import type { Db } from "../db/connection.ts";

export interface ReviewerRunner {
	readonly id: string;
	readonly name: string;
	readonly command: readonly string[];
	readonly enabled: boolean;
	readonly timeoutSeconds: number | null;
}

export interface ReviewerRunResult {
	readonly runnerId: string;
	readonly runnerName: string;
	readonly command: readonly string[];
	readonly status: "completed" | "failed" | "timeout" | "missing";
	readonly exitCode: number | null;
	readonly output: string;
	readonly stderr: string;
	readonly outputPath: string | null;
	readonly durationMs: number;
}

export interface RunnerInput {
	readonly runner: ReviewerRunner;
	readonly promptText: string;
	readonly timeoutSeconds: number;
	readonly outputPath?: string;
	readonly signal?: AbortSignal;
}

export class ReviewerRunnerRepo {
	readonly #db: Db;
	constructor(db: Db) {
		this.#db = db;
	}

	list(): ReviewerRunner[] {
		const rows = this.#db
			.query(
				"SELECT id, name, command_json, enabled, timeout_seconds FROM reviewer_runners ORDER BY id",
			)
			.all() as {
			id: string;
			name: string;
			command_json: string;
			enabled: number;
			timeout_seconds: number | null;
		}[];
		return rows.map((r) => ({
			id: r.id,
			name: r.name,
			command: JSON.parse(r.command_json) as string[],
			enabled: r.enabled === 1,
			timeoutSeconds: r.timeout_seconds,
		}));
	}

	get(id: string): ReviewerRunner | null {
		const row = this.#db
			.query(
				"SELECT id, name, command_json, enabled, timeout_seconds FROM reviewer_runners WHERE id = $id",
			)
			.get({ $id: id }) as {
			id: string;
			name: string;
			command_json: string;
			enabled: number;
			timeout_seconds: number | null;
		} | null;
		if (row === null) return null;
		return {
			id: row.id,
			name: row.name,
			command: JSON.parse(row.command_json) as string[],
			enabled: row.enabled === 1,
			timeoutSeconds: row.timeout_seconds,
		};
	}

	upsert(runner: ReviewerRunner): void {
		const now = Date.now();
		this.#db
			.prepare(
				`INSERT INTO reviewer_runners (id, name, command_json, enabled, timeout_seconds, created_at, updated_at)
				 VALUES ($id, $name, $cmd, $enabled, $to, $now, $now)
				 ON CONFLICT(id) DO UPDATE SET
					 name = excluded.name,
					 command_json = excluded.command_json,
					 enabled = excluded.enabled,
					 timeout_seconds = excluded.timeout_seconds,
					 updated_at = excluded.updated_at`,
			)
			.run({
				$id: runner.id,
				$name: runner.name,
				$cmd: JSON.stringify(runner.command),
				$enabled: runner.enabled ? 1 : 0,
				$to: runner.timeoutSeconds ?? null,
				$now: now,
			});
	}

	delete(id: string): boolean {
		const res = this.#db.prepare("DELETE FROM reviewer_runners WHERE id = $id").run({ $id: id });
		return Number(res.changes) > 0;
	}
}

export async function executeReviewerRun(input: RunnerInput): Promise<ReviewerRunResult> {
	const { runner, promptText, timeoutSeconds, outputPath, signal } = input;
	const started = performance.now();
	if (!runner.enabled) {
		return buildResult(runner, "missing", null, "", "runner disabled", null, started);
	}
	const executable = runner.command[0];
	if (executable === undefined) {
		return buildResult(runner, "failed", null, "", "empty command", null, started);
	}
	const which = Bun.which(executable);
	if (which === null) {
		return buildResult(runner, "missing", null, "", `${executable} not on PATH`, null, started);
	}

	const tmpDir = (await Bun.file("/tmp/.gadget-prompts").exists())
		? "/tmp/.gadget-prompts"
		: "/tmp";
	const promptPath = `${tmpDir}/gadget-prompt-${Date.now()}-${Math.floor(Math.random() * 1e9)}.txt`;
	await Bun.write(promptPath, promptText);

	const resolved = runner.command.map((arg) =>
		arg.replaceAll("{input_file}", promptPath).replaceAll("{output_file}", outputPath ?? ""),
	);
	const pipePrompt = !runner.command.some((a) => a.includes("{input_file}"));

	const proc = Bun.spawn(resolved, {
		stdin: pipePrompt ? "pipe" : "ignore",
		stdout: "pipe",
		stderr: "pipe",
	});
	if (pipePrompt && proc.stdin !== undefined && proc.stdin !== null) {
		const sink = proc.stdin as { write(data: Uint8Array): void; end(): void };
		sink.write(new TextEncoder().encode(promptText));
		sink.end();
	}

	const timeout = setTimeout(() => {
		proc.kill("SIGKILL");
	}, Math.max(1, timeoutSeconds) * 1000);
	const abortListener = (): void => {
		proc.kill("SIGKILL");
	};
	signal?.addEventListener("abort", abortListener, { once: true });

	let stdout = "";
	let stderr = "";
	try {
		stdout = await new Response(proc.stdout).text();
		stderr = await new Response(proc.stderr).text();
	} finally {
		clearTimeout(timeout);
		signal?.removeEventListener("abort", abortListener);
	}
	const exitCode = await proc.exited;

	let output = stdout;
	if (outputPath !== undefined && (await Bun.file(outputPath).exists())) {
		output = await Bun.file(outputPath).text();
	}

	let status: ReviewerRunResult["status"] = "completed";
	if (signal?.aborted === true) status = "failed";
	else if (exitCode === 143 || exitCode === 137) status = "timeout";
	else if (exitCode !== 0) status = "failed";

	return buildResult(runner, status, exitCode, output, stderr, outputPath ?? null, started);
}

function buildResult(
	runner: ReviewerRunner,
	status: ReviewerRunResult["status"],
	exitCode: number | null,
	output: string,
	stderr: string,
	outputPath: string | null,
	started: number,
): ReviewerRunResult {
	return {
		runnerId: runner.id,
		runnerName: runner.name,
		command: runner.command,
		status,
		exitCode,
		output,
		stderr,
		outputPath,
		durationMs: Math.round(performance.now() - started),
	};
}

export function aggregateReviewStatus(
	results: readonly ReviewerRunResult[],
): "completed" | "partialFailure" | "failed" {
	if (results.length === 0) return "failed";
	const ok = results.filter((r) => r.status === "completed").length;
	if (ok === results.length) return "completed";
	if (ok === 0) return "failed";
	return "partialFailure";
}
