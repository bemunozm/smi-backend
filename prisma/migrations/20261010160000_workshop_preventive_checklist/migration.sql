-- AlterTable
ALTER TABLE "orden_trabajo" ADD COLUMN "pauta_milestone" INTEGER,
ADD COLUMN "pauta_cycle" INTEGER;

-- AlterTable
ALTER TABLE "tarea_ot" ADD COLUMN "plan_item_id" TEXT,
ADD COLUMN "notas" TEXT,
ADD COLUMN "foto_key" TEXT;
