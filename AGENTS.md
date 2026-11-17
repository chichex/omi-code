# omi-code

Harness agéntico de codificación e infraestructura para OMI. CLI y TUI de `omi`, con un servidor MCP. Embebe Pi (`@earendil-works/pi-coding-agent`) y se distribuye como binario.

## Stack

- TypeScript ESM sobre Node 22.19 o superior, sin transpilar en desarrollo (type stripping nativo de Node).
- Tests con `node --test`. El probe de la plantilla Python usa `python3`: sólo verifica, el binario no lo necesita.
- Dependencias de runtime fijadas a versión exacta. Pi 1.5.1 satisface el mínimo requerido por `pi-claude-bridge@0.13.0`.
- El binario sale de `bun build --compile`.
- Sin superficie de diseño propia más allá de la TUI. La maqueta de referencia está en `design/` (ver `design/README.md`).

## Comandos

Todos corren desde la raíz del repo. Un worktree nuevo no trae `node_modules`: empezar con `npm ci`.

| Acción | Comando | Notas |
|---|---|---|
| deps | `npm ci` | ~5 s |
| typecheck | `npm run typecheck` | ~2 s |
| test | `npm test` | ~8 s. Mock de omi-api en `test/helpers/mock-omi.ts`. `smoke.test.ts` usa Pi y procesos reales y necesita `python3`. Los 3 smoke de empaquetado se corren aparte |
| empaquetado | `npm run test:packaging` | ~12 s. Necesita `bun` y `python3`. Compila para el host, instala en un HOME temporal y verifica versión, assets de Pi, entorno de los hijos y cancelar el prompt en un pty |
| censo de protocolo | `OMI_REPO=<checkout de chichex/omi> npm test` | ~6 s. Compara `src/protocol/constants.ts` con el código Go. Usarlo si cambió `src/protocol/` o el contrato con omi-api |
| release local | `node scripts/build-release.ts --out <dir>` | ~25 s. Las cuatro plataformas; `--targets` acota |
| plan de release | `node scripts/next-release.ts` | <1 s. Imprime `version=X.Y.Z`, o `version=` si nada empaquetado cambió desde el último tag |
| correr | `npm run omi -- --help` | <1 s |

## Ambientes

- **Local:** todo corre contra un mock efímero de omi-api. Los tests no usan credenciales reales.
- **Real:** `https://app.ohmyinfra.com`, con `chichex/omi#140` desplegado. Sin eso, `omi login` falla con `session_token_unavailable`.
- **Linux real:** el host `chichex-linux` sirve para probar el binario `linux-x64` en un HOME temporal.
- **Git:** branch default `main`, remote `origin` en `github.com/chichex/omi-code`. `main` está protegida: exige PR y el check `cierre`, también para admins.
- **CI:** `ci.yml` corre typecheck, test y empaquetado en cada PR. El check se llama `cierre`.
- **Release:** cada merge a `main` que cambie lo empaquetado publica. `release.yml` calcula la versión desde el último tag, repite los gates, prueba macOS, arranca el binario en las cuatro plataformas y crea el tag. El tag es la fuente de verdad: `package.json` se estampa sólo en CI.
- **Dry-run de release:** `gh workflow run release.yml --ref <rama> -f dry_run=true`. Corre el pipeline completo sin publicar (~5 min). Lo lanza una persona.
- **Review a pedido:** `gh workflow run claude-review.yml --repo chichex/omi-code -f pr=<N>`. Necesita el secret `CLAUDE_CODE_OAUTH_TOKEN` y consume cuota de Claude.

## Cómo verificar un cambio

1. `npm run typecheck`.
2. `npm test`.
3. `OMI_REPO=<checkout de chichex/omi> npm test`, si cambió `src/protocol/` o el contrato con omi-api.
4. `npm run test:packaging`, si cambió algo empaquetado (`src/`, `bin/`, `package.json`, `install.sh`, `scripts/build-release.ts`).
5. Los dos gates de abajo.

Techo: tests contra un mock de omi-api. No hay cobertura automática contra una API real, ni forma de probar sin una persona el login ni nada contra `app.ohmyinfra.com`.

## Reglas de código

