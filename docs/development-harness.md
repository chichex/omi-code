# Harness de desarrollo · hasta PR draft

Primer corte para **repos existentes con issues de GitHub**, sobre sesiones y tools nativas de Pi. Implementa Directa, Diagnóstico y Con spec. No incluye Fundación, prototipos descartables, perfiles/fallbacks de modelos, Review externa, Land ni Ship.

## Entrar y continuar

1. En Issues, preparar o retomar un issue con `/omi-triage N`.
2. Dentro de su worktree, ejecutar `/omi-work start`.
3. Autorizar la exploración. El agente lee código y entrega una receta; no obtiene permiso de editar por iniciar el flujo.
4. Responder preguntas y aprobar la receta completa en la UI. La aprobación incluye los comandos exactos de los casos y commits locales, no un push.
5. El agente implementa, verifica y pide otro consentimiento para publicar la rama y abrir un PR draft.

`/omi-triage` conserva su contrato anterior: prepara worktree/sesión y no inicia implementación. El harness es opt-in; sus tools empiezan inactivas y no se imponen a todas las conversaciones.

| Comando humano | Efecto |
|---|---|
| `/omi-work start` | Crear un trabajo o contrastar/retomar el existente, sin duplicarlo. Necesita GitHub para leer la fuente vigente. |
| `/omi-work resume` | Adoptar explícitamente el estado guardado; no repite comandos ya hechos. Si estaba pausado, reanuda sin conceder aprobaciones. |
| `/omi-work approve` | Aprobar receta/spec vigente y agregar su artefacto al issue. Revalida fuente y código explorado. |
| `/omi-work pause` | Pausar conservando fase, decisiones, archivos y evidencia. |
| `/omi-work refresh` | Volver a leer el pedido y explorar; invalida receta, decisiones y pruebas activas. También reabre un trabajo que el agente cerró sin cambio. Si lo propone el agente, pide confirmación. |
| `/omi-work pr` | Revalidar y pedir permiso remoto para comentario de evidencia, push normal y PR draft. |
| `/omi-work status` | Consultar el estado sin llamar al modelo. |
| `/omi-work stop` | Salir explícitamente del flujo y restaurar las tools normales del chat, sin borrar ni revertir archivos. |
| `/omi-progress` | Detalle del progreso en el workspace TUI, también con la lateral oculta. |

Restaurar una sesión o recargar OMI **no ejecuta** pruebas, modelo, commits ni publicaciones. `resume` es una acción humana explícita. En offline se puede restaurar/consultar el estado local; contrastar el pedido, aprobar una receta nueva o publicar necesita GitHub. En el modo clásico se conserva el status y `/omi-work status`, no el panel del workspace.

## Etapas y rutas

- **Explorar:** referencias a archivos/líneas leídos por tools y todavía vigentes, hallazgos, enfoque, base faltante y dependencias. El inspector permite consultar diff, hasta 20 commits y hasta 20 issues abiertos/cerrados mediante una búsqueda por título; no es un censo exhaustivo de duplicados. Una búsqueda fallida no se presenta como vacía exitosa.
- **Resolver inferencias:** checkpoint explícito, incluso con lista vacía. Cada inferencia tiene tipo qué/cómo, recomendación, confianza y reversibilidad. Umbral inicial fijo: 80/100. Las del cómo sin evidencia y las irreversibles siempre requieren respuesta humana. La confianza es una estimación del agente, no una probabilidad calibrada.
- **Receta:** tipo, tamaño, riesgo y ejecutor, objetivo, enfoque, alcance/fuera de alcance, casos D y comandos exactos, lentes. Inline por defecto; delegación por las primitivas existentes, hasta cuatro escritores y respetando el tope de la receta. El filesystem sigue siendo compartido: no hay reservas ni sandbox por archivo.
- **Directa:** trabajo chico con causa/enfoque entendido; genera un paso C1 sin spec pesada.
- **Diagnóstico:** bug sin causa conocida. Pide reproducción observada y causa; después el arreglo sigue como Directa o Con spec según su tamaño. No habilita arreglos durante el diagnóstico.
- **Con spec:** trabajo grande. Exige por qué, pasos C con cobertura explícita de todos los D y playbook humano antes de aprobar.
- **Implementar:** un C activo por vez, test rojo real, mismo comando verde, commit convencional nuevo por paso. No se completa un paso mediante texto del modelo.
- **Verificar:** cada D con su comando aprobado, salida/exit code y contenido actuales; gates ejecutados y lentes solicitados. Seguridad y Cumplimiento son obligatorios con riesgo alto. Los lentes son llamadas de sólo lectura, sin tools ni conversación del implementador; no sustituyen la Review externa del PR. Un resultado inválido, incompleto o cancelado no aprueba el lente. Un lente que falló no se repite sobre el mismo contenido: hay que corregir en otra vuelta. Cada lente corre hasta tres veces por contenido.
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
- Hay hasta tres vueltas de corrección. Reintentar invalida pruebas activas y conserva sus resultados en un archivo de intentos anteriores; no pueden acreditar la nueva vuelta. Los pasos ya commiteados siguen hechos y la vuelta agrega un paso de corrección `C<n>` que cubre todos los D, con su propio rojo, verde y commit. Se mantiene la aprobación sólo si pedido, receta y spec son exactamente los mismos.
- Cambiar el pedido invalida receta/aprobación/pruebas cuando se contrasta con GitHub, en los checkpoints de inicio/retoma, planificación, aprobación y publicación. Si el alcance cambia en chat, hay que pausar, actualizar el issue y hacer `refresh`; no tratarlo como un cambio silencioso del Cómo.

