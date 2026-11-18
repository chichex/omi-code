// Observación del runtime, separada de la API de propuestas del modelo. Nunca acredita gates.
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { DevelopmentSession, ObservationOrigin } from "./development-session.ts";
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
export function observeDevelopment(pi: ExtensionAPI, session: DevelopmentSession): void {
 let ctx: ExtensionContext | undefined;
 const tools = new Map<string, ObservationOrigin>();
 const batches = new Map<string, ObservationOrigin>();
 const clear = () => { tools.clear(); batches.clear(); };
 pi.on("session_start", (_event, context) => { ctx = context; clear(); });
 pi.on("session_tree", (_event, context) => { ctx = context; clear(); });
 pi.on("agent_start", async (_event, context) => { await session.observe(session.observationOrigin(), "inline", context); });
 pi.on("tool_call", event => {
  if (event.parentToolCallId || event.toolName === "subagent" || event.toolName === "omi_workflow" && event.input.action === "status") return;
  const origin = session.observationOrigin();
  if (origin && tools.size < 1024) tools.set(event.toolCallId, origin);
 });
 pi.on("tool_result", async (event, context) => {
  const origin = tools.get(event.toolCallId); tools.delete(event.toolCallId);
  if (origin) await session.observe(origin, "inline", context);
 });
 pi.on("tool_execution_end", event => { tools.delete(event.toolCallId); });
 const unsubscribe = pi.events.on?.("omi:subagents", (event: unknown) => {
  if (!ctx || !record(event) || typeof event.id !== "string" || !event.id.length || event.id.length > 256 || /[\u0000-\u0020\u007f-\u009f\u202a-\u202e\u2066-\u2069]/.test(event.id) || !["start", "update", "end"].includes(String(event.phase))) return;
  if (!record(event.details) || !Array.isArray(event.details.results) || event.details.results.length > 8) return;
  if (event.phase === "start") { const origin = session.observationOrigin(); if (origin && batches.size < 8) batches.set(event.id, origin); }
  const origin = batches.get(event.id);
  if (event.phase === "end") batches.delete(event.id);
  const ran = event.details.results.some((r: unknown) => record(r) && ["scout", "planner", "reviewer", "worker"].includes(String(r.agent)) && (r.status === "running" || typeof r.turns === "number" && Number.isSafeInteger(r.turns) && r.turns > 0));
  if (origin && ran) return session.observe(origin, "subagent", ctx);
 });
 pi.on("session_shutdown", () => { ctx = undefined; clear(); unsubscribe?.(); });
}
