// Stack de PRs: la spec agrupa los pasos C y el reducer planea, registra y actualiza los PRs.
import assert from "node:assert/strict";
import { test } from "node:test";
import { Value } from "typebox/value";
import { createWorkflow, transition } from "../src/harness/state.ts";
import { parseWorkflow, SpecSchema, sourceHash, type Evidence, type Exploration, type Plan, type Spec, type Workflow } from "../src/harness/model.ts";
import { stackGroups, stackIssueLine, stackLines } from "../src/harness/stack.ts";

const at = "2026-01-01T00:00:00Z";
const source = { number: 7, title: "Stack", body: "Pedido grande", url: "https://github.com/acme/repo/issues/7", hash: sourceHash("Stack", "Pedido grande") };
const checkout = { root: "/repo", commonDir: "/repo/.git", branch: "feat/issue-7", baseCommit: "base" };
const exploration: Exploration = { references: [{ path: "src/a.ts", line: 1, detail: "entrada" }], findings: [], approach: "extender", missingFoundation: [], dependencies: [], disposition: "continue", reason: "listo" };
const plan: Plan = { classification: { type: "add", size: "large", risk: "low", riskAreas: [], causeKnown: true }, objective: "cambio grande", approach: "por partes", scope: ["a"], outOfScope: [], cases: [{ id: "D1", description: "anda", command: "npm test" }], lenses: [], executor: { mode: "inline", writers: 0 } };
const steps = [{ id: "C1", title: "Modelo", cases: ["D1"] }, { id: "C2", title: "Estado", cases: ["D1"] }, { id: "C3", title: "Vista", cases: ["D1"] }];
const groups = [{ title: "Modelo y estado", steps: ["C1", "C2"] }, { title: "Vista", steps: ["C3"] }];
const spec = (stack: Spec["stack"] | null = groups): Spec => ({ why: "Se revisa mejor por partes", steps, playbook: ["Probar"], ...(stack ? { stack } : {}) });
const send = (s: Workflow, event: Parameters<typeof transition>[1]) => transition(s, event, at);
function specified(stack: Spec["stack"] | null = groups): Workflow {
 let s = send(createWorkflow(source, checkout, "w", at), { type: "explored", exploration });
 s = send(s, { type: "inferences", inferences: [] }); s = send(s, { type: "planned", plan });
 return send(s, { type: "specified", spec: spec(stack) });
}
const evidence = (kind: Evidence["kind"], changes: Partial<Evidence> = {}): Evidence => ({ id: `${kind}-${changes.stepId ?? ""}${changes.head ?? ""}`, kind, command: "npm test", stepId: null, caseId: "D1", exitCode: kind === "red" ? 1 : 0, outcome: kind === "red" ? "failed" : "passed", output: "", fingerprint: "tree", head: "c3", startedAt: at, finishedAt: at, ...changes });
function implement(s: Workflow, ids: string[]): Workflow {
 for (const id of ids) {
  s = send(s, { type: "step_started", id });
  s = send(s, { type: "evidence", evidence: evidence("red", { stepId: id, caseId: null }) });
  s = send(s, { type: "evidence", evidence: evidence("green", { stepId: id, caseId: null }) });
  s = send(s, { type: "step_completed", id, commit: id.toLowerCase(), fingerprint: "tree" });
 }
 return s;
}
function verified(stack: Spec["stack"] | null = groups, head = "c3"): Workflow {
 let s = implement(send(specified(stack), { type: "approved" }), ["C1", "C2", "C3"]);
 s = send(s, { type: "evidence", evidence: evidence("verification", { head }) });
 return send(s, { type: "verified", fingerprint: "tree" });
}
const pending = (s: Workflow, head = "c3") => send(s, { type: "publishing", head, bodyHash: "artifact" });
const receipts = [{ number: 3, url: "https://github.com/acme/repo/pull/3" }, { number: 4, url: "https://github.com/acme/repo/pull/4" }];
const opened = () => send(pending(verified()), { type: "published", head: "c3", url: receipts[1]!.url, number: 4, stack: receipts });

