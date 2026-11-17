-- El último cambio (el grupo de `maintenance_record` que hace de ancla) queda
-- ligado a la orden que lo escribió: desde la pizarra el administrador corrige
-- también el título, el tipo, quién la hizo y las observaciones de esa orden.
-- Referencia blanda, como las demás refs a OT (sin FK).
ALTER TABLE "maintenance_record" ADD COLUMN "orden_id" TEXT;

CREATE INDEX "maintenance_record_orden_id_idx" ON "maintenance_record"("orden_id");

-- Relleno de lo existente, SOLO donde la orden es inequívoca; el resto queda
-- nulo (se corrige fecha, lectura e hito, pero no los datos de la orden).
--
-- 1) Órdenes de la pauta ya cerradas (las del aviso: PREVENTIVO y
--    COMPLETADA): mismo equipo (id o código interno, como guarda el taller),
--    misma vuelta y mismo hito. Solo si coincide exactamente una.
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
   AND ot.estado = 'COMPLETADA'
   AND ot.origen = 'PREVENTIVO'
  WHERE r.plan_item_id IS NOT NULL
    AND r.orden_id IS NULL
  GROUP BY r.id
  HAVING COUNT(DISTINCT ot.id) = 1
) m
WHERE mr.id = m.record_id;

-- 2) Mantenciones anteriores (registro histórico): la orden del mismo equipo
--    (por código interno, que es lo que guarda) cuya única tarea se hizo el
--    mismo día del registro (en hora de faena). Inequívoca en los dos
--    sentidos: el registro coincide con una sola orden y la orden con un solo
--    cambio (un hito y vuelta, o un servicio) de ese día. No se distingue por
--    `kind`: cada operación del hito tiene el suyo.
WITH candidatos AS (
  SELECT r.id AS record_id, ot.id AS orden_id, r.cycle, r.milestone,
         (r.plan_item_id IS NULL) AS servicio
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
),
ordenes_un_cambio AS (
  SELECT orden_id
  FROM candidatos
  GROUP BY orden_id
  HAVING COUNT(DISTINCT (cycle, milestone, servicio)) = 1
),
registros_una_orden AS (
  SELECT record_id, MIN(orden_id) AS orden_id
  FROM candidatos
  GROUP BY record_id
  HAVING COUNT(DISTINCT orden_id) = 1
)
UPDATE "maintenance_record" mr
SET "orden_id" = u.orden_id
FROM registros_una_orden u
JOIN ordenes_un_cambio o ON o.orden_id = u.orden_id
WHERE mr.id = u.record_id;
