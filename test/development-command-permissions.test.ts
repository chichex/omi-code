// Las decisiones humanas de autorización en TUI/RPC; ningún resultado tardío concede permiso.
import assert from "node:assert/strict";
import { test } from "node:test";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { darkTheme, fakeTui } from "./helpers/questions.ts";
import { commandAuthorization } from "../src/harness/authorization.ts";
import { AUTHORIZE, COMMAND, REPO, accepted, authorizations, block, choose, commandFixture, noPermissionAdded, option, saves } from "./helpers/command-permissions.ts";

for (const mode of ["tui", "rpc"] as const) {
	test(`command_permissions: ${mode} ofrece Sí/No/Editar reglas y muestra comando, alcance y destino`, async (t) => {
		const f = await commandFixture(t); Reflect.set(f.context, "mode", mode); choose(f, "no");
		await assert.rejects(f.check(), /no autorizado|cancel/i);
		assert.equal(authorizations(f).length, 1, "no usa la confirmación binaria");
		const dialog = authorizations(f)[0]!;
		assert.deepEqual(dialog.options, ["Sí", "No", "Editar reglas"]);
		const text = [dialog.title, ...dialog.options].join("\n");
		for (const visible of [COMMAND, f.checkout.root, REPO, new URL(f.kb.url).host, "producto repo", "perillas"]) assert.ok(text.includes(visible));
		assert.match(text, /Foundations/); assert.match(text, /KB/);
		assert.match(text, /queda guardado para este trabajo/); assert.match(text, /exacto|EXACTO/);
		assert.match(text, /reintent|volver a intentar/); assert.doesNotMatch(text, /Permitir siempre/);
		assert.match(text, /(?:no |nunca )(?:autoriza|habilita).*(?:merge|deploy|secretos)/i);
		if (mode === "tui") {
			const rendered = f.permissionScreens.at(-1)!.join("\n").replace(/\s+/g, "");
			for (const visible of [COMMAND, f.checkout.root, REPO, new URL(f.kb.url).host, "producto repo", "perillas"]) {
				assert.ok(rendered.includes(visible.replace(/\s+/g, "")), `las páginas muestran ${visible}, no sólo sus props`);
			}
		}
		assert.equal(saves(f).length, 0); await noPermissionAdded(f);
	});

	test(`command_permissions: ${mode} Sí guarda sólo el grant exacto del trabajo, no la KB`, async (t) => {
		const f = await commandFixture(t); Reflect.set(f.context, "mode", mode); choose(f, "yes");
		const previous = await accepted(f);
		await f.check(); await f.check();
		assert.deepEqual(f.executed, [COMMAND, COMMAND]); assert.equal(authorizations(f).length, 1);
		const state = await f.state();
		assert.deepEqual(state.grants?.map((grant) => grant.command), [COMMAND]);
		assert.equal(saves(f).length, 0); assert.deepEqual(await accepted(f), previous);
		const policy = { block: block(), accepted: true };
		assert.equal(commandAuthorization({ ...state, id: "otro-trabajo" }, COMMAND, policy), "ask");
		assert.equal(commandAuthorization({ ...state, source: { ...state.source, hash: "otro-pedido" } }, COMMAND, policy), "ask");
	});

	test(`command_permissions: ${mode} No y cerrar no ejecutan ni guardan y permiten preguntar de nuevo`, async (t) => {
		for (const decision of ["no", "cancel"] as const) {
			const f = await commandFixture(t); Reflect.set(f.context, "mode", mode); choose(f, decision);
			const previous = await accepted(f);
			await assert.rejects(f.check(), /no autorizado|cancel/i);
			await noPermissionAdded(f); assert.equal(saves(f).length, 0); assert.deepEqual(await accepted(f), previous);
			assert.equal(authorizations(f).length, 1, decision);
			choose(f, "yes"); await f.check();
			assert.deepEqual(f.executed, [COMMAND]); assert.equal(authorizations(f).length, 2);
		}
	});
}

test("command_permissions: RPC Editar reglas requiere TUI sin guardar, conceder ni ejecutar", async (t) => {
	const f = await commandFixture(t); Reflect.set(f.context, "mode", "rpc"); choose(f, "edit"); const previous = await accepted(f);
	await assert.rejects(f.check(), /TUI|interactiva/i);
	assert.equal(f.foundationsScreens.length, 0); assert.equal(saves(f).length, 0); await noPermissionAdded(f);
	assert.deepEqual(await accepted(f), previous);
});

