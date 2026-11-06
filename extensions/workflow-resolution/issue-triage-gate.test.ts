// Del gate multi-harness del origen queda lo que aplica a un solo harness: el contrato de
// `issue-triage` y `spec` de este repo. La paridad entre Claude, Codex, OpenCode y Pi no aplica.

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

async function readSkill(name: string): Promise<string> {
	return readFile(new URL(`../../skills/${name}/SKILL.md`, import.meta.url), "utf8");
}

function artifactAwareBlock(markdown: string): string {
	const match = markdown.match(
		/<!-- artifact-aware:start -->\n([\s\S]*?)\n<!-- artifact-aware:end -->/,
	);
	assert.ok(match?.[1], "bloque normativo artifact-aware presente");
	return match[1];
}

const REQUIRED_ROUTES = [
	"resume-grill",
	"spec-from-grill",
	"update-existing-spec",
	"run-existing-spec",
	"already-implemented",
	"superseded-artifact",
	"audit-existing-spec",
	"artifact-conflict",
] as const;

const REQUIRED_SCHEMA_FIELDS = [
	"version",
	"outcome",
	"code",
	"recommendedClassification",
	"fallbackClassification",
	"recommendedRoute",
	"selectedRoute",
	"stage",
	"mode",
	"repo",
	"cwd",
	"sources",
	"canonicalIssue",
	"summary",
	"impactExample",
	"scope",
	"checklist",
	"evidence",
	"risks",
	"artifacts",
] as const;

test("issue-triage keeps its artifact-aware contract", async () => {
	const markdown = await readSkill("issue-triage");
	assert.doesNotMatch(markdown, /## Fase 6 — Ejecutar la ruta/);
	assert.doesNotMatch(markdown, /Creá un worktree hermano/);
	assert.doesNotMatch(markdown, /Cargá (?:completo )?(?:el skill )?[`~/.a-z-]*(?:grill|spec)\/SKILL\.md/);

	const contract = artifactAwareBlock(markdown);
	for (const route of REQUIRED_ROUTES) assert.match(contract, new RegExp(`\\b${route}\\b`), route);
	for (const field of REQUIRED_SCHEMA_FIELDS) assert.match(contract, new RegExp(`\\b${field}\\b`), field);
	for (const rule of [
		"parseSddArtifact",
		"CRLF",
		"Body original",
		"superseded-by",
		"fresh|stale|unknown",
		"parentId",
		"canonicalization",
		"selectedRoute=null",
		"JSON.parse(JSON.stringify(result))",
	]) {
		assert.ok(contract.includes(rule), rule);
	}
	assert.match(contract, /no ejecuta pasos de ningún stage/i);
	assert.match(contract, /en Pi lo abre el orquestador de `\/issues`/);
	assert.doesNotMatch(contract, /triage produce contexto y termina/);
});

test("spec advertises its full signature", async () => {
	const markdown = await readSkill("spec");
	const signature = markdown.match(/## Argumentos\n\n```text\n([^\n]+)\n```/)?.[1];
	assert.ok(signature, "firma de argumentos presente");
	assert.ok(markdown.includes(`Atajo: ${signature} saltea este menu.`), "atajo alineado con la firma");
	assert.match(markdown, /Los argumentos[^\n]*una ruta de spec para actualizarla/, "intro menciona la ruta de spec");
});

test("issue-triage keeps chaining in the orchestrator, not in the skill", async () => {
	const markdown = await readSkill("issue-triage");
	assert.doesNotMatch(markdown, /<!-- stage-chain:start -->/);
	assert.match(markdown, /submit_workflow_resolution/);
});
