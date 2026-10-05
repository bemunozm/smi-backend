-- RFC "Supervisión en Terreno", Anexo 2 (28/09 noche): "operador del catálogo
-- en Trabajos extra + snapshot único". `TrabajoExtraordinario.operador` era
-- texto libre sin validación, con dos formas distintas de armar el snapshot
-- en el resto del sistema (`ShiftsService.openCard` lo deriva del catálogo,
-- `HorometroService.create` de Flota confiaba en el texto del cliente). Esta
-- migración agrega `operatorId` (FK real, nullable) para unificar el patrón:
-- de ahora en más el SERVIDOR arma `operador` desde `OperatorsService
-- .assertActive(dto.operatorId).name`, nunca desde texto que mande el
-- cliente (`operador` sale de los DTO de creación).
--
-- Generada con `prisma migrate dev --create-only` (agrega columna + índice +
-- FK) y editada a mano para insertar el backfill de datos entre el ADD COLUMN
-- y el ADD CONSTRAINT — Prisma no puede expresar un UPDATE de datos en el
-- diff de schema. Entorno no interactivo (mismo criterio que las dos
-- migraciones anteriores de este RFC): sin prompts de `migrate dev`.
--
-- A diferencia de la migración de Fase 1 (`..._shift_register_foundations`,
-- que sí agregó columnas a `RegistroHorometro`), esta NO toca esa tabla —
-- no aparece el falso `DROP INDEX "RegistroHorometro_equipo_id_open_turno_key"`
-- del índice único parcial (ver la nota en la migración
-- `20260921153343_horometro_open_turno_unique_index`), confirmado con
-- `prisma migrate diff` contra una shadow DB descartable antes de cerrar el
-- Anexo 2.

-- 1) Columna nueva, nullable: las filas legacy (texto libre, sin garantía de
--    match contra el catálogo) se quedan sin catálogo salvo que el backfill
--    de abajo las resuelva.
-- AlterTable
ALTER TABLE "TrabajoExtraordinario" ADD COLUMN     "operator_id" TEXT;

-- 2) Backfill por nombre normalizado (trim + case-insensitive), mismo patrón
--    `DISTINCT ON` que la migración `20260928223000_operator_catalog_assignment`
--    (Anexo "el operador deja de ser usuario de la plataforma"): si el
--    catálogo tiene más de un operador homónimo para el mismo nombre
--    normalizado, se elige el MÁS ANTIGUO (`created_at`, luego `id` como
--    desempate estable) de forma determinística, así el match es siempre
--    contra un único operador, nunca "el que sea" de varios candidatos. Lo
--    que no calce exactamente contra un nombre del catálogo queda en NULL —
--    no hay heurística difusa acá, es texto histórico sin garantías (en el
--    entorno de dev, ninguna de las 2 filas existentes calza: "Juan Rojas" y
--    "Pedro Soto" no están en el catálogo sembrado por `seedOperators()`).
UPDATE "TrabajoExtraordinario" te
SET "operator_id" = t."operator_id"
FROM (
  SELECT DISTINCT ON (lower(trim(o."name")))
    lower(trim(o."name")) AS "norm_name",
    o."id" AS "operator_id"
  FROM "operator" o
  ORDER BY lower(trim(o."name")), o."created_at", o."id"
) t
WHERE t."norm_name" = lower(trim(te."operador"));

-- CreateIndex
CREATE INDEX "TrabajoExtraordinario_operator_id_idx" ON "TrabajoExtraordinario"("operator_id");

-- AddForeignKey
ALTER TABLE "TrabajoExtraordinario" ADD CONSTRAINT "TrabajoExtraordinario_operator_id_fkey" FOREIGN KEY ("operator_id") REFERENCES "operator"("id") ON DELETE SET NULL ON UPDATE CASCADE;