test("stack: la spec agrupa sus pasos C en PRs; sin grupos es un solo PR, como antes", () => {
 assert.equal(Value.Check(SpecSchema, spec()), true);
 assert.equal(Value.Check(SpecSchema, spec(null)), true, "una spec sin stack sigue valiendo");
 assert.deepEqual(specified().spec?.stack, groups);
 assert.deepEqual(stackGroups(specified()), groups);
 assert.equal(stackGroups(specified(null)), null, "sin stack, un solo PR");
});

test("stack: los grupos cubren cada paso C una vez, contiguos y en orden", () => {
 const invalid: [Spec["stack"], RegExp][] = [
  [[{ title: "A", steps: ["C1"] }, { title: "B", steps: ["C3"] }, { title: "C", steps: ["C2"] }], /orden/],
  [[{ title: "A", steps: ["C1", "C3"] }, { title: "B", steps: ["C2"] }], /orden/],
  [[{ title: "A", steps: ["C1"] }, { title: "B", steps: ["C2"] }], /C3/],
  [[{ title: "A", steps: ["C1", "C2"] }, { title: "B", steps: ["C2", "C3"] }], /una vez|orden/],
  [[{ title: "A", steps: ["C1", "C2"] }, { title: "B", steps: ["C3", "C4"] }], /C4/],
  [[{ title: "A", steps: ["C1", "C2", "C3"] }], /al menos dos/],
 ];
 for (const [stack, message] of invalid) assert.throws(() => specified(stack), message, JSON.stringify(stack));
});

test("stack: publicar planea una rama por PR, el primero sobre main y cada uno sobre el de abajo", () => {
 const s = pending(verified());
 assert.equal(s.publication.status, "pending");
 assert.deepEqual(s.publication.status === "pending" ? s.publication.stack : undefined, [
  { title: "Modelo y estado", steps: ["C1", "C2"], branch: "feat/issue-7-1", base: "main", head: "c2", number: null, url: null, status: "planned" },
  { title: "Vista", steps: ["C3"], branch: "feat/issue-7-2", base: "feat/issue-7-1", head: "c3", number: null, url: null, status: "planned" },
 ]);
 const single = pending(verified(null));
 assert.ok(single.publication.status === "pending" && !("stack" in single.publication), "sin stack la publicación queda como antes");
});

test("stack: publicado registra cada PR; el de arriba es la publicación", () => {
 const s = opened();
 assert.equal(s.phase, "done"); assert.equal(s.publication.status, "opened");
 assert.ok(s.publication.status === "opened");
 assert.equal(s.publication.number, 4);
 assert.deepEqual(s.publication.stack?.map((p) => [p.number, p.url, p.status, p.base]), [[3, receipts[0]!.url, "draft", "main"], [4, receipts[1]!.url, "draft", "feat/issue-7-1"]]);
 const waiting = pending(verified());
 assert.throws(() => send(waiting, { type: "published", head: "c3", url: receipts[1]!.url, number: 4 }), /stack/);
 assert.throws(() => send(waiting, { type: "published", head: "c3", url: receipts[1]!.url, number: 4, stack: [receipts[0]!] }), /stack/);
 assert.throws(() => send(waiting, { type: "published", head: "c3", url: receipts[0]!.url, number: 3, stack: receipts }), /arriba|stack/);
 assert.throws(() => send(pending(verified(null)), { type: "published", head: "c3", url: receipts[1]!.url, number: 4, stack: receipts }), /stack/);
});

test("stack: el paso de corrección de una vuelta va en el PR de arriba", () => {
 let s = send(verified(), { type: "retry", reason: "falta un borde" });
 assert.equal(s.steps.at(-1)?.id, "C4");
 assert.deepEqual(stackGroups(s)?.map((g) => g.steps), [["C1", "C2"], ["C3", "C4"]]);
 s = implement(s, ["C4"]);
 s = send(s, { type: "evidence", evidence: evidence("verification", { id: "v4", head: "c4" }) });
 s = pending(send(s, { type: "verified", fingerprint: "tree" }), "c4");
 assert.deepEqual(s.publication.status === "pending" ? s.publication.stack?.map((p) => [p.branch, p.head, p.steps]) : [], [["feat/issue-7-1", "c2", ["C1", "C2"]], ["feat/issue-7-2", "c4", ["C3", "C4"]]]);
});

