-- Contador con que el equipo empezó a llevarse en el sistema: los hitos que
-- vencían antes se dan por hechos («previos al sistema»).
ALTER TABLE "maintenance_plan" ADD COLUMN "baseline_counter" DOUBLE PRECISION;

-- Las pautas ya creadas toman el contador actual de su equipo: es el que tenía
-- al entrar al sistema, porque las pautas existen desde el 06/10/2026.
UPDATE "maintenance_plan" p
SET "baseline_counter" = CASE
  WHEN e."control_unit" = 'KM' THEN e."current_mileage"
  ELSE e."current_hourmeter"
END
FROM "equipment" e
WHERE e."id" = p."equipment_id";
