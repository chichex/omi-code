import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { processRunner } from "../src/core/exec.ts";
import type { OmiError } from "../src/core/errors.ts";
import { tempDir } from "./helpers/io.ts";
import { humanless, linkedProject, type Linked } from "./helpers/project.ts";
import { fakeRunner } from "./helpers/runner.ts";

function git(cwd: string, ...args: string[]): string {
	return execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });
}

/** Repo real con remoto bare: el tag se crea y se empuja de verdad. */
async function gitRepo(t: TestContext, linked: Linked): Promise<string> {
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
	return remote;
}

const publish = { service: "api", version: "1.2.0" };

test("omi_publish_version --via tag_crea y empuja vX.Y.Z y espera el barrido", async (t) => {
	const linked = await linkedProject(t);
	const remote = await gitRepo(t, linked);
	linked.workloads.scan = { tag: "1.2.0", afterRefreshes: 3, refreshes: 0 };

	const result = await linked.call("omi_publish_version", publish, { runner: processRunner });

	assert.match(git(remote, "tag", "--list"), /^v1\.2\.0$/m);
	assert.equal(linked.workloads.scan.refreshes, 3);
	assert.deepEqual((result.data as { tag: string; version: string; via: string }), { tag: "v1.2.0", version: "1.2.0", via: "tag", service: "api" });
});

test("omi_publish_version_en un monorepo usa <service>/vX.Y.Z", async (t) => {
	const linked = await linkedProject(t, [["api", 8080], ["web", 3000]]);
	const remote = await gitRepo(t, linked);
	await writeFile(join(linked.repo, ".github/workflows/omi-web.yml"), "name: y\n");
	git(linked.repo, "add", ".");
	git(linked.repo, "commit", "-q", "-m", "web");
	linked.workloads.scan = { tag: "1.2.0", afterRefreshes: 1, refreshes: 0 };
	await linked.call("omi_publish_version", publish, { runner: processRunner });
	assert.match(git(remote, "tag", "--list"), /^api\/v1\.2\.0$/m);
});

test("omi_publish_version_rechaza un árbol sucio sin crear el tag", async (t) => {
	const linked = await linkedProject(t);
	await gitRepo(t, linked);
	await writeFile(join(linked.repo, "server.js"), "cambio sin commit\n");
	await assert.rejects(
		linked.call("omi_publish_version", publish, { runner: processRunner }),
		(error: OmiError) => error.code === "dirty_tree",
	);
	assert.equal(git(linked.repo, "tag", "--list"), "");
});

test("omi_publish_version_rechaza un service que no cumple /health y /version", async (t) => {
	const linked = await linkedProject(t);
	const remote = await gitRepo(t, linked);
	await writeFile(join(linked.repo, "server.js"), 'app.get("/health", ok);\n');
	git(linked.repo, "add", ".");
	git(linked.repo, "commit", "-q", "-m", "sin version");
	await assert.rejects(
		linked.call("omi_publish_version", publish, { runner: processRunner }),
		(error: OmiError) => error.code === "contract_unmet" && /\/version/.test(error.message),
	);
	assert.equal(git(remote, "tag", "--list"), "");
});

test("omi_publish_version_rechaza un tag que ya existe", async (t) => {
	const linked = await linkedProject(t);
	await gitRepo(t, linked);
	git(linked.repo, "tag", "v1.2.0");
	await assert.rejects(
		linked.call("omi_publish_version", publish, { runner: processRunner }),
		(error: OmiError) => error.code === "tag_exists",
	);
});

test("omi_publish_version_borra el tag local si el push falla", async (t) => {
	const linked = await linkedProject(t);
	await gitRepo(t, linked);
	git(linked.repo, "remote", "set-url", "origin", join(linked.repo, "no-existe"));
	await assert.rejects(
		linked.call("omi_publish_version", publish, { runner: processRunner }),
		(error: OmiError) => error.code === "publish_failed",
	);
	assert.equal(git(linked.repo, "tag", "--list"), "");
});

test("omi_publish_version_avisa si el barrido nunca detecta la versión", async (t) => {
	const linked = await linkedProject(t);
	await gitRepo(t, linked);
	await assert.rejects(
		linked.call("omi_publish_version", { ...publish, timeoutSeconds: 0 }, { runner: processRunner }),
		(error: OmiError) => error.code === "version_not_detected" && /labels/.test(error.hint ?? ""),
	);
});

