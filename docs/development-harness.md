# Harness de desarrollo · hasta PR draft

Primer corte para **repos existentes con issues de GitHub**, sobre sesiones y tools nativas de Pi. Implementa Directa, Diagnóstico y Con spec. No incluye Fundación, prototipos descartables, perfiles/fallbacks de modelos, Review externa, Land ni Ship.

## Empezar y continuar

1. Pedí en el chat un cambio de código del repo que valga la pena seguir: feature, fix, mejora o chore con impacto. Preguntas, explicaciones, operaciones de OMI y cambios triviales que pedís hacer directo siguen en el chat normal, sin harness ni issue.
2. El agente propone empezar con la tool `omi_work_begin`:
   - si el pedido nombra un issue (`#N`), con ese issue;
   - si no, con un título y un cuerpo para crear uno. La sesión nueva no hereda el chat, así que el cuerpo tiene que traer el pedido completo.

   La tool no crea nada: deja un pedido de un solo uso, ligado a la sesión, y termina el turno. Si el agente la llamó junto con otras tools, Pi le da una respuesta más antes de terminar. Mientras el pedido espera el sí, el resto de las tools del agente quedan bloqueadas. Un Esc en ese turno descarta el pedido sin preguntar.
3. OMI te pide **un solo sí**. El diálogo dice primero qué va a pasar. Si el issue es nuevo, lo muestra completo al final (repo, título y cuerpo). Dice también quién lo pidió: el motivo del agente, o que vino del panel de Issues. Lo que se puede comprobar sin efectos falla antes de preguntar:
   - el tamaño del pedido;
   - caracteres invisibles o de dirección de texto en el título o el cuerpo;
   - la identidad de una preparación guardada (también una anterior al registro, que se reconoce por su sesión), y que su worktree y su sesión sigan ahí;
   - que exista `main` local;
   - que la ruta del worktree no sea ajena;
   - el modo offline (`--offline` o `PI_OFFLINE`); en ese caso el panel tampoco ofrece Enter;
   - la falta de modelo o de confianza.
4. Si aceptás:
   - se crea el issue, si hace falta;
   - se clasifica el issue;
   - se prepara un worktree desde `main` local, con su propia sesión;
   - se cambia a esa sesión y el trabajo sigue en Explorar.

   Si decís que no, no se crea issue, worktree, sesión ni trabajo.
5. Explorar no habilita escrituras. Respondé las preguntas y aprobá la receta completa en la UI. La aprobación incluye los comandos exactos de los casos y los commits locales, no un push. La revisión TUI abre en un resumen humano y permite inspeccionar íntegramente los detalles y los comandos, que después corren sin volver a preguntar. Si volvés/cancelás, el agente puede rehacer la receta conservando la exploración y las respuestas.
6. El agente implementa, verifica y pide otro consentimiento para publicar la rama y abrir un PR draft.

**Enter iniciar trabajo** (o **retomar trabajo**) en el panel de Issues y «Trabajar en el issue seleccionado» en la paleta entran por el mismo camino y piden el mismo sí. Si el issue ya tenía worktree y sesión, se retoman sin reclasificar ni volver a leer sus etiquetas. Un trabajo guardado sigue desde su etapa, sin duplicarse, y el diálogo dice en cuál está. Si estaba pausado, el diálogo lo avisa y el sí lo reanuda, como `/omi-work resume`, sin conceder aprobaciones. Si algo falla después de crear el issue, el aviso trae su número: hay que pedir ese issue, no crear otro.

No hay un comando para empezar: `/omi-triage` y `/omi-work start` ya no existen. Una tool no puede cambiar de sesión, así que el pedido viaja como un comando interno con un token de un solo uso, que vive sólo en la memoria del proceso. Escribir ese comando a mano, sin un token vigente, no hace nada. Con el harness activo, `omi_work_begin` no se ofrece. Un arranque y `/omi-main` no corren a la vez: los dos cambian de sesión.

