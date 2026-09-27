/*
  Warnings:

  - You are about to drop the column `insurance_expiry` on the `equipment` table. All the data in the column will be lost.
  - You are about to drop the column `technical_inspection_expiry` on the `equipment` table. All the data in the column will be lost.

*/
-- CreateEnum
CREATE TYPE "EquipmentDocumentType" AS ENUM ('TECHNICAL_INSPECTION', 'INSURANCE', 'CIRCULATION_PERMIT', 'CERTIFICATION', 'OTHER');

-- AlterTable
ALTER TABLE "equipment" DROP COLUMN "insurance_expiry",
DROP COLUMN "technical_inspection_expiry";

-- CreateTable
CREATE TABLE "equipment_document" (
    "id" TEXT NOT NULL,
    "equipment_id" TEXT NOT NULL,
    "type" "EquipmentDocumentType" NOT NULL,
    "title" TEXT,
    "expiry_date" TIMESTAMP(3),
    "file_url" TEXT,
    "notes" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "equipment_document_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "equipment_document_equipment_id_idx" ON "equipment_document"("equipment_id");

-- AddForeignKey
ALTER TABLE "equipment_document" ADD CONSTRAINT "equipment_document_equipment_id_fkey" FOREIGN KEY ("equipment_id") REFERENCES "equipment"("id") ON DELETE CASCADE ON UPDATE CASCADE;
