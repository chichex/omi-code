import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, test } from "node:test";

import * as orchestrator from "./index.ts";

function fakeStripFrontmatter(content: string): string {
	const end = content.indexOf("\n---", 3);
	return end === -1 ? content : content.slice(end + 4).trim();
}

function evidence() {
	return [{ kind: "artifact", reference: ".sdd/specs/local.md", detail: "Canonical SDD spec" }];
}

function issueRequest() {
	return {
		version: 1,
		kind: "sdd-run",
		repo: "acme/omi-code",
		cwd: "/workspace/skills",
		target: {
			type: "issue",
			canonicalReference: "acme/omi-code#14",
			issue: { repository: "acme/omi-code", number: 14 },
		},
		summary: "Run the SDD spec stored in issue #14.",
		evidence: evidence(),
	};
}

function canonicalIssueSpec(number = 14): string {
	return [
		`# Spec — Issue ${number}`,
		"<!-- Generada. Estado: aprobada -->",
		`<!-- SDD-Tracking: version=1; type=spec; state=approved; issue=#${number}; grill=none; superseded-by=none -->`,
		"",
	].join("\n");
}

function specRequest() {
	return {
		version: 1,
		kind: "sdd-run",
		repo: "acme/omi-code",
		cwd: "/workspace/skills",
		target: {
			type: "spec",
			canonicalReference: "acme/omi-code:.sdd/specs/local.md",
			path: "/workspace/skills/.sdd/specs/local.md",
			issue: null,
		},
		summary: "Run local.md without inventing a GitHub issue.",
		evidence: evidence(),
	};
}

test("direct run request v1 strictly validates issue and issue-less spec targets", () => {
	assert.equal(typeof (orchestrator as Record<string, unknown>).validateDirectRunRequest, "function");
	for (const request of [issueRequest(), specRequest()]) {
		const result = orchestrator.validateDirectRunRequest(request);
		assert.equal(result.ok, true);
		if (result.ok) assert.deepEqual(result.value, request);
	}

	const extra = { ...issueRequest(), transcript: "must never be copied" };
	const invalid = orchestrator.validateDirectRunRequest(extra);
	assert.equal(invalid.ok, false);
	if (!invalid.ok) assert.ok(invalid.diagnostics.some((item) => item.code === "extra-field"));
	assert.equal(orchestrator.validateDirectRunRequest({ ...issueRequest(), summary: "x".repeat(241) }).ok, false);

	for (const [field, value] of [["repo", ""], ["cwd", ""], ["summary", ""]] as const) {
		const result = orchestrator.validateDirectRunRequest({ ...issueRequest(), [field]: value });
		assert.equal(result.ok, false);
		if (!result.ok) {
			const fieldDiagnostics = result.diagnostics.filter((item) => item.path === `$.${field}`);
			assert.equal(fieldDiagnostics.length, 1, `${field} should produce one actionable diagnostic`);
			assert.equal(fieldDiagnostics[0]!.code, "invalid-value");
		}
	}
});

function missingContractMessage(root: string): string {
	return `Create a canonical .omi/project.md in ${root} before launching run (a repo initialised before the rename may still keep it in .chiche/project.md or .sdd/project.md)`;
}

