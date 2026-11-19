// Criterios de continuidad en chat, no permisos. La evaluación es una estimación del pedido, no del diff.
import { createHash } from "node:crypto";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import { fences } from "./fences.ts";

const text = Type.String({ minLength: 1, maxLength: 1000, pattern: "\\S" });
export const AssessmentSchema = Type.Object({
	scope: Type.Union([Type.Literal("localized"), Type.Literal("module"), Type.Literal("crosscutting"), Type.Literal("unknown")]),
	impact: Type.Union([Type.Literal("cosmetic"), Type.Literal("documentation"), Type.Literal("local-behavior"), Type.Literal("public-contract"), Type.Literal("unknown")]),
	reversible: Type.Union([Type.Literal("yes"), Type.Literal("no"), Type.Literal("unknown")]), verification: Type.Union([Type.Literal("clear"), Type.Literal("unclear"), Type.Literal("unknown")]),
	risk: Type.Union([Type.Literal("low"), Type.Literal("high"), Type.Literal("unknown")]),
	riskAreas: Type.Array(Type.Union([Type.Literal("security"), Type.Literal("permissions"), Type.Literal("auth"), Type.Literal("secrets"), Type.Literal("payments"), Type.Literal("personal-data"), Type.Literal("migrations"), Type.Literal("infra"), Type.Literal("public-contract"), Type.Literal("harness")]), { maxItems: 10, uniqueItems: true }),
	rationale: text,
}, { additionalProperties: false });
export type RequestAssessment = Static<typeof AssessmentSchema>;
const PolicySchema = Type.Object({
	enabled: Type.Boolean(), maxScope: Type.Union([Type.Literal("localized"), Type.Literal("module")]),
	allowedImpacts: Type.Array(Type.Union([Type.Literal("cosmetic"), Type.Literal("documentation"), Type.Literal("local-behavior")]), { maxItems: 3, uniqueItems: true }),
}, { additionalProperties: false });
export type TriagePolicy = Static<typeof PolicySchema>;
export const DEFAULT_TRIAGE_POLICY: TriagePolicy = { enabled: true, maxScope: "localized", allowedImpacts: ["cosmetic", "documentation", "local-behavior"] };
const RepoSchema = Type.String({ pattern: "^[a-z0-9_.-]+/[a-z0-9_.-]+$", maxLength: 200 });
const BlockSchema = Type.Object({ version: Type.Literal(1), repo: RepoSchema, chat: PolicySchema }, { additionalProperties: false });
export interface TriagePolicyPin { origin: "kb" | "default"; policy: TriagePolicy; hash: string | null; notice: string }
export type ParsedTriagePolicy = { status: "valid"; policy: TriagePolicy; hash: string } | { status: "missing" } | { status: "invalid"; reason: string };
export function parseDevelopmentTriagePolicy(body: string, repo: string): ParsedTriagePolicy {
	let found: unknown; let count = 0;
	for (const fence of fences(body).filter((item) => item.info === "omi-development-triage")) {
		if (!fence.closed) return { status: "invalid", reason: "cerca de triage sin cerrar" };
		let value: unknown;
		try { value = JSON.parse(body.slice(fence.contentStart, fence.contentEnd)); }
		catch { return { status: "invalid", reason: "JSON de triage inválido" }; }
		if (!value || typeof value !== "object" || !("repo" in value) || !Value.Check(RepoSchema, value.repo)) return { status: "invalid", reason: "triage sin repo identificable" };
		if (value.repo.toLowerCase() !== repo.toLowerCase()) continue;
		found = value; count++;
	}
	if (!count) return { status: "missing" };
	if (count !== 1 || !Value.Check(BlockSchema, found)) return { status: "invalid", reason: "bloque de triage duplicado o fuera del esquema" };
	const policy = found.chat;
	const canonical = { version: 1, repo: found.repo, chat: { enabled: policy.enabled, maxScope: policy.maxScope, allowedImpacts: [...policy.allowedImpacts].sort() } };
	return { status: "valid", policy, hash: createHash("sha256").update(JSON.stringify(canonical)).digest("hex") };
}
export interface RequestDecision { kind: "chat" | "harness" | "needs-info"; reason: string; questions: string[] }
export function decideAssessment(assessment: RequestAssessment, questions: readonly string[], policy: TriagePolicy = DEFAULT_TRIAGE_POLICY): RequestDecision {
	if (!Value.Check(AssessmentSchema, assessment) || !Value.Check(PolicySchema, policy)) throw new Error("Evaluación o política de clasificación inválida");
	const missing = [...questions];
	const unknownQuestions = { scope: "¿Qué parte del proyecto abarca el cambio?", impact: "¿Qué comportamiento o contrato cambia?", reversible: "¿Se puede revertir sin perder datos ni efectos externos?", verification: "¿Cómo se comprueba el resultado esperado?", risk: "¿Afecta permisos, seguridad, datos u otra superficie sensible?" };
	for (const field of Object.keys(unknownQuestions) as (keyof typeof unknownQuestions)[]) if (assessment[field] === "unknown") missing.push(unknownQuestions[field]);
	if (missing.length) return { kind: "needs-info", reason: "Falta información para decidir; no se considera un cambio simple.", questions: [...new Set(missing)] };
	const harness = (reason: string): RequestDecision => ({ kind: "harness", reason, questions: [] });
	if (assessment.risk === "high" || assessment.riskAreas.length || assessment.impact === "public-contract") return harness("El impacto o riesgo requiere seguimiento con el harness.");
	if (!policy.enabled) return harness("La política del repo deshabilita cambios simples en chat.");
	if (assessment.reversible !== "yes" || assessment.verification !== "clear") return harness("El cambio no tiene reversibilidad o verificación suficientemente claras.");
	if (assessment.scope === "crosscutting" || assessment.scope === "module" && policy.maxScope === "localized") return harness("El alcance supera el máximo configurado para el chat.");
	if (!policy.allowedImpacts.some((impact) => impact === assessment.impact)) return harness("El impacto no está permitido para cambios simples en chat.");
	return { kind: "chat", reason: "El pedido es localizado, reversible, verificable y sin riesgo sensible según la evaluación previa. Siguen vigentes las reglas y permisos del proyecto.", questions: [] };
}
