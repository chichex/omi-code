import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { GUARDRAIL_CONFIRMATION_REQUIRED, type OmiError } from "../src/core/errors.ts";
import { checkHandler, handlerTemplate, type HandlerLanguage } from "../src/jobs/handler.ts";
import { tempDir } from "./helpers/io.ts";
import { humanless, linkedProject, type Linked } from "./helpers/project.ts";

const JOB = { action: "create", name: "facturar", service: "api", path: "/jobs/facturar", schedule: "0 6 * * *", timeoutSeconds: 120 };

function deployProd(linked: Linked): void {
	const prod = linked.project.services.get("api")?.view.environments.find((environment) => environment.name === "prod");
	if (prod !== undefined) prod.current_version = "1.0.0";
}

const jobsPath = "/api/v1/organizations/org_acme/projects/tienda/jobs";

test("omi_jobs_manage_crea un job con schedule, path y timeout_seconds", async (t) => {
	const linked = await linkedProject(t);
	const result = await linked.call("omi_jobs_manage", JOB);
	assert.deepEqual(linked.omi.requests.find((request) => request.method === "POST")?.body, {
		name: "facturar",
		service: "api",
		path: "/jobs/facturar",
		schedule: "0 6 * * *",
		timezone: "",
		timeout_seconds: 120,
	});
	assert.match(result.text, /facturar/);
});

test("omi_jobs_manage_actualiza con reemplazo completo conservando lo no enviado", async (t) => {
	const linked = await linkedProject(t);
	await linked.call("omi_jobs_manage", JOB);
	await linked.call("omi_jobs_manage", { action: "update", name: "facturar", schedule: "0 7 * * *" });
	assert.deepEqual(linked.omi.requests.find((request) => request.method === "PUT")?.body, {
		service: "api",
		path: "/jobs/facturar",
		schedule: "0 7 * * *",
		timezone: "UTC",
		timeout_seconds: 120,
	});
});

test("omi_jobs_manage_lista, borra y consulta corridas con ambiente", async (t) => {
	const linked = await linkedProject(t);
	await linked.call("omi_jobs_manage", JOB);
	const list = await linked.call("omi_jobs_manage", { action: "list" });
	assert.deepEqual((list.data as { jobs: { name: string }[] }).jobs.map((job) => job.name), ["facturar"]);
	await linked.call("omi_jobs_manage", { action: "runs", name: "facturar", environment: "stage" });
	assert.match(linked.omi.requests.at(-1)?.path ?? "", /runs\?environment=stage$/);
	await linked.call("omi_jobs_manage", { action: "delete", name: "facturar" });
	assert.equal(linked.workloads.jobs.size, 0);
});

test("omi_jobs_manage_run, pause y resume mandan el cuerpo {} obligatorio", async (t) => {
	const linked = await linkedProject(t);
	await linked.call("omi_jobs_manage", JOB);
	for (const action of ["run", "pause", "resume"]) {
		await linked.call("omi_jobs_manage", { action, name: "facturar", environment: "stage" });
		assert.deepEqual(linked.omi.requests.at(-1)?.body, {});
		assert.equal(linked.omi.requests.at(-1)?.path, `${jobsPath}/facturar/environments/stage/${action}`);
	}
});

test("omi_jobs_manage_en stage autorizado no pregunta", async (t) => {
	const linked = await linkedProject(t);
	await linked.call("omi_jobs_manage", JOB, { guard: humanless(true) });
	assert.equal(linked.workloads.jobs.size, 1);
});

test("omi_jobs_manage_un job de un service con prod desplegado exige un humano", async (t) => {
	const linked = await linkedProject(t);
	deployProd(linked);
	await assert.rejects(
		linked.call("omi_jobs_manage", JOB, { guard: humanless(true) }),
		(error: OmiError) => error.code === GUARDRAIL_CONFIRMATION_REQUIRED,
	);
	assert.deepEqual(linked.mutations(), []);
});

test("mover un job de un service con prod desplegado a otro sin prod sigue exigiendo humano", async (t) => {
	const linked = await linkedProject(t, [["api", 8080], ["worker", 8080]]);
	await linked.call("omi_jobs_manage", JOB);
	deployProd(linked);
	const before = linked.mutations().length;
	await assert.rejects(linked.call("omi_jobs_manage", { action: "update", name: "facturar", service: "worker" }, { guard: humanless(true) }),
		(error: OmiError) => error.code === GUARDRAIL_CONFIRMATION_REQUIRED);
	assert.equal(linked.mutations().length, before);
	assert.equal(linked.workloads.jobs.get("facturar")?.service, "api");
});

test("omi_jobs_manage_operar prod directamente exige un humano", async (t) => {
	const linked = await linkedProject(t);
	await linked.call("omi_jobs_manage", JOB);
	const before = linked.mutations().length;
	await assert.rejects(
		linked.call("omi_jobs_manage", { action: "run", name: "facturar", environment: "prod" }, { guard: humanless(true) }),
		(error: OmiError) => error.code === GUARDRAIL_CONFIRMATION_REQUIRED,
	);
	assert.equal(linked.mutations().length, before);
});

