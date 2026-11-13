-- ============================================================================
-- Borra lo que registraron los SUPERVISORES, para que vuelvan a cargar desde
-- el 1 de noviembre (pedido de Joaquín, 12/11/2026: un supervisor aprendió con
-- datos de prueba en producción).
--
-- QUÉ BORRA (de usuarios con rol SUPERVISOR):
--   1. Tarjetas de turno (`RegistroHorometro`) que el supervisor abrió o cerró,
--      pesados y livianos.
--   2. Cargas de combustible: las de esas tarjetas y las que el supervisor creó
--      a mano.
--   3. Informes diarios de equipos (`shift_exit_report`) y sus turnos (`shift`).
--   4. Producción diaria (`reporte_diario` y sus tablas hijas, por cascada).
--   5. Historial de ediciones (`change_log`) y avisos (`notification`) de
--      todo lo anterior, para que el Registro de actividad no muestre
--      ediciones de registros que ya no existen.
--
-- QUÉ NO TOCA: lo que cargaron administradores, mantenedores, prevencionistas
-- o la secretaria a su nombre; usuarios, equipos, operadores, inventario,
-- mantenciones, hallazgos, Reports y checklists. Las fotos quedan en el
-- almacenamiento (sin registro que las use); se pueden limpiar después.
--
-- CONTADORES: cada equipo con tarjetas borradas queda como si los
-- supervisores nunca hubieran registrado: con la lectura más alta que quede de
-- otros (admin, mantenedor, Flota) o, si no queda ninguna, con la lectura más
-- baja de las tarjetas borradas (un contador bajo no rechaza nada y sube solo
-- con la siguiente lectura real; uno inflado por un dato de prueba bloquearía
-- los cierres de noviembre). La tabla de la prueba lo muestra para revisarlo.
--
-- USO (en el servidor, desde la carpeta del backend):
--   0) Respaldo, SIEMPRE antes:
--      docker compose -f docker-compose.prod.yml exec -T postgres \
--        pg_dump -U smi_user -d smi_db -Fc > respaldo-antes-reset-$(date +%F-%H%M).dump
--   1) Prueba (no borra nada, muestra conteos y contadores, termina en ROLLBACK):
--      docker compose -f docker-compose.prod.yml exec -T postgres \
--        psql -U smi_user -d smi_db -v aplicar=0 -v ON_ERROR_STOP=1 < scripts/sql/reset-registros-supervisores.sql
--   2) Aplicar (mismo comando con aplicar=1, termina en COMMIT):
--      ... -v aplicar=1 ...
--   Restaurar el respaldo si algo sale mal:
--      docker compose -f docker-compose.prod.yml exec -T postgres \
--        pg_restore -U smi_user -d smi_db --clean --if-exists < respaldo-....dump
-- ============================================================================

\if :{?aplicar}
\else
  \set aplicar 0
\endif

BEGIN;

-- Supervisores ---------------------------------------------------------------
CREATE TEMP TABLE sup ON COMMIT DROP AS
  SELECT id, name, email FROM "user" WHERE role = 'SUPERVISOR';

-- Tarjetas que abrió o cerró un supervisor ------------------------------------
CREATE TEMP TABLE del_cards ON COMMIT DROP AS
  SELECT r.id, r.equipo_id, r.fecha, r.created_at, r."valorInicial"
  FROM "RegistroHorometro" r
  WHERE r.supervisor_id IN (SELECT id FROM sup)
     OR r.closed_by_id IN (SELECT id FROM sup);

-- Cargas: las de esas tarjetas + las manuales del supervisor ------------------
CREATE TEMP TABLE del_fuel ON COMMIT DROP AS
  SELECT c.id FROM "RegistroCombustible" c
  WHERE c.registro_horometro_id IN (SELECT id FROM del_cards)
     OR c.created_by_id IN (SELECT id FROM sup);

-- Turnos e informes diarios de equipos de los supervisores --------------------
CREATE TEMP TABLE del_shifts ON COMMIT DROP AS
  SELECT s.id FROM shift s WHERE s.supervisor_id IN (SELECT id FROM sup);

CREATE TEMP TABLE del_exit ON COMMIT DROP AS
  SELECT e.id FROM shift_exit_report e
  WHERE e.shift_id IN (SELECT id FROM del_shifts)
     OR e.created_by_id IN (SELECT id FROM sup);

-- Producción diaria ------------------------------------------------------------
CREATE TEMP TABLE del_prod ON COMMIT DROP AS
  SELECT d.id FROM reporte_diario d WHERE d.supervisor_id IN (SELECT id FROM sup);

-- Todos los ids borrados, para el historial y los avisos -----------------------
CREATE TEMP TABLE del_ids ON COMMIT DROP AS
  SELECT id FROM del_cards UNION SELECT id FROM del_fuel
  UNION SELECT id FROM del_exit UNION SELECT id FROM del_prod;