test("command_permissions: sin UI no pregunta, no ejecuta y no concede permisos", async (t) => {
	const f = await commandFixture(t); Reflect.set(f.context, "hasUI", false); choose(f, "edit");
	await assert.rejects(f.check(), /interactiv|humana|UI/i);
	assert.equal(authorizations(f).length, 0); assert.equal(saves(f).length, 0); await noPermissionAdded(f);
});

test("command_permissions: error del selector falla cerrado sin fallback binario", async (t) => {
	const f = await commandFixture(t); f.uiControl.select = () => { throw new Error("selector fallido"); };
	await assert.rejects(f.check(), /selector fallido/);
	assert.equal(authorizations(f).length, 1); assert.equal(saves(f).length, 0); await noPermissionAdded(f);
});

for (const decision of ["yes", "edit"] as const) {
	test(`command_permissions: abortar antes de ${decision} no abre UI ni guarda`, async (t) => {
		const f = await commandFixture(t); choose(f, decision); const controller = new AbortController(); controller.abort();
		await assert.rejects(f.check(COMMAND, controller.signal), /abort|cancel/i);
		assert.equal(authorizations(f).length, 0); assert.equal(saves(f).length, 0); await noPermissionAdded(f);
	});

	for (const mode of ["tui", "rpc"] as const) test(`command_permissions: ${mode} ${decision} tardío tras abortar no ejecuta ni guarda`, async (t) => {
		const f = await commandFixture(t); Reflect.set(f.context, "mode", mode); const controller = new AbortController();
		f.uiControl.select = async (_title, options) => { controller.abort(); await Promise.resolve(); return option(options, decision); };
		await assert.rejects(f.check(COMMAND, controller.signal), /abort|cancel|no autorizado/i);
		assert.equal(authorizations(f).length, 1); assert.equal(saves(f).length, 0); assert.equal(f.foundationsScreens.length, 0); await noPermissionAdded(f);
	});

	test(`command_permissions: cerrar la sesión durante ${decision} invalida una selección posterior`, async (t) => {
		const f = await commandFixture(t);
		f.uiControl.select = async (_title, options) => { f.session.shutdown(); await Promise.resolve(); return option(options, decision); };
		await assert.rejects(f.check(), /abort|cancel|no autorizado|sesión/i);
		assert.equal(authorizations(f).length, 1); assert.equal(saves(f).length, 0); await noPermissionAdded(f);
	});

	test(`command_permissions: otra ventana pausa durante ${decision}; no guarda ni ejecuta estado viejo`, async (t) => {
		const f = await commandFixture(t);
		f.uiControl.select = async (_title, options) => {
			await f.action({ action: "pause", reason: "Pausado en otra ventana durante el diálogo" });
			return option(options, decision);
		};
		await assert.rejects(f.check(), /cambi|paus|vigente|retom|desactual/i);
		assert.equal(saves(f).length, 0); assert.equal(f.foundationsScreens.length, 0); await noPermissionAdded(f);
	});
}

test("command_permissions: grant exacto no autoriza prefijos, globs ni variantes compuestas", async (t) => {
	const f = await commandFixture(t); choose(f, "yes"); await f.check(); choose(f, "no");
	const variants = [`${COMMAND} --verbose`, `${COMMAND} && node test.cjs`, `${COMMAND}; node test.cjs`, 'node -e "process.exitCode = 0"'];
	for (const variant of variants) await assert.rejects(f.check(variant), /no autorizado|cancel/i);
	assert.equal(authorizations(f).length, variants.length + 1);
	assert.deepEqual(f.executed, [COMMAND]); assert.equal(saves(f).length, 0);
	assert.deepEqual((await f.state()).grants?.map((grant) => grant.command), [COMMAND]);
	const blocked = await f.emit("tool_call", { toolName: "bash", toolCallId: "sensitive", input: { command: "gh pr merge" } });
	assert.equal(!!blocked && typeof blocked === "object" && "block" in blocked && blocked.block, true, "las guardas independientes prevalecen");
});

