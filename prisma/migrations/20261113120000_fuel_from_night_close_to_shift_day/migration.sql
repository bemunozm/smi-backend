-- Pedido del cliente (13-11): el término del turno NOCTURNO pertenece al día
-- en que ABRIÓ (20:00–08:00) — una carga de combustible nacida del cierre de
-- la madrugada del 13 debe listarse/agruparse en el 12. El código ya fecha así
-- los cierres nuevos (`liveCloseFuelDate`); esto corrige las filas existentes:
-- cargas de tarjeta NOCTURNO cuya `fecha` cayó entre las 00:00 y las 07:59
-- hora de Chile se re-fechan al día chileno anterior, 20:30 −03:00 (= 23:30
-- UTC, el mismo instante sintético de `businessDayInstant(día, '20:30')`).
-- Solo tarjetas NOCTURNO: es el caso inequívoco; manuales y ya-sintéticas
-- (20:30/12:00 −03, hora local ≥ 08) no entran en el WHERE. `created_at`
-- conserva el instante real del registro (el panel muestra «registrada el …»).
--
-- `fecha` es TIMESTAMP(3) naive guardado en UTC (Prisma): naive→UTC→hora
-- chilena exige el doble AT TIME ZONE.
UPDATE "RegistroCombustible" rc
SET "fecha" = ((rc."fecha" AT TIME ZONE 'UTC' AT TIME ZONE 'America/Santiago')::date - 1)
              + interval '23 hours 30 minutes'
FROM "RegistroHorometro" rh
WHERE rc."registro_horometro_id" = rh."id"
  AND rh."turno" = 'NOCTURNO'
  AND EXTRACT(HOUR FROM (rc."fecha" AT TIME ZONE 'UTC' AT TIME ZONE 'America/Santiago')) < 8;
