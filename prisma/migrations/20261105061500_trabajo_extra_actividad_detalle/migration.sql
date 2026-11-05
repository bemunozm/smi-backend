-- El «dónde se hizo» es POR ACTIVIDAD, no del report completo (cliente,
-- 05-11): el desglose vive en `detalle_actividades` (JSON de filas
-- {actividad, lugar, planta, horas}) y las columnas sueltas se van antes de
-- llegar a producción (esta rama nunca se desplegó).
ALTER TABLE "TrabajoExtraordinario"
ADD COLUMN "detalle_actividades" JSONB,
DROP COLUMN "destino",
DROP COLUMN "planta";
