import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import { test } from "node:test";
import { loadCredentials, saveCredentials } from "../src/auth/credentials.ts";
import { run } from "../src/cli/main.ts";
import { credentialsPath } from "../src/core/paths.ts";
import { tempDir, testIo } from "./helpers/io.ts";
import { MOCK_EMAIL, MOCK_PASSWORD, sessionCookie, startMockOmi, type MockOmi } from "./helpers/mock-omi.ts";

test("login_con --password-stdin guarda la sesión con modo 0600", async (t) => {
	const home = await tempDir(t);
	const omi = await startMockOmi(t);
	const io = testIo({ homeDir: home, stdin: `${MOCK_PASSWORD}\n` });

	const code = await run(["login", "--email", MOCK_EMAIL, "--password-stdin", "--api", omi.url], io);

	assert.equal(code, 0, io.errors());
	const path = credentialsPath(home);
	assert.equal((await stat(path)).mode & 0o777, 0o600);
	assert.deepEqual(JSON.parse(await readFile(path, "utf8")), {
		apiUrl: omi.url,
		token: "prs_1",
		expiresAt: "2026-11-12T00:00:00Z",
		user: { id: "usr_ada", name: "Ada", email: MOCK_EMAIL },
		defaultOrganizationSlug: "acme",
	});
	assert.deepEqual(omi.requests[0]?.body, { email: MOCK_EMAIL, password: MOCK_PASSWORD });
	assert.doesNotMatch(io.output() + io.errors(), /prs_1|correct horse/);
});

test("login_interactivo pide email y contraseña", async (t) => {
	const home = await tempDir(t);
	const omi = await startMockOmi(t);
	const io = testIo({ homeDir: home, interactive: true, answers: [MOCK_EMAIL, MOCK_PASSWORD], env: { OMI_API_URL: omi.url } });
	assert.equal(await run(["login"], io), 0, io.errors());
	assert.equal(io.prompts.length, 2);
	assert.equal((await loadCredentials(credentialsPath(home)))?.apiUrl, omi.url);
});

test("login_no interactivo sin --password-stdin es error de uso", async (t) => {
	const home = await tempDir(t);
	const io = testIo({ homeDir: home });
	assert.equal(await run(["login", "--email", MOCK_EMAIL], io), 2);
	assert.match(io.errors(), /--password-stdin/);
});

test("login_con credenciales inválidas sale con 1 y no guarda nada", async (t) => {
	const home = await tempDir(t);
	const omi = await startMockOmi(t);
	const io = testIo({ homeDir: home, stdin: "mala" });
	assert.equal(await run(["login", "--email", MOCK_EMAIL, "--password-stdin", "--api", omi.url], io), 1);
	assert.match(io.errors(), /email o contraseña incorrectos/);
	assert.equal(await loadCredentials(credentialsPath(home)), null);
});

test("login_pide el token de sesión con el header X-Omi-Session-Token", async (t) => {
	const home = await tempDir(t);
	const omi = await startMockOmi(t);
	const io = testIo({ homeDir: home, stdin: MOCK_PASSWORD });
	assert.equal(await run(["login", "--email", MOCK_EMAIL, "--password-stdin", "--api", omi.url], io), 0, io.errors());
	assert.equal(omi.requests[0]?.path, "/api/v1/sessions");
	assert.equal(omi.requests[0]?.sessionToken, "body");
	assert.equal((await loadCredentials(credentialsPath(home)))?.token, "prs_1");
});

test("login_el header del token no viaja en los demás pedidos", async (t) => {
	const { home, omi } = await loggedIn(t);
	assert.equal(await run(["whoami"], testIo({ homeDir: home })), 0);
	assert.equal(omi.requests.at(-1)?.path, "/api/v1/me");
	assert.equal(omi.requests.at(-1)?.sessionToken, undefined);
});

test("login_contra una API anterior, que entrega el token sin mirar el header, sigue funcionando", async (t) => {
	const home = await tempDir(t);
	const omi = await startMockOmi(t);
	omi.route("POST /api/v1/sessions", () => ({
		status: 200,
		body: { user_id: "usr_ada", name: "Ada", email: MOCK_EMAIL, organizations: [], token: "prs_vieja", expires_at: "2026-11-12T00:00:00Z" },
	}));
	const io = testIo({ homeDir: home, stdin: MOCK_PASSWORD });
	assert.equal(await run(["login", "--email", MOCK_EMAIL, "--password-stdin", "--api", omi.url], io), 0, io.errors());
	assert.equal((await loadCredentials(credentialsPath(home)))?.token, "prs_vieja");
});

