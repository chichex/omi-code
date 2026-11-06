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

No hace falta Node ni Bun.

```sh
curl -fsSL https://github.com/chichex/omi-code/releases/latest/download/install.sh | sh
omi login
```

`omi upgrade` actualiza a la última release y `omi upgrade --check` sólo informa. Hasta que `chichex/omi#140` esté desplegado, `omi login` no funciona contra producción.

## Guardrails

| Operación | Quién decide |
|---|---|
| Lecturas | libre |
| Variables no secretas, jobs y deploy en stage, publicar | autónomo en una sesión autorizada |
| Cualquier cosa en prod, secretos, Postgres, bajas | humano, siempre |

En la TUI, `/skill:ship` autoriza stage para la sesión. En `omi mcp`, lo hace el flag `--authorize-stage` y la aprobación humana llega por elicitación del cliente MCP. En la CLI sin terminal, `--yes` aprueba; dentro de una sesión agéntica, no vale.

## Desarrollo

Requiere Node 22.19 o superior. TypeScript corre sin transpilar.

```sh
npm ci
npm run typecheck
npm test
npm run test:packaging   # compila e instala de verdad; requiere bun
npm run omi -- --help
```

## Licencia

MIT.
