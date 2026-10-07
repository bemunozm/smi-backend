-- CreateTable
CREATE TABLE "maintenance_plan" (
    "id" TEXT NOT NULL,
    "equipment_id" TEXT NOT NULL,
    "milestones" INTEGER[],
    "initial_milestone" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "maintenance_plan_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "maintenance_plan_item" (
    "id" TEXT NOT NULL,
    "plan_id" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "kind" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "quantity" DOUBLE PRECISION,
    "unit" TEXT,
    "part_number" TEXT,
    "inventory_item_id" TEXT,
    "milestones" INTEGER[],

    CONSTRAINT "maintenance_plan_item_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "maintenance_plan_equipment_id_key" ON "maintenance_plan"("equipment_id");

-- CreateIndex
CREATE INDEX "maintenance_plan_item_plan_id_idx" ON "maintenance_plan_item"("plan_id");

-- AddForeignKey
ALTER TABLE "maintenance_plan_item" ADD CONSTRAINT "maintenance_plan_item_plan_id_fkey" FOREIGN KEY ("plan_id") REFERENCES "maintenance_plan"("id") ON DELETE CASCADE ON UPDATE CASCADE;