// Issue #103, CA-13: the gate reads <root>/.omi/project.md first and falls back to
// <root>/.chiche/project.md and <root>/.sdd/project.md only when the previous one is absent
// (ENOENT); any other read error is not "absent" and does not fall back. Virtual filesystem through the
// injected `readFile` port: no path exists on disk.
describe("#103 CA-13: el gate de contrato de /run", () => {
	const root = "/virtual/project";
	const omiContract = join(root, ".omi", "project.md");
	const chicheContract = join(root, ".chiche", "project.md");
	const sddContract = join(root, ".sdd", "project.md");
	const v2 = ["# Contract", "<!-- Chiche-Tracking: version=2; type=project; generated-at=2026-10-09 -->", ""].join("\n");
	const v1 = ["# Contract", "<!-- SDD-Tracking: version=1; type=project; generated-at=2026-08-15 -->", ""].join("\n");
	const notCanonical = ["# Contract", "Sin marker de tracking.", ""].join("\n");

	function project(files: Record<string, string>, failures: Record<string, string> = {}) {
		const reads: string[] = [];
		let issueLookups = 0;
		const dependencies = {
			resolveGitRoot: async () => root,
			realpath: async (path: string) => path,
			resolveRepository: async () => "acme/omi-code",
			resolveIssue: async (_root: string, _repo: string, number: number) => {
				issueLookups += 1;
				return { number, url: `https://github.com/acme/omi-code/issues/${number}`, state: "OPEN", body: canonicalIssueSpec(number) };
			},
			readFile: async (path: string) => {
				reads.push(path);
				if (path in failures) throw Object.assign(new Error(`${failures[path]}: ${path}`), { code: failures[path] });
				if (path in files) return files[path]!;
				throw Object.assign(new Error(`ENOENT: ${path}`), { code: "ENOENT" });
			},
		};
		return { dependencies, reads, issueLookups: () => issueLookups };
	}

	test("solo .omi/project.md canónico: es un proyecto SDD y /run avanza hasta el issue", async () => {
		const { dependencies, reads, issueLookups } = project({ [omiContract]: v2 });
		assert.equal(await orchestrator.isSddProject(root, dependencies), true);
		const resolved = await orchestrator.resolveDirectRunRequest("#14", root, dependencies);
		assert.equal(resolved.ok, true, resolved.ok ? "" : `${resolved.code}: ${resolved.message}`);
		assert.equal(issueLookups(), 1);
		assert.ok(!reads.includes(sddContract), "con .omi/project.md presente no se lee .sdd/project.md");
	});

	test("solo .sdd/project.md canónico (repo sin migrar): sigue siendo un proyecto SDD y /run avanza", async () => {
		const { dependencies, reads, issueLookups } = project({ [sddContract]: v1 });
		assert.equal(await orchestrator.isSddProject(root, dependencies), true);
		const resolved = await orchestrator.resolveDirectRunRequest("#14", root, dependencies);
		assert.equal(resolved.ok, true, resolved.ok ? "" : `${resolved.code}: ${resolved.message}`);
		assert.equal(issueLookups(), 1);
		assert.deepEqual(reads.slice(0, 3), [omiContract, chicheContract, sddContract], "primero .omi/, al faltar .chiche/ y al faltar .sdd/");
	});

	test("solo .chiche/project.md canónico (repo sin migrar): sigue siendo un proyecto SDD y gana sobre .sdd/", async () => {
		const { dependencies, reads, issueLookups } = project({ [chicheContract]: v2, [sddContract]: notCanonical });
		assert.equal(await orchestrator.isSddProject(root, dependencies), true);
		const resolved = await orchestrator.resolveDirectRunRequest("#14", root, dependencies);
		assert.equal(resolved.ok, true, resolved.ok ? "" : `${resolved.code}: ${resolved.message}`);
		assert.equal(issueLookups(), 1);
		assert.ok(!reads.includes(sddContract), "con .chiche/project.md presente no se lee .sdd/project.md");
	});

	test("un .chiche/project.md presente pero no canónico NO cae a un .sdd/project.md canónico", async () => {
		const { dependencies } = project({ [chicheContract]: notCanonical, [sddContract]: v1 });
		assert.equal(await orchestrator.isSddProject(root, dependencies), false);
	});

	test("con las tres marcas, omi gana sin leer las otras dos", async () => {
		const { dependencies, reads } = project({ [omiContract]: v2, [chicheContract]: notCanonical, [sddContract]: notCanonical });
		assert.equal(await orchestrator.isSddProject(root, dependencies), true);
		assert.deepEqual(reads, [omiContract]);
	});

	test("un .omi/project.md presente pero no canónico NO cae a un .sdd/project.md canónico", async () => {
		const { dependencies, issueLookups } = project({ [omiContract]: notCanonical, [sddContract]: v1 });
		assert.equal(await orchestrator.isSddProject(root, dependencies), false);
		const resolved = await orchestrator.resolveDirectRunRequest("#14", root, dependencies);
		assert.deepEqual(resolved, { ok: false, code: "missing-contract", message: missingContractMessage(root) });
		assert.equal(issueLookups(), 0, "el gate corre antes de cualquier consulta a GitHub");
	});

	// Review de #107 (10): solo la ausencia (ENOENT) habilita el fallback legacy.
	test("un .omi/project.md ilegible (EACCES) NO cae a un .sdd/project.md canónico", async () => {
		const { dependencies, reads, issueLookups } = project({ [sddContract]: v1 }, { [omiContract]: "EACCES" });
		assert.equal(await orchestrator.isSddProject(root, dependencies), false);
		const resolved = await orchestrator.resolveDirectRunRequest("#14", root, dependencies);
		assert.deepEqual(resolved, { ok: false, code: "missing-contract", message: missingContractMessage(root) });
		assert.equal(issueLookups(), 0, "el gate corre antes de cualquier consulta a GitHub");
		assert.ok(!reads.includes(sddContract), "con .omi/project.md ilegible no se lee .sdd/project.md");
		assert.ok(!reads.includes(chicheContract), "ni .chiche/project.md");
	});

	test("ninguno de los tres: missing-contract con el mensaje que nombra .omi/project.md y los fallbacks", async () => {
		const { dependencies, issueLookups } = project({});
		assert.equal(await orchestrator.isSddProject(root, dependencies), false);
		const resolved = await orchestrator.resolveDirectRunRequest("#14", root, dependencies);
		assert.deepEqual(resolved, { ok: false, code: "missing-contract", message: missingContractMessage(root) });
		assert.equal(issueLookups(), 0);
	});
});

test("issue targets require an SDD-aware project and reject unsafe integers before authorization", async () => {
	const temporary = await mkdtemp(join(tmpdir(), "direct-sdd-contract-"));
	try {
		const root = await realpath(temporary);
		let issueLookups = 0;
		const dependencies = {
			resolveGitRoot: async () => root,
			resolveRepository: async () => "acme/omi-code",
			resolveIssue: async (_root: string, _repo: string, number: number) => {
				issueLookups += 1;
				return {
					number,
					url: `https://github.com/acme/omi-code/issues/${number}`,
					state: "OPEN",
					body: canonicalIssueSpec(number),
				};
			},
		};
		const withoutContract = await orchestrator.resolveDirectRunRequest("#14", root, dependencies);
		assert.deepEqual(withoutContract, {
			ok: false,
			code: "missing-contract",
			message: missingContractMessage(root),
		});
		assert.equal(issueLookups, 0, "the contract gate runs before any GitHub issue lookup");

		await mkdir(join(root, ".sdd"), { recursive: true });
		await writeFile(join(root, ".sdd", "project.md"), [
			"# Contract",
			"<!-- SDD-Tracking: version=1; type=project; generated-at=2026-08-15 -->",
			"",
		].join("\n"), "utf8");
		const unsafe = await orchestrator.resolveDirectRunRequest("#9007199254740993", root, dependencies);
		assert.equal(unsafe.ok, false);
		if (!unsafe.ok) assert.equal(unsafe.code, "invalid-target");

		const missing = await orchestrator.resolveDirectRunRequest("#14", root, {
			...dependencies,
			resolveIssue: async () => { throw new Error("issue not found"); },
		});
		assert.equal(missing.ok, false);
		if (!missing.ok) assert.equal(missing.code, "unresolved-issue");

		const noSpec = await orchestrator.resolveDirectRunRequest("#14", root, {
			...dependencies,
			resolveIssue: async () => ({ number: 14, url: "https://example.test/14", state: "OPEN", body: "# Bug" }),
		});
		assert.equal(noSpec.ok, false);
		if (!noSpec.ok) assert.equal(noSpec.code, "invalid-spec");

		const verified = await orchestrator.resolveDirectRunRequest("#14", root, dependencies);
		assert.equal(verified.ok, true);
	} finally {
		await rm(temporary, { recursive: true, force: true });
	}
});