test("stack: actualizarlo después de abrirlo cambia base, head y estado, nunca la identidad de un PR", () => {
 const s = opened();
 const current = s.publication.status === "opened" ? s.publication.stack! : [];
 const synced = send(s, { type: "stack_synced", stack: [{ ...current[0]!, head: "h1", status: "merged" }, { ...current[1]!, base: "main", head: "m2", status: "open" }] });
 assert.equal(synced.phase, "done"); assert.equal(synced.status, "complete"); assert.equal(synced.revision, s.revision + 1);
 assert.deepEqual(synced.publication.status === "opened" ? synced.publication.stack?.map((p) => [p.base, p.head, p.status]) : [], [["main", "h1", "merged"], ["main", "m2", "open"]]);
 for (const change of [{ number: 9 }, { branch: "otra" }, { steps: ["C3"] }, { url: "https://github.com/acme/repo/pull/9" }]) assert.throws(() => send(s, { type: "stack_synced", stack: [{ ...current[0]!, ...change }, current[1]!] }), /stack/, JSON.stringify(change));
 assert.throws(() => send(synced, { type: "stack_synced", stack: [{ ...current[0]!, status: "draft" }, current[1]!] }), /mergeado/);
 assert.throws(() => send(s, { type: "stack_synced", stack: [current[0]!] }), /stack/);
 assert.throws(() => send(pending(verified()), { type: "stack_synced", stack: current }), /fase|stack/);
});

test("stack: sólo el último PR cierra el issue; los de abajo lo referencian", () => {
 assert.equal(stackIssueLine(42, 0, 2), "Refs #42");
 assert.equal(stackIssueLine(42, 1, 3), "Refs #42");
 assert.equal(stackIssueLine(42, 2, 3), "Closes #42");
});

test("stack: las líneas del progreso muestran cada PR con número, base, pasos y estado", () => {
 assert.deepEqual(stackLines(specified()), ["PR 1 de 2 · sin abrir · base main · C1, C2 · Modelo y estado", "PR 2 de 2 · sin abrir · base PR 1 · C3 · Vista"]);
 assert.deepEqual(stackLines(opened()), ["PR 1 de 2 · #3 · base main · C1, C2 · draft · Modelo y estado", "PR 2 de 2 · #4 · base #3 · C3 · draft · Vista"]);
 assert.deepEqual(stackLines(specified(null)), []);
});

test("stack: un estado guardado sin stack sigue leyéndose igual", () => {
 const legacy = opened();
 const raw = JSON.parse(JSON.stringify(legacy)) as Record<string, unknown> & { spec: Record<string, unknown>; publication: Record<string, unknown> };
 delete raw.spec.stack; delete raw.publication.stack;
 const parsed = parseWorkflow(JSON.stringify(raw));
 assert.equal(stackGroups(parsed), null); assert.deepEqual(stackLines(parsed), []);
});

test("stack: las instrucciones del agente dicen cuándo partir en un stack y cómo actualizarlo", async () => {
 const { developmentInstructions } = await import("../src/tui/development-view.ts");
 let s = send(createWorkflow(source, checkout, "w", at), { type: "explored", exploration });
 s = send(send(s, { type: "inferences", inferences: [] }), { type: "planned", plan });
 assert.equal(s.phase, "spec");
 const guide = developmentInstructions(s);
 assert.match(guide, /stack/); assert.match(guide, /contiguos y en orden/); assert.match(guide, /un solo PR/);
 assert.match(developmentInstructions(pending(verified())), /un draft por grupo/);
 assert.match(developmentInstructions(opened()), /action stack/);
});

