#!/usr/bin/env bun
/**
 * forge.ts — gadget-mcp release pipeline
 *
 * Subcommands:
 *   build       — compile per-triple binaries into target/<profile>/
 *   package     — tar.gz each binary, write SHA256SUMS.txt into target/packages/
 *   source      — git archive the source tree into target/packages/
 *   sbom        — emit a CycloneDX 1.5 JSON SBOM from node_modules
 *   release     — build + package + source + sbom
 *   targets     — print the resolved target matrix
 */
import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { basename, join, resolve } from "node:path";

interface PackageJson {
	readonly name: string;
	readonly version: string;
	readonly forge?: {
		readonly entry?: string;
		readonly binary?: string;
		readonly targets?: string;
		readonly outDir?: string;
	};
}

const LINUX_TARGETS: readonly string[] = [
	"bun-linux-x64",
	"bun-linux-x64-musl",
	"bun-linux-arm64",
	"bun-linux-arm64-musl",
];

const DARWIN_TARGETS: readonly string[] = ["bun-darwin-x64", "bun-darwin-arm64"];

// Bun's Windows arm64 target is not yet supported by `bun build --compile`.
const WINDOWS_TARGETS: readonly string[] = ["bun-windows-x64"];

const TARGET_MATRIX: Readonly<Record<string, readonly string[]>> = {
	linux: LINUX_TARGETS,
	darwin: DARWIN_TARGETS,
	windows: WINDOWS_TARGETS,
	all: [...LINUX_TARGETS, ...DARWIN_TARGETS, ...WINDOWS_TARGETS],
};

function resolveTargets(spec: string | undefined): readonly string[] {
	if (spec === undefined || spec === "") return LINUX_TARGETS;
	const trimmed = spec.trim();
	const preset = TARGET_MATRIX[trimmed];
	if (preset !== undefined) return preset;
	// Comma-separated explicit target list, e.g. "bun-linux-x64,bun-darwin-arm64".
	const parts = trimmed
		.split(",")
		.map((s) => s.trim())
		.filter((s) => s !== "");
	if (parts.length === 0) return LINUX_TARGETS;
	return parts;
}

interface Config {
	readonly pkg: PackageJson;
	readonly entry: string;
	readonly binary: string;
	readonly outDir: string;
	readonly targets: readonly string[];
}

async function loadConfig(): Promise<Config> {
	const pkgRaw = await readFile("package.json", "utf8");
	const pkg = JSON.parse(pkgRaw) as PackageJson;
	const forge = pkg.forge ?? {};
	const entry = forge.entry ?? "./packages/server/src/cli.ts";
	const binary = forge.binary ?? "gadget-mcp";
	const outDir = forge.outDir ?? "./target";
	const targets = resolveTargets(forge.targets);
	return { pkg, entry, binary, outDir, targets };
}

function parseFlag(args: readonly string[], key: string): string | null {
	for (let i = 0; i < args.length; i++) {
		const a = args[i];
		if (a === undefined) continue;
		if (a === key) return args[i + 1] ?? null;
		if (a.startsWith(`${key}=`)) return a.slice(key.length + 1);
	}
	return null;
}

function hasFlag(args: readonly string[], key: string): boolean {
	return args.includes(key);
}

async function fileSha256(path: string): Promise<string> {
	const buf = await readFile(path);
	return createHash("sha256").update(buf).digest("hex");
}

