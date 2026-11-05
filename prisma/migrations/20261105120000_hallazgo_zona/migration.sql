-- Hallazgos de ZONA (un lugar de la faena) además de los de EQUIPO.
-- Los existentes quedan como EQUIPO; uno de zona lleva faena y lugar, sin equipo.
ALTER TABLE "Hallazgo"
  ADD COLUMN "tipo" TEXT NOT NULL DEFAULT 'EQUIPO',
  ADD COLUMN "faena" TEXT,
  ADD COLUMN "lugar" TEXT,
  ALTER COLUMN "equipo_id" DROP NOT NULL;

-- Cada tipo con lo suyo: el de equipo tiene equipo, el de zona su lugar.
ALTER TABLE "Hallazgo" ADD CONSTRAINT "Hallazgo_tipo_check" CHECK (
  ("tipo" = 'EQUIPO' AND "equipo_id" IS NOT NULL)
  OR ("tipo" = 'ZONA' AND "equipo_id" IS NULL AND "faena" IS NOT NULL AND "lugar" IS NOT NULL)
);
