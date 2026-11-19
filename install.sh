#!/bin/sh
# Instala omi en ~/.omi/bin/omi y sus assets en ~/.omi/runtime. No hace falta Node ni Bun.
# Si ~/.omi/bin no está en el PATH, lo agrega al archivo de inicio del shell de $SHELL.
#
#   curl -fsSL https://github.com/chichex/omi-code/releases/latest/download/install.sh | sh
#
# OMI_INSTALL_BASE cambia el origen de los assets; OMI_HOME, el destino.
# OMI_NO_MODIFY_PATH=1 no toca ningún archivo del shell. Va del lado de sh, no de curl:
#
#   curl -fsSL https://github.com/chichex/omi-code/releases/latest/download/install.sh | OMI_NO_MODIFY_PATH=1 sh

set -eu

DEFAULT_BASE="https://github.com/chichex/omi-code/releases/latest/download"
BASE="${OMI_INSTALL_BASE:-$DEFAULT_BASE}"
TARGET="${OMI_HOME:-$HOME/.omi}"

die() {
	echo "omi: $*" >&2
	exit 1
}

case "$TARGET" in
	/*) ;;
	*) die "OMI_HOME debe ser una ruta absoluta" ;;
esac

case "$(uname -s)" in
	Darwin) os=darwin ;;
	Linux) os=linux ;;
	*) die "sistema no soportado: $(uname -s)" ;;
esac
case "$(uname -m)" in
	arm64 | aarch64) arch=arm64 ;;
	x86_64 | amd64) arch=x64 ;;
	*) die "arquitectura no soportada: $(uname -m)" ;;
esac
platform="$os-$arch"
binary="omi-$platform"
bundle="omi-$platform-runtime.tar.gz"

work=$(mktemp -d "${TMPDIR:-/tmp}/omi-install.XXXXXX")
trap 'rm -rf "$work"' EXIT

fetch() {
	if [ "$BASE" = "$DEFAULT_BASE" ] && command -v gh >/dev/null 2>&1 && gh auth status >/dev/null 2>&1; then
		gh release download --repo chichex/omi-code --pattern "$1" --dir "$work" || die "no se pudo descargar $1 con gh"
	else
		curl -fsSL "$BASE/$1" -o "$work/$1" || die "no se pudo descargar $1; si el repo es privado, usá gh autenticado"
	fi
}

sha256() {
	if command -v sha256sum >/dev/null 2>&1; then
		sha256sum "$1" | cut -d' ' -f1
	else
		shasum -a 256 "$1" | cut -d' ' -f1
	fi
}

verify() {
	expected=$(awk -v name="$1" '$2 == name { print $1 }' "$work/checksums.txt")
	[ -n "$expected" ] || die "checksums.txt no trae $1"
	[ "$expected" = "$(sha256 "$work/$1")" ] || die "el SHA-256 de $1 no coincide: no se instaló nada"
}

# macOS mata un binario de bun con la firma de fábrica. Es best-effort: decide el arranque.
sign() {
	[ "$os" = darwin ] || return 0
	codesign --remove-signature "$1" 2>/dev/null || true
	codesign --force --sign - "$1" 2>/dev/null || true
}

fetch checksums.txt
fetch "$binary"
fetch "$bundle"
verify "$binary"
verify "$bundle"

mkdir -p "$TARGET/bin"
rm -rf "$TARGET/runtime.new"
mkdir "$TARGET/runtime.new"
tar -xzf "$work/$bundle" -C "$TARGET/runtime.new"
sign "$TARGET/runtime.new/omi"
rm -rf "$TARGET/runtime"
mv "$TARGET/runtime.new" "$TARGET/runtime"

cp "$work/$binary" "$TARGET/bin/omi.new"
chmod +x "$TARGET/bin/omi.new"
sign "$TARGET/bin/omi.new"
mv "$TARGET/bin/omi.new" "$TARGET/bin/omi"

# Cita POSIX: una ruta es dato, no código de shell.
shell_quote() {
	printf "'%s'" "$(printf '%s' "$1" | sed "s/'/'\\\\''/g")"
}

# Fallback: si el binario suelto no arranca, se usa el del bundle.
if ! "$TARGET/bin/omi" --version >/dev/null 2>&1; then
	printf '#!/bin/sh\nexec %s "$@"\n' "$(shell_quote "$TARGET/runtime/omi")" >"$TARGET/bin/omi.new"
	chmod +x "$TARGET/bin/omi.new"
	mv "$TARGET/bin/omi.new" "$TARGET/bin/omi"
	"$TARGET/bin/omi" --version >/dev/null 2>&1 || die "omi no arranca en esta máquina"
fi

# Sin echo: el de algunos sh interpreta las barras de una ruta.
say() {
	printf '%s\n' "$*"
}

say "omi $("$TARGET/bin/omi" --version): binario instalado en $TARGET/bin/omi"

# --- PATH persistente --------------------------------------------------------
# Un instalador corrido con sh no puede cambiar el PATH de la terminal que lo lanzó: escribe el
# archivo que lee una terminal nueva y dice qué correr en la actual.

BIN="$TARGET/bin"
MARK_START="# >>> omi >>>"
MARK_END="# <<< omi <<<"
shell_path=${SHELL:-}
shell_name=${shell_path##*/}

# Cita fish: entre comillas simples sólo \ y ' llevan escape.
fish_quote() {
	printf "'%s'" "$(printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e "s/'/\\\\'/g")"
}

