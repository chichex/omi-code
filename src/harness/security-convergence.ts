// Convergencia del lente de seguridad entre revisiones del mismo pedido. Desde la segunda revisión, el host compara con
// la anterior: un blocker nuevo de clase otro que cae en un archivo sin cambios desde ese contenido, y que no repite el
// archivo de un blocker anterior, baja a aviso. Así cada vuelta revisa lo que cambió y no reabre lo que ya se juzgó.
// El veredicto nunca cambia: sólo la severidad. Todo lo calcula el host con Git; no hay campo nuevo en el estado.
// Falla cerrado: no baja nada si no se puede comparar, ni un secreto o una exfiltración, ni un hallazgo sin clase, con
// una clase inválida, sin archivo o con un archivo que no está en HEAD, ni uno cuyo texto nombra un secreto, ni uno que
// cita en cualquier parte de su texto un archivo cambiado o el de un blocker anterior. Una base
// parcial (alguna parte sin juicio) no compara: lo que no se revisó no es «lo que ya se juzgó».
// Lo que una persona aceptó sobre la base, si reaparece con el mismo texto en archivos sin cambios, es el riesgo que ya
// aceptó y baja a aviso con su propio prefijo. Aceptó un texto, no un archivo: otro hallazgo en ese archivo sigue la regla
// (b). Un archivo cambiado, un secreto o un retry (que borra la aceptación) lo vuelven a frenar.
import type { Runner } from "../core/exec.ts";
import type { Review, Workflow } from "./model.ts";
import { changedPaths, treePaths, type CheckoutSnapshot } from "./git.ts";
import { prefixed, type LensResult } from "./lenses.ts";
import { acceptedRisksOf, requestReviews, SECURITY_DOWNGRADED, securityBlockers, severitiesOf, unacceptedBlockers } from "./security-blockers.ts";

export { SECURITY_DOWNGRADED };
export const SECURITY_ACCEPTED_REPEAT = "bajado a aviso: repite en un archivo sin cambios un riesgo que aceptó una persona";
export const SECURITY_PREVIOUS_NOTE = "previous es tu revisión de security anterior de este mismo trabajo, calculada por el harness: findings son tus hallazgos de entonces y changedFiles los archivos que cambiaron desde ese contenido. Decí primero si cada blocker anterior sigue. accepted marca el que aceptó una persona: si sigue igual, repetí su texto exacto (sin el prefijo de parte) y dejalo blocker; el host decide si la aceptación todavía vale. Un blocker nuevo de clase otro sólo bloquea si cae en un archivo de changedFiles o en el archivo de un blocker anterior; si no, el harness lo baja a aviso. Un secreto o una exfiltración bloquean siempre. Citá con archivo:línea cada archivo del escenario: donde está el problema y donde se dispara.";
const NO_COMPARISON = "sin comparación con la revisión anterior: no se baja ningún blocker";
const NO_BLOCKER_FILE = "sin comparación con la revisión anterior: un blocker anterior no cita su archivo; no se baja ningún blocker";
const NO_BLOCKER_IN_TREE = "sin comparación con la revisión anterior: un blocker anterior cita un archivo que no está en el árbol; no se baja ningún blocker";
const PARTIAL_BASELINE = "sin comparación con la revisión anterior: no revisó todas las partes del cambio; no se baja ningún blocker";
// Sin \b: con \b no corta en «_» y no reconoce CLAUDE_CODE_OAUTH_TOKEN. En inglés y en español, porque el lente responde en
// español, y por raíz, no por frases: cualquier «key», «clave» o «llave», también «primary key» o «clave primaria». Es la
// última barrera: la principal es la clase secreto o exfiltración que declara el lente. Un falso positivo sólo deja el
// blocker como está.
const SECRET = /secret|secreto|key|password|contraseña|passphrase|credencial|credential|clave|llave|id_rsa|id_ed25519|\.pem\b|\.ssh\b|\.aws\b|\.netrc|\.npmrc|\.gnupg|\.docker\b|ssh_auth_sock|kubeconfig|token|bearer|authorization|jwt|cookie|session[ _-]?id|sesi[oó]n|\.env\b|auth\.json|oauth|semilla|seed[ _-]?phrase/i;
const MAX_PREVIOUS_FINDINGS = 10; const MAX_PREVIOUS_TEXT = 500; const MAX_CHANGED_FILES = 200;

