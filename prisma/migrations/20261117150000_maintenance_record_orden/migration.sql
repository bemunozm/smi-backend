-- El último cambio (el grupo de `maintenance_record` que hace de ancla) queda
-- ligado a la orden que lo escribió: desde la pizarra el administrador corrige
-- también el título, el tipo, quién la hizo y las observaciones de esa orden.
-- Referencia blanda, como las demás refs a OT (sin FK).
ALTER TABLE "maintenance_record" ADD COLUMN "orden_id" TEXT;

CREATE INDEX "maintenance_record_orden_id_idx" ON "maintenance_record"("orden_id");

-- Relleno de lo existente, SOLO donde la orden es inequívoca; el resto queda
-- nulo (se corrige fecha, lectura e hito, pero no los datos de la orden).
--
-- 1) Órdenes de la pauta: mismo equipo (id o código interno, como guarda el
--    taller), misma vuelta y mismo hito. Solo si coincide exactamente una.
UPDATE "maintenance_record" mr
SET "orden_id" = m.orden_id
FROM (
  SELECT r.id AS record_id, MIN(ot.id) AS orden_id
  FROM "maintenance_record" r
  JOIN "equipment" e ON r.equipment_id IN (e.id, e.internal_code)
  JOIN "orden_trabajo" ot
    ON ot.pauta_cycle = r.cycle
   AND ot.pauta_milestone = r.milestone
   AND ot."equipoId" IN (e.id, e.internal_code)
  WHERE r.plan_item_id IS NOT NULL
    AND r.orden_id IS NULL
  GROUP BY r.id
  HAVING COUNT(DISTINCT ot.id) = 1
) m
WHERE mr.id = m.record_id;

-- 2) Mantenciones anteriores (registro histórico): la orden del mismo equipo
--    (por código interno, que es lo que guarda) cuya única tarea se hizo el
--    mismo día del registro (en hora de faena). Solo si coincide exactamente
--    una.
UPDATE "maintenance_record" mr
SET "orden_id" = m.orden_id
FROM (
  SELECT r.id AS record_id, MIN(ot.id) AS orden_id
  FROM "maintenance_record" r
  JOIN "equipment" e ON e.id = r.equipment_id
  JOIN "orden_trabajo" ot
    ON ot."equipoId" = e.internal_code
   AND ot.origen = 'MANUAL'
   AND ot."origenDetalle" LIKE 'Mantención anterior (registro histórico)%'
  JOIN "tarea_ot" t ON t."ordenId" = ot.id
  WHERE r.orden_id IS NULL
    AND (SELECT COUNT(*) FROM "tarea_ot" t2 WHERE t2."ordenId" = ot.id) = 1
    AND t.hecha_at IS NOT NULL
    AND (t.hecha_at AT TIME ZONE 'UTC' AT TIME ZONE 'America/Santiago')::date
      = (r.done_at AT TIME ZONE 'UTC' AT TIME ZONE 'America/Santiago')::date
  GROUP BY r.id
  HAVING COUNT(DISTINCT ot.id) = 1
) m
WHERE mr.id = m.record_id;