# El archivo que lee una terminal nueva del shell de $SHELL; vacío si no se soporta.
# - zsh: .zshrc lo lee toda sesión interactiva, login o no, después de /etc/zprofile, así que el
#   path_helper de macOS no lo reordena.
# - bash en macOS: Terminal abre un login shell, que lee el primero que exista de .bash_profile,
#   .bash_login y .profile. Crear otro taparía al que ya se usa.
# - bash en Linux: la terminal abre un shell interactivo no login, que lee .bashrc.
# - fish: un archivo propio en conf.d, que fish lee siempre.
shell_rc() {
	case "$shell_name" in
		zsh) say "${ZDOTDIR:-$HOME}/.zshrc" ;;
		bash)
			if [ "$os" = linux ]; then
				say "$HOME/.bashrc"
				return
			fi
			for name in .bash_profile .bash_login .profile; do
				if [ -e "$HOME/$name" ]; then
					say "$HOME/$name"
					return
				fi
			done
			say "$HOME/.bash_profile"
			;;
		fish) say "${XDG_CONFIG_HOME:-$HOME/.config}/fish/conf.d/omi.fish" ;;
	esac
}

# La línea que agrega BIN al PATH: va en el archivo y sirve tal cual en la terminal actual.
path_line() {
	if [ "$shell_name" = fish ]; then
		printf 'set -gx PATH %s $PATH\n' "$(fish_quote "$BIN")"
	else
		printf 'export PATH=%s:"$PATH"\n' "$(shell_quote "$BIN")"
	fi
}

# El bloque entre marcadores, que reinstalar reemplaza entero. No repite BIN en shells anidados.
path_block() {
	printf '%s\n' "$MARK_START" "# Lo agregó el instalador de omi: reinstalar reemplaza este bloque."
	if [ "$shell_name" = fish ]; then
		printf 'if not contains -- %s $PATH\n\t%s\nend\n' "$(fish_quote "$BIN")" "$(path_line)"
	else
		printf 'case ":$PATH:" in\n\t*:%s:*) ;;\n\t*) %s ;;\nesac\n' "$(shell_quote "$BIN")" "$(path_line)"
	fi
	say "$MARK_END"
}

# none, one o bad. Un bloque es un inicio seguido de su fin: cualquier otra cosa no se toca.
block_state() {
	awk -v start="$MARK_START" -v end="$MARK_END" '
		$0 == start { s++; if (s != e + 1) bad = 1 }
		$0 == end { e++; if (e != s) bad = 1 }
		END { if (bad || s > 1 || s != e) print "bad"; else if (s) print "one"; else print "none" }
	' "$1"
}

# Reemplaza el bloque en su lugar o lo agrega al final, y deja igual el resto del archivo.
# Escribe sobre el archivo, sin mv, para seguir un symlink (dotfiles) y conservar sus permisos.
write_block() {
	path_block >"$work/path-block"
	if [ "$2" = one ]; then
		OMI_BLOCK="$work/path-block" awk -v start="$MARK_START" -v end="$MARK_END" '
			$0 == start { while ((getline line < ENVIRON["OMI_BLOCK"]) > 0) print line; skip = 1; next }
			skip && $0 == end { skip = 0; next }
			!skip { print }
		' "$1" >"$work/rc" && cat "$work/rc" >"$1"
		return
	fi
	{
		if [ -s "$1" ]; then
			[ -z "$(tail -c 1 "$1")" ] || printf '\n'
			printf '\n'
		fi
		cat "$work/path-block"
	} >>"$1"
}

# Sin configurar: dice por qué y deja la línea lista para copiar.
manual() {
	say "PATH: sin configurar. $1"
	say "Agregá esta línea a $rc y corré la misma en esta terminal:"
	say "  $(path_line)"
}

can_write() {
	if [ -e "$1" ]; then
		[ -f "$1" ] && [ -r "$1" ] && [ -w "$1" ]
	else
		mkdir -p "$(dirname "$1")" 2>/dev/null && [ -w "$(dirname "$1")" ]
	fi
}

configure_path() {
	case ":$PATH:" in
		*":$BIN:"*)
			say "PATH: ya incluye $BIN. No se tocó ningún archivo."
			return
			;;
	esac
	rc=$(shell_rc)
	if [ -z "$rc" ]; then
		say "PATH: sin configurar. No sé configurar tu shell (SHELL=$shell_path): soporto zsh, bash y fish."
		say "Agregá $BIN al PATH en el archivo de inicio de tu shell. En sh, dash o ksh, agregá esta línea a $HOME/.profile y corré la misma en esta terminal:"
		say "  $(path_line)"
		return
	fi
	case "${OMI_NO_MODIFY_PATH:-}" in
		"" | 0) ;;
		*)
			manual "Lo pediste con OMI_NO_MODIFY_PATH=$OMI_NO_MODIFY_PATH."
			return
			;;
	esac
	if ! can_write "$rc"; then
		manual "No se puede escribir $rc."
		return
	fi
	state=none
	# Con set -e, un awk que falla cortaría el instalador con el binario ya puesto.
	if [ -e "$rc" ]; then state=$(block_state "$rc") || state=bad; fi
	if [ "$state" = bad ]; then
		manual "$rc tiene un bloque de omi incompleto o repetido; no se tocó."
		return
	fi
	if ! write_block "$rc" "$state" 2>/dev/null; then
		manual "No se pudo escribir $rc."
		return
	fi
	say "PATH: configurado en $rc."
	say "Las terminales nuevas ya lo ven. En esta, corré:"
	say "  $(path_line)"
}

configure_path
