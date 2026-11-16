-- Motivo por el que una tarjeta se cerró sin carga de combustible (corte de
-- luz, surtidor sin combustible, etc.). Pedido del cliente, 16/11/2026.
ALTER TABLE "RegistroHorometro" ADD COLUMN "no_fuel_reason" TEXT;
