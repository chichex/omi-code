import assert from "node:assert/strict";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { saveCredentials } from "../src/auth/credentials.ts";
import { run } from "../src/cli/main.ts";
import { credentialsPath } from "../src/core/paths.ts";
import { parseProjectLink } from "../src/project/link.ts";
import { tempDir, testIo } from "./helpers/io.ts";
import { serviceView, startMockOmi, type MockOmi } from "./helpers/mock-omi.ts";
import { allowAll, humanless } from "./helpers/project.ts";
import { fakeRunner } from "./helpers/runner.ts";

async function setup(t: TestContext): Promise<{ home: string; repo: string; omi: MockOmi }> {
	const home = await tempDir(t);
	const repo = await tempDir(t);
	const omi = await startMockOmi(t);
	omi.sessions.set("prs_test", "active");
	await saveCredentials(credentialsPath(home), {
		apiUrl: omi.url,
		token: "prs_test",
		expiresAt: "2026-11-12T00:00:00Z",
		user: { id: "usr_ada", name: "Ada", email: "ada@omi.test" },
		defaultOrganizationSlug: "acme",
	});
	return { home, repo, omi };
}

function seedProject(omi: MockOmi, slug: string, services: [string, number][]): void {
	const project = { id: `prj_${slug}`, name: slug, slug, services: new Map() };
	for (const [name, port] of services) project.services.set(name, serviceView(project, name, port, "stage", "acme"));
	omi.projects.set(slug, project);
}

test("init_vincula un service único en la raíz y escribe .omi/project.json", async (t) => {
	const { home, repo, omi } = await setup(t);
	seedProject(omi, "tienda", [["api", 8080]]);
	const io = testIo({ homeDir: home, cwd: repo });

	const code = await run(["init", "--project", "tienda", "--service", "api", "--port", "8080"], io);

	assert.equal(code, 0, io.errors());
	assert.deepEqual(JSON.parse(await readFile(join(repo, ".omi/project.json"), "utf8")), {
		version: 1,
		organizationSlug: "acme",
		projectSlug: "tienda",
		services: [{ name: "api", path: ".", port: 8080, dockerfile: "Dockerfile" }],
	});
});