test("the generic lifecycle cannot bypass strict DirectRunRequestV1 validation", async () => {
	const request = { ...issueRequest(), transcript: "must never cross the boundary" };
	const result = await orchestrator.startFreshStage({
		direct: {
			request,
			cwd: request.cwd,
			name: "SDD run-existing-spec · acme/omi-code#14",
			repository: request.repo,
			canonicalReference: request.target.canonicalReference,
			issueNumber: request.target.issue.number,
		},
		skill: { name: "run", args: "#14" },
	}, {} as never, { commands: [] });
	assert.equal(result.ok, false);
	if (!result.ok) assert.equal(result.code, "invalid-direct-request");
});

test("direct target resolution normalizes #NN and local/cross-project canonical specs without inventing issues", async () => {
	assert.equal(typeof (orchestrator as Record<string, unknown>).resolveDirectRunRequest, "function");
	const temporary = await mkdtemp(join(tmpdir(), "direct-run-"));
	try {
		const projectA = await realpath(temporary);
		const projectB = join(projectA, "project-b");
		await mkdir(join(projectA, ".sdd", "specs"), { recursive: true });
		await mkdir(join(projectA, "packages", "api"), { recursive: true });
		await mkdir(join(projectB, ".sdd", "specs"), { recursive: true });
		const contract = [
			"# Contract",
			"<!-- SDD-Tracking: version=1; type=project; generated-at=2026-08-15 -->",
			"",
		].join("\n");
		await Promise.all([
			writeFile(join(projectA, ".sdd", "project.md"), contract, "utf8"),
			writeFile(join(projectB, ".sdd", "project.md"), contract, "utf8"),
		]);
		const localSpec = join(projectA, ".sdd", "specs", "local.md");
		const crossSpec = join(projectB, ".sdd", "specs", "issue-7-cross.md");
		await writeFile(localSpec, [
			`# Spec — ${"Local artifact ".repeat(40)}`,
			"<!-- Generada. Estado: aprobada -->",
			"<!-- SDD-Tracking: version=1; type=spec; state=approved; issue=none; grill=none; superseded-by=none -->",
			"",
		].join("\n"), "utf8");
		await writeFile(crossSpec, [
			"# Spec — Cross project",
			"<!-- Generada. Estado: aprobada -->",
			"<!-- SDD-Tracking: version=1; type=spec; state=approved; issue=#7; grill=none; superseded-by=none -->",
			"",
		].join("\n"), "utf8");

		const dependencies = {
			async resolveGitRoot(path: string) {
				return path.startsWith(projectB) ? projectB : projectA;
			},
			async resolveRepository(root: string) {
				return root === projectB ? "owner/project-b" : "acme/omi-code";
			},
			async resolveRepositoryRoot(_originRoot: string, repository: string) {
				return repository === "owner/project-b"
					? { ok: true as const, root: projectB }
					: { ok: false as const, code: "project-not-found" as const, roots: [] };
			},
			async resolveIssue(_root: string, repo: string, number: number) {
				return {
					number,
					url: `https://github.com/${repo}/issues/${number}`,
					state: "OPEN",
					body: canonicalIssueSpec(number),
				};
			},
		};
		const issue = await orchestrator.resolveDirectRunRequest("#14", projectA, dependencies);
		assert.equal(issue.ok, true);
		if (issue.ok) {
			assert.deepEqual(issue.request.target, {
				type: "issue",
				canonicalReference: "acme/omi-code#14",
				issue: { repository: "acme/omi-code", number: 14 },
			});
		}

		const crossIssueUrl = await orchestrator.resolveDirectRunRequest(
			"https://github.com/owner/project-b/issues/7",
			projectA,
			dependencies,
		);
		assert.equal(crossIssueUrl.ok, true, "a GitHub issue URL resolves against its known local checkout");
		if (crossIssueUrl.ok) {
			assert.equal(crossIssueUrl.request.cwd, projectB);
			assert.equal(crossIssueUrl.request.repo, "owner/project-b");
			assert.deepEqual(crossIssueUrl.request.target, {
				type: "issue",
				canonicalReference: "owner/project-b#7",
				issue: { repository: "owner/project-b", number: 7 },
			});
		}

		const crossIssueRef = await orchestrator.resolveDirectRunRequest("owner/project-b#7", projectA, dependencies);
		assert.equal(crossIssueRef.ok, true, "a qualified issue reference resolves against its known local checkout");
		if (crossIssueRef.ok) {
			assert.equal(crossIssueRef.request.cwd, projectB);
			assert.equal(crossIssueRef.request.target.canonicalReference, "owner/project-b#7");
		}

		const originSubdirectory = join(projectA, "packages", "api");
		const local = await orchestrator.resolveDirectRunRequest(".sdd/specs/local.md", originSubdirectory, dependencies);
		assert.equal(local.ok, true, "CA-7 resolves relative spec targets against the project root");
		if (local.ok) {
			assert.equal(local.request.cwd, projectA);
			assert.ok(local.request.summary.length <= 240, "the transport summary stays bounded");
			assert.deepEqual(local.request.target, {
				type: "spec",
				canonicalReference: "acme/omi-code:.sdd/specs/local.md",
				path: localSpec,
				issue: null,
			});
		}

		const cross = await orchestrator.resolveDirectRunRequest(crossSpec, projectA, dependencies);
		assert.equal(cross.ok, true);
		if (cross.ok) {
			assert.equal(cross.request.cwd, projectB);
			assert.equal(cross.request.repo, "owner/project-b");
			assert.deepEqual(cross.request.target, {
				type: "spec",
				canonicalReference: "owner/project-b:.sdd/specs/issue-7-cross.md",
				path: crossSpec,
				issue: { repository: "owner/project-b", number: 7 },
			});
		}
	} finally {
		await rm(temporary, { recursive: true, force: true });
	}
});

