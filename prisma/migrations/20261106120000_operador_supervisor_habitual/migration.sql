-- Supervisor habitual de cada operador (pedido del cliente, 06/11): en los
-- selectores de ese supervisor el operador aparece primero, en «Tus
-- operadores». Soft ref a "user".id, sin FK (mismo criterio que los turnos).
ALTER TABLE "operator" ADD COLUMN "supervisor_habitual_id" TEXT;
CREATE INDEX "operator_supervisor_habitual_id_idx" ON "operator"("supervisor_habitual_id");

-- Carga inicial con la planilla del cliente. Cada persona se busca por nombre
-- + primer apellido (sin mayúsculas ni tildes, palabras completas) y SOLO se
-- asigna si hay una única coincidencia de cada lado: un nombre ambiguo o que
-- no existe queda sin asignar, y lo completa el administrador en Operadores.
WITH planilla (sup_nombre, sup_apellido, op_nombre, op_apellido) AS (
  VALUES
    ('limbert', 'villacorta', 'roberto', 'perez'),
    ('limbert', 'villacorta', 'milton', 'mosquera'),
    ('limbert', 'villacorta', 'flavio', 'bustamante'),
    ('jose', 'perez', 'pablo', 'soriano'),
    ('jose', 'perez', 'sebastian', 'tapia'),
    ('jose', 'perez', 'sebastian', 'figueroa'),
    ('johan', 'ibaceta', 'jose', 'astudillo'),
    ('johan', 'ibaceta', 'cesar', 'lagos'),
    ('johan', 'ibaceta', 'arturo', 'cortes'),
    ('victor', 'araya', 'samuel', 'astudillo'),
    ('victor', 'araya', 'victor', 'zavala'),
    ('victor', 'araya', 'diego', 'tejerina'),
    ('yanin', 'segura', 'hernan', 'rojas'),
    ('yanin', 'segura', 'jairo', 'cortes'),
    ('yanin', 'segura', 'hugo', 'escobar')
),
-- Nombre normalizado y rodeado de espacios, para comparar palabras completas.
usuarios AS (
  SELECT "id", ' ' || translate(lower("name"), 'áéíóúüñ', 'aeiouun') || ' ' AS n
  FROM "user"
  WHERE "role" = 'SUPERVISOR'
),
operadores AS (
  SELECT "id", ' ' || translate(lower("name"), 'áéíóúüñ', 'aeiouun') || ' ' AS n
  FROM "operator"
),
pares AS (
  SELECT
    p.*,
    (SELECT array_agg(u."id") FROM usuarios u
      WHERE u.n LIKE '% ' || p.sup_nombre || ' %' AND u.n LIKE '% ' || p.sup_apellido || ' %') AS sups,
    (SELECT array_agg(o."id") FROM operadores o
      WHERE o.n LIKE '% ' || p.op_nombre || ' %' AND o.n LIKE '% ' || p.op_apellido || ' %') AS ops
  FROM planilla p
)
UPDATE "operator" o
SET "supervisor_habitual_id" = pares.sups[1]
FROM pares
WHERE cardinality(pares.sups) = 1
  AND cardinality(pares.ops) = 1
  AND o."id" = pares.ops[1];