Mientras el flujo está activo, shell arbitrario, tools desconocidas y operaciones OMI no están habilitadas por el harness. Edit/write requieren receta aprobada y C activo, con paths relativos dentro del checkout (sin `~` ni `file://`, que Pi expandiría afuera) y sin metadata Git ni rutas evidentes de secretos. El commit del paso trata sus paths como literales, no como pathspecs. Las tools conservan el pipeline y hooks de Pi. **No es una frontera de seguridad:** comparte usuario, filesystem y credenciales; un comando aprobado ejecuta código arbitrario con esos permisos. No reemplaza aislamiento del sistema operativo ni los guardrails de OMI. Las reglas del proyecto prevalecen.

## Persistencia, sesiones y recuperación

El trabajo se guarda en `<git-common-dir>/omi/development/N.json`, separado de `.omi/project.json` y de las fases de preparación de `/omi-triage`. No requiere vincular el repo a un proyecto de infraestructura OMI.

- Esquema versionado, identidad completa de issue/checkout/base, revisión optimista, archivo 0600, escritura atómica y lock exclusivo con PID/host.
- No se siguen symlinks para el estado. Registro corrupto, recurso perdido o checkout ajeno no se reemplazan automáticamente.
- Los locks abandonados no se roban por antigüedad. Una persona verifica el proceso/host antes de retirarlos.
- La conversación guarda un vínculo al trabajo y a su revisión. Una rama de conversación atrasada no adopta silenciosamente cambios de otra ventana; exige `resume`.
- Las tareas de subagentes siguen siendo efímeras. Lo durable es el trabajo, no un proceso vivo ni un job remoto.

Los cambios externos del filesystem no se revierten. Una operación ejecutada sin recibo por cierre abrupto requiere inspección y revalidación, no replay automático.

## GitHub sin sobrescribir el pedido

GitHub no ofrece un CAS efectivo para reemplazar el body del issue con `gh issue edit`. Por eso **la fuente humana se conserva intacta**: receta/spec y evidencia se agregan como comentarios append-only administrados, no como reemplazo de la descripción. La evidencia publicada lleva comando, exit code, HEAD y fingerprint; la salida de los comandos queda sólo en el estado local, porque nadie la revisa antes de publicar. Se deduplican por identidad, autor y contenido exacto; un POST ambiguo se intenta recuperar antes de repetirlo. No se editan comentarios ajenos.

La publicación guarda un recibo pendiente antes del push, valida repositorio/origin/branch y usa el SHA inmutable aprobado, sin force ni tags. Recupera sólo un draft abierto de esa rama/base/SHA con identidad y cuerpo exactos de este trabajo. Un PR ajeno o editado por una persona requiere intervención; no se sobrescribe ni se duplica. Los artefactos obligatorios se publican completos o fallan pidiendo dividir la tarea; no se aprueba una spec silenciosamente truncada.

No hay garantía de atomicidad entre cambios humanos del issue y todas las acciones posteriores de Git/GitHub. Los checkpoints detectan cambios; no hay lock distribuido sobre la intención de la persona.

## Progreso en la TUI

`PROGRESO · #N` muestra ruta, etapa, actividad, pasos, checks observados y bloqueos. Los eventos de lectura, comandos, preguntas y lentes actualizan la actividad sin esperar el refresco de recursos. El detalle incluye preguntas, evidencia, lentes e intentos anteriores. No convierte una tool exitosa ni un workflow verde de Actions en aprobación del PR.

El panel sólo pertenece al cwd/worktree/rama correctos, se reinicia al cambiar de sesión/árbol y prioriza bloqueos en panes bajos. Reemplaza el bloque Issue activo mientras hay un trabajo y respeta su visibilidad en Personalizar lateral; conserva Sesión, recursos y las demás preferencias. Usa el mismo renderer, temas y modales del workspace, sin otra interfaz web.

## Verificación del cambio

Los tests nuevos cubren las tres rutas con Git y comandos reales en repos temporales, modelos/GitHub falsos, consentimientos, invalidación, evidencia, recuperación, concurrencia, cancelación y panel estrecho/claro/oscuro. El empaquetado comprueba el binario instalado. No equivalen a una prueba contra GitHub/OMI real ni a una evaluación de calidad de modelos: esas pruebas requieren una persona.