test("URL-like non-issue targets fail clearly instead of becoming fabricated local paths", async () => {
	let pathReads = 0;
	const result = await orchestrator.resolveDirectRunRequest(
		"https://github.com/pramaestudio/brik/pull/114",
		"/workspace/skills",
		{
			resolveGitRoot: async () => "/workspace/skills",
			realpath: async (path: string) => {
				if (!path.includes("https:")) return path;
				pathReads += 1;
				throw new Error("must not resolve an HTTP URL as a local path");
			},
		},
	);
	assert.deepEqual(result, {
		ok: false,
		code: "invalid-target",
		message: "Issue targets must use #NN, owner/repo#NN, or https://github.com/owner/repo/issues/NN",
	});
	assert.equal(pathReads, 0);
});

test("startDirectRun creates a fresh linked child whose first message is materialized run plus request v1", async () => {
	assert.equal(typeof (orchestrator as Record<string, unknown>).startDirectRun, "function");
	const temporary = await mkdtemp(join(tmpdir(), "direct-sdd-child-"));
	try {
		const project = await realpath(temporary);
		const sessionDirectory = join(project, "sessions");
		const originFile = join(sessionDirectory, "origin.jsonl");
		const childFile = join(sessionDirectory, "child.jsonl");
		const skillPath = join(project, "skills", "run", "SKILL.md");
		const specPath = join(project, ".sdd", "specs", "local.md");
		await mkdir(dirname(skillPath), { recursive: true });
		await mkdir(dirname(specPath), { recursive: true });
		await mkdir(sessionDirectory, { recursive: true });
		await writeFile(skillPath, "---\nname: run\ndescription: Run\n---\n# SDD run\n", "utf8");
		await writeFile(specPath, "# Spec — Local\n", "utf8");
		await writeFile(originFile, "{}\n", "utf8");
		const request = specRequest();
		request.cwd = project;
		request.target.path = specPath;
		request.target.canonicalReference = "acme/omi-code:.sdd/specs/local.md";
		request.evidence[0]!.reference = ".sdd/specs/local.md";
		let kickoff = "";
		let sessionName = "";
		const context = {
			cwd: project,
			sessionManager: {
				getCwd: () => project,
				getSessionId: () => "origin-id",
				getSessionFile: () => originFile,
				getSessionDir: () => sessionDirectory,
			},
			async newSession(options: {
				parentSession: string;
				setup: (manager: { appendSessionInfo(name: string): string }) => Promise<void>;
				withSession: (replacement: unknown) => Promise<void>;
			}) {
				assert.equal(options.parentSession, originFile);
				await options.setup({ appendSessionInfo(name: string) { sessionName = name; return "info"; } });
				await options.withSession({
					cwd: project,
					sessionManager: {
						getCwd: () => project,
						getSessionId: () => "child-id",
						getSessionFile: () => childFile,
					},
					getSystemPromptOptions: () => ({
						cwd: project,
						contextFiles: [],
						skills: [{
							name: "run",
							description: "Run",
							filePath: skillPath,
							sourceInfo: { path: skillPath, scope: "temporary" },
							disableModelInvocation: false,
						}],
					}),
					async sendUserMessage(message: string) { kickoff = message; },
				});
				return { cancelled: false };
			},
			async switchSession() { throw new Error("same-project launch must use newSession"); },
		};

		const result = await orchestrator.startDirectRun(request, context as never, {
			commands: [{ name: "skill:run", source: "skill", sourceInfo: { path: skillPath } }],
			stripSkillFrontmatter: fakeStripFrontmatter,
			resolveGitRoot: async () => project,
		});
		assert.equal(result.ok, true);
		if (!result.ok) return;
		assert.equal(result.target.sessionId, "child-id");
		assert.equal(result.target.artifactPath, specPath);
		assert.equal(sessionName, "SDD run-existing-spec · acme/omi-code/local.md");
		assert.doesNotMatch(kickoff, /\/skill:run|origin transcript/i);
		assert.match(kickoff, new RegExp(`<skill name="run" location="${skillPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}">`));
		const envelope = kickoff.match(/<workflow-launch version="1">\n([\s\S]+)\n<\/workflow-launch>$/)?.[1];
		assert.ok(envelope);
		assert.deepEqual(JSON.parse(envelope), request);
	} finally {
		await rm(temporary, { recursive: true, force: true });
	}
});

