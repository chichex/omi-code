// Convergencia del lente de seguridad entre revisiones del mismo pedido. Desde la segunda revisión, el host compara con
// la anterior: un blocker nuevo de clase otro que cae en un archivo sin cambios desde ese contenido, y que no repite el
// archivo de un blocker anterior, baja a aviso. Así cada vuelta revisa lo que cambió y no reabre lo que ya se juzgó.
// El veredicto nunca cambia: sólo la severidad. Todo lo calcula el host con Git; no hay campo nuevo en el estado.
// Falla cerrado: no baja nada si no se puede comparar, ni un secreto o una exfiltración, ni un hallazgo sin clase, con
// una clase inválida, sin archivo o con un archivo que no está en HEAD, ni uno cuyo texto nombra un secreto, ni uno que
// cita en cualquier parte de su texto un archivo cambiado o el de un blocker anterior. Una base
// parcial (alguna parte sin juicio) no compara: lo que no se revisó no es «lo que ya se juzgó».
// Lo que una persona aceptó sobre la base no cuenta para la regla (b): repetido en su archivo sin cambios es el riesgo que
// ya aceptó y baja a aviso, con su propio prefijo. Un archivo cambiado, un secreto o un retry (que borra la aceptación) lo
// vuelven a frenar.
import type { Runner } from "../core/exec.ts";
import type { Review, Workflow } from "./model.ts";
import { changedPaths, treePaths, type CheckoutSnapshot } from "./git.ts";
import { prefixed, type LensResult } from "./lenses.ts";
import { securityBlockers, severitiesOf, unacceptedBlockers } from "./security-blockers.ts";

export const SECURITY_DOWNGRADED = "bajado a aviso: archivo sin cambios desde la revisión anterior";
export const SECURITY_ACCEPTED_REPEAT = "bajado a aviso: repite en un archivo sin cambios un riesgo que aceptó una persona";
export const SECURITY_PREVIOUS_NOTE = "previous es tu revisión de security anterior de este mismo trabajo, calculada por el harness: findings son tus hallazgos de entonces y changedFiles los archivos que cambiaron desde ese contenido. Decí primero si cada blocker anterior sigue; accepted marca el que aceptó una persona. Un blocker nuevo de clase otro sólo bloquea si cae en un archivo de changedFiles o en el archivo de un blocker anterior; si no, el harness lo baja a aviso. Un secreto o una exfiltración bloquean siempre. Citá con archivo:línea cada archivo del escenario: donde está el problema y donde se dispara.";
const NO_COMPARISON = "sin comparación con la revisión anterior: no se baja ningún blocker";
const NO_BLOCKER_FILE = "sin comparación con la revisión anterior: un blocker anterior no cita su archivo; no se baja ningún blocker";
const NO_BLOCKER_IN_TREE = "sin comparación con la revisión anterior: un blocker anterior cita un archivo que no está en el árbol; no se baja ningún blocker";
const PARTIAL_BASELINE = "sin comparación con la revisión anterior: no revisó todas las partes del cambio; no se baja ningún blocker";
// Sin \b: con \b no corta en «_» y no reconoce CLAUDE_CODE_OAUTH_TOKEN. Un falso positivo sólo deja el blocker como está.
const SECRET = /secret|secreto|api[ _-]?key|password|contraseña|credencial|credential|private[ _-]?key|clave privada|token|bearer|auth\.json|oauth/i;
const MAX_PREVIOUS_FINDINGS = 10; const MAX_PREVIOUS_TEXT = 500; const MAX_CHANGED_FILES = 200;

