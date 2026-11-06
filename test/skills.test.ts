import assert from "node:assert/strict";
import { readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const root = fileURLToPath(new URL("../skills", import.meta.url));
const EXPECTED = ["code-review", "coding-policies", "design-system", "grill", "init", "issue-triage", "land", "run", "ship", "spec", "tdd"];

/** Lee claves de primer nivel, incluidos los valores en bloque `>-`. */
function frontmatter(source: string): Record<string, string> {
	const block = /^---\n([\s\S]*?)\n---\n/.exec(source)?.[1] ?? "";
	const fields: Record<string, string> = {};
	let current = "";
	for (const line of block.split("\n")) {
		if (line.startsWith(" ")) {
			fields[current] = `${fields[current] ?? ""} ${line.trim()}`.trim();
			continue;
		}
		const separator = line.indexOf(":");
		current = line.slice(0, separator);
		const value = line.slice(separator + 1).trim();
		fields[current] = value === ">-" ? "" : value;
	}
	return fields;
}

async function skill(name: string): Promise<string> {
	return readFile(join(root, name, "SKILL.md"), "utf8");
}

test("skills_están los once del flujo y nada más", async () => {
	const entries = (await readdir(root)).sort();
	assert.deepEqual(entries, EXPECTED);
});

for (const name of EXPECTED) {
	test(`skills_${name} tiene frontmatter válido y su nombre coincide con la carpeta`, async () => {
		const meta = frontmatter(await skill(name));
		assert.equal(meta.name, name);
		assert.ok((meta.description ?? "").length > 40);
		assert.equal((await stat(join(root, name))).isDirectory(), true);
	});

	test(`skills_${name} no referencia skills de chiche`, async () => {
		assert.doesNotMatch(await skill(name), /\/skill:chiche-|chiche-(init|run|spec|land)\b/);
	});
}

test("spec_exige la sección de impacto OMI", async () => {
	const source = await skill("spec");
	assert.match(source, /## Impacto OMI/);
	for (const item of ["variables", "secretos", "Postgres", "jobs", "puerto", "/health"]) assert.match(source, new RegExp(item, "i"), item);
});

test("run_verifica /health y /version con 200 antes de abrir el PR", async () => {
	const source = await skill("run");
	const check = source.indexOf("Contrato OMI");
	assert.ok(check > 0, "falta la verificación del contrato OMI");
	assert.ok(check < source.indexOf("## Fase 5"), "tiene que ocurrir antes del PR");
	assert.match(source.slice(check, check + 900), /\/health/);
	assert.match(source.slice(check, check + 900), /\/version/);
	assert.match(source.slice(check, check + 900), /200/);
});

test("init_vincula con omi_link_project y .omi/project.json", async () => {
	const source = await skill("init");
	assert.match(source, /omi_link_project/);
	assert.match(source, /\.omi\/project\.json/);
});

test("land_encadena ship", async () => {
	assert.match(await skill("land"), /\/skill:ship/);
});

test("ship_encadena publicar, sincronizar, desplegar y proponer prod en ese orden", async () => {
	const source = await skill("ship");
	const stages = ["omi_publish_version", "omi_env_set", "omi_jobs_manage", "omi_deploy", "omi_logs_tail", "omi_crash_logs", "omi_promote"];
	const positions = stages.map((name) => source.indexOf(name));
	assert.ok(positions.every((position) => position >= 0), stages.join(", "));
	assert.deepEqual([...positions].sort((a, b) => a - b), positions);
	assert.match(source, /\/health/);
});

test("ship_deja prod bajo confirmación humana y no pide secretos", async () => {
	const source = await skill("ship");
	assert.match(source, /Stage es del agente, prod es del humano/);
	assert.match(source, /No pedir, imprimir ni pasar el valor de un secreto/);
});
