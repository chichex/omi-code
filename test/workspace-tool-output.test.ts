import assert from "node:assert/strict";
import { test } from "node:test";
import { ToolExecutionComponent, type Theme } from "@earendil-works/pi-coding-agent";
import { Container, Text, stripTerminalSequences, visibleWidth, type TUI, type TuiMouseEvent } from "@earendil-works/pi-tui";
import { getThemeByName, setThemeInstance } from "../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js";
import { withBuiltInRenderers } from "../node_modules/@earendil-works/pi-coding-agent/dist/core/tools/renderers/index.js";
import { CompactTranscript } from "../src/tui/workspace/tool-output.ts";

function harness() {
	let theme = getThemeByName("dark")!; setThemeInstance(theme); let renders = 0;
	const chat = new Container(); const ui = { requestRender() { renders++; } } as unknown as TUI;
	const transcript = new CompactTranscript(chat, ToolExecutionComponent, () => theme, () => ui.requestRender());
	const tool = (name: string, args: unknown = {}, completed = true) => {
		const component = new ToolExecutionComponent(name, `id-${chat.children.length}`, args, { showImages: false }, withBuiltInRenderers(name, undefined), ui, "/repo");
		chat.addChild(component);
		if (completed) { component.setArgsComplete(); component.markExecutionStarted(); component.updateResult({ content: [{ type: "text", text: "PRIVATE_OUTPUT" }], isError: false }); }
		return component;
	};
	return { chat, transcript, tool, renders: () => renders, theme: () => theme, setTheme(value: Theme) { theme = value; setThemeInstance(value); }, plain(width = 90) { return transcript.render(width).map(stripTerminalSequences).join("\n"); }, click(y: number, width = 90, button = "left") { return transcript.handleMouse({ type: "click", x: 3, y, width, height: 100, button } as TuiMouseEvent); } };
}

test("tool output: agrupa comandos consecutivos en una sola fila gris, sin output ni argumentos", () => {
	const h = harness(); h.tool("bash", { command: "COMMAND_ONE" }); h.tool("bash", { command: "COMMAND_TWO" }); h.tool("bash", { command: "COMMAND_THREE" });
	const lines = h.transcript.render(90); const plain = lines.map(stripTerminalSequences).join("\n");
	assert.match(plain, /Ran 3 shell commands/); assert.doesNotMatch(plain, /PRIVATE_OUTPUT|COMMAND_|bash/);
	assert.equal(lines.filter((line) => stripTerminalSequences(line).trim()).length, 1);
	assert.ok(lines.some((line) => line.includes(h.theme().getFgAnsi("muted"))));
	assert.equal(h.chat.children.length, 3, "no reemplaza ni elimina las herramientas originales de Pi");
});

test("tool output: cuenta archivos distintos, separa lectura, edición, escritura y búsqueda", () => {
	const h = harness(); h.tool("read", { path: "a.ts", offset: 1 }); h.tool("read", { path: "/repo/a.ts", offset: 40 }); h.tool("read", { path: "b.ts" });
	h.tool("edit", { path: "a.ts", oldText: "old", newText: "new" }); h.tool("edit", { path: "a.ts", oldText: "new", newText: "next" });
	h.tool("write", { path: "c.ts", content: "new" }); h.tool("write", { path: "d.ts", content: "new" });
	h.tool("grep", { pattern: "needle", path: "." }); h.tool("find", { pattern: "*.ts" }); h.tool("ls", { path: "." });
	const plain = h.plain();
	assert.match(plain, /Read 2 files/); assert.match(plain, /Edited 1 file/); assert.match(plain, /Wrote 2 files/); assert.match(plain, /Ran 3 searches/);
	assert.equal(plain.match(/Read /g)?.length, 1); assert.doesNotMatch(plain, /PRIVATE_OUTPUT/);
});

test("tool output: diferencia argumentos en streaming, ejecución parcial y finalización real", () => {
	const h = harness(); const first = h.tool("bash", { command: "echo streamed" }, false);
	assert.match(h.plain(), /Preparing 1 shell command/); assert.doesNotMatch(h.plain(), /Ran 1/);
	first.markExecutionStarted(); first.updateResult({ content: [{ type: "text", text: "PARTIAL_SECRET" }], isError: false }, true);
	assert.match(h.plain(), /Running 1 shell command/); assert.doesNotMatch(h.plain(), /PARTIAL_SECRET|Ran 1/);
	first.updateResult({ content: [{ type: "text", text: "DONE_SECRET" }], isError: false });
	const second = h.tool("bash", { command: "echo second" }, false); second.markExecutionStarted();
	assert.match(h.plain(), /Running 2 shell commands.*1\/2/); assert.doesNotMatch(h.plain(), /Ran 2/);
	second.updateResult({ content: [], isError: false }); assert.match(h.plain(), /Ran 2 shell commands/);
});