| Comando humano | Efecto |
|---|---|
| `/omi-work resume` | Adoptar explícitamente el estado guardado; no repite comandos ya hechos. Si estaba pausado, reanuda sin conceder aprobaciones. |
| `/omi-work approve` | Aprobar receta/spec vigente y agregar su artefacto al issue. Revalida fuente y código explorado. |
| `/omi-work pause` | Pausar conservando fase, decisiones, archivos y evidencia. |
| `/omi-work refresh` | Volver a leer el pedido y explorar; invalida receta, decisiones y pruebas activas. También reabre un trabajo que el agente cerró sin cambio. Si lo propone el agente, pide confirmación. |
| `/omi-work pr` | Revalidar y pedir permiso remoto para comentario de evidencia, push normal y PR draft. |
| `/omi-work status` | Consultar el estado sin llamar al modelo. |
| `/omi-work stop` | Salir explícitamente del flujo y restaurar las tools normales del chat, sin borrar ni revertir archivos. También sale de un harness bloqueado (estado inválido o atrasado) sin tocar el estado guardado. |
| Ctrl 6 / `/omi-workflow` | Pantalla 6 · Progreso: recorrido completo de sólo lectura, también con la lateral oculta. |
| `/omi-progress` | Detalle del progreso en el workspace TUI, también con la lateral oculta. |

Restaurar una sesión o recargar OMI **no ejecuta** pruebas, modelo, commits ni publicaciones. `resume` es una acción humana explícita. En offline se puede restaurar/consultar el estado local; empezar, contrastar el pedido, aprobar una receta nueva o publicar necesita GitHub. Para abrir offline la sesión de un issue preparado, usá `/resume` de Pi. En el modo clásico se conserva el status y `/omi-work status`, no el panel del workspace.

## Revisar y aprobar una receta

La TUI presenta una revisión dedicada, no un volcado JSON en un confirm genérico. Abre en **Resumen** con issue, objetivo, qué cambia, alcance, tipo, ruta, tamaño, riesgo y ejecutor. Las secciones **Enfoque**, **Alcance**, **Pasos**, **Pruebas**, **Inferencias**, **Spec**, **Autorización** y **Fuente** conservan los detalles completos. Las huellas técnicas quedan en Fuente, no como contenido principal.

