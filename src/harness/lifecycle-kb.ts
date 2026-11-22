// Lifecycle KB compartido por CLI/TUI: sin imports runtime de Pi, preguntas del modelo ni efectos operativos.
import { createHash } from "node:crypto";
import type { KbClient, KbDoc } from "../tui/kb-client.ts";
import { checkLifecycleConfig, composeLifecyclePerillas, defaultLifecycleConfig, lifecycleHash, parseLifecycleConfig, type LifecycleConfig } from "./lifecycle-config.ts";
import { visibleText } from "./foundations.ts";
import { lifecycleKeyValid, readLifecycleTrust, writeLifecycleTrust, type LifecycleAcceptance, type LifecycleKey, type LifecycleTrust, type LifecycleTrustReading } from "./lifecycle-trust.ts";

export type LifecycleReading =
 | { kind: "unavailable"; key: LifecycleKey; reason: string }
 | { kind: "missing"; key: LifecycleKey; perillas: KbDoc | null }
 | { kind: "invalid"; key: LifecycleKey; perillas: KbDoc; reason: string }
 | { kind: "valid"; key: LifecycleKey; perillas: KbDoc; block: LifecycleConfig; hash: string };
function validDoc(value: KbDoc, key: LifecycleKey): boolean {
 return typeof value.id === "string" && value.id.length > 0 && value.id.length <= 200 && value.producto === key.product && value.tipo === "perillas"
  && typeof value.cuerpo === "string" && value.cuerpo.length <= 400_000 && typeof value.titulo === "string"
  && (value.autor === undefined || typeof value.autor === "string") && (value.fecha === undefined || typeof value.fecha === "string");
}
/** Confirmar ausencia requiere una respuesta de la KB accesible: sin acceso nunca es missing. */
export async function readLifecycle(kb: KbClient | undefined, key: LifecycleKey, cwd: string, signal: AbortSignal): Promise<LifecycleReading> {
 const unavailable = (reason: string): LifecycleReading => ({ kind: "unavailable", key, reason });
 if (!lifecycleKeyValid(key) || !kb || kb.url !== key.kbUrl) return unavailable("KB o identidad no disponible");
 try {
  signal.throwIfAborted(); const ready = await kb.ready(cwd, signal); signal.throwIfAborted();
  if (!ready.ready) return unavailable(ready.reason);
  if (!(await kb.products(signal)).includes(key.product)) return unavailable("Producto inexistente o sin acceso; no se considera ausencia de configuración");
  signal.throwIfAborted(); const doc = await kb.currentPerillas(key.product, signal); signal.throwIfAborted();
  return lifecycleFromPerillas(key, doc);
 } catch { return unavailable("No se pudo consultar la KB; no se presume configuración ausente"); }
}
/** Lectura del documento de perillas ya obtenido de una KB accesible (por ejemplo, el que leyó Foundations). */
export function lifecycleFromPerillas(key: LifecycleKey, doc: KbDoc | null): LifecycleReading {
 if (!doc) return { kind: "missing", key, perillas: null };
 if (!lifecycleKeyValid(key) || !validDoc(doc, key)) return { kind: "unavailable", key, reason: "La KB devolvió otro documento, identidad o formato" };
 const perillas = structuredClone(doc); const parsed = parseLifecycleConfig(perillas.cuerpo, key.repo);
 return parsed.status === "missing" ? { kind: "missing", key, perillas }
  : parsed.status === "invalid" ? { kind: "invalid", key, perillas, reason: parsed.reason }
  : { kind: "valid", key, perillas, block: parsed.block, hash: parsed.hash };
}
const sameKey = (a: LifecycleKey, b: LifecycleKey) => a.kbUrl === b.kbUrl && a.product === b.product && a.repo === b.repo;
export interface LifecycleEvaluation {
 status: "accepted" | "pending" | "missing" | "invalid" | "unavailable";
 canStartEffects: boolean; observationPin: LifecycleAcceptance | null;
}
/** Diagnóstico puro para --check. El pin viejo permite observar/recuperar recibos, nunca nuevos efectos. */
export function evaluateLifecycle(reading: LifecycleReading, local: LifecycleTrustReading): LifecycleEvaluation {
 const observationPin = local.kind === "valid" && sameKey(local.record, reading.key) ? structuredClone(local.record.accepted) : null;
 if (local.kind === "invalid" || local.kind === "valid" && !sameKey(local.record, reading.key)) return { status: "invalid", canStartEffects: false, observationPin: null };
 if (reading.kind !== "valid") return { status: reading.kind, canStartEffects: false, observationPin };
 const accepted = observationPin?.blockHash === reading.hash && observationPin.block.repo === reading.key.repo;
 return { status: accepted ? "accepted" : "pending", canStartEffects: accepted, observationPin };
}
function fields(value: unknown, prefix = ""): [string, string][] {
 if (Array.isArray(value)) return value.length ? value.flatMap((v, i) => fields(v, `${prefix}[${i}]`)) : [[prefix, "[]"]];
 if (value && typeof value === "object") return Object.entries(value).flatMap(([k, v]) => fields(v, prefix ? `${prefix}.${k}` : k));
 return [[prefix, String(value)]];
}
/** Resumen íntegro por campos: defaults/destinos/evidence y todas las perillas auto quedan visibles. */
export function lifecycleDiff(previous: LifecycleConfig | undefined, next: LifecycleConfig, key: LifecycleKey): string {
 const checked = checkLifecycleConfig(next); if ("reason" in checked) throw new Error(checked.reason);
 const before = new Map(fields(previous ?? defaultLifecycleConfig(next.repo, next.land.base)));
 const after = new Map(fields(checked.block));
 const rows = [...after].map(([name, value]) => {
  const was = before.get(name); const warning = name.endsWith(".mode") && value === "auto" ? " · AUTO: requiere igualmente reglas y permisos válidos" : "";
  return `${name}: ${was === undefined || was === value ? value : `${was} → ${value}`}${warning}`;
 });
 for (const [name, value] of before) if (!after.has(name)) rows.push(`- ${name}: ${value}`);
 return [`Lifecycle · ${key.repo} · KB ${key.product} (${key.kbUrl})`, previous ? `Antes: revisión aceptada ${lifecycleHash(previous)}` : "Antes: sin aceptación; defaults materializados (ningún efecto autorizado)", ...rows,
  "Aceptar configuración no ejecuta review, merge, workflows ni deploy; las reglas del repo y guardrails prevalecen."].map(visibleText).join("\n");
}
export interface LifecycleSaveDeps {
 trustDir: string; expectedRevision: number | undefined; signal: AbortSignal; now: () => string;
 beforeAccept?: () => Promise<void>;
 /** Frontera de persistencia inyectable para probar resultados inciertos después de rename. */
 writeAcceptance?: typeof writeLifecycleTrust;
}
class AcceptanceUnconfirmed extends Error {
 constructor() { super("No se pudo confirmar la aceptación local; pudo persistirse. Releer antes de continuar"); }
}
async function assertLocal(deps: LifecycleSaveDeps, key: LifecycleKey): Promise<LifecycleTrust | undefined> {
 deps.signal.throwIfAborted(); const local = await readLifecycleTrust(deps.trustDir, key); deps.signal.throwIfAborted();
 if (local.kind === "invalid") throw new Error("Registro de aceptación inválido; recuperar antes de aceptar");
 const record = local.kind === "valid" ? local.record : undefined;
 if (record?.revision !== deps.expectedRevision) throw new Error("La aceptación cambió durante la decisión");
 return record;
}
function acceptance(reading: Extract<LifecycleReading, { kind: "valid" }>, now: () => string): LifecycleAcceptance {
 return { docId: reading.perillas.id, blockHash: reading.hash, block: reading.block, author: reading.perillas.autor ?? "", date: reading.perillas.fecha ?? "", acceptedAt: now() };
}
async function saveAcceptance(deps: LifecycleSaveDeps, key: LifecycleKey, pin: LifecycleAcceptance): Promise<void> {
 const local = await assertLocal(deps, key);
 const next: LifecycleTrust = { version: 1, ...key, revision: local ? local.revision + 1 : 0, accepted: pin, deferred: local?.deferred ?? null };
 deps.signal.throwIfAborted();
 try { await (deps.writeAcceptance ?? writeLifecycleTrust)(deps.trustDir, key, deps.expectedRevision, next); }
 catch { throw new AcceptanceUnconfirmed(); }
}
/** Únicamente una confirmación host explícita acepta una revisión externa. Sin UI/confirm no escribe. */
export async function acceptLifecycle(kb: KbClient, key: LifecycleKey, cwd: string, deps: LifecycleSaveDeps & { confirm?: (diff: string) => Promise<boolean> }): Promise<LifecycleAcceptance | null> {
 if (!deps.confirm) return null;
 const local = await assertLocal(deps, key); const reading = await readLifecycle(kb, key, cwd, deps.signal);
 if (reading.kind !== "valid") return null;
 if (local?.accepted?.blockHash === reading.hash) return structuredClone(local.accepted);
 if (!(await deps.confirm(lifecycleDiff(local?.accepted?.block, reading.block, key)))) return null;
 deps.signal.throwIfAborted(); await deps.beforeAccept?.(); await assertLocal(deps, key);
 const fresh = await readLifecycle(kb, key, cwd, deps.signal);
 if (fresh.kind !== "valid" || fresh.hash !== reading.hash) throw new Error("La configuración cambió durante la confirmación; revisar otra vez");
 const pin = acceptance(fresh, deps.now); await saveAcceptance(deps, key, pin);
 if (deps.signal.aborted) throw new Error("Aceptación local durable; continuación cancelada, no se ejecutó ninguna operación");
 return pin;
}
export interface PreparedLifecycleSave { previous: KbDoc | null; body: string; clave: string; blockHash: string; cwd: string }
/** Preparación sin escritura, para el resumen que verá la persona antes de guardar. */
export async function prepareLifecycleSave(kb: KbClient, key: LifecycleKey, block: LifecycleConfig, signal: AbortSignal, expectedHash: string | null, cwd = process.cwd()): Promise<PreparedLifecycleSave> {
 const current = await readLifecycle(kb, key, cwd, signal); signal.throwIfAborted();
 if (current.kind === "unavailable" || current.kind === "invalid") throw new Error("No se puede preparar el guardado: KB inaccesible o configuración inválida");
 if ((current.kind === "valid" ? current.hash : null) !== expectedHash) throw new Error("La revisión lifecycle cambió antes de componer las perillas");
 const previous = current.perillas;
 const body = composeLifecyclePerillas(previous?.cuerpo, key.product, key.repo, block);
 if (body.length > 400_000) throw new Error("Las perillas exceden el límite de la KB");
 const bodyHash = createHash("sha256").update(body).digest("hex");
 return { previous, body, blockHash: lifecycleHash(block), cwd, clave: `omi-development-lifecycle|${key.repo}|${previous?.id ?? "none"}|${bodyHash}` };
}
/** Guardado optimista, no CAS remoto. Tras incertidumbre sólo observa: nunca repite la mutación. */
export async function commitLifecycleSave(kb: KbClient, key: LifecycleKey, block: LifecycleConfig, prepared: PreparedLifecycleSave, deps: LifecycleSaveDeps): Promise<LifecycleAcceptance> {
 deps.signal.throwIfAborted();
 if (prepared.blockHash !== lifecycleHash(block) || prepared.body !== composeLifecyclePerillas(prepared.previous?.cuerpo, key.product, key.repo, block)) throw new Error("El contenido preparado cambió; revisar el resumen");
 await deps.beforeAccept?.(); deps.signal.throwIfAborted();
 const current = await readLifecycle(kb, key, prepared.cwd, deps.signal); deps.signal.throwIfAborted();
 if (current.kind === "unavailable" || current.kind === "invalid") throw new Error("KB no disponible o inválida antes del guardado");
 if ((current.perillas?.id ?? null) !== (prepared.previous?.id ?? null) || current.perillas?.cuerpo !== prepared.previous?.cuerpo) throw new Error("Las perillas cambiaron antes de guardar; no se guardó nada");
 await assertLocal(deps, key); deps.signal.throwIfAborted();
 let sent = false; let confirmed = false; let accepted = false;
 try {
  sent = true;
  let savedId: string;
  try { const saved = await kb.save({ product: key.product, titulo: prepared.previous?.titulo || `Perillas de ${key.product}`, cuerpo: prepared.body, clave: prepared.clave }, deps.signal); savedId = saved.id; }
  catch {
   deps.signal.throwIfAborted();
   const observed = await readLifecycle(kb, key, prepared.cwd, deps.signal);
   if (observed.kind !== "valid" || observed.perillas.cuerpo !== prepared.body) throw new Error("Guardado incierto: no se repite la mutación");
   savedId = observed.perillas.id;
  }
  deps.signal.throwIfAborted(); const stored = await kb.read(savedId, deps.signal); deps.signal.throwIfAborted();
  if (!validDoc(stored, key) || stored.id !== savedId || stored.cuerpo !== prepared.body) throw new Error("La KB no confirmó el contenido guardado");
  confirmed = true;
  await deps.beforeAccept?.(); deps.signal.throwIfAborted();
  const latest = await readLifecycle(kb, key, prepared.cwd, deps.signal); deps.signal.throwIfAborted();
  if (latest.kind !== "valid" || latest.perillas.id !== stored.id || latest.perillas.cuerpo !== prepared.body || latest.hash !== prepared.blockHash) throw new Error("Hay otra revisión de perillas antes de aceptar");
  const pin = acceptance(latest, deps.now); await saveAcceptance(deps, key, pin); accepted = true;
  deps.signal.throwIfAborted(); return pin;
 } catch (error) {
  const status = accepted ? "KB guardada y aceptación local durable; operación posterior cancelada"
   : error instanceof AcceptanceUnconfirmed ? `KB guardada. ${error.message}; no se inicia ninguna operación`
   : confirmed ? "KB guardada, pero aceptación no completada; no se inicia ninguna operación"
    : sent ? "Guardado KB incierto; pudo guardarse, no hay aceptación ni se repite"
     : "No se guardó ni aceptó la configuración";
  throw new Error(status);
 }
}
