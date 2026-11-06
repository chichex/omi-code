// Repo vinculado con sesión activa contra el doble de omi-api, listo para correr tools.

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { TestContext } from "node:test";
import { saveCredentials } from "../../src/auth/credentials.ts";
import { credentialsPath } from "../../src/core/paths.ts";
import { fakeRunner } from "./runner.ts";
import type { Guard } from "../../src/guardrails/policy.ts";
import { CATALOG } from "../../src/tools/catalog.ts";
import type { ToolResult, ToolRuntime } from "../../src/tools/types.ts";
import { tempDir, testIo, type TestIo, type TestIoOptions } from "./io.ts";
import { environmentView, serviceView, startMockOmi, type MockOmi, type MockProject } from "./mock-omi.ts";
import { installWorkloads, type WorkloadState } from "./mock-workloads.ts";

export interface Linked {
	home: string;
	repo: string;
	omi: MockOmi;
	workloads: WorkloadState;
	project: MockProject;
	io(overrides?: Partial<TestIoOptions>): TestIo;
	runtime(overrides?: Partial<ToolRuntime>, io?: TestIo): ToolRuntime;
	call(name: string, params: unknown, overrides?: Partial<ToolRuntime>): Promise<ToolResult>;
	mutations(): string[];
}

export function allowAll(): Guard {
	return {
		surface: "cli",
		canAsk: false,
		preApproved: true,
		stageAuthorized: true,
		ask: async () => true,
		grantStage() {},
	};
}

export function humanless(stageAuthorized = false): Guard {
	return {
		surface: "mcp",
		canAsk: false,
		preApproved: false,
		stageAuthorized,
		ask: async () => false,
		grantStage() {},
	};
}

export async function linkedProject(t: TestContext, services: [string, number][] = [["api", 8080]]): Promise<Linked> {
	const home = await tempDir(t);
	const repo = await tempDir(t);
	const omi = await startMockOmi(t);
	const workloads = installWorkloads(omi);
	omi.sessions.set("prs_test", "active");
	await saveCredentials(credentialsPath(home), {
		apiUrl: omi.url,
		token: "prs_test",
		expiresAt: "2026-11-12T00:00:00Z",
		user: { id: "usr_ada", name: "Ada", email: "ada@omi.test" },
		defaultOrganizationSlug: "acme",
	});
	const project: MockProject = { id: "prj_tienda", name: "Tienda", slug: "tienda", services: new Map() };
	for (const [name, port] of services) {
		const service = serviceView(project, name, port, "stage", "acme");
		service.view.environments.push(environmentView("prod", name, "acme", "tienda"));
		project.services.set(name, service);
	}
	omi.projects.set("tienda", project);
	await mkdir(join(repo, ".omi"));
	const link = {
		version: 1,
		organizationSlug: "acme",
		projectSlug: "tienda",
		services: services.map(([name, port]) => ({ name, path: ".", port, dockerfile: "Dockerfile" })),
	};
	await writeFile(join(repo, ".omi/project.json"), JSON.stringify(link));

	const io = (overrides: Partial<TestIoOptions> = {}): TestIo =>
		testIo({ homeDir: home, cwd: repo, env: { OMI_POLL_INTERVAL_MS: "1" }, ...overrides });
	const runtime = (overrides: Partial<ToolRuntime> = {}, testingIo: TestIo = io()): ToolRuntime => ({
		io: testingIo,
		guard: allowAll(),
		runner: fakeRunner(),
		...overrides,
	});
	return {
		home,
		repo,
		omi,
		workloads,
		project,
		io,
		runtime,
		call: async (name, params, overrides) => {
			const tool = CATALOG.find((candidate) => candidate.name === name);
			if (tool === undefined) throw new Error(`tool desconocida: ${name}`);
			return tool.run(params as never, runtime(overrides));
		},
		mutations: () => omi.requests.filter((request) => request.method !== "GET").map((request) => `${request.method} ${request.path}`),
	};
}
