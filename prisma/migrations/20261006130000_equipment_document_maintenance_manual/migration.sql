-- Pauta o manual de mantención del fabricante, adjunto desde «Asignar
-- mantenciones». Solo agrega un valor al enum: no toca filas existentes.
ALTER TYPE "EquipmentDocumentType" ADD VALUE 'MAINTENANCE_MANUAL' BEFORE 'OTHER';
