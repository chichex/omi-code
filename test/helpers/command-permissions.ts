// Autorización real de executeCheck y almacenamiento real del trabajo; sólo el proceso y la KB son dobles.
import assert from "node:assert/strict";
import type { TestContext } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { STRICT_POLICY, renderFoundationsBlock, type FoundationsBlock, type FoundationsPolicy } from "../../src/harness/foundations.ts";
import { foundationsDir, readTrust } from "../../src/harness/foundations-trust.ts";
import { executeCheck } from "../../src/tui/development-execution.ts";
import { DevelopmentSession } from "../../src/tui/development-session.ts";
import { developmentFixture } from "./development.ts";
import { memoryKb } from "./mock-kb.ts";
import { testIo } from "./io.ts";

export const AUTHORIZE = "Autorizar comando del proyecto";
export const REPO = "test/repo";
export const COMMAND = 'node -e "process.exit(0)"';
export const KNOWN = "node test.cjs";
export const HUMAN = '# Perillas de repo\n\nTono: formal.\n\n```json\n{ "otra": "perilla" }\n```\n';
export const block = (confirmar: string[] = ["git push *"], overrides: Partial<FoundationsBlock> = {}): FoundationsBlock => ({ version: 2, repo: REPO, confirmar, politica: { ...STRICT_POLICY }, ...overrides });

/** `foundations`: además, una revisión v2 aceptada localmente con `*` (la que vale si la KB no da una válida). */
export async function commandFixture(t: TestContext, options: { body?: string | null; value?: FoundationsBlock; products?: string[]; withoutKb?: boolean; foundations?: FoundationsPolicy } = {}) {
	const kb = memoryKb({ products: options.products ?? ["repo"] });
	if (options.body !== null) kb.perillas("repo", options.body ?? `${HUMAN}\n${renderFoundationsBlock(options.value ?? block())}\n`);
	const f = await developmentFixture(t, { ...(options.withoutKb ? {} : { kb }), ...(options.foundations ? { foundations: options.foundations } : {}) });
	await f.start(); await f.explore(); await f.action({ action: "planned", plan: f.plan() }); await f.action({ action: "approve" });
	assert.equal((await f.state()).phase, "implement", "la fixture llega a la etapa que permite setup");
	// Frontera Pi mínima: el propio DevelopmentSession sigue validando contexto, permisos y estado durable.
	const pi = { appendEntry: (name: string, data: unknown) => f.manager.appendCustomEntry(name, data), events: { emit() {} } } as unknown as ExtensionAPI;
	const session = new DevelopmentSession(pi, testIo({ homeDir: f.home, cwd: f.checkout.root }), [], { runner: f.runner, loader: f.loader, ...(options.withoutKb ? {} : { kb }) });
	await session.restore(f.context);
	const executed: string[] = [];
	const check = (command = COMMAND, signal = new AbortController().signal) => executeCheck(session, { kind: "setup", command }, f.context, signal, async (_checkout, actual) => {
		executed.push(actual); return { exitCode: 0, output: "prueba inyectada", interrupted: false };
	});
	return Object.assign(f, { kb, session, executed, check });
}
export type CommandFixture = Awaited<ReturnType<typeof commandFixture>>;
export const key = (f: CommandFixture) => ({ kbUrl: f.kb.url, product: "repo", repo: REPO });
export const saves = (f: CommandFixture) => f.kb.calls.filter((call) => call.tool === "guardar");
export const authorizations = (f: CommandFixture) => f.selects.filter((call) => call.title.startsWith(AUTHORIZE));
export const accepted = (f: CommandFixture) => readTrust(foundationsDir(f.home), key(f));

export function option(options: string[], decision: "yes" | "no" | "edit"): string {
	const selected = options.find((value) => decision === "yes" ? value === "Sí" : decision === "no" ? value === "No" : value === "Editar reglas");
	assert.ok(selected, `falta la decisión ${decision}: ${JSON.stringify(options)}`);
	return selected;
}
export function choose(f: CommandFixture, decision: "yes" | "no" | "edit" | "cancel"): void {
	f.uiControl.select = (_title, options) => decision === "cancel" ? undefined : option(options, decision);
}
export async function noPermissionAdded(f: CommandFixture, _command = COMMAND): Promise<void> {
	assert.deepEqual(f.executed, [], "no llegó al ejecutor, ni siquiera como comando interrumpido");
	assert.deepEqual((await f.state()).grants ?? [], [], "no hay fallback temporal: editar reglas no concede un grant");
}
