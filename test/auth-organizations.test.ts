import assert from "node:assert/strict";
import { test } from "node:test";
import { loadCredentials } from "../src/auth/credentials.ts";
import { run } from "../src/cli/main.ts";
import { credentialsPath } from "../src/core/paths.ts";
import { tempDir, testIo } from "./helpers/io.ts";
import { MOCK_EMAIL, MOCK_PASSWORD, startMockOmi } from "./helpers/mock-omi.ts";

for (const count of [0, 2]) {
	test(`login con ${count} organizaciones no elige una arbitraria e init explica cómo seguir`, async (t) => {
		const home = await tempDir(t);
		const omi = await startMockOmi(t);
		const organizations = count === 0 ? [] : [omi.organization, { ...omi.organization, slug: "beta", organization_id: "org_beta" }];
		const principal = { user_id: "u", name: "Ada", email: MOCK_EMAIL, organizations };
		omi.route("POST /api/v1/sessions", () => ({ status: 200, body: { ...principal, token: "prs_test", expires_at: "2026-12-01" } }));
		omi.route("GET /api/v1/me", () => ({ status: 200, body: principal }));
		const io = testIo({ homeDir: home, cwd: await tempDir(t), stdin: MOCK_PASSWORD });
		assert.equal(await run(["login", "--email", MOCK_EMAIL, "--password-stdin", "--api", omi.url], io), 0);
		assert.equal((await loadCredentials(credentialsPath(home)))?.defaultOrganizationSlug, "");
		assert.equal(await run(["init", "--project", "x", "--service", "api", "--create"], io), 1);
		assert.match(io.errors(), count === 0 ? /ninguna organización/ : /--org.*acme.*beta/);
		assert.equal(omi.requests.filter((r) => r.method === "POST" && r.path !== "/api/v1/sessions").length, 0);
	});
}