- **Commits convencionales:** `tipo(scope)?: resumen`, con tipos `feat`, `fix`, `refactor`, `test`, `docs`, `style`, `chore`, `ci`, `build`, `perf` y `revert`. Gate (sin salida es PASS; `BASE` es el branch contra el que se revisa):

  ```sh
  git log --no-merges --format=%s "$BASE"..HEAD \
    | grep -Ev '^(feat|fix|refactor|test|docs|style|chore|ci|build|perf|revert)(\([a-z0-9-]+\))?!?: .+'
  ```

- **Máximo 500 líneas por archivo `.ts`** que no sea de test. Gate:

  ```sh
  fail=0
  git cat-file -e "$BASE^{commit}" 2>/dev/null || { echo "BASE inválido: $BASE"; exit 1; }
  for f in $(git diff --name-only --diff-filter=ACMR "$BASE"...HEAD -- '*.ts' | grep -Ev '\.test\.ts$'); do
    actual=$(wc -l < "$f")
    [ "$actual" -le 500 ] || { echo "FALLA $f ($actual > 500)"; fail=1; }
  done
  [ "$fail" -eq 0 ] && echo "MAX_LINES=PASS"
  ```

- **Tests primero** cuando hay código, con rojo previo. Prohibido debilitar un test para que pase.
- **Políticas de código:** `docs/coding-policies.md` (secciones Clean Code y TypeScript). Las juzga la review: no tienen gate.
- Un cambio vale por lo que pide. No mezclar arreglos que nadie pidió.

## Nunca sin una persona

Esto no lo hace un agente solo, con cualquier instrucción:

- **Pushear a `main`**, ni siquiera a un branch con ese nombre de destino, y **forzar un push** (`--force`, `-f` o un refspec con `+`). Todo va por PR.
- **Mergear.** El merge a `main` es la decisión humana de publicar: dispara el release.
- **Publicar a mano.** No empujar tags `vX.Y.Z` ni correr `gh release create`: el pipeline es el único camino.
- **Lanzar workflows de GitHub** (`gh workflow run`): el dry-run de release y la review a pedido gastan minutos de CI y cuota de Claude.
- **Commitear credenciales, tokens ni valores de secretos.** El valor de un secreto tampoco pasa por el contexto del modelo ni por la salida de un comando.
- **Desplegar, promover o migrar datos compartidos** de OMI sin confirmación.
- **Debilitar una verificación:** aflojar un assert, agregar `skip` u `only`, bajar un umbral o dejar como verificado algo que no corrió.

## Decisiones que no hay que deshacer

