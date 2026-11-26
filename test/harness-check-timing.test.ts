// Duración de los checks desde la evidencia guardada: sin campos nuevos, sale de finishedAt − startedAt.
import assert from "node:assert/strict";
import { test } from "node:test";
import { sourceHash, type Evidence, type Workflow } from "../src/harness/model.ts";
import { createWorkflow } from "../src/harness/state.ts";
import { heavyCheck, HEAVY_CHECK_MS, lastCompleteMs, MAX_CHECK_TIMEOUT_SECONDS, plannedTimeout, timeoutNote } from "../src/harness/check-timing.ts";

const T0 = Date.parse("2026-11-26T03:00:00.000Z");
let id = 0;
function run(command: string, ms: number, outcome: Evidence["outcome"] = "failed", at = T0 + ++id * 1000_000): Evidence {
 return { id: `e${id}`, kind: "gate", command, stepId: null, caseId: null, exitCode: outcome === "interrupted" ? null : outcome === "passed" ? 0 : 1, outcome, output: "",
  fingerprint: "f", head: "h", startedAt: new Date(at).toISOString(), finishedAt: new Date(at + ms).toISOString() };
}
// La evidencia vigente y la archivada por vuelta, que es lo que lee check-timing.
function workflow(current: Evidence[], ...rounds: Evidence[][]): Workflow {
 const source = { number: 7, title: "Change", body: "Details", url: "https://example.test/7", hash: sourceHash("Change", "Details") };
 const state = createWorkflow(source, { root: "/repo", commonDir: "/repo/.git", branch: "work", baseCommit: "base" }, "id", "now");
 state.evidence = current;
 if (rounds.length) state.attempts = rounds.map((evidence, round) => ({ sourceHash: source.hash, round, reason: "retry", at: "now", evidence, reviews: [] }));
 return state;
}

test("check_timing la última corrida completa sale de cualquier vuelta, del mismo comando exacto, y nunca de una interrumpida", () => {
 // El caso de #99: 230 s en la vuelta 0, 240 s cortada y 245 s en la 1, 209 s en la 2; la vigente no corrió npm test.
 const state = workflow([run("npm run typecheck", 1500, "passed")],
  [run("npm test", 230_489)], [run("npm test", 240_381, "interrupted"), run("npm test", 245_005)], [run("npm test", 209_050, "passed"), run("npm test ", 999_000, "passed")]);
 assert.equal(lastCompleteMs(state, "npm test"), 209_050, "la última completa, de una vuelta archivada; otro comando no cuenta aunque difiera en un espacio");
 assert.equal(lastCompleteMs(workflow([run("npm test", 240_147, "interrupted")]), "npm test"), undefined, "una interrumpida nunca da la duración");
 assert.equal(lastCompleteMs(workflow([run("npm test", 346_049, "failed"), run("npm test", 240_147, "interrupted")], [run("npm test", 10_000, "passed", T0)]), "npm test"), 346_049, "la vigente gana a una vuelta anterior y la interrumpida posterior no la tapa");
 assert.equal(lastCompleteMs(workflow([]), "npm test"), undefined);
 const broken = { ...run("npm test", 5000, "passed"), finishedAt: "no es fecha" }; const negative = run("npm test", -5000, "passed");
 assert.equal(lastCompleteMs(workflow([run("npm test", 7000, "passed"), broken, negative]), "npm test"), 7000, "descarta NaN y negativos");
});

test("check_timing un timeout menor que 1,5× la última corrida completa sube a ese piso y lo dice: el caso de #99", () => {
 assert.deepEqual(plannedTimeout(240, 230_489), { seconds: 346, note: "timeoutSeconds 240 → 346: la última corrida completa de este comando tardó 230 s; el host deja 1,5× de margen." });
 assert.equal(plannedTimeout(300, 346_049).seconds, 520, "el piso de npm test en #98");
 assert.equal(plannedTimeout(300, 209_050).seconds, 314, "el piso de npm test en #99");
 assert.deepEqual(plannedTimeout(600, 230_489), { seconds: 600 }, "un timeout que ya alcanza no cambia");
 assert.deepEqual(plannedTimeout(240, undefined), { seconds: 240 }, "sin corrida completa no hay piso");
 assert.deepEqual(plannedTimeout(240, 1_500_000), { seconds: MAX_CHECK_TIMEOUT_SECONDS, note: "timeoutSeconds 240 → 1800: la última corrida completa de este comando tardó 1500 s; el host deja 1,5× de margen, con tope de 1800 s." });
});

test("check_timing al cortarse por tiempo sugiere el doble del usado o 1,5× lo conocido, con tope de 1800", () => {
 assert.equal(timeoutNote(240, undefined), "Se cortó por tiempo a los 240 s. No cuenta como corrida completa: quedó interrumpida. Volvé a correrlo con timeoutSeconds: 480.");
 assert.match(timeoutNote(240, 400_000), /timeoutSeconds: 600\.$/, "1,5× lo conocido si supera el doble");
 assert.match(timeoutNote(240, 100_000), /timeoutSeconds: 480\.$/, "el doble si supera 1,5× lo conocido");
 assert.match(timeoutNote(1200, undefined), /timeoutSeconds: 1800\.$/, "con tope de 1800");
 assert.equal(timeoutNote(1800, 1_500_000), "Se cortó por tiempo a los 1800 s, el tope del host. No cuenta como corrida completa: quedó interrumpida. Partí el comando en partes más chicas.");
});

test("check_timing es pesado un gate o un setup sin historia, o cualquier comando que alguna vez tardó 30 s o más", () => {
 const empty = workflow([]);
 assert.equal(heavyCheck(empty, "gate", "npm test"), true);
 assert.equal(heavyCheck(empty, "setup", "npm test"), true, "la suite como setup antes del último C entra en la cola desde la vuelta 0");
 for (const kind of ["verification", "reproduction", "red", "green"] as const) assert.equal(heavyCheck(empty, kind, "npm test"), false, `${kind} sin historia`);
 const history = workflow([run("npm run typecheck", 1500, "passed")], [run("node --test test/a.test.ts", 240_000, "interrupted")], [run("npm run test:packaging", 43_408, "passed")]);
 assert.equal(heavyCheck(history, "gate", "npm run typecheck"), false, "un gate rápido conocido no espera turno");
 assert.equal(heavyCheck(history, "setup", "npm run typecheck"), false, "la historia es del comando, de cualquier kind");
 assert.equal(heavyCheck(history, "red", "node --test test/a.test.ts"), true, "una corrida interrumpida que ya tardó 4 min también cuenta");
 assert.equal(heavyCheck(history, "verification", "npm run test:packaging"), true);
 assert.equal(heavyCheck(workflow([run("npm test", HEAVY_CHECK_MS - 1, "passed")]), "gate", "npm test"), false, "justo bajo 30 s");
 assert.equal(heavyCheck(workflow([run("npm test", 1000, "passed"), run("npm test", HEAVY_CHECK_MS, "passed")]), "gate", "npm test"), true, "alguna vez 30 s o más");
});
