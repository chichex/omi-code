# Preparación autorizada del land — stack #4

2026-11-08. El humano eligió explícitamente «Sí, registrar las excepciones y preparar el land». Esto autoriza la preparación; no reemplaza la confirmación final del merge.

## Decisiones aceptadas

- Baseline de adopción limitada a los 13 paths y tamaños actuales del `case` de `.chiche/project.md`. No se excluye `extensions/` ni se aumenta el límite normal de 500. Los archivos de la baseline no pueden crecer y su techo baja con el base hasta llegar a 500. Un aumento o una nueva excepción exige otra decisión humana.
- La deuda de tamaño no está refactorizada ni se declara resuelta: se acepta para el port inicial, evitando un refactor masivo incidental al land.
- Los hallazgos de aislamiento CLI y confianza de aprobación MCP siguen sin resolver técnicamente. Se autoriza resolver sus hilos como riesgos aceptados/diferidos a https://github.com/chichex/omi-code/issues/5 y https://github.com/chichex/omi-code/issues/6; ambos issues permanecen abiertos.
- Se autoriza quitar Draft del PR #3 una vez publicada esta decisión. No se modifican protecciones, settings del repo, releases ni tags.

## Verificación

El código de aplicación no cambia respecto de `37bc3e74bed6b4a1781108d56f4a380a5ae43215`; sólo cambian este documento y el contrato.

- Gate `max-lines` del contrato ejecutado sobre el stack completo y la capa 3, en `sh` y `bash`: PASS.
- Los 13 techos nominales se cotejaron contra los archivos reales, con `wc -l` equivalente: coinciden exactamente.
- 14 casos del gate en repos temporales: acepta el port, rechaza crecimiento de baseline, conserva 500 para archivos nuevos, no excluye carpetas, reduce el techo con el base y rechaza bases inexistentes. PASS; fixtures eliminados.
- `npm ci` y `npm run typecheck`: PASS.
- `OMI_REPO=/Users/ayrtonmarini/workspace/omi npm test`: 780 pasan, 2 smoke de packaging separados, 0 fallos.
- `npm run test:packaging`: 2/2, binario real instalado en HOME temporal. Total de pruebas de regresión distintas verificadas: 782.
- Gate de commits y `git diff --check`: PASS.

El land será atómico para #1/#2/#3 y requiere releer los gates y recibir la confirmación final. La aprobación de estos riesgos no es una garantía de aislamiento adversarial ni una prueba contra producción.
