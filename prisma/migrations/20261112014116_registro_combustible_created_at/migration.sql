-- AlterTable
ALTER TABLE "RegistroCombustible" ADD COLUMN     "created_at" TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP;

-- Backfill de filas existentes (el DEFAULT de arriba las dejó con la hora de
-- ESTA migración, que mentiría): una carga nacida de cierre de tarjeta se
-- registró cuando se cerró esa tarjeta; una manual, en su propia `fecha`
-- (mejor aproximación disponible — el alta manual fecha el momento de la
-- carga).
UPDATE "RegistroCombustible" rc
SET "created_at" = rh."closed_at"
FROM "RegistroHorometro" rh
WHERE rc."registro_horometro_id" = rh."id" AND rh."closed_at" IS NOT NULL;

UPDATE "RegistroCombustible"
SET "created_at" = "fecha"
WHERE "registro_horometro_id" IS NULL;
