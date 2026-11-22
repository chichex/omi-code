// Identidad de datos JSON, independiente de schemas/reducers e I/O.
import { createHash } from "node:crypto";
function canonical(value: unknown): unknown {
 if (Array.isArray(value)) return value.map(canonical);
 return value && typeof value === "object" ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)])) : value;
}
export const dataHash = (value: unknown): string => createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
export const sameData = (a: unknown, b: unknown): boolean => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
