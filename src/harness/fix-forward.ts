// Fix-forward permanece en la raíz; los efectos se implementan como transportes host separados.
export { prepareFixForwardWorkspace, verifyFixForwardWorkspace } from "./fix-forward-workspace.ts";
export async function pushFixForward(..._args: unknown[]) { return { state: "unknown" }; }
export async function publishFixForward(..._args: unknown[]) { return { state: "unknown", pullRequest: null }; }
export function acceptFixForwardPull(original: unknown, ..._args: unknown[]) { return structuredClone(original); }
