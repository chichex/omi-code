// Motivo de pausa de la continuidad: un código cerrado y durable, con texto legible y un próximo paso.
// Puro: sin red, Git, modelo ni host.
import assert from "node:assert/strict";
import { test } from "node:test";
import { CONTINUITY_PAUSES, type ContinuityPause } from "../src/harness/continuity-pause.ts";
import { continuityPauseGuide, continuityPauseText } from "../src/harness/continuity-pause-text.ts";
import { migrateWorkflow, sourceHash } from "../src/harness/model.ts";
import { createWorkflow } from "../src/harness/state.ts";
import type { ContinuityStage } from "../src/harness/lifecycle-continuity.ts";

const AT = "2026-01-01T00:00:00Z";
const STAGES = ["entry", "review", "fix", "land", "ship"] as const satisfies readonly ContinuityStage[];
const COMMANDS = { entry: "/omi-work adopt", review: "/omi-work review", fix: "/omi-work fix", land: "/omi-work land", ship: "/omi-work ship" } satisfies Record<ContinuityStage, string>;
const line = (reason: ContinuityPause, stage?: ContinuityStage) => { const g = continuityPauseGuide(reason, stage); return `${g.message}: ${g.next}`; };
function workflow() {
 return createWorkflow({ number: 42, title: "Pausa", body: "Pedido", hash: sourceHash("Pausa", "Pedido"), url: "https://github.com/acme/app/issues/42" }, { root: "/repo", commonDir: "/repo/.git", branch: "feat/pausa", baseCommit: "a".repeat(40) }, "work42", AT);
}

test("los códigos de pausa son un catálogo cerrado: sin códigos muertos y con los del host", () => {
 for (const dead of ["stage-mismatch", "restore"]) assert.ok(!(CONTINUITY_PAUSES as readonly string[]).includes(dead), `${dead} no lo produce nadie`);
 for (const host of ["declined", "not-adopted", "no-progress", "continuity-disabled", "error"]) assert.ok((CONTINUITY_PAUSES as readonly string[]).includes(host), `${host} es un motivo propio del host`);
 assert.equal(new Set(CONTINUITY_PAUSES).size, CONTINUITY_PAUSES.length);
});

test("cada código, con o sin etapa, se lee en español con un próximo paso y sin el código crudo", () => {
 for (const reason of CONTINUITY_PAUSES) for (const stage of [undefined, ...STAGES]) {
  const { message, next } = continuityPauseGuide(reason, stage);
  assert.match(message, /^[A-ZÁÉÍÓÚÑ]/, `${reason}: el mensaje empieza como oración`);
  assert.match(next, /\S/, `${reason}: siempre hay próximo paso`);
  const all = `${message} ${next}`;
  if (reason.includes("-")) assert.ok(!all.includes(reason), `${reason}: no sale el código crudo`);
  assert.doesNotMatch(all, /undefined|null|\bentry\b|·/, `${reason}/${stage}: sin claves internas ni separadores de código`);
 }
});

test("los ejemplos del dueño: manual nombra el comando de su etapa; config, incierto, presupuesto y rondas", () => {
 assert.equal(line("manual", "review"), "Review está en manual: corré /omi-work review");
 for (const stage of STAGES) assert.ok(line("manual", stage).endsWith(`corré ${COMMANDS[stage]}`), `manual · ${stage}`);
 assert.equal(line("config-required"), "Falta configurar el lifecycle: /omi-setup");
 assert.equal(line("operation-unsettled"), "Hay una operación con resultado incierto: no se repite sola; revisá en GitHub");
 assert.match(line("review-facts-required"), /\/omi-work review/);
 assert.match(line("budget-exhausted"), /presupuesto/i);
 assert.match(line("rounds-exhausted"), /rondas/i);
 assert.match(line("human-required"), /decisión humana/i);
 assert.match(line("continuity-disabled", "land"), /ya no tiene continuidad.*\/omi-work land/);
 assert.match(line("declined", "fix"), /Dijiste que no.*\/omi-work fix/);
 assert.match(line("error"), /no se reintenta/i);
});

test("el detalle de texto libre acompaña al código genérico, sin reemplazarlo", () => {
 const detail = "Push de la corrección al PR #8: no. No se ejecutó nada.";
 const text = continuityPauseText({ reason: "declined", stage: "fix", detail });
 assert.ok(text.startsWith(line("declined", "fix")), "primero el motivo y el próximo paso");
 assert.ok(text.includes(`Detalle: ${detail}`));
 assert.equal(continuityPauseText({ reason: "manual", stage: "review" }), line("manual", "review"));
});

