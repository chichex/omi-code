// Las decisiones humanas de autorización: TUI y RPC comparten select; ningún resultado tardío concede permiso.
import assert from "node:assert/strict";
import { test } from "node:test";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { darkTheme, fakeTui } from "./helpers/questions.ts";
import { commandAuthorization } from "../src/harness/authorization.ts";
import { parseFoundations } from "../src/harness/foundations.ts";
import { AUTHORIZE, COMMAND, REPO, accepted, authorizations, choose, commandFixture, noPermissionAdded, option, saves } from "./helpers/command-permissions.ts";

for (const mode of ["tui", "rpc"] as const) {
	test(`command_permissions: ${mode} ofrece tres decisiones y muestra comando, alcance y destino`, async (t) => {
		const f = await commandFixture(t); Reflect.set(f.context, "mode", mode); choose(f, "no");
		await assert.rejects(f.check(), /no autorizado|cancel/i);
		assert.equal(authorizations(f).length, 1, "no usa la confirmación binaria");
		const dialog = authorizations(f)[0]!;
		assert.equal(dialog.options.length, 3);
		for (const decision of ["yes", "no", "always"] as const) option(dialog.options, decision);
		const text = [dialog.title, ...dialog.options].join("\n");
		assert.ok(text.includes(COMMAND)); assert.ok(text.includes(f.checkout.root)); assert.ok(text.includes(REPO));
		assert.match(text, /Foundations/); assert.match(text, /KB/); assert.match(text, /perillas/);
		assert.match(text, /producto repo/); assert.ok(text.includes(new URL(f.kb.url).host));
		assert.match(text, /queda guardado para este trabajo/, "el sí conserva el alcance temporal que ya documentaba");
		assert.match(text, /(?:no |nunca )(?:autoriza|habilita).*(?:merge|deploy|secretos)/i, "no reemplaza decisiones sensibles de OMI");
		assert.equal(saves(f).length, 0); await noPermissionAdded(f);
	});

	test(`command_permissions: ${mode} Sí guarda sólo el grant del trabajo y no escribe en la KB`, async (t) => {
		const f = await commandFixture(t); Reflect.set(f.context, "mode", mode); choose(f, "yes");
		const previous = await accepted(f);
		await f.check(); await f.check();
		assert.deepEqual(f.executed, [COMMAND, COMMAND]); assert.equal(authorizations(f).length, 1);
		const state = await f.state();
		assert.deepEqual(state.grants?.map((grant) => grant.command), [COMMAND]);
		assert.equal(saves(f).length, 0); assert.deepEqual(await accepted(f), previous);
		assert.equal(commandAuthorization({ ...state, id: "otro-trabajo" }, COMMAND), "ask", "el sí no se extiende al siguiente trabajo");
	});

	test(`command_permissions: ${mode} No y cerrar no ejecutan ni guardan, y permiten volver a preguntar`, async (t) => {
		for (const decision of ["no", "cancel"] as const) {
			const f = await commandFixture(t); Reflect.set(f.context, "mode", mode); choose(f, decision);
			const previous = await accepted(f);
			await assert.rejects(f.check(), /no autorizado|cancel/i);
			await noPermissionAdded(f); assert.equal(saves(f).length, 0); assert.deepEqual(await accepted(f), previous);
			assert.equal(authorizations(f).length, 1, decision);
			choose(f, "yes"); await f.check();
			assert.deepEqual(f.executed, [COMMAND]); assert.equal(authorizations(f).length, 2, "cancelar no dejó un permiso escondido");
		}
	});

	test(`command_permissions: ${mode} siempre guarda inmediato, acepta y actualiza el pin sin grant temporal`, async (t) => {
		const f = await commandFixture(t); Reflect.set(f.context, "mode", mode); choose(f, "always");
		await f.check();
		assert.deepEqual(f.executed, [COMMAND]); assert.equal(saves(f).length, 1, "guardó antes de terminar la decisión, no al cerrar el trabajo");
		const stored = f.kb.documents.at(-1)!;
		const parsed = parseFoundations(stored.cuerpo, REPO);
		assert.equal(parsed.status, "valid");
		assert.ok(parsed.status === "valid" && parsed.block.comandos.includes(COMMAND));
		assert.equal((await accepted(f))?.accepted?.docId, stored.id);
		assert.equal(f.session.foundations.current(f.context)?.docId, stored.id);
		assert.deepEqual((await f.state()).grants ?? [], [], "el catálogo no se duplica en la lista de grants");
		choose(f, "no"); await f.check();
		assert.deepEqual(f.executed, [COMMAND, COMMAND]); assert.equal(authorizations(f).length, 1, "el pin nuevo ya vale en esta sesión");
		assert.equal(saves(f).length, 1);
		assert.deepEqual((await f.state()).evidence, [], "setup sigue sin acreditar pruebas");
		const event = { systemPromptOptions: { sections: {} as Record<string, string> } };
		await f.emit("before_agent_start", event);
		assert.ok(event.systemPromptOptions.sections.omi_development?.includes(JSON.stringify(COMMAND)), "el modelo ve el catálogo actualizado como datos");
	});
}

