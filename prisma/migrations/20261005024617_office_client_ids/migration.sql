-- AlterTable
ALTER TABLE "RegistroCombustible" ADD COLUMN     "created_by_id" TEXT;

-- AlterTable
ALTER TABLE "actividad" ADD COLUMN     "created_by_id" TEXT;

-- AlterTable
ALTER TABLE "branch" ADD COLUMN     "created_by_id" TEXT;

-- AlterTable
ALTER TABLE "equipment" ADD COLUMN     "created_by_id" TEXT;

-- AlterTable
ALTER TABLE "equipment_document" ADD COLUMN     "created_by_id" TEXT;

-- AlterTable
ALTER TABLE "intervencion" ADD COLUMN     "created_by_id" TEXT;

-- AlterTable
ALTER TABLE "inventory_item" ADD COLUMN     "created_by_id" TEXT;

-- AlterTable
ALTER TABLE "item_category" ADD COLUMN     "created_by_id" TEXT;

-- AlterTable
ALTER TABLE "operator" ADD COLUMN     "created_by_id" TEXT;

-- AlterTable
ALTER TABLE "orden_trabajo" ADD COLUMN     "created_by_id" TEXT;

-- AlterTable
ALTER TABLE "umbral_mantenimiento" ADD COLUMN     "created_by_id" TEXT;
