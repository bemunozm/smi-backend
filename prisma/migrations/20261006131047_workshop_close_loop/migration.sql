-- AlterTable
ALTER TABLE "intervencion" ADD COLUMN     "fotoKey" TEXT;

-- AlterTable
ALTER TABLE "orden_trabajo" ADD COLUMN     "hallazgo_id" TEXT;

-- CreateIndex
CREATE INDEX "orden_trabajo_hallazgo_id_idx" ON "orden_trabajo"("hallazgo_id");
