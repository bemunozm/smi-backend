-- CreateTable
CREATE TABLE "maintenance_record" (
    "id" TEXT NOT NULL,
    "equipment_id" TEXT NOT NULL,
    "plan_item_id" TEXT,
    "cycle" INTEGER NOT NULL,
    "milestone" INTEGER NOT NULL,
    "description" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "counter_at" DOUBLE PRECISION,
    "done_by_id" TEXT NOT NULL,
    "done_by_name" TEXT NOT NULL,
    "done_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "maintenance_record_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "maintenance_record_equipment_id_cycle_idx" ON "maintenance_record"("equipment_id", "cycle");

-- CreateIndex
CREATE UNIQUE INDEX "maintenance_record_plan_item_id_cycle_milestone_key" ON "maintenance_record"("plan_item_id", "cycle", "milestone");

-- AddForeignKey
ALTER TABLE "maintenance_record" ADD CONSTRAINT "maintenance_record_plan_item_id_fkey" FOREIGN KEY ("plan_item_id") REFERENCES "maintenance_plan_item"("id") ON DELETE SET NULL ON UPDATE CASCADE;

