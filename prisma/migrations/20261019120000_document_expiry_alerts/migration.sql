-- Módulo 4 · R21: avisos de vencimiento documental.

-- AlterTable
ALTER TABLE "equipment_document" ADD COLUMN "alert_days_before" INTEGER NOT NULL DEFAULT 30;

-- CreateTable
CREATE TABLE "document_expiry_alert" (
    "id" TEXT NOT NULL,
    "document_id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "expiry_date" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "document_expiry_alert_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "document_expiry_alert_document_id_kind_expiry_date_key" ON "document_expiry_alert"("document_id", "kind", "expiry_date");

-- AddForeignKey
ALTER TABLE "document_expiry_alert" ADD CONSTRAINT "document_expiry_alert_document_id_fkey" FOREIGN KEY ("document_id") REFERENCES "equipment_document"("id") ON DELETE CASCADE ON UPDATE CASCADE;
