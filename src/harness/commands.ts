// Keep Pi's native process-tree cancellation; never echo the environment or backend errors.
import { StringDecoder } from "node:string_decoder";
import type { BashOperations } from "@earendil-works/pi-coding-agent";
import { childEnvironment } from "../core/process-environment.ts";
import type { Workflow } from "./model.ts";

export const DEFAULT_COMMAND_TIMEOUT_SECONDS = 300;
/** timedOut: Pi lo cortó por su plazo, no la persona; también es interrupted. */
export interface WorkflowCommandResult { exitCode: number | null; output: string; interrupted: boolean; timedOut?: true }
export async function runWorkflowCommand(
 checkout: Workflow["checkout"], command: string, signal: AbortSignal, timeoutSeconds = DEFAULT_COMMAND_TIMEOUT_SECONDS, backend?: BashOperations,
): Promise<WorkflowCommandResult> {
 if (!command.trim()) throw new Error("Comando vacío");
 if (!Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0 || timeoutSeconds > 2147483) throw new Error("Timeout inválido");
 if (signal.aborted) return { exitCode: null, output: "", interrupted: true };
 const operations = backend ?? (await import("@earendil-works/pi-coding-agent")).createLocalBashOperations();
 let output = ""; const decoder = new StringDecoder("utf8");
 const append = (text: string) => { output = (output + text).slice(-12000); };
 try {
  const result = await operations.exec(command, checkout.root, {
   signal, timeout: timeoutSeconds, env: childEnvironment(process.env), onData: data => append(decoder.write(data)),
  });
  append(decoder.end());
  return { exitCode: signal.aborted ? null : result.exitCode, output, interrupted: signal.aborted };
 } catch (error) {
  append(decoder.end());
  const interrupted = signal.aborted || (error instanceof Error && (error.message === "aborted" || error.message.startsWith("timeout:")));
  // `timeout:<s>` es el mensaje del ShellTimeoutError de Pi. Si la persona canceló, gana la cancelación.
  const timedOut = !signal.aborted && error instanceof Error && error.message.startsWith("timeout:");
  return { exitCode: null, output, interrupted, ...(timedOut ? { timedOut: true as const } : {}) };
 }
}