/** La última revisión de security con veredicto de este pedido, también la archivada por retry. */
export function securityBaseline(state: Workflow): Review | undefined {
 return requestReviews(state).findLast(r => r.lens === "security" && !r.noResult && r.verdict !== "unknown");
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

// Qué archivos nombra un hallazgo, sin adivinar la forma de una ruta (Makefile, «acción.ts», «run task.ts», entre «» o **,
// con #L12 o una flecha pegada): cada archivo conocido se busca como subcadena del texto, completo o por sus finales después
// de una «/», con límites de ruta a los dos lados. Nombrar de más sólo deja un blocker como está.
const WORD = /[\p{L}\p{N}_]/u;
const tails = (path: string): string[] => path.split("/").map((_, i, parts) => parts.slice(i).join("/")).filter(Boolean);
// La ruta sigue con una letra, un número o «_», o con «-» o «.» pegados a otra letra: «b.ts.bak» y «x-b.ts» son otros
// archivos; «b.ts.» al cerrar una oración o «b.ts->exec», no.
const joins = (char: string | undefined, next: string | undefined): boolean => WORD.test(char ?? "") || (char === "-" || char === ".") && WORD.test(next ?? "");
const bounded = (text: string, at: number, end: number): boolean => !joins(text[at - 1], text[at - 2]) && !joins(text[end], text[end + 1]);
function mentions(text: string, file: string): boolean {
 if (!text.includes(file.slice(file.lastIndexOf("/") + 1))) return false;
 // Un final corto («a») nombraría a cualquier palabra: cuenta si tiene extensión o 4 caracteres o más.
 return tails(file).some((tail, i) => {
  if (i > 0 && tail.length < 4 && !tail.includes(".")) return false;
  for (let at = text.indexOf(tail); at !== -1; at = text.indexOf(tail, at + 1)) if (bounded(text, at, at + tail.length)) return true;
  return false;
 });
}
/** Lo que el hallazgo cita con «archivo:línea» en cualquier parte del texto, sin «./». */
export function lineRefs(text: string): string[] {
 return [...text.matchAll(/([^\s`"'()[\]{}<>,;·|:←→⇐⇒]+):\d/gu)].map(m => m[1]!.replace(/^\.\//, ""));
}
/** La misma ruta escrita completa o corta: «store.ts» es «src/harness/store.ts». */
const sameFile = (a: string, b: string): boolean => a === b || a.endsWith(`/${b}`) || b.endsWith(`/${a}`);
const cites = (text: string, files: Iterable<string>): boolean => [...files].some(f => mentions(text, f));

// Las rutas de los blockers anteriores, como están en el árbol de HEAD o entre los cambios (un archivo borrado): una ruta
// corta vale por todas las que terminan así. Si el primer tramo no está en ninguno, no se sabe qué archivo era: undefined.
function resolvedFiles(blockers: readonly string[], known: readonly string[]): Set<string> | undefined {
 const files = new Set<string>();
 for (const text of blockers) {
  const anchor = known.filter(k => sameFile(k, findingFile(text)!));
  if (!anchor.length) return undefined;
  for (const k of [...anchor, ...known.filter(k => mentions(text, k))]) files.add(k);
 }
 return files;
}

// blockerFiles: los archivos de todos los blockers de la base. accepted: los textos que aceptó una persona, sin el prefijo
// de parte ni espacios de más.
export interface SecurityComparison { baseline: Review; changed: ReadonlySet<string>; tree: ReadonlySet<string>; blockerFiles: ReadonlySet<string>; accepted: ReadonlySet<string> }
const sameText = (text: string): string => text.replace(/^\s*parte \d+\/\d+ · /, "").replace(/\s+/g, " ").trim();
// El texto que aceptó una persona, sin los prefijos que pone el host: el de parte y el de repetido.
const REPEAT_PREFIX = `${SECURITY_ACCEPTED_REPEAT} · `;
const acceptedText = (text: string): string => { const same = sameText(text); return same.startsWith(REPEAT_PREFIX) ? sameText(same.slice(REPEAT_PREFIX.length)) : same; };
// Lo aceptado que la base ya bajó como repetido (un aviso con el prefijo del host), sin los prefijos.
const repeatedInBaseline = (baseline: Review): string[] => baseline.findings.filter(f => sameText(f).startsWith(REPEAT_PREFIX)).map(acceptedText);
/** Qué cambió desde la revisión anterior. Sin base no hay nada que comparar; si no se puede comparar, sólo una nota. */
export async function securityComparison(state: Workflow, snapshot: Pick<CheckoutSnapshot, "head" | "fingerprint">, runner: Runner, signal?: AbortSignal): Promise<{ comparison?: SecurityComparison; note?: string }> {
 const baseline = securityBaseline(state);
 if (!baseline) return {};
 if (baseline.partial) return { note: PARTIAL_BASELINE };
 // Todos los blockers de la base, también los que aceptó una persona: los dos tienen que citar su archivo. Lo que ya bajó como
 // repetido en la base cuenta siempre como blocker anterior, para la regla (b); como aceptado, sólo si una persona aceptó ese
 // texto en esta vuelta (un retry borra la aceptación). Un prefijo falso sólo suma un archivo protegido: falla cerrado.
 const repeated = repeatedInBaseline(baseline), acceptedNow = new Set(acceptedRisksOf(state).flatMap(a => a.findings).map(sameText));
 const blockers = [...securityBlockers(baseline), ...repeated], pending = new Set(unacceptedBlockers(state, baseline));
 if (blockers.some(text => findingFile(text) === null)) return { note: NO_BLOCKER_FILE };
 // Sobre el mismo contenido no cambió nada: no hace falta el commit ni el diff, pero sí el árbol de HEAD.
 const same = baseline.fingerprint === snapshot.fingerprint;
 const commit = same ? undefined : reviewedCommit(state, baseline.fingerprint);
 if (!same && !commit) return { note: NO_COMPARISON };
 try {
  const changed = commit ? await changedPaths(state.checkout, commit, snapshot.head, runner, signal) : [];
  const tree = await treePaths(state.checkout, snapshot.head, runner, signal);
  const blockerFiles = resolvedFiles(blockers, [...tree, ...changed]);
  if (!blockerFiles) return { note: NO_BLOCKER_IN_TREE };
  const accepted = new Set([...securityBlockers(baseline).filter(text => !pending.has(text)), ...repeated.filter(text => acceptedNow.has(text))].map(sameText));
  return { comparison: { baseline, changed: new Set(changed), tree: new Set(tree), blockerFiles, accepted } };
 } catch (error) {
  if (signal?.aborted) throw error;
  return { note: NO_COMPARISON };
 }
}
const clip = (text: string): string => text.length <= MAX_PREVIOUS_TEXT ? text : `${text.slice(0, /[\ud800-\udbff]/.test(text[MAX_PREVIOUS_TEXT - 2] ?? "") ? MAX_PREVIOUS_TEXT - 2 : MAX_PREVIOUS_TEXT - 1)}…`;
/** Lo que el lente ve de su revisión anterior: sus hallazgos, con lo aceptado y los blockers primero, y los archivos cambiados. */
export function previousMaterial(c: SecurityComparison) {
 const severities = c.baseline.verdict === "fail" ? severitiesOf(c.baseline) : [];
 // Un texto aceptado va entero y sin los prefijos del host: el lente lo tiene que poder repetir exacto.
 const all = c.baseline.findings.map((text, i) => {
  const accepted = c.accepted.has(acceptedText(text));
  return { blocker: severities[i] === "blocker", ...(accepted ? { accepted: true } : {}), text: accepted ? acceptedText(text) : clip(text) };
 });
 // Primero lo aceptado, después los blockers y después los avisos: el tope de 10 no puede dejar afuera un texto aceptado.
 const findings = [...all.filter(f => f.accepted), ...all.filter(f => !f.accepted && f.blocker), ...all.filter(f => !f.accepted && !f.blocker)];
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
  // Todo el texto, no sólo el primer tramo: el disparador puede estar en un archivo cambiado citado después.
  const file = findingFile(item.text), repeat = c.accepted.has(acceptedText(item.text));
  // Un texto aceptado vale como lo escribió la persona: una ruta corta («store.ts:22») se resuelve contra el árbol.
  const inTree = (path: string) => repeat ? [...c.tree].some(t => sameFile(t, path)) : c.tree.has(path);
  const touched = (path: string) => repeat ? [...c.changed].some(t => sameFile(t, path)) : c.changed.has(path);
  const unchanged = item.blocker && item.downgradable && !SECRET.test(item.text) && file !== null && inTree(file) && !touched(file)
   && !lineRefs(item.text).some(p => !inTree(p)) && !cites(item.text, c.changed);
  if (!unchanged) return item;
  // El texto que aceptó una persona baja como repetido; cualquier otro en el archivo de un blocker anterior se mantiene (b).
  if (!repeat && (c.blockerFiles.has(file) || cites(item.text, c.blockerFiles))) return item;
  downgraded++;
  return { ...item, blocker: false, text: prefixed(`${repeat ? SECURITY_ACCEPTED_REPEAT : SECURITY_DOWNGRADED} · `, item.text) };
 });
 return { result: withSecurityItems(result, items), downgraded };
}
