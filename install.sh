#!/bin/sh
# Instala omi en ~/.omi/bin/omi y sus assets en ~/.omi/runtime. No hace falta Node ni Bun.
#
#   curl -fsSL https://github.com/chichex/omi-code/releases/latest/download/install.sh | sh
#
# OMI_INSTALL_BASE cambia el origen de los assets; OMI_HOME, el destino.

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

echo "omi $("$TARGET/bin/omi" --version) instalado en $TARGET/bin/omi"
case ":$PATH:" in
	*":$TARGET/bin:"*) ;;
	*) echo "Agregá $TARGET/bin a tu PATH." ;;
esac
