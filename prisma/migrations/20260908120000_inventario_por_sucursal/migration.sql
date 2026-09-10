-- RFC-11 / DEV-11 — Inventario de suministros y repuestos por sucursal.
--
-- Escrita a mano (no con `prisma migrate dev`) porque el entorno donde se
-- desarrolló no tiene Postgres. La parte que un `migrate dev` NO habría podido
-- generar sola es el backfill de los pasos 4 y 6: sin él, `sucursalId` no puede
-- volverse NOT NULL sobre un kardex con filas, y el stock actual de cada insumo
-- quedaría sin bodega. Verificar con `npx prisma migrate dev` en una máquina con
-- la BD levantada antes del merge.

-- 1. Clasificación suministro / repuesto -------------------------------------
CREATE TYPE "TipoInsumo" AS ENUM ('SUMINISTRO', 'REPUESTO');

ALTER TABLE "Insumo" ADD COLUMN "tipo" "TipoInsumo" NOT NULL DEFAULT 'SUMINISTRO';

CREATE INDEX "Insumo_tipo_idx" ON "Insumo"("tipo");

-- 2. Sucursales ---------------------------------------------------------------
CREATE TABLE "Sucursal" (
    "id" TEXT NOT NULL,
    "codigo" TEXT NOT NULL,
    "nombre" TEXT NOT NULL,
    "direccion" TEXT,
    "activa" BOOLEAN NOT NULL DEFAULT true,
    "esPrincipal" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Sucursal_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "Sucursal_codigo_key" ON "Sucursal"("codigo");
CREATE INDEX "Sucursal_activa_idx" ON "Sucursal"("activa");

-- 3. Saldo por bodega ---------------------------------------------------------
CREATE TABLE "StockSucursal" (
    "id" TEXT NOT NULL,
    "insumoId" TEXT NOT NULL,
    "sucursalId" TEXT NOT NULL,
    "stock" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "stockMinimo" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StockSucursal_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "StockSucursal_insumoId_sucursalId_key"
    ON "StockSucursal"("insumoId", "sucursalId");
CREATE INDEX "StockSucursal_sucursalId_idx" ON "StockSucursal"("sucursalId");

ALTER TABLE "StockSucursal" ADD CONSTRAINT "StockSucursal_insumoId_fkey"
    FOREIGN KEY ("insumoId") REFERENCES "Insumo"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "StockSucursal" ADD CONSTRAINT "StockSucursal_sucursalId_fkey"
    FOREIGN KEY ("sucursalId") REFERENCES "Sucursal"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- 4. Bodega por defecto + backfill del stock actual ---------------------------
-- Todo el saldo que hoy vive en `Insumo.stock` pasa a la casa matriz. Así la
-- invariante `Insumo.stock = Σ StockSucursal.stock` se cumple desde el minuto
-- cero y ninguna lectura existente cambia de resultado.
INSERT INTO "Sucursal" ("id", "codigo", "nombre", "direccion", "activa", "esPrincipal", "createdAt", "updatedAt")
VALUES ('suc_central_seed_0000000', 'CENTRAL', 'Casa Matriz', NULL, true, true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);

INSERT INTO "StockSucursal" ("id", "insumoId", "sucursalId", "stock", "stockMinimo", "createdAt", "updatedAt")
SELECT
    'stk_' || substr(md5(random()::text || clock_timestamp()::text), 1, 21),
    "id",
    'suc_central_seed_0000000',
    "stock",
    "stockMinimo",
    CURRENT_TIMESTAMP,
    CURRENT_TIMESTAMP
FROM "Insumo";

-- 5. Ubicación en el kardex — se agrega nullable para poder backfillear --------
ALTER TABLE "MovimientoInventario" ADD COLUMN "sucursalId" TEXT;

-- 6. Backfill del historial ---------------------------------------------------
UPDATE "MovimientoInventario" SET "sucursalId" = 'suc_central_seed_0000000'
WHERE "sucursalId" IS NULL;

-- 7. Recién ahora se puede exigir la ubicación --------------------------------
ALTER TABLE "MovimientoInventario" ALTER COLUMN "sucursalId" SET NOT NULL;

CREATE INDEX "MovimientoInventario_sucursalId_fecha_idx"
    ON "MovimientoInventario"("sucursalId", "fecha");

-- RESTRICT y no CASCADE: dar de baja una sucursal no puede llevarse su historial
-- de movimientos por delante. `SucursalesService.remove` bloquea antes con un 409.
ALTER TABLE "MovimientoInventario" ADD CONSTRAINT "MovimientoInventario_sucursalId_fkey"
    FOREIGN KEY ("sucursalId") REFERENCES "Sucursal"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
