# omi-code

Harness agéntico de codificación e infraestructura para [OMI](https://ohmyinfra.com), sobre [Pi](https://github.com/earendil-works/pi).

Un solo comando, `omi`, con tres caras sobre el mismo core:

| Cara | Comando | Para qué |
|---|---|---|
| TUI | `omi` | sesión agéntica con las tools y skills de OMI |
| CLI | `omi <subcomando>` | operaciones determinísticas, con `--json` |
| MCP | `omi mcp` | el mismo catálogo por stdio para otros agentes |

Códigos de salida: `0` ok, `1` error de ejecución o API, `2` error de uso o guardrail bloqueado.

## Instalación

No hace falta Node ni Bun. Tiene que existir una release publicada.
**Mientras el repo sea privado**, usá `gh` previamente autenticado y con acceso:

```sh
tmp="$(mktemp -d)"
gh release download --repo chichex/omi-code --pattern install.sh --dir "$tmp"
sh "$tmp/install.sh"
rm -rf "$tmp"
```

El instalador descarga los assets con `gh` autenticado. Cuando el repo sea público también se podrá usar:

```sh
curl -fsSL https://github.com/chichex/omi-code/releases/latest/download/install.sh | sh
```

Se instala en `~/.omi`; `OMI_HOME=/ruta/absoluta` permite otra raíz. El binario instalado la infiere de su ubicación.

`omi upgrade` actualiza a la última release y `omi upgrade --check` sólo informa.
Para releases privadas necesita `GH_TOKEN` o `GITHUB_TOKEN` con acceso. Por ejemplo, desde una terminal del humano:

```sh
GH_TOKEN="$(gh auth token)" omi upgrade --check
```

El token sólo se envía a la API de releases de este repo; no se imprime ni se guarda.
`omi login` inicia la sesión de OMI, que es distinta de la autenticación de GitHub. Hasta que `chichex/omi#140` esté desplegado, `omi login` no funciona contra producción.

## Guardrails

Son controles locales para las superficies soportadas, no aislamiento de un proceso hostil (ver «Alcance de los guardrails»).

| Operación | Quién decide |
|---|---|
| Lecturas | libre |
| Variables no secretas, jobs y deploy en stage, publicar | autónomo en una sesión autorizada |
| Cualquier cosa en prod, secretos, Postgres, bajas | humano, siempre |

En la TUI, `/skill:ship` autoriza stage para la sesión. En `omi mcp`, lo hace el flag `--authorize-stage` y la aprobación humana llega por elicitación del cliente MCP. En la CLI sin terminal, `--yes` aprueba; dentro de una sesión agéntica, no vale.

El bump semanal de Pi abre un PR sólo tras typecheck, tests y empaquetado en el mismo workflow. La revisión y el merge son humanos.

## Desarrollo

Requiere Node 22.19 o superior y `python3` para verificar la plantilla del handler Python en los tests. TypeScript corre sin transpilar desde el checkout.
No se distribuye por npm: Node no ejecuta TypeScript dentro de `node_modules`.
El paquete es privado para impedir publicaciones accidentales; la distribución para usuarios es el binario de release.

```sh
npm ci
npm run typecheck
npm test
npm run test:packaging   # compila e instala de verdad; requiere bun
npm run omi -- --help
```

## Publicación y reintentos

El modo directo construye para `linux/amd64`, igual que el workflow del kit en su runner predeterminado.
No sobrescribe una versión que OMI ya detectó. Si la espera del registry vence después del push,
`omi publish --version X.Y.Z --service api --wait-only` retoma sólo el polling, sin construir ni tocar tags.

## Alcance de los guardrails

Las confirmaciones protegen las operaciones realizadas por las superficies soportadas; **no son un sandbox**.
Un agente con bash y acceso al mismo filesystem puede quitar variables de entorno, fabricar un TTY,
leer el token local o actuar como su propio cliente MCP. Ni un TTY ni una respuesta MCP `accept` prueban identidad humana.
No confíes en estos checks como barrera frente a código hostil con acceso a credenciales de producción.

El aislamiento y la autorización fuera del control del agente quedan pendientes en [CLI #5](https://github.com/chichex/omi-code/issues/5)
y [MCP #6](https://github.com/chichex/omi-code/issues/6). Las sesiones identificadas como agénticas no aceptan `--yes`,
`--create`, pseudo-terminales ni `--authorize-stage` como aprobación; ocultar esa identidad sigue fuera de la garantía actual.

## Licencia

MIT.
