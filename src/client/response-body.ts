// Límite antes de JSON/validación, incluso para errores. Nunca devuelve cuerpos truncados.
import { OmiError } from "../core/errors.ts";
export async function boundedResponseText(response: Response, limit: number): Promise<string> {
 const reader = response.body?.getReader(); if (!reader) return ""; const chunks: Uint8Array[] = []; let bytes = 0;
 try {
  while (true) { const chunk = await reader.read(); if (chunk.done) break; bytes += chunk.value.byteLength;
   if (bytes > limit) throw new OmiError("response_too_large", "OMI excedió el límite de bytes de respuesta"); chunks.push(chunk.value);
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
 } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}
