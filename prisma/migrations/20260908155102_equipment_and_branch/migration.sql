-- T01 (Benjamín) — Flota: `Equipo` -> `Equipment` (rediseño en inglés, RFC
-- T01 opción A) + nueva entidad `Branch`.
--
-- Dev-fixture reset: no hay datos reales (100% reseedable vía
-- `npm run db:seed`, ver `prisma/seed.ts`). Las filas de los dominios que
-- referencian `Equipo` se limpian acá en vez de intentar remapear valor a
-- valor el enum `EstadoEquipo` -> `EquipmentStatus` (sin correspondencia
-- 1:1) — el seed las vuelve a crear de inmediato.
DELETE FROM "Hallazgo";
DELETE FROM "RegistroCombustible";
DELETE FROM "RegistroHorometro";
DELETE FROM "TrabajoExtraordinario";
DELETE FROM "MovimientoInventario";

-- CreateEnum
CREATE TYPE "EquipmentClass" AS ENUM ('LIGHT', 'HEAVY');

-- CreateEnum
CREATE TYPE "ControlUnit" AS ENUM ('KM', 'HOURS');

-- CreateEnum
CREATE TYPE "EquipmentStatus" AS ENUM ('OPERATIONAL', 'IN_WORKSHOP', 'OUT_OF_SERVICE');

-- DropForeignKey
ALTER TABLE "Hallazgo" DROP CONSTRAINT "Hallazgo_equipoId_fkey";

-- DropForeignKey
ALTER TABLE "MovimientoInventario" DROP CONSTRAINT "MovimientoInventario_equipoId_fkey";

-- DropForeignKey
ALTER TABLE "RegistroCombustible" DROP CONSTRAINT "RegistroCombustible_equipoId_fkey";

-- DropForeignKey
ALTER TABLE "RegistroHorometro" DROP CONSTRAINT "RegistroHorometro_equipoId_fkey";

-- DropForeignKey
ALTER TABLE "TrabajoExtraordinario" DROP CONSTRAINT "TrabajoExtraordinario_equipoId_fkey";

-- DropIndex
DROP INDEX "MovimientoInventario_equipoId_idx";

-- AlterTable
ALTER TABLE "Hallazgo" DROP COLUMN "equipoId",
ADD COLUMN     "equipo_id" TEXT NOT NULL;

-- AlterTable
ALTER TABLE "MovimientoInventario" DROP COLUMN "equipoId",
ADD COLUMN     "equipo_id" TEXT;

-- AlterTable
ALTER TABLE "RegistroCombustible" DROP COLUMN "equipoId",
ADD COLUMN     "equipo_id" TEXT NOT NULL;

-- AlterTable
ALTER TABLE "RegistroHorometro" DROP COLUMN "equipoId",
ADD COLUMN     "equipo_id" TEXT NOT NULL;

-- AlterTable
ALTER TABLE "TrabajoExtraordinario" DROP COLUMN "equipoId",
ADD COLUMN     "equipo_id" TEXT NOT NULL;

-- DropTable
DROP TABLE "Equipo";

-- DropEnum
DROP TYPE "EstadoEquipo";

-- CreateTable
CREATE TABLE "branch" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "address" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "branch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "equipment" (
    "id" TEXT NOT NULL,
    "internal_code" TEXT NOT NULL,
    "license_plate" TEXT,
    "equipment_class" "EquipmentClass" NOT NULL,
    "type" TEXT NOT NULL,
    "brand" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "year" INTEGER,
    "control_unit" "ControlUnit" NOT NULL,
    "current_hourmeter" DOUBLE PRECISION,
    "current_mileage" DOUBLE PRECISION,
    "status" "EquipmentStatus" NOT NULL DEFAULT 'OPERATIONAL',
    "home_branch_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "equipment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "branch_name_key" ON "branch"("name");

-- CreateIndex
CREATE UNIQUE INDEX "equipment_internal_code_key" ON "equipment"("internal_code");

-- CreateIndex
CREATE UNIQUE INDEX "equipment_license_plate_key" ON "equipment"("license_plate");

-- CreateIndex
CREATE INDEX "equipment_equipment_class_idx" ON "equipment"("equipment_class");

-- CreateIndex
CREATE INDEX "equipment_status_idx" ON "equipment"("status");

-- CreateIndex
CREATE INDEX "MovimientoInventario_equipo_id_idx" ON "MovimientoInventario"("equipo_id");

-- AddForeignKey
ALTER TABLE "equipment" ADD CONSTRAINT "equipment_home_branch_id_fkey" FOREIGN KEY ("home_branch_id") REFERENCES "branch"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MovimientoInventario" ADD CONSTRAINT "MovimientoInventario_equipo_id_fkey" FOREIGN KEY ("equipo_id") REFERENCES "equipment"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RegistroCombustible" ADD CONSTRAINT "RegistroCombustible_equipo_id_fkey" FOREIGN KEY ("equipo_id") REFERENCES "equipment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RegistroHorometro" ADD CONSTRAINT "RegistroHorometro_equipo_id_fkey" FOREIGN KEY ("equipo_id") REFERENCES "equipment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TrabajoExtraordinario" ADD CONSTRAINT "TrabajoExtraordinario_equipo_id_fkey" FOREIGN KEY ("equipo_id") REFERENCES "equipment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Hallazgo" ADD CONSTRAINT "Hallazgo_equipo_id_fkey" FOREIGN KEY ("equipo_id") REFERENCES "equipment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
