// `omi upgrade`: consulta o instala la última release.

import pkg from "../../../package.json" with { type: "json" };
import { EXIT_OK } from "../../core/errors.ts";
import { processRunner } from "../../core/exec.ts";
import { RELEASES_URL, currentPlatform } from "../../upgrade/release.ts";
import { checkUpgrade, runUpgrade, type UpgradeOptions } from "../../upgrade/upgrade.ts";
import { parseFlags } from "../flags.ts";
import type { Io } from "../io.ts";
import { printJson } from "../output.ts";

export async function upgradeCommand(args: string[], io: Io): Promise<number> {
	const { values } = parseFlags(args, { check: { type: "boolean" } });
	const options: Omit<UpgradeOptions, "platform"> = {
		homeDir: io.homeDir,
		current: pkg.version,
		releasesUrl: io.env.OMI_RELEASES_URL ?? RELEASES_URL,
		runner: processRunner,
	};
	if (values.check === true) {
		const report = await checkUpgrade(options);
		if (values.json === true) printJson(report, io);
		else io.out(report.updateAvailable ? `Hay una versión nueva: ${report.current} → ${report.latest}` : `omi ${report.current} está al día`);
		return EXIT_OK;
	}
	const report = await runUpgrade({ ...options, platform: currentPlatform() });
	if (values.json === true) printJson(report, io);
	else io.out(report.updated ? `omi actualizado: ${report.current} → ${report.latest}` : `omi ${report.current} está al día`);
	return EXIT_OK;
}