test("omi_publish_version_tolera fallas transitorias del registry mientras espera", async (t) => {
	const linked = await linkedProject(t);
	await gitRepo(t, linked);
	let calls = 0;
	linked.omi.route("POST /api/v1/organizations/{organizationID}/projects/{projectSlug}/services/{serviceName}/versions/refresh", () => {
		calls += 1;
		if (calls === 1) return { status: 502, body: { error: { code: "version_refresh_failed", message: "falló" } } };
		return { status: 200, body: { versions: [{ tag: "1.2.0" }] } };
	});
	await linked.call("omi_publish_version", publish, { runner: processRunner });
	assert.equal(calls, 2);
});

for (const version of ["v1.2.0", "1.2", "latest", "1.2.0+build", "1.0.0-rc.01", "1.0.0-01"]) {
	test(`omi_publish_version_rechaza la versión ${version}`, async (t) => {
		const linked = await linkedProject(t);
		await assert.rejects(linked.call("omi_publish_version", { ...publish, version }), (error: OmiError) => error.exitCode === 2);
	});
}

function directRunner() {
	return fakeRunner((command, args) => {
		if (command === "git" && args[0] === "rev-parse") return { stdout: "abc123\n" };
		if (command === "git" && args[0] === "grep") return { stdout: "server.js\n" };
		return {};
	});
}

test("omi_publish_version --via direct_construye con labels y empuja con regctl en chunks", async (t) => {
	const linked = await linkedProject(t);
	await writeFile(join(linked.repo, "Dockerfile"), "FROM scratch\n");
	linked.workloads.scan = { tag: "1.2.0", afterRefreshes: 1, refreshes: 0 };
	const runner = directRunner();

	const result = await linked.call(
		"omi_publish_version",
		{ ...publish, via: "direct" },
		{ runner, io: linked.io({ env: { OMI_POLL_INTERVAL_MS: "1", OMI_REGISTRY_PASSWORD: "clave-de-push" } }) },
	);

	const image = "registry-acme.ohmyinfra.test/acme/tienda/api:1.2.0";
	const build = runner.commands.find((command) => command.command === "docker" && command.args[0] === "build");
	const buildArgs = build?.args.join(" ") ?? "";
	assert.match(buildArgs, /--platform linux\/amd64/);
	assert.match(buildArgs, /--build-arg VERSION=1\.2\.0/);
	assert.match(buildArgs, /--build-arg GIT_COMMIT=abc123/);
	assert.match(buildArgs, /--build-arg BUILD_DATE=\d{4}-\d{2}-\d{2}T/);
	assert.match(buildArgs, /--label org\.opencontainers\.image\.version=1\.2\.0/);
	assert.match(buildArgs, /--label org\.opencontainers\.image\.revision=abc123/);
	assert.match(buildArgs, /--label org\.opencontainers\.image\.created=\d{4}/);
	assert.ok(build?.args.includes(image));

	const regctl = runner.commands.filter((command) => command.command === "regctl");
	assert.deepEqual(regctl[0]?.args, ["registry", "set", "registry-acme.ohmyinfra.test", "--tls", "enabled", "--blob-chunk", "52428800", "--blob-max", "52428800", "--skip-check"]);
	assert.deepEqual(regctl[1]?.args, ["registry", "login", "registry-acme.ohmyinfra.test", "--user", "ci-push", "--pass-stdin"]);
	assert.equal(regctl[1]?.input, "clave-de-push");
	assert.equal(regctl[2]?.args[0], "image");
	assert.equal(regctl[2]?.args[1], "import");
	assert.equal(regctl[2]?.args[2], image);

	const everything = JSON.stringify(runner.commands.map((command) => command.args)) + JSON.stringify(result);
	assert.doesNotMatch(everything, /clave-de-push/);
	assert.equal((result.data as { via: string }).via, "direct");
});

