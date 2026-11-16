// `--yes` y `--create` no aprueban lo que exige un humano: sin terminal la CLI rechaza sin mutar nada.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { saveCredentials } from "../src/auth/credentials.ts";
import { run } from "../src/cli/main.ts";
import { credentialsPath } from "../src/core/paths.ts";
import type { Guard } from "../src/guardrails/policy.ts";
import { tempDir, testIo, type TestIo } from "./helpers/io.ts";
import { startMockOmi } from "./helpers/mock-omi.ts";
import { linkedProject, type Linked } from "./helpers/project.ts";

const BASE_ENV = { OMI_POLL_INTERVAL_MS: "1" };
const JOB = ["jobs", "create", "facturar", "--path", "/jobs/f", "--schedule", "0 6 * * *"];

/** Un humano que dice que sí: sólo para preparar el estado previo de un caso. */
function humanSaysYes(): Guard {
	return { surface: "tui", canAsk: true, preApproved: false, stageAuthorized: true, ask: async () => true, grantStage() {} };
}

function withVersion(linked: Linked): void {
	const view = linked.project.services.get("api")?.view;
	assert.ok(view);
	view.versions = [{ tag: "1.1.0", prerelease: false }];
}

function prod(linked: Linked): Record<string, unknown> {
	const view = linked.project.services.get("api")?.view.environments.find((candidate) => candidate.name === "prod");
	assert.ok(view);
	return view;
}

function errorCode(io: TestIo): string {
	return (JSON.parse(io.errors()) as { error: { code: string } }).error.code;
}

interface Case {
	name: string;
	args: string[];
	env?: Record<string, string>;
	prepare?(linked: Linked): Promise<void> | void;
}

const HUMAN_REQUIRED: Case[] = [
	{ name: "crear el registry", args: ["registry", "create", "--host", "hst_cp"] },
	{
		name: "reintentar la ruta del registry",
		args: ["registry", "retry-route"],
		prepare: async (linked) => {
			linked.platform.routeOutcome = "error";
			await linked.call("omi_registry_manage", { action: "create", hostId: "hst_cp" }, { guard: humanSaysYes() });
		},
	},
	{ name: "visibilidad en stage", args: ["visibility", "set", "publico", "--env", "stage"] },
	{ name: "visibilidad en prod", args: ["visibility", "set", "publico", "--env", "prod"] },
	{ name: "una variable en prod", args: ["env", "set", "--env", "prod", "FEATURE=on"] },
	{ name: "un secreto en stage", args: ["env", "set", "--env", "stage", "--secret", "API_KEY=LOCAL"], env: { LOCAL: "de-entorno" } },
	{ name: "un secreto en prod", args: ["env", "set", "--env", "prod", "--secret", "API_KEY=LOCAL"], env: { LOCAL: "de-entorno" } },
	{ name: "crear un Postgres en stage", args: ["resources", "postgres", "create", "--env", "stage", "--slug", "app", "--mode", "local"] },
	{ name: "crear un Postgres en prod", args: ["resources", "postgres", "create", "--env", "prod", "--slug", "app", "--mode", "local"] },
	{ name: "dar de baja un Postgres", args: ["resources", "postgres", "delete", "--resource-id", "res_1"] },
	...["stage", "prod"].map((environment) => ({
		name: `ejecutar SQL en ${environment}`,
		args: ["resources", "postgres", "exec", "--env", environment, "--slug", "app", "DELETE FROM pruebas"],
		prepare: (linked: Linked) => void linked.workloads.resources.set("res_app", { id: "res_app", environment, slug: "app", mode: "local", variable: "POSTGRES_URL_APP", state: "lista", engine: "postgres", active_revision: 1 }),
	})),
	{ name: "un job de un service con prod desplegado", args: JOB, prepare: (linked) => void (prod(linked).current_version = "1.0.0") },
	{ name: "correr un job en prod", args: ["jobs", "run", "facturar", "--env", "prod"] },
	{ name: "desplegar en prod", args: ["deploy", "--env", "prod", "--version", "1.1.0"], prepare: withVersion },
	{
		name: "promover a prod",
		args: ["promote"],
		prepare: (linked) => {
			withVersion(linked);
			prod(linked).promotion = { version: "1.1.0" };
		},
	},
];

