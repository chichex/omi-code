# omi-code

Harness agéntico de codificación e infraestructura para [OMI](https://ohmyinfra.com), sobre [Pi](https://github.com/earendil-works/pi).

Un solo comando, `omi`, con tres caras sobre el mismo core:

| Cara | Comando | Para qué |
|---|---|---|
| TUI | `omi` | sesión agéntica con las tools y skills de OMI |
| CLI | `omi <subcomando>` | operaciones determinísticas, con `--json` |
| MCP | `omi mcp` | el mismo catálogo por stdio para otros agentes |

Códigos de salida: `0` ok, `1` error de ejecución o API, `2` error de uso o guardrail bloqueado.

## Desarrollo

Requiere Node 22.19 o superior. TypeScript corre sin transpilar desde el checkout.
No se distribuye por npm: Node no ejecuta TypeScript dentro de `node_modules`.
El paquete es privado para impedir publicaciones accidentales; la distribución para usuarios es el binario de release.

```sh
npm ci
npm run typecheck
npm test
npm run omi -- --help
```

## Licencia

MIT.
