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
| test | `npm test` | ~8 s. Mock de omi-api en `test/helpers/mock-omi.ts`. `smoke.test.ts` usa Pi y procesos reales y necesita `python3`. Necesita `fd` (o `fdfind`) y `rg` en el `PATH`: sin ellos Pi los baja de github.com y el guard de red falla. Los tests de `install.sh` abren zsh, bash y fish nuevos: sin uno, lo dejan dicho (`shell nuevo NO corrió`); con `OMI_REQUIRE_SHELLS=1`, como en `ci.yml`, fallan. Los 3 smoke de empaquetado se corren aparte |
| empaquetado | `npm run test:packaging` | ~45 s. Necesita `bun` y `python3`. Compila para el host, instala en un HOME temporal y verifica versión, assets de Pi, fd y rg incluidos, entorno de los hijos y cancelar el prompt en un pty. La primera vez baja fd y rg del host a `~/.cache/omi-code/tools` |
| censo de protocolo | `OMI_REPO=<checkout de chichex/omi> npm test` | ~6 s. Compara `src/protocol/constants.ts` con el código Go. Usarlo si cambió `src/protocol/` o el contrato con omi-api |
| release local | `node scripts/build-release.ts --out <dir>` | ~25 s. Las cuatro plataformas; `--targets` acota. Sin cache, baja los 8 assets de fd y rg (~14 MB); `--cache <dir>` cambia dónde quedan |
| plan de release | `node scripts/next-release.ts` | <1 s. Imprime `version=X.Y.Z`, o `version=` si nada empaquetado cambió desde el último tag |
| correr | `npm run omi -- --help` | <1 s |

## Ambientes

- **Local:** todo corre contra un mock efímero de omi-api. Los tests no usan credenciales reales.
- **Sin red en tests:** `npm test` precarga `test/helpers/no-network.ts`: corta las conexiones TCP/TLS de Node (`net.Socket#connect`) fuera de loopback, del archivo de test y de los hijos de Node que heredan su entorno, y hace fallar el archivo. Sus huecos están en «Límites conocidos». Un hijo con Pi interactivo y HOME nuevo lleva `PI_TELEMETRY=0`; `PI_OFFLINE` apaga además la KB y GitHub.
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
4. `npm run test:packaging`, si cambió algo empaquetado (`src/`, `bin/`, `package.json`, `install.sh`, `scripts/build-release.ts`, `scripts/bundled-tools.*`).
5. Los dos gates de abajo (`node scripts/gate-commits.ts <base>` y `node scripts/gate-max-lines.ts <base>`).

Techo: tests contra un mock de omi-api. No hay cobertura automática contra una API real, ni forma de probar sin una persona el login ni nada contra `app.ohmyinfra.com`.

## Reglas de código

- **Commits convencionales:** `tipo(scope)?: resumen`, con tipos `feat`, `fix`, `refactor`, `test`, `docs`, `style`, `chore`, `ci`, `build`, `perf` y `revert`. Gate: `node scripts/gate-commits.ts <base>`, donde `<base>` es el branch o commit contra el que se revisa. Por ejemplo, `node scripts/gate-commits.ts origin/main`. Imprime `CONVENTIONAL_COMMITS=PASS` o lista los commits inválidos y sale con 1.
- **Máximo 500 líneas por archivo `.ts`** que no sea de test. Gate: `node scripts/gate-max-lines.ts <base>`. Imprime `MAX_LINES=PASS` o una línea `FALLA <archivo> (<líneas> > 500)` por archivo y sale con 1.
- Los gates son scripts para que sean comandos simples: con Foundations y reglas, una línea con `;`, `|`, `$( )` o comillas pide sí. Escribir la base literal, sin variables: `node scripts/gate-commits.ts "$BASE"` lleva comillas.
- **Tests primero** cuando hay código, con rojo previo. Prohibido debilitar un test para que pase.
- **Políticas de código:** `docs/coding-policies.md` (secciones Clean Code y TypeScript). Las juzga la review: no tienen gate.
- Un cambio vale por lo que pide. No mezclar arreglos que nadie pidió.

## Nunca sin una persona

Esto no lo hace un agente solo, con cualquier instrucción:

