// ZIP de recibos: un único JSON conocido, sin extracción al filesystem ni ejecución de herramientas.
import { createHash } from "node:crypto";
import * as zlib from "node:zlib";
import { MAX_REVIEW_ARTIFACT_BYTES } from "./gha-review-contract.ts";
const MAX_ZIP_BYTES = 8 * 1024 * 1024;
function requireZip(condition: unknown): asserts condition { if (!condition) throw new Error("Artefacto ZIP inválido, ambiguo o fuera de límites"); }
function checksum(data: Buffer): number {
 if (typeof zlib.crc32 === "function") return zlib.crc32(data);
 // Compatibilidad con hosts compilados que todavía no exponen crc32 de Node>=22.2.
 let crc = 0xffffffff;
 for (const byte of data) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = crc >>> 1 ^ (crc & 1 ? 0xedb88320 : 0); }
 return (crc ^ 0xffffffff) >>> 0;
}
async function inflate(data: Buffer, signal?: AbortSignal): Promise<Buffer> {
 signal?.throwIfAborted();
 return new Promise((resolve, reject) => {
  const stream = zlib.createInflateRaw({ chunkSize: 16384 }); const chunks: Buffer[] = []; let length = 0;
  const abort = () => stream.destroy(new Error("Lectura del recibo cancelada")); signal?.addEventListener("abort", abort, { once: true });
  stream.on("data", (chunk: Buffer) => {
   length += chunk.length;
   if (length > MAX_REVIEW_ARTIFACT_BYTES) stream.destroy(new Error("Recibo descomprimido demasiado grande")); else chunks.push(chunk);
  });
  stream.once("error", () => { signal?.removeEventListener("abort", abort); reject(new Error("Recibo comprimido incompleto/fuera de límite")); });
  stream.once("end", () => { signal?.removeEventListener("abort", abort); resolve(Buffer.concat(chunks, length)); });
  stream.end(data);
 });
}
export async function readReceiptZip(bytes: Buffer, expectedName: "review.json" | "ship.json" | "omi-release-plan.json", digest?: string | null, signal?: AbortSignal): Promise<string> {
 signal?.throwIfAborted(); requireZip(Buffer.isBuffer(bytes) && bytes.length >= 22 && bytes.length <= MAX_ZIP_BYTES);
 if (digest !== undefined && digest !== null) requireZip(/^sha256:[a-f0-9]{64}$/.test(digest) && `sha256:${createHash("sha256").update(bytes).digest("hex")}` === digest);
 let end = -1;
 for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 22 - 65535); i--) {
  if (bytes.readUInt32LE(i) === 0x06054b50 && i + 22 + bytes.readUInt16LE(i + 20) === bytes.length) { end = i; break; }
 }
 requireZip(end >= 0 && bytes.readUInt16LE(end + 4) === 0 && bytes.readUInt16LE(end + 6) === 0 && bytes.readUInt16LE(end + 8) === 1 && bytes.readUInt16LE(end + 10) === 1);
 const central = bytes.readUInt32LE(end + 16), centralSize = bytes.readUInt32LE(end + 12);
 requireZip(central + centralSize === end && centralSize >= 46 && central + 46 <= end && bytes.readUInt32LE(central) === 0x02014b50);
 const flags = bytes.readUInt16LE(central + 8), method = bytes.readUInt16LE(central + 10), crc = bytes.readUInt32LE(central + 16);
 const compressedSize = bytes.readUInt32LE(central + 20), size = bytes.readUInt32LE(central + 24);
 const nameLength = bytes.readUInt16LE(central + 28), extraLength = bytes.readUInt16LE(central + 30), commentLength = bytes.readUInt16LE(central + 32);
 const attributes = bytes.readUInt32LE(central + 38), local = bytes.readUInt32LE(central + 42);
 const type = attributes >>> 16 & 0o170000;
 requireZip((flags & ~0x080e) === 0 && [0, 8].includes(method) && size <= MAX_REVIEW_ARTIFACT_BYTES && compressedSize <= MAX_ZIP_BYTES && bytes.readUInt16LE(central + 34) === 0
  && [0, 0o100000].includes(type) && !(attributes & 0x10) && 46 + nameLength + extraLength + commentLength === centralSize);
 const name = bytes.subarray(central + 46, central + 46 + nameLength); requireZip(name.equals(Buffer.from(expectedName)));
 requireZip(local + 30 <= central && bytes.readUInt32LE(local) === 0x04034b50 && bytes.readUInt16LE(local + 6) === flags && bytes.readUInt16LE(local + 8) === method);
 const localNameLength = bytes.readUInt16LE(local + 26), localExtraLength = bytes.readUInt16LE(local + 28);
 const start = local + 30 + localNameLength + localExtraLength;
 requireZip(start + compressedSize <= central && name.equals(bytes.subarray(local + 30, local + 30 + localNameLength)));
 if (!(flags & 8)) requireZip(bytes.readUInt32LE(local + 14) === crc && bytes.readUInt32LE(local + 18) === compressedSize && bytes.readUInt32LE(local + 22) === size);
 const compressed = bytes.subarray(start, start + compressedSize); const content = method === 8 ? await inflate(compressed, signal) : compressed;
 requireZip(content.length === size && content.length <= MAX_REVIEW_ARTIFACT_BYTES && checksum(content) === crc); signal?.throwIfAborted();
 return new TextDecoder("utf-8", { fatal: true }).decode(content);
}