for (const { name, args, env, prepare } of HUMAN_REQUIRED) {
	test(`--yes sin terminal no aprueba ${name}: sale con 2 y no muta nada`, async (t) => {
		const linked = await linkedProject(t);
		await prepare?.(linked);
		const before = linked.mutations();
		const io = linked.io({ env: { ...BASE_ENV, ...env } });
		assert.equal(await run([...args, "--yes", "--json"], io), 2, io.errors());
		assert.equal(errorCode(io), "guardrail_confirmation_required");
		assert.match(io.errors(), /--yes/);
		assert.deepEqual(linked.mutations(), before);
		assert.deepEqual(io.prompts, []);
	});
}

async function unlinkedRepo(t: TestContext) {
	const home = await tempDir(t);
	const repo = await tempDir(t);
	const omi = await startMockOmi(t);
	omi.sessions.set("prs_test", "active");
	await saveCredentials(credentialsPath(home), {
		apiUrl: omi.url,
		token: "prs_test",
		expiresAt: "2026-12-01T00:00:00Z",
		user: { id: "usr_ada", name: "Ada", email: "ada@omi.test" },
		defaultOrganizationSlug: "acme",
	});
	await mkdir(join(repo, "kb"));
	return { home, repo, omi, posts: () => omi.requests.filter((request) => request.method !== "GET") };
}

// El comando real que creó un proyecto y un service desde un agente externo, sin TTY y con stdin cerrado.
const REAL_INIT = ["init", "--project", "harness", "--name", "Harness", "--service", "kb:kb:8080:Dockerfile", "--env", "stage,prod", "--create", "--json"];

test("init --create sin terminal no crea el proyecto ni el service: pide un humano", async (t) => {
	const { home, repo, omi, posts } = await unlinkedRepo(t);
	const io = testIo({ homeDir: home, cwd: repo, env: BASE_ENV });
	assert.equal(await run(REAL_INIT, io), 2, io.errors());
	assert.equal(errorCode(io), "guardrail_confirmation_required");
	assert.deepEqual(posts(), []);
	assert.equal(omi.projects.has("harness"), false);
	assert.deepEqual(io.prompts, []);
	await assert.rejects(stat(join(repo, ".omi/project.json")));
});

test("init --create con terminal pregunta igual, avisa que --create no aprueba y crea con un sí", async (t) => {
	const { home, repo, omi } = await unlinkedRepo(t);
	const io = testIo({ homeDir: home, cwd: repo, env: BASE_ENV, interactive: true, answers: ["s"] });
	assert.equal(await run(REAL_INIT, io), 0, io.errors());
	assert.equal(io.prompts.length, 1);
	assert.match(io.errors(), /--create no aprueba/);
	assert.deepEqual(omi.projects.get("harness")?.services.get("kb")?.view.environments.map((environment) => environment.name), ["stage", "prod"]);
});

test("init --create con terminal respeta un no y no crea nada", async (t) => {
	const { home, repo, posts } = await unlinkedRepo(t);
	const io = testIo({ homeDir: home, cwd: repo, env: BASE_ENV, interactive: true, answers: ["n"] });
	assert.equal(await run(REAL_INIT, io), 2);
	assert.match(io.errors(), /"code":"guardrail_declined"/);
	assert.deepEqual(posts(), []);
	await assert.rejects(stat(join(repo, ".omi/project.json")));
});

test("--yes con terminal pregunta igual, avisa por qué y un no frena el deploy a prod", async (t) => {
	const linked = await linkedProject(t);
	withVersion(linked);
	const io = linked.io({ interactive: true, answers: ["n"] });
	assert.equal(await run(["deploy", "--env", "prod", "--version", "1.1.0", "--yes", "--json"], io), 2);
	assert.equal(io.prompts.length, 1);
	assert.match(io.errors(), /--yes no aprueba/);
	assert.match(io.errors(), /"code":"guardrail_declined"/);
	assert.deepEqual(linked.mutations(), []);
});

test("--yes con terminal y un sí despliega en prod", async (t) => {
	const linked = await linkedProject(t);
	withVersion(linked);
	const io = linked.io({ interactive: true, answers: ["s"] });
	assert.equal(await run(["deploy", "--env", "prod", "--version", "1.1.0", "--yes"], io), 0, io.errors());
	assert.equal(io.prompts.length, 1);
	assert.equal(prod(linked).current_version, "1.1.0");
});

