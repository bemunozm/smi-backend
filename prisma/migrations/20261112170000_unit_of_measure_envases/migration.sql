-- Envases para contar suministros: tineta, bidón, tambor y caja.
-- Solo agrega valores al enum; no toca filas existentes.
ALTER TYPE "UnitOfMeasure" ADD VALUE IF NOT EXISTS 'PAIL';
ALTER TYPE "UnitOfMeasure" ADD VALUE IF NOT EXISTS 'CAN';
ALTER TYPE "UnitOfMeasure" ADD VALUE IF NOT EXISTS 'DRUM';
ALTER TYPE "UnitOfMeasure" ADD VALUE IF NOT EXISTS 'BOX';
