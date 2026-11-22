// Algoritmo v1 congelado del planner conocido. Sólo evalúa datos; no importa ni ejecuta el CLI objetivo.
const dirs = ["src/", "bin/"];
const files = new Set(["package.json", "package-lock.json", "tsconfig.json", "install.sh", "scripts/build-release.ts", "scripts/bundled-tools.ts", "scripts/bundled-tools.json"]);
export function packagedV1(path: string): boolean { return !path.endsWith(".test.ts") && (files.has(path) || dirs.some(dir => path.startsWith(dir))); }
export function versionV1(current: string, commits: readonly { message: string; files: string[] }[], force = false): string | null {
 const messages = commits.filter(c => c.files.some(packagedV1)).map(c => c.message); if (!messages.length && !force) return null;
 const [major = 0, minor = 0, patch = 0] = current.split(".").map(Number);
 const breaking = messages.some(m => /^[a-z]+(\([^)]*\))?!:/.test(m) || /^BREAKING[ -]CHANGE:/m.test(m));
 if (breaking && major > 0) return `${major + 1}.0.0`;
 return breaking || messages.some(m => /^feat(\([^)]*\))?:/.test(m)) ? `${major}.${minor + 1}.0` : `${major}.${minor}.${patch + 1}`;
}
export function latestV1(tags: readonly string[]): string | null {
 const versions = tags.flatMap(tag => { const m = /^v(\d+)\.(\d+)\.(\d+)$/.exec(tag); return m ? [[Number(m[1]), Number(m[2]), Number(m[3])]] : []; });
 versions.sort((a, b) => (b[0] ?? 0) - (a[0] ?? 0) || (b[1] ?? 0) - (a[1] ?? 0) || (b[2] ?? 0) - (a[2] ?? 0)); return versions[0]?.join(".") ?? null;
}
