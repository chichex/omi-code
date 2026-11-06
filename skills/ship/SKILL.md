---
name: ship
description: Lleva a producción lo que ya se mergeó en un proyecto vinculado a OMI. Publica la versión, sincroniza variables y jobs en stage, despliega en stage verificando salud y logs, y propone promover a prod con confirmación humana. Usar SIEMPRE que el usuario quiera publicar, deployar, shippear, "subir a stage", "pasar a prod", o después de /skill:land cuando el cambio tiene que llegar a usuarios. Exige .omi/project.json: si no existe, correr /skill:init primero.
---

Cierra el ciclo después de `/skill:land`: lo mergeado llega a stage y, con confirmación humana, a prod. Cada paso se verifica antes de pasar al siguiente.

Tres ideas fuerza:

1. **Stage es del agente, prod es del humano.** Escribir `/skill:ship` autoriza operar stage en esta sesión. Prod nunca: cada operación en prod abre su confirmación, y un rechazo se respeta sin insistir.
2. **Un paso fallido frena la cadena.** No se despliega lo que no se publicó, ni se propone promover lo que no quedó sano en stage.
3. **Los secretos no pasan por acá.** Sus valores no entran al contexto: los carga el humano con `fromEnv` o con `omi env set --secret` en una terminal.

## Argumentos

```text
/skill:ship [X.Y.Z] [--service <nombre>] [--via tag|direct] [--no-prod]
```

- `X.Y.Z`: versión a publicar, semver sin `v`. Sin ella, sugerir el siguiente patch de la última versión de `omi_project_status` y confirmarla con `ask_user_question`.
- `--service`: obligatorio si `.omi/project.json` tiene varios services y el usuario no pidió todos.
- `--via`: `tag` por defecto, para que publique el CI del kit. `direct` construye con docker y empuja con regctl.
- `--no-prod`: termina en stage, sin proponer la promoción.

## Precondiciones

1. Existe `.omi/project.json`. Si no, frenar y ofrecer `/skill:init`.
2. `omi_project_status` responde. Un `not_logged_in` o `session_expired` se resuelve con `omi login`, que corre el humano.
3. El checkout está en el branch default, limpio y al día con su remote. `ship` publica lo mergeado, no lo que está en un branch.

## Etapa 1 — Publicar

Correr `omi_publish_version` con la versión y `via`. La tool valida árbol limpio y contrato `/health` + `/version`, crea el tag (`vX.Y.Z`, o `<service>/vX.Y.Z` en un monorepo) y espera a que OMI detecte la versión.

- `dirty_tree`, `contract_unmet`, `tag_exists`: frenar y reportar. No forzar un tag ni commitear para destrabar.
- `version_not_detected`: revisar el workflow del kit y sus labels OCI, y reportar. No reintentar a ciegas.

## Etapa 2 — Sincronizar stage

Declarar lo que el cambio necesita, tomándolo de la sección `## Impacto OMI` de la spec. Si no hay spec, preguntarlo.

1. **Variables no secretas:** comparar con `omi_env_list` y aplicar lo que falte con `omi_env_set`.
2. **Secretos:** listar los faltantes y pedirle al humano que los cargue. Nunca pedir el valor por el chat.
3. **Jobs:** comparar con `omi_jobs_manage` (`list`) y crear o actualizar. Verificar el handler con `handler_check` antes de crear un job nuevo.
4. **Recursos:** un Postgres nuevo pasa por `omi_postgres_manage`, que siempre pide confirmación.

Las variables rigen en el próximo deploy: se sincroniza antes de desplegar.

## Etapa 3 — Desplegar en stage

Correr `omi_deploy` con `environment: stage`. La tool sigue el rolling instancia por instancia. Después verificar los tres puntos, en orden:

1. **Deploy:** terminó `exitoso` y `omi_project_status` muestra stage `corriendo` en la versión nueva.
2. **`/health`:** con visibilidad `publico`, pedir `https://<hostname>/health` y `/version`, y exigir `200` y la versión esperada. Con otra visibilidad el acceso pide login: vale la readiness del rolling, que ya pegó contra `/health`.
3. **Logs:** leer `omi_logs_tail` unos 60 segundos o 200 líneas y buscar errores. Consultar `omi_crash_logs`: una captura nueva de esta versión es un fallo.

Si algo falla, no seguir. Con `deployment_failed`, traer `omi_crash_logs` con el `instanceLogId` del error y diagnosticar sobre las líneas reales. OMI ya hizo el rollback del rolling: reportar causa, evidencia y arreglo propuesto, que entra por `/skill:spec` o `/skill:run`.

## Etapa 4 — Proponer prod

Con `--no-prod`, terminar acá. Si no, mostrar la versión en stage, la versión en prod y lo que cambia, y preguntar con `ask_user_question`:

- `Promover a prod`: correr `omi_promote`, que abre la confirmación humana con el diff exacto. Repetir la verificación de la Etapa 3 sobre prod.
- `Quedarse en stage`: terminar.

Antes de promover, sincronizar en prod lo mismo que en stage: `omi_promote` copia sólo la versión, no variables ni jobs. Cada cambio en prod lleva su propia confirmación.

`promotion_blocked` no se fuerza: explicar el motivo. Por ejemplo, `same_version` quiere decir que prod ya corre esa versión.

Si prod falla, no reintentar por iniciativa propia: reportar y dejar la decisión al humano.

## Reporte

```text
Ship completo: <service> <versión>
- publicada: <tag | direct> · detectada por OMI
- stage: <variables, jobs> · deploy <id> exitoso · /health <resultado> · logs <resultado>
- prod: <promovida, deploy <id> | no promovida: motivo>
- pendiente tuyo: <secretos a cargar | decisión de prod | nada>
```

Con un paso fallido, usar `SHIP DETENIDO` en lugar de `Ship completo`, y nombrar la etapa, el error real y qué quedó aplicado.

## MUST DO

- Verificar cada etapa con la herramienta que la observa, no por inferencia.
- Respetar el rechazo humano de una confirmación.
- Sincronizar variables y jobs antes de desplegar.
- Citar líneas reales de logs en un diagnóstico.

## MUST NOT DO

- No pedir, imprimir ni pasar el valor de un secreto.
- No correr `omi ... --yes` ni otra vía que esquive un guardrail: dentro de una sesión agéntica no funciona, y buscar el rodeo es el error.
- No reintentar un deploy fallido en loop.
- No promover una versión que no quedó sana en stage.
