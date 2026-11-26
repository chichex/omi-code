// Contratos del trabajo de desarrollo. Datos del modelo, GitHub y disco se validan al entrar.
import { createHash } from "node:crypto";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import { PHASES, PHASES_V1 } from "./phases.ts";
import { LifecycleStateSchema } from "./lifecycle-state-schema.ts";
import { validateLifecycleState } from "./lifecycle-invariants.ts";
import { validateCorrectionWorkflow } from "./correction-invariants.ts";
import { ContinuityPauseSchema } from "./continuity-pause.ts";

// Topes compartidos por el esquema y el reducer: el reducer los respeta antes de validar.
export const MAX_HISTORY = 1000; export const MAX_STEPS = 50; export const MAX_STACK = 10; export const MAX_ATTEMPTS = 100; export const MAX_EVIDENCE = 1000; export const MAX_REVIEWS = 100; export const MAX_AGREEMENTS = 50; export const MAX_GRANTS = 200; export const MAX_AMENDS = 2; export const MAX_ACCEPTED_RISKS = 10;
export const text = (maxLength = 4000) => Type.String({ minLength: 1, maxLength, pattern: "\\S" });
const list = () => Type.Array(text(), { maxItems: 100 });
const nullableText = () => Type.Union([text(8192), Type.Null()]);
const LegacyPhaseSchema = Type.Enum(PHASES_V1.map(p => p.id));
export const PhaseSchema = Type.Enum(PHASES.map(p => p.id));
export type Phase = Static<typeof PhaseSchema>;
export const LensSchema = Type.Union([Type.Literal("compliance"), Type.Literal("security"), Type.Literal("reliability"), Type.Literal("quality"), Type.Literal("resilience"), Type.Literal("refuter")]);
export type Lens = Static<typeof LensSchema>;
export const ReferenceSchema = Type.Object({ path: text(8192), line: Type.Integer({ minimum: 1 }), detail: text() }, { additionalProperties: false });
export const ExplorationSchema = Type.Object({
	references: Type.Array(ReferenceSchema, { maxItems: 100 }), findings: list(), approach: text(), missingFoundation: list(), fingerprint: Type.Optional(text(128)),
	dependencies: Type.Array(Type.Object({ name: text(), blocking: Type.Boolean(), ready: Type.Boolean() }, { additionalProperties: false }), { maxItems: 50 }),
	disposition: Type.Union([Type.Literal("continue"), Type.Literal("needs-info"), Type.Literal("wontfix")]), reason: text(),
}, { additionalProperties: false });
export type Exploration = Static<typeof ExplorationSchema>;
export const InferenceInputSchema = Type.Object({
	id: text(32), kind: Type.Union([Type.Literal("what"), Type.Literal("how")]), question: text(), recommended: text(),
	confidence: Type.Integer({ minimum: 0, maximum: 100 }), irreversible: Type.Boolean(), references: Type.Array(ReferenceSchema, { maxItems: 30 }),
}, { additionalProperties: false });
export type InferenceInput = Static<typeof InferenceInputSchema>;
export const InferenceSchema = Type.Union([
	Type.Object({ ...InferenceInputSchema.properties, resolution: Type.Literal("pending"), answer: Type.Null() }, { additionalProperties: false }),
	Type.Object({ ...InferenceInputSchema.properties, resolution: Type.Literal("assumed"), answer: text() }, { additionalProperties: false }),
	Type.Object({ ...InferenceInputSchema.properties, resolution: Type.Literal("answered"), answer: text() }, { additionalProperties: false }),
]);
export type Inference = InferenceInput & { resolution: "pending" | "assumed" | "answered"; answer: string | null };
export const CaseSchema = Type.Object({ id: text(32), description: text(), command: text(8192) }, { additionalProperties: false });
export const PlanSchema = Type.Object({
	classification: Type.Object({
		type: Type.Union([Type.Literal("add"), Type.Literal("fix"), Type.Literal("improve"), Type.Literal("chore")]),
		size: Type.Union([Type.Literal("small"), Type.Literal("large")]), risk: Type.Union([Type.Literal("low"), Type.Literal("high")]),
		riskAreas: list(), causeKnown: Type.Boolean(),
	}, { additionalProperties: false }),
	objective: text(), approach: text(), scope: list(), outOfScope: list(), cases: Type.Array(CaseSchema, { minItems: 1, maxItems: 100 }),
	lenses: Type.Array(LensSchema, { maxItems: 6 }),
	executor: Type.Object({ mode: Type.Union([Type.Literal("inline"), Type.Literal("subagents")]), writers: Type.Integer({ minimum: 0, maximum: 4 }) }, { additionalProperties: false }),
}, { additionalProperties: false });
export type Plan = Static<typeof PlanSchema>;
export const RecipeSchema = Type.Object({ ...PlanSchema.properties, route: Type.Union([Type.Literal("direct"), Type.Literal("diagnostic"), Type.Literal("spec")]) }, { additionalProperties: false });
export type Recipe = Static<typeof RecipeSchema>;
export const StepInputSchema = Type.Object({ id: text(32), title: text(), cases: Type.Array(text(32), { minItems: 1, maxItems: 100 }) }, { additionalProperties: false });
export type StepInput = Static<typeof StepInputSchema>;
// Stack de PRs: grupos contiguos de pasos C, uno por PR. Sin stack, el trabajo va en un solo PR.
const stackSteps = () => Type.Array(text(32), { minItems: 1, maxItems: MAX_STEPS });
export const StackGroupSchema = Type.Object({ title: text(200), steps: stackSteps() }, { additionalProperties: false });
export const SpecSchema = Type.Object({ why: text(), steps: Type.Array(StepInputSchema, { minItems: 1, maxItems: 50 }), playbook: Type.Array(text(), { minItems: 1, maxItems: 100 }),
	stack: Type.Optional(Type.Array(StackGroupSchema, { minItems: 2, maxItems: MAX_STACK })) }, { additionalProperties: false });
