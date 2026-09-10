-- RFC-12 / DEV-12 — Compatibilidad repuesto ↔ equipo.
--
-- Puramente aditiva: una tabla nueva, sin tocar ninguna columna existente.
-- Escrita a mano (el entorno de desarrollo no tiene Postgres); verificar con
-- `npx prisma migrate dev` en una máquina con la BD levantada antes del merge.

CREATE TABLE "compatibilidad_equipo_insumo" (
    "id" TEXT NOT NULL,
    "equipoId" TEXT NOT NULL,
    "insumoId" TEXT NOT NULL,
    "nota" TEXT,
    "declaradaPorId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "compatibilidad_equipo_insumo_pkey" PRIMARY KEY ("id")
);

-- Una máquina no declara dos veces el mismo repuesto. Es lo que hace idempotente
-- a la replicación por marca/modelo: reejecutarla no duplica filas.
CREATE UNIQUE INDEX "compatibilidad_equipo_insumo_equipoId_insumoId_key"
    ON "compatibilidad_equipo_insumo"("equipoId", "insumoId");

-- Índice para la consulta inversa ("¿en qué equipos se usa este repuesto?"):
-- el índice único de arriba solo sirve con `equipoId` por delante.
CREATE INDEX "compatibilidad_equipo_insumo_insumoId_idx"
    ON "compatibilidad_equipo_insumo"("insumoId");

-- CASCADE en ambos lados: la compatibilidad no tiene sentido sin sus extremos y
-- no debe bloquear la baja de un equipo o de un insumo. A diferencia del kardex,
-- no es un registro histórico auditable: es una afirmación sobre el presente.
ALTER TABLE "compatibilidad_equipo_insumo"
    ADD CONSTRAINT "compatibilidad_equipo_insumo_equipoId_fkey"
    FOREIGN KEY ("equipoId") REFERENCES "Equipo"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "compatibilidad_equipo_insumo"
    ADD CONSTRAINT "compatibilidad_equipo_insumo_insumoId_fkey"
    FOREIGN KEY ("insumoId") REFERENCES "Insumo"("id") ON DELETE CASCADE ON UPDATE CASCADE;
