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
