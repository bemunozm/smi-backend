-- AlterTable
ALTER TABLE "Hallazgo" ADD COLUMN     "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "created_by_id" TEXT;

-- AlterTable
ALTER TABLE "TrabajoExtraordinario" ADD COLUMN     "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "created_by_id" TEXT;

-- CreateIndex
CREATE INDEX "Hallazgo_created_by_id_idx" ON "Hallazgo"("created_by_id");

-- CreateIndex
CREATE INDEX "TrabajoExtraordinario_created_by_id_idx" ON "TrabajoExtraordinario"("created_by_id");

-- Las filas previas conservan su fecha real como hora de alta en vez de la
-- del momento de la migración.
UPDATE "Hallazgo" SET "created_at" = "fecha";
UPDATE "TrabajoExtraordinario" SET "created_at" = "fecha";
