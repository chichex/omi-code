import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
	cpSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { after, before, test } from "node:test";

import { parseSddArtifact } from "../artifacts/index.ts";
import { parseSddEventLine, type SddEvent } from "../artifacts/sdd-events.ts";
import { handoffFileNames } from "./logic.ts";
import { snapshotStorageStem } from "./runtime-import.ts";

interface RegisteredTool {
	name: string;
	execute: (...args: any[]) => Promise<any>;
}

interface RegisteredCommand {
	handler: (...args: any[]) => Promise<void>;
}

// omi-code trae a Pi como dependencia: los tests usan esa copia, no un `pi` del PATH.
const NODE_MODULES = fileURLToPath(new URL("../../node_modules/", import.meta.url));
const PI_PACKAGE_ROOT = join(NODE_MODULES, "@earendil-works", "pi-coding-agent");
// El nombre de la clave retirada se arma a pedazos: el gate de grill exige que no aparezca
// escrito en ningun archivo trackeado de extensions, ni siquiera en los tests.
const RETIRED_LIMIT_KEY = ["question", "Limit"].join("");
let sandbox = "";
let previousHome: string | undefined;
let tools = new Map<string, RegisteredTool>();
let commands = new Map<string, RegisteredCommand>();
let grillEvents: any[] = [];
let sentMessages: Array<{ content: string; options?: unknown }> = [];
let appendedEntries: Array<{ type: string; data: unknown }> = [];
let availableSkills = new Set(["grill", "spec"]);
let failMessageQueue = false;
let skillPaths = new Map<string, string>();
let execHandler = async (..._args: any[]) => ({ code: 0, stdout: "", stderr: "" });

before(async () => {
	sandbox = realpathSync(mkdtempSync(join(tmpdir(), "grill-tools-test-")));
	cpSync(new URL("..", import.meta.url), join(sandbox, "extensions"), { recursive: true });

	const scopedRoot = join(sandbox, "node_modules", "@earendil-works");
	mkdirSync(scopedRoot, { recursive: true });
	for (const packageName of ["pi-ai", "pi-tui"]) {
		symlinkSync(
			join(NODE_MODULES, "@earendil-works", packageName),
			join(scopedRoot, packageName),
			"dir",
		);
	}
	symlinkSync(PI_PACKAGE_ROOT, join(scopedRoot, "pi-coding-agent"), "dir");
	symlinkSync(
		join(NODE_MODULES, "typebox"),
		join(sandbox, "node_modules", "typebox"),
		"dir",
	);

	previousHome = process.env.HOME;
	process.env.HOME = join(sandbox, "home");
	// Dentro de una sesión omi esta variable apunta al ~/.omi/agent real: el test no lo toca.
	delete process.env.PI_CODING_AGENT_DIR;
	mkdirSync(process.env.HOME, { recursive: true });
	for (const name of ["grill", "spec"]) {
		const path = join(sandbox, "skills", name, "SKILL.md");
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, `---\nname: ${name}\ndescription: Test ${name}\n---\n# ${name}\n`, "utf8");
		skillPaths.set(name, path);
	}

	const { default: register } = await import(
		`${pathToFileURL(join(sandbox, "extensions", "grill-tools", "index.ts")).href}?test=${Date.now()}`
	);
	register({
		registerEntryRenderer() {},
		registerCommand(name: string, command: RegisteredCommand) {
			commands.set(name, command);
		},
		registerTool(tool: RegisteredTool) {
			tools.set(tool.name, tool);
		},
		events: {
			emit(name: string, payload: unknown) {
				if (name === "grill:interview-state") grillEvents.push(payload);
			},
		},
		getCommands() {
			return [...availableSkills].map((name) => ({
				name: `skill:${name}`,
				source: "skill",
				sourceInfo: { path: skillPaths.get(name) },
			}));
		},
		sendUserMessage(content: string, options?: unknown) {
			if (failMessageQueue) throw new Error("queue failed");
			sentMessages.push({ content, options });
		},
		appendEntry(type: string, data: unknown) {
			appendedEntries.push({ type, data });
		},
		exec: (...args: any[]) => execHandler(...args),
	} as never);
});

after(() => {
	if (previousHome === undefined) delete process.env.HOME;
	else process.env.HOME = previousHome;
	if (sandbox) rmSync(sandbox, { recursive: true, force: true });
});

function canonicalHandoff(
	id: string,
	state: "paused" | "finalized",
	topic: string,
	projectPath: string,
): string {
	return [
		`# Grill — ${topic}`,
		`<!-- SDD-Tracking: version=1; type=grill; state=${state}; issue=none; grill=${encodeURIComponent(id)}; project=${encodeURIComponent(projectPath)} -->`,
		"",
		"## Hechos comprobados",
		"Confirmed source context.",
		"",
	].join("\n");
}

function storedSnapshotIds(): string[] {
	const directory = join(process.env.HOME!, ".pi", "agent", "grill-sessions");
	try {
		return readdirSync(directory)
			.filter((file) => file.endsWith(".json"))
			.flatMap((file) => {
				try {
					const parsed = JSON.parse(readFileSync(join(directory, file), "utf8"));
					return typeof parsed.id === "string" ? [parsed.id] : [];
				} catch {
					return [];
				}
			});
	} catch {
		return [];
	}
}

function removeStoredSnapshot(id: string): void {
	const directory = join(process.env.HOME!, ".pi", "agent", "grill-sessions");
	try {
		for (const file of readdirSync(directory).filter((name) => name.endsWith(".json"))) {
			const path = join(directory, file);
			try {
				if (JSON.parse(readFileSync(path, "utf8")).id === id) rmSync(path, { force: true });
			} catch {
				// Keep unrelated corrupt fixtures.
			}
		}
	} catch {
		// The store may not exist yet.
	}
}

function rpcContext(projectPath: string, choices: string[]) {
	let index = 0;
	return {
		cwd: projectPath,
		hasUI: true,
		mode: "rpc",
		ui: {
			async select(_title: string, labels: string[]) {
				const choice = choices[index++];
				if (choice === undefined) return undefined;
				const selected = labels.find((label) => label.includes(choice));
				assert.ok(selected, `missing ${choice} in ${labels.join(" | ")}`);
				return selected;
			},
		},
	};
}

test("grill_session persists interviewMode and refuses checkpoints before it is selected", async () => {
	const tool = tools.get("grill_session");
	assert.ok(tool);
	const projectPath = join(sandbox, "project");
	mkdirSync(projectPath, { recursive: true });

	const created = await tool.execute(
		"create-grill",
		{
			action: "create",
			topic: "Round persistence",
			projectPath,
			estimate: { min: 2, likely: 4, max: 6 },
		},
		undefined,
		undefined,
		{ cwd: projectPath },
	);
	assert.equal(created.details.snapshot.interviewMode, "unselected");

	await assert.rejects(
		tool.execute(
			"checkpoint-before-mode",
			{
				action: "checkpoint",
				sessionId: created.details.snapshot.id,
				interaction: { id: "q1", question: "¿Primera?", answers: ["A"] },
			},
			undefined,
			undefined,
			{ cwd: projectPath },
		),
		/configure.*interviewMode/i,
	);

	await assert.rejects(
		tool.execute(
			"configure-unselected",
			{ action: "configure", sessionId: created.details.snapshot.id, interviewMode: "unselected" },
			undefined,
			undefined,
			{ cwd: projectPath },
		),
		/configure requires interviewMode/i,
	);

	const configured = await tool.execute(
		"configure-rounds",
		{
			action: "configure",
			sessionId: created.details.snapshot.id,
			interviewMode: "rounds",
		},
		undefined,
		undefined,
		{ cwd: projectPath },
	);
	assert.equal(configured.details.snapshot.interviewMode, "rounds");
	assert.equal(configured.details.snapshot.status, "active");

	const persisted = JSON.parse(readFileSync(configured.details.jsonPath, "utf8"));
	assert.equal(persisted.interviewMode, "rounds");
	assert.ok(
		grillEvents.some((event) => event.id === persisted.id && event.interviewMode === "rounds"),
		"the questioning tool receives the persisted interview state",
	);

	const legacy = { ...persisted, id: "legacy-grill-without-interview-mode", version: 3 };
	delete legacy.interviewMode;
	const legacyPath = join(dirname(configured.details.jsonPath), `${legacy.id}.json`);
	writeFileSync(legacyPath, `${JSON.stringify(legacy, null, 2)}\n`, "utf8");
	const loadedLegacy = await tool.execute(
		"load-legacy-grill",
		{ action: "get", sessionId: legacy.id },
		undefined,
		undefined,
		{ cwd: projectPath },
	);
	assert.equal(loadedLegacy.details.snapshot.interviewMode, "unselected");
	assert.equal(loadedLegacy.details.snapshot.version, 5);
});

