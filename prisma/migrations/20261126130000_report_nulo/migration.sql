-- Report NULO: un report en papel anulado («NULO») se registra igual para
-- que la secuencia de folios no quede con huecos. No suma horas ni cobro, y
-- equipo y operador son opcionales en él.
ALTER TABLE "TrabajoExtraordinario" ADD COLUMN     "nulo" BOOLEAN NOT NULL DEFAULT false,
ALTER COLUMN "operador" DROP NOT NULL,
ALTER COLUMN "equipo_id" DROP NOT NULL;

-- Solo un report nulo puede quedar sin equipo u operador, y un nulo nunca
-- suma horas (los lectores lo excluyen igual; esto evita que entre uno mal).
ALTER TABLE "TrabajoExtraordinario" ADD CONSTRAINT "TrabajoExtraordinario_nulo_check"
  CHECK (
    "nulo"
    OR ("equipo_id" IS NOT NULL AND "operador" IS NOT NULL)
  );
ALTER TABLE "TrabajoExtraordinario" ADD CONSTRAINT "TrabajoExtraordinario_nulo_sin_horas_check"
  CHECK (NOT "nulo" OR "totalHoras" = 0);