test("command_permissions: sin UI no pregunta, no ejecuta y no concede permisos", async (t) => {
	const f = await commandFixture(t); Reflect.set(f.context, "hasUI", false); choose(f, "always");
	await assert.rejects(f.check(), /interactiv|humana|UI/i);
	assert.equal(authorizations(f).length, 0); assert.equal(saves(f).length, 0); await noPermissionAdded(f);
});

test("command_permissions: un error de select falla cerrado sin fallback al confirm binario", async (t) => {
	const f = await commandFixture(t); f.uiControl.select = () => { throw new Error("selector fallido"); };
	await assert.rejects(f.check(), /selector fallido/);
	assert.equal(authorizations(f).length, 1); assert.equal(saves(f).length, 0); await noPermissionAdded(f);
});

for (const decision of ["yes", "always"] as const) {
	test(`command_permissions: abortar antes de mostrar ${decision} no abre UI ni guarda`, async (t) => {
		const f = await commandFixture(t); choose(f, decision); const controller = new AbortController(); controller.abort();
		await assert.rejects(f.check(COMMAND, controller.signal), /abort|cancel/i);
		assert.equal(authorizations(f).length, 0); assert.equal(saves(f).length, 0); await noPermissionAdded(f);
	});

	for (const mode of ["tui", "rpc"] as const) test(`command_permissions: ${mode} una selección ${decision} tardía tras abortar no ejecuta ni guarda`, async (t) => {
		const f = await commandFixture(t); Reflect.set(f.context, "mode", mode); const controller = new AbortController();
		f.uiControl.select = async (_title, options) => { controller.abort(); await Promise.resolve(); return option(options, decision); };
		await assert.rejects(f.check(COMMAND, controller.signal), /abort|cancel|no autorizado/i);
		assert.equal(authorizations(f).length, 1); assert.equal(saves(f).length, 0); await noPermissionAdded(f);
	});

	test(`command_permissions: cerrar la sesión durante ${decision} invalida incluso una selección posterior`, async (t) => {
		const f = await commandFixture(t);
		f.uiControl.select = async (_title, options) => { f.session.shutdown(); await Promise.resolve(); return option(options, decision); };
		await assert.rejects(f.check(), /abort|cancel|no autorizado|sesión/i);
		assert.equal(authorizations(f).length, 1); assert.equal(saves(f).length, 0); await noPermissionAdded(f);
	});
}

test("command_permissions: el permiso permanente es exacto, no un prefijo, comodín ni shell global", async (t) => {
	const f = await commandFixture(t); choose(f, "always"); await f.check(); choose(f, "no");
	const variants = [`${COMMAND} --verbose`, `${COMMAND} && node test.cjs`, `${COMMAND}; node test.cjs`, "node -e \"process.exitCode = 0\"", "node other-test.cjs"];
	for (const variant of variants) await assert.rejects(f.check(variant), /no autorizado|cancel/i);
	assert.equal(authorizations(f).length, variants.length + 1);
	assert.deepEqual(f.executed, [COMMAND]); assert.equal(saves(f).length, 1);
	assert.deepEqual((await f.state()).grants ?? [], []);
	const blocked = await f.emit("tool_call", { toolName: "bash", toolCallId: "sensitive", input: { command: "gh pr merge" } });
	assert.equal(!!blocked && typeof blocked === "object" && "block" in blocked && blocked.block, true, "no salta las guardas del harness");
});

test("command_permissions: recargar y retomar conserva el permiso permanente en el catálogo, no por un grant", async (t) => {
	const f = await commandFixture(t); choose(f, "always"); await f.check();
	await f.attach(); await f.command("resume"); choose(f, "no");
	await f.invoke("omi_workflow_check", { kind: "setup", command: COMMAND });
	assert.equal(authorizations(f).length, 1); assert.equal(saves(f).length, 1);
	assert.deepEqual((await f.state()).grants ?? [], []);
	assert.ok(f.prompts.includes(AUTHORIZE), "la instrumentación mantiene visibles los contadores existentes");
});

