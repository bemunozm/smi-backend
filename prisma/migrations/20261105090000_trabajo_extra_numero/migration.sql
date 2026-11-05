-- N° de Report correlativo para los trabajos extraordinarios.
-- Los existentes se numeran por orden de creación (desempate por fecha e id);
-- los nuevos toman el siguiente de la secuencia, que es lo que Prisma espera
-- de `@default(autoincrement())`.
ALTER TABLE "TrabajoExtraordinario" ADD COLUMN "numero" INTEGER;

WITH ordenados AS (
  SELECT "id", ROW_NUMBER() OVER (ORDER BY "created_at", "fecha", "id") AS n
  FROM "TrabajoExtraordinario"
)
UPDATE "TrabajoExtraordinario" t
SET "numero" = ordenados.n
FROM ordenados
WHERE t."id" = ordenados."id";

CREATE SEQUENCE "TrabajoExtraordinario_numero_seq" OWNED BY "TrabajoExtraordinario"."numero";
SELECT setval(
  '"TrabajoExtraordinario_numero_seq"',
  COALESCE((SELECT MAX("numero") FROM "TrabajoExtraordinario"), 0) + 1,
  false
);

ALTER TABLE "TrabajoExtraordinario"
  ALTER COLUMN "numero" SET DEFAULT nextval('"TrabajoExtraordinario_numero_seq"'),
  ALTER COLUMN "numero" SET NOT NULL;

CREATE UNIQUE INDEX "TrabajoExtraordinario_numero_key" ON "TrabajoExtraordinario"("numero");
