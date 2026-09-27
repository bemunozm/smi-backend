-- RFC R2-storage, Fase 2: los 3 usos de Flota pasan de guardar una URL a
-- guardar la KEY del objeto en el bucket de storage (R2/MinIO) — la URL
-- firmada se resuelve on-read (`StorageService.sign`), nunca se persiste.
--
-- Los RENAME COLUMN preservan los datos existentes (a diferencia de un
-- DROP+ADD, que es lo que `prisma migrate dev`/`migrate diff` proponen por
-- defecto para un cambio de nombre de columna — Prisma no tiene detección
-- automática de rename fuera del prompt interactivo de `migrate dev`, que no
-- corre en este entorno no interactivo). Las columnas legacy (`photo_url`,
-- `file_url`) tenían URLs de `/uploads/...` (Flota vieja) o del seed
-- (picsum.photos) — ninguna de las dos sirve como key de bucket, así que el
-- UPDATE que sigue a cada RENAME las anula explícitamente.
--
-- NOTA para quien vuelva a correr `prisma migrate dev`/`migrate diff` sobre
-- este proyecto: el índice único parcial
-- "RegistroHorometro_equipo_id_open_turno_key" (ver migración
-- 20260921153343_horometro_open_turno_unique_index) NO está declarado en
-- `schema.prisma` a propósito (Prisma Schema Language no soporta índices
-- parciales) y esta migración NO lo toca. Si el engine de diffing propone un
-- DROP INDEX de ese índice en una migración futura, es el mismo falso
-- positivo ya documentado — generar con `--create-only` y borrar esa línea
-- antes de aplicar.

-- AlterTable: equipment.photo_url -> photo_key
ALTER TABLE "equipment" RENAME COLUMN "photo_url" TO "photo_key";

-- Limpia las URLs picsum.photos del seed (no son keys de bucket válidas) —
-- cualquier otro valor legacy no reconocible tampoco es una key `equipment-
-- photos/...` real, así que se anula igual.
UPDATE "equipment"
SET "photo_key" = NULL
WHERE "photo_key" IS NOT NULL
  AND "photo_key" NOT LIKE 'equipment-photos/%';

-- AlterTable: equipment_document.file_url -> file_key
ALTER TABLE "equipment_document" RENAME COLUMN "file_url" TO "file_key";

-- Limpia las rutas legacy `/uploads/...` (no son keys de bucket válidas).
UPDATE "equipment_document"
SET "file_key" = NULL
WHERE "file_key" IS NOT NULL
  AND "file_key" NOT LIKE 'equipment-documents/%';

-- AlterTable: equipment_document gana file_name (nombre "humano" del archivo,
-- para el Content-Disposition — file_key es un uuid sin significado).
ALTER TABLE "equipment_document" ADD COLUMN "file_name" TEXT;

-- AlterTable: RegistroCombustible gana fotoKey, ADITIVO sobre fotoUrl legacy
-- (Terreno sigue usando /api/uploads + fotoUrl para su propia vista — ver
-- Diseño del RFC R2-storage, "Combustible"). Sin @map en el modelo (mismo
-- criterio sin snake_case del resto de Terreno), así que acá también va sin
-- mapear.
ALTER TABLE "RegistroCombustible" ADD COLUMN "fotoKey" TEXT;