async function build(
	cfg: Config,
	opts: { profile: string; only?: string | null },
): Promise<readonly string[]> {
	const outRoot = join(cfg.outDir, opts.profile);
	await mkdir(outRoot, { recursive: true });
	const produced: string[] = [];
	// `--only` accepts:
	//   * an exact triple (`bun-linux-x64`) — wins over substring matches,
	//   * a comma-separated list of exact triples,
	//   * a legacy substring (`linux`, `arm64`, `musl`).
	// Exact matching is tried first so `--only=bun-linux-x64` no longer
	// unintentionally selects `bun-linux-x64-musl`.
	const onlyRaw = opts.only ?? null;
	const onlyExact: readonly string[] | null =
		onlyRaw !== null && onlyRaw.includes(",")
			? onlyRaw.split(",").map((s) => s.trim()).filter((s) => s !== "")
			: onlyRaw !== null
				? [onlyRaw]
				: null;
	for (const triple of cfg.targets) {
		if (onlyExact !== null) {
			const exact = onlyExact.some((t) => t === triple);
			const substring = !exact && onlyExact.length === 1 && onlyRaw !== null && triple.includes(onlyRaw);
			if (!exact && !substring) continue;
			// If any exact match is declared in the --only list, substring
			// fallback is disabled to avoid picking up musl for `x64`, etc.
			if (!exact && onlyExact.some((t) => cfg.targets.includes(t))) continue;
		}
		const out = join(outRoot, `${cfg.binary}-${triple}`);
		const args = [
			"build",
			cfg.entry,
			"--compile",
			`--target=${triple}`,
			`--outfile=${out}`,
		];
		if (opts.profile === "release") args.push("--minify");
		const proc = Bun.spawn(["bun", ...args], {
			stdout: "inherit",
			stderr: "inherit",
			stdin: "ignore",
		});
		const code = await proc.exited;
		if (code !== 0) {
			throw new Error(`bun build failed for ${triple} (exit ${code})`);
		}
		produced.push(out);
		process.stderr.write(`built: ${out}\n`);
	}
	return produced;
}

async function packageArtifacts(
	cfg: Config,
	opts: { profile: string },
): Promise<string> {
	const outRoot = join(cfg.outDir, opts.profile);
	const pkgDir = join(cfg.outDir, "packages");
	await mkdir(pkgDir, { recursive: true });
	const entries = await readdir(outRoot);
	const archives: string[] = [];
	for (const name of entries) {
		const binPath = join(outRoot, name);
		const s = await stat(binPath);
		if (!s.isFile()) continue;
		const archivePath = join(pkgDir, `${name}.tar.gz`);
		await tarGzSingleFile(binPath, archivePath);
		archives.push(archivePath);
		process.stderr.write(`packaged: ${archivePath}\n`);
	}
	const sumsPath = join(pkgDir, "SHA256SUMS.txt");
	const lines: string[] = [];
	for (const p of archives) {
		const h = await fileSha256(p);
		lines.push(`${h}  ${basename(p)}`);
	}
	await writeFile(sumsPath, `${lines.join("\n")}\n`, "utf8");
	process.stderr.write(`checksums: ${sumsPath}\n`);
	return sumsPath;
}

async function tarGzSingleFile(src: string, dest: string): Promise<void> {
	const proc = Bun.spawn(["tar", "-czf", dest, "-C", "target", basename(src).replace(/^/, "")], {
		stdout: "inherit",
		stderr: "inherit",
		stdin: "ignore",
	});
	const code = await proc.exited;
	if (code !== 0) throw new Error(`tar failed (exit ${code}) for ${src}`);
}

async function sourceArchive(cfg: Config, opts: { ref: string }): Promise<string> {
	const pkgDir = join(cfg.outDir, "packages");
	await mkdir(pkgDir, { recursive: true });
	const out = join(pkgDir, `${cfg.binary}-${cfg.pkg.version}-source.tar.gz`);
	const proc = Bun.spawn(
		["git", "archive", `--prefix=${cfg.binary}-${cfg.pkg.version}/`, "-o", out, opts.ref],
		{ stdout: "inherit", stderr: "inherit", stdin: "ignore" },
	);
	const code = await proc.exited;
	if (code !== 0) throw new Error(`git archive failed (exit ${code})`);
	process.stderr.write(`source archive: ${out}\n`);
	return out;
}

interface CdxComponent {
	readonly type: "library";
	readonly name: string;
	readonly version: string;
	readonly purl: string;
	readonly hashes?: readonly { alg: string; content: string }[];
}

