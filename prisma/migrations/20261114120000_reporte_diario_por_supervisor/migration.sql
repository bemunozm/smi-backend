-- Un reporte por turno POR SUPERVISOR: dos supervisores del mismo turno
-- reportan cada uno el suyo. El unique global (fecha, turno) hacía que el
-- segundo supervisor chocara con un 409 aunque su reporte fuera distinto.
DROP INDEX "reporte_diario_fecha_turno_key";

-- CreateIndex
CREATE UNIQUE INDEX "reporte_diario_fecha_turno_supervisor_id_key" ON "reporte_diario"("fecha", "turno", "supervisor_id");