-- Contador objetivo por equipo -------------------------------------------------
CREATE TEMP TABLE contadores ON COMMIT DROP AS
WITH primera AS (
  SELECT equipo_id, MIN("valorInicial") AS inicial
  FROM del_cards
  GROUP BY equipo_id
),
restantes AS (
  SELECT r.equipo_id,
         MAX(GREATEST(r."valorInicial", COALESCE(r."valorFinal", r."valorInicial"))) AS maximo
  FROM "RegistroHorometro" r
  WHERE r.id NOT IN (SELECT id FROM del_cards)
  GROUP BY r.equipo_id
)
SELECT e.id AS equipo_id,
       e.internal_code,
       e.control_unit,
       CASE WHEN e.control_unit = 'KM' THEN e.current_mileage ELSE e.current_hourmeter END AS actual,
       p.inicial AS lectura_mas_baja_borrada,
       x.maximo AS maximo_restante,
       COALESCE(x.maximo, p.inicial) AS nuevo
FROM primera p
JOIN equipment e ON e.id = p.equipo_id
LEFT JOIN restantes x ON x.equipo_id = p.equipo_id;

-- Resumen ------------------------------------------------------------------------
\echo
\echo '=== Supervisores ==='
SELECT name, email FROM sup ORDER BY name;

\echo '=== Lo que se borraría ==='
SELECT 'Tarjetas de turno' AS que, COUNT(*) FROM del_cards
UNION ALL SELECT 'Cargas de combustible', COUNT(*) FROM del_fuel
UNION ALL SELECT 'Informes diarios de equipos', COUNT(*) FROM del_exit
UNION ALL SELECT 'Turnos', COUNT(*) FROM del_shifts
UNION ALL SELECT 'Producción diaria', COUNT(*) FROM del_prod
UNION ALL SELECT 'Historial de ediciones', COUNT(*) FROM change_log WHERE entity_id IN (SELECT id FROM del_ids)
UNION ALL SELECT 'Avisos', COUNT(*) FROM notification n
  WHERE n.data IS NOT NULL AND EXISTS (SELECT 1 FROM del_ids d WHERE n.data::text LIKE '%' || d.id || '%');

\echo '=== Contadores: actual -> nuevo (revisar antes de aplicar) ==='
SELECT internal_code AS equipo, control_unit AS unidad, actual,
       lectura_mas_baja_borrada, maximo_restante, nuevo
FROM contadores ORDER BY internal_code;

-- Borrado (en orden: primero lo que referencia a otros) ------------------------
DELETE FROM notification n
  WHERE n.data IS NOT NULL AND EXISTS (SELECT 1 FROM del_ids d WHERE n.data::text LIKE '%' || d.id || '%');
DELETE FROM change_log WHERE entity_id IN (SELECT id FROM del_ids);
DELETE FROM "RegistroCombustible" WHERE id IN (SELECT id FROM del_fuel);
DELETE FROM shift_exit_report WHERE id IN (SELECT id FROM del_exit);
DELETE FROM "RegistroHorometro" WHERE id IN (SELECT id FROM del_cards);
-- Un turno de supervisor que todavía tenga tarjetas de otros no se borra.
DELETE FROM shift s WHERE s.id IN (SELECT id FROM del_shifts)
  AND NOT EXISTS (SELECT 1 FROM "RegistroHorometro" r WHERE r.shift_id = s.id)
  AND NOT EXISTS (SELECT 1 FROM shift_exit_report e WHERE e.shift_id = s.id);
DELETE FROM reporte_diario WHERE id IN (SELECT id FROM del_prod);

UPDATE equipment e SET
  current_mileage   = CASE WHEN c.control_unit = 'KM' THEN c.nuevo ELSE e.current_mileage END,
  current_hourmeter = CASE WHEN c.control_unit = 'KM' THEN e.current_hourmeter ELSE c.nuevo END
FROM contadores c WHERE c.equipo_id = e.id;

\echo '=== Quedan (deben ser 0) ==='
SELECT 'Tarjetas de supervisores' AS que, COUNT(*) FROM "RegistroHorometro"
  WHERE supervisor_id IN (SELECT id FROM sup) OR closed_by_id IN (SELECT id FROM sup)
UNION ALL SELECT 'Producción diaria de supervisores', COUNT(*) FROM reporte_diario
  WHERE supervisor_id IN (SELECT id FROM sup);

\if :aplicar
  \echo '>>> APLICADO: COMMIT'
  COMMIT;
\else
  \echo '>>> PRUEBA: ROLLBACK (no se borró nada). Para aplicar: -v aplicar=1'
  ROLLBACK;
\endif
