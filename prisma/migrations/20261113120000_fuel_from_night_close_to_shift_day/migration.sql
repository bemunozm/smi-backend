-- Pedido del cliente (13-11, regla corregida en segunda iteración): la carga
-- de combustible nacida del cierre de una tarjeta pertenece al DÍA DEL TURNO
-- en que quedó reportada la tarjeta — el turno de quien cerró el liviano
-- (`closed_shift_id`) o el turno en que se abrió (`shift_id`) — aunque el
-- cierre real haya caído en otro día de calendario, incluso pasadas las 08:00
-- del día siguiente. El código ya fecha así los cierres nuevos
-- (`fuelDateForShiftDay`); esto corrige las filas existentes: cargas de
-- tarjeta cuyo día chileno de `fecha` difiere del día del turno se re-fechan
-- al instante sintético de ese día (20:30 −03 NOCTURNO = 23:30 UTC,
-- 12:00 −03 DIURNO = 15:00 UTC — patrón de `businessDayInstant`). Manuales
-- (sin tarjeta) y filas ya coherentes no entran en el WHERE; una tarjeta sin
-- `Shift` (soft ref rota, excepcional) queda como está. `created_at` conserva
-- el instante real del registro (el panel muestra «registrada el …»).
--
-- `fecha` es TIMESTAMP(3) naive guardado en UTC (Prisma): naive→UTC→día
-- chileno exige el doble AT TIME ZONE. `shift.date` es DATE (el día del
-- turno, sin hora).
UPDATE "RegistroCombustible" rc
SET "fecha" = s."date" + CASE WHEN s."type" = 'NOCTURNO'
                              THEN interval '23 hours 30 minutes'
                              ELSE interval '15 hours' END
FROM "RegistroHorometro" rh
JOIN "shift" s ON s."id" = COALESCE(rh."closed_shift_id", rh."shift_id")
WHERE rc."registro_horometro_id" = rh."id"
  AND (rc."fecha" AT TIME ZONE 'UTC' AT TIME ZONE 'America/Santiago')::date
      <> s."date";