/** La última revisión de security con veredicto de este pedido, también la archivada por retry. */
export function securityBaseline(state: Workflow): Review | undefined {
 const archived = (state.attempts ?? []).filter(a => a.sourceHash === state.source.hash).flatMap(a => a.reviews);
 return [...archived, ...state.reviews].findLast(r => r.lens === "security" && !r.noResult && r.verdict !== "unknown");
}
/** El commit del paso cuyo verde acreditó ese contenido. */
export function reviewedCommit(state: Workflow, fingerprint: string): string | undefined {
 const evidence = [...(state.attempts ?? []).flatMap(a => a.evidence), ...state.evidence];
 return state.steps.findLast(s => s.status === "done" && s.commit && evidence.some(e => e.id === s.green && e.fingerprint === fingerprint))?.commit ?? undefined;
}
/** El archivo del primer tramo «archivo:línea» del hallazgo, sin «./»; null si ningún tramo empieza así. */
export function findingFile(text: string): string | null {
 for (const part of text.split(" · ")) {
  const match = /^[`"']?([^\s:`"'·]+):\d/.exec(part.trim());
  if (match) return match[1]!.replace(/^\.\//, "");
 }
 return null;
}

/** Las rutas que cita el hallazgo en todo su texto: cada «archivo:línea» (line) y cada palabra con forma de ruta. */
export function findingPaths(text: string): { path: string; line: boolean }[] {
 const paths: { path: string; line: boolean }[] = [];
 for (const word of text.split(/[\s`"'()[\]{}<>,;·]+/)) {
  const match = /^(?:\.\/)?([^:]+?)(:\d.*)?[.:]*$/.exec(word);
  const path = match?.[1];
  if (path && /^[\w@~+./-]+$/.test(path) && /[A-Za-z]/.test(path) && (path.includes("/") || /\.[A-Za-z0-9]+$/.test(path))) paths.push({ path, line: match[2] !== undefined });
 }
 return paths;
}
/** La misma ruta escrita completa o corta: «store.ts» es «src/harness/store.ts». */
const sameFile = (a: string, b: string): boolean => a === b || a.endsWith(`/${b}`) || b.endsWith(`/${a}`);
const cites = (paths: readonly { path: string }[], files: ReadonlySet<string>): boolean => paths.some(p => [...files].some(f => sameFile(p.path, f)));

// Las rutas de los blockers anteriores, como están en el árbol de HEAD o entre los cambios (un archivo borrado): una ruta
// corta vale por todas las que terminan así. Si el primer tramo no está en ninguno, no se sabe qué archivo era: undefined.
function resolvedFiles(blockers: readonly string[], known: readonly string[]): Set<string> | undefined {
 const files = new Set<string>();
 for (const text of blockers) {
  const anchor = known.filter(k => sameFile(k, findingFile(text)!));
  if (!anchor.length) return undefined;
  for (const k of [...anchor, ...findingPaths(text).flatMap(p => known.filter(k => sameFile(k, p.path)))]) files.add(k);
 }
 return files;
}

// accepted: los blockers de la base que aceptó una persona; acceptedFiles, sus archivos. blockerFiles, los de los demás.
export interface SecurityComparison { baseline: Review; changed: ReadonlySet<string>; tree: ReadonlySet<string>; blockerFiles: ReadonlySet<string>; accepted: ReadonlySet<string>; acceptedFiles: ReadonlySet<string> }
/** Qué cambió desde la revisión anterior. Sin base no hay nada que comparar; si no se puede comparar, sólo una nota. */
export async function securityComparison(state: Workflow, snapshot: Pick<CheckoutSnapshot, "head" | "fingerprint">, runner: Runner, signal?: AbortSignal): Promise<{ comparison?: SecurityComparison; note?: string }> {
 const baseline = securityBaseline(state);
 if (!baseline) return {};
 if (baseline.partial) return { note: PARTIAL_BASELINE };
 // Todos los blockers de la base, también los que aceptó una persona: los dos tienen que citar su archivo.
 const blockers = securityBlockers(baseline), pending = new Set(unacceptedBlockers(state, baseline));
 if (blockers.some(text => findingFile(text) === null)) return { note: NO_BLOCKER_FILE };
 // Sobre el mismo contenido no cambió nada: no hace falta el commit ni el diff, pero sí el árbol de HEAD.
 const same = baseline.fingerprint === snapshot.fingerprint;
 const commit = same ? undefined : reviewedCommit(state, baseline.fingerprint);
 if (!same && !commit) return { note: NO_COMPARISON };
 try {
  const changed = commit ? await changedPaths(state.checkout, commit, snapshot.head, runner, signal) : [];
  const tree = await treePaths(state.checkout, snapshot.head, runner, signal);
  const accepted = blockers.filter(text => !pending.has(text)), known = [...tree, ...changed];
  const blockerFiles = resolvedFiles([...pending], known), acceptedFiles = resolvedFiles(accepted, known);
  if (!blockerFiles || !acceptedFiles) return { note: NO_BLOCKER_IN_TREE };
  return { comparison: { baseline, changed: new Set(changed), tree: new Set(tree), blockerFiles, accepted: new Set(accepted), acceptedFiles } };
 } catch (error) {
  if (signal?.aborted) throw error;
  return { note: NO_COMPARISON };
 }
}
const clip = (text: string): string => text.length <= MAX_PREVIOUS_TEXT ? text : `${text.slice(0, /[\ud800-\udbff]/.test(text[MAX_PREVIOUS_TEXT - 2] ?? "") ? MAX_PREVIOUS_TEXT - 2 : MAX_PREVIOUS_TEXT - 1)}…`;
/** Lo que el lente ve de su revisión anterior: sus hallazgos, con los blockers primero, y los archivos cambiados. */
export function previousMaterial(c: SecurityComparison) {
 const severities = c.baseline.verdict === "fail" ? severitiesOf(c.baseline) : [];
 const all = c.baseline.findings.map((text, i) => ({ blocker: severities[i] === "blocker", ...(c.accepted.has(text) ? { accepted: true } : {}), text: clip(text) }));
 const findings = [...all.filter(f => f.blocker), ...all.filter(f => !f.blocker)];
 const changedFiles = [...c.changed].sort();
 return {
  fingerprint: c.baseline.fingerprint, verdict: c.baseline.verdict,
  findings: findings.slice(0, MAX_PREVIOUS_FINDINGS), ...(findings.length > MAX_PREVIOUS_FINDINGS ? { findingsOmitted: findings.length - MAX_PREVIOUS_FINDINGS } : {}),
  changedFiles: changedFiles.slice(0, MAX_CHANGED_FILES), ...(changedFiles.length > MAX_CHANGED_FILES ? { changedFilesOmitted: changedFiles.length - MAX_CHANGED_FILES } : {}),
 };
}

type Item = { text: string; blocker: boolean; downgradable: boolean };
// Un hallazgo es blocker sólo en un fail: con la lista alineada lo dice su severidad; si no, lo es.
function securityItems(result: LensResult): Item[] {
 const aligned = result.severities?.length === result.findings.length;
 return result.findings.map((text, i) => ({ text, blocker: result.verdict === "fail" && (aligned ? result.severities?.[i] === "blocker" : true), downgradable: result.downgradable?.[i] === true }));
}
function withSecurityItems(result: LensResult, items: Item[]): LensResult {
 return result.verdict === "fail" ? { ...result, findings: items.map(i => i.text), severities: items.map(i => i.blocker ? "blocker" : "aviso") } : result;
}
/** Una parte del lente comparada con la revisión anterior: baja a aviso lo que la regla permite y cuenta cuántos. */
export function convergeSecurity(result: LensResult, c: SecurityComparison): { result: LensResult; downgraded: number } {
 let downgraded = 0;
 const items = securityItems(result).map((item): Item => {
  // Todas las rutas del texto, no sólo la primera: el disparador puede estar en un archivo cambiado citado después.
  const file = findingFile(item.text), paths = findingPaths(item.text);
  const keep = !item.blocker || !item.downgradable || SECRET.test(item.text) || file === null || !c.tree.has(file)
   || paths.some(p => p.line && !c.tree.has(p.path)) || cites(paths, c.changed) || cites(paths, c.blockerFiles);
  if (keep) return item;
  downgraded++;
  return { ...item, blocker: false, text: prefixed(`${cites(paths, c.acceptedFiles) ? SECURITY_ACCEPTED_REPEAT : SECURITY_DOWNGRADED} · `, item.text) };
 });
 return { result: withSecurityItems(result, items), downgraded };
}