export type Spec = Static<typeof SpecSchema>;
export const StepSchema = Type.Object({ ...StepInputSchema.properties,
	status: Type.Union([Type.Literal("pending"), Type.Literal("active"), Type.Literal("done")]), red: nullableText(), green: nullableText(), commit: nullableText(),
}, { additionalProperties: false });
export type Step = Static<typeof StepSchema>;
export const EvidenceKindSchema = Type.Union([Type.Literal("reproduction"), Type.Literal("red"), Type.Literal("green"), Type.Literal("verification"), Type.Literal("gate")]);
export type EvidenceKind = Static<typeof EvidenceKindSchema>;
export const EvidenceSchema = Type.Object({
	id: text(100), kind: EvidenceKindSchema, command: text(8192), stepId: nullableText(), caseId: nullableText(),
	exitCode: Type.Union([Type.Integer(), Type.Null()]), outcome: Type.Union([Type.Literal("passed"), Type.Literal("failed"), Type.Literal("interrupted")]),
	output: Type.String({ maxLength: 12000 }), fingerprint: text(128), head: text(128), startedAt: text(100), finishedAt: text(100),
}, { additionalProperties: false });
export type Evidence = Static<typeof EvidenceSchema>;
export const SeveritySchema = Type.Union([Type.Literal("blocker"), Type.Literal("aviso")]);
export type Severity = Static<typeof SeveritySchema>;
// noResult: el lente no llegó a juzgar (conexión, plazo, formato, cancelado); sin la marca, un unknown es del modelo.
// severities: sólo en security, una por hallazgo y sólo si hay algún aviso. Sin la lista (estados anteriores), cada hallazgo es blocker.
export const ReviewSchema = Type.Object({ lens: LensSchema, fingerprint: text(128), verdict: Type.Union([Type.Literal("pass"), Type.Literal("fail"), Type.Literal("unknown")]), findings: list(), severities: Type.Optional(Type.Array(SeveritySchema, { maxItems: 100 })), noResult: Type.Optional(Type.Literal(true)), at: text(100) }, { additionalProperties: false });
export type Review = Static<typeof ReviewSchema>;
// Hallazgos blocker de security que una persona aceptó para un contenido exacto, con su motivo. Sin autor: lo decide la TUI.
export const AcceptedRiskSchema = Type.Object({ fingerprint: text(128), findings: Type.Array(text(), { minItems: 1, maxItems: 100 }), reason: text(2000), at: text(100) }, { additionalProperties: false });
export type AcceptedRisk = Static<typeof AcceptedRiskSchema>;
// Un acuerdo de alcance dicho por la persona en el chat: su cita textual (verificada por el host) y lo acordado.
export const AgreementSchema = Type.Object({ quote: text(2000), summary: text(2000), replan: Type.Boolean(), phase: PhaseSchema, at: text(100) }, { additionalProperties: false });
export type Agreement = Static<typeof AgreementSchema>;
// Un PR del stack: su rama, la base sobre la que se abre y el commit del último paso de su grupo.
export const StackPullSchema = Type.Object({ title: text(200), steps: stackSteps(), branch: text(256), base: text(256), head: text(128),
	number: Type.Union([Type.Integer({ minimum: 1 }), Type.Null()]), url: Type.Union([text(2048), Type.Null()]),
	status: Type.Union([Type.Literal("planned"), Type.Literal("draft"), Type.Literal("open"), Type.Literal("merged")]) }, { additionalProperties: false });