test("omi_publish_version --via direct_respeta la ruta y el dockerfile del service", async (t) => {
	const linked = await linkedProject(t);
	await writeFile(join(linked.repo, ".omi/project.json"), JSON.stringify({ version: 1, organizationSlug: "acme", projectSlug: "tienda", services: [{ name: "api", path: "services/api", port: 8080, dockerfile: "Dockerfile.prod" }] }));
	await mkdir(join(linked.repo, "services/api"), { recursive: true });
	await writeFile(join(linked.repo, "services/api/Dockerfile.prod"), "FROM scratch\n");
	linked.workloads.scan = { tag: "1.2.0", afterRefreshes: 1, refreshes: 0 };
	const runner = directRunner();
	await linked.call("omi_publish_version", { ...publish, via: "direct" }, { runner, io: linked.io({ env: { OMI_POLL_INTERVAL_MS: "1", OMI_REGISTRY_PASSWORD: "x" } }) });
	const build = runner.commands.find((command) => command.args[0] === "build")?.args ?? [];
	assert.equal(build.at(-1), "services/api");
	assert.equal(build[build.indexOf("-f") + 1], "services/api/Dockerfile.prod");
});

test("omi_publish_version --via direct_sin credencial no construye nada", async (t) => {
	const linked = await linkedProject(t);
	await writeFile(join(linked.repo, "Dockerfile"), "FROM scratch\n");
	const runner = directRunner();
	await assert.rejects(
		linked.call("omi_publish_version", { ...publish, via: "direct" }, { runner }),
		(error: OmiError) => error.code === "secret_input_unavailable",
	);
	assert.equal(runner.commands.some((command) => command.command === "docker"), false);
});

test("omi_publish_version directo no reconstruye una versión ya publicada", async (t) => {
	const linked = await linkedProject(t);
	await writeFile(join(linked.repo, "Dockerfile"), "FROM scratch\n");
	const service = linked.project.services.get("api");
	assert.ok(service);
	service.view.versions = [{ tag: "1.2.0", prerelease: false }];
	const runner = directRunner();
	await assert.rejects(linked.call("omi_publish_version", { ...publish, via: "direct", timeoutSeconds: 0 }, {
		runner, io: linked.io({ env: { OMI_REGISTRY_PASSWORD: "x" } }),
	}), (error: OmiError) => error.code === "version_exists");
	assert.equal(runner.commands.some((command) => command.command === "docker" || command.command === "regctl"), false);
});

test("omi_publish_version retoma sólo la espera después de un timeout, sin tocar tags ni construir", async (t) => {
	const linked = await linkedProject(t);
	await gitRepo(t, linked);
	await assert.rejects(linked.call("omi_publish_version", { ...publish, timeoutSeconds: 0 }, { runner: processRunner }),
		(error: OmiError) => error.code === "version_not_detected");
	linked.workloads.scan = { tag: "1.2.0", afterRefreshes: 1, refreshes: 0 };
	const runner = fakeRunner(() => { throw new Error("waitOnly no debe correr comandos"); });
	const result = await linked.call("omi_publish_version", { ...publish, waitOnly: true }, { runner });
	assert.match(result.text, /detectada/);
	assert.equal(runner.commands.length, 0);
});

test("omi_publish_version reintenta registry_not_ready sin volver a publicar", async (t) => {
	const linked = await linkedProject(t);
	await gitRepo(t, linked);
	let calls = 0;
	linked.omi.route("POST /api/v1/organizations/{organizationID}/projects/{projectSlug}/services/{serviceName}/versions/refresh", () => {
		calls += 1;
		return calls === 1 ? { status: 409, body: { error: { code: "registry_not_ready", message: "todavía no" } } } : { status: 200, body: { versions: [{ tag: "1.2.0" }] } };
	});
	await linked.call("omi_publish_version", publish, { runner: processRunner });
	assert.equal(calls, 2);
});

test("omi_publish_version_sin sesión autorizada ni humano queda bloqueada", async (t) => {
	const linked = await linkedProject(t);
	await writeFile(join(linked.repo, "Dockerfile"), "FROM scratch\n");
	const runner = directRunner();
	await assert.rejects(
		linked.call("omi_publish_version", { ...publish, via: "direct" }, { runner, guard: humanless(false), io: linked.io({ env: { OMI_REGISTRY_PASSWORD: "x" } }) }),
		(error: OmiError) => error.code === "guardrail_confirmation_required",
	);
	assert.equal(runner.commands.some((command) => command.command === "docker"), false);
});
