-- T01 · DEV-25 — Modelo de datos de Inventario en inglés (RFC-3, opción A).
--
-- Rediseño limpio, NO migración de datos: RFC-3 §Contexto lo autoriza
-- explícitamente ("estamos en dev, sin datos reales → rediseñamos el schema al
-- ideal"). Las tablas en español se descartan y el catálogo se repuebla con el
-- seed (T05 · T17).
--
-- El cambio de fondo: la existencia deja de ser una columna del ítem y pasa a
-- `stock` (ítem × sucursal), que queda como única fuente de verdad del saldo.

-- CreateEnum
CREATE TYPE "UnitOfMeasure" AS ENUM ('UNIT', 'LITER', 'KILOGRAM', 'METER');

-- CreateEnum
CREATE TYPE "ItemType" AS ENUM ('SUPPLY', 'PART');

-- CreateEnum
CREATE TYPE "MovementDirection" AS ENUM ('IN', 'OUT');

-- CreateEnum
CREATE TYPE "MovementReason" AS ENUM ('PURCHASE', 'RETURN', 'PHYSICAL_ADJUSTMENT', 'INTERVENTION', 'ACTIVITY', 'EXTRAORDINARY_WORK', 'TRANSFER');

-- DropForeignKey
ALTER TABLE "MovimientoInventario" DROP CONSTRAINT "MovimientoInventario_equipo_id_fkey";

-- DropForeignKey
ALTER TABLE "MovimientoInventario" DROP CONSTRAINT "MovimientoInventario_insumoId_fkey";

-- DropTable
DROP TABLE "Insumo";

-- DropTable
DROP TABLE "MovimientoInventario";

-- DropEnum
DROP TYPE "OrigenMovimiento";

-- DropEnum
DROP TYPE "TipoMovimiento";

-- DropEnum
DROP TYPE "UnidadInsumo";

-- CreateTable
CREATE TABLE "item_category" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "item_category_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inventory_item" (
    "id" TEXT NOT NULL,
    "sku" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "unit" "UnitOfMeasure" NOT NULL DEFAULT 'UNIT',
    "type" "ItemType" NOT NULL DEFAULT 'SUPPLY',
    "category_id" TEXT,
    "part_number" TEXT,
    "default_supplier" TEXT,
    "is_critical" BOOLEAN NOT NULL DEFAULT false,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "inventory_item_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stock" (
    "id" TEXT NOT NULL,
    "item_id" TEXT NOT NULL,
    "branch_id" TEXT NOT NULL,
    "quantity" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "minimum_quantity" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "stock_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stock_movement" (
    "id" TEXT NOT NULL,
    "item_id" TEXT NOT NULL,
    "branch_id" TEXT NOT NULL,
    "direction" "MovementDirection" NOT NULL,
    "reason" "MovementReason" NOT NULL,
    "quantity" DOUBLE PRECISION NOT NULL,
    "resulting_balance" DOUBLE PRECISION NOT NULL,
    "reference" TEXT,
    "source_branch_id" TEXT,
    "destination_branch_id" TEXT,
    "performed_by_id" TEXT,
    "equipment_id" TEXT,
    "notes" TEXT,
    "occurred_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "stock_movement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "part_compatibility" (
    "id" TEXT NOT NULL,
    "equipment_id" TEXT NOT NULL,
    "item_id" TEXT NOT NULL,
    "note" TEXT,
    "declared_by_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "part_compatibility_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "item_category_name_key" ON "item_category"("name");

-- CreateIndex
CREATE UNIQUE INDEX "inventory_item_sku_key" ON "inventory_item"("sku");

-- CreateIndex
CREATE INDEX "inventory_item_name_idx" ON "inventory_item"("name");

-- CreateIndex
CREATE INDEX "inventory_item_type_idx" ON "inventory_item"("type");

-- CreateIndex
CREATE INDEX "stock_branch_id_idx" ON "stock"("branch_id");

-- CreateIndex
CREATE UNIQUE INDEX "stock_item_id_branch_id_key" ON "stock"("item_id", "branch_id");

-- CreateIndex
CREATE INDEX "stock_movement_item_id_occurred_at_idx" ON "stock_movement"("item_id", "occurred_at");

-- CreateIndex
CREATE INDEX "stock_movement_branch_id_occurred_at_idx" ON "stock_movement"("branch_id", "occurred_at");

-- CreateIndex
CREATE INDEX "stock_movement_equipment_id_idx" ON "stock_movement"("equipment_id");

-- CreateIndex
CREATE INDEX "stock_movement_reference_idx" ON "stock_movement"("reference");

-- CreateIndex
CREATE INDEX "part_compatibility_item_id_idx" ON "part_compatibility"("item_id");

-- CreateIndex
CREATE UNIQUE INDEX "part_compatibility_equipment_id_item_id_key" ON "part_compatibility"("equipment_id", "item_id");

-- AddForeignKey
ALTER TABLE "inventory_item" ADD CONSTRAINT "inventory_item_category_id_fkey" FOREIGN KEY ("category_id") REFERENCES "item_category"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock" ADD CONSTRAINT "stock_item_id_fkey" FOREIGN KEY ("item_id") REFERENCES "inventory_item"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock" ADD CONSTRAINT "stock_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branch"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_movement" ADD CONSTRAINT "stock_movement_item_id_fkey" FOREIGN KEY ("item_id") REFERENCES "inventory_item"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_movement" ADD CONSTRAINT "stock_movement_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_movement" ADD CONSTRAINT "stock_movement_source_branch_id_fkey" FOREIGN KEY ("source_branch_id") REFERENCES "branch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_movement" ADD CONSTRAINT "stock_movement_destination_branch_id_fkey" FOREIGN KEY ("destination_branch_id") REFERENCES "branch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_movement" ADD CONSTRAINT "stock_movement_equipment_id_fkey" FOREIGN KEY ("equipment_id") REFERENCES "equipment"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "part_compatibility" ADD CONSTRAINT "part_compatibility_equipment_id_fkey" FOREIGN KEY ("equipment_id") REFERENCES "equipment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "part_compatibility" ADD CONSTRAINT "part_compatibility_item_id_fkey" FOREIGN KEY ("item_id") REFERENCES "inventory_item"("id") ON DELETE CASCADE ON UPDATE CASCADE;

