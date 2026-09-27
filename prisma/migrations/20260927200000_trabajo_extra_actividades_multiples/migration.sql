-- Trabajos extraordinarios: de UNA actividad a VARIAS, más «Otro» en texto libre.
--
-- La especificación del 21/09 pide multi-selección con una opción «Otro»: una
-- misma salida suele mezclar tareas (soltar material y después limpiar la
-- cancha es un trabajo, no dos), y con una sola columna el supervisor tenía
-- que elegir cuál reportar y perder la otra.
--
-- Los registros que ya existen NO se pierden: su única actividad pasa a ser el
-- primer (y único) elemento del arreglo. Por eso la columna vieja se borra
-- recién después de copiar.

ALTER TABLE "TrabajoExtraordinario"
  ADD COLUMN "actividades" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  ADD COLUMN "otra_actividad" TEXT;

UPDATE "TrabajoExtraordinario"
  SET "actividades" = ARRAY["actividad"]
  WHERE "actividad" IS NOT NULL;

ALTER TABLE "TrabajoExtraordinario" DROP COLUMN "actividad";

-- El default existía solo para poder agregar la columna como NOT NULL sobre
-- filas ya escritas. De acá en adelante el arreglo lo manda siempre el
-- servicio, que además exige al menos una actividad.
ALTER TABLE "TrabajoExtraordinario" ALTER COLUMN "actividades" DROP DEFAULT;