test("init_descarga el kit: Dockerfile, contrato y workflow omi-<service>.yml", async (t) => {
	const { home, repo, omi } = await setup(t);
	seedProject(omi, "tienda", [["api", 8080]]);
	const io = testIo({ homeDir: home, cwd: repo });
	assert.equal(await run(["init", "--project", "tienda", "--service", "api", "--json"], io), 0, io.errors());

	const workflow = await readFile(join(repo, ".github/workflows/omi-api.yml"), "utf8");
	assert.match(workflow, /registry-acme\.ohmyinfra\.test/);
	assert.match(workflow, /# \.github\/workflows\/omi-api\.yml/);
	assert.match(await readFile(join(repo, "Dockerfile"), "utf8"), /FROM node/);
	assert.match(await readFile(join(repo, ".omi/kit/api/contract.md"), "utf8"), /\/health/);
	assert.match(await readFile(join(repo, ".omi/kit/api/push-image.sh"), "utf8"), /--blob-chunk 52428800/);
	const report = JSON.parse(io.output()) as { kit: { path: string; status: string }[] };
	assert.ok(report.kit.every((file) => file.status === "created"));
});

test("init_no pisa un Dockerfile ni un workflow que ya existen", async (t) => {
	const { home, repo, omi } = await setup(t);
	seedProject(omi, "tienda", [["api", 8080]]);
	await writeFile(join(repo, "Dockerfile"), "FROM scratch\n");
	await mkdir(join(repo, ".github/workflows"), { recursive: true });
	await writeFile(join(repo, ".github/workflows/omi-api.yml"), "name: propio\n");
	const io = testIo({ homeDir: home, cwd: repo });
	assert.equal(await run(["init", "--project", "tienda", "--service", "api", "--json"], io), 0, io.errors());
	assert.equal(await readFile(join(repo, "Dockerfile"), "utf8"), "FROM scratch\n");
	assert.equal(await readFile(join(repo, ".github/workflows/omi-api.yml"), "utf8"), "name: propio\n");
	const report = JSON.parse(io.output()) as { kit: { path: string; status: string }[] };
	assert.equal(report.kit.find((file) => file.path === "Dockerfile")?.status, "kept");
});

test("init_soporta monorepo con varios services y adapta el workflow a cada ruta", async (t) => {
	const { home, repo, omi } = await setup(t);
	seedProject(omi, "tienda", [["api", 8080], ["web", 3000]]);
	const io = testIo({ homeDir: home, cwd: repo });
	const code = await run(
		["init", "--project", "tienda", "--service", "api:services/api:8080", "--service", "web:apps/web:3000:Dockerfile.web"],
		io,
	);
	assert.equal(code, 0, io.errors());
	const link = parseProjectLink(await readFile(join(repo, ".omi/project.json"), "utf8"));
	assert.deepEqual(link.services, [
		{ name: "api", path: "services/api", port: 8080, dockerfile: "Dockerfile" },
		{ name: "web", path: "apps/web", port: 3000, dockerfile: "Dockerfile.web" },
	]);
	assert.equal((await stat(join(repo, "services/api/Dockerfile"))).isFile(), true);
	assert.equal((await stat(join(repo, "apps/web/Dockerfile.web"))).isFile(), true);
	const workflow = await readFile(join(repo, ".github/workflows/omi-web.yml"), "utf8");
	assert.match(workflow, /tags: \["web\/v\*"\]/);
	assert.match(workflow, /-t web:"\$VERSION" -f apps\/web\/Dockerfile\.web apps\/web/);
});

test("init --create_con el sí del humano crea proyecto y service que faltan", async (t) => {
	const { home, repo, omi } = await setup(t);
	const io = testIo({ homeDir: home, cwd: repo, interactive: true, answers: ["s"] });
	const code = await run(["init", "--project", "nueva", "--name", "Nueva", "--service", "api", "--port", "9000", "--create", "--json"], io);
	assert.equal(code, 0, io.errors());
	const posts = omi.requests.filter((request) => request.method === "POST");
	assert.deepEqual(posts.map((request) => request.path), [
		"/api/v1/organizations/org_acme/projects",
		"/api/v1/organizations/org_acme/projects/nueva/services",
	]);
	assert.deepEqual(posts[0]?.body, { name: "Nueva", slug: "nueva" });
	assert.deepEqual(posts[1]?.body, { name: "api", port: 9000, environment: { name: "stage" } });
	const report = JSON.parse(io.output()) as { created: { project: boolean; services: string[] } };
	assert.deepEqual(report.created, { project: true, services: ["api"] });
});

test("init --create_con el sí del humano agrega también prod si se pide con --env", async (t) => {
	const { home, repo, omi } = await setup(t);
	const io = testIo({ homeDir: home, cwd: repo, interactive: true, answers: ["s"] });
	const code = await run(["init", "--project", "nueva", "--service", "api", "--create", "--env", "stage,prod"], io);
	assert.equal(code, 0, io.errors());
	const environments = omi.projects.get("nueva")?.services.get("api")?.view.environments ?? [];
	assert.deepEqual(environments.map((environment) => environment.name), ["stage", "prod"]);
});

test("init_espera el recibo si la creación del service queda en cola", async (t) => {
	const { home, repo, omi } = await setup(t);
	seedProject(omi, "tienda", []);
	omi.queueNext(1);
	const io = testIo({ homeDir: home, cwd: repo, env: { OMI_POLL_INTERVAL_MS: "1" }, interactive: true, answers: ["s"] });
	const code = await run(["init", "--project", "tienda", "--service", "api", "--create", "--json"], io);
	assert.equal(code, 0, io.errors());
	assert.ok(omi.requests.some((request) => request.path.includes("/queued-mutations/mutation_1")));
	assert.match(await readFile(join(repo, ".github/workflows/omi-api.yml"), "utf8"), /registry-acme/);
});

test("init_sin --create no crea nada y explica cómo seguir", async (t) => {
	const { home, repo, omi } = await setup(t);
	const io = testIo({ homeDir: home, cwd: repo });
	assert.equal(await run(["init", "--project", "nueva", "--service", "api"], io), 1);
	assert.match(io.errors(), /--create/);
	assert.equal(omi.requests.filter((request) => request.method === "POST").length, 0);
	await assert.rejects(stat(join(repo, ".omi/project.json")));
});

test("init_interactivo pregunta antes de crear", async (t) => {
	const { home, repo, omi } = await setup(t);
	const io = testIo({ homeDir: home, cwd: repo, interactive: true, answers: ["s"] });
	assert.equal(await run(["init", "--project", "nueva", "--service", "api"], io), 0, io.errors());
	assert.equal(io.prompts.length, 1);
	assert.ok(omi.projects.has("nueva"));
});

test("init --create_no crea desde una sesión agéntica", async (t) => {
	const { home, repo, omi } = await setup(t);
	const io = testIo({ homeDir: home, cwd: repo, env: { OMI_AGENT_SESSION: "1" } });
	assert.equal(await run(["init", "--project", "nueva", "--service", "api", "--create"], io), 2);
	assert.equal(omi.requests.filter((request) => request.method === "POST").length, 0);
});

test("init_rechaza una organización a la que no pertenece", async (t) => {
	const { home, repo } = await setup(t);
	const io = testIo({ homeDir: home, cwd: repo });
	assert.equal(await run(["init", "--org", "otra", "--project", "x", "--service", "api"], io), 1);
	assert.match(io.errors(), /otra/);
});

test("init_sin datos en modo no interactivo es error de uso", async (t) => {
	const { home, repo } = await setup(t);
	const io = testIo({ homeDir: home, cwd: repo });
	assert.equal(await run(["init"], io), 2);
});

for (const [name, raw, message] of [
	["versión desconocida", { version: 2, organizationSlug: "a", projectSlug: "b", services: [] }, /version/],
	["sin services", { version: 1, organizationSlug: "a", projectSlug: "b", services: [] }, /services/],
	["campo desconocido", { version: 1, organizationSlug: "a", projectSlug: "b", services: [{ name: "x", path: ".", port: 1, dockerfile: "D", extra: 1 }] }, /extra/],
	["ruta que sale del repo", { version: 1, organizationSlug: "a", projectSlug: "b", services: [{ name: "x", path: "../y", port: 1, dockerfile: "D" }] }, /path/],
	["ruta absoluta", { version: 1, organizationSlug: "a", projectSlug: "b", services: [{ name: "x", path: "/y", port: 1, dockerfile: "D" }] }, /path/],
	["service repetido", { version: 1, organizationSlug: "a", projectSlug: "b", services: [{ name: "x", path: ".", port: 1, dockerfile: "D" }, { name: "x", path: "b", port: 1, dockerfile: "D" }] }, /repetido/],
	["puerto fuera de rango", { version: 1, organizationSlug: "a", projectSlug: "b", services: [{ name: "x", path: ".", port: 70000, dockerfile: "D" }] }, /port/],
] as const) {
	test(`parseProjectLink_rechaza ${name}`, () => {
		assert.throws(() => parseProjectLink(JSON.stringify(raw)), message);
	});
}

test("omi_link_project_es la misma lógica vista como tool", async (t) => {
	const { CATALOG } = await import("../src/tools/catalog.ts");
	const { home, repo, omi } = await setup(t);
	seedProject(omi, "tienda", [["api", 8080]]);
	const tool = CATALOG.find((candidate) => candidate.name === "omi_link_project");
	assert.ok(tool);
	const result = await tool.run(
		{ projectSlug: "tienda", services: [{ name: "api" }] },
		{ io: testIo({ homeDir: home, cwd: repo }), guard: humanless(), runner: fakeRunner() },
	);
	assert.match(result.text, /tienda/);
	assert.equal((await stat(join(repo, ".omi/project.json"))).isFile(), true);
});

test("omi_link_project_crear en OMI exige un humano aunque el modelo pida create", async (t) => {
	const { CATALOG } = await import("../src/tools/catalog.ts");
	const { home, repo, omi } = await setup(t);
	const tool = CATALOG.find((candidate) => candidate.name === "omi_link_project");
	assert.ok(tool);
	await assert.rejects(
		tool.run(
			{ projectSlug: "nueva", services: [{ name: "api" }], create: true },
			{ io: testIo({ homeDir: home, cwd: repo }), guard: humanless(true), runner: fakeRunner() },
		),
		/requiere confirmación humana/,
	);
	assert.equal(omi.requests.filter((request) => request.method === "POST").length, 0);
});

test("omi_link_project_con el humano de acuerdo crea lo que falta", async (t) => {
	const { CATALOG } = await import("../src/tools/catalog.ts");
	const { home, repo, omi } = await setup(t);
	const tool = CATALOG.find((candidate) => candidate.name === "omi_link_project");
	assert.ok(tool);
	await tool.run(
		{ projectSlug: "nueva", services: [{ name: "api" }], create: true },
		{ io: testIo({ homeDir: home, cwd: repo }), guard: allowAll(), runner: fakeRunner() },
	);
	assert.ok(omi.projects.has("nueva"));
});