- `skipLibCheck: true`: `@google/genai`, transitiva de Pi, declara tipos contra un peer opcional de MCP y contra globals del DOM; sin eso `tsc` falla en `node_modules`. `moduleResolution: Bundler`: bun empaqueta el binario y los `.d.ts` de Pi importan JSON sin atributo.
- Overrides sólo para tests: `OMI_POLL_INTERVAL_MS`, `OMI_RELEASES_URL`, `OMI_INSTALL_BASE` y `OMI_PACKAGING_SMOKE`.
- En macOS un binario de bun muere con exit 137 hasta refirmarlo ad hoc: lo hacen `install.sh` y `omi upgrade`.
- `OMI_HOME` es una raíz absoluta; un binario instalado infiere la raíz por su ubicación. `PI_PACKAGE_DIR` es sólo del host y se quita de bash y Runner.
- **Instalación aislada.** Para el agente Pi, omi lee configuración sólo de `~/.omi/agent` y del proyecto (del cwd a la raíz del repo; sin repo, el cwd). `src/tui/isolation.ts` excluye `~/.agents/skills/**`, corre Pi con `--no-context-files` e inyecta sólo el contexto permitido (por ejemplo, el `AGENTS.md` del proyecto). Falla cerrado. `test/helpers/foreign-config.ts` mira el request real al proveedor y cubre los bumps de Pi.
- **Instalación limpia.** Trae las extensiones e integraciones builtin de OMI, sin skills ni descarga o instalación de paquetes en el home al arrancar. No agrega paquetes a los ajustes ni cambia el modelo predeterminado del usuario. Las credenciales del shell enumeradas en `PROVIDER_CREDENTIALS` se sacan del host (`hideFromHost`) y vuelven en `childEnvironment` para los comandos, no para Claude Bridge; un test vigila las que sondea cada proveedor de Pi.
- **Claude Bridge incluido.** `pi-claude-bridge@0.13.0` se distribuye como builtin `omi-claude-bridge`, con su catálogo incluido también con `--offline` o `--no-mcp`. Se desactiva con `extensions: ["-builtin:omi-claude-bridge"]` en los ajustes o con `--no-extensions`. Usa Claude Code externo, que OMI no instala. La configuración global vive en `<OMI_HOME>/agent/claude-bridge.json` (por defecto `~/.omi/agent/claude-bridge.json`); se respeta `provider.pathToClaudeCodeExecutable`. En una instalación limpia, sin ejecutable disponible en esa ruta o en `PATH`, no se anuncia el bridge como disponible/autenticado ni se autoselecciona. La detección es local del ejecutable: no consulta la red ni valida login. No configurar una `apiKey` para `claude-bridge` en `models.json`/`auth.json`: su auth es externa; declarar una clave en Pi no verifica ejecutable ni login. Se selecciona `claude-bridge/...` desde `/model`, no `anthropic/...` ni `/login` de Pi. En la CLI se usan IDs con proveedor, porque un ID Claude solo puede ser ambiguo si ambos están disponibles.
- **Autenticación soportada del bridge.** Claude Code externo con `claude auth login` fuera de OMI, o `CLAUDE_CODE_OAUTH_TOKEN` como variable propia de Claude Code. La sesión y sus credenciales están en `~/.claude` (o `CLAUDE_CONFIG_DIR`). OMI fuerza `settingSources: []`: intencionalmente no carga ajustes ni hooks de usuario o proyecto de Claude Code. No soporta autenticación basada en `settings.json`, su sección `env` ni `apiKeyHelper`, ni flujos Bedrock/Vertex. Las credenciales del shell ocultas por `isolatePi` no se reinyectan en el bridge: por ejemplo `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `AWS_ACCESS_KEY_ID`, `AWS_PROFILE` y `GOOGLE_APPLICATION_CREDENTIALS` (lista no exhaustiva; no implica ocultar todas las `AWS_*`). Selectores como `CLAUDE_CODE_USE_BEDROCK` pueden heredarse, sin convertir ese flujo en soportado. Usar un entorno de suscripción para el bridge y un proveedor nativo de Pi configurado explícitamente para API/cloud. No reinyectar secretos ni habilitar hooks para sortear el aislamiento.
- **Importar desde Pi** pregunta por grupo y Enter sólo copia lo inofensivo; credenciales, ajustes con código externo y los que reemplazan a los de omi piden un sí explícito. El criterio: importar, borrar `~/.pi` y que omi siga igual.
- **Release continuo.** Sólo publica lo que cambia el binario (`isPackaged` en `scripts/next-release.ts`): primero se miran las rutas y después el tipo de commit. Antes de 1.0 lo incompatible sube el minor. Volver atrás es mergear un `revert:`; `omi upgrade` sólo sube de versión.
- **`cierre` obligatorio.** La CI de un PR abierto con `GITHUB_TOKEN` queda en `action_required` sin correr, y un `cierre` de `workflow_dispatch` no cuenta para la protección. `bump-pi.yml` publica el check por la API tras correr los mismos gates; el bump de Pi deja el merge a una persona.
- **Bun:** `rl.question` queda pendiente al cerrar el readline; por eso existe `askOrCancel`. Con Node no se reproduce: lo cubre el smoke de empaquetado con un pty real.

## Límites conocidos

- Depende de `chichex/omi#140` para funcionar contra producción.
- Los guardrails locales no aíslan a un agente con bash y acceso al Bearer. Riesgos aceptados y diferidos: aislamiento del CLI en el issue #5 y confianza de aprobación de MCP en el #6.
- El contrato de `/version` se verifica estático al publicar (`git grep`); OMI no lo valida.
- Sin confirmar si el proveedor invalida el refresh token viejo al copiar `auth.json` con OAuth; por eso el aviso dice «puede».
- El aislamiento cubre la configuración de agentes, no todo el home (por ejemplo `~/.cache/huggingface/token`). Sin repo git, Pi sube hasta `/` buscando `.agents/skills`.
- `models.json` o `auth.json` con una referencia a una variable oculta (`$GEMINI_API_KEY`) no la resuelven.
- Importar no cubre symlinks absolutos hacia `~/.pi`, rutas fuera de `~/.pi/agent` ni paquetes de terceros con `~/.pi` en su código.
- `release.yml` pasa los binarios entre jobs como un artifact de 283 MB que expira en un día. Sin confirmar el límite de almacenamiento de Actions: si se llena, falla el build y no se publica nada.
