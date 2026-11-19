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
export const LENS_EVIDENCE_NOTE = "evidence la registró el harness de OMI al ejecutar cada comando; no la escribió el modelo implementador. kind es la etiqueta del check (red, green, verification, gate), con su comando, exit code, resultado, HEAD, fingerprint y la salida que guarda el harness (sus últimos 12.000 caracteres; 500 si archived, de una vuelta anterior). En cada paso C, history va en orden: un rojo que falla y después un verde del mismo comando muestran que la prueba se escribió primero. Si evidence.summarized existe, la evidencia se resumió para entrar en la llamada: summarized.rule dice qué quedó, omittedRuns cuenta las corridas que no vinieron y una salida recortada empieza con [recortado: N caracteres]; no marques como faltante lo que el resumen dice que se omitió. content es el HEAD y fingerprint del cambio que revisás.";

// Si la evidencia completa no deja lugar para el diff, se resume de forma determinista y lo dice: por paso C
// el rojo y el verde acreditados (o los últimos), por caso D y por gate la última corrida, y cada salida con
// su cola. Se prueba de la salida más larga a ninguna; nada se omite sin contarlo.
type LensEvidence = ReturnType<typeof lensEvidence>;
const OUTPUT_CAPS = [12_000, 4000, 1000, 250, 0];
function tail<T extends { output: string }>(run: T, cap: number): T {
	let start = Math.max(0, run.output.length - cap);
	if (start && /[\udc00-\udfff]/.test(run.output[start] ?? "")) start++;
	return start ? { ...run, output: `[recortado: ${start} caracteres]${start < run.output.length ? ` ${run.output.slice(start)}` : ""}` } : run;
}
function summarizedEvidence(full: LensEvidence, cap: number) {
	const gates = full.gates.filter((g, i) => !full.gates.slice(i + 1).some((n) => n.command === g.command));
	let omitted = full.gates.length - gates.length;
	const steps = full.steps.map((s) => {
		const pick = (kind: "red" | "green", id: string | null) => s.history.find((e) => e.id === id) ?? s.history.findLast((e) => e.kind === kind);
		const keep = [pick("red", s.red), pick("green", s.green)];
		const history = s.history.filter((e) => keep.includes(e)); omitted += s.history.length - history.length;
		return { ...s, history: history.map((e) => tail(e, cap)), ...(s.history.length > history.length ? { omittedRuns: s.history.length - history.length } : {}) };
	});
	return {
		summarized: { rule: `Resumida para entrar en la llamada: por paso C el rojo y el verde acreditados (o los últimos), por caso D y por gate la última corrida, y cada salida con sus últimos ${cap} caracteres.`, omittedRuns: omitted, outputChars: cap },
		cases: full.cases.map((c) => ({ ...c, verification: c.verification && tail(c.verification, cap) })), steps, gates: gates.map((g) => tail(g, cap)),
	};
}
/** El JSON de cada llamada de un lente: el contexto, la evidencia y una parte del diff, sin pasar el presupuesto. */
export function lensRequests(context: Record<string, unknown>, state: Workflow, files: string[], budget = LENS_PART_BUDGET): string[] {
	// Sin el diff y con el número de parte más largo posible: lo que ocupa todo lo demás en cada llamada.
	const fixed = (evidence: unknown) => JSON.stringify({ ...context, evidence, part: { index: 99999, total: 99999 }, diff: "" }).length;
	const needed = Math.min(LENS_MIN_DIFF_BUDGET, files.reduce((sum, file) => sum + jsonCost(file), 0));
	const full = lensEvidence(state);
	const candidates = [full, ...OUTPUT_CAPS.map((cap) => summarizedEvidence(full, cap))];
	const evidence = candidates.find((e) => budget - fixed(e) >= needed);
	if (!evidence) throw new Error(`El material del lente no entra en una llamada ni con la evidencia resumida: casos, alcance y evidencia ocupan ${fixed(candidates.at(-1))} de ${budget} caracteres y el diff necesita ${needed}. Achicá la receta o dividí la tarea.`);
	const parts = lensParts(files, budget - fixed(evidence));
	return parts.map((diff, index) => JSON.stringify({ ...context, evidence, part: { index: index + 1, total: parts.length }, diff }));
}

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

// Un diff que no entra en una llamada se reparte por archivo en partes de hasta `budget` caracteres, medidos
// como van en el JSON de la llamada (comillas, barras y saltos escapados). Un archivo más grande se corta por
// líneas, y una línea enorme por caracteres sin partir un par sustituto. Cada fragmento siguiente lleva una
// etiqueta: es lo único que se agrega; nada se omite.
/** Tope de cada llamada de un lente: el JSON entero del mensaje, con contexto, evidencia y diff. */
export const LENS_PART_BUDGET = 120_000; export const LENS_MIN_DIFF_BUDGET = 30_000;
const jsonCost = (value: string): number => JSON.stringify(value).length - 2;
const cut = (value: string, size: number): number => /[\ud800-\udbff]/.test(value[size - 1] ?? "") ? size - 1 : size;
// Pedazos de hasta `room` por código: un carácter nunca se parte, aunque escapado ocupe hasta 6.
function split(line: string, room: number): string[] {
	const pieces: string[] = []; let start = 0; let used = 0; let index = 0;
	for (const char of line) {
		const cost = jsonCost(char);
		if (used + cost > room && index > start) { pieces.push(line.slice(start, index)); start = index; used = 0; }
		used += cost; index += char.length;
	}
	return [...pieces, line.slice(start)];
}
function fragments(file: string, budget: number): string[] {
	if (jsonCost(file) <= budget) return [file];
	const header = file.split("\n", 1)[0]!; const name = header.length > 200 ? `${header.slice(0, cut(header, 200))}…` : header;
	const label = (index: number | string, total: number | string) => `[continúa ${name} · fragmento ${index}/${total}]\n`;
	const room = Math.max(6, budget - jsonCost(label("99999", "99999")));
	const chunks: string[] = []; let current = ""; let used = 0;
	for (const line of file.split(/(?<=\n)/)) {
		const cost = jsonCost(line);
		if (used + cost <= room) { current += line; used += cost; continue; }
		if (current) chunks.push(current);
		const pieces = split(line, room);
		chunks.push(...pieces.slice(0, -1)); current = pieces.at(-1) ?? ""; used = jsonCost(current);
	}
	if (current) chunks.push(current);
	return chunks.map((chunk, i) => i ? label(i + 1, chunks.length) + chunk : chunk);
}
export function lensParts(files: string[], budget: number): string[] {
	const parts: string[] = []; let current = ""; let used = 0;
	for (const piece of files.flatMap((f) => fragments(f, budget))) {
		const cost = jsonCost(piece);
		if (current && used + cost > budget) { parts.push(current); current = ""; used = 0; }
		current += piece; used += cost;
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