test("command_permissions: grant sobrevive reload/resume y replan sin escribir KB", async (t) => {
	const f = await commandFixture(t); choose(f, "yes"); await f.check();
	await f.attach(); await f.command("resume"); choose(f, "no");
	await f.invoke("omi_workflow_check", { kind: "setup", command: COMMAND });
	assert.equal(authorizations(f).length, 1);
	const quote = "Sumá también que other.cjs devuelva 2";
	f.manager.appendMessage({ role: "user", content: quote, timestamp: Date.now() });
	await f.action({ action: "agreed", quote, agreement: "Ampliar el alcance a other.cjs", replan: true });
	await f.action({ action: "planned", plan: f.plan() }); await f.action({ action: "approve" });
	await f.invoke("omi_workflow_check", { kind: "setup", command: COMMAND });
	assert.equal(authorizations(f).length, 1); assert.equal(saves(f).length, 0);
	assert.deepEqual((await f.state()).grants?.map((grant) => grant.command), [COMMAND]);
	assert.ok(f.prompts.includes(AUTHORIZE));
});

for (const change of ["request", "refresh"] as const) test(`command_permissions: ${change} invalida el grant exacto durable`, async (t) => {
	const f = await commandFixture(t); choose(f, "yes"); await f.check();
	if (change === "request") { f.remote.body = "Otro pedido: devolver tres en vez de dos."; await f.command("resume"); }
	else { await f.command("resume"); await f.command("refresh"); }
	assert.deepEqual((await f.state()).grants ?? [], []);
	await f.session.restore(f.context, true); choose(f, "no");
	await assert.rejects(f.check(), /no autorizado|cancel/i);
	assert.equal(authorizations(f).length, 2); assert.deepEqual(f.executed, [COMMAND]); assert.equal(saves(f).length, 0);
});

test("command_permissions: lista vacía no autoriza sintaxis compuesta, pero sí simple no coincidente", async (t) => {
	const f = await commandFixture(t, { value: block([]) }); choose(f, "no");
	await f.check("npm test"); assert.deepEqual(f.executed, ["npm test"]); assert.equal(authorizations(f).length, 0);
	for (const command of ['echo "texto"', "npm test && git push origin main", "VAR=x npm test", "echo $(id)", "npm test\nnpm test"]) {
		await assert.rejects(f.check(command), /no autorizado|cancel/i);
	}
	assert.equal(authorizations(f).length, 5); assert.deepEqual(f.executed, ["npm test"]);
	assert.deepEqual((await f.state()).grants ?? [], []);
});

test("command_permissions: en 80×24 el detalle es navegable y conserva comando completo y decisiones", async (t) => {
	const f = await commandFixture(t); let mounted = false;
	const longCommand = `node -e '${"a".repeat(1800)}' FIN-DEL-COMANDO`;
	f.context.ui.custom = async (factory) => {
		mounted = true; let decision: unknown; let doneCalls = 0;
		const component = await factory(fakeTui({ columns: 80, rows: 24 }), darkTheme(), { matches: () => false } as never, (result) => { doneCalls++; decision = result; });
		const pages: string[] = [];
		for (let page = 0; page < 100; page++) {
			const lines = component.render(80);
			assert.ok(lines.length <= 16); assert.ok(lines.every((line) => visibleWidth(line) <= 80));
			const screen = lines.map(stripTerminalSequences).join("\n"); pages.push(screen);
			assert.match(screen, /Sí/); assert.match(screen, /No/); assert.match(screen, /Editar reglas/);
			component.handleInput?.("\x1b[6~");
		}
		const inspected = pages.join("\n");
		assert.match(inspected, /FIN-DEL-COMANDO/); assert.match(inspected, /Foundations/); assert.match(inspected, /producto repo/);
		assert.equal(doneCalls, 0, "navegar no cierra ni autoriza");
		component.handleInput?.("\x1b"); assert.equal(doneCalls, 1); assert.equal(decision, undefined);
		component.handleInput?.("\x1b"); assert.equal(doneCalls, 1);
		return decision as never;
	};
	await assert.rejects(f.check(longCommand), /no autorizado|cancel/i);
	assert.equal(mounted, true); assert.equal(saves(f).length, 0); await noPermissionAdded(f, longCommand);
});
