-- Informe temporal «subido después»: sin tarjetas, con sus equipos a mano.
-- AlterTable
ALTER TABLE "informe_temporal" ADD COLUMN     "antiguo" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "equipos_registrados" JSONB;
