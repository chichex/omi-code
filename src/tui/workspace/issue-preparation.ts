// Una preparación por issue. Resolver lo existente antes de pedir red/modelo o crear Git.
import { lstat, realpath } from "node:fs/promises";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { GitSnapshot, GithubItem } from "./data.ts";
import { classifyIssue, createIssueSession, issueTriageState } from "./issue-triage.ts";
import { checkIssueWorktree, createPlannedIssueWorktree, ensureIssueWorktree, inspectIssueWorktree, planIssueWorktree, refreshMain } from "./issue-worktree.ts";
import { assertIssueIdentity, discoverLegacyPreparations, readIssuePreparation, readIssueSession, saveIssuePreparation, verifyIssuePreparation, withIssuePreparationLock, type IssuePreparation } from "./issue-registry.ts";

export type IssueClassification = Awaited<ReturnType<typeof classifyIssue>> & { body: string };
export interface PrepareIssueOptions {
	sessionDir?: string;
	signal: AbortSignal;
	isCurrent: () => boolean;
	/** Se invoca sólo si el issue todavía no tiene un triage guardado. */
	classify: () => Promise<IssueClassification | undefined>;
}
export async function prepareIssue(git: GitSnapshot, number: number, item: GithubItem | undefined, ctx: ExtensionContext, options: PrepareIssueOptions): Promise<{ record: IssuePreparation; resumed: boolean } | undefined> {
	const current = () => { options.signal.throwIfAborted(); if (!options.isCurrent()) throw new Error("La sesión cambió mientras se preparaba el issue"); };
	return withIssuePreparationLock(git, number, async () => {
		current();
		let record = await readIssuePreparation(git, number);
		if (!record) {
			const legacy = (await discoverLegacyPreparations(git, new Map(), options.sessionDir, options.signal, number)).get(number);
			if (legacy?.error) throw new Error(legacy.error);
			if (legacy?.record) { record = legacy.record; if (item) assertIssueIdentity(record, item); await saveIssuePreparation(git, record); }
		}
		if (record && item) assertIssueIdentity(record, item);
		if (record?.phase === "ready") {
			await verifyIssuePreparation(git, record, options.signal); current();
			return { record, resumed: true };
		}
		let classification: IssueClassification | undefined;
		if (!record) {
			if (!item) throw new Error("Falta el issue de GitHub para prepararlo. Pedí el cambio en el chat o elegí un issue en Issues.");
			// Antes de gastar una llamada al modelo: ni rutas ni ramas ajenas se adoptan a ciegas.
			await checkIssueWorktree(git, number, options.signal); current();
			classification = await options.classify();
			if (!classification) return undefined;
			current();
			// El worktree sale de main recién traída de origin; si no se puede, de main local, y se avisa.
			const stale = await refreshMain(git, options.signal); current();
			if (stale) ctx.ui.notify(stale, "warning");
			const plan = await planIssueWorktree(git, item, classification.triage.type, options.signal);
			record = { version: 1, commonDir: await realpath(git.commonDir), state: issueTriageState(item, classification.triage, plan), phase: "triaged", source: { body: classification.body, labels: item.labels } };
			await saveIssuePreparation(git, record);
		}
		current();
		if (record.phase === "triaged") {
			if (classification) await createPlannedIssueWorktree(git, record.state, options.signal);
			else await ensureIssueWorktree(git, record.state, options.signal);
			record = { ...record, phase: "worktree" }; await saveIssuePreparation(git, record);
		} else if (await inspectIssueWorktree(git, record.state, options.signal) !== "ready") {
			throw new Error(`Falta el worktree guardado en ${record.state.worktree}. No se recrea automáticamente; recuperalo antes de continuar.`);
		}
		current();
		let hasSession = false;
		if (record.sessionFile) {
			try { await lstat(record.sessionFile); hasSession = true; }
			catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
		}
		if (hasSession) await readIssueSession(record.sessionFile!, record.state);
		else {
			const issue: GithubItem = { ...record.state.issue, labels: record.source.labels, author: "", updatedAt: "", draft: false, head: "", base: "", review: "" };
			await createIssueSession(record.state, issue, record.source.body, ctx, options.sessionDir, classification, {
				...(record.sessionFile ? { sessionFile: record.sessionFile } : {}),
				onPlanned: async (sessionFile) => { current(); record = { ...record!, sessionFile }; await saveIssuePreparation(git, record); },
			});
		}
		record = { ...record, phase: "ready" }; await saveIssuePreparation(git, record);
		await verifyIssuePreparation(git, record, options.signal); current();
		return { record, resumed: false };
	});
}
