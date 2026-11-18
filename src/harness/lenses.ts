// Material de los lentes de Verificar: hechos que registró el harness, nunca texto del implementador.
import type { Evidence, Workflow } from "./model.ts";

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