for (const decision of ["yes", "always"] as const) test(`command_permissions: otra ventana pausa el trabajo durante ${decision}; no guarda ni ejecuta desde el estado viejo`, async (t) => {
	const f = await commandFixture(t);
	f.uiControl.select = async (_title, options) => {
		await f.action({ action: "pause", reason: "Pausado en otra ventana durante el diálogo" });
		return option(options, decision);
	};
	await assert.rejects(f.check(), /cambi|paus|vigente|retom|desactual/i);
	assert.equal(saves(f).length, 0); await noPermissionAdded(f);
});

test("command_permissions: un cambio durable durante el guardado impide ejecutar y reemplazar el pin", async (t) => {
	const f = await commandFixture(t); choose(f, "always");
	const save = f.kb.save.bind(f.kb);
	f.kb.save = async (input, signal) => {
		const result = await save(input, signal);
		await f.action({ action: "pause", reason: "Otra ventana pausó mientras guardaba" });
		return result;
	};
	await assert.rejects(f.check(), /cambi|paus|vigente|retom|desactual/i);
	assert.deepEqual(f.executed, []); assert.deepEqual((await f.state()).grants ?? [], []);
	assert.ok(!f.session.foundations.current(f.context)?.block?.comandos.includes(COMMAND));
});

test("command_permissions: abortar tras un envío a la KB no reintenta ni acepta localmente", async (t) => {
	const f = await commandFixture(t); choose(f, "always"); const controller = new AbortController();
	const save = f.kb.save.bind(f.kb);
	f.kb.save = async (input, signal) => {
		await save(input, signal); controller.abort(); throw new Error("respuesta perdida después del aborto");
	};
	await assert.rejects(f.check(COMMAND, controller.signal), /abort|cancel|confirm|KB/i);
	assert.equal(saves(f).length, 1, "no reintenta una escritura después de cancelar");
	await noPermissionAdded(f);
});

for (const failure of ["pause", "abort"] as const) test(`command_permissions: ${failure} después de aceptar localmente informa que el permiso sí quedó persistido`, async (t) => {
	const f = await commandFixture(t); choose(f, "always"); const controller = new AbortController(); let injected = false;
	const assertCurrent = f.session.assertUnchanged.bind(f.session);
	f.session.assertUnchanged = async (state, ctx) => {
		if (!injected && (await accepted(f))?.accepted?.block.comandos.includes(COMMAND)) {
			injected = true;
			if (failure === "pause") await f.action({ action: "pause", reason: "Otra ventana pausó tras la aceptación local" });
			else controller.abort();
		}
		await assertCurrent(state, ctx);
	};
	await assert.rejects(f.check(COMMAND, controller.signal), /guardado.*KB.*aceptado.*no se ejecut/is);
	assert.equal(injected, true); assert.deepEqual(f.executed, []);
	assert.ok((await accepted(f))?.accepted?.block.comandos.includes(COMMAND));
	assert.deepEqual((await f.state()).grants ?? [], []);
});

test("command_permissions: en 80×24 el permiso tiene detalle navegable sin ocultar decisiones ni truncar el comando", async (t) => {
	const f = await commandFixture(t); choose(f, "always"); let mounted = false;
	const longCommand = `node -e '${"a".repeat(1800)}' FIN-DEL-COMANDO`;
	f.context.ui.custom = async (factory) => {
		mounted = true; let decision: unknown;
		const size = { columns: 80, rows: 24 };
		const component = await factory(fakeTui(size), darkTheme(), { matches: () => false } as never, (result) => { decision = result; });
		const pages: string[] = [];
		for (let page = 0; page < 100; page++) {
			const lines = component.render(80);
			assert.ok(lines.length <= 16, "respeta el lugar del editor y las filas reservadas del workspace");
			assert.ok(lines.every((line) => visibleWidth(line) <= 80));
			const screen = lines.map(stripTerminalSequences).join("\n"); pages.push(screen);
			assert.match(screen, /Sí/); assert.match(screen, /No/); assert.match(screen, /Permitir siempre en este proyecto/);
			component.handleInput?.("\x1b[6~");
		}
		const inspected = pages.join("\n");
		assert.match(inspected, /FIN-DEL-COMANDO/); assert.match(inspected, /Foundations/); assert.match(inspected, /producto repo/);
		component.handleInput?.("\x1b");
		assert.equal(decision, undefined, "Esc cancela el permiso");
		return decision as never;
	};
	await assert.rejects(f.check(longCommand), /no autorizado|cancel/i);
	assert.equal(mounted, true, "no usa un título estático que excede la terminal");
	assert.equal(saves(f).length, 0); await noPermissionAdded(f, longCommand);
});