test("startDirectRun stages a cross-project child under the selected spec project", async () => {
	const temporary = await mkdtemp(join(tmpdir(), "direct-sdd-cross-"));
	try {
		const origin = await realpath(temporary);
		const target = join(origin, "target");
		const originSessions = join(origin, "sessions");
		const originFile = join(originSessions, "origin.jsonl");
		const childFile = join(target, "sessions", "child.jsonl");
		const skillPath = join(origin, "global-skills", "run", "SKILL.md");
		const specPath = join(target, ".sdd", "specs", "local.md");
		await mkdir(dirname(originFile), { recursive: true });
		await mkdir(dirname(skillPath), { recursive: true });
		await mkdir(dirname(specPath), { recursive: true });
		await writeFile(originFile, "{}\n", "utf8");
		await writeFile(skillPath, "---\nname: run\ndescription: Run\n---\n# Run\n", "utf8");
		await writeFile(specPath, "# Spec — Target\n", "utf8");
		const request = specRequest();
		request.repo = "owner/target";
		request.cwd = target;
		request.target.canonicalReference = "owner/target:.sdd/specs/local.md";
		request.target.path = specPath;
		let stagedInput: unknown;
		let switched = "";
		const context = {
			cwd: origin,
			sessionManager: {
				getCwd: () => origin,
				getSessionId: () => "origin-id",
				getSessionFile: () => originFile,
				getSessionDir: () => originSessions,
			},
			async newSession() { throw new Error("cross-project launch must not use newSession"); },
			async switchSession(path: string, options: { withSession: (context: unknown) => Promise<void> }) {
				switched = path;
				await options.withSession({
					cwd: target,
					sessionManager: { getCwd: () => target, getSessionId: () => "child-id", getSessionFile: () => childFile },
					getSystemPromptOptions: () => ({
						cwd: target,
						contextFiles: [{ path: join(target, "AGENTS.md"), content: "target" }],
						skills: [{
							name: "run",
							description: "Run",
							filePath: skillPath,
							sourceInfo: { path: skillPath, scope: "global" },
							disableModelInvocation: false,
						}],
					}),
					async sendUserMessage() {},
				});
				return { cancelled: false };
			},
		};
		const result = await orchestrator.startDirectRun(request, context as never, {
			commands: [{ name: "skill:run", source: "skill", sourceInfo: { path: skillPath } }],
			stripSkillFrontmatter: fakeStripFrontmatter,
			resolveGitRoot: async () => target,
			stageCrossProjectSession: async (input: unknown) => {
				stagedInput = input;
				return { sessionId: "staged-id", sessionFile: childFile, cwd: target };
			},
		});
		assert.equal(result.ok, true);
		assert.equal(switched, childFile);
		assert.deepEqual(stagedInput, {
			cwd: target,
			parentSession: originFile,
			name: "SDD run-existing-spec · owner/target/local.md",
			sourceCwd: origin,
			sourceSessionDir: originSessions,
		});
	} finally {
		await rm(temporary, { recursive: true, force: true });
	}
});

// Spec #84, CA-12 e issue #103, CA-1: /run, launch_sdd_run y
// __sdd-dispatch aceptan una spec en <git-common-dir>/omi/specs/ (o, de antes
// del renombre, en <git-common-dir>/sdd/specs/) desde el checkout principal y
// desde un worktree linkeado. Repo git real; el repositorio de GitHub se inyecta.
async function draftRepo(brand: "omi" | "sdd" = "omi"): Promise<{ base: string; main: string; linked: string; draft: string }> {
	const { execFileSync } = await import("node:child_process");
	const git = (cwd: string, ...args: string[]) => execFileSync("git", [
		"-c", "user.name=sdd", "-c", "user.email=sdd@example.invalid", "-c", "commit.gpgsign=false", ...args,
	], { cwd, encoding: "utf8" });
	const base = await realpath(await mkdtemp(join(tmpdir(), "direct-sdd-draft-")));
	const main = join(base, "repo");
	await mkdir(join(main, ".sdd"), { recursive: true });
	git(main, "init", "-q", "-b", "main");
	await writeFile(join(main, ".sdd", "project.md"), [
		"# Contract",
		"<!-- SDD-Tracking: version=1; type=project; generated-at=2026-10-09 -->",
		"",
	].join("\n"), "utf8");
	git(main, "add", ".sdd/project.md");
	git(main, "commit", "-q", "-m", "contrato");
	const linked = join(base, "repo-wt");
	git(main, "worktree", "add", "-q", "-b", "feature", linked);
	const draftDirectory = join(main, ".git", brand, "specs");
	await mkdir(draftDirectory, { recursive: true });
	const draft = join(draftDirectory, "borrador.md");
	await writeFile(draft, [
		"# Spec — Borrador fuera del árbol",
		"<!-- Generada. Estado: aprobada -->",
		"<!-- SDD-Tracking: version=1; type=spec; state=approved; issue=none; grill=none; superseded-by=none -->",
		"",
	].join("\n"), "utf8");
	return { base, main, linked, draft };
}