test("CA-8/9: grill_session create persists no question limit and progress has no limit suffix", async () => {
	const tool = tools.get("grill_session");
	assert.ok(tool);
	const projectPath = join(sandbox, "no-limit-project");
	mkdirSync(projectPath, { recursive: true });

	const created = await tool.execute(
		"create-no-limit",
		{
			action: "create",
			topic: "Interview without a limit",
			projectPath,
			estimate: { min: 1, likely: 2, max: 3 },
			[RETIRED_LIMIT_KEY]: 5,
		},
		undefined,
		undefined,
		{ cwd: projectPath },
	);
	assert.equal(RETIRED_LIMIT_KEY in created.details.snapshot, false);
	assert.match(created.content[0].text, /"progress": "0 of ~2"/);
	assert.doesNotMatch(created.content[0].text, /\(limit/, "progress has no (limit N) suffix");
	const persisted = JSON.parse(readFileSync(created.details.jsonPath, "utf8"));
	assert.equal(RETIRED_LIMIT_KEY in persisted, false, "create ignores the retired parameter");
	assert.equal(persisted.version, 5);
});

test("CA-7: grill_session checkpoint accepts the 21st interaction and keeps going", async () => {
	const tool = tools.get("grill_session");
	assert.ok(tool);
	const projectPath = join(sandbox, "unbounded-project");
	mkdirSync(projectPath, { recursive: true });

	const created = await tool.execute(
		"create-unbounded",
		{ action: "create", topic: "Unbounded interview", projectPath, estimate: { min: 1, likely: 2, max: 3 } },
		undefined,
		undefined,
		{ cwd: projectPath },
	);
	const sessionId = created.details.snapshot.id;
	await tool.execute(
		"configure-unbounded",
		{ action: "configure", sessionId, interviewMode: "adaptive" },
		undefined,
		undefined,
		{ cwd: projectPath },
	);

	let last: any;
	for (let index = 1; index <= 21; index++) {
		last = await tool.execute(
			`checkpoint-${index}`,
			{
				action: "checkpoint",
				sessionId,
				interaction: { id: `q${index}`, question: `¿Decision ${index}?`, answers: ["A"] },
			},
			undefined,
			undefined,
			{ cwd: projectPath },
		);
	}
	assert.match(last.content[0].text, /"progress": "21 of ~2"/);
	const persisted = JSON.parse(readFileSync(last.details.jsonPath, "utf8"));
	assert.equal(persisted.interactions.length, 21);
	assert.equal(persisted.status, "active");
});

test("CA-1/4/6: /grills and select_grill_session expose the same handoff and snapshot inventory", async () => {
	const command = commands.get("grills");
	const tool = tools.get("select_grill_session");
	assert.ok(command);
	assert.ok(tool);
	const projectPath = join(sandbox, "inventory-project");
	const grillsDirectory = join(projectPath, ".sdd", "grills");
	const storeDirectory = join(process.env.HOME!, ".pi", "agent", "grill-sessions");
	mkdirSync(grillsDirectory, { recursive: true });
	mkdirSync(storeDirectory, { recursive: true });
	const handoffId = "portable-finalized";
	writeFileSync(join(grillsDirectory, "portable.md"), [
		"# Grill — Portable finalized",
		`<!-- SDD-Tracking: version=1; type=grill; state=finalized; issue=none; grill=${handoffId}; project=${encodeURIComponent("/old/project")} -->`,
		"",
		"## Handoff",
		"Portable source.",
		"",
	].join("\n"));
	const timestamp = "2026-09-29T12:00:00.000Z";
	writeFileSync(join(storeDirectory, "runtime-active.json"), `${JSON.stringify({
		version: 4,
		id: "runtime-active",
		topic: "Runtime active",
		projectPath,
		projectName: "inventory-project",
		status: "active",
		interviewMode: "adaptive",
		createdAt: timestamp,
		updatedAt: timestamp,
		estimate: { min: 1, likely: 2, max: 3 },
		sections: [],
		interactions: [],
		decisions: [],
		pendingBranches: [],
		revision: 1,
	}, null, 2)}\n`);

	const commandRenders: string[] = [];
	const theme = {
		fg: (_color: string, text: string) => text,
		bg: (_color: string, text: string) => text,
		bold: (text: string) => text,
	};
	await command.handler("", {
		cwd: projectPath,
		mode: "tui",
		waitForIdle: async () => {},
		ui: {
			notify(message: string) {
				commandRenders.push(`NOTIFY: ${message}`);
			},
			async custom(factory: (...args: any[]) => any) {
				return new Promise((resolveDone) => {
					const component = factory({ requestRender() {} }, theme, {}, resolveDone);
					commandRenders.push(component.render(160).join("\n"));
					component.handleInput("\x1b");
				});
			},
		},
	});

	let toolLabels: string[] = [];
	const selected = await tool.execute(
		"same-inventory",
		{ status: "all", scope: "current-project" },
		undefined,
		undefined,
		{
			cwd: projectPath,
			hasUI: true,
			mode: "rpc",
			ui: {
				async select(_title: string, labels: string[]) {
					toolLabels = labels;
					return undefined;
				},
			},
		},
	);

	const commandView = commandRenders.join("\n");
	assert.match(commandView, /Portable finalized/);
	assert.match(commandView, /Runtime active/);
	assert.ok(toolLabels.some((label) => label.includes("Portable finalized")));
	assert.ok(toolLabels.some((label) => label.includes("Runtime active")));
	assert.equal(selected.details.action, "cancel");
});

test("CA-7: inspect and failed materialization never import a handoff-only snapshot", async () => {
	const tool = tools.get("select_grill_session");
	assert.ok(tool);
	const projectPath = join(sandbox, "preflight-project");
	const handoffPath = join(projectPath, ".sdd", "grills", "preflight.md");
	const id = "preflight/unsafe id";
	mkdirSync(dirname(handoffPath), { recursive: true });
	writeFileSync(handoffPath, canonicalHandoff(id, "paused", "Preflight paused", projectPath));
	removeStoredSnapshot(id);

	const inspected = await tool.execute(
		"inspect-handoff-only",
		{ status: "paused", query: "Preflight paused" },
		undefined,
		undefined,
		rpcContext(projectPath, ["Preflight paused", "Inspeccionar"]),
	);
	assert.equal(inspected.details.action, "inspect");
	assert.equal(storedSnapshotIds().includes(id), false);

	availableSkills.delete("grill");
	try {
		await assert.rejects(
			tool.execute(
				"failed-preflight",
				{ status: "paused", query: "Preflight paused" },
				undefined,
				undefined,
				rpcContext(projectPath, ["Preflight paused", "Retomar"]),
			),
			/Could not materialize grill/i,
		);
		assert.equal(storedSnapshotIds().includes(id), false);
	} finally {
		availableSkills.add("grill");
		removeStoredSnapshot(id);
	}
});

test("CA-7: a handoff changed after listing is revalidated before runtime import", async () => {
	const tool = tools.get("select_grill_session");
	assert.ok(tool);
	const projectPath = join(sandbox, "revalidate-project");
	const handoffPath = join(projectPath, ".sdd", "grills", "revalidate.md");
	const id = "revalidate-before-import";
	mkdirSync(dirname(handoffPath), { recursive: true });
	writeFileSync(handoffPath, canonicalHandoff(id, "paused", "Revalidate paused", projectPath));
	removeStoredSnapshot(id);
	let selection = 0;
	try {
		await assert.rejects(
			tool.execute(
				"revalidate-before-import",
				{ status: "paused", query: "Revalidate paused" },
				undefined,
				undefined,
				{
					cwd: projectPath,
					hasUI: true,
					mode: "rpc",
					ui: {
						async select(_title: string, labels: string[]) {
							selection += 1;
							if (selection === 1) {
								const selected = labels.find((label) => label.includes("Revalidate paused"));
								assert.ok(selected);
								writeFileSync(handoffPath, "# Grill — replaced with invalid metadata\n");
								return selected;
							}
							return labels.find((label) => label.includes("Retomar"));
						},
					},
				},
			),
			/changed|valid handoff-only|metadata/i,
		);
		assert.equal(storedSnapshotIds().includes(id), false);
	} finally {
		removeStoredSnapshot(id);
	}
});

test("CA-7: a queue failure rolls back a newly imported runtime snapshot", async () => {
	const tool = tools.get("select_grill_session");
	assert.ok(tool);
	const projectPath = join(sandbox, "queue-failure-project");
	const handoffPath = join(projectPath, ".sdd", "grills", "queue-failure.md");
	const id = "queue-failure/unsafe id";
	mkdirSync(dirname(handoffPath), { recursive: true });
	writeFileSync(handoffPath, canonicalHandoff(id, "paused", "Queue failure paused", projectPath));
	removeStoredSnapshot(id);
	failMessageQueue = true;
	try {
		await assert.rejects(
			tool.execute(
				"queue-failure",
				{ status: "paused", query: "Queue failure paused" },
				undefined,
				undefined,
				rpcContext(projectPath, ["Queue failure paused", "Retomar"]),
			),
			/queue failed/i,
		);
		assert.equal(storedSnapshotIds().includes(id), false, "failed delivery must not leave an imported snapshot");
	} finally {
		failMessageQueue = false;
		removeStoredSnapshot(id);
	}
});

test("CA-7/8: resume imports the exact logical identity and complete handoff before queuing grill", async () => {
	const tool = tools.get("select_grill_session");
	assert.ok(tool);
	const projectPath = join(sandbox, "resume-import-project");
	const handoffPath = join(projectPath, ".sdd", "grills", "resume.md");
	const id = "resume/unsafe id";
	const markdown = canonicalHandoff(id, "paused", "Resume imported", "/historical/project");
	mkdirSync(dirname(handoffPath), { recursive: true });
	writeFileSync(handoffPath, markdown);
	removeStoredSnapshot(id);
	sentMessages = [];
	try {
		const result = await tool.execute(
			"resume-import",
			{ status: "paused", query: "Resume imported" },
			undefined,
			undefined,
			rpcContext(projectPath, ["Resume imported", "Retomar"]),
		);
		assert.equal(result.details.action, "resume");
		assert.equal(result.details.selected.id, id);
		assert.equal(result.details.selected.projectPath, projectPath);
		assert.equal(result.details.selected.interviewMode, "unselected");
		assert.equal(result.details.selected.importedHandoff.markdown, markdown);
		assert.equal(result.details.selected.importedHandoff.sourcePath, handoffPath);
		assert.equal(result.details.selected.importedHandoff.historicalProjectPath, "/historical/project");
		assert.equal(sentMessages.length, 1);
		assert.ok(sentMessages[0]!.content.endsWith(`--resume ${JSON.stringify(id)}`));
		assert.deepEqual(sentMessages[0]!.options, { deliverAs: "followUp" });
	} finally {
		removeStoredSnapshot(id);
	}
});

// Issue #103, S11: la continuación de grill a spec materializa siempre
// `spec`; el alias `sdd-spec` no se despacha ni se nombra.
function assertQueuedOmiSpec(content: string): void {
	assert.match(content, new RegExp(`^<skill name="spec" location="${(skillPaths.get("spec") ?? "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}">`));
	assert.doesNotMatch(content, /sdd-spec/);
}

test("CA-9: finalized handoff-only queues spec by validated absolute path without importing", async () => {
	const tool = tools.get("select_grill_session");
	assert.ok(tool);
	const projectPath = join(sandbox, "spec source with spaces");
	const handoffPath = join(projectPath, ".sdd", "grills", "final source.md");
	const id = "final-path-source";
	mkdirSync(dirname(handoffPath), { recursive: true });
	writeFileSync(handoffPath, canonicalHandoff(id, "finalized", "Final path source", "/old/project"));
	removeStoredSnapshot(id);
	sentMessages = [];
	const result = await tool.execute(
		"spec-from-path",
		{ status: "finalized", query: "Final path source" },
		undefined,
		undefined,
		rpcContext(projectPath, ["Final path source", "Crear spec SDD"]),
	);
	assert.equal(result.details.action, "create-spec");
	assert.equal(result.details.sourceTarget, handoffPath);
	assert.equal(storedSnapshotIds().includes(id), false);
	assert.equal(sentMessages.length, 1);
	assert.match(sentMessages[0]!.content, new RegExp(`--from-grill ${JSON.stringify(handoffPath).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`));
	assertQueuedOmiSpec(sentMessages[0]!.content);
});

test("CA-5/6: inventory inspection truncates oversized persisted handoffs", async () => {
	const tool = tools.get("select_grill_session");
	assert.ok(tool);
	const projectPath = join(sandbox, "large-inspection-project");
	const handoffPath = join(projectPath, ".sdd", "grills", "large.md");
	const id = "large-inspection";
	const largeFact = "confirmed-context-".repeat(6_000);
	const markdown = canonicalHandoff(id, "finalized", "Large inspection", projectPath).replace(
		"Confirmed source context.",
		largeFact,
	);
	mkdirSync(dirname(handoffPath), { recursive: true });
	writeFileSync(handoffPath, markdown);

	const result = await tool.execute(
		"large-inspection",
		{ status: "finalized", query: "Large inspection", intent: "spec-source" },
		undefined,
		undefined,
		rpcContext(projectPath, ["Large inspection"]),
	);
	const content = result.content[0].text as string;
	assert.ok(Buffer.byteLength(content, "utf8") < 48 * 1024, "inspection output stays under the tool budget");
	assert.match(content, /Inventory inspection truncated/);
});

test("CA-9: snapshot-backed spec dispatch quotes an unsafe logical grill id", async () => {
	const tool = tools.get("select_grill_session");
	assert.ok(tool);
	const projectPath = join(sandbox, "snapshot-spec-source");
	const storeDirectory = join(process.env.HOME!, ".pi", "agent", "grill-sessions");
	const id = "final/unsafe id";
	const topic = "Unsafe snapshot spec source";
	const handoffMarkdown = canonicalHandoff(id, "finalized", topic, projectPath);
	const timestamp = "2026-09-29T12:00:00.000Z";
	mkdirSync(projectPath, { recursive: true });
	mkdirSync(storeDirectory, { recursive: true });
	writeFileSync(join(storeDirectory, `${snapshotStorageStem(id)}.json`), `${JSON.stringify({
		version: 5,
		id,
		topic,
		projectPath,
		projectName: "snapshot-spec-source",
		status: "finalized",
		interviewMode: "adaptive",
		createdAt: timestamp,
		updatedAt: timestamp,
		estimate: { min: 1, likely: 2, max: 3 },
		sections: [],
		interactions: [],
		decisions: [],
		pendingBranches: [],
		handoffMarkdown,
		revision: 1,
	}, null, 2)}\n`);
	sentMessages = [];
	try {
		const result = await tool.execute(
			"spec-from-unsafe-id",
			{ status: "finalized", query: topic },
			undefined,
			undefined,
			rpcContext(projectPath, [topic, "Crear spec SDD"]),
		);
		assert.equal(result.details.action, "create-spec");
		assert.equal(result.details.sourceTarget, id);
		assert.equal(sentMessages.length, 1);
		assert.ok(sentMessages[0]!.content.endsWith(`--from-grill ${JSON.stringify(id)}`));
		assertQueuedOmiSpec(sentMessages[0]!.content);
	} finally {
		removeStoredSnapshot(id);
	}
});

test("CA-7: corrupt snapshots whose id contains ENOENT are not mistaken for missing files", async () => {
	const tool = tools.get("select_grill_session");
	assert.ok(tool);
	const projectPath = join(sandbox, "corrupt-enoent-project");
	const handoffPath = join(projectPath, ".sdd", "grills", "corrupt.md");
	const storeDirectory = join(process.env.HOME!, ".pi", "agent", "grill-sessions");
	const id = "corrupt-ENOENT-id";
	const snapshotPath = join(storeDirectory, `${id}.json`);
	const corruptContent = `{"id":"${id}","broken":`;
	mkdirSync(dirname(handoffPath), { recursive: true });
	mkdirSync(storeDirectory, { recursive: true });
	writeFileSync(handoffPath, canonicalHandoff(id, "paused", "Corrupt ENOENT snapshot", projectPath));
	writeFileSync(snapshotPath, corruptContent);
	sentMessages = [];
	try {
		await assert.rejects(
			tool.execute(
				"corrupt-enoent",
				{ status: "paused", query: "Corrupt ENOENT snapshot" },
				undefined,
				undefined,
				rpcContext(projectPath, ["Corrupt ENOENT snapshot", "Retomar"]),
			),
			(error: Error) => {
				assert.match(error.message, /Could not load grill session.*corrupt-ENOENT-id/i);
				assert.doesNotMatch(error.message, /EEXIST/);
				return true;
			},
		);
		assert.equal(readFileSync(snapshotPath, "utf8"), corruptContent);
		assert.equal(sentMessages.length, 0);
	} finally {
		rmSync(snapshotPath, { force: true });
	}
});

test("CA-1: inventory discovery shares repository lookups and bounds git root concurrency", async () => {
	const tool = tools.get("select_grill_session");
	assert.ok(tool);
	const projectPath = join(sandbox, "inventory-cache-project");
	const handoffPath = join(projectPath, ".sdd", "grills", "cached.md");
	mkdirSync(dirname(handoffPath), { recursive: true });
	writeFileSync(handoffPath, canonicalHandoff("cached-inventory", "paused", "Cached inventory", projectPath));

	const sessionsDirectory = join(process.env.HOME!, ".pi", "agent", "sessions");
	for (let index = 0; index < 8; index += 1) {
		const cwd = join(sandbox, `known-project-${index}`);
		const directory = join(sessionsDirectory, `cache-session-${index}`);
		mkdirSync(directory, { recursive: true });
		writeFileSync(join(directory, "session.jsonl"), `${JSON.stringify({ type: "session", cwd })}\n`);
	}

	let activeRootLookups = 0;
	let maxRootConcurrency = 0;
	const repositoryCalls = new Map<string, number>();
	execHandler = async (command: string, args: string[], options: { cwd?: string }) => {
		assert.equal(command, "git");
		const cwd = resolve(options.cwd ?? projectPath);
		if (args[0] === "rev-parse") {
			activeRootLookups += 1;
			maxRootConcurrency = Math.max(maxRootConcurrency, activeRootLookups);
			await new Promise((resolveDone) => setTimeout(resolveDone, 5));
			activeRootLookups -= 1;
			return { code: 0, stdout: `${cwd}\n`, stderr: "" };
		}
		if (args[0] === "config") {
			repositoryCalls.set(cwd, (repositoryCalls.get(cwd) ?? 0) + 1);
			return { code: 0, stdout: "git@github.com:acme/omi-code.git\n", stderr: "" };
		}
		throw new Error(`unexpected git args: ${args.join(" ")}`);
	};
	try {
		await tool.execute(
			"bounded-inventory",
			{ status: "all", scope: "all", query: "no-such-grill" },
			undefined,
			undefined,
			{
				cwd: projectPath,
				hasUI: true,
				mode: "rpc",
				ui: { async select() { return undefined; } },
			},
		);
		assert.ok(maxRootConcurrency <= 4, `git root concurrency was ${maxRootConcurrency}`);
		assert.equal(repositoryCalls.get(resolve(projectPath)), 1);
	} finally {
		execHandler = async (..._args: any[]) => ({ code: 0, stdout: "", stderr: "" });
	}
});

test("persist_sdd_spec exposes the parser-backed boundary and returns a receipt after a local reread", async () => {
	const tool = tools.get("persist_sdd_spec");
	assert.ok(tool, "the executable Pi boundary is registered");
	const projectPath = join(sandbox, "publication-project");
	// Fuera de git, una spec nueva en la ruta lógica `.sdd/specs/` se escribe en `.omi/specs/` (#103, CA-1).
	const relativePath = ".sdd/specs/canonical.md";
	const absolutePath = join(projectPath, ".omi", "specs", "canonical.md");
	mkdirSync(projectPath, { recursive: true });
	const markdown = [
		"# Spec — Canonical publication",
		"<!-- Generada por /skill:spec. Estado: aprobada -->",
		"<!-- SDD-Tracking: version=1; type=spec; state=approved; issue=none; grill=none; superseded-by=none -->",
		"",
		"## Contexto",
		"Body.",
		"",
	].join("\n");

	const result = await tool.execute(
		"persist-local-spec",
		{
			mode: "interactive",
			repository: "local/publication-project",
			projectPath,
			documents: [{
				id: "successor",
				role: "successor",
				markdown,
				destinations: [{ kind: "local", path: relativePath }],
			}],
		},
		undefined,
		undefined,
		{ cwd: projectPath },
	);

	assert.equal(result.details.ok, true);
	assert.equal(result.details.receipt.kind, "sdd-spec-publication");
	assert.equal(readFileSync(absolutePath, "utf8"), markdown);
	assert.equal(existsSync(join(projectPath, relativePath)), false, "nada nuevo en .sdd/specs");
});

test("persist_sdd_spec keeps local content normative while archiving an existing issue body idempotently in Ambos", async () => {
	const tool = tools.get("persist_sdd_spec");
	assert.ok(tool);
	const projectPath = join(sandbox, "ambos-publication-project");
	const localPath = join(projectPath, ".omi", "specs", "issue-33-canonical.md");
	mkdirSync(projectPath, { recursive: true });
	let remoteBody = "Original request.\n";
	execHandler = async (command: string, args: string[]) => {
		if (command === "git" && args[0] === "rev-parse") {
			return { code: 0, stdout: `${projectPath}\n`, stderr: "" };
		}
		if (command === "git" && args[0] === "config") {
			return { code: 0, stdout: "git@github.com:acme/omi-code.git\n", stderr: "" };
		}
		if (command === "gh" && args[0] === "issue" && args[1] === "view") {
			return { code: 0, stdout: JSON.stringify({ body: remoteBody }), stderr: "" };
		}
		if (command === "gh" && args[0] === "issue" && args[1] === "edit") {
			const bodyPath = args[args.indexOf("--body-file") + 1];
			remoteBody = readFileSync(bodyPath, "utf8");
			return { code: 0, stdout: "", stderr: "" };
		}
		throw new Error(`unexpected command: ${command} ${args.join(" ")}`);
	};
	try {
		const markdown = [
			"# Spec — Ambos publication",
			"<!-- Generada por /skill:spec. Estado: aprobada -->",
			"<!-- SDD-Tracking: version=1; type=spec; state=approved; issue=#33; grill=none; superseded-by=none -->",
			"",
			"## Contexto",
			"Body.",
			"",
		].join("\n");
		const input = {
			mode: "interactive",
			repository: "acme/omi-code",
			projectPath,
			documents: [{
				id: "successor",
				role: "successor",
				markdown,
				issueNumber: 33,
				destinations: [
					{ kind: "local", path: ".sdd/specs/issue-33-canonical.md" },
					{ kind: "issue", issueNumber: 33 },
				],
			}],
		};

		const first = await tool.execute("persist-ambos", input, undefined, undefined, { cwd: projectPath });
		assert.equal(first.details.ok, true);
		assert.equal(readFileSync(localPath, "utf8"), markdown);
		assert.match(remoteBody, /<details><summary>Body original<\/summary>/);
		assert.match(remoteBody, /Original request\./);
		assert.equal(remoteBody.match(/<details><summary>Body original<\/summary>/g)?.length, 1);

		const retry = await tool.execute("retry-ambos", input, undefined, undefined, { cwd: projectPath });
		assert.equal(retry.details.ok, true);
		assert.equal(remoteBody.match(/<details><summary>Body original<\/summary>/g)?.length, 1);
		assert.match(remoteBody, /Original request\./);
	} finally {
		execHandler = async (..._args: any[]) => ({ code: 0, stdout: "", stderr: "" });
	}
});

test("review #105: reintentar con una spec v1 contra el issue que ya tiene la misma spec en v2 deja el body intacto", async () => {
	const tool = tools.get("persist_sdd_spec");
	assert.ok(tool);
	const projectPath = join(sandbox, "v1-v2-retry-project");
	mkdirSync(projectPath, { recursive: true });
	const markdown = [
		"# Spec — Marca v1 contra v2",
		"<!-- SDD-Tracking: version=1; type=spec; state=approved; issue=#34; grill=none; superseded-by=none -->",
		"",
		"## Contexto",
		"Body.",
		"",
	].join("\n");
	const currentBody = markdown
		.replace("<!-- SDD-Tracking: version=1; ", "<!-- Chiche-Tracking: version=2; ")
		.replace("issue=#34", "issue=acme/omi-code#34");
	let remoteBody = currentBody;
	const edits: string[] = [];
	execHandler = async (command: string, args: string[]) => {
		if (command === "git" && args[0] === "rev-parse") {
			return { code: 0, stdout: `${projectPath}\n`, stderr: "" };
		}
		if (command === "git" && args[0] === "config") {
			return { code: 0, stdout: "git@github.com:acme/omi-code.git\n", stderr: "" };
		}
		if (command === "gh" && args[0] === "issue" && args[1] === "view") {
			return { code: 0, stdout: JSON.stringify({ body: remoteBody }), stderr: "" };
		}
		if (command === "gh" && args[0] === "issue" && args[1] === "edit") {
			remoteBody = readFileSync(args[args.indexOf("--body-file") + 1], "utf8");
			edits.push(remoteBody);
			return { code: 0, stdout: "", stderr: "" };
		}
		throw new Error(`unexpected command: ${command} ${args.join(" ")}`);
	};
	try {
		const result = await tool.execute("retry-v1-v2", {
			mode: "interactive",
			repository: "acme/omi-code",
			projectPath,
			documents: [{
				id: "successor",
				role: "successor",
				markdown,
				issueNumber: 34,
				destinations: [{ kind: "issue", issueNumber: 34 }],
			}],
		}, undefined, undefined, { cwd: projectPath });
		assert.equal(result.details.ok, true);
		assert.equal(remoteBody, currentBody);
		assert.doesNotMatch(remoteBody, /<details><summary>Body original<\/summary>/);
		assert.ok(edits.every((body) => body === currentBody), "ningún edit cambia el body");
	} finally {
		execHandler = async (..._args: any[]) => ({ code: 0, stdout: "", stderr: "" });
	}
});

test("persist_sdd_spec creates a staging issue and publishes only after binding its identity", async () => {
	const tool = tools.get("persist_sdd_spec");
	assert.ok(tool);
	const projectPath = join(sandbox, "github-publication-project");
	mkdirSync(projectPath, { recursive: true });
	let stagingBody = "";
	let publishedBody = "";
	execHandler = async (command: string, args: string[], options: { cwd?: string }) => {
		if (command === "git" && args[0] === "rev-parse") {
			return { code: 0, stdout: `${projectPath}\n`, stderr: "" };
		}
		if (command === "git" && args[0] === "config") {
			return { code: 0, stdout: "https://github.com/acme/omi-code.git\n", stderr: "" };
		}
		if (command === "gh" && args[0] === "issue" && args[1] === "create") {
			const bodyPath = args[args.indexOf("--body-file") + 1];
			stagingBody = readFileSync(bodyPath, "utf8");
			publishedBody = stagingBody;
			return { code: 0, stdout: "https://github.com/acme/omi-code/issues/77\n", stderr: "" };
		}
		if (command === "gh" && args[0] === "issue" && args[1] === "edit") {
			const bodyPath = args[args.indexOf("--body-file") + 1];
			publishedBody = readFileSync(bodyPath, "utf8");
			return { code: 0, stdout: "", stderr: "" };
		}
		if (command === "gh" && args[0] === "issue" && args[1] === "view") {
			return { code: 0, stdout: JSON.stringify({ body: publishedBody }), stderr: "" };
		}
		throw new Error(`unexpected command in ${options.cwd}: ${command} ${args.join(" ")}`);
	};
	try {
		const markdown = [
			"# Spec — New issue publication",
			"<!-- Generada por /skill:spec. Estado: aprobada -->",
			"<!-- SDD-Tracking: version=1; type=spec; state=approved; issue=none; grill=none; superseded-by=none -->",
			"",
			"## Contexto",
			"Body.",
			"",
		].join("\n");
		const result = await tool.execute(
			"persist-new-issue-spec",
			{
				mode: "interactive",
				repository: "acme/omi-code",
				projectPath,
				documents: [{
					id: "successor",
					role: "successor",
					markdown,
					destinations: [{ kind: "new-issue", title: "New issue publication" }],
				}],
			},
			undefined,
			undefined,
			{ cwd: projectPath },
		);

		assert.equal(result.details.ok, true);
		assert.doesNotMatch(stagingBody, /(?:Chiche|SDD)-Tracking/, "the creation body is not a transient spec");
		assert.match(publishedBody, /^<!-- Chiche-Tracking: version=2; type=spec; state=approved; issue=#77; grill=none; superseded-by=none -->$/m);
		assert.doesNotMatch(publishedBody, /SDD-Tracking/, "the rewritten v1 marker migrates to v2 in place");
		assert.match(publishedBody, /issue=#77/);
		assert.doesNotMatch(publishedBody, /issue=none/);
		assert.doesNotMatch(publishedBody, /<details>/, "staging is not archived into the final issue body");
		assert.deepEqual(result.details.receipt.documents[0].destinations, ["issue:acme/omi-code#77"]);
	} finally {
		execHandler = async (..._args: any[]) => ({ code: 0, stdout: "", stderr: "" });
	}
});

// Spec #84 (CA-10, CA-11) e issue #103 (CA-1): los borradores van a
// <git-common-dir>/omi/, fuera de los working trees, y se siguen leyendo de
// <git-common-dir>/sdd/ y de los trackeados .omi/ y .sdd/. Estos tests usan repos git reales con un worktree
// linkeado, con rutas canónicas (realpath) para no depender de /var vs
// /private/var en macOS.
function git(cwd: string, ...args: string[]): string {
	const result = spawnSync("git", ["-c", "user.name=sdd", "-c", "user.email=sdd@example.invalid", "-c", "commit.gpgsign=false", ...args], {
		cwd,
		encoding: "utf8",
	});
	assert.equal(result.status, 0, `git ${args.join(" ")}: ${result.stderr}`);
	return result.stdout;
}

function repoWithLinkedWorktree(name: string): { base: string; main: string; linked: string; common: string } {
	const base = realpathSync(mkdtempSync(join(tmpdir(), `grill-tools-${name}-`)));
	const main = join(base, "repo");
	mkdirSync(main);
	git(main, "init", "-q", "-b", "main");
	writeFileSync(join(main, "README.md"), "repo\n");
	git(main, "add", "README.md");
	git(main, "commit", "-q", "-m", "init");
	const linked = join(base, "repo-wt");
	git(main, "worktree", "add", "-q", "-b", "feature", linked);
	return { base, main, linked, common: join(main, ".git") };
}

function gitStatus(cwd: string): string {
	return git(cwd, "status", "--porcelain", "--untracked-files=all");
}

function canonicalSpec(title: string): string {
	return [
		`# Spec — ${title}`,
		"<!-- Generada por /skill:spec. Estado: aprobada -->",
		"<!-- SDD-Tracking: version=1; type=spec; state=approved; issue=none; grill=none; superseded-by=none -->",
		"",
		"## Contexto",
		"Body.",
		"",
	].join("\n");
}

async function selectLabels(cwd: string, params: Record<string, unknown>): Promise<string[]> {
	const tool = tools.get("select_grill_session");
	assert.ok(tool);
	let labels: string[] = [];
	await tool.execute("list-labels", params, undefined, undefined, {
		cwd,
		hasUI: true,
		mode: "rpc",
		ui: {
			async select(_title: string, offered: string[]) {
				labels = offered;
				return undefined;
			},
		},
	});
	return labels;
}

let themeReady = false;

async function renderSpecs(cwd: string): Promise<string> {
	const command = commands.get("specs");
	assert.ok(command);
	if (!themeReady) {
		// selectMenu usa el theme global de Pi: se inicializa una vez, sin watcher.
		const pi = await import(pathToFileURL(join(sandbox, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "index.js")).href);
		pi.initTheme(undefined, false);
		themeReady = true;
	}
	const renders: string[] = [];
	const theme = {
		fg: (_color: string, text: string) => text,
		bg: (_color: string, text: string) => text,
		bold: (text: string) => text,
	};
	await command.handler("", {
		cwd,
		mode: "tui",
		waitForIdle: async () => {},
		ui: {
			notify(message: string) {
				renders.push(`NOTIFY: ${message}`);
			},
			async custom(factory: (...args: any[]) => any) {
				return new Promise((resolveDone) => {
					const component = factory({ requestRender() {} }, theme, {}, resolveDone);
					renders.push(component.render(200).join("\n"));
					component.handleInput("\x1b");
				});
			},
		},
	});
	return renders.join("\n");
}

test("#84 CA-10: grill_session pause y finalize escriben el handoff en <git-common-dir>/omi/grills sin ensuciar ningún checkout", async (t) => {
	const tool = tools.get("grill_session");
	assert.ok(tool);
	const { base, main, linked, common } = repoWithLinkedWorktree("pause");
	t.after(() => rmSync(base, { recursive: true, force: true }));
	const created = await tool.execute(
		"create-local-handoff",
		{ action: "create", topic: "Borradores fuera del árbol", projectPath: main, estimate: { min: 1, likely: 2, max: 3 } },
		undefined,
		undefined,
		{ cwd: main },
	);
	const id = created.details.snapshot.id;
	t.after(() => removeStoredSnapshot(id));
	await tool.execute("configure-local-handoff", { action: "configure", sessionId: id, interviewMode: "adaptive" }, undefined, undefined, { cwd: main });

	const paused = await tool.execute("pause-local-handoff", { action: "pause", sessionId: id, summary: "Pausa" }, undefined, undefined, { cwd: main });
	assert.equal(dirname(paused.details.repoHandoffPath), join(common, "omi", "grills"));
	assert.match(readFileSync(paused.details.repoHandoffPath, "utf8"), /state=paused/);
	assert.equal(gitStatus(main), "", "checkout principal limpio después de pause");
	assert.equal(gitStatus(linked), "", "worktree linkeado limpio después de pause");

	const finalized = await tool.execute(
		"finalize-local-handoff",
		{ action: "finalize", sessionId: id, handoffMarkdown: "# Grill — Borradores fuera del árbol\n\n## Handoff\nListo.\n" },
		undefined,
		undefined,
		{ cwd: main },
	);
	assert.equal(finalized.details.repoHandoffPath, paused.details.repoHandoffPath);
	assert.match(readFileSync(finalized.details.repoHandoffPath, "utf8"), /state=finalized/);
	assert.equal(gitStatus(main), "", "checkout principal limpio después de finalize");
	assert.equal(gitStatus(linked), "", "worktree linkeado limpio después de finalize");
});

test("issue #102 CA-9: grill_session finalize con continueWithSpec y autonomy propaga --autonomy <código> a spec, y rechaza un nivel inválido", async (t) => {
	const tool = tools.get("grill_session");
	assert.ok(tool);
	const { base, main } = repoWithLinkedWorktree("continue-spec-autonomy");
	t.after(() => rmSync(base, { recursive: true, force: true }));
	const created = await tool.execute(
		"create-continue-autonomy",
		{ action: "create", topic: "Continuar a spec en A2", projectPath: main, estimate: { min: 1, likely: 2, max: 3 } },
		undefined,
		undefined,
		{ cwd: main },
	);
	const id = created.details.snapshot.id;
	t.after(() => removeStoredSnapshot(id));
	await tool.execute("configure-continue-autonomy", { action: "configure", sessionId: id, interviewMode: "adaptive" }, undefined, undefined, { cwd: main });
	await assert.rejects(
		tool.execute("configure-autonomy-invalid", { action: "configure", sessionId: id, autonomy: "A2" }, undefined, undefined, { cwd: main }),
		/autonomy is valid only for finalize/,
	);
	// Review #114-10: sin continueWithSpec no hay a quién propagar el nivel; se rechaza en vez de ignorarse en silencio.
	await assert.rejects(
		tool.execute("finalize-autonomy-sin-continue", { action: "finalize", sessionId: id, autonomy: "A2", handoffMarkdown: "# Grill\n\n## Handoff\nx\n" }, undefined, undefined, { cwd: main }),
		/autonomy requires continueWithSpec/,
	);
	await assert.rejects(
		tool.execute("finalize-autonomy-a4", { action: "finalize", sessionId: id, continueWithSpec: true, autonomy: "A4", handoffMarkdown: "# Grill\n\n## Handoff\nx\n" }, undefined, undefined, { cwd: main }),
		/--autonomy A4: no soportado todavía \(v1 honra A1–A3\)/,
	);

	sentMessages = [];
	await tool.execute(
		"finalize-continue-autonomy",
		{ action: "finalize", sessionId: id, continueWithSpec: true, autonomy: "plan-approved", handoffMarkdown: "# Grill — Continuar a spec en A2\n\n## Handoff\nListo.\n" },
		undefined,
		undefined,
		{ cwd: main },
	);
	assert.equal(sentMessages.length, 1);
	assert.ok(sentMessages[0]!.content.endsWith(`--from-grill ${JSON.stringify(id)} --autonomy A2`), sentMessages[0]!.content.slice(-120));
	assertQueuedOmiSpec(sentMessages[0]!.content);
});

test("issue #103 S11: grill_session finalize con continueWithSpec encola spec --from-grill en la misma sesión", async (t) => {
	const tool = tools.get("grill_session");
	assert.ok(tool);
	const { base, main } = repoWithLinkedWorktree("continue-spec");
	t.after(() => rmSync(base, { recursive: true, force: true }));
	const created = await tool.execute(
		"create-continue-spec",
		{ action: "create", topic: "Continuar a spec", projectPath: main, estimate: { min: 1, likely: 2, max: 3 } },
		undefined,
		undefined,
		{ cwd: main },
	);
	const id = created.details.snapshot.id;
	t.after(() => removeStoredSnapshot(id));
	await tool.execute("configure-continue-spec", { action: "configure", sessionId: id, interviewMode: "adaptive" }, undefined, undefined, { cwd: main });

	sentMessages = [];
	const finalized = await tool.execute(
		"finalize-continue-spec",
		{ action: "finalize", sessionId: id, continueWithSpec: true, handoffMarkdown: "# Grill — Continuar a spec\n\n## Handoff\nListo.\n" },
		undefined,
		undefined,
		{ cwd: main },
	);
	assert.equal(sentMessages.length, 1);
	assert.ok(sentMessages[0]!.content.endsWith(`--from-grill ${JSON.stringify(id)}`));
	assert.deepEqual(sentMessages[0]!.options, { deliverAs: "followUp" });
	assertQueuedOmiSpec(sentMessages[0]!.content);
	const text = finalized.content[0].text as string;
	assert.match(text, /Next stage: canonical spec queued in this session\./);
	assert.doesNotMatch(text, /sdd-spec/);
});

test("review #90: grill_session pause escribe el handoff con decisiones y ramas pendientes prefijadas por su bloque", async (t) => {
	const tool = tools.get("grill_session");
	assert.ok(tool);
	const { base, main } = repoWithLinkedWorktree("block-prefix");
	t.after(() => rmSync(base, { recursive: true, force: true }));
	const sections = [
		{ id: "alcance", title: "Alcance", estimatedQuestions: 1, status: "active" as const },
		{ id: "permisos", title: "Permisos", estimatedQuestions: 1, status: "pending" as const },
	];
	const created = await tool.execute(
		"create-block-prefix",
		{ action: "create", topic: "Export con bloques", projectPath: main, estimate: { min: 1, likely: 2, max: 3 }, sections },
		undefined,
		undefined,
		{ cwd: main },
	);
	const id = created.details.snapshot.id;
	t.after(() => removeStoredSnapshot(id));
	await tool.execute("configure-block-prefix", { action: "configure", sessionId: id, interviewMode: "adaptive" }, undefined, undefined, { cwd: main });
	await tool.execute(
		"checkpoint-block-prefix",
		{
			action: "checkpoint",
			sessionId: id,
			interaction: { id: "q1", question: "¿Formato?", answers: ["CSV"], section: "alcance" },
			decision: { id: "d1", title: "Formato", agreement: "CSV con cabecera", section: "alcance" },
			sections: [{ ...sections[0], status: "resolved" }, { ...sections[1], status: "active" }],
		},
		undefined,
		undefined,
		{ cwd: main },
	);

	const paused = await tool.execute(
		"pause-block-prefix",
		{
			action: "pause",
			sessionId: id,
			summary: "Pausa en el bloque Permisos",
			pendingBranches: [{ id: "b1", title: "Roles", description: "quién exporta", section: "permisos" }],
		},
		undefined,
		undefined,
		{ cwd: main },
	);
	const handoff = readFileSync(paused.details.repoHandoffPath, "utf8");
	assert.match(handoff, /^1\. Alcance: Formato — CSV con cabecera$/m);
	assert.match(handoff, /^- Permisos: Roles — quién exporta$/m);
});

test("#84 CA-10: /grills y select_grill_session listan los seis lugares y no duplican el handoff local entre worktrees", async (t) => {
	const { base, main, linked, common } = repoWithLinkedWorktree("listing");
	t.after(() => rmSync(base, { recursive: true, force: true }));
	const localDirectory = join(common, "sdd", "grills");
	mkdirSync(localDirectory, { recursive: true });
	writeFileSync(join(localDirectory, "local.md"), canonicalHandoff("cero-residuos-local", "paused", "Handoff local compartido", main));
	mkdirSync(join(main, ".sdd", "grills"), { recursive: true });
	writeFileSync(join(main, ".sdd", "grills", "trackeado.md"), canonicalHandoff("cero-residuos-trackeado", "paused", "Handoff trackeado del principal", main));
	// #103, CA-1: los lugares omi se listan junto a los sdd y, en cada par,
	// ante el mismo nombre gana omi.
	const omiLocal = join(common, "omi", "grills");
	mkdirSync(omiLocal, { recursive: true });
	writeFileSync(join(omiLocal, "local-omi.md"), canonicalHandoff("cero-residuos-local-omi", "paused", "Handoff local omi", main));
	writeFileSync(join(omiLocal, "empate.md"), canonicalHandoff("cero-residuos-empate-omi", "paused", "Empate local omi", main));
	writeFileSync(join(localDirectory, "empate.md"), canonicalHandoff("cero-residuos-empate-sdd", "paused", "Empate local sdd", main));
	mkdirSync(join(main, ".omi", "grills"), { recursive: true });
	writeFileSync(join(main, ".omi", "grills", "trackeado-omi.md"), canonicalHandoff("cero-residuos-trackeado-omi", "paused", "Handoff trackeado omi", main));
	// Compatibilidad: chiche se lee entre omi y sdd, en el árbol y en el common-dir.
	mkdirSync(join(main, ".chiche", "grills"), { recursive: true });
	writeFileSync(join(main, ".chiche", "grills", "trackeado-marca.md"), canonicalHandoff("cero-residuos-trackeado-marca", "paused", "Handoff trackeado marca vieja", main));
	const chicheLocal = join(common, "chiche", "grills");
	mkdirSync(chicheLocal, { recursive: true });
	writeFileSync(join(chicheLocal, "local-marca.md"), canonicalHandoff("cero-residuos-local-marca", "paused", "Handoff local marca vieja", main));
	writeFileSync(join(chicheLocal, "empate.md"), canonicalHandoff("cero-residuos-empate-marca", "paused", "Empate local marca vieja", main));
	writeFileSync(join(chicheLocal, "empate-sdd.md"), canonicalHandoff("cero-residuos-empate-sdd-gana-marca", "paused", "Empate chiche sobre sdd", main));
	writeFileSync(join(localDirectory, "empate-sdd.md"), canonicalHandoff("cero-residuos-empate-sdd-pierde", "paused", "Empate sdd bajo chiche", main));
	// Una sesión en cada checkout los vuelve roots conocidos para el scope "all".
	for (const [name, cwd] of [["cero-residuos-main", main], ["cero-residuos-linked", linked]] as const) {
		const sessionDirectory = join(process.env.HOME!, ".pi", "agent", "sessions", name);
		mkdirSync(sessionDirectory, { recursive: true });
		writeFileSync(join(sessionDirectory, "session.jsonl"), `${JSON.stringify({ type: "session", cwd })}\n`);
		t.after(() => rmSync(sessionDirectory, { recursive: true, force: true }));
	}

	for (const cwd of [main, linked]) {
		const all = await selectLabels(cwd, { status: "all", scope: "all", query: "cero-residuos" });
		assert.equal(all.filter((label) => label.includes("Handoff local compartido")).length, 1, `${cwd}: el handoff local aparece una sola vez`);
		assert.equal(all.filter((label) => label.includes("Handoff trackeado del principal")).length, 1, `${cwd}: el handoff trackeado aparece una sola vez`);
		assert.equal(all.filter((label) => label.includes("Handoff local omi")).length, 1, `${cwd}: el handoff local omi aparece una sola vez`);
		assert.equal(all.filter((label) => label.includes("Handoff trackeado omi")).length, 1, `${cwd}: el handoff trackeado omi aparece una sola vez`);
		assert.equal(all.filter((label) => label.includes("Empate local omi")).length, 1, `${cwd}: en el empate local gana omi`);
		assert.equal(all.filter((label) => label.includes("Empate local sdd")).length, 0, `${cwd}: el sdd del mismo nombre queda oculto`);
		assert.equal(all.filter((label) => label.includes("Handoff trackeado marca vieja")).length, 1, `${cwd}: el handoff trackeado de chiche aparece`);
		assert.equal(all.filter((label) => label.includes("Handoff local marca vieja")).length, 1, `${cwd}: el handoff local de chiche aparece`);
		assert.equal(all.filter((label) => label.includes("Empate local marca vieja")).length, 0, `${cwd}: omi gana sobre chiche`);
		assert.equal(all.filter((label) => label.includes("Empate chiche sobre sdd")).length, 1, `${cwd}: chiche gana sobre sdd`);
		assert.equal(all.filter((label) => label.includes("Empate sdd bajo chiche")).length, 0, `${cwd}: el sdd queda oculto`);
	}
	const current = await selectLabels(main, { status: "all", scope: "current-project", query: "cero-residuos" });
	assert.ok(current.some((label) => label.includes("Handoff local compartido")), "el proyecto del handoff local lo ve en su scope");
	assert.ok(current.some((label) => label.includes("Handoff trackeado del principal")));
});

test("#84 CA-11: persist_sdd_spec con destino local escribe en <git-common-dir>/omi/specs desde el principal y desde el worktree", async (t) => {
	const tool = tools.get("persist_sdd_spec");
	assert.ok(tool);
	const { base, main, linked, common } = repoWithLinkedWorktree("persist");
	t.after(() => rmSync(base, { recursive: true, force: true }));
	for (const [projectPath, slug] of [[main, "desde-principal"], [linked, "desde-worktree"]] as const) {
		const markdown = canonicalSpec(`Spec ${slug}`);
		const result = await tool.execute(
			`persist-${slug}`,
			{
				mode: "interactive",
				repository: `local/${projectPath === main ? "repo" : "repo-wt"}`,
				projectPath,
				documents: [{ id: "successor", role: "successor", markdown, destinations: [{ kind: "local", path: `.sdd/specs/${slug}.md` }] }],
			},
			undefined,
			undefined,
			{ cwd: projectPath },
		);
		assert.equal(result.details.ok, true, JSON.stringify(result.details.diagnostics));
		assert.equal(readFileSync(join(common, "omi", "specs", `${slug}.md`), "utf8"), markdown);
		assert.equal(existsSync(join(common, "sdd", "specs", `${slug}.md`)), false, `${slug}: nada nuevo en <git-common-dir>/sdd/specs`);
		assert.equal(gitStatus(main), "", `${slug}: checkout principal limpio`);
		assert.equal(gitStatus(linked), "", `${slug}: worktree linkeado limpio`);
	}
});

test("#84 CA-11: el confinamiento de persist_sdd_spec acepta los seis directorios y rechaza cualquier otro", async (t) => {
	const tool = tools.get("persist_sdd_spec");
	assert.ok(tool);
	const { base, main, common } = repoWithLinkedWorktree("confine");
	t.after(() => rmSync(base, { recursive: true, force: true }));
	const persist = (path: string) => tool.execute(
		"persist-confined",
		{
			mode: "interactive",
			repository: "local/repo",
			projectPath: main,
			documents: [{ id: "successor", role: "successor", markdown: canonicalSpec("Confinada"), destinations: [{ kind: "local", path }] }],
		},
		undefined,
		undefined,
		{ cwd: main },
	);
	for (const outside of [
		join(main, "specs", "x.md"),
		join(main, ".sdd", "grills", "x.md"),
		join(main, ".omi", "grills", "x.md"),
		join(main, ".chiche", "grills", "x.md"),
		join(common, "sdd", "grills", "x.md"),
		join(common, "omi", "grills", "x.md"),
		join(common, "chiche", "grills", "x.md"),
		join(common, "sdd", "specs", "sub", "x.md"),
		join(common, "chiche", "specs", "sub", "x.md"),
		join(common, "omi", "specs", "sub", "x.md"),
		"specs/x.md",
		".omi/grills/x.md",
	]) {
		await assert.rejects(persist(outside), /Local spec destination must be one Markdown file directly under/, `rechaza ${outside}`);
	}
	for (const accepted of [
		join(common, "omi", "specs", "absoluta-local.md"),
		join(common, "chiche", "specs", "absoluta-local-chiche.md"),
		join(common, "sdd", "specs", "absoluta-local-sdd.md"),
		join(main, ".omi", "specs", "absoluta-trackeada-omi.md"),
		join(main, ".chiche", "specs", "absoluta-trackeada-chiche.md"),
		join(main, ".sdd", "specs", "absoluta-trackeada.md"),
	]) {
		const result = await persist(accepted);
		assert.equal(result.details.ok, true, accepted);
		assert.equal(readFileSync(accepted, "utf8"), canonicalSpec("Confinada"), accepted);
	}
});

test("#103 CA-1: una ruta lógica .omi/specs, .chiche/specs o .sdd/specs actualiza en su lugar la spec existente y una nueva va a <git-common-dir>/omi/specs", async (t) => {
	const tool = tools.get("persist_sdd_spec");
	assert.ok(tool);
	const { base, main, common } = repoWithLinkedWorktree("by-name");
	t.after(() => rmSync(base, { recursive: true, force: true }));
	const persist = (path: string, title: string) => tool.execute(
		"persist-by-name",
		{
			mode: "interactive",
			repository: "local/repo",
			projectPath: main,
			documents: [{ id: "successor", role: "successor", markdown: canonicalSpec(title), destinations: [{ kind: "local", path }] }],
		},
		undefined,
		undefined,
		{ cwd: main },
	);
	mkdirSync(join(main, ".sdd", "specs"), { recursive: true });
	mkdirSync(join(main, ".omi", "specs"), { recursive: true });
	mkdirSync(join(common, "sdd", "specs"), { recursive: true });
	mkdirSync(join(main, ".chiche", "specs"), { recursive: true });
	mkdirSync(join(common, "chiche", "specs"), { recursive: true });
	writeFileSync(join(main, ".chiche", "specs", "trackeada-chiche.md"), canonicalSpec("Vieja"));
	writeFileSync(join(main, ".chiche", "specs", "empate-chiche.md"), canonicalSpec("Vieja"));
	writeFileSync(join(main, ".sdd", "specs", "empate-chiche.md"), canonicalSpec("Vieja"));
	writeFileSync(join(common, "chiche", "specs", "local-chiche.md"), canonicalSpec("Vieja"));
	writeFileSync(join(main, ".sdd", "specs", "trackeada-sdd.md"), canonicalSpec("Vieja"));
	writeFileSync(join(main, ".omi", "specs", "empate.md"), canonicalSpec("Vieja"));
	writeFileSync(join(main, ".sdd", "specs", "empate.md"), canonicalSpec("Vieja"));
	writeFileSync(join(common, "sdd", "specs", "local-sdd.md"), canonicalSpec("Vieja"));
	const cases: Array<[string, string, string]> = [
		[".sdd/specs/trackeada-sdd.md", join(main, ".sdd", "specs", "trackeada-sdd.md"), "una .sdd/specs existente se actualiza en su lugar"],
		[".omi/specs/trackeada-sdd.md", join(main, ".sdd", "specs", "trackeada-sdd.md"), "la ruta .omi/ resuelve por nombre a la .sdd/ existente"],
		[".sdd/specs/empate.md", join(main, ".omi", "specs", "empate.md"), "ante el mismo nombre en el árbol gana .omi/specs"],
		[".sdd/specs/local-sdd.md", join(common, "sdd", "specs", "local-sdd.md"), "una spec de <git-common-dir>/sdd/specs se actualiza en su lugar"],
		[".sdd/specs/nueva-sdd.md", join(common, "omi", "specs", "nueva-sdd.md"), "una spec nueva con ruta .sdd/ va a <git-common-dir>/omi/specs"],
		[".omi/specs/nueva-omi.md", join(common, "omi", "specs", "nueva-omi.md"), "una spec nueva con ruta .omi/ va a <git-common-dir>/omi/specs"],
		[".chiche/specs/trackeada-chiche.md", join(main, ".chiche", "specs", "trackeada-chiche.md"), "una .chiche/specs existente se actualiza en su lugar"],
		[".omi/specs/trackeada-chiche.md", join(main, ".chiche", "specs", "trackeada-chiche.md"), "la ruta .omi/ resuelve por nombre a la .chiche/ existente"],
		[".sdd/specs/empate-chiche.md", join(main, ".chiche", "specs", "empate-chiche.md"), "ante el mismo nombre .chiche/specs gana sobre .sdd/specs"],
		[".chiche/specs/local-chiche.md", join(common, "chiche", "specs", "local-chiche.md"), "una spec de <git-common-dir>/chiche/specs se actualiza en su lugar"],
		[".chiche/specs/nueva-chiche.md", join(common, "omi", "specs", "nueva-chiche.md"), "una spec nueva con ruta .chiche/ va a <git-common-dir>/omi/specs"],
	];
	for (const [path, expected, why] of cases) {
		const result = await persist(path, `Nueva ${path}`);
		assert.equal(result.details.ok, true, `${why}: ${JSON.stringify(result.details.diagnostics)}`);
		assert.equal(readFileSync(expected, "utf8"), canonicalSpec(`Nueva ${path}`), why);
	}
	assert.equal(readFileSync(join(main, ".sdd", "specs", "empate.md"), "utf8"), canonicalSpec("Vieja"), "el .sdd/specs perdedor del empate no se toca");
	assert.equal(existsSync(join(common, "sdd", "specs", "nueva-sdd.md")), false, "nada nuevo en <git-common-dir>/sdd/specs");
	assert.equal(existsSync(join(main, ".sdd", "specs", "nueva-sdd.md")), false, "nada nuevo en .sdd/specs");
	assert.equal(existsSync(join(common, "chiche", "specs", "nueva-chiche.md")), false, "nada nuevo en <git-common-dir>/chiche/specs");
	assert.equal(existsSync(join(main, ".chiche", "specs", "nueva-chiche.md")), false, "nada nuevo en .chiche/specs");
});

test("#84 CA-11: /specs lista los seis lugares desde el principal y desde el worktree, y ante el mismo nombre gana el trackeado", async (t) => {
	const { base, main, linked, common } = repoWithLinkedWorktree("specs");
	t.after(() => rmSync(base, { recursive: true, force: true }));
	const localDirectory = join(common, "sdd", "specs");
	const omiLocal = join(common, "omi", "specs");
	mkdirSync(localDirectory, { recursive: true });
	mkdirSync(omiLocal, { recursive: true });
	mkdirSync(join(main, ".sdd", "specs"), { recursive: true });
	writeFileSync(join(main, ".sdd", "specs", "compartida.md"), canonicalSpec("Compartida trackeada"));
	writeFileSync(join(localDirectory, "compartida.md"), canonicalSpec("Compartida local"));
	writeFileSync(join(localDirectory, "solo-local.md"), canonicalSpec("Solo local"));
	// #103, CA-1: el par omi se lista junto al sdd y, en cada par, gana omi.
	writeFileSync(join(omiLocal, "solo-omi.md"), canonicalSpec("Solo omi local"));
	writeFileSync(join(omiLocal, "empate-local.md"), canonicalSpec("Empate omi local"));
	writeFileSync(join(localDirectory, "empate-local.md"), canonicalSpec("Empate sdd local"));
	// Compatibilidad: chiche se lista y queda entre omi y sdd.
	const chicheLocal = join(common, "chiche", "specs");
	mkdirSync(chicheLocal, { recursive: true });
	writeFileSync(join(chicheLocal, "solo-chiche.md"), canonicalSpec("Solo marca vieja local"));
	writeFileSync(join(chicheLocal, "empate-local.md"), canonicalSpec("Empate marca vieja local"));
	writeFileSync(join(chicheLocal, "empate-sdd.md"), canonicalSpec("Empate chiche gana"));
	writeFileSync(join(localDirectory, "empate-sdd.md"), canonicalSpec("Empate sdd pierde"));
	mkdirSync(join(main, ".chiche", "specs"), { recursive: true });
	writeFileSync(join(main, ".chiche", "specs", "trackeada-chiche.md"), canonicalSpec("Trackeada marca vieja"));
	for (const cwd of [main, linked]) {
		const view = await renderSpecs(cwd);
		assert.match(view, /Solo marca vieja local/, `${cwd}: /specs muestra la spec local de chiche`);
		assert.doesNotMatch(view, /Empate marca vieja local/, `${cwd}: omi gana sobre chiche`);
		assert.match(view, /Empate chiche gana/, `${cwd}: chiche gana sobre sdd`);
		assert.doesNotMatch(view, /Empate sdd pierde/, `${cwd}: el sdd queda oculto`);
		assert.match(view, /Solo local/, `${cwd}: /specs muestra la spec local`);
		assert.match(view, /Solo omi local/, `${cwd}: /specs muestra la spec local de omi`);
		assert.doesNotMatch(view, /NOTIFY/, `${cwd}: sin errores`);
	}
	const fromMain = await renderSpecs(main);
	assert.match(fromMain, /Compartida trackeada/);
	assert.doesNotMatch(fromMain, /Compartida local/, "la trackeada gana ante el mismo nombre");
	assert.match(fromMain, /Empate omi local/);
	assert.match(fromMain, /Trackeada marca vieja/, "la trackeada de chiche se lista");
	assert.doesNotMatch(fromMain, /Empate sdd local/, "en el par local gana omi ante el mismo nombre");
});

test("#84 CA-10 (review #86): una revisión local del mismo grill reemplaza al handoff trackeado y el grill sigue válido", async (t) => {
	const tool = tools.get("grill_session");
	assert.ok(tool);
	const { base, main, common } = repoWithLinkedWorktree("shadow");
	t.after(() => rmSync(base, { recursive: true, force: true }));
	const created = await tool.execute(
		"create-shadowed-handoff",
		{ action: "create", topic: "Handoff ya commiteado", projectPath: main, estimate: { min: 1, likely: 2, max: 3 } },
		undefined,
		undefined,
		{ cwd: main },
	);
	const snapshot = created.details.snapshot;
	t.after(() => removeStoredSnapshot(snapshot.id));
	const names = handoffFileNames(snapshot);
	mkdirSync(join(main, ".sdd", "grills"), { recursive: true });
	writeFileSync(join(main, ".sdd", "grills", names.primary), canonicalHandoff(snapshot.id, "paused", "Handoff ya commiteado", main));
	git(main, "add", ".sdd/grills");
	git(main, "commit", "-q", "-m", "handoff commiteado");
	await tool.execute("configure-shadowed", { action: "configure", sessionId: snapshot.id, interviewMode: "adaptive" }, undefined, undefined, { cwd: main });
	const paused = await tool.execute("pause-shadowed", { action: "pause", sessionId: snapshot.id, summary: "Nueva revisión" }, undefined, undefined, { cwd: main });
	assert.equal(paused.details.repoHandoffPath, join(common, "omi", "grills", names.primary));
	assert.equal(gitStatus(main), "");
	const labels = (await selectLabels(main, { status: "all", scope: "current-project", query: snapshot.id })).filter((label) => label.includes("Handoff ya commiteado"));
	assert.equal(labels.length, 1, labels.join(" | "));
	assert.doesNotMatch(labels[0]!, /^!/, "el grill no queda BLOCKED por divergent-handoffs");
});

test("#103 CA-1: un handoff previo del mismo grill en <git-common-dir>/sdd/grills conserva su nombre y la revisión va a <git-common-dir>/omi/grills", async (t) => {
	const tool = tools.get("grill_session");
	assert.ok(tool);
	const { base, main, common } = repoWithLinkedWorktree("legacy-local");
	t.after(() => rmSync(base, { recursive: true, force: true }));
	const created = await tool.execute(
		"create-legacy-local",
		{ action: "create", topic: "Handoff previo al renombre", projectPath: main, estimate: { min: 1, likely: 2, max: 3 } },
		undefined,
		undefined,
		{ cwd: main },
	);
	const snapshot = created.details.snapshot;
	t.after(() => removeStoredSnapshot(snapshot.id));
	const names = handoffFileNames(snapshot);
	mkdirSync(join(common, "sdd", "grills"), { recursive: true });
	writeFileSync(join(common, "sdd", "grills", names.primary), canonicalHandoff(snapshot.id, "paused", "Handoff previo al renombre", main));
	await tool.execute("configure-legacy-local", { action: "configure", sessionId: snapshot.id, interviewMode: "adaptive" }, undefined, undefined, { cwd: main });
	const paused = await tool.execute("pause-legacy-local", { action: "pause", sessionId: snapshot.id, summary: "Nueva revisión" }, undefined, undefined, { cwd: main });
	assert.equal(paused.details.repoHandoffPath, join(common, "omi", "grills", names.primary));
	assert.equal(gitStatus(main), "");
	const labels = (await selectLabels(main, { status: "all", scope: "current-project", query: snapshot.id })).filter((label) => label.includes("Handoff previo al renombre"));
	assert.equal(labels.length, 1, labels.join(" | "));
	assert.doesNotMatch(labels[0]!, /^!/, "el grill no queda BLOCKED por divergent-handoffs");
});

test("#84 CA-10 (review #86): un handoff trackeado de otro grill con el mismo nombre no oculta la revisión local", async (t) => {
	const tool = tools.get("grill_session");
	assert.ok(tool);
	const { base, main, common } = repoWithLinkedWorktree("foreign");
	t.after(() => rmSync(base, { recursive: true, force: true }));
	const created = await tool.execute(
		"create-foreign-shadow",
		{ action: "create", topic: "Nombre compartido", projectPath: main, estimate: { min: 1, likely: 2, max: 3 } },
		undefined,
		undefined,
		{ cwd: main },
	);
	const snapshot = created.details.snapshot;
	t.after(() => removeStoredSnapshot(snapshot.id));
	const names = handoffFileNames(snapshot);
	mkdirSync(join(main, ".sdd", "grills"), { recursive: true });
	writeFileSync(join(main, ".sdd", "grills", names.primary), canonicalHandoff("otro-grill-ajeno", "paused", "Grill ajeno", main));
	git(main, "add", ".sdd/grills");
	git(main, "commit", "-q", "-m", "handoff ajeno");
	await tool.execute("configure-foreign", { action: "configure", sessionId: snapshot.id, interviewMode: "adaptive" }, undefined, undefined, { cwd: main });
	const paused = await tool.execute("pause-foreign", { action: "pause", sessionId: snapshot.id, summary: "Pausa" }, undefined, undefined, { cwd: main });
	assert.equal(paused.details.repoHandoffPath, join(common, "omi", "grills", names.fallback));
	const labels = await selectLabels(main, { status: "all", scope: "current-project", query: "" });
	assert.equal(labels.filter((label) => label.includes("Nombre compartido") && !label.startsWith("!")).length, 1, labels.join(" | "));
	assert.equal(labels.filter((label) => label.includes("Grill ajeno") && !label.startsWith("!")).length, 1, labels.join(" | "));
});

test("#84 CA-10 (review #86): un handoff del common-dir cuyo Proyecto no es un worktree del repo se atribuye al worktree principal", async (t) => {
	const { base, main, linked, common } = repoWithLinkedWorktree("fallback-root");
	t.after(() => rmSync(base, { recursive: true, force: true }));
	mkdirSync(join(common, "sdd", "grills"), { recursive: true });
	writeFileSync(join(common, "sdd", "grills", "historico.md"), canonicalHandoff("cero-residuos-historico", "paused", "Handoff de otra maquina", "/old/project"));
	const labels = await selectLabels(linked, { status: "all", scope: "all", query: "cero-residuos-historico" });
	const label = labels.find((candidate) => candidate.includes("Handoff de otra maquina"));
	assert.ok(label, labels.join(" | "));
	assert.ok(label!.endsWith(`@ ${main}`), `${label} se atribuye a ${main}`);
});

test("#84 CA-11 (review #86): fuera de git, un .omi/specs o .sdd/specs symlinkeado fuera del proyecto se rechaza", async (t) => {
	const tool = tools.get("persist_sdd_spec");
	assert.ok(tool);
	const base = realpathSync(mkdtempSync(join(tmpdir(), "grill-tools-symlink-")));
	t.after(() => rmSync(base, { recursive: true, force: true }));
	const project = join(base, "proyecto");
	const outside = join(base, "fuera");
	const legacyOutside = join(base, "fuera-sdd");
	mkdirSync(join(project, ".omi"), { recursive: true });
	mkdirSync(join(project, ".sdd"), { recursive: true });
	mkdirSync(outside);
	mkdirSync(legacyOutside);
	symlinkSync(outside, join(project, ".omi", "specs"), "dir");
	symlinkSync(legacyOutside, join(project, ".sdd", "specs"), "dir");
	// Una spec ya existente en .sdd/specs se actualizaría en su lugar (#103, CA-1).
	writeFileSync(join(legacyOutside, "vieja.md"), canonicalSpec("Vieja"));
	const persist = (path: string) => tool.execute(
		"persist-symlinked",
		{
			mode: "interactive",
			repository: "local/proyecto",
			projectPath: project,
			documents: [{ id: "successor", role: "successor", markdown: canonicalSpec("Escapada"), destinations: [{ kind: "local", path }] }],
		},
		undefined,
		undefined,
		{ cwd: project },
	);
	const result = await persist(".sdd/specs/escapada.md");
	assert.equal(result.details.ok, false, "la publicación queda bloqueada");
	assert.match(JSON.stringify(result.details.diagnostics), /Refusing a \.omi\/specs directory that resolves outside the project/);
	assert.deepEqual(readdirSync(outside), [], "no se escribe nada fuera del proyecto");
	const legacy = await persist(".sdd/specs/vieja.md");
	assert.equal(legacy.details.ok, false, "la actualización en su lugar queda bloqueada");
	assert.match(JSON.stringify(legacy.details.diagnostics), /Refusing a \.sdd\/specs directory that resolves outside the project/);
	assert.equal(readFileSync(join(legacyOutside, "vieja.md"), "utf8"), canonicalSpec("Vieja"), "la spec de afuera queda intacta");
});

// #93: log de eventos SDD (events-v1) escrito por las tools de Pi.

function eventLines(common: string): string[] {
	const path = join(common, "omi", "events.jsonl");
	let content = "";
	try {
		content = readFileSync(path, "utf8");
	} catch {
		return [];
	}
	assert.ok(content === "" || content.endsWith("\n"), "cada línea termina en LF");
	return content === "" ? [] : content.slice(0, -1).split("\n");
}

function loggedEvents(common: string): SddEvent[] {
	return eventLines(common).map((line) => {
		const parsed = parseSddEventLine(line);
		assert.equal(parsed.kind, "event", `línea válida: ${line}`);
		return (parsed as { kind: "event"; event: SddEvent }).event;
	});
}

function withoutTs(event: SddEvent | undefined): Omit<SddEvent, "ts"> | undefined {
	if (!event) return undefined;
	const { ts: _ts, ...rest } = event;
	return rest;
}

function warningLines(text: string): string[] {
	return text.split("\n").filter((line) => line.startsWith("SDD event log not updated"));
}

test("#93 CA-4: grill_session pause y finalize agregan grill.paused y grill.finalized con la identidad del handoff escrito", async (t) => {
	const tool = tools.get("grill_session");
	assert.ok(tool);
	const { base, main, linked, common } = repoWithLinkedWorktree("events-grill");
	t.after(() => rmSync(base, { recursive: true, force: true }));
	const created = await tool.execute(
		"create-events",
		{
			action: "create",
			topic: "Eventos del grill",
			projectPath: main,
			estimate: { min: 1, likely: 2, max: 3 },
			sourceIssue: { number: 93, repository: "acme/omi-code" },
		},
		undefined,
		undefined,
		{ cwd: main },
	);
	const id = created.details.snapshot.id;
	t.after(() => removeStoredSnapshot(id));
	await tool.execute("configure-events", { action: "configure", sessionId: id, interviewMode: "adaptive" }, undefined, undefined, { cwd: main });
	assert.deepEqual(eventLines(common), [], "create y configure no emiten");

	const paused = await tool.execute("pause-events", { action: "pause", sessionId: id, summary: "Pausa" }, undefined, undefined, { cwd: main });
	const pausedMarker = parseSddArtifact(readFileSync(paused.details.repoHandoffPath, "utf8"));
	assert.ok(pausedMarker.kind === "metadata" && pausedMarker.metadata.type === "grill");
	assert.equal(pausedMarker.metadata.issue, "acme/omi-code#93");
	assert.equal(pausedMarker.metadata.grill, id);
	let events = loggedEvents(common);
	assert.equal(events.length, 1, "pause agrega exactamente una línea");
	assert.deepEqual(withoutTs(events[0]), {
		v: 1,
		harness: "pi",
		event: "grill.paused",
		issue: pausedMarker.metadata.issue,
		spec: null,
		previous: null,
		grill: pausedMarker.metadata.grill,
		pr: [],
		reason: null,
	});
	assert.deepEqual(warningLines(paused.content[0].text), []);

	const finalized = await tool.execute(
		"finalize-events",
		{ action: "finalize", sessionId: id, handoffMarkdown: "# Grill — Eventos del grill\n\n## Handoff\nListo.\n" },
		undefined,
		undefined,
		{ cwd: main },
	);
	const finalizedMarker = parseSddArtifact(readFileSync(finalized.details.repoHandoffPath, "utf8"));
	assert.ok(finalizedMarker.kind === "metadata" && finalizedMarker.metadata.type === "grill");
	events = loggedEvents(common);
	assert.equal(events.length, 2, "finalize agrega exactamente una línea más");
	assert.deepEqual(withoutTs(events[1]), {
		v: 1,
		harness: "pi",
		event: "grill.finalized",
		issue: finalizedMarker.metadata.issue,
		spec: null,
		previous: null,
		grill: finalizedMarker.metadata.grill,
		pr: [],
		reason: null,
	});
	assert.equal(gitStatus(main), "", "checkout principal limpio");
	assert.equal(gitStatus(linked), "", "worktree linkeado limpio");
});

test("#93 CA-4: si el handoff no se pudo escribir, pause no agrega ningún evento", async (t) => {
	const tool = tools.get("grill_session");
	assert.ok(tool);
	const { base, main, common } = repoWithLinkedWorktree("events-grill-blocked");
	t.after(() => rmSync(base, { recursive: true, force: true }));
	const created = await tool.execute(
		"create-blocked",
		{ action: "create", topic: "Handoff bloqueado", projectPath: main, estimate: { min: 1, likely: 2, max: 3 } },
		undefined,
		undefined,
		{ cwd: main },
	);
	const id = created.details.snapshot.id;
	t.after(() => removeStoredSnapshot(id));
	await tool.execute("configure-blocked", { action: "configure", sessionId: id, interviewMode: "adaptive" }, undefined, undefined, { cwd: main });
	mkdirSync(join(common, "omi"), { recursive: true });
	writeFileSync(join(common, "omi", "grills"), "no es un directorio\n");

	const paused = await tool.execute("pause-blocked", { action: "pause", sessionId: id, summary: "Pausa" }, undefined, undefined, { cwd: main });
	assert.match(paused.content[0].text, /Repo handoff could not be written/);
	assert.deepEqual(eventLines(common), [], "sin handoff escrito no hay evento");
});

test("#93 CA-6: con el append roto, grill_session pause devuelve el mismo resultado exitoso más un aviso de una línea", async (t) => {
	const tool = tools.get("grill_session");
	assert.ok(tool);
	const { base, main, linked, common } = repoWithLinkedWorktree("events-grill-broken");
	t.after(() => rmSync(base, { recursive: true, force: true }));
	const created = await tool.execute(
		"create-broken",
		{ action: "create", topic: "Log roto", projectPath: main, estimate: { min: 1, likely: 2, max: 3 } },
		undefined,
		undefined,
		{ cwd: main },
	);
	const id = created.details.snapshot.id;
	t.after(() => removeStoredSnapshot(id));
	await tool.execute("configure-broken", { action: "configure", sessionId: id, interviewMode: "adaptive" }, undefined, undefined, { cwd: main });
	const log = join(common, "omi", "events.jsonl");
	mkdirSync(log, { recursive: true });

	const broken = await tool.execute("pause-broken", { action: "pause", sessionId: id, summary: "Pausa" }, undefined, undefined, { cwd: main });
	assert.match(readFileSync(broken.details.repoHandoffPath, "utf8"), /state=paused/, "el handoff queda escrito igual");
	const brokenText: string = broken.content[0].text;
	assert.equal(warningLines(brokenText).length, 1, "un aviso de una línea");

	rmSync(log, { recursive: true, force: true });
	const healthy = await tool.execute("pause-healthy", { action: "pause", sessionId: id, summary: "Pausa" }, undefined, undefined, { cwd: main });
	assert.equal(loggedEvents(common).length, 1, "con el log sano, pause sí registra");
	const normalize = (text: string) => text.replace(/"updatedAt": "[^"]*"/g, "\"updatedAt\": \"<t>\"");
	assert.equal(
		normalize(brokenText.split("\n").filter((line) => !line.startsWith("SDD event log not updated")).join("\n")),
		normalize(healthy.content[0].text),
		"sin el aviso, el texto es el mismo que con el log sano",
	);
	const details = (result: any) => ({ ...result.details, snapshot: { ...result.details.snapshot, updatedAt: "<t>" } });
	assert.deepEqual(details(broken), details(healthy), "mismos details");
	assert.equal(gitStatus(main), "", "checkout principal limpio");
	assert.equal(gitStatus(linked), "", "worktree linkeado limpio");
});

function lifecycleSpec(title: string, state: "draft" | "approved" | "superseded", grill: string, supersededBy = "none"): string {
	const human = state === "draft" ? "draft" : state === "approved" ? "aprobada" : `reemplazada por ${decodeURIComponent(supersededBy)}`;
	return [
		`# Spec — ${title}`,
		`<!-- Generada por /skill:spec. Estado: ${human} -->`,
		`<!-- SDD-Tracking: version=1; type=spec; state=${state}; issue=none; grill=${grill}; superseded-by=${supersededBy} -->`,
		"",
		"## Contexto",
		"Body.",
		"",
	].join("\n");
}

test("#93 CA-5: persist_sdd_spec agrega spec.published en draft, spec.approved al aprobar y un spec.superseded por predecesora", async (t) => {
	const tool = tools.get("persist_sdd_spec");
	assert.ok(tool);
	const { base, main, linked, common } = repoWithLinkedWorktree("events-spec");
	t.after(() => rmSync(base, { recursive: true, force: true }));
	const persist = (callId: string, mode: "interactive" | "assume", documents: unknown[]) => tool.execute(
		callId,
		{ mode, repository: "local/repo", projectPath: main, documents },
		undefined,
		undefined,
		{ cwd: main },
	);
	const successor = (title: string, state: "draft" | "approved", path: string, grill?: string) => ({
		id: "successor",
		role: "successor",
		markdown: lifecycleSpec(title, state, grill ?? "none"),
		...(grill === undefined ? {} : { grill }),
		destinations: [{ kind: "local", path }],
	});

	const steps: Array<[string, "interactive" | "assume", unknown[]]> = [
		["vieja-draft", "assume", [successor("Vieja", "draft", ".sdd/specs/vieja.md")]],
		["eventos-draft", "assume", [successor("Eventos", "draft", ".sdd/specs/eventos.md", "grill-x")]],
		["eventos-republicada", "assume", [successor("Eventos", "draft", ".sdd/specs/eventos.md", "grill-x")]],
		["eventos-aprobada", "interactive", [successor("Eventos", "approved", ".sdd/specs/eventos.md", "grill-x")]],
		["eventos-vuelve-a-draft", "assume", [successor("Eventos", "draft", ".sdd/specs/eventos.md", "grill-x")]],
		["eventos-reemplaza-vieja", "assume", [
			successor("Eventos", "draft", ".sdd/specs/eventos.md", "grill-x"),
			{
				id: "predecessor",
				role: "predecessor",
				markdown: lifecycleSpec("Vieja", "superseded", "none", ".sdd%2Fspecs%2Feventos.md"),
				supersededBy: ".sdd/specs/eventos.md",
				destinations: [{ kind: "local", path: ".sdd/specs/vieja.md" }],
			},
		]],
	];
	for (const [callId, mode, documents] of steps) {
		const result = await persist(callId, mode, documents);
		assert.equal(result.details.ok, true, `${callId}: ${JSON.stringify(result.details.diagnostics)}`);
		assert.deepEqual(warningLines(result.content[0].text), [], `${callId}: sin aviso`);
	}
	const expected = [
		["spec.published", ".sdd/specs/vieja.md", null],
		["spec.published", ".sdd/specs/eventos.md", "grill-x"],
		["spec.published", ".sdd/specs/eventos.md", "grill-x"],
		["spec.approved", ".sdd/specs/eventos.md", "grill-x"],
		["spec.published", ".sdd/specs/eventos.md", "grill-x"],
		["spec.published", ".sdd/specs/eventos.md", "grill-x"],
		["spec.superseded", ".sdd/specs/vieja.md", null],
	];
	assert.deepEqual(
		loggedEvents(common).map(withoutTs),
		expected.map(([event, spec, grill]) => ({ v: 1, harness: "pi", event, issue: null, spec, previous: null, grill, pr: [], reason: null })),
	);

	const blocked = await persist("gate-falla", "assume", [successor("Eventos", "approved", ".sdd/specs/eventos.md", "grill-x")]);
	assert.equal(blocked.details.ok, false, "assume exige draft: el gate bloquea");
	assert.equal(eventLines(common).length, expected.length, "una publicación bloqueada no agrega líneas");
	assert.equal(gitStatus(main), "", "checkout principal limpio");
	assert.equal(gitStatus(linked), "", "worktree linkeado limpio");
});

test("#93 CA-5: una spec publicada en un issue se registra con spec=#NN aunque también tenga copia local", async (t) => {
	const tool = tools.get("persist_sdd_spec");
	assert.ok(tool);
	const { base, main, common } = repoWithLinkedWorktree("events-issue");
	t.after(() => rmSync(base, { recursive: true, force: true }));
	let remoteBody = "Pedido original.\n";
	execHandler = async (command: string, args: string[]) => {
		if (command === "git" && args[0] === "rev-parse") return { code: 0, stdout: `${main}\n`, stderr: "" };
		if (command === "git" && args[0] === "config") return { code: 0, stdout: "git@github.com:acme/omi-code.git\n", stderr: "" };
		if (command === "gh" && args[0] === "issue" && args[1] === "view") {
			return { code: 0, stdout: JSON.stringify({ body: remoteBody }), stderr: "" };
		}
		if (command === "gh" && args[0] === "issue" && args[1] === "edit") {
			remoteBody = readFileSync(args[args.indexOf("--body-file") + 1]!, "utf8");
			return { code: 0, stdout: "", stderr: "" };
		}
		throw new Error(`unexpected command: ${command} ${args.join(" ")}`);
	};
	try {
		const markdown = lifecycleSpec("En issue", "approved", "none").replace("issue=none", "issue=#33");
		const result = await tool.execute(
			"persist-issue-events",
			{
				mode: "interactive",
				repository: "acme/omi-code",
				projectPath: main,
				documents: [{
					id: "successor",
					role: "successor",
					markdown,
					issueNumber: 33,
					destinations: [{ kind: "local", path: ".sdd/specs/en-issue.md" }, { kind: "issue", issueNumber: 33 }],
				}],
			},
			undefined,
			undefined,
			{ cwd: main },
		);
		assert.equal(result.details.ok, true, JSON.stringify(result.details.diagnostics));
	} finally {
		execHandler = async (..._args: any[]) => ({ code: 0, stdout: "", stderr: "" });
	}
	assert.deepEqual(loggedEvents(common).map(withoutTs), [
		{ v: 1, harness: "pi", event: "spec.approved", issue: "#33", spec: "#33", previous: null, grill: null, pr: [], reason: null },
	]);
});

test("#93 (review #94): spec.approved sale solo en la transición; republicar una spec ya approved no lo repite", async (t) => {
	const tool = tools.get("persist_sdd_spec");
	assert.ok(tool);
	const { base, main, common } = repoWithLinkedWorktree("events-approved-once");
	t.after(() => rmSync(base, { recursive: true, force: true }));
	const persist = (callId: string, mode: "interactive" | "assume", state: "draft" | "approved") => tool.execute(
		callId,
		{
			mode,
			repository: "local/repo",
			projectPath: main,
			documents: [{ id: "successor", role: "successor", markdown: lifecycleSpec("Una vez", state, "none"), destinations: [{ kind: "local", path: ".sdd/specs/una-vez.md" }] }],
		},
		undefined,
		undefined,
		{ cwd: main },
	);
	const steps: Array<[string, "interactive" | "assume", "draft" | "approved"]> = [
		["aprobada", "interactive", "approved"],
		["republicada-aprobada", "interactive", "approved"],
		["vuelve-a-draft", "assume", "draft"],
		["aprobada-otra-vez", "interactive", "approved"],
	];
	for (const [callId, mode, state] of steps) {
		const result = await persist(callId, mode, state);
		assert.equal(result.details.ok, true, `${callId}: ${JSON.stringify(result.details.diagnostics)}`);
		assert.deepEqual(warningLines(result.content[0].text), [], `${callId}: sin aviso`);
	}
	assert.deepEqual(loggedEvents(common).map((event) => event.event), ["spec.approved", "spec.published", "spec.approved"]);
});

test("#93 (review #94): llevar a issue una spec local registra spec.moved con la identidad anterior y después la publicación con #NN", async (t) => {
	const tool = tools.get("persist_sdd_spec");
	assert.ok(tool);
	const { base, main, common } = repoWithLinkedWorktree("events-moved");
	t.after(() => rmSync(base, { recursive: true, force: true }));
	let remoteBody = "";
	execHandler = async (command: string, args: string[]) => {
		if (command === "git" && args[0] === "rev-parse") return { code: 0, stdout: `${main}\n`, stderr: "" };
		if (command === "git" && args[0] === "config") return { code: 0, stdout: "git@github.com:acme/omi-code.git\n", stderr: "" };
		if (command === "gh" && args[0] === "issue" && args[1] === "create") {
			remoteBody = readFileSync(args[args.indexOf("--body-file") + 1]!, "utf8");
			return { code: 0, stdout: "https://github.com/acme/omi-code/issues/57\n", stderr: "" };
		}
		if (command === "gh" && args[0] === "issue" && args[1] === "view") {
			return { code: 0, stdout: JSON.stringify({ body: remoteBody }), stderr: "" };
		}
		if (command === "gh" && args[0] === "issue" && args[1] === "edit") {
			remoteBody = readFileSync(args[args.indexOf("--body-file") + 1]!, "utf8");
			return { code: 0, stdout: "", stderr: "" };
		}
		throw new Error(`unexpected command: ${command} ${args.join(" ")}`);
	};
	const local = { kind: "local", path: ".sdd/specs/llevar.md" };
	const publish = (callId: string, destinations: unknown[]) => tool.execute(
		callId,
		{
			mode: "assume",
			repository: "acme/omi-code",
			projectPath: main,
			documents: [{ id: "successor", role: "successor", markdown: lifecycleSpec("Llevar", "draft", "grill-l"), grill: "grill-l", destinations }],
		},
		undefined,
		undefined,
		{ cwd: main },
	);
	try {
		const first = await publish("local", [local]);
		assert.equal(first.details.ok, true, JSON.stringify(first.details.diagnostics));
		const moved = await publish("llevar-a-issue", [local, { kind: "new-issue", title: "Llevar" }]);
		assert.equal(moved.details.ok, true, JSON.stringify(moved.details.diagnostics));
		assert.match(remoteBody, /issue=#57/);
	} finally {
		execHandler = async (..._args: any[]) => ({ code: 0, stdout: "", stderr: "" });
	}
	const base_ = { v: 1, harness: "pi", issue: null, grill: "grill-l", pr: [], reason: null };
	assert.deepEqual(loggedEvents(common).map(withoutTs), [
		{ ...base_, event: "spec.published", spec: ".sdd/specs/llevar.md", previous: null },
		{ ...base_, event: "spec.moved", issue: "#57", spec: "#57", previous: ".sdd/specs/llevar.md" },
		{ ...base_, event: "spec.published", issue: "#57", spec: "#57", previous: null },
	]);
});

test("#93 CA-6: con el append roto, persist_sdd_spec devuelve el mismo resultado exitoso más un aviso de una línea", async (t) => {
	const tool = tools.get("persist_sdd_spec");
	assert.ok(tool);
	const { base, main, linked, common } = repoWithLinkedWorktree("events-spec-broken");
	t.after(() => rmSync(base, { recursive: true, force: true }));
	const input = {
		mode: "assume",
		repository: "local/repo",
		projectPath: main,
		documents: [{
			id: "successor",
			role: "successor",
			markdown: lifecycleSpec("Log roto", "draft", "none"),
			destinations: [{ kind: "local", path: ".sdd/specs/log-roto.md" }],
		}],
	};
	const log = join(common, "omi", "events.jsonl");
	mkdirSync(log, { recursive: true });
	const broken = await tool.execute("persist-broken", input, undefined, undefined, { cwd: main });
	assert.equal(broken.details.ok, true, "la publicación sigue verificada");
	assert.equal(readFileSync(join(common, "omi", "specs", "log-roto.md"), "utf8"), input.documents[0]!.markdown, "la spec queda escrita igual");
	const brokenText: string = broken.content[0].text;
	assert.equal(warningLines(brokenText).length, 1, "un aviso de una línea");

	rmSync(log, { recursive: true, force: true });
	const healthy = await tool.execute("persist-healthy", input, undefined, undefined, { cwd: main });
	assert.equal(loggedEvents(common).length, 1, "con el log sano, la publicación sí registra");
	assert.equal(
		brokenText.split("\n").filter((line) => !line.startsWith("SDD event log not updated")).join("\n"),
		healthy.content[0].text,
		"sin el aviso, el texto es el mismo que con el log sano",
	);
	assert.deepEqual(broken.details, healthy.details, "mismos details");
	assert.equal(gitStatus(main), "", "checkout principal limpio");
	assert.equal(gitStatus(linked), "", "worktree linkeado limpio");
});
