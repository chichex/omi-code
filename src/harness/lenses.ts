// Material de los lentes de Verificar: hechos que registró el harness, nunca texto del implementador.
import type { Evidence, Lens, Review, Workflow } from "./model.ts";

type Recorded = Omit<Evidence, "id" | "stepId" | "caseId"> & { archived?: true };
const recorded = ({ id: _id, stepId: _step, caseId: _case, ...e }: Evidence, archived = false): Recorded => (archived ? { ...e, archived: true } : e);

// Por caso D, su última verificación; por paso C, su historial rojo/verde y lo que acreditó su commit.
// Los pasos de vueltas anteriores conservan sólo el rojo y el verde acreditados, ya archivados.
export function lensEvidence(state: Workflow) {
	const archived = (state.attempts ?? []).flatMap((a) => a.evidence);
	const find = (id: string | null) => id === null ? undefined : state.evidence.find((e) => e.id === id) ?? archived.find((e) => e.id === id);
	return {
		cases: (state.recipe?.cases ?? []).map((c) => {
			const latest = state.evidence.findLast((e) => e.kind === "verification" && e.caseId === c.id);
			return { ...c, verification: latest ? recorded(latest) : null };
		}),
		steps: state.steps.map((s) => {
			const current = state.evidence.filter((e) => e.stepId === s.id && (e.kind === "red" || e.kind === "green"));
			const accredited = [find(s.red), find(s.green)].filter((e): e is Evidence => !!e && !current.includes(e));
			return { id: s.id, title: s.title, cases: s.cases, status: s.status, commit: s.commit, red: s.red, green: s.green,
				history: [...accredited.map((e) => ({ id: e.id, ...recorded(e, true) })), ...current.map((e) => ({ id: e.id, ...recorded(e) }))] };
		}),
		gates: state.evidence.filter((e) => e.kind === "gate").map((e) => recorded(e)),
	};
}
export const LENS_EVIDENCE_NOTE = "evidence la registró el harness de OMI al ejecutar cada comando; no la escribió el modelo implementador. kind es la etiqueta del check (red, green, verification, gate), con su comando, exit code, resultado, HEAD, fingerprint y la salida que guarda el harness (sus últimos 12.000 caracteres; 500 si archived, de una vuelta anterior). En cada paso C, history va en orden: un rojo que falla y después un verde del mismo comando muestran que la prueba se escribió primero. content es el HEAD y fingerprint del cambio que revisás.";

// Los lentes asesoran: su fail/unknown es un aviso visible. Sólo un fail de seguridad bloquea.
export interface LensStatus { lens: Lens; verdict: Review["verdict"] | "not-run"; findings: string[]; blocking: boolean }
// El contenido revisado: el de la última verificación o, antes de verificar, el del último lente.
function reviewedFingerprint(state: Workflow): string | undefined {
	return state.evidence.findLast((e) => e.kind === "verification")?.fingerprint ?? state.reviews.at(-1)?.fingerprint;
}
export function lensStatuses(state: Workflow): LensStatus[] {
	const fingerprint = reviewedFingerprint(state);
	return (state.recipe?.lenses ?? []).map((lens) => {
		const review = state.reviews.findLast((r) => r.lens === lens && r.fingerprint === fingerprint);
		return { lens, verdict: review?.verdict ?? "not-run", findings: review?.findings ?? [], blocking: lens === "security" && review?.verdict === "fail" };
	});
}
export const lensWarnings = (state: Workflow): LensStatus[] => lensStatuses(state).filter((s) => s.verdict === "fail" || s.verdict === "unknown");
export function lensWarningLine(s: LensStatus): string {
	const more = s.findings.length > 1 ? ` (+${s.findings.length - 1} hallazgos)` : "";
	return `Lente ${s.lens} · ${s.verdict}${s.blocking ? " · bloquea" : ""}${s.findings[0] ? ` · ${s.findings[0]}` : ""}${more}`;
}
const oneLine = (value: string): string => value.replace(/\s*[\r\n]+\s*/g, " ");
export function lensReport(state: Workflow): string {
	const statuses = lensStatuses(state);
	if (!statuses.length) return "La receta no pidió lentes.";
	return ["Los lentes asesoran: unknown y fail quedan como aviso y no bloquean Verificar ni este PR. Sólo un fail de seguridad bloquea.", "",
		...statuses.flatMap((s) => [`- ${s.lens} · ${s.verdict === "not-run" ? "sin correr" : s.verdict}${s.blocking ? " · bloquea" : ""}`, ...s.findings.map((f) => `  - ${oneLine(f)}`)])].join("\n");
}

