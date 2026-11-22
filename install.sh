#!/bin/sh
# Instala omi en ~/.omi/bin/omi y sus assets en ~/.omi/runtime. No hace falta Node ni Bun.
# Si ~/.omi/bin no está en el PATH, lo agrega al archivo de inicio del shell de $SHELL.
#
#   curl -fsSL https://github.com/chichex/omi-code/releases/latest/download/install.sh | sh
#
# OMI_INSTALL_BASE cambia el origen de los assets; OMI_HOME, el destino.
# OMI_NO_MODIFY_PATH=1 no toca ningún archivo del shell. Vacío, 0, false o no (en mayúsculas o
# minúsculas) sí lo configuran; cualquier otro valor, no. Va del lado de sh, no de curl:
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
# Para los mensajes: con HOME sin definir, set -u cortaría el instalador con el binario ya puesto.
home_shown=${HOME:-\~}

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
		zsh) say "${ZDOTDIR:-${HOME:-}}/.zshrc" ;;
		bash)
			if [ "$os" = linux ]; then
				say "${HOME:-}/.bashrc"
				return
			fi
			for name in .bash_profile .bash_login .profile; do
				if [ -e "${HOME:-}/$name" ]; then
					say "${HOME:-}/$name"
					return
				fi
			done
			say "${HOME:-}/.bash_profile"
			;;
		fish) say "${XDG_CONFIG_HOME:-${HOME:-}/.config}/fish/conf.d/omi.fish" ;;
	esac
}

# La línea que agrega BIN al PATH en la sintaxis del shell: va en el archivo y sirve tal cual en la
# terminal actual. csh y tcsh no se configuran, pero reciben su línea; el resto, la de sh.
path_line() {
	case "$shell_name" in
		fish) printf 'set -gx PATH %s $PATH\n' "$(fish_quote "$BIN")" ;;
		csh | tcsh) printf 'setenv PATH %s:"$PATH"\n' "$(shell_quote "$BIN")" ;;
		*) printf 'export PATH=%s:"$PATH"\n' "$(shell_quote "$BIN")" ;;
	esac
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

# El archivo entero con el bloque nuevo: reemplazado en su lugar o agregado al final. Fuera del
# bloque queda igual byte a byte, incluido el último salto de línea o su falta.
new_content() {
	if [ "$2" = one ]; then
		eol=1
		[ -z "$(tail -c 1 "$1")" ] || eol=0
		path_block >"$work/path-block"
		OMI_BLOCK="$work/path-block" awk -v start="$MARK_START" -v end="$MARK_END" -v eol="$eol" '
			function out(text) { printf "%s%s", sep, text; sep = "\n" }
			$0 == start { while ((getline line < ENVIRON["OMI_BLOCK"]) > 0) out(line); skip = 1; next }
			skip && $0 == end { skip = 0; next }
			!skip { out($0) }
			END { if (eol) printf "\n" }
		' "$1"
		return
	fi
	if [ -s "$1" ]; then
		cat "$1"
		[ -z "$(tail -c 1 "$1")" ] || printf '\n'
		printf '\n'
	fi
	path_block
}

# Escribe sobre el archivo, sin mv, para seguir un symlink (dotfiles) y conservar sus permisos.
# Antes guarda el original en $work: si la escritura se corta (disco lleno), lo restaura.
# Devuelve 0 si escribió, 1 si no y el archivo quedó como estaba, 2 si pudo quedar a medias.
write_block() {
	new_content "$1" "$2" >"$work/rc.new" || return 1
	if [ -e "$1" ]; then
		cp "$1" "$work/rc.orig" || return 1
		cat "$work/rc.new" >"$1" && return 0
		cat "$work/rc.orig" >"$1" && return 1
		return 2
	fi
	cat "$work/rc.new" >"$1" && return 0
	# No existía: volver atrás es borrar lo creado, salvo que sea un enlace ajeno.
	[ ! -L "$1" ] && rm -f "$1" && return 1
	return 2
}

# Sin configurar: dice por qué y deja la línea lista para copiar, con el archivo si se sabe.
manual() {
	say "PATH: sin configurar. $1"
	if [ -n "${2:-}" ]; then
		say "Agregá esta línea a $2 y corré la misma en esta terminal:"
	else
		say "Agregá esta línea al archivo de inicio de tu shell y corré la misma en esta terminal:"
	fi
	say "  $(path_line)"
}

# La escritura se cortó y no se pudo volver atrás: no dice que el archivo quedó bien.
write_lost() {
	lost="No se pudo escribir $1 ni restaurarlo: puede haber quedado incompleto."
	saved="$TARGET/$(basename "$1").antes-de-omi"
	if [ ! -e "$work/rc.orig" ]; then
		manual "$lost" "$1"
	elif cp "$work/rc.orig" "$saved" 2>/dev/null; then
		manual "$lost El original está en $saved." "$1"
	else
		manual "$lost Tampoco se pudo guardar una copia del original." "$1"
	fi
}

# Shell no soportado: no escribe nada. csh y tcsh reciben su sintaxis; el resto, la de sh, dicha como tal.
unsupported() {
	reason="No sé configurar tu shell (SHELL=$shell_path): soporto zsh, bash y fish."
	case "$shell_name" in
		csh) manual "$reason" "$home_shown/.cshrc" ;;
		tcsh)
			# tcsh lee .tcshrc si existe y, si no, .cshrc.
			if [ -n "${HOME:-}" ] && [ -e "$HOME/.tcshrc" ]; then
				manual "$reason" "$HOME/.tcshrc"
			else
				manual "$reason" "$home_shown/.cshrc"
			fi
			;;
		*)
			say "PATH: sin configurar. $reason"
			say "Agregá $BIN al PATH en el archivo de inicio de tu shell. En sh, dash o ksh es esta línea (sintaxis sh), en $home_shown/.profile y en la terminal actual:"
			say "  $(path_line)"
			;;
	esac
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
	case "$shell_name" in
		zsh | bash | fish) ;;
		*)
			unsupported
			return
			;;
	esac
	if [ -z "${HOME:-}" ]; then
		manual "HOME no está definido: no sé dónde está el archivo de inicio de $shell_name."
		return
	fi
	rc=$(shell_rc)
	no_modify=$(printf '%s' "${OMI_NO_MODIFY_PATH:-}" | tr '[:upper:]' '[:lower:]')
	case "$no_modify" in
		"" | 0 | false | no) ;;
		*)
			manual "Lo pediste con OMI_NO_MODIFY_PATH=$OMI_NO_MODIFY_PATH." "$rc"
			return
			;;
	esac
	if ! can_write "$rc"; then
		manual "No se puede escribir $rc." "$rc"
		return
	fi
	state=none
	# Con set -e, un awk que falla cortaría el instalador con el binario ya puesto.
	if [ -e "$rc" ]; then state=$(block_state "$rc") || state=bad; fi
	if [ "$state" = bad ]; then
		manual "$rc tiene un bloque de omi incompleto o repetido; no se tocó." "$rc"
		return
	fi
	written=0
	write_block "$rc" "$state" 2>/dev/null || written=$?
	case "$written" in
		0) ;;
		1)
			manual "No se pudo escribir $rc; quedó como estaba." "$rc"
			return
			;;
		*)
			write_lost "$rc"
			return
			;;
	esac
	say "PATH: configurado en $rc."
	say "Las terminales nuevas ya lo ven. En esta, corré:"
	say "  $(path_line)"
}

configure_path