test("tool output: errores, cancelaciones e imágenes conservan el renderer original visible", () => {
	const h = harness(); h.tool("bash", { command: "ok" }); const failed = h.tool("bash", { command: "fail" });
	failed.updateResult({ content: [{ type: "text", text: "ERROR_VISIBLE exit code 1" }], isError: true });
	const image = h.tool("read", { path: "picture.png" }); image.updateResult({ content: [{ type: "text", text: "IMAGE_VISIBLE" }, { type: "image", data: "", mimeType: "image/png" }], isError: false }); image.setExpanded(true);
	const cancelled = h.tool("edit", { path: "bad.ts", oldText: "a", newText: "b" }); cancelled.updateResult({ content: [{ type: "text", text: "Operation aborted" }], isError: true });
	const plain = h.plain(); assert.match(plain, /Ran 1 shell command/); assert.match(plain, /ERROR_VISIBLE/); assert.match(plain, /IMAGE_VISIBLE/); assert.match(plain, /Operation aborted/);
	assert.doesNotMatch(plain, /Ran 2 shell commands|Read 1 file|Edited 1 file/);
});

test("tool output: texto de assistant, usuario, diagnósticos y herramientas ajenas no se reordenan", () => {
	const h = harness(); h.chat.addChild(new Text("USER_VISIBLE", 0, 0)); h.tool("read", { path: "a" }); h.chat.addChild(new Container()); h.tool("read", { path: "b" });
	h.chat.addChild(new Text("ASSISTANT_VISIBLE", 0, 0)); h.tool("read", { path: "c" }); h.chat.addChild(new Text("DIAGNOSTIC_VISIBLE", 0, 0));
	h.tool("omi_project_status"); h.tool("omi_project_status"); h.tool("other_tool");
	const plain = h.plain(); assert.match(plain, /USER_VISIBLE[\s\S]*Read 2 files[\s\S]*ASSISTANT_VISIBLE[\s\S]*Read 1 file[\s\S]*DIAGNOSTIC_VISIBLE[\s\S]*Used omi_project_status 2 times[\s\S]*Used other_tool 1 time/);
});

test("tool output: clic abre/cierra el grupo, Ctrl O nativo sigue mostrando el output completo", () => {
	const h = harness(); const first = h.tool("bash", { command: "COMMAND_ONE" }); const second = h.tool("bash", { command: "COMMAND_TWO" });
	const y = h.transcript.render(90).findIndex((line) => stripTerminalSequences(line).includes("Ran 2")); const before = h.renders();
	h.click(y); assert.match(h.plain(), /COMMAND_ONE/); assert.match(h.plain(), /COMMAND_TWO/); assert.match(h.plain(), /PRIVATE_OUTPUT/); assert.equal(h.renders() - before, 1);
	h.click(y); assert.doesNotMatch(h.plain(), /PRIVATE_OUTPUT/);
	first.setExpanded(true); second.setExpanded(true); assert.match(h.plain(), /PRIVATE_OUTPUT/);
	first.setExpanded(false); second.setExpanded(false); assert.doesNotMatch(h.plain(), /PRIVATE_OUTPUT/);
	h.click(y, 90, "right"); assert.doesNotMatch(h.plain(), /PRIVATE_OUTPUT/);
	assert.equal(h.transcript.handleMouse({ type: "wheel", x: 1, y, width: 90, height: 20, wheelDelta: 1 } as TuiMouseEvent), undefined);
});

test("tool output: truncamiento sigue advertido y se conserva todo el detalle original", () => {
	const h = harness(); const component = h.tool("bash", { command: "long command" });
	component.updateResult({ content: [{ type: "text", text: "ORIGINAL_TRUNCATION_NOTICE /tmp/full-output.txt" }], details: { truncation: { truncated: true, totalLines: 999, outputLines: 10 } }, isError: false });
	assert.match(h.plain(), /truncated/);
	component.setExpanded(true); assert.match(h.plain(), /ORIGINAL_TRUNCATION_NOTICE/); assert.match(h.plain(), /\/tmp\/full-output.txt/);
});

test("tool output: falla abierto ante cambios del contrato de Pi, temas y resizes no pierden datos", () => {
	const h = harness(); const native = h.tool("bash", { command: "ORIGINAL_VISIBLE" });
	Reflect.deleteProperty(native, "isPartial"); assert.match(h.plain(), /ORIGINAL_VISIBLE/); assert.match(h.plain(), /PRIVATE_OUTPUT/);
	const normal = harness(); normal.tool("read", { path: "漢字🙂\x1b\n" });
	for (const name of ["dark", "light"]) { normal.setTheme(getThemeByName(name)!); for (const width of [1, 8, 28, 80, 132]) assert.ok(normal.transcript.render(width).every((line) => visibleWidth(line) <= width)); }
	const incompatible = new CompactTranscript(new Text("FALLBACK_VISIBLE", 0, 0), ToolExecutionComponent, () => h.theme(), () => {});
	assert.match(incompatible.render(90).map(stripTerminalSequences).join("\n"), /FALLBACK_VISIBLE/);
});
