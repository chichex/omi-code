import assert from "node:assert/strict";
import { mkdir, readFile, stat, symlink } from "node:fs/promises";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { saveCredentials } from "../src/auth/credentials.ts";
import { run } from "../src/cli/main.ts";
import { credentialsPath } from "../src/core/paths.ts";
import { linkProject } from "../src/project/init.ts";
import { parseProjectLink } from "../src/project/link.ts";
import { tempDir, testIo } from "./helpers/io.ts";
import { startMockOmi } from "./helpers/mock-omi.ts";

async function setup(t: TestContext) {
	const home = await tempDir(t);
	const repo = join(await tempDir(t), "repo");
	await mkdir(repo);
	const omi = await startMockOmi(t);
	omi.sessions.set("prs_test", "active");
	await saveCredentials(credentialsPath(home), {
		apiUrl: omi.url, token: "prs_test", expiresAt: "2026-12-01",
		user: { id: "u", name: "Ada", email: "ada@omi.test" }, defaultOrganizationSlug: "acme",
	});
	return { repo, omi, io: testIo({ homeDir: home, cwd: repo, env: { OMI_POLL_INTERVAL_MS: "1" } }) };
}

for (const extra of [
	["--service", "api:../outside"],
	["--service", "api:.:8080:../outside"],
	["--service", "API"],
	["--service", "api", "--env", "stage,"],
	["--service", "api", "--env", "dev"],
	["--service", "api", "--service", "api"],
]) {
	test(`init valida ${extra.join(" ")} antes de crear o escribir`, async (t) => {
		const { repo, omi, io } = await setup(t);
		assert.notEqual(await run(["init", "--project", "x", "--create", ...extra], io), 0);
		assert.equal(omi.requests.filter((r) => r.method === "POST").length, 0);
		await assert.rejects(stat(join(repo, "../outside")));
		await assert.rejects(stat(join(repo, ".omi/project.json")));
	});
}

for (const approval of [undefined, false, true]) {
	test(`omi_link_project create no aprueba la creación; respuesta humana: ${approval}`, async (t) => {
		const { linkProjectTool } = await import("../src/tools/link.ts");
		const { omi, io } = await setup(t);
		const runtime = { io, ...(approval === undefined ? {} : { confirmCreate: async () => approval }) };
		const task = linkProjectTool.run({ projectSlug: "x", services: [{ name: "api" }], create: true }, runtime);
		if (approval === true) {
			assert.match((await task).text, /Vinculado/);
		} else {
			await assert.rejects(task, /confirmación humana/);
			assert.equal(omi.requests.filter((r) => r.method === "POST").length, 0);
		}
	});
}

test("init no sigue symlinks fuera del repo antes de mutar", async (t) => {
	const { repo, omi, io } = await setup(t);
	const outside = await tempDir(t);
	await symlink(outside, join(repo, "api"));
	assert.notEqual(await run(["init", "--project", "x", "--service", "api:api", "--create"], io), 0);
	assert.equal(omi.requests.filter((r) => r.method === "POST").length, 0);
	await assert.rejects(stat(join(outside, "Dockerfile")));
});

test("init incremental conserva los services y sólo acepta tags específicos de cada service", async (t) => {
	const { repo, io } = await setup(t);
	for (const name of ["api", "web", "worker"]) {
		assert.equal(await run(["init", "--project", "x", "--service", `${name}:services/${name}`, "--create"], io), 0, io.errors());
	}
	const link = parseProjectLink(await readFile(join(repo, ".omi/project.json"), "utf8"));
	assert.deepEqual(link.services.map((s) => s.name), ["api", "web", "worker"]);
	for (const name of ["api", "web", "worker"]) {
		const workflow = await readFile(join(repo, `.github/workflows/omi-${name}.yml`), "utf8");
		assert.ok(workflow.includes(`tags: ["${name}/v*"]`));
	}
	assert.equal(await run(["init", "--project", "x", "--service", "api"], io), 0, io.errors());
	const rerun = parseProjectLink(await readFile(join(repo, ".omi/project.json"), "utf8"));
	assert.equal(rerun.services[0]?.path, "services/api");
});

test("init agrega los ambientes pedidos a un service existente", async (t) => {
	const { omi, io } = await setup(t);
	assert.equal(await run(["init", "--project", "x", "--service", "api", "--create"], io), 0);
	assert.equal(await run(["init", "--project", "x", "--service", "api", "--create", "--env", "stage,prod"], io), 0, io.errors());
	assert.deepEqual(omi.projects.get("x")?.services.get("api")?.view.environments.map((e) => e.name), ["stage", "prod"]);
});

test("init cancelado no hace requests ni escribe archivos", async (t) => {
	const { repo, omi, io } = await setup(t);
	const signal = AbortSignal.abort(new Error("cancelled"));
	await assert.rejects(linkProject({ projectSlug: "x", services: [{ name: "api" }], create: true }, { io, signal }), /cancelled/);
	assert.deepEqual(omi.requests, []);
	await assert.rejects(stat(join(repo, ".omi/project.json")));
});

test("cancelar init durante el polling corta la espera sin escribir el kit", async (t) => {
	const { repo, omi, io } = await setup(t);
	const controller = new AbortController();
	omi.queueNext(1);
	omi.route("GET /api/v1/organizations/{organizationID}/projects/{projectSlug}/queued-mutations/{mutationID}", () => {
		controller.abort(new Error("cancelled"));
		return { status: 200, body: { mutation_id: "mutation_1", state: "en_curso" } };
	});
	await assert.rejects(linkProject({ projectSlug: "x", services: [{ name: "api" }], create: true }, { io, signal: controller.signal }), /cancelled|abort/i);
	await assert.rejects(stat(join(repo, "Dockerfile")));
	await assert.rejects(stat(join(repo, ".omi/project.json")));
});