const STAGE_AUTONOMOUS: Case[] = [
	{ name: "una variable en stage", args: ["env", "set", "--env", "stage", "FEATURE=on"] },
	{ name: "desplegar en stage", args: ["deploy", "--env", "stage", "--version", "1.1.0"], prepare: withVersion },
	{ name: "un job de un service sin prod desplegado", args: JOB },
	{ name: "correr un job en stage", args: ["jobs", "run", "facturar", "--env", "stage"], prepare: async (linked) => void (await linked.call("omi_jobs_manage", { action: "create", name: "facturar", service: "api", path: "/jobs/f", schedule: "0 6 * * *" }, { guard: humanSaysYes() })) },
];

for (const { name, args, prepare } of STAGE_AUTONOMOUS) {
	for (const yes of [["--yes"], []]) {
		test(`lo autónomo de stage sigue sin preguntar: ${name} ${yes.join("") || "sin --yes"}, sin terminal`, async (t) => {
			const linked = await linkedProject(t);
			await prepare?.(linked);
			const before = linked.mutations().length;
			const io = linked.io();
			assert.equal(await run([...args, ...yes], io), 0, io.errors());
			assert.equal(linked.mutations().length, before + 1);
			assert.deepEqual(io.prompts, []);
		});
	}
}

function git(cwd: string, ...args: string[]): string {
	const identity = { GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
	return execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, ...identity } });
}

test("publicar con --yes sigue sin preguntar, sin terminal", async (t) => {
	const linked = await linkedProject(t);
	const remote = await tempDir(t, "omi-remote-");
	git(remote, "init", "--bare", "-q");
	git(linked.repo, "init", "-q", "-b", "main");
	git(linked.repo, "remote", "add", "origin", remote);
	await writeFile(join(linked.repo, "server.js"), 'app.get("/health", ok); app.get("/version", version);\n');
	await writeFile(join(linked.repo, "Dockerfile"), "FROM scratch\n");
	await mkdir(join(linked.repo, ".github/workflows"), { recursive: true });
	await writeFile(join(linked.repo, ".github/workflows/omi-api.yml"), "name: x\n");
	git(linked.repo, "add", ".");
	git(linked.repo, "commit", "-q", "-m", "inicio");
	linked.workloads.scan = { tag: "1.2.0", afterRefreshes: 1, refreshes: 0 };
	const io = linked.io();
	assert.equal(await run(["publish", "--version", "1.2.0", "--yes"], io), 0, io.errors());
	assert.match(git(remote, "tag", "--list"), /^v1\.2\.0$/m);
	assert.deepEqual(io.prompts, []);
});

test("la ayuda dice que --yes y --create no aprueban lo que exige un humano", async (t) => {
	const linked = await linkedProject(t);
	for (const command of ["env", "resources", "registry", "visibility", "jobs", "deploy", "promote"]) {
		const io = linked.io();
		assert.equal(await run([command, "--help"], io), 0);
		assert.match(io.output(), /pide confirmación en una terminal interactiva; --yes no la reemplaza\./, command);
	}
	const init = linked.io();
	assert.equal(await run(["init", "--help"], init), 0);
	assert.match(init.output(), /--create pide crear .* no lo aprueba/);
	const publish = linked.io();
	assert.equal(await run(["publish", "--help"], publish), 0);
	assert.doesNotMatch(publish.output(), /no la reemplaza/);
	const general = linked.io();
	assert.equal(await run(["--help"], general), 0);
	assert.match(general.output(), /ni --yes ni --create lo aprueban/);
	assert.deepEqual(linked.omi.requests, []);
});

test("init sin --create ni terminal explica que crear pide una terminal interactiva", async (t) => {
	const { home, repo, posts } = await unlinkedRepo(t);
	const io = testIo({ homeDir: home, cwd: repo, env: BASE_ENV });
	assert.equal(await run(REAL_INIT.filter((arg) => arg !== "--create"), io), 1);
	assert.match(io.errors(), /--create en una terminal interactiva/);
	assert.deepEqual(posts(), []);
});