- **Pushear a `main`**, ni siquiera a un branch con ese nombre de destino, y **forzar un push** (`--force`, `-f` o un refspec con `+`). Todo va por PR.
- **Mergear sin el sí de la persona.** El merge a `main` es la decisión humana de publicar: dispara el release. En omi se mergea con `omi_pr_merge`, que le muestra el PR a la persona y le pide el sí en pantalla; nunca con `gh pr merge` ni con la API desde bash. Otro agente mergea sólo si la persona se lo pide para ese PR.
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
- **Instalación limpia.** Trae las extensiones e integraciones builtin de OMI, sin skills ni descarga o instalación de paquetes en el home al arrancar. No agrega paquetes a los ajustes ni cambia el modelo predeterminado del usuario. Las credenciales del shell enumeradas en `PROVIDER_CREDENTIALS` se sacan del host (`hideFromHost`) y vuelven en `childEnvironment` para los comandos, no para Claude Bridge; un test vigila las que sondea cada proveedor de Pi. Sin telemetría de Pi: el host corre con `PI_TELEMETRY=0` (`overrideInHost`), que gana sobre el shell y sobre `enableInstallTelemetry`. Pi no avisa a pi.dev al instalarse ni al actualizarse, y la sesión no manda sus headers de atribución (por ejemplo, a OpenRouter). No cubre otros pedidos a pi.dev: la consulta de versión con `OMI_TUI=classic` y el refresh del catálogo de modelos con un proveedor configurado. Los comandos ven el `PI_TELEMETRY` del usuario. Lo vigila un arranque interactivo detrás de un proxy local, también con el binario.
- **fd y rg incluidos.** Pi no los baja de GitHub: la release los trae en `<runtime>/bin`, con sus licencias en `<runtime>/licenses`. `scripts/bundled-tools.json` fija versión, URL y SHA-256 por plataforma; `build-release.ts` los verifica (falla cerrado) y los guarda en un cache por hash. Cada descarga tiene hasta 4 intentos, con esperas de 1, 2 y 4 s: reintenta un corte de red, un timeout o un HTTP 408, 429 o 5xx. Otro 4xx o un hash distinto fallan a la primera. Al arrancar, un binario instalado los enlaza en `<OMI_HOME>/agent/bin`, que Pi revisa antes que el `PATH` (`src/tui/managed-tools.ts`). Sólo los que faltan: si el `PATH` del usuario trae `fd`, `fdfind` o `rg`, gana el suyo y se saca el enlace propio. No toca un archivo que Pi ya bajó ni un enlace ajeno. El enlace es relativo desde la ruta real de `<agent>/bin`, así sirve con `<agent>` como symlink (stow, dotfiles). Si no se puede enlazar, omi avisa por stderr y arranca igual: Pi usa los del `PATH` o los baja. Bash los ve porque recibe `<agent>/bin` adelante, como con las descargas de Pi; los comandos del Runner ven el `PATH` del usuario. En desarrollo no se enlaza nada. No se refirman en macOS: arm64 trae la firma ad hoc del linker intacta y x64 no la necesita. Subir una versión: bajar los 8 assets una vez, calcular su SHA-256 y compararlo con el `digest` de la API de GitHub (ripgrep publica además `.sha256`), editar el manifiesto y correr `npm test`, `npm run test:packaging` y la release local de las cuatro plataformas. Lo vigila el smoke de empaquetado: arranque interactivo sin fd ni rg en el `PATH`, detrás de un proxy que corta todo.
- **Claude Bridge incluido.** `pi-claude-bridge@0.13.0` se distribuye como builtin `omi-claude-bridge`, con su catálogo incluido también con `--offline` o `--no-mcp`. Se desactiva con `extensions: ["-builtin:omi-claude-bridge"]` en los ajustes o con `--no-extensions`. Usa Claude Code externo, que OMI no instala. La configuración global vive en `<OMI_HOME>/agent/claude-bridge.json` (por defecto `~/.omi/agent/claude-bridge.json`); se respeta `provider.pathToClaudeCodeExecutable`. En una instalación limpia, sin ejecutable disponible en esa ruta o en `PATH`, no se anuncia el bridge como disponible/autenticado ni se autoselecciona. La detección es local del ejecutable: no consulta la red ni valida login. Sin CLI se registra un catálogo legacy vacío, que prevalece sobre `models.json` y mantiene seguros los snapshots provisionales de Pi; no alcanza con filtros/auth asíncronos. El bundle sigue distribuido y reiniciar OMI o `/reload` después de instalar Claude Code registra sus modelos. No configurar una `apiKey` para `claude-bridge` en `models.json`/`auth.json`: su auth es externa; declarar una clave en Pi no verifica ejecutable ni login. Se selecciona `claude-bridge/...` desde `/model`, no `anthropic/...` ni `/login` de Pi. En la CLI se usan IDs con proveedor, porque un ID Claude solo puede ser ambiguo si ambos están disponibles.
- **Autenticación soportada del bridge.** Claude Code externo con `claude auth login` fuera de OMI, o `CLAUDE_CODE_OAUTH_TOKEN` como variable propia de Claude Code. La sesión y sus credenciales están en `~/.claude` (o `CLAUDE_CONFIG_DIR`). OMI fuerza `settingSources: []`: intencionalmente no carga ajustes ni hooks de usuario o proyecto de Claude Code. No soporta autenticación basada en `settings.json`, su sección `env` ni `apiKeyHelper`, ni flujos Bedrock/Vertex. Las credenciales del shell ocultas por `isolatePi` no se reinyectan en el bridge: por ejemplo `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `AWS_ACCESS_KEY_ID`, `AWS_PROFILE` y `GOOGLE_APPLICATION_CREDENTIALS` (lista no exhaustiva; no implica ocultar todas las `AWS_*`). Selectores como `CLAUDE_CODE_USE_BEDROCK` pueden heredarse, sin convertir ese flujo en soportado. Usar un entorno de suscripción para el bridge y un proveedor nativo de Pi configurado explícitamente para API/cloud. No reinyectar secretos ni habilitar hooks para sortear el aislamiento.
- **Arranque del harness de desarrollo.** Ante un pedido de cambio de código que vale la pena seguir, el agente llama a `omi_work_begin`. Una tool no puede cambiar de sesión, así que el pedido viaja en un comando interno (`/omi-work begin <token>`) con un token de un solo uso que vive en memoria. Sin issue, OMI clasifica el pedido antes de crear recursos: un cambio simple o dudas vuelven al chat original, sin activar harness ni conceder permisos. Los criterios viven por repo en `omi-development-triage` en las perillas de la KB; no se basan en líneas medidas del diff. Si amerita harness, crea el issue y reutiliza el triage para preparar worktree y sesión, sin preguntar; con `arranque: ask` en Foundations, antes pide un único sí. Sin Foundations ningún punto del harness pregunta (arranque, receta, comandos, push y PR draft): Foundations pone cada uno en `ask`. Lo que falta configurar sí se ofrece solo (al entrar al harness, en una sesión interactiva nueva y, para el lifecycle, al publicar el PR draft), con «Más adelante» por revisión; `/omi-setup` lo corre a pedido. Pedido del dueño (2026-11-23). Un issue existente siempre usa harness y su número; retomar no reclasifica ni duplica recursos. `/omi-triage` y `/omi-work start` se borraron a pedido del dueño (2026-11-17): no hay una entrada manual para empezar, y restaurar o recargar una sesión no vuelve a arrancar nada.
- **Importar desde Pi** pregunta por grupo y Enter sólo copia lo inofensivo; credenciales, ajustes con código externo y los que reemplazan a los de omi piden un sí explícito. El criterio: importar, borrar `~/.pi` y que omi siga igual.
- **Release continuo.** Sólo publica lo que cambia el binario (`isPackaged` en `scripts/next-release.ts`): primero se miran las rutas y después el tipo de commit. Antes de 1.0 lo incompatible sube el minor. Volver atrás es mergear un `revert:`; `omi upgrade` sólo sube de versión.
- **`cierre` obligatorio.** La CI de un PR abierto con `GITHUB_TOKEN` queda en `action_required` sin correr, y un `cierre` de `workflow_dispatch` no cuenta para la protección. `bump-pi.yml` publica el check por la API tras correr los mismos gates; el bump de Pi deja el merge a una persona.
- **Bun:** `rl.question` queda pendiente al cerrar el readline; por eso existe `askOrCancel`. Con Node no se reproduce: lo cubre el smoke de empaquetado con un pty real. Además, `spawnSync` sin `env` busca el comando y arma el entorno del hijo con el `PATH` y las variables con que arrancó el proceso, no con `process.env` (bun 1.3.13). Por eso fd y rg se enlazan en `<agent>/bin` en lugar de sumarse al `PATH`.
- **PTY en macOS:** un hijo que muere con salida sin leer en el PTY queda trabado en exit (estado `E`), y un `waitpid` que no lee el master espera para siempre. En Linux no pasa. Por eso el driver de `test/helpers/startup-network.ts` lee hasta el final, espera con límite y cierra el master. Un cuelgue así colgó el job `macos` de `release.yml` hasta los 300 s.

## Límites conocidos

- Depende de `chichex/omi#140` para funcionar contra producción.
- Los guardrails locales no aíslan a un agente con bash y acceso al Bearer. Riesgos aceptados y diferidos: aislamiento del CLI en el issue #5 y confianza de aprobación de MCP en el #6.
- El contrato de `/version` se verifica estático al publicar (`git grep`); OMI no lo valida.
- Sin confirmar si el proveedor invalida el refresh token viejo al copiar `auth.json` con OAuth; por eso el aviso dice «puede».
- En desarrollo (`npm run omi`), sin `fd` o `rg` en el `PATH` ni en `<OMI_HOME>/agent/bin`, Pi todavía los descarga de GitHub. El binario instalado no.
- El aislamiento cubre la configuración de agentes, no todo el home (por ejemplo `~/.cache/huggingface/token`). Sin repo git, Pi sube hasta `/` buscando `.agents/skills`.
- `models.json` o `auth.json` con una referencia a una variable oculta (`$GEMINI_API_KEY`) no la resuelven.
- Importar no cubre symlinks absolutos hacia `~/.pi`, rutas fuera de `~/.pi/agent` ni paquetes de terceros con `~/.pi` en su código.
- El guard de red de `npm test` sólo ve `net.Socket#connect` en procesos Node que cargan el preload. No cubre DNS (`dns.lookup`, `dns.resolve*`), UDP (`dgram`), hijos que no son Node (`curl`, `gh`, `python3`; `git` sólo usa transportes locales porque el preload fija `GIT_ALLOW_PROTOCOL=file`), el binario de bun ni hijos lanzados con un entorno explícito sin `NODE_OPTIONS`. Si un hijo conecta después del `after` de su archivo, la conexión se corta pero sólo queda en stderr.
- `release.yml` pasa los binarios entre jobs como un artifact de 283 MB que expira en un día. Sin confirmar el límite de almacenamiento de Actions: si se llena, falla el build y no se publica nada.
