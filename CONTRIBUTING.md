# Contribuir a SMI — Backend

Guía de **proceso** del equipo. La **arquitectura y convenciones de código** viven en `CLAUDE.md` (léelo primero, es lo primordial). Este documento define **cómo trabajamos**: de una idea a código en `main`.

> El proyecto pasó de demo a **producción a medida** (cliente: arriendo de maquinaria minera). Equipo de 2 + IA, con estándares de producción.

## Regla de oro
**Sin ticket de Producto + RFC aprobado, no se desarrolla.**

## Los tres tableros (Notion → proyecto SMI)
| Tablero | Para qué | IDs |
|---|---|---|
| **Producto** | el *qué* y el *por qué* (necesidad + criterios de aceptación) | `PROD-xx` |
| **RFCs** | el *cómo* (≥2 opciones con trade-offs → decisión) | `RFC-xx` |
| **Desarrollo** | el *cuándo / quién* (cada tarjeta = 1 PR) | `DEV-xx` |

## Flujo de punta a punta
1. **Idea → Producto** (Inbox). Se define objetivo de negocio + criterios de aceptación → `PROD-xx`.
2. **RFC** (si no es trivial): estado actual, problema, ≥2 opciones con trade-offs, decisión. Aprobado por el otro dev → `RFC-xx`. Toda decisión técnica no trivial pasa por un RFC.
3. **Descomposición** en tarjetas `DEV-xx` (cada una = 1 PR revisable).
4. **Tomar la tarea:** leer ticket + RFC, entender criterios, mapear código a reutilizar, correr en local.
5. **Implementar** en rama `tipo/<dominio>/<slug>`.
6. **PR** → CI verde (build · lint · typecheck · test) + QA / seguridad si aplica.
7. **Review cruzado humano obligatorio** (el otro dev). La IA asiste, no reemplaza.
8. **Merge** (squash) a `main` → deploy a staging. Cerrar tarjetas; RFC → Implementado.

## Trazabilidad por ID
- Rama: `tipo/<dominio>/<slug>` (ej. `feat/inventario/descuento-stock`).
- Commits: Conventional Commits en **inglés**, imperativo, ≤100 chars, sin mayúscula inicial ni punto final, **sin co-autoría de IA**. Tipos: `feat` `fix` `docs` `style` `refactor` `perf` `test` `chore`.
- El **cuerpo del PR** referencia `PROD-xx · RFC-xx · DEV-xx`; el ticket/RFC en Notion guarda el link del PR (enlace manual bidireccional).

## Reparto
2 personas, **propiedad por dominio**; el **epic** es la unidad de planificación. En epics transversales uno lidera y el otro colabora + revisa. **Review cruzado 1↔1:** ningún PR entra a `main` sin la aprobación del otro humano.

## Definition of Done (producción)
- [ ] Tests unit + integración (+ e2e en rutas críticas) verdes en CI.
- [ ] Lint + typecheck + build OK (CI bloqueante).
- [ ] Seguridad revisada en cambios sensibles (auth, datos personales, uploads).
- [ ] Datos sensibles: bitácoras inalterables + auditoría; operaciones de stock atómicas; validación de horómetro.
- [ ] Migraciones Prisma **versionadas** (no `db push`).
- [ ] Observabilidad: logging estructurado / manejo de errores.
- [ ] Docs actualizados (RFC, `README`/`.env.example`, este repo).
- [ ] PR enlaza `PROD·RFC·DEV` + evidencia (pasos/salida) + revisado por el otro dev.

## Git
- `main` estable y **protegida**: PR obligatorio + review del otro + CI verde. **Nunca push directo a `main`.**
- Ramas cortas (1 rama = 1 funcionalidad). `git pull` de `main` seguido para integrar temprano.
- Cambios a `prisma/schema.prisma`: rama corta + **migración versionada** + PR, avisando al equipo.

## Nombres e idioma
Código y base de datos en **inglés** (identificadores: modelos, tablas, columnas, enums, funciones, variables, tipos, endpoints, archivos). Español solo para textos de UI de cara al usuario y comentarios. Casing y detalle en `CLAUDE.md`. **Migración gradual por módulo** (cada dueño renombra el suyo al tocarlo); todo lo nuevo nace en inglés.

## Referencias
- **Playbook** (visión general + roadmap de 2 meses): https://claude.ai/code/artifact/2606ba46-5690-4e6a-b271-03565b68c892
- **Tableros:** proyecto **SMI** en Notion (Producto · RFCs · Desarrollo).