for (const brand of ["omi", "sdd"] as const) {
	test(`#84 CA-12: /run acepta una spec en <git-common-dir>/${brand}/specs desde el checkout principal y desde un worktree linkeado`, async () => {
		const { base, main, linked, draft } = await draftRepo(brand);
		try {
			const dependencies = { async resolveRepository() { return "acme/omi-code"; } };
			for (const cwd of [main, linked]) {
				for (const target of [".omi/specs/borrador.md", ".sdd/specs/borrador.md", draft]) {
					const result = await orchestrator.resolveDirectRunRequest(target, cwd, dependencies);
					assert.equal(result.ok, true, `${cwd} · ${target}: ${result.ok ? "" : `${result.code}: ${result.message}`}`);
					if (!result.ok) continue;
					assert.equal(result.request.cwd, cwd);
					assert.deepEqual(result.request.target, {
						type: "spec",
						canonicalReference: `acme/omi-code:.${brand}/specs/borrador.md`,
						path: draft,
						issue: null,
					});
					assert.equal(orchestrator.describeDirectRun(result.request).skill.args, draft);
					assert.equal(orchestrator.validateDirectRunRequest(result.request).ok, true);
				}
			}
			for (const target of [".sdd/specs/no-existe.md", ".omi/specs/no-existe.md"]) {
				const missing = await orchestrator.resolveDirectRunRequest(target, linked, dependencies);
				assert.equal(missing.ok, false, target);
				if (!missing.ok) assert.equal(missing.code, "unreadable-spec");
			}
		} finally {
			await rm(base, { recursive: true, force: true });
		}
	});
}

test("#103 CA-1: /run resuelve una ruta lógica por nombre con la precedencia .omi/specs > .sdd/specs > <git-common-dir>/omi/specs > <git-common-dir>/sdd/specs", async () => {
	const { base, main, linked, draft } = await draftRepo("sdd");
	try {
		const dependencies = { async resolveRepository() { return "acme/omi-code"; } };
		const resolveFrom = async (cwd: string, target: string) => {
			const result = await orchestrator.resolveDirectRunRequest(target, cwd, dependencies);
			assert.equal(result.ok, true, `${cwd} · ${target}: ${result.ok ? "" : `${result.code}: ${result.message}`}`);
			return result.ok && result.request.target.type === "spec" ? result.request.target : null;
		};
		const omiDraft = join(main, ".git", "omi", "specs", "borrador.md");
		await mkdir(dirname(omiDraft), { recursive: true });
		await writeFile(omiDraft, await readFile(draft, "utf8"), "utf8");
		for (const cwd of [main, linked]) {
			const target = await resolveFrom(cwd, ".sdd/specs/borrador.md");
			assert.equal(target?.path, omiDraft, `${cwd}: en el empate local gana <git-common-dir>/omi/specs`);
			assert.equal(target?.canonicalReference, "acme/omi-code:.omi/specs/borrador.md");
		}
		const legacyTracked = join(linked, ".sdd", "specs", "borrador.md");
		await mkdir(dirname(legacyTracked), { recursive: true });
		await writeFile(legacyTracked, await readFile(draft, "utf8"), "utf8");
		assert.equal((await resolveFrom(linked, ".omi/specs/borrador.md"))?.path, legacyTracked, "un .sdd/specs del árbol gana a los borradores");
		const tracked = join(linked, ".omi", "specs", "borrador.md");
		await mkdir(dirname(tracked), { recursive: true });
		await writeFile(tracked, await readFile(draft, "utf8"), "utf8");
		const winner = await resolveFrom(linked, ".sdd/specs/borrador.md");
		assert.equal(winner?.path, tracked, ".omi/specs del árbol gana a todo");
		assert.equal(winner?.canonicalReference, "acme/omi-code:.omi/specs/borrador.md");
	} finally {
		await rm(base, { recursive: true, force: true });
	}
});

// Review #106, F5: el nombre de la spec se resuelve con el `stat` inyectado, no
// con el del disco. Filesystem virtual: ningún path existe de verdad, así que
// una resolución que ignore el puerto cae en el lugar local de omi.
test("#103 CA-1: /run resuelve el nombre de la spec por el stat inyectado con la precedencia .omi/specs > .chiche/specs > .sdd/specs > <git-common-dir>/omi/specs > <git-common-dir>/chiche/specs > <git-common-dir>/sdd/specs", async () => {
	const root = "/virtual/repo";
	const commonDir = join(root, ".git");
	const places = {
		tracked: join(root, ".omi", "specs", "borrador.md"),
		chicheTracked: join(root, ".chiche", "specs", "borrador.md"),
		legacyTracked: join(root, ".sdd", "specs", "borrador.md"),
		local: join(commonDir, "omi", "specs", "borrador.md"),
		chicheLocal: join(commonDir, "chiche", "specs", "borrador.md"),
		legacyLocal: join(commonDir, "sdd", "specs", "borrador.md"),
	};
	const contractPath = join(root, ".sdd", "project.md");
	const contract = ["# Contract", "<!-- SDD-Tracking: version=1; type=project; generated-at=2026-10-09 -->", ""].join("\n");
	const spec = [
		"# Spec — Borrador virtual",
		"<!-- Generada. Estado: aprobada -->",
		"<!-- SDD-Tracking: version=1; type=spec; state=approved; issue=none; grill=none; superseded-by=none -->",
		"",
	].join("\n");
	const existing = new Set<string>();
	const statCalls: string[] = [];
	const dependencies = {
		resolveGitRoot: async () => root,
		resolveGitCommonDir: async () => commonDir,
		resolveRepository: async () => "acme/omi-code",
		realpath: async (path: string) => path,
		stat: async (path: string) => {
			statCalls.push(path);
			if (!existing.has(path)) throw Object.assign(new Error(`ENOENT: ${path}`), { code: "ENOENT" });
			return { isFile: () => true };
		},
		readFile: async (path: string) => {
			if (path === contractPath) return contract;
			if (existing.has(path)) return spec;
			throw Object.assign(new Error(`ENOENT: ${path}`), { code: "ENOENT" });
		},
	};
	const resolveFrom = async (target: string) => {
		statCalls.length = 0;
		return orchestrator.resolveDirectRunRequest(target, root, dependencies);
	};
	const { tracked, chicheTracked, legacyTracked, local, chicheLocal, legacyLocal } = places;
	// Cada escenario quita al ganador anterior; `stat` ve los lugares en orden de precedencia
	// hasta el primero que existe, y después la verificación final del archivo ya resuelto.
	const scenarios: Array<{ present: string[]; winner: string; probed: string[] }> = [
		{ present: [tracked, chicheTracked, legacyTracked, local, chicheLocal, legacyLocal], winner: tracked, probed: [tracked] },
		{ present: [chicheTracked, legacyTracked, local, chicheLocal, legacyLocal], winner: chicheTracked, probed: [tracked, chicheTracked] },
		{ present: [legacyTracked, local, chicheLocal, legacyLocal], winner: legacyTracked, probed: [tracked, chicheTracked, legacyTracked] },
		{ present: [local, chicheLocal, legacyLocal], winner: local, probed: [tracked, chicheTracked, legacyTracked, local] },
		{ present: [chicheLocal, legacyLocal], winner: chicheLocal, probed: [tracked, chicheTracked, legacyTracked, local, chicheLocal] },
		{ present: [legacyLocal], winner: legacyLocal, probed: [tracked, chicheTracked, legacyTracked, local, chicheLocal, legacyLocal] },
	];
	for (const { present, winner, probed } of scenarios) {
		existing.clear();
		for (const path of present) existing.add(path);
		for (const target of [".sdd/specs/borrador.md", ".chiche/specs/borrador.md", ".omi/specs/borrador.md"]) {
			const result = await resolveFrom(target);
			assert.equal(result.ok, true, `${target} con ${present.length} lugares: ${result.ok ? "" : `${result.code}: ${result.message}`}`);
			assert.equal(result.ok && result.request.target.type === "spec" ? result.request.target.path : null, winner, `${target}: gana ${winner}`);
			assert.deepEqual(statCalls, [...probed, winner], `${target}: el stat inyectado recorre los lugares en orden y verifica al ganador`);
		}
	}
	existing.clear();
	const missing = await resolveFrom(".sdd/specs/borrador.md");
	assert.equal(missing.ok, false);
	if (!missing.ok) assert.equal(missing.code, "unreadable-spec");
	assert.deepEqual(statCalls, [tracked, chicheTracked, legacyTracked, local, chicheLocal, legacyLocal, local], "sin ninguno, el stat ve los seis lugares y el destino local de omi");
});

