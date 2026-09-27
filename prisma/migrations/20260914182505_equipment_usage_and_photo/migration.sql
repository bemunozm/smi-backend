-- AlterTable
ALTER TABLE "equipment" ADD COLUMN     "current_operator_id" TEXT,
ADD COLUMN     "current_supervisor_id" TEXT,
ADD COLUMN     "photo_url" TEXT;

-- CreateIndex
CREATE INDEX "equipment_current_operator_id_idx" ON "equipment"("current_operator_id");

-- CreateIndex
CREATE INDEX "equipment_current_supervisor_id_idx" ON "equipment"("current_supervisor_id");
