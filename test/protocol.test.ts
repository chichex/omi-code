import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import * as protocol from "../src/protocol/constants.ts";

const source = readFileSync(new URL("../src/protocol/constants.ts", import.meta.url), "utf8");
const omiRepo = process.env.OMI_REPO;

test("protocolo_no arrastra nombres legacy de prama", () => {
	assert.doesNotMatch(source, /prama/i);
});

test("protocolo_define la URL y el override de la API", () => {
	assert.equal(protocol.DEFAULT_API_URL, "https://app.ohmyinfra.com");
	assert.equal(protocol.API_URL_ENV, "OMI_API_URL");
});

test("protocolo_define variables, headers y archivos", () => {
	assert.deepEqual(
		{
			env: [protocol.ENV_PORT, protocol.ENV_OMI_ENVIRONMENT, protocol.ENV_OMI_VERSION, protocol.RESERVED_ENV_PREFIX],
			ci: protocol.CI_REGISTRY_SECRET,
			trigger: protocol.ENV_TRIGGER_SECRET,
			headers: [protocol.HEADER_JOB, protocol.HEADER_SCHEDULED_AT, protocol.HEADER_ATTEMPT, protocol.HEADER_TIMESTAMP, protocol.HEADER_SIGNATURE],
			files: [protocol.PROJECT_LINK_FILE, protocol.OMI_HOME_DIR, protocol.CREDENTIALS_FILE],
		},
		{
			env: ["PORT", "OMI_ENVIRONMENT", "OMI_VERSION", "OMI_"],
			ci: "OMI_REGISTRY_PASSWORD",
			trigger: "OMI_TRIGGER_SECRET",
			headers: ["X-Omi-Job", "X-Omi-Scheduled-At", "X-Omi-Attempt", "X-Omi-Timestamp", "X-Omi-Signature"],
			files: [".omi/project.json", ".omi", "credentials.json"],
		},
	);
});

// Sólo corre con un checkout de chichex/omi: `OMI_REPO=../omi npm test`.
test("protocolo_coincide con el código de chichex/omi", { skip: omiRepo === undefined || !existsSync(join(omiRepo, "trigger/trigger.go")) }, () => {
	const read = (path: string): string => readFileSync(join(omiRepo ?? "", path), "utf8");
	const trigger = read("trigger/trigger.go");
	for (const header of [protocol.HEADER_JOB, protocol.HEADER_SCHEDULED_AT, protocol.HEADER_ATTEMPT, protocol.HEADER_TIMESTAMP, protocol.HEADER_SIGNATURE]) {
		assert.ok(trigger.includes(`"${header}"`), `${header} en trigger/trigger.go`);
	}
	assert.ok(read("internal/api/trigger_bundle.go").includes(`"${protocol.ENV_TRIGGER_SECRET}"`));
	const variables = read("internal/api/variables.go");
	for (const name of [protocol.ENV_PORT, protocol.ENV_OMI_ENVIRONMENT, protocol.ENV_OMI_VERSION]) {
		assert.ok(variables.includes(`"${name}"`), `${name} en internal/api/variables.go`);
	}
	assert.ok(variables.includes(`"${protocol.RESERVED_ENV_PREFIX}"`), "prefijo reservado en internal/api/variables.go");
	const kit = read("internal/api/kit.go");
	assert.ok(kit.includes(protocol.CI_REGISTRY_SECRET));
	assert.ok(kit.includes("50 << 20"));
	assert.equal(protocol.REGISTRY_CHUNK_BYTES, 50 << 20);
	const versions = read("internal/api/versions.go");
	for (const label of [protocol.LABEL_VERSION, protocol.LABEL_REVISION, protocol.LABEL_CREATED]) {
		assert.ok(versions.includes(label) || kit.includes(label), `${label} en la API`);
	}
});
