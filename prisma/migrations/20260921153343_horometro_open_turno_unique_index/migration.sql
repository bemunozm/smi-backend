-- Garantía dura (hallazgo B2) de que un equipo no puede tener dos turnos de
-- horómetro abiertos a la vez ("turno abierto" = "valorFinal" IS NULL). El
-- `findFirst` + `create` aplicativo de `HorometroService.create()` no cierra
-- la ventana de carrera bajo READ COMMITTED (default de Postgres; ningún
-- `$transaction` del proyecto fija `isolationLevel`); este índice único
-- parcial es la garantía real a nivel de base de datos.
--
-- NOTA para quien vuelva a correr `prisma migrate dev` para una migración
-- FUTURA de este proyecto: Prisma Schema Language no tiene sintaxis para
-- índices parciales (WHERE), así que este índice NO está declarado en
-- `schema.prisma` a propósito y nunca podrá estarlo con la versión actual de
-- Prisma. Si el engine de diffing propone un `DROP INDEX
-- "RegistroHorometro_equipo_id_open_turno_key"` en la próxima migración
-- generada, es un falso positivo (cree que sobra porque el schema no lo
-- modela) — generá esa migración con `--create-only` y borrá esa línea del
-- `migration.sql` antes de aplicarla. `HorometroService` traduce el P2002
-- que dispara este índice al mismo `BadRequestException` del chequeo
-- aplicativo (fast-path de UX).
CREATE UNIQUE INDEX "RegistroHorometro_equipo_id_open_turno_key"
  ON "RegistroHorometro" ("equipo_id")
  WHERE "valorFinal" IS NULL;