test("el estado guarda la pausa estructurada; los estados sin el campo siguen valiendo", () => {
 const w = workflow();
 assert.equal(Object.hasOwn(migrateWorkflow(JSON.parse(JSON.stringify(w))), "continuityPause"), false, "un estado guardado antes no cambia");
 const pause = { reason: "manual", stage: "review", subjectId: "pr:8:" + "b".repeat(40), lastOperationId: "review:1", at: AT, detail: "texto" };
 assert.deepEqual(migrateWorkflow({ ...w, continuityPause: pause }).continuityPause, pause);
 assert.deepEqual(migrateWorkflow({ ...w, continuityPause: { reason: "error", at: AT } }).continuityPause, { reason: "error", at: AT });
 const invalid = [{ ...pause, reason: "stage-mismatch" }, { ...pause, reason: "Continuidad en pausa: manual · review" }, { ...pause, stage: "deploy" },
  { ...pause, extra: true }, { ...pause, at: "" }, { ...pause, detail: " " }, { reason: "manual" }, "Continuidad en pausa: manual"];
 for (const continuityPause of invalid) assert.throws(() => migrateWorkflow({ ...w, continuityPause }), /Estado del harness inválido/, JSON.stringify(continuityPause));
});

// S2.3 · Un stack publicado no entra a la cadena.
test("stack-unsupported: dice cuántos PRs tiene el stack y qué hacer, con el mismo texto que el adopt manual", async () => {
 const { stackUnsupportedText } = await import("../src/harness/continuity-pause-text.ts");
 const expected = "Este trabajo se publicó como stack de 3 PRs y el lifecycle no adopta stacks: mergealos en orden con su sí";
 assert.equal(continuityPauseText({ reason: "stack-unsupported", stage: "entry", stackPulls: 3 }), expected);
 assert.equal(stackUnsupportedText(3), "Este trabajo se publicó como stack de 3 PRs y el lifecycle no adopta stacks. Mergealos en orden con su sí.");
 assert.match(line("stack-unsupported", "entry"), /stack de PRs y el lifecycle no adopta stacks/, "sin el número no inventa uno");
});

test("la pausa de stack guarda cuántos PRs tenía al pausar; el campo es sólo de esa pausa", async () => {
 const { continuityPauseRecord } = await import("../src/harness/continuity-pause.ts");
 const { MAX_STACK } = await import("../src/harness/model.ts");
 const pull = (index: number, base: string) => ({ title: `Parte ${index}`, steps: [`C${index}`], branch: `feat/pausa-${index}`, base, head: String(index).repeat(40), number: 7 + index, url: `https://github.com/acme/app/pull/${7 + index}`, status: "draft" as const });
 const w = { ...workflow(), phase: "done" as const, publication: { status: "opened" as const, head: "2".repeat(40), number: 9, url: "https://github.com/acme/app/pull/9", stack: [pull(1, "main"), pull(2, "feat/pausa-1")] } };
 assert.deepEqual(continuityPauseRecord(w, { reason: "stack-unsupported", stage: "entry" }, AT), { reason: "stack-unsupported", stage: "entry", subjectId: "2".repeat(40), stackPulls: 2, at: AT });
 assert.equal(Object.hasOwn(continuityPauseRecord(w, { reason: "declined", stage: "entry" }, AT), "stackPulls"), false);
 const saved = { reason: "stack-unsupported", stage: "entry", stackPulls: MAX_STACK, at: AT };
 assert.deepEqual(migrateWorkflow({ ...workflow(), continuityPause: saved }).continuityPause, saved);
 for (const stackPulls of [1, MAX_STACK + 1, 2.5]) assert.throws(() => migrateWorkflow({ ...workflow(), continuityPause: { ...saved, stackPulls } }), /Estado del harness inválido/, String(stackPulls));
});

// S2.3 · Review no observada en esta sesión.
test("review-facts-required: el próximo paso sale de los hallazgos ya registrados y no repite la Review", () => {
 assert.equal(line("review-facts-required", "land"), "La Review del HEAD actual no se observó en esta sesión: corré /omi-work land; relee GitHub y no repite la Review");
 assert.equal(line("review-facts-required", "fix"), "La Review del HEAD actual no se observó en esta sesión: corré /omi-work fix; usa los hallazgos ya registrados");
 assert.match(line("review-facts-required"), /\/omi-work review/, "sin etapa, el comando de siempre");
});

// Ship manual no se configura con /omi-setup: se declara. Sin configurar, el texto sigue valiendo después de configurarlo.
test("ship: sin configurar manda a /omi-setup y después a /omi-work ship; manual manda a declararla", () => {
 assert.equal(line("ship-unconfigured"), "Ship no está configurado: configuralo con /omi-setup y después corré /omi-work ship");
 assert.equal(line("ship-manual" as ContinuityPause), "Ship es manual y OMI no verifica la entrega: declarala con /omi-work ship");
 assert.doesNotMatch(line("ship-manual" as ContinuityPause), /\/omi-setup/, "en manual, /omi-setup no hace nada");
});
