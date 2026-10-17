-- Módulo 3 · R25: validación del supervisor sobre el checklist diario.

-- AlterTable
ALTER TABLE "daily_checklist" ADD COLUMN "submission_count" INTEGER NOT NULL DEFAULT 1;

-- CreateTable
CREATE TABLE "daily_checklist_review" (
    "id" TEXT NOT NULL,
    "checklist_id" TEXT NOT NULL,
    "decision" "ChecklistStatus" NOT NULL,
    "comment" TEXT,
    "reviewer_id" TEXT NOT NULL,
    "reviewer_name" TEXT NOT NULL,
    "submission" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "daily_checklist_review_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "daily_checklist_review_checklist_id_idx" ON "daily_checklist_review"("checklist_id");

-- AddForeignKey
ALTER TABLE "daily_checklist_review" ADD CONSTRAINT "daily_checklist_review_checklist_id_fkey" FOREIGN KEY ("checklist_id") REFERENCES "daily_checklist"("id") ON DELETE CASCADE ON UPDATE CASCADE;