test("#84 CA-12: el protocolo directo acepta un borrador del common-dir y sigue rechazando rutas ajenas", () => {
	const request = (path: string, canonicalReference: string) => ({
		version: 1,
		kind: "sdd-run",
		repo: "acme/omi-code",
		cwd: "/workspace/skills-wt",
		target: { type: "spec", canonicalReference, path, issue: null },
		summary: "Run SDD spec Borrador.",
		evidence: evidence(),
	});
	assert.equal(orchestrator.validateDirectRunRequest(request("/workspace/skills/.git/omi/specs/borrador.md", "acme/omi-code:.omi/specs/borrador.md")).ok, true);
	assert.equal(orchestrator.validateDirectRunRequest(request("/workspace/skills/.git/chiche/specs/borrador.md", "acme/omi-code:.chiche/specs/borrador.md")).ok, true);
	assert.equal(orchestrator.validateDirectRunRequest(request("/workspace/skills/.git/sdd/specs/borrador.md", "acme/omi-code:.sdd/specs/borrador.md")).ok, true);
	assert.equal(orchestrator.validateDirectRunRequest(request("/workspace/skills-wt/.omi/specs/x.md", "acme/omi-code:.omi/specs/x.md")).ok, true);
	assert.equal(orchestrator.validateDirectRunRequest(request("/workspace/skills-wt/.sdd/specs/x.md", "acme/omi-code:.sdd/specs/x.md")).ok, true);
	for (const [path, reference] of [
		["/workspace/skills/.git/sdd/specs/borrador.md", "acme/omi-code:.git/sdd/specs/borrador.md"],
		["/workspace/skills/.git/omi/specs/borrador.md", "acme/omi-code:.sdd/specs/borrador.md"],
		["/workspace/skills/.git/sdd/specs/borrador.md", "acme/omi-code:.omi/specs/borrador.md"],
		["/workspace/skills/.git/chiche/specs/borrador.md", "acme/omi-code:.omi/specs/borrador.md"],
		["/workspace/otro/specs/x.md", "acme/omi-code:.sdd/specs/x.md"],
		["/workspace/skills/.git/sdd/grills/x.md", "acme/omi-code:.sdd/specs/x.md"],
		["/workspace/skills/.git/omi/grills/x.md", "acme/omi-code:.omi/specs/x.md"],
		["/workspace/skills/.git/otra/specs/x.md", "acme/omi-code:.otra/specs/x.md"],
	]) {
		assert.equal(orchestrator.validateDirectRunRequest(request(path!, reference!)).ok, false, path);
	}
});

function draftRequest(cwd: string, path: string, canonicalReference = "acme/omi-code:.sdd/specs/borrador.md") {
	return {
		version: 1,
		kind: "sdd-run",
		repo: "acme/omi-code",
		cwd,
		target: { type: "spec", canonicalReference, path, issue: null },
		summary: "Run SDD spec Borrador.",
		evidence: evidence(),
	};
}

