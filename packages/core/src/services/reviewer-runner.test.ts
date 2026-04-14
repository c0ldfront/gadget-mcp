import { expect, test } from "bun:test";
import { openMemoryDb } from "../db/connection.ts";
import {
	aggregateReviewStatus,
	executeReviewerRun,
	ReviewerRunnerRepo,
} from "./reviewer-runner.ts";

test("ReviewerRunnerRepo upsert + get + list + delete", () => {
	const db = openMemoryDb();
	const repo = new ReviewerRunnerRepo(db);
	repo.upsert({
		id: "echo",
		name: "Echo",
		command: ["echo", "hello"],
		enabled: true,
		timeoutSeconds: 5,
	});
	expect(repo.list().length).toBe(1);
	expect(repo.get("echo")?.command).toEqual(["echo", "hello"]);
	repo.upsert({
		id: "echo",
		name: "Echo2",
		command: ["echo", "bye"],
		enabled: false,
		timeoutSeconds: null,
	});
	expect(repo.get("echo")?.name).toBe("Echo2");
	expect(repo.get("echo")?.enabled).toBe(false);
	expect(repo.delete("echo")).toBe(true);
	expect(repo.get("echo")).toBeNull();
	db.close();
});

test("executeReviewerRun runs /bin/echo and captures stdout", async () => {
	const res = await executeReviewerRun({
		runner: {
			id: "echo",
			name: "echo",
			command: ["echo", "hello gadget"],
			enabled: true,
			timeoutSeconds: null,
		},
		promptText: "",
		timeoutSeconds: 5,
	});
	expect(res.status).toBe("completed");
	expect(res.output.trim()).toBe("hello gadget");
});

test("executeReviewerRun returns missing for disabled runner", async () => {
	const res = await executeReviewerRun({
		runner: {
			id: "nope",
			name: "x",
			command: ["echo"],
			enabled: false,
			timeoutSeconds: null,
		},
		promptText: "",
		timeoutSeconds: 1,
	});
	expect(res.status).toBe("missing");
});

test("executeReviewerRun returns missing for unknown executable", async () => {
	const res = await executeReviewerRun({
		runner: {
			id: "x",
			name: "x",
			command: ["__definitely_missing_binary_xyz__"],
			enabled: true,
			timeoutSeconds: null,
		},
		promptText: "",
		timeoutSeconds: 1,
	});
	expect(res.status).toBe("missing");
});

test("aggregateReviewStatus rolls up mixed results", () => {
	const base = {
		runnerId: "x",
		runnerName: "x",
		command: [],
		output: "",
		stderr: "",
		outputPath: null,
		exitCode: 0,
		durationMs: 0,
	};
	expect(aggregateReviewStatus([])).toBe("failed");
	expect(aggregateReviewStatus([{ ...base, status: "completed" }])).toBe("completed");
	expect(aggregateReviewStatus([{ ...base, status: "failed" }])).toBe("failed");
	expect(
		aggregateReviewStatus([
			{ ...base, status: "completed" },
			{ ...base, status: "failed" },
		]),
	).toBe("partialFailure");
});
