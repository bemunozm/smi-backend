-- Contenido de cada unidad de un ítem contado en unidades (bidón de AdBlue de 10 L).
ALTER TABLE "inventory_item" ADD COLUMN "content_per_unit" DOUBLE PRECISION,
ADD COLUMN "content_unit" "UnitOfMeasure";
