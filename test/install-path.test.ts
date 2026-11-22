// install.sh configura el PATH del shell de la persona (issue #23). Todo corre con HOME,
// ZDOTDIR y XDG_CONFIG_HOME temporales: nunca toca la config de shell de quien corre el test.

import assert from "node:assert/strict";
import { chmod, lstat, mkdir, readFile, readdir, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { currentPlatform } from "../src/upgrade/release.ts";
import { assertNewShellFinds, fakeRelease, fakeUname, runInstaller } from "./helpers/installer.ts";
import { tempDir } from "./helpers/io.ts";

const START = "# >>> omi >>>";
const NOTE = "# Lo agregó el instalador de omi: reinstalar reemplaza este bloque.";
const END = "# <<< omi <<<";

const posixQuote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;
const fishQuote = (value: string): string => `'${value.replaceAll("\\", "\\\\").replaceAll("'", "\\'")}'`;
const exportLine = (bin: string): string => `export PATH=${posixQuote(bin)}:"$PATH"`;
const fishLine = (bin: string): string => `set -gx PATH ${fishQuote(bin)} $PATH`;
const setenvLine = (bin: string): string => `setenv PATH ${posixQuote(bin)}:"$PATH"`;

function posixBlock(bin: string): string {
	const quoted = posixQuote(bin);
	return [START, NOTE, 'case ":$PATH:" in', `\t*:${quoted}:*) ;;`, `\t*) ${exportLine(bin)} ;;`, "esac", END, ""].join("\n");
}

function fishBlock(bin: string): string {
	const quoted = fishQuote(bin);
	return [START, NOTE, `if not contains -- ${quoted} $PATH`, `\t${fishLine(bin)}`, "end", END, ""].join("\n");
}

interface Setup {
	home: string;
	release: string;
	/** `$HOME/.omi/bin`, el destino por defecto. */
	bin: string;
	/** PATH con un `uname` que dice ser `platform`: fija qué archivo elige bash. */
	env: NodeJS.ProcessEnv;
}

async function setup(t: TestContext, platform = currentPlatform()): Promise<Setup> {
	const home = await tempDir(t);
	const release = await fakeRelease(t, { platform });
	const env = { PATH: `${await fakeUname(t, platform)}:${process.env.PATH}` };
	return { home, release, bin: join(home, ".omi/bin"), env };
}

/**
 * Un `cat` que se corta a mitad, como con el disco lleno, al copiar desde la carpeta de trabajo
 * del instalador. Con `FAIL_CAT=new` deja pasar la restauración desde `rc.orig`; con `all`, no.
 */
async function failingCat(t: TestContext): Promise<string> {
	const dir = await tempDir(t);
	await writeFile(join(dir, "cat"), `#!/bin/sh
for arg in "$@"; do
	case "$arg" in
		*/omi-install.*/*)
			if [ "$FAIL_CAT" = all ] || [ "\${arg##*/}" != rc.orig ]; then
				head -c 10 "$arg"
				exit 1
			fi
			;;
	esac
done
exec /bin/cat "$@"
`, { mode: 0o755 });
	return dir;
}

test("assertNewShellFinds_sin el shell falla con OMI_REQUIRE_SHELLS y, sin ella, dice que no corrió", () => {
	const missing = { shell: "shell-que-no-existe-omi", flags: ["-c"], home: "/nada", bin: "/nada/bin" };
	const notes: string[] = [];
	const t = { diagnostic: (note: string) => { notes.push(note); } };
	assert.throws(() => assertNewShellFinds(t, { ...missing, required: true }), /shell-que-no-existe-omi no está instalado y OMI_REQUIRE_SHELLS=1/);
	assert.deepEqual(notes, []);
	assertNewShellFinds(t, { ...missing, required: false });
	assert.equal(notes.length, 1);
	assert.match(notes[0] ?? "", /^shell nuevo NO corrió: shell-que-no-existe-omi no está instalado/);
});

test("install.sh_con zsh agrega el bloque a ~/.zshrc, separa binario de PATH y un zsh nuevo encuentra omi", async (t) => {
	const { home, release, bin, env } = await setup(t);
	const result = runInstaller(release, home, { ...env, SHELL: "/bin/zsh" });
	assert.equal(result.status, 0, result.stderr);
	assert.equal(result.stdout, [
		`omi 1.0.0: binario instalado en ${bin}/omi`,
		`PATH: configurado en ${join(home, ".zshrc")}.`,
		"Las terminales nuevas ya lo ven. En esta, corré:",
		`  ${exportLine(bin)}`,
		"",
	].join("\n"));
	assert.equal(await readFile(join(home, ".zshrc"), "utf8"), posixBlock(bin));
	assertNewShellFinds(t, { shell: "zsh", flags: ["-i", "-c"], home, bin });
});

test("install.sh_con zsh respeta ZDOTDIR", async (t) => {
	const { home, release, bin, env } = await setup(t);
	const zdotdir = join(home, "config zsh");
	await mkdir(zdotdir);
	const result = runInstaller(release, home, { ...env, SHELL: "/usr/bin/zsh", ZDOTDIR: zdotdir });
	assert.equal(result.status, 0, result.stderr);
	assert.ok(result.stdout.includes(`PATH: configurado en ${join(zdotdir, ".zshrc")}.\n`), result.stdout);
	assert.equal(await readFile(join(zdotdir, ".zshrc"), "utf8"), posixBlock(bin));
	await assert.rejects(stat(join(home, ".zshrc")));
	assertNewShellFinds(t, { shell: "zsh", flags: ["-i", "-c"], home, bin, env: { ZDOTDIR: zdotdir } });
});

test("install.sh_con bash en macOS usa ~/.bash_profile, el que lee el login shell de Terminal", async (t) => {
	const { home, release, bin, env } = await setup(t, "darwin-arm64");
	const result = runInstaller(release, home, { ...env, SHELL: "/bin/bash" });
	assert.equal(result.status, 0, result.stderr);
	assert.ok(result.stdout.includes(`PATH: configurado en ${join(home, ".bash_profile")}.\n`), result.stdout);
	assert.equal(await readFile(join(home, ".bash_profile"), "utf8"), posixBlock(bin));
	await assert.rejects(stat(join(home, ".bashrc")));
	assertNewShellFinds(t, { shell: "bash", flags: ["-l", "-c"], home, bin });
});

test("install.sh_con bash en macOS escribe ~/.profile si es el que bash ya lee, sin crear ~/.bash_profile", async (t) => {
	const { home, release, bin, env } = await setup(t, "darwin-x64");
	await writeFile(join(home, ".profile"), "export EDITOR=vi\n");
	const result = runInstaller(release, home, { ...env, SHELL: "/bin/bash" });
	assert.equal(result.status, 0, result.stderr);
	assert.equal(await readFile(join(home, ".profile"), "utf8"), `export EDITOR=vi\n\n${posixBlock(bin)}`);
	await assert.rejects(stat(join(home, ".bash_profile")), "un ~/.bash_profile nuevo taparía al ~/.profile existente");
	assertNewShellFinds(t, { shell: "bash", flags: ["-l", "-c"], home, bin });
});

test("install.sh_con bash en Linux usa ~/.bashrc, el que lee una terminal nueva", async (t) => {
	const { home, release, bin, env } = await setup(t, "linux-x64");
	const result = runInstaller(release, home, { ...env, SHELL: "/usr/bin/bash" });
	assert.equal(result.status, 0, result.stderr);
	assert.ok(result.stdout.includes(`PATH: configurado en ${join(home, ".bashrc")}.\n`), result.stdout);
	assert.equal(await readFile(join(home, ".bashrc"), "utf8"), posixBlock(bin));
	await assert.rejects(stat(join(home, ".bash_profile")));
	assertNewShellFinds(t, { shell: "bash", flags: ["-i", "-c"], home, bin });
});

test("install.sh_con fish escribe conf.d/omi.fish bajo XDG_CONFIG_HOME", async (t) => {
	const { home, release, bin, env } = await setup(t);
	const xdg = join(home, "config xdg");
	const result = runInstaller(release, home, { ...env, SHELL: "/opt/homebrew/bin/fish", XDG_CONFIG_HOME: xdg });
	assert.equal(result.status, 0, result.stderr);
	const file = join(xdg, "fish/conf.d/omi.fish");
	assert.equal(result.stdout, [
		`omi 1.0.0: binario instalado en ${bin}/omi`,
		`PATH: configurado en ${file}.`,
		"Las terminales nuevas ya lo ven. En esta, corré:",
		`  ${fishLine(bin)}`,
		"",
	].join("\n"));
	assert.equal(await readFile(file, "utf8"), fishBlock(bin));
	assertNewShellFinds(t, { shell: "fish", flags: ["-c"], home, bin, env: { XDG_CONFIG_HOME: xdg } });
});

test("install.sh_con fish sin XDG_CONFIG_HOME usa ~/.config/fish/conf.d", async (t) => {
	const { home, release, bin, env } = await setup(t);
	const result = runInstaller(release, home, { ...env, SHELL: "/usr/bin/fish" });
	assert.equal(result.status, 0, result.stderr);
	assert.equal(await readFile(join(home, ".config/fish/conf.d/omi.fish"), "utf8"), fishBlock(bin));
	assertNewShellFinds(t, { shell: "fish", flags: ["-c"], home, bin });
});

test("install.sh_cita un OMI_HOME con espacios, comillas, $ y barras en zsh, bash y fish", async (t) => {
	const { home, release, env } = await setup(t, "linux-arm64");
	const target = join(home, "mi omi 'raro' $HOME \\ `false`");
	const bin = join(target, "bin");
	for (const [shell, file, block] of [
		["/bin/zsh", join(home, ".zshrc"), posixBlock(bin)],
		["/bin/bash", join(home, ".bashrc"), posixBlock(bin)],
		["/usr/bin/fish", join(home, ".config/fish/conf.d/omi.fish"), fishBlock(bin)],
	] as const) {
		const result = runInstaller(release, home, { ...env, SHELL: shell, OMI_HOME: target });
		assert.equal(result.status, 0, result.stderr);
		assert.ok(result.stdout.startsWith(`omi 1.0.0: binario instalado en ${bin}/omi\nPATH: configurado en ${file}.\n`), result.stdout);
		assert.equal(await readFile(file, "utf8"), block);
	}
	await assert.rejects(stat(join(home, ".omi")), "con OMI_HOME no se instala en ~/.omi");
	assertNewShellFinds(t, { shell: "zsh", flags: ["-i", "-c"], home, bin });
	assertNewShellFinds(t, { shell: "bash", flags: ["-i", "-c"], home, bin });
	assertNewShellFinds(t, { shell: "fish", flags: ["-c"], home, bin });
});

test("install.sh_conserva el contenido previo del archivo y agrega el bloque al final", async (t) => {
	const { home, release, bin, env } = await setup(t);
	const previous = "export EDITOR=vi\nalias ll='ls -l' # sin salto de línea final";
	await writeFile(join(home, ".zshrc"), previous);
	const result = runInstaller(release, home, { ...env, SHELL: "/bin/zsh" });
	assert.equal(result.status, 0, result.stderr);
	assert.equal(await readFile(join(home, ".zshrc"), "utf8"), `${previous}\n\n${posixBlock(bin)}`);
	assertNewShellFinds(t, { shell: "zsh", flags: ["-i", "-c"], home, bin });
});

test("install.sh_reinstalar no duplica el bloque ni cambia el archivo", async (t) => {
	const { home, release, env } = await setup(t);
	await writeFile(join(home, ".zshrc"), "export EDITOR=vi\n");
	for (let round = 0; round < 2; round++) {
		const result = runInstaller(release, home, { ...env, SHELL: "/bin/zsh" });
		assert.equal(result.status, 0, result.stderr);
		assert.ok(result.stdout.includes("PATH: configurado en"), result.stdout);
	}
	const content = await readFile(join(home, ".zshrc"), "utf8");
	assert.equal(content, `export EDITOR=vi\n\n${posixBlock(join(home, ".omi/bin"))}`);
	assert.equal(content.split("\n").filter((line) => line === START).length, 1);
});

test("install.sh_reemplaza en su lugar un bloque viejo y conserva lo de antes y de después", async (t) => {
	const { home, release, bin, env } = await setup(t);
	const before = "export EDITOR=vi\n";
	const after = "alias ll='ls -l'\n";
	await writeFile(join(home, ".zshrc"), `${before}${posixBlock("/otra/ruta/omi/bin")}${after}`);
	const result = runInstaller(release, home, { ...env, SHELL: "/bin/zsh" });
	assert.equal(result.status, 0, result.stderr);
	assert.equal(await readFile(join(home, ".zshrc"), "utf8"), `${before}${posixBlock(bin)}${after}`);
});

for (const [label, around] of [
	["una línea después del bloque", { before: "export EDITOR=vi\n", after: "alias ll='ls -l'", block: (bin: string) => posixBlock(bin) }],
	["el bloque al final", { before: "export EDITOR=vi\n", after: "", block: (bin: string) => posixBlock(bin).slice(0, -1) }],
] as const) {
	test(`install.sh_al reemplazar el bloque respeta que el archivo no termine en salto de línea (${label})`, async (t) => {
		const { home, release, bin, env } = await setup(t);
		await writeFile(join(home, ".zshrc"), `${around.before}${around.block("/otra/ruta/omi/bin")}${around.after}`);
		const result = runInstaller(release, home, { ...env, SHELL: "/bin/zsh" });
		assert.equal(result.status, 0, result.stderr);
		assert.equal(await readFile(join(home, ".zshrc"), "utf8"), `${around.before}${around.block(bin)}${around.after}`);
	});
}

test("install.sh_sigue un ~/.zshrc enlazado (dotfiles) sin reemplazar el enlace", async (t) => {
	const { home, release, bin, env } = await setup(t);
	await mkdir(join(home, "dotfiles"));
	await writeFile(join(home, "dotfiles/zshrc"), "export EDITOR=vi\n");
	await symlink(join(home, "dotfiles/zshrc"), join(home, ".zshrc"));
	const result = runInstaller(release, home, { ...env, SHELL: "/bin/zsh" });
	assert.equal(result.status, 0, result.stderr);
	assert.equal((await lstat(join(home, ".zshrc"))).isSymbolicLink(), true);
	assert.equal(await readFile(join(home, "dotfiles/zshrc"), "utf8"), `export EDITOR=vi\n\n${posixBlock(bin)}`);
});

for (const [label, original] of [
	["con un bloque viejo", `export EDITOR=vi\n${posixBlock("/otra/ruta/omi/bin")}alias ll='ls -l'\n`],
	["sin bloque", "export EDITOR=vi\nalias ll='ls -l'\n"],
	["sin archivo previo", undefined],
] as const) {
	test(`install.sh_si la escritura se corta a mitad restaura el archivo (${label})`, async (t) => {
		const { home, release, bin, env } = await setup(t);
		const rc = join(home, ".zshrc");
		if (original !== undefined) await writeFile(rc, original);
		const result = runInstaller(release, home, { ...env, PATH: `${await failingCat(t)}:${env.PATH}`, FAIL_CAT: "new", SHELL: "/bin/zsh" });
		assert.equal(result.status, 0, result.stderr);
		if (original === undefined) await assert.rejects(stat(rc), "volver atrás es borrar lo que creó");
		else assert.equal(await readFile(rc, "utf8"), original);
		assert.ok(result.stdout.includes(`PATH: sin configurar. No se pudo escribir ${rc}; quedó como estaba.\nAgregá esta línea a ${rc} y corré la misma en esta terminal:\n  ${exportLine(bin)}\n`), result.stdout);
		assert.doesNotMatch(result.stdout, /configurado en/);
	});
}

test("install.sh_si tampoco puede restaurar no dice que el archivo quedó bien y guarda el original", async (t) => {
	const { home, release, bin, env } = await setup(t);
	const rc = join(home, ".zshrc");
	const original = `export EDITOR=vi\n${posixBlock("/otra/ruta/omi/bin")}alias ll='ls -l'\n`;
	await writeFile(rc, original);
	const result = runInstaller(release, home, { ...env, PATH: `${await failingCat(t)}:${env.PATH}`, FAIL_CAT: "all", SHELL: "/bin/zsh" });
	assert.equal(result.status, 0, result.stderr);
	const saved = join(home, ".omi/.zshrc.antes-de-omi");
	assert.equal(await readFile(saved, "utf8"), original);
	assert.ok(result.stdout.includes(`PATH: sin configurar. No se pudo escribir ${rc} ni restaurarlo: puede haber quedado incompleto. El original está en ${saved}.\n`), result.stdout);
	assert.ok(result.stdout.includes(`  ${exportLine(bin)}\n`), result.stdout);
	assert.doesNotMatch(result.stdout, /quedó como estaba|configurado en/);
});

test("install.sh_con el archivo del shell no escribible no lo toca y da la línea para copiar", async (t) => {
	const { home, release, bin, env } = await setup(t);
	const rc = join(home, ".zshrc");
	await writeFile(rc, "export EDITOR=vi\n");
	await chmod(rc, 0o444);
	const result = runInstaller(release, home, { ...env, SHELL: "/bin/zsh" });
	assert.equal(result.status, 0, result.stderr);
	assert.equal(await readFile(rc, "utf8"), "export EDITOR=vi\n");
	assert.equal(result.stdout, [
		`omi 1.0.0: binario instalado en ${bin}/omi`,
		`PATH: sin configurar. No se puede escribir ${rc}.`,
		`Agregá esta línea a ${rc} y corré la misma en esta terminal:`,
		`  ${exportLine(bin)}`,
		"",
	].join("\n"));
});

test("install.sh_con la carpeta de config no escribible no crea nada y da la línea para copiar", async (t) => {
	const { home, release, bin, env } = await setup(t);
	const xdg = join(home, "config");
	await mkdir(xdg);
	await chmod(xdg, 0o555);
	const result = runInstaller(release, home, { ...env, SHELL: "/usr/bin/fish", XDG_CONFIG_HOME: xdg });
	assert.equal(result.status, 0, result.stderr);
	const file = join(xdg, "fish/conf.d/omi.fish");
	assert.deepEqual(await readdir(xdg), []);
	assert.ok(result.stdout.includes(`PATH: sin configurar. No se puede escribir ${file}.\nAgregá esta línea a ${file} y corré la misma en esta terminal:\n  ${fishLine(bin)}\n`), result.stdout);
	assert.doesNotMatch(result.stdout, /configurado en/);
});

test("install.sh_con un directorio en lugar del archivo del shell termina bien y da la línea para copiar", async (t) => {
	const { home, release, bin, env } = await setup(t);
	const rc = join(home, ".zshrc");
	await mkdir(rc);
	const result = runInstaller(release, home, { ...env, SHELL: "/bin/zsh" });
	assert.equal(result.status, 0, result.stderr);
	assert.deepEqual(await readdir(rc), []);
	assert.ok(result.stdout.includes(`PATH: sin configurar. No se puede escribir ${rc}.\n`), result.stdout);
	assert.ok(result.stdout.includes(`  ${exportLine(bin)}\n`), result.stdout);
});

test("install.sh_no toca un archivo con un bloque de omi incompleto", async (t) => {
	const { home, release, bin, env } = await setup(t);
	const rc = join(home, ".zshrc");
	const damaged = `export EDITOR=vi\n${START}\nexport PATH=/viejo:$PATH\n`;
	await writeFile(rc, damaged);
	const result = runInstaller(release, home, { ...env, SHELL: "/bin/zsh" });
	assert.equal(result.status, 0, result.stderr);
	assert.equal(await readFile(rc, "utf8"), damaged);
	assert.ok(result.stdout.includes(`PATH: sin configurar. ${rc} tiene un bloque de omi incompleto o repetido; no se tocó.\n`), result.stdout);
	assert.ok(result.stdout.includes(`  ${exportLine(bin)}\n`), result.stdout);
});

for (const home of [undefined, ""]) {
	test(`install.sh_con HOME ${home === undefined ? "sin definir" : "vacío"} instala, termina en 0 y da la línea para copiar`, async (t) => {
		const { release, env } = await setup(t);
		const target = join(await tempDir(t), "omi");
		const bin = join(target, "bin");
		const result = runInstaller(release, "", { ...env, HOME: home, OMI_HOME: target, SHELL: "/bin/bash" });
		assert.equal(result.status, 0, result.stderr);
		assert.equal(result.stdout, [
			`omi 1.0.0: binario instalado en ${bin}/omi`,
			"PATH: sin configurar. HOME no está definido: no sé dónde está el archivo de inicio de bash.",
			"Agregá esta línea al archivo de inicio de tu shell y corré la misma en esta terminal:",
			`  ${exportLine(bin)}`,
			"",
		].join("\n"));
	});
}

for (const [shell, file, existing] of [["/bin/tcsh", ".cshrc", undefined], ["/bin/tcsh", ".tcshrc", ".tcshrc"], ["/bin/csh", ".cshrc", undefined]] as const) {
	test(`install.sh_con ${shell}${existing === undefined ? "" : ` y ${existing}`} da la línea de csh sin tocar nada`, async (t) => {
		const { home, release, bin, env } = await setup(t);
		if (existing !== undefined) await writeFile(join(home, existing), "set prompt = '> '\n");
		const result = runInstaller(release, home, { ...env, SHELL: shell });
		assert.equal(result.status, 0, result.stderr);
		assert.deepEqual((await readdir(home)).sort(), existing === undefined ? [".omi"] : [".omi", existing]);
		if (existing !== undefined) assert.equal(await readFile(join(home, existing), "utf8"), "set prompt = '> '\n");
		assert.equal(result.stdout, [
			`omi 1.0.0: binario instalado en ${bin}/omi`,
			`PATH: sin configurar. No sé configurar tu shell (SHELL=${shell}): soporto zsh, bash y fish.`,
			`Agregá esta línea a ${join(home, file)} y corré la misma en esta terminal:`,
			`  ${setenvLine(bin)}`,
			"",
		].join("\n"));
	});
}

// SHELL vacío y no ausente: si falta, el sh de macOS (bash) lo completa con el login shell de passwd.
for (const shell of ["/usr/bin/nu", ""]) {
	test(`install.sh_con un shell no soportado (SHELL=${shell}) da la línea en sintaxis sh, dicha como tal, sin tocar nada`, async (t) => {
		const { home, release, bin, env } = await setup(t);
		const result = runInstaller(release, home, { ...env, SHELL: shell });
		assert.equal(result.status, 0, result.stderr);
		assert.deepEqual(await readdir(home), [".omi"]);
		assert.equal(result.stdout, [
			`omi 1.0.0: binario instalado en ${bin}/omi`,
			`PATH: sin configurar. No sé configurar tu shell (SHELL=${shell}): soporto zsh, bash y fish.`,
			`Agregá ${bin} al PATH en el archivo de inicio de tu shell. En sh, dash o ksh es esta línea (sintaxis sh), en ${join(home, ".profile")} y en la terminal actual:`,
			`  ${exportLine(bin)}`,
			"",
		].join("\n"));
	});
}

test("install.sh_con OMI_NO_MODIFY_PATH=1 por curl | sh no toca nada y explica qué agregar", async (t) => {
	const { home, release, bin, env } = await setup(t);
	const result = runInstaller(release, home, { ...env, SHELL: "/bin/zsh", OMI_NO_MODIFY_PATH: "1" }, true);
	assert.equal(result.status, 0, result.stderr);
	assert.deepEqual(await readdir(home), [".omi"]);
	assert.equal(result.stdout, [
		`omi 1.0.0: binario instalado en ${bin}/omi`,
		"PATH: sin configurar. Lo pediste con OMI_NO_MODIFY_PATH=1.",
		`Agregá esta línea a ${join(home, ".zshrc")} y corré la misma en esta terminal:`,
		`  ${exportLine(bin)}`,
		"",
	].join("\n"));
});

for (const value of ["0", "false", "FALSE", "no", "No"]) {
	test(`install.sh_con OMI_NO_MODIFY_PATH=${value} configura igual`, async (t) => {
		const { home, release, bin, env } = await setup(t);
		const result = runInstaller(release, home, { ...env, SHELL: "/bin/zsh", OMI_NO_MODIFY_PATH: value });
		assert.equal(result.status, 0, result.stderr);
		assert.equal(await readFile(join(home, ".zshrc"), "utf8"), posixBlock(bin));
	});
}

for (const value of ["yes", "true", "cualquiera"]) {
	test(`install.sh_con OMI_NO_MODIFY_PATH=${value} no toca nada`, async (t) => {
		const { home, release, env } = await setup(t);
		const result = runInstaller(release, home, { ...env, SHELL: "/bin/zsh", OMI_NO_MODIFY_PATH: value });
		assert.equal(result.status, 0, result.stderr);
		assert.deepEqual(await readdir(home), [".omi"]);
		assert.ok(result.stdout.includes(`PATH: sin configurar. Lo pediste con OMI_NO_MODIFY_PATH=${value}.\n`), result.stdout);
	});
}

test("install.sh_con el bin ya en el PATH no toca nada", async (t) => {
	const { home, release, bin, env } = await setup(t);
	const result = runInstaller(release, home, { SHELL: "/bin/zsh", PATH: `${bin}:${env.PATH}` });
	assert.equal(result.status, 0, result.stderr);
	assert.deepEqual(await readdir(home), [".omi"]);
	assert.equal(result.stdout, `omi 1.0.0: binario instalado en ${bin}/omi\nPATH: ya incluye ${bin}. No se tocó ningún archivo.\n`);
});
