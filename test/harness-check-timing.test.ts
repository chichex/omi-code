// Duración de los checks desde la evidencia guardada: sin campos nuevos, sale de finishedAt − startedAt.
import assert from "node:assert/strict";
import { test } from "node:test";
import { sourceHash, type Evidence, type Workflow } from "../src/harness/model.ts";
import { createWorkflow } from "../src/harness/state.ts";
import { heavyCheck, HEAVY_CHECK_MS, lastCompleteMs, MAX_CHECK_TIMEOUT_SECONDS, plannedTimeout, SetupHistory, type SetupRun, timeoutNote } from "../src/harness/check-timing.ts";

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

// Review del incidente (2026-11-26, queue-1-Q1): setup nunca se guarda como evidencia, así que nunca tenía historia y
// siempre esperaba turno. Un npm ci de 5 s esperaba entero el npm test de otro worktree. Ahora el host recuerda en memoria
// cada setup de la sesión: sólo el primero de un comando espera; después, si tardó menos de 30 s, ya no.
const setup = (command: string, ms: number, complete = true, at = T0 + ++id * 1000_000): SetupRun => ({ command, ms, finishedAt: at + ms, complete });
test("check_timing un setup con historia en la sesión sólo es pesado si alguna corrida tardó 30 s o más", () => {
 const empty = workflow([]);
 assert.equal(heavyCheck(empty, "setup", "npm ci", [setup("npm ci", 5000)]), false, "un npm ci rápido ya corrido no espera turno");
 assert.equal(heavyCheck(empty, "setup", "npm ci", [setup("npm install", 5000)]), true, "la historia es del comando exacto");
 assert.equal(heavyCheck(empty, "setup", "npm test", [setup("npm test", 230_000)]), true, "la suite como setup sigue siendo pesada");
 assert.equal(heavyCheck(empty, "setup", "npm ci", [setup("npm ci", 40_000, false)]), true, "una interrumpida que ya tardó 40 s cuenta");
 assert.equal(heavyCheck(empty, "gate", "npm test", [setup("npm test", 200_000)]), true, "y le sirve a un gate del mismo comando");
 assert.equal(heavyCheck(empty, "gate", "npm run typecheck", [setup("npm run typecheck", 1500)]), false);
 const history = new SetupHistory();
 history.record("w1", setup("npm ci", 5000));
 assert.deepEqual(history.of("w1").map((r) => r.command), ["npm ci"]);
 assert.deepEqual(history.of("w2"), [], "por trabajo");
 for (let i = 0; i < 60; i++) history.record("w1", setup(`cmd ${i}`, 10));
 assert.equal(history.of("w1").length, 50, "con tope: guarda las últimas 50");
 assert.equal(history.of("w1").at(-1)?.command, "cmd 59");
});

// Review del incidente (2026-11-26, queue-1-Q3): el piso ignoraba la suite corrida como setup antes del último C. En
// Verificar, el primer gate del mismo comando corría con el timeoutSeconds corto y se cortaba, y la sugerencia tampoco
// usaba la duración medida.
test("check_timing la última corrida completa de un setup de la sesión da el piso y la sugerencia del mismo comando", () => {
 const empty = workflow([]);
 assert.equal(lastCompleteMs(empty, "npm test", [setup("npm test", 230_489)]), 230_489);
 assert.equal(plannedTimeout(240, lastCompleteMs(empty, "npm test", [setup("npm test", 230_489)])).seconds, 346, "el gate de Verificar sube a 1,5× el setup");
 assert.equal(lastCompleteMs(empty, "npm test", [setup("npm test", 230_489, false)]), undefined, "un setup cortado no da la duración");
 assert.equal(lastCompleteMs(empty, "npm test", [setup("npm test ", 230_489)]), undefined, "del mismo comando exacto");
 const later = workflow([run("npm test", 200_000, "passed", T0)]);
 assert.equal(lastCompleteMs(later, "npm test", [setup("npm test", 260_000, true, T0 + 1000_000)]), 260_000, "la más reciente gana, sea gate o setup");
 assert.match(timeoutNote(240, lastCompleteMs(empty, "npm test", [setup("npm test", 400_000)])), /timeoutSeconds: 600\.$/, "la sugerencia tras un corte usa lo medido como setup");
});

// Review del incidente (ronda 2, queue-2-interrumpida-corta-vuelve-liviano): una corrida interrumpida corta (un Esc a los 5 s,
// un timeoutSeconds de 20) no dice cuánto tarda el comando, pero lo volvía liviano y npm test dejaba de esperar turno.
test("check_timing sólo una corrida completa prueba que un comando es liviano; una interrumpida corta no", () => {
 assert.equal(heavyCheck(workflow([run("npm test", 5000, "interrupted")]), "gate", "npm test"), true, "un gate interrumpido a los 5 s sigue pesado");
 assert.equal(heavyCheck(workflow([]), "setup", "npm test", [setup("npm test", 20_000, false)]), true, "un setup cortado a los 20 s también");
 assert.equal(heavyCheck(workflow([run("npm test", 5000, "interrupted")]), "verification", "npm test"), false, "sin corrida completa vale la regla sin historia");
 assert.equal(heavyCheck(workflow([run("npm test", 5000, "interrupted"), run("npm test", 8000, "passed")]), "gate", "npm test"), false, "con una completa corta, liviano");
 assert.equal(heavyCheck(workflow([run("npm test", 5000, "passed"), run("npm test", 40_000, "interrupted")]), "gate", "npm test"), true, "una interrumpida de 30 s o más sigue contando");
});
