-- Motivo nuevo del kardex: salida automática de AdBlue al declararse una carga
-- (cierre de tarjeta de turno o carga manual del panel). Va en su PROPIA
-- migración, separada del backfill que lo usa: Postgres no permite usar un
-- valor de enum en la misma transacción que lo agrega, y cada migración de
-- Prisma corre en su propia transacción.
ALTER TYPE "MovementReason" ADD VALUE 'ADBLUE_LOAD';