// Un diff que no entra en una llamada se reparte por archivo en partes de hasta `budget` caracteres.
// Un archivo más grande se corta por líneas, y una línea enorme por caracteres sin partir un par
// sustituto. Cada fragmento siguiente lleva una etiqueta: es lo único que se agrega; nada se omite.
export const LENS_PART_BUDGET = 120_000; export const LENS_MIN_DIFF_BUDGET = 30_000;
const cut = (value: string, size: number): number => /[\ud800-\udbff]/.test(value[size - 1] ?? "") ? size - 1 : size;
function fragments(file: string, budget: number): string[] {
	if (file.length <= budget) return [file];
	const header = file.split("\n", 1)[0]!; const name = header.length > 200 ? `${header.slice(0, cut(header, 200))}…` : header;
	const label = (index: number | string, total: number | string) => `[continúa ${name} · fragmento ${index}/${total}]\n`;
	const room = Math.max(2, budget - label("99999", "99999").length);
	const chunks: string[] = []; let current = "";
	for (const line of file.split(/(?<=\n)/)) {
		if (current.length + line.length <= room) { current += line; continue; }
		if (current) chunks.push(current);
		let rest = line;
		while (rest.length > room) { const size = cut(rest, room); chunks.push(rest.slice(0, size)); rest = rest.slice(size); }
		current = rest;
	}
	if (current) chunks.push(current);
	return chunks.map((chunk, i) => i ? label(i + 1, chunks.length) + chunk : chunk);
}
export function lensParts(files: string[], budget: number): string[] {
	const parts: string[] = []; let current = "";
	for (const piece of files.flatMap((f) => fragments(f, budget))) {
		if (current && current.length + piece.length > budget) { parts.push(current); current = ""; }
		current += piece;
	}
	return [...parts, current];
}
// Se corre el lente por parte y se combina: el peor veredicto gana y se juntan los hallazgos con su parte.
export interface LensResult { verdict: Review["verdict"]; findings: string[] }
const SEVERITY: Record<Review["verdict"], number> = { pass: 0, unknown: 1, fail: 2 };
const MAX_FINDINGS = 100; const MAX_FINDING = 4000;
const prefixed = (prefix: string, finding: string): string => {
	const value = prefix + finding;
	return value.length <= MAX_FINDING ? value : `${value.slice(0, cut(value, MAX_FINDING - 1))}…`;
};
export function combineLensResults(results: LensResult[]): LensResult {
	if (!results.length) return { verdict: "unknown", findings: ["No se revisó ninguna parte del cambio."] };
	const verdict = results.reduce<Review["verdict"]>((worst, r) => SEVERITY[r.verdict] > SEVERITY[worst] ? r.verdict : worst, "pass");
	const findings = results.flatMap((r, i) => r.findings.map((f) => results.length === 1 ? f : prefixed(`parte ${i + 1}/${results.length} · `, f)));
	if (findings.length <= MAX_FINDINGS) return { verdict, findings };
	const kept = findings.slice(0, MAX_FINDINGS - 1);
	return { verdict, findings: [...kept, `… y ${findings.length - kept.length} hallazgos más de las partes no entran en el registro del lente (tope de ${MAX_FINDINGS}); volvé a correr el lente sobre un cambio más chico para verlos.`] };
}
