import { test } from "node:test";
import assert from "node:assert/strict";
import { parseIssueBody, withIssueSection, SECTION_START, SECTION_END } from "../src/harness/issue-section.ts";

const block = (content: string) => `${SECTION_START}\n${content}\n${SECTION_END}`;

test("the human text above the managed section comes back byte for byte", () => {
	for (const human of ["Pedido\n", "Pedido", "", "Línea 1\r\nLínea 2\r\n", "Termina con espacios   ", "Dos saltos\n\n", "`<!-- omi:harness:start -->` citado en línea"]) {
		const body = withIssueSection(human, parseIssueBody(human), "## Harness · #7");
		const parts = parseIssueBody(body);
		assert.equal(parts.human, human, JSON.stringify(human));
		assert.equal(parts.section, "\n## Harness · #7\n");
		assert.ok(body.startsWith(human), "el pedido queda arriba, intacto");
		assert.ok(body.endsWith(SECTION_END));
	}
});

test("rewriting replaces only what is between the markers, including human text added below", () => {
	const first = withIssueSection("Pedido\n", parseIssueBody("Pedido\n"), "vieja");
	const edited = `${first}\n\nNota humana debajo\n`;
	const second = withIssueSection(edited, parseIssueBody(edited), "nueva");
	assert.equal(second, `Pedido\n\n\n${block("nueva")}\n\nNota humana debajo\n`);
	assert.equal(parseIssueBody(second).human, "Pedido\n\n\nNota humana debajo\n");
	assert.equal(parseIssueBody(second).human, parseIssueBody(edited).human, "reescribir la sección no cambia el pedido");
});

test("only markers alone on their own line count; mentions in the request are human text", () => {
	for (const body of ["Usar `<!-- omi:harness:start -->` y `<!-- omi:harness:end -->`", "texto <!-- omi:harness:start -->\nmás <!-- omi:harness:end -->", "  <!-- omi:harness:start -->\n  <!-- omi:harness:end -->"]) {
		const parts = parseIssueBody(body);
		assert.equal(parts.human, body); assert.equal(parts.section, null);
	}
});

test("duplicate, unpaired, reversed or unknown markers are refused instead of guessed", () => {
	const good = block("x");
	for (const body of [SECTION_START, SECTION_END, `${good}\n${good}`, `${SECTION_END}\n${SECTION_START}`, `${SECTION_START}\n${SECTION_START}\n${SECTION_END}`, "<!-- omi:harness:otro -->", `${SECTION_START} extra\n${SECTION_END}`, `<!--omi:harness:start-->\n${SECTION_END}`]) {
		assert.throws(() => parseIssueBody(`Pedido\n\n${body}`), /marcadores/i, JSON.stringify(body));
	}
	// Un cuerpo editado en la web vuelve con CRLF: la sección se sigue reconociendo y reescribirla no cambia el pedido.
	const web = `Pedido\r\n\r\n${SECTION_START}\r\nx\r\n${SECTION_END}\r\nNota\r\n`; const parts = parseIssueBody(web);
	assert.notEqual(parts.section, null); assert.ok(parts.human.includes("Nota"));
	assert.equal(parseIssueBody(withIssueSection(web, parts, "nueva")).human, parts.human);
});