- **←/→**, **Tab / Shift+Tab**: cambiar de sección. **1–9**: ir directamente a una sección.
- **↑/↓**, **PgUp/PgDn**, **Home/End** y rueda: desplazar el cuerpo de la sección. El título informa posición y total; ayuda y decisiones quedan fuera del cuerpo desplazable.
- **Ctrl+S**: aprobar deliberadamente. **Enter no aprueba**. **Esc**, **Ctrl+C**, **Ctrl+D** o cerrar/abortar: volver sin conceder aprobación ni publicar comentarios. Se puede ajustar y revisar de nuevo sin perder exploración ni respuestas.
- **Pruebas** muestra cada caso con descripción y comando completo. `│` inicia una línea lógica, `↳` marca continuación visual y `↵` un salto real. No se pierden espacios al envolver comandos. Los backslashes se duplican (`\\` representa `\`); tabulaciones, retornos, controles y caracteres invisibles se muestran como escapes (`\t`, `\r`, `\uXXXX`), nunca como secuencias ejecutables del terminal. La leyenda de la sección los escribe igual que en los comandos. Navegar no ejecuta comandos ni exige visitar todas las secciones para habilitar el sí.
- El marco adapta ancho/alto al terminal y al tema vigente, incluidos 80×24 y resize. Si el pane ya no permite inspección (menos de 32 columnas de revisión o 14 filas de terminal), se suspende aprobar hasta ampliarlo; Esc sigue cancelando.

El sí autoriza **implementar, commits locales, comandos D exactos sin volver a preguntar y agregar el comentario administrado de receta al issue**. No autoriza push, merge, workflows ni deploy. Setup y otros comandos siguen requiriendo consentimiento aparte. La receta no tiene un tope propio de tamaño: la revisión navega por secciones. Antes del sí sólo se comprueba que el artefacto entre en GitHub; si no entra, falla pidiendo dividir el trabajo, no se resume en silencio para aprobarla.

En RPC, donde Pi no ofrece componentes TUI, se conserva una confirmación humana con el mismo documento completo organizado en texto, con los mismos escapes y marcadores `│`/`↵` en los comandos. Los modos sin UI no pueden aprobar. Tras revisar se vuelve a contrastar la fuente, el estado guardado y el código explorado; una revisión obsoleta no se convierte en aprobación de otra receta.

## Etapas y rutas

- **Explorar:** referencias a archivos/líneas leídos por tools y todavía vigentes, hallazgos, enfoque, base faltante y dependencias. El inspector permite consultar el diff completo (si es grande, por partes, con `diffPart`), hasta 20 commits y hasta 20 issues abiertos/cerrados mediante una búsqueda por título; no es un censo exhaustivo de duplicados. Una búsqueda fallida no se presenta como vacía exitosa.
- **Resolver inferencias:** checkpoint explícito, incluso con lista vacía. Cada inferencia tiene tipo qué/cómo, recomendación, confianza y reversibilidad. Umbral inicial fijo: 80/100. Las del cómo sin evidencia y las irreversibles siempre requieren respuesta humana. La confianza es una estimación del agente, no una probabilidad calibrada.
- **Receta:** tipo, tamaño, riesgo y ejecutor, objetivo, enfoque, alcance/fuera de alcance, casos D y comandos exactos, lentes. Inline por defecto; delegación por las primitivas existentes, hasta cuatro escritores y respetando el tope de la receta. El filesystem sigue siendo compartido: no hay reservas ni sandbox por archivo.
- **Directa:** trabajo chico con causa/enfoque entendido; genera un paso C1 sin spec pesada.
- **Diagnóstico:** bug sin causa conocida. Pide reproducción observada y causa; después el arreglo sigue como Directa o Con spec según su tamaño. No habilita arreglos durante el diagnóstico.
- **Con spec:** trabajo grande. Exige por qué, pasos C con cobertura explícita de todos los D y playbook humano antes de aprobar.
- **Implementar:** un C activo por vez, test rojo real, mismo comando verde, commit convencional nuevo por paso. No se completa un paso mediante texto del modelo.
- **Verificar:** cada D con su comando aprobado, salida/exit code y contenido actuales; gates ejecutados y lentes solicitados. Seguridad y Cumplimiento son obligatorios con riesgo alto. Los lentes son llamadas de sólo lectura, sin tools ni conversación del implementador; no sustituyen la Review externa del PR.
  - **Qué ven.** Los casos D, el alcance, el diff completo y la evidencia que registró el harness, no el modelo: por caso D su última verificación; por paso C su historial rojo→verde con comando, etiqueta, exit code, HEAD, fingerprint y la salida que ya se guarda. Un paso de una vuelta anterior trae su rojo y su verde acreditados, archivados.
  - **Asesoran, no bloquean.** Cada lente pedido tiene que correr sobre el contenido actual. Un `unknown` o un `fail` queda como aviso y no frena Verificar ni el PR draft. Única excepción: un `fail` de Seguridad bloquea hasta corregir en otra vuelta. Un resultado inválido, incompleto o cancelado queda como `unknown`.
  - **Sin tope de tamaño.** Si el diff no entra en una llamada, se reparte por archivo en partes de hasta 120.000 caracteres. Un archivo más grande se corta por líneas, con una etiqueta por fragmento. El lente corre por parte, con los casos y toda la evidencia en cada una, y se combina: el peor veredicto gana (`fail`, `unknown`, `pass`) y se juntan los hallazgos con su parte. Nada se trunca en silencio.
  - **Corridas.** Un lente que falló no se repite sobre el mismo contenido, salvo que un `refuter` posterior apruebe: así un aviso no se borra repitiendo el lente y el fail de Seguridad no se esquiva. Por contenido, cada lente admite tres veredictos y diez corridas: cancelar o un error del proveedor no gasta veredictos.
- **PR:** sólo con cambio limpio y verificado, confirmación humana remota y un SHA autorizado. Termina en un draft; no mergea ni cierra el issue.

Base incompleta, dependencia bloqueante, información insuficiente, inferencia nueva o imposibilidad de verificar deben quedar como espera/pausa. En este corte, Fundación no se ejecuta: la persona completa la base y usa `refresh`.

## Evidencia y permisos

`omi_workflow` sólo recibe propuestas de artefactos y acciones. No acepta exit codes, aprobaciones humanas ni resultados de pruebas aportados por el modelo.

- Los comandos se ejecutan con `omi_workflow_check`. Antes de aprobar la receta, una reproducción necesita consentimiento explícito; ejecutar código de un repo no es una lectura inocua.
- Los comandos de casos D visibles en la receta quedan autorizados al aprobarla. Otros comandos, incluido setup, necesitan consentimiento separado. Setup nunca acredita una prueba y sus errores se muestran.
- El runner registra salida acotada a 12.000 caracteres, exit code, interrupción, HEAD, fingerprint y tiempos. No imprime el entorno ni mensajes internos potencialmente sensibles del backend. La salida del propio programa puede contener datos sensibles: no autorizar comandos que revelen secretos.
- Un rojo que pasa, comando ausente, cancelación o contenido modificado durante el comando no se convierte en prueba válida. Los intentos fallidos quedan registrados sin habilitar pasos.
- El fingerprint representa contenido cambiado desde la base y archivos nuevos no ignorados, incluidos modos/eliminaciones/symlinks. Permanece estable al hacer stage/commit del mismo contenido.
- Las pruebas de cada paso y su commit deben coincidir. La verificación final debe corresponder al contenido actual; un verde histórico o un comando distinto no alcanza.
- Hay hasta tres vueltas de corrección. Reintentar invalida pruebas activas y conserva sus resultados en un archivo de intentos anteriores; no pueden acreditar la nueva vuelta. Los pasos ya commiteados siguen hechos y la vuelta agrega un paso de corrección `C<n>` que cubre todos los D, con su propio rojo, verde y commit. Ese paso conserva la aprobación porque usa los mismos casos y comandos aprobados; su título lo escribe el agente y la persona no lo aprueba aparte. Se mantiene la aprobación sólo si pedido, receta y spec son exactamente los mismos.
- Cambiar el pedido invalida receta/aprobación/pruebas cuando se contrasta con GitHub, en los checkpoints de inicio/retoma, planificación, aprobación y publicación. Si el alcance cambia en chat, hay que pausar, actualizar el issue y hacer `refresh`; no tratarlo como un cambio silencioso del Cómo.

Mientras el flujo está activo, shell arbitrario, tools desconocidas y operaciones OMI no están habilitadas por el harness. Edit/write requieren receta aprobada y C activo, con paths relativos dentro del checkout (sin `~` ni `file://`, que Pi expandiría afuera) y sin metadata Git ni rutas evidentes de secretos. Código como `credentials.ts` y plantillas como `.env.example` sí se pueden editar. El commit del paso trata sus paths como literales, no como pathspecs. Las tools conservan el pipeline y hooks de Pi. **No es una frontera de seguridad:** comparte usuario, filesystem y credenciales; un comando aprobado ejecuta código arbitrario con esos permisos. No reemplaza aislamiento del sistema operativo ni los guardrails de OMI. Las reglas del proyecto prevalecen.

## Persistencia, sesiones y recuperación

El trabajo se guarda en `<git-common-dir>/omi/development/N.json`, separado de `.omi/project.json` y del registro de preparación del worktree (`<git-common-dir>/omi/issue-workspaces/N.json`). No requiere vincular el repo a un proyecto de infraestructura OMI.

- Esquema versionado, identidad completa de issue/checkout/base, revisión optimista, archivo 0600, escritura atómica y lock exclusivo con PID/host.
- No se siguen symlinks para el estado. Registro corrupto, recurso perdido o checkout ajeno no se reemplazan automáticamente.
- Los locks abandonados no se roban por antigüedad. Una persona verifica el proceso/host antes de retirarlos.
- La conversación guarda un vínculo al trabajo y a su revisión. Una rama de conversación atrasada no adopta silenciosamente cambios de otra ventana; exige `resume`.
- Las tareas de subagentes siguen siendo efímeras. Lo durable es el trabajo, no un proceso vivo ni un job remoto.

Los cambios externos del filesystem no se revierten. Una operación ejecutada sin recibo por cierre abrupto requiere inspección y revalidación, no replay automático.

## GitHub sin sobrescribir el pedido

Crear el issue de un pedido nuevo es la única escritura en GitHub antes de Explorar. Pasa sólo con el sí, una vez, con el título y el cuerpo que mostró el diálogo. Si GitHub no confirma la creación, no se reintenta: hay que revisar el repo antes de volver a pedirlo, para no duplicarlo.

GitHub no ofrece un CAS efectivo para reemplazar el body del issue con `gh issue edit`. Por eso **la fuente humana se conserva intacta**: receta/spec y evidencia se agregan como comentarios append-only administrados, no como reemplazo de la descripción. La evidencia publicada lleva comando, exit code, HEAD y fingerprint; la salida de los comandos queda sólo en el estado local, porque nadie la revisa antes de publicar. Se deduplican por identidad, autor y contenido exacto; un POST ambiguo se intenta recuperar antes de repetirlo. No se editan comentarios ajenos.

La publicación guarda un recibo pendiente antes del push, valida repositorio/origin/branch y usa el SHA inmutable aprobado, sin force ni tags. Recupera sólo un draft abierto de esa rama/base/SHA con identidad y cuerpo exactos de este trabajo. Un PR ajeno o editado por una persona requiere intervención; no se sobrescribe ni se duplica. Los artefactos obligatorios se publican completos o fallan pidiendo dividir la tarea; no se aprueba una spec silenciosamente truncada.

No hay garantía de atomicidad entre cambios humanos del issue y todas las acciones posteriores de Git/GitHub. Los checkpoints detectan cambios; no hay lock distribuido sobre la intención de la persona.

## Progreso en la TUI

`PROGRESO · #N` muestra ruta, etapa, actividad, pasos, checks observados y bloqueos. Los eventos de lectura, comandos, preguntas y lentes actualizan la actividad sin esperar el refresco de recursos. El detalle incluye preguntas, evidencia, lentes e intentos anteriores. No convierte una tool exitosa ni un workflow verde de Actions en aprobación del PR.

El recorrido usa el catálogo de fases del harness y sus decisiones reales de ruta, no una lista paralela del renderer. Incluye pendientes, fases condicionales (Diagnóstico/Spec antes de conocer la ruta), no aplicables y los finales alternativos PR draft abierto/cierre sin cambio. `>` identifica la actual; los símbolos y textos distinguen avance sin depender del color. Un rojo esperado no hace fallar Implementar; los checks fallidos o interrumpidos conservan su significado observado. Un aviso de lente marca Verificar como △ **Con avisos**, durante la etapa y después de cumplida; sólo un `fail` de Seguridad la marca como fallida. La lateral muestra cuántos avisos hay y la pantalla 6 y `/omi-progress` los listan, uno por lente. El artefacto del issue y el PR draft traen la sección **Avisos de los lentes**, con el estado de cada lente pedido y sus hallazgos.

**6 · Progreso**, por Ctrl 6, pestaña/clic, paleta o `/omi-workflow`, muestra el recorrido completo y separa **Previsto** de **Real**. Usa desplazamiento de la vista de sólo lectura (flechas, PgUp/PgDn, Home/End y rueda) y Esc vuelve a Chat. La lateral muestra las etapas cuando entran todas, nunca una lista parcial que oculte la actual; en panes bajos mantiene su resumen, bloqueos, contadores y los otros bloques, con acceso indicado a la pantalla 6, sin scroll lateral. `/omi-progress` conserva el detalle.

La receta sólo prevé el ejecutor de Implementar. El modo real se observa desde tools ejecutadas en la sesión principal y tareas efectivamente iniciadas, no desde consultas status/result/cancel ni lotes sólo en cola. Se admite combinación inline/subagente; los lentes de Verificar se rotulan como llamadas aisladas, sin inventar una llamada a la tool subagent. No se afirma exclusividad ni éxito de una tarea por conocer su modo. Los metadatos durables son booleanos acotados por fase/vuelta, sin tareas, prompts ni outputs privados. Los estados anteriores siguen legibles con modo «sin observar»; restaurar no vuelve a lanzar jobs. Refresh los invalida y los eventos tardíos no acreditan otro pedido/vuelta.

El panel sólo pertenece al cwd/worktree/rama correctos, se reinicia al cambiar de sesión/árbol y prioriza bloqueos en panes bajos. Reemplaza el bloque Issue activo mientras hay un trabajo y respeta su visibilidad en Personalizar lateral; conserva Sesión, recursos y las demás preferencias. Usa el mismo renderer, temas y modales del workspace, sin otra interfaz web.

## Verificación del cambio

El arranque tiene sus propios tests, con Git, worktrees y sesiones reales y con GitHub y modelo falsos: pedido nuevo con un solo sí, issue existente sin duplicar, decir que no, token de un solo uso, guardas sin efectos y recarga sin kickoff. Dos tests de pty real recorren los dos caminos. El del panel: Enter en Issues, el sí, Esc en la clasificación y el harness arrancado en el worktree. El del agente: un pedido en el chat, la tool, un turno que termina sin seguir, el sí antes de crear el issue y de clasificar, y el harness en el worktree del issue nuevo. Los lentes tienen tests con Git real: la evidencia que reciben, los avisos que no frenan el PR draft, el bloqueo por un fail de Seguridad y un diff de más de 200.000 caracteres revisado por partes sin truncar. Los tests del flujo cubren las tres rutas con Git y comandos reales en repos temporales, modelos/GitHub falsos, consentimientos, invalidación, evidencia, recuperación, concurrencia, cancelación y panel estrecho/claro/oscuro. La aprobación tiene cobertura específica de documento íntegro, comandos largos/multilínea y caracteres de control, navegación/resize/temas, decisiones negativas y revalidación durante la revisión. Una prueba con Pi en PTY real recorre 80×24, resize a 132×40 y vuelta, temas claro/oscuro, navegación hasta el final del comando, cancelar y aprobar explícitamente con GitHub falso; no es una evaluación visual humana. El empaquetado comprueba el binario instalado. No equivalen a una prueba contra GitHub/OMI real ni a una evaluación de calidad de modelos: esas pruebas requieren una persona.
