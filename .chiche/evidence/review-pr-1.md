# Resolución de feedback — PR #1

Verificación local sobre `570a06d`, 2026-11-07. Sin credenciales reales ni servicios pagos.

| Comentario | Disposición | Evidencia |
|---|---|---|
| 4503341914 | corregido: `create` solicita aprobación por un canal del humano; nunca la concede | `test/init-safety.test.ts`: acepta/rechaza/sin canal |
| 4503341998 | corregido: token ligado a la URL guardada; un override diferente falla antes de HTTP | `test/auth.test.ts`: whoami/logout/init × env/flag, sesión conservada |
| 4503342063 | corregido: valida paths, dockerfile y symlinks antes de POST/escrituras | `test/init-safety.test.ts` |
| 4503342136 | corregido: conserva services y rutas previas; actualiza sólo workflows generados reconocidos al pasar a monorepo | `test/init-safety.test.ts`: tres altas incrementales |
| 4503342200 | corregido: conserva exitCode de Pi | `test/tui-launch.test.ts`: códigos 1 y 2 |
| 4503342272 | corregido: señal propagada a requests/mutaciones y checkpoints antes de escribir | `test/init-safety.test.ts`: cancelación inicial y durante polling |
| 4503342374 | corregido: auth/models vacíos no equivalen a proveedores configurados | `test/pi-import.test.ts` |
| 4503342462 | corregido: nombres/ambientes inválidos fallan antes de mutar; agrega ambientes faltantes en services existentes | `test/init-safety.test.ts` |
| 4503342538 | corregido: stdout de tools va a stderr; stdin/prompts pertenecen al protocolo MCP | `test/mcp.test.ts` |
| 4503342608 | corregido: normaliza identidad de paquetes absorbidos y paths relativos conservando su origen | `test/pi-import.test.ts`: objetos, refs, transportes, BOM y paquetes locales |
| 4503342702 | corregido: temporales únicos con cleanup en finally y soporte de BOM | `test/pi-import.test.ts`: temporal preexistente y permisos 0600 |
| 4503342773 | corregido: dispatcher sólo admite propiedades propias | `test/cli-routing.test.ts`: toString/constructor/__proto__/valueOf |
| 4503342870 | corregido: sólo hay default si existe exactamente una organización; error accionable en cero/múltiples | `test/auth-organizations.test.ts` |
| 4503342940 | corregido: rechaza HOME vacío/relativo antes de persistir | `test/io.test.ts` |
| 4503343023 | corregido en alcance: no se ofrece instalación npm incompatible; paquete privado sin bin TS y distribución por releases documentada | `test/cli-routing.test.ts` + manifiesto/lockfile/README |

## Comandos ejecutados

- `npm run typecheck`: PASS.
- `npm test`: PASS, 104 pasan / 105 total; 1 censo contra Go omitido porque no hay checkout de `chichex/omi`.
- `git diff --check`: PASS.
- Gates contractuales `commits` y `max-lines` contra `origin/main`: PASS.
- Regresiones nuevas observadas primero en rojo; cancelación de polling pre-fix no concluyó en 20 segundos, post-fix concluye en milisegundos.

No se probó producción ni una sesión paga con un modelo real. La herramienta de creación en MCP sin aprobación permanece cerrada por defecto; la política común completa se incorpora en la capa 2.
