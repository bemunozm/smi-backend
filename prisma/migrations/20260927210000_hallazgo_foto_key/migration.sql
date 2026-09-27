-- Hallazgos: foto al storage privado, igual que Combustible.
--
-- Aditiva a propósito. `fotoUrl` queda como está: los hallazgos ya cargados
-- apuntan a /api/uploads y se tienen que seguir viendo. Los nuevos suben por
-- POST /api/files y guardan la key, que la API firma al devolverla.
--
-- No hay backfill: mover los archivos viejos al bucket es una tarea aparte,
-- y hasta que se haga las dos formas conviven sin pisarse.

ALTER TABLE "Hallazgo" ADD COLUMN "fotoKey" TEXT;
