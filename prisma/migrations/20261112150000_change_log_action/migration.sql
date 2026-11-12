-- Qué pasó con el registro: hasta ahora el historial solo guardaba
-- correcciones (UPDATE). Las eliminaciones definitivas empiezan a dejar su
-- propia fila (action = 'DELETE') con el resumen de lo borrado en `changes`.
ALTER TABLE "change_log" ADD COLUMN "action" TEXT NOT NULL DEFAULT 'UPDATE';