test("omi_jobs_manage_devuelve la plantilla del handler para el lenguaje pedido", async (t) => {
	const linked = await linkedProject(t);
	const result = await linked.call("omi_jobs_manage", { action: "handler_template", language: "go", path: "/jobs/facturar" });
	assert.match(result.text, /github\.com\/chichex\/omi\/trigger/);
	assert.match(result.text, /\/jobs\/facturar/);
});

test("omi_jobs_manage_verifica un archivo del repo con el chequeo estático", async (t) => {
	const linked = await linkedProject(t);
	await writeFile(join(linked.repo, "handler.ts"), "export function h() {}\n");
	await assert.rejects(
		linked.call("omi_jobs_manage", { action: "handler_check", file: "handler.ts" }),
		(error: OmiError) => error.code === "handler_unsigned" && /X-Omi-Signature/.test(error.message),
	);
	await writeFile(join(linked.repo, "handler.ts"), handlerTemplate("ts", "/jobs/x"));
	const result = await linked.call("omi_jobs_manage", { action: "handler_check", file: "handler.ts" });
	assert.deepEqual((result.data as { missing: string[] }).missing, []);
});

for (const language of ["go", "ts", "python"] as const) {
	test(`handlerTemplate_${language} pasa su propio chequeo`, () => {
		assert.deepEqual(checkHandler(handlerTemplate(language, "/jobs/x"), language), []);
	});
}

const unsigned: [HandlerLanguage, string][] = [
	["go", 'package main\nimport "net/http"\nfunc h(w http.ResponseWriter, r *http.Request) {}\n'],
	["ts", "export const h = (req, res) => res.end();\n"],
	["python", "def h(request):\n    return 'ok'\n"],
];

for (const [language, source] of unsigned) {
	test(`checkHandler_${language} marca un handler sin firma`, () => {
		assert.ok(checkHandler(source, language).length > 0);
	});
}

test("checkHandler_exige comparar en tiempo constante", () => {
	const naive = 'const s = process.env.OMI_TRIGGER_SECRET; const t = req.headers["x-omi-timestamp"]; const g = req.headers["x-omi-signature"]; if (createHmac("sha256", s).update(t + ".").digest("hex") === g) {}';
	assert.deepEqual(checkHandler(naive, "ts"), ["comparación en tiempo constante (timingSafeEqual)", "antigüedad de X-Omi-Timestamp"]);
});

test("la plantilla ts verifica los vectores generados por trigger.Sign de Go", async (t) => {
	t.mock.method(Date, "now", () => 1793858403_000);
	const dir = await tempDir(t);
	const file = join(dir, "handler.ts");
	await writeFile(file, handlerTemplate("ts", "/jobs/x"));
	const { verifyOmiJob } = (await import(file)) as { verifyOmiJob(headers: Record<string, string>, body: Buffer): boolean };
	process.env.OMI_TRIGGER_SECRET = "clave";
	t.after(() => delete process.env.OMI_TRIGGER_SECRET);
	const vectors: [string, string][] = [
		["hola", "sha256=6ed8eb894e806517e0c019fea338e8681635eb51fb7879aa7915e19c1dbaeb05"],
		["", "sha256=45cee5cb7aa000a62518be34f14f293372d4dbf9bf3ff1fdd191e792c75516ac"],
	];
	for (const [body, signature] of vectors) {
		const headers = { "x-omi-timestamp": "1793858403", "x-omi-signature": signature };
		assert.equal(verifyOmiJob(headers, Buffer.from(body)), true);
		assert.equal(verifyOmiJob({ ...headers, "x-omi-timestamp": "1793858404" }, Buffer.from(body)), false);
	}
});

test("la plantilla ts rechaza firmas válidas fuera de la ventana temporal y timestamps inválidos", async (t) => {
	t.mock.method(Date, "now", () => 1793858403_000);
	const file = join(await tempDir(t), "handler.ts");
	await writeFile(file, handlerTemplate("ts", "/jobs/x"));
	const { verifyOmiJob } = await import(file);
	const previous = process.env.OMI_TRIGGER_SECRET;
	t.after(() => { if (previous === undefined) delete process.env.OMI_TRIGGER_SECRET; else process.env.OMI_TRIGGER_SECRET = previous; });
	process.env.OMI_TRIGGER_SECRET = "clave";
	for (const timestamp of ["1793858102", "1793858704", "not-a-date", "", "1e9"]) {
		const body = Buffer.from("hola");
		const signature = `sha256=${createHmac("sha256", "clave").update(`${timestamp}.`).update(body).digest("hex")}`;
		assert.equal(verifyOmiJob({ "x-omi-timestamp": timestamp, "x-omi-signature": signature }, body), false, timestamp);
	}
});