export type StackPull = Static<typeof StackPullSchema>;
const stackPulls = () => Type.Optional(Type.Array(StackPullSchema, { minItems: 2, maxItems: MAX_STACK }));
// head, url y number son siempre los del PR de arriba (el único, sin stack).
export const PublicationSchema = Type.Union([
	Type.Object({ status: Type.Literal("none") }, { additionalProperties: false }),
	Type.Object({ status: Type.Literal("pending"), head: text(128), bodyHash: text(128), at: text(100), stack: stackPulls() }, { additionalProperties: false }),
	Type.Object({ status: Type.Literal("opened"), head: text(128), url: text(2048), number: Type.Integer({ minimum: 1 }), stack: stackPulls() }, { additionalProperties: false }),
]);
// Esquema del binario anterior: cerrado y sin fases/campos de lifecycle.
export const WorkflowV1Schema = Type.Object({
	version: Type.Literal(1), id: text(100), revision: Type.Integer({ minimum: 0 }),
	source: Type.Object({ number: Type.Integer({ minimum: 1 }), title: text(2000), url: text(2048), body: Type.String({ maxLength: 100000 }), hash: text(128) }, { additionalProperties: false }),
	checkout: Type.Object({ root: text(8192), commonDir: text(8192), branch: text(128), baseCommit: text(128) }, { additionalProperties: false }),
	phase: LegacyPhaseSchema, status: Type.Union([Type.Literal("active"), Type.Literal("waiting"), Type.Literal("paused"), Type.Literal("complete")]),
	blockedReason: Type.String({ maxLength: 4000 }), activity: text(),
	exploration: Type.Union([ExplorationSchema, Type.Null()]), inferences: Type.Array(InferenceSchema, { maxItems: 100 }), recipe: Type.Union([RecipeSchema, Type.Null()]),
	diagnosis: Type.Union([Type.Object({ cause: text(), reproduction: text(100), size: Type.Union([Type.Literal("small"), Type.Literal("large")]) }, { additionalProperties: false }), Type.Null()]),
	spec: Type.Union([SpecSchema, Type.Null()]), steps: Type.Array(StepSchema, { maxItems: MAX_STEPS }), evidence: Type.Array(EvidenceSchema, { maxItems: MAX_EVIDENCE }), reviews: Type.Array(ReviewSchema, { maxItems: MAX_REVIEWS }),
	round: Type.Integer({ minimum: 0 }), maxRounds: Type.Integer({ minimum: 1, maximum: 10 }),
	attempts: Type.Optional(Type.Array(Type.Object({ sourceHash: text(128), round: Type.Integer({ minimum: 0 }), reason: text(), at: text(100), evidence: Type.Array(EvidenceSchema, { maxItems: 1000 }), reviews: Type.Array(ReviewSchema, { maxItems: 100 }) }, { additionalProperties: false }), { maxItems: MAX_ATTEMPTS })),
	// by ausente es una persona: todo estado anterior lo es. foundations es el hash de la revisión que aprobó sola.
	approval: Type.Union([Type.Object({ sourceHash: text(128), recipeHash: text(128), at: text(100), by: Type.Optional(Type.Union([Type.Literal("person"), Type.Literal("foundations")])), foundations: Type.Optional(text(128)) }, { additionalProperties: false }), Type.Null()]),
	// Comandos que la persona autorizó para este pedido, con cualquier etiqueta. Sobreviven a resume.
	grants: Type.Optional(Type.Array(Type.Object({ key: text(128), command: text(8192), at: text(100) }, { additionalProperties: false }), { maxItems: MAX_GRANTS })),
	publication: PublicationSchema,
	// Opcional para estados previos. Sobrevive a refresh: son palabras de la persona, no del pedido.
	agreements: Type.Optional(Type.Array(Type.Object({ ...AgreementSchema.properties, phase: LegacyPhaseSchema }, { additionalProperties: false }), { maxItems: MAX_AGREEMENTS })),
	// Sólo hechos de ejecución, nunca inputs/outputs privados. Opcional para estados previos.
	observations: Type.Optional(Type.Array(Type.Object({ phase: LegacyPhaseSchema, round: Type.Integer({ minimum: 0, maximum: 10 }), inline: Type.Boolean(), subagent: Type.Boolean(), lens: Type.Boolean() }, { additionalProperties: false }), { maxItems: 121 })),
	history: Type.Array(Type.Object({ at: text(100), phase: LegacyPhaseSchema, activity: text() }, { additionalProperties: false }), { maxItems: MAX_HISTORY }),
}, { additionalProperties: false });
const PullRequestSchema = Type.Union([Type.Null(), Type.Object({ number: Type.Integer({ minimum: 1 }), url: text(2048), head: text(128), branch: text(128), base: text(128), ownership: Type.Enum(["unadopted", "adopted"]) }, { additionalProperties: false })]);
export const WorkflowV2Schema = Type.Object({
 ...WorkflowV1Schema.properties, version: Type.Literal(2), phase: PhaseSchema,
 // Disabled no significa omitido/no-aplica ni permiso: habilitar/adoptar es una operación host explícita.
 lifecycle: LifecycleStateSchema,
 pullRequest: PullRequestSchema,
 // Correcciones livianas de la vuelta actual: el contenido del que partió cada una. Opcional para estados previos.
 amends: Type.Optional(Type.Array(Type.Object({ from: text(128), reason: text(), at: text(100) }, { additionalProperties: false }), { maxItems: MAX_AMENDS })),
 // Riesgos de seguridad que una persona aceptó desde la TUI para un contenido exacto. Opcional para estados previos; retry, refresh y replan lo borran.
 acceptedRisks: Type.Optional(Type.Array(AcceptedRiskSchema, { maxItems: MAX_ACCEPTED_RISKS })),
 // El renderer v1 permanece ligado al pending legacy y no se cambia al migrar/reanudar.
 publicationFormat: Type.Literal(1),
 // Por qué se detuvo la continuidad. Opcional para estados previos; las transiciones del reducer lo conservan.
 continuityPause: Type.Optional(ContinuityPauseSchema),
 agreements: Type.Optional(Type.Array(AgreementSchema, { maxItems: MAX_AGREEMENTS })),
 observations: Type.Optional(Type.Array(Type.Object({ phase: PhaseSchema, round: Type.Integer({ minimum: 0, maximum: 10 }), inline: Type.Boolean(), subagent: Type.Boolean(), lens: Type.Boolean() }, { additionalProperties: false }), { maxItems: 121 })),
 history: Type.Array(Type.Object({ at: text(100), phase: PhaseSchema, activity: text() }, { additionalProperties: false }), { maxItems: MAX_HISTORY }),
}, { additionalProperties: false });
export const WorkflowSchema = Type.Union([WorkflowV1Schema, WorkflowV2Schema]);
export type WorkflowV1 = Omit<Static<typeof WorkflowV1Schema>, "inferences"> & { inferences: Inference[] };
export type WorkflowV2 = Omit<Static<typeof WorkflowV2Schema>, "inferences"> & { inferences: Inference[] };
export type Workflow = WorkflowV1 | WorkflowV2;
/** Migración pura: validar antes de convertir, sin I/O, nuevos efectos ni avance de revisión. */
export function migrateWorkflow(value: unknown): WorkflowV2 {
 if (Value.Check(WorkflowV2Schema, value)) {
  if (value.lifecycle.status === "enabled") {
   const repo = /^https:\/\/github\.com\/([a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+)\/issues\/(\d+)$/.exec(value.source.url);
   if (!repo || Number(repo[2]) !== value.source.number) throw new Error("Estado del harness inválido: lifecycle sin identidad GitHub comprobable");
   validateLifecycleState(value.lifecycle, { workflowId: value.id, issue: value.source.number, repo: repo[1]!.toLowerCase() });
  }
  validateCorrectionWorkflow(value);
  return structuredClone(value);
 }
 if (!Value.Check(WorkflowV1Schema, value)) throw new Error("Estado del harness inválido; no se reemplaza ni se reinicia automáticamente");
 const old = structuredClone(value);
 return { ...old, version: 2, lifecycle: { status: "disabled" }, publicationFormat: 1,
  pullRequest: old.publication.status === "opened" ? { number: old.publication.number, url: old.publication.url, head: old.publication.head, branch: old.checkout.branch, base: "main", ownership: "unadopted" } : null };
}
// Identidad de un issue de GitHub: https://github.com/<owner>/<repo>/issues/<número>, sin credenciales,
// query ni fragmento. Devuelve owner/repo: el PR y su Closes viven en ese mismo repositorio.
export function issueRepository(url: string, number: number): string {
	const parsed = new URL(url); const match = /^\/([^/]+\/[^/]+)\/issues\/(\d+)$/.exec(parsed.pathname);
	if (parsed.protocol !== "https:" || parsed.host !== "github.com" || parsed.username || parsed.password || parsed.search || parsed.hash || !match || Number(match[2]) !== number) throw new Error("Identidad de issue no válida");
	return match[1]!;
}
export const sourceHash = (title: string, body: string): string => createHash("sha256").update(JSON.stringify({ title, body })).digest("hex");
export const artifactHash = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex");
export function parseWorkflow(raw: string): WorkflowV2 {
	let value: unknown;
	try { value = JSON.parse(raw); } catch { throw new Error("Estado del harness inválido: no es JSON"); }
	return migrateWorkflow(value);
}