test("login_contra una API que no entrega el token explica las causas posibles", async (t) => {
	const home = await tempDir(t);
	const omi = await startMockOmi(t);
	omi.route("POST /api/v1/sessions", () => ({
		status: 200,
		body: { user_id: "usr_ada", name: "Ada", email: MOCK_EMAIL, organizations: [], expires_at: "2026-11-12T00:00:00Z" },
	}));
	const io = testIo({ homeDir: home, stdin: MOCK_PASSWORD });
	assert.equal(await run(["login", "--email", MOCK_EMAIL, "--password-stdin", "--api", omi.url, "--json"], io), 1);
	const report = JSON.parse(io.errors()) as { error: { code: string; message: string; hint: string } };
	assert.equal(report.error.code, "session_token_unavailable");
	assert.match(report.error.message, /no entregó el token de sesión/);
	// Las dos causas reales: un intermediario que no reenvía el header, o una API anterior al Bearer.
	assert.match(report.error.hint, /X-Omi-Session-Token/);
	assert.match(report.error.hint, /chichex\/omi#140/);
	assert.equal(await loadCredentials(credentialsPath(home)), null);
	// Sin cookie en la respuesta no hay sesión que cerrar.
	assert.equal(omi.requests.length, 1);
});

/** La API abre la sesión y manda su cookie, pero el token no llega en el cuerpo. */
function openSessionWithoutToken(omi: MockOmi): void {
	omi.route("POST /api/v1/sessions", () => {
		omi.sessions.set("prs_huerfana", "active");
		return {
			status: 200,
			headers: { "Set-Cookie": sessionCookie("prs_huerfana") },
			body: { user_id: "usr_ada", name: "Ada", email: MOCK_EMAIL, organizations: [], expires_at: "2026-11-12T00:00:00Z" },
		};
	});
}

test("login_si la API abrió la sesión pero no entregó el token, la cierra con la cookie recibida", async (t) => {
	const home = await tempDir(t);
	const omi = await startMockOmi(t);
	openSessionWithoutToken(omi);
	const io = testIo({ homeDir: home, stdin: MOCK_PASSWORD });
	assert.equal(await run(["login", "--email", MOCK_EMAIL, "--password-stdin", "--api", omi.url, "--json"], io), 1);
	assert.equal((JSON.parse(io.errors()) as { error: { code: string } }).error.code, "session_token_unavailable");
	assert.equal(omi.sessions.size, 0);
	const last = omi.requests.at(-1);
	assert.equal(`${last?.method} ${last?.path}`, "DELETE /api/v1/sessions/current");
	assert.equal(last?.authorization, undefined);
	assert.doesNotMatch(io.output() + io.errors(), /prs_huerfana/);
	assert.equal(await loadCredentials(credentialsPath(home)), null);
});

test("login_si no puede cerrar la sesión sin token, reporta igual el error del login", async (t) => {
	const home = await tempDir(t);
	const omi = await startMockOmi(t);
	openSessionWithoutToken(omi);
	omi.route("DELETE /api/v1/sessions/current", () => ({ status: 500, body: { error: { code: "internal_error", message: "falló el cierre" } } }));
	const io = testIo({ homeDir: home, stdin: MOCK_PASSWORD });
	assert.equal(await run(["login", "--email", MOCK_EMAIL, "--password-stdin", "--api", omi.url, "--json"], io), 1);
	const report = JSON.parse(io.errors()) as { error: { code: string } };
	assert.equal(report.error.code, "session_token_unavailable");
	assert.equal(`${omi.requests.at(-1)?.method} ${omi.requests.at(-1)?.path}`, "DELETE /api/v1/sessions/current");
	assert.doesNotMatch(io.errors(), /falló el cierre|internal_error/);
});

for (const [name, retryAfter, wait] of [
	["segundos", "30", /esperá 30 segundos/],
	["un segundo", "1", /esperá 1 segundo /],
	["minutos, redondeados hacia arriba", "61", /esperá 2 minutos/],
	["el tope de la API", "900", /esperá 15 minutos/],
] as const) {
	test(`login_ante un 429 muestra el mensaje de la API y la espera en ${name}`, async (t) => {
		const home = await tempDir(t);
		const omi = await startMockOmi(t);
		omi.route("POST /api/v1/sessions", () => ({
			status: 429,
			headers: { "Retry-After": retryAfter },
			body: { error: { code: "login_rate_limited", message: "demasiados intentos fallidos" } },
		}));
		const io = testIo({ homeDir: home, stdin: MOCK_PASSWORD });
		assert.equal(await run(["login", "--email", MOCK_EMAIL, "--password-stdin", "--api", omi.url, "--json"], io), 1);
		const report = JSON.parse(io.errors()) as { error: { code: string; message: string; hint?: string } };
		assert.equal(report.error.code, "login_rate_limited");
		assert.equal(report.error.message, "demasiados intentos fallidos");
		assert.match(report.error.hint ?? "", wait);
		assert.equal(await loadCredentials(credentialsPath(home)), null);
	});
}

for (const [name, headers] of [
	["sin Retry-After", {}],
	["con un Retry-After que no es un número de segundos", { "Retry-After": "Wed, 21 Oct 2026 07:28:00 GMT" }],
] as const) {
	test(`login_ante un 429 ${name} muestra el mensaje sin inventar una espera`, async (t) => {
		const home = await tempDir(t);
		const omi = await startMockOmi(t);
		omi.route("POST /api/v1/sessions", () => ({
			status: 429,
			headers,
			body: { error: { code: "login_rate_limited", message: "demasiados intentos fallidos" } },
		}));
		const io = testIo({ homeDir: home, stdin: MOCK_PASSWORD });
		assert.equal(await run(["login", "--email", MOCK_EMAIL, "--password-stdin", "--api", omi.url], io), 1);
		assert.match(io.errors(), /demasiados intentos fallidos/);
		assert.doesNotMatch(io.errors(), /esperá/);
	});
}

test("login_ante un 429 de un intermediario, con cuerpo que no es JSON, igual muestra la espera", async (t) => {
	const home = await tempDir(t);
	const omi = await startMockOmi(t);
	omi.route("POST /api/v1/sessions", () => ({
		status: 429,
		headers: { "Retry-After": "30", "Content-Type": "text/html" },
		text: "<html><body><h1>429 Too Many Requests</h1></body></html>",
	}));
	const io = testIo({ homeDir: home, stdin: MOCK_PASSWORD });
	assert.equal(await run(["login", "--email", MOCK_EMAIL, "--password-stdin", "--api", omi.url, "--json"], io), 1);
	const report = JSON.parse(io.errors()) as { error: { code: string; message: string; hint?: string } };
	assert.equal(report.error.code, "unexpected_response");
	assert.match(report.error.message, /429/);
	assert.equal(report.error.hint, "esperá 30 segundos antes de volver a intentar");
});

for (const [name, retryAfter, hint] of [
	["de una hora justa se muestra en minutos", "3600", "esperá 60 minutos antes de volver a intentar"],
	["de más de una hora no se convierte a minutos", "3601", "esperá más de una hora antes de volver a intentar"],
	["absurdo no se muestra como número", "100000000000000000000", "esperá más de una hora antes de volver a intentar"],
] as const) {
	test(`login_ante un 429 un Retry-After ${name}`, async (t) => {
		const home = await tempDir(t);
		const omi = await startMockOmi(t);
		omi.route("POST /api/v1/sessions", () => ({
			status: 429,
			headers: { "Retry-After": retryAfter },
			body: { error: { code: "login_rate_limited", message: "demasiados intentos fallidos" } },
		}));
		const io = testIo({ homeDir: home, stdin: MOCK_PASSWORD });
		assert.equal(await run(["login", "--email", MOCK_EMAIL, "--password-stdin", "--api", omi.url, "--json"], io), 1);
		const report = JSON.parse(io.errors()) as { error: { hint?: string } };
		assert.equal(report.error.hint, hint);
	});
}

async function loggedIn(t: Parameters<typeof tempDir>[0]) {
	const home = await tempDir(t);
	const omi = await startMockOmi(t);
	const io = testIo({ homeDir: home, stdin: MOCK_PASSWORD });
	assert.equal(await run(["login", "--email", MOCK_EMAIL, "--password-stdin", "--api", omi.url], io), 0, io.errors());
	return { home, omi };
}

test("whoami_valida la sesión con Authorization Bearer", async (t) => {
	const { home, omi } = await loggedIn(t);
	const io = testIo({ homeDir: home });
	assert.equal(await run(["whoami"], io), 0, io.errors());
	assert.match(io.output(), /Ada/);
	assert.match(io.output(), /acme/);
	assert.equal(omi.requests.at(-1)?.authorization, "Bearer prs_1");
	assert.equal(omi.requests.at(-1)?.path, "/api/v1/me");
});

test("whoami --json_no expone el token", async (t) => {
	const { home } = await loggedIn(t);
	const io = testIo({ homeDir: home });
	assert.equal(await run(["whoami", "--json"], io), 0, io.errors());
	const output = JSON.parse(io.output()) as { email: string; organizations: { slug: string }[] };
	assert.equal(output.email, MOCK_EMAIL);
	assert.equal(output.organizations[0]?.slug, "acme");
	assert.doesNotMatch(io.output(), /prs_/);
});

for (const [name, code, status] of [
	["una sesión vencida", "session_expired", "expired"],
	["un token desconocido", "authentication_required", undefined],
] as const) {
	test(`whoami_ante ${name} indica correr omi login`, async (t) => {
		const { home, omi } = await loggedIn(t);
		if (status === undefined) omi.sessions.clear();
		else omi.sessions.set("prs_1", status);
		const io = testIo({ homeDir: home });
		assert.equal(await run(["whoami", "--json"], io), 1);
		const report = JSON.parse(io.errors()) as { error: { code: string; hint: string } };
		assert.equal(report.error.code, code);
		assert.match(report.error.hint, /omi login/);
	});
}

test("whoami_sin sesión guardada indica correr omi login", async (t) => {
	const home = await tempDir(t);
	const io = testIo({ homeDir: home });
	assert.equal(await run(["whoami"], io), 1);
	assert.match(io.errors(), /omi login/);
});

test("logout_revoca la sesión con Bearer y borra las credenciales", async (t) => {
	const { home, omi } = await loggedIn(t);
	const io = testIo({ homeDir: home });
	assert.equal(await run(["logout"], io), 0, io.errors());
	const last = omi.requests.at(-1);
	assert.equal(`${last?.method} ${last?.path}`, "DELETE /api/v1/sessions/current");
	assert.equal(last?.authorization, "Bearer prs_1");
	assert.equal(omi.sessions.size, 0);
	assert.equal(await loadCredentials(credentialsPath(home)), null);
});

test("logout_conserva las credenciales si no pudo revocar", async (t) => {
	const home = await tempDir(t);
	const path = credentialsPath(home);
	await saveCredentials(path, {
		apiUrl: "http://127.0.0.1:9",
		token: "prs_x",
		expiresAt: "2026-11-12T00:00:00Z",
		user: { id: "u", name: "n", email: "e" },
		defaultOrganizationSlug: "acme",
	});
	const io = testIo({ homeDir: home });
	assert.equal(await run(["logout"], io), 1);
	assert.notEqual(await loadCredentials(path), null);
});

for (const command of ["whoami", "logout", "init"]) {
	for (const source of ["env", "flag"]) {
		test(`${command}_no envía el token a una API distinta por ${source}`, async (t) => {
			const { home, omi } = await loggedIn(t);
			const other = await startMockOmi(t);
			const io = testIo({ homeDir: home, env: source === "env" ? { OMI_API_URL: other.url } : {} });
			const args = command === "init" ? [command, "--project", "x", "--service", "api", "--create"] : [command];
			if (source === "flag") args.push("--api", other.url);
			args.push("--json");
			assert.equal(await run(args, io), 1);
			assert.match(io.errors(), /api_url_mismatch/);
			assert.deepEqual(other.requests, []);
			assert.equal(omi.sessions.get("prs_1"), "active");
			assert.notEqual(await loadCredentials(credentialsPath(home)), null);
		});
	}
}

test("whoami_acepta la URL guardada con barra final", async (t) => {
	const { home, omi } = await loggedIn(t);
	assert.equal(await run(["whoami", "--api", `${omi.url}/`], testIo({ homeDir: home })), 0);
});

test("logout_sin sesión no falla", async (t) => {
	const home = await tempDir(t);
	assert.equal(await run(["logout"], testIo({ homeDir: home })), 0);
});
