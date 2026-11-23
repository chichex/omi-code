// El setup de lo que falta: Foundations y después el lifecycle, solo o con /omi-setup. Git temporal, KB en memoria, sin red.
// Cambio de requisito del dueño (2026-11-23): «todas estas fallas de que falta algo de configurar, que se detecten solas y te corra Foundations».
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { FORMATO_ANTERIOR } from "../src/harness/config-doctor.ts";
import { foundationsDir, readTrust, trustPath } from "../src/harness/foundations-trust.ts";
import { lifecycleTrustDir, readLifecycleTrust } from "../src/harness/lifecycle-trust.ts";
import { developmentFixture } from "./helpers/development.ts";
import { autoContinuity, continuityFixture } from "./helpers/lifecycle-continuity.ts";
import { memoryKb, type MemoryKb } from "./helpers/mock-kb.ts";
import { KEYS } from "./helpers/questions.ts";

const REPO = "test/repo";
const SAVE = ["\x13", "\x13"];
const saves = (kb: MemoryKb) => kb.calls.filter((call) => call.tool === "guardar").length;
const trustKey = (kb: MemoryKb, repo = REPO) => ({ kbUrl: kb.url, product: repo.split("/")[1]!, repo });
const git = (root: string, ...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
/** La rama base que el wizard del lifecycle lee de origin/HEAD. */
const originHead = (root: string) => git(root, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main");

async function fixture(t: TestContext, options: { body?: string | null; available?: string; args?: readonly string[] } = {}) {
	const kb = memoryKb({ products: ["repo"] }); if (options.body) kb.perillas("repo", options.body);
	if (options.available) kb.available = options.available;
	const background: Promise<void>[] = [];
	const f = await developmentFixture(t, { kb, ...(options.args ? { args: options.args } : {}), deps: { background: (work) => { background.push(work); } } });
	originHead(f.checkout.root);
	/** Una sesión interactiva nueva del mismo checkout: otra instancia de la extensión, sin mensajes. */
	const session = async (reason: string) => {
		Reflect.set(f.context, "sessionManager", SessionManager.create(f.checkout.root, join(f.home, `sessions-${reason}-${background.length}-${f.asked.length}`)));
		await f.attach(); await f.emit("session_start", { reason }); await Promise.all(background);
	};
	return Object.assign(f, { kb, session, settled: () => Promise.all(background) });
}
const titles = (f: { asked: string[][] }) => f.asked.map((screens) => /Foundations de|Ship de|Resumen antes|Continuidad|Review del PR|Entrada/.exec(screens[0] ?? "")?.[0] ?? "?");

test("config_setup: /omi-setup corre Foundations y después el lifecycle, en orden, y también lo postergado", async (t) => {
	const f = await fixture(t);
	f.uiControl.questions = (screen) => /Foundations de/.test(screen) ? ["1"] : /Ship de/.test(screen) ? ["2"] : [KEYS.esc];
	f.uiControl.foundations = () => SAVE;
	await f.run("omi-setup");
	assert.deepEqual(titles(f), ["Foundations de", "Ship de"], "primero Foundations, después el wizard del lifecycle");
	assert.equal(f.foundationsScreens.length, 1, "Configurar ahora abre el panel existente"); assert.equal(saves(f.kb), 1, "sólo Guardar del panel escribe la KB");
	assert.ok((await readTrust(foundationsDir(f.home), trustKey(f.kb)))?.accepted, "Foundations quedó aceptado");
	const lifecycle = await readLifecycleTrust(lifecycleTrustDir(f.home), trustKey(f.kb));
	assert.ok(lifecycle.kind === "valid"); assert.match(lifecycle.record.deferred?.revision ?? "", /^missing:/, "Más adelante posterga esa revisión del lifecycle");
	f.uiControl.questions = () => [KEYS.esc];
	await f.run("omi-setup");
	assert.deepEqual(titles(f).slice(2), ["Ship de"], "el comando también corre lo postergado; Foundations ya está");
	assert.ok(f.messages.some((message) => /Configuración cancelada: no se guardó nada/.test(message)));
	assert.equal(saves(f.kb), 1, "cancelar no guarda nada");
});

test("config_setup: /omi-setup sin nada para correr muestra el diagnóstico; la KB caída es «no disponible», nunca «falta»", async (t) => {
	const f = await fixture(t, { available: "la KB no conectó a tiempo (sin login en /mcp, sin red o lenta)" });
	await f.run("omi-setup");
	assert.equal(f.asked.length, 0); assert.equal(f.foundationsScreens.length, 0);
	const shown = f.messages.at(-1) ?? "";
	assert.match(shown, /Foundations · no disponible: No se pudo leer Foundations: la KB no conectó a tiempo/);
	assert.match(shown, /Lifecycle · no disponible/); assert.match(shown, /Proyecto OMI · falta: Sin proyecto OMI vinculado/);
	assert.doesNotMatch(shown, /Foundations · falta/);
	const offline = await fixture(t, { args: ["--offline"] }); await offline.run("omi-setup");
	assert.equal(offline.asked.length, 0); assert.match(offline.messages.at(-1) ?? "", /Sin red/);
});

test("config_setup: una sesión interactiva nueva lo ofrece sola; resume, reload, fork y una sesión con mensajes, no", async (t) => {
	const f = await fixture(t); f.uiControl.questions = () => [KEYS.esc];
	await f.attach(); await f.emit("session_start", { reason: "startup" }); await f.settled();
	assert.equal(f.asked.length, 0, "abrir una sesión que ya tiene mensajes no es una sesión nueva");
	for (const reason of ["resume", "reload", "fork"]) { await f.session(reason); assert.equal(f.asked.length, 0, reason); }
	await f.session("startup"); assert.deepEqual(titles(f), ["Foundations de"], "arranque de una sesión nueva");
	await f.session("new"); assert.deepEqual(titles(f), ["Foundations de", "Foundations de"], "/new también; Esc no posterga");
	assert.equal(saves(f.kb), 0); assert.equal(await readTrust(foundationsDir(f.home), trustKey(f.kb)), undefined);
});

test("config_setup: sin UI, offline o con la KB caída no se ofrece ni al arrancar el harness ni al abrir una sesión", async (t) => {
	const rpc = await fixture(t); Reflect.set(rpc.context, "mode", "rpc"); await rpc.start(); await rpc.session("startup");
	assert.equal(rpc.asked.length, 0, "sin TUI no hay a quién preguntar");
	const offline = await fixture(t, { args: ["--offline"] }); await offline.session("startup");
	assert.equal(offline.asked.length, 0, "offline no ofrece");
	const down = await fixture(t, { available: "KB caída" }); await down.start(); await down.session("startup");
	assert.equal(down.asked.length, 0, "KB caída no es «falta configurar»"); assert.equal(saves(down.kb), 0);
});

test("config_setup: «Más adelante» de Foundations no se repite en esa revisión; el lifecycle sí se ofrece y /omi-setup lo retoma", async (t) => {
	const f = await fixture(t);
	f.uiControl.questions = (screen) => /Foundations de/.test(screen) ? ["2"] : [KEYS.esc];
	await f.start();
	assert.deepEqual(titles(f), ["Foundations de", "Ship de"], "Más adelante sigue con el lifecycle");
	await f.session("startup");
	assert.deepEqual(titles(f).slice(2), ["Ship de"], "la revisión postergada de Foundations no vuelve a salir sola");
	await f.run("omi-setup");
	assert.equal(titles(f)[3], "Foundations de", "el comando sí ofrece lo postergado");
	assert.equal(saves(f.kb), 0);
});

test("config_setup: un registro local del formato anterior se avisa como tal, sin nombrar versiones ni reescribirlo al cancelar", async (t) => {
	const f = await fixture(t); const dir = foundationsDir(f.home); await mkdir(dir, { recursive: true, mode: 0o700 });
	const legacy = JSON.stringify({ version: 1, ...trustKey(f.kb), accepted: null, offerDeclined: false });
	await writeFile(trustPath(dir, trustKey(f.kb)), legacy, { mode: 0o600 });
	f.uiControl.questions = () => [KEYS.esc]; await f.start();
	const offer = f.asked[0]?.join("\n") ?? "";
	assert.match(offer.replace(/\s+/g, " "), new RegExp(FORMATO_ANTERIOR.slice(0, 40))); assert.doesNotMatch(offer, /\bv1\b|version/i);
	assert.equal(await readTrust(dir, trustKey(f.kb)), undefined, "sigue sin valer y no se migró");
});

test("config_setup: publicar el PR draft sin continuidad ofrece el wizard; Más adelante posterga y no adopta", async (t) => {
	const { f, gh, kb } = await continuityFixture(t); originHead(f.checkout.root);
	// El detalle se desplaza con PgDn en 80×24: las recomendaciones van al final.
	f.uiControl.questions = (screen) => /Ship de acme\/app/.test(screen) ? [KEYS.pageDown, KEYS.pageDown, KEYS.pageDown, "3"] : [KEYS.esc];
	await f.command("pr");
	assert.deepEqual(titles(f), ["Ship de"], "al publicar sólo el lifecycle, nunca Foundations");
	assert.match(f.asked[0]!.join("\n"), /Continuidad sin configurar/);
	const state = await f.state();
	assert.equal(state.phase, "done"); assert.equal(state.version === 2 && state.lifecycle.status, "disabled", "no adopta el draft");
	const local = await readLifecycleTrust(lifecycleTrustDir(f.home), trustKey(kb, "acme/app"));
	assert.ok(local.kind === "valid"); assert.equal(local.record.deferred?.revision, `lifecycle:${local.record.accepted?.blockHash}`);
	assert.deepEqual(gh.mutations, [], "publicar no hace ready ni merge");
});

test("config_setup: guardar la continuidad al publicar no adopta el draft y avisa el próximo paso", async (t) => {
	const { f, gh, kb } = await continuityFixture(t); originHead(f.checkout.root);
	const answers: [RegExp, string[]][] = [[/Ship de acme\/app/, ["1"]], [/Review del PR/, ["1"]], [/Continuidad del lifecycle/, ["2"]],
		[/Entrada, Review, Fix y Land/, ["1", "1", "1", "1", KEYS.enter]], [/Continuidad de Ship/, ["1"]], [/Resumen antes de guardar/, ["1", KEYS.enter]]];
	f.uiControl.questions = (screen) => answers.find(([pattern]) => pattern.test(screen))?.[1] ?? [KEYS.esc];
	await f.command("pr");
	const local = await readLifecycleTrust(lifecycleTrustDir(f.home), trustKey(kb, "acme/app"));
	assert.ok(local.kind === "valid"); assert.equal(local.record.accepted?.block.continuity?.entry, "ask");
	const state = await f.state();
	assert.equal(state.version === 2 && state.lifecycle.status, "disabled", "guardar no adopta el draft");
	assert.ok(f.messages.some((message) => /\/omi-work adopt/.test(message) && /PR draft #8/.test(message)), "dice cómo seguir");
	assert.deepEqual(gh.mutations, []);
});

test("config_setup: con continuidad configurada o la KB caída, publicar no ofrece nada", async (t) => {
	const configured = await continuityFixture(t, { change: (block) => { block.continuity = { ...autoContinuity, entry: "manual" }; } }); originHead(configured.f.checkout.root);
	configured.f.uiControl.questions = () => [KEYS.esc]; await configured.f.command("pr");
	assert.equal(configured.f.asked.length, 0);
	const down = await continuityFixture(t); originHead(down.f.checkout.root); down.f.uiControl.questions = () => [KEYS.esc];
	down.kb.available = "KB caída"; await down.f.command("pr");
	assert.equal(down.f.asked.length, 0, "sin lectura no se ofrece");
});

// Integración de áreas: en la TUI, lo que falta de configurar se resuelve con /omi-setup, no con un comando de terminal.
test("config_setup: sin lifecycle en la KB, publicar y /omi-work adopt mandan a /omi-setup", async (t) => {
	const { f, gh, kb } = await continuityFixture(t); originHead(f.checkout.root);
	kb.perillas("app", "# Perillas de app\n");
	f.uiControl.questions = () => [KEYS.esc];
	await f.command("pr");
	await f.command("adopt");
	const notices = f.messages.filter((message) => /^Lifecycle sin configurar para acme\/app/.test(message));
	assert.equal(notices.length, 2, "publicar y adopt lo avisan");
	for (const notice of notices) { assert.match(notice, /\/omi-setup/); assert.doesNotMatch(notice, /omi init --development/); }
	const state = await f.state();
	assert.equal(state.version === 2 && state.lifecycle.status, "disabled"); assert.deepEqual(gh.mutations, []);
});

test("config_setup: con el PR adoptado y Ship sin configurar, /omi-work status manda a /omi-setup", async (t) => {
	const { f } = await continuityFixture(t, { change: (block) => { block.ship = { status: "unconfigured", targets: [] }; } }); originHead(f.checkout.root);
	f.uiControl.questions = () => [KEYS.esc];
	await f.command("pr"); await f.command("adopt");
	const state = await f.state(); assert.equal(state.version === 2 && state.lifecycle.status, "enabled", "adopt habilita el lifecycle");
	await f.command("status");
	const status = f.messages.at(-1) ?? "";
	assert.match(status, /Ship: sin configurar \(\/omi-setup\)/); assert.doesNotMatch(status, /omi init --development/);
});
