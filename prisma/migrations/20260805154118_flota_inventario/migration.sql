/*
  Warnings:

  - The `estado` column on the `Equipo` table would be dropped and recreated. This will lead to data loss if there is data in the column.
  - Added the required column `updatedAt` to the `Equipo` table without a default value. This is not possible if the table is not empty.

*/
-- CreateEnum
CREATE TYPE "EstadoEquipo" AS ENUM ('DISPONIBLE', 'EN_RUTA', 'EN_MANTENCION', 'DE_BAJA');

-- CreateEnum
CREATE TYPE "UnidadInsumo" AS ENUM ('UNIDAD', 'LITRO', 'KILOGRAMO', 'METRO');

-- CreateEnum
CREATE TYPE "TipoMovimiento" AS ENUM ('ENTRADA', 'SALIDA');

-- CreateEnum
CREATE TYPE "OrigenMovimiento" AS ENUM ('COMPRA', 'DEVOLUCION', 'AJUSTE_FISICO', 'INTERVENCION', 'ACTIVIDAD', 'TRABAJO_EXTRAORDINARIO');

-- AlterTable
ALTER TABLE "Equipo" ADD COLUMN     "anio" INTEGER,
ADD COLUMN     "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "updatedAt" TIMESTAMP(3) NOT NULL,
DROP COLUMN "estado",
ADD COLUMN     "estado" "EstadoEquipo" NOT NULL DEFAULT 'DISPONIBLE';

-- CreateTable
CREATE TABLE "Insumo" (
    "id" TEXT NOT NULL,
    "codigo" TEXT NOT NULL,
    "nombre" TEXT NOT NULL,
    "descripcion" TEXT,
    "unidad" "UnidadInsumo" NOT NULL DEFAULT 'UNIDAD',
    "stock" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "stockMinimo" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Insumo_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MovimientoInventario" (
    "id" TEXT NOT NULL,
    "insumoId" TEXT NOT NULL,
    "tipo" "TipoMovimiento" NOT NULL,
    "origen" "OrigenMovimiento" NOT NULL,
    "cantidad" DOUBLE PRECISION NOT NULL,
    "saldoResultante" DOUBLE PRECISION NOT NULL,
    "responsableId" TEXT,
    "equipoId" TEXT,
    "referenciaId" TEXT,
    "observacion" TEXT,
    "fecha" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MovimientoInventario_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Insumo_codigo_key" ON "Insumo"("codigo");

-- CreateIndex
CREATE INDEX "Insumo_nombre_idx" ON "Insumo"("nombre");

-- CreateIndex
CREATE INDEX "MovimientoInventario_insumoId_fecha_idx" ON "MovimientoInventario"("insumoId", "fecha");

-- CreateIndex
CREATE INDEX "MovimientoInventario_equipoId_idx" ON "MovimientoInventario"("equipoId");

-- CreateIndex
CREATE INDEX "Equipo_estado_idx" ON "Equipo"("estado");

-- AddForeignKey
ALTER TABLE "MovimientoInventario" ADD CONSTRAINT "MovimientoInventario_insumoId_fkey" FOREIGN KEY ("insumoId") REFERENCES "Insumo"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MovimientoInventario" ADD CONSTRAINT "MovimientoInventario_equipoId_fkey" FOREIGN KEY ("equipoId") REFERENCES "Equipo"("id") ON DELETE SET NULL ON UPDATE CASCADE;