test("review #86: el protocolo directo solo acepta borradores bajo un directorio .git", () => {
	assert.equal(orchestrator.validateDirectRunRequest(draftRequest("/workspace/skills-wt", "/workspace/skills/.git/sdd/specs/borrador.md")).ok, true);
	assert.equal(orchestrator.validateDirectRunRequest(draftRequest("/workspace/skills-wt", "/srv/repos/skills.git/sdd/specs/borrador.md")).ok, true, "repo bare");
	assert.equal(orchestrator.validateDirectRunRequest(draftRequest("/workspace/skills-wt", "/srv/repos/skills.git/omi/specs/borrador.md", "acme/omi-code:.omi/specs/borrador.md")).ok, true, "repo bare, omi");
	for (const [cwd, path, reference] of [
		["/workspace/skills-wt", "/tmp/sdd/specs/borrador.md", undefined],
		["/workspace/skills-wt", "/tmp/omi/specs/borrador.md", "acme/omi-code:.omi/specs/borrador.md"],
		["/workspace/skills-wt", "/workspace/otro/vendor/sdd/specs/borrador.md", undefined],
		["/workspace/skills-wt", "/workspace/skills-wt/vendor/sdd/specs/borrador.md", undefined],
	] as const) {
		assert.equal(orchestrator.validateDirectRunRequest(draftRequest(cwd, path, reference)).ok, false, path);
	}
});

test("review #86: startFreshStage rechaza un borrador que no está en el common-dir del repo de cwd", async () => {
	const launch = (path: string) => {
		const request = draftRequest("/workspace/skills-wt", path);
		const descriptor = orchestrator.describeDirectRun(request as never);
		return orchestrator.startFreshStage({ direct: { request, ...descriptor.direct }, skill: descriptor.skill }, {} as never, {
			commands: [],
			resolveGitCommonDir: async (cwd: string) => (cwd === "/workspace/skills-wt" ? "/workspace/skills/.git" : null),
		} as never);
	};
	const foreign = await launch("/workspace/otro/.git/sdd/specs/borrador.md");
	assert.equal(foreign.ok, false);
	if (!foreign.ok) assert.equal(foreign.code, "invalid-direct-request");
	const own = await launch("/workspace/skills/.git/sdd/specs/borrador.md");
	assert.ok(own.ok || own.code !== "invalid-direct-request", JSON.stringify(own));
	const launchOmi = (path: string) => {
		const request = draftRequest("/workspace/skills-wt", path, "acme/omi-code:.omi/specs/borrador.md");
		const descriptor = orchestrator.describeDirectRun(request as never);
		return orchestrator.startFreshStage({ direct: { request, ...descriptor.direct }, skill: descriptor.skill }, {} as never, {
			commands: [],
			resolveGitCommonDir: async (cwd: string) => (cwd === "/workspace/skills-wt" ? "/workspace/skills/.git" : null),
		} as never);
	};
	const foreignOmi = await launchOmi("/workspace/otro/.git/omi/specs/borrador.md");
	assert.equal(foreignOmi.ok, false);
	if (!foreignOmi.ok) assert.equal(foreignOmi.code, "invalid-direct-request");
	const ownOmi = await launchOmi("/workspace/skills/.git/omi/specs/borrador.md");
	assert.ok(ownOmi.ok || ownOmi.code !== "invalid-direct-request", JSON.stringify(ownOmi));
});

// Review #114-7 (issue #102): launch_sdd_run acepta `autonomy` opcional y el protocolo directo lo lleva a los args.
test("review #114-7: DirectRunRequestV1 acepta autonomy opcional validado (A1–A3), lo rechaza fuera de la escala y describeDirectRun lo agrega a los args", () => {
	const base = draftRequest("/workspace/skills", "/workspace/skills/.git/omi/specs/borrador.md", "acme/omi-code:.omi/specs/borrador.md");
	const plain = orchestrator.validateDirectRunRequest(base);
	assert.equal(plain.ok, true, JSON.stringify(plain));
	assert.equal(orchestrator.describeDirectRun(base as never).skill.args, "/workspace/skills/.git/omi/specs/borrador.md");
	for (const [token, code] of [["A2", "A2"], ["unattended", "A3"], ["a1", "A1"]] as const) {
		const validation = orchestrator.validateDirectRunRequest({ ...base, autonomy: token });
		assert.equal(validation.ok, true, `${token}: ${JSON.stringify(validation)}`);
		if (validation.ok) {
			assert.equal(validation.value.autonomy, code);
			assert.equal(orchestrator.describeDirectRun(validation.value).skill.args, `/workspace/skills/.git/omi/specs/borrador.md --autonomy ${code}`);
		}
	}
	for (const token of ["A4", "auto-deploy", "extreme", 3]) {
		const validation = orchestrator.validateDirectRunRequest({ ...base, autonomy: token });
		assert.equal(validation.ok, false, String(token));
		if (!validation.ok) assert.ok(validation.diagnostics.some((diagnostic) => diagnostic.path === "$.autonomy"), JSON.stringify(validation.diagnostics));
	}
});

test("ronda 2 (#116-22): un pedido de grill con autonomy se rechaza con extra-field, no se ignora", () => {
	const issue = { repository: "acme/omi-code", number: 14 };
	const base = { version: 1, kind: "grill", repo: "acme/omi-code", cwd: "/workspace/skills", target: { type: "issue", canonicalReference: "acme/omi-code#14", issue }, summary: "Grill #14", evidence: [{ kind: "issue", reference: "#14", detail: "x" }] };
	assert.equal(orchestrator.validateDirectGrillRequest(base).ok, true);
	const rejected = orchestrator.validateDirectGrillRequest({ ...base, autonomy: "A3" });
	assert.equal(rejected.ok, false, "autonomy no es un campo de grill");
	if (!rejected.ok) assert.deepEqual(rejected.diagnostics.map((diagnostic) => [diagnostic.path, diagnostic.code]), [["$.autonomy", "extra-field"]]);
});