test("stack: la sección del issue muestra cada PR con su número, base, pasos y estado", async () => {
 const { renderIssueSection } = await import("../src/harness/issue-section.ts");
 const planned = renderIssueSection(specified());
 assert.match(planned, /^### Stack de PRs$/m);
 assert.match(planned, /^- \*\*PR 1 de 2\*\* · sin abrir · base `main` · pasos C1, C2 · Modelo y estado$/m);
 assert.match(planned, /^- \*\*PR 2 de 2\*\* · sin abrir · base `feat\/issue-7-1` \(PR 1\) · pasos C3 · Vista$/m);
 const section = renderIssueSection(opened());
 assert.match(section, /^- \*\*PR 1 de 2\*\* · https:\/\/github\.com\/acme\/repo\/pull\/3 · base `main` · pasos C1, C2 · draft · Modelo y estado$/m);
 assert.match(section, /^- \*\*PR 2 de 2\*\* · https:\/\/github\.com\/acme\/repo\/pull\/4 · base `feat\/issue-7-1` \(#3\) · pasos C3 · draft · Vista$/m);
 const s = opened(); const current = s.publication.status === "opened" ? s.publication.stack! : [];
 const merged = renderIssueSection(send(s, { type: "stack_synced", stack: [{ ...current[0]!, status: "merged" }, { ...current[1]!, base: "main" }] }));
 assert.match(merged, /^- \*\*PR 1 de 2\*\* · \S+ · base `main` · pasos C1, C2 · mergeado · Modelo y estado$/m);
 assert.match(merged, /^- \*\*PR 2 de 2\*\* · \S+ · base `main` · pasos C3 · draft · Vista$/m);
 const hostile = renderIssueSection(specified([{ title: "![x](https://evil.test/?d=1) @alguien #9", steps: ["C1", "C2"] }, { title: "Vista", steps: ["C3"] }]));
 assert.match(hostile, /· `!\[x\]\(https:\/\/evil\.test\/\?d=1\)` `@alguien` `#9`$/m, "el título de un grupo es datos: nada queda activo");
 assert.doesNotMatch(renderIssueSection(specified(null)), /Stack de PRs/);
});

test("stack: el progreso, la pantalla 6 y la revisión de la receta muestran el stack", async () => {
 const { developmentProgress } = await import("../src/tui/development-view.ts");
 const { WorkflowProgressMonitor, workflowProgressDetail, workflowProgressView } = await import("../src/tui/workspace/workflow-progress.ts");
 const { approvalDocument, approvalText } = await import("../src/tui/development-approval.ts");
 const { getThemeByName } = await import("../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js");
 const { stripTerminalSequences } = await import("@earendil-works/pi-tui");
 const progress = developmentProgress(opened());
 assert.deepEqual(progress.stack, stackLines(opened()));
 assert.equal("stack" in developmentProgress(verified(null)), false, "sin stack el progreso no cambia");
 const monitor = new WorkflowProgressMonitor();
 assert.equal(monitor.consume({ progress: { ...progress, stack: [1] } }), false, "las líneas del stack son texto");
 assert.equal(monitor.consume({ progress: { ...progress, stack: [...progress.stack!, "PR 3\x1b]0;EVIL\x07"] } }), true);
 const git = { root: "/repo", gitDir: "/repo/.git", commonDir: "/repo/.git", mainRoot: "/repo", linked: false, branch: "feat/issue-7", detached: false, changes: [], changeCount: 0, tracking: false, ahead: undefined, behind: undefined };
 const current = monitor.current("/repo", git)!;
 assert.doesNotMatch(JSON.stringify(current), /EVIL|\\u001b/);
 const view = workflowProgressView(getThemeByName("dark")!, current, 100).map(stripTerminalSequences).join("\n");
 assert.match(view, /Stack de PRs/); assert.match(view, /PR 2 de 2 · #4 · base #3 · C3 · draft · Vista/);
 const detail = JSON.stringify(workflowProgressDetail(current));
 assert.match(detail, /Stack de PRs/); assert.match(detail, /PR 1 de 2 · #3 · base main/);
 const review = approvalText(approvalDocument(specified()));
 assert.match(review, /Stack de PRs/); assert.match(review, /PR 2 de 2 · sin abrir · base PR 1 · C3 · Vista/);
 assert.doesNotMatch(approvalText(approvalDocument(specified(null))), /Stack de PRs/);
});