async function scanNodeModules(): Promise<CdxComponent[]> {
	const root = "node_modules";
	const seen = new Set<string>();
	const out: CdxComponent[] = [];
	async function walk(dir: string): Promise<void> {
		let entries: string[];
		try {
			entries = await readdir(dir);
		} catch {
			return;
		}
		for (const name of entries) {
			if (name === ".bin" || name === ".cache") continue;
			const full = join(dir, name);
			const s = await stat(full).catch(() => null);
			if (s === null) continue;
			if (!s.isDirectory()) continue;
			if (name.startsWith("@")) {
				await walk(full);
				continue;
			}
			const pkgJson = join(full, "package.json");
			try {
				const text = await readFile(pkgJson, "utf8");
				const parsed = JSON.parse(text) as { name?: string; version?: string };
				if (typeof parsed.name === "string" && typeof parsed.version === "string") {
					const key = `${parsed.name}@${parsed.version}`;
					if (!seen.has(key)) {
						seen.add(key);
						out.push({
							type: "library",
							name: parsed.name,
							version: parsed.version,
							purl: `pkg:npm/${encodeURIComponent(parsed.name).replace("%40", "@")}@${parsed.version}`,
						});
					}
				}
			} catch {
				// ignore non-package dirs
			}
			// Walk nested node_modules
			const nested = join(full, "node_modules");
			const ns = await stat(nested).catch(() => null);
			if (ns !== null && ns.isDirectory()) await walk(nested);
		}
	}
	await walk(root);
	return out;
}

async function sbom(cfg: Config, opts: { out?: string | null }): Promise<string> {
	const components = await scanNodeModules();
	const doc = {
		bomFormat: "CycloneDX",
		specVersion: "1.5",
		serialNumber: `urn:uuid:${randomUUID()}`,
		version: 1,
		metadata: {
			timestamp: new Date().toISOString(),
			tools: [{ vendor: "gadget-mcp", name: "forge.ts" }],
			component: {
				type: "application",
				name: cfg.pkg.name,
				version: cfg.pkg.version,
				purl: `pkg:generic/${cfg.pkg.name}@${cfg.pkg.version}`,
			},
		},
		components,
	};
	const outPath = opts.out ?? join(cfg.outDir, "SBOM.cyclonedx.json");
	await mkdir(resolve(outPath, ".."), { recursive: true });
	await writeFile(outPath, `${JSON.stringify(doc, null, 2)}\n`, "utf8");
	process.stderr.write(`sbom: ${outPath} (${components.length} components)\n`);
	return outPath;
}

async function cleanProfile(cfg: Config, profile: string): Promise<void> {
	await rm(join(cfg.outDir, profile), { recursive: true, force: true });
}

async function main(argv: readonly string[]): Promise<void> {
	const sub = argv[0];
	const args = argv.slice(1);
	const cfg = await loadConfig();
	if (sub === undefined || sub === "help" || sub === "--help") {
		process.stdout.write(
			"forge.ts subcommands: build | package | source | sbom | release | targets\n",
		);
		return;
	}
	if (sub === "targets") {
		for (const t of cfg.targets) process.stdout.write(`${t}\n`);
		return;
	}
	const profile = parseFlag(args, "--profile") ?? "release";
	if (sub === "build") {
		await cleanProfile(cfg, profile);
		await build(cfg, { profile, only: parseFlag(args, "--only") });
		return;
	}
	if (sub === "package") {
		await packageArtifacts(cfg, { profile });
		return;
	}
	if (sub === "source") {
		const ref = parseFlag(args, "--ref") ?? "HEAD";
		await sourceArchive(cfg, { ref });
		return;
	}
	if (sub === "sbom") {
		await sbom(cfg, { out: parseFlag(args, "--out") });
		return;
	}
	if (sub === "release") {
		await cleanProfile(cfg, profile);
		await build(cfg, { profile, only: parseFlag(args, "--only") });
		await packageArtifacts(cfg, { profile });
		if (!hasFlag(args, "--no-source")) await sourceArchive(cfg, { ref: "HEAD" });
		await sbom(cfg, { out: null });
		return;
	}
	process.stderr.write(`forge: unknown subcommand '${sub}'\n`);
	process.exit(2);
}

if (import.meta.main === true) {
	main(process.argv.slice(2)).catch((err) => {
		process.stderr.write(`forge: ${(err as Error).message}\n`);
		process.exit(1);
	});
}
