// Contexto activo sin reemplazar checkout/publicación/PR históricos ni clonar la autoridad presupuestaria.
import type { Workflow } from "./model.ts";
export function currentRecoveryWorkspace(state: Workflow) {
 if (state.version !== 2 || state.lifecycle.status !== "enabled") return undefined;
 const lifecycle = state.lifecycle; return lifecycle.activeRecoveryId ? lifecycle.recoveryWorkspaces?.find(w => w.id === lifecycle.activeRecoveryId) : undefined;
}
export function executionCheckout(state: Workflow) { return currentRecoveryWorkspace(state)?.checkout ?? state.checkout; }
export function activePullRequest(state: Workflow) { const w = currentRecoveryWorkspace(state); return w ? w.pullRequest : state.version === 2 ? state.pullRequest : null; }
export function activePublication(state: Workflow): Workflow["publication"] {
 const w = currentRecoveryWorkspace(state); return w ? w.pullRequest ? { status: "opened", number: w.pullRequest.number, url: w.pullRequest.url, head: w.pullRequest.head } : { status: "none" } : state.publication;
}
