-- Anexo (28/09 noche) del RFC "Supervisión en Terreno": el operador deja de
-- ser usuario de la plataforma. El catálogo `Operator` ya existía (Fase 1,
-- migración `20260928161111_shift_register_foundations`); esta migración:
--   1) copia al catálogo cada usuario con rol OPERADOR que no tenga ya un
--      homónimo sembrado (trim + case-insensitive por nombre), sin insertar
--      duplicados entre sí cuando dos usuarios OPERADOR comparten el mismo
--      nombre normalizado;
--   2) repunta `equipment.current_operator_id`, del id de ese usuario al
--      `operator.id` correspondiente, eligiendo un único operador por nombre
--      normalizado de forma determinística aunque el catálogo ya tuviera
--      homónimos duplicados de antes (p.ej. creados a mano vía
--      `/api/operators`);
--   3) limpia a NULL cualquier `current_operator_id` que no haya podido
--      resolverse contra el catálogo (defensivo — no debería quedar ninguno
--      tras el paso 2, pero la FK del paso 4 no tolera un id huérfano);
--   4) agrega la FK real `equipment.current_operator_id -> operator.id`
--      (`ON DELETE SET NULL ON UPDATE CASCADE`, igual que Prisma genera);
--   5) borra las filas `user` con rol OPERADOR — primero sus notificaciones
--      explícitas (`notification.userId` es soft ref, sin FK, así que no cae
--      en cascada), y luego las filas `user` (`session`/`account` sí caen en
--      cascada, `onDelete: Cascade` en el schema);
--   6) cambia el default de `user.role` a 'MANTENEDOR'.
--
-- Generada a mano: `prisma migrate diff --from-migrations prisma/migrations
-- --to-schema-datamodel prisma/schema.prisma --shadow-database-url ...`
-- contra una shadow DB descartable solo devuelve el ALTER DEFAULT (paso 6) y
-- el ADD CONSTRAINT (paso 4) — el schema no puede expresar los pasos de
-- datos 1/2/3/5, así que se agregaron a mano, en el orden que exige la FK
-- nueva. Mismo criterio que la migración anterior: el entorno no es
-- interactivo, `migrate dev` no soporta prompts en este shell. Verificada
-- con el mismo comando contra una shadow DB descartable: diff vacío tras
-- aplicarla (ver también "Verify" del anexo). No hay datos en producción; en
-- los entornos de dev solo existe un usuario OPERADOR ('operador@smi.local').
-- Nota: a diferencia de la migración de Fase 1, acá NO aparece el falso
-- `DROP INDEX` del índice parcial de `RegistroHorometro` — esta migración no
-- toca esa tabla.
--
-- Fix (28/09, verificado por QA antes de aplicarse a ningún ambiente
-- compartido): la versión original del paso 1 filtraba con
-- `NOT EXISTS (SELECT 1 FROM "operator" ...)`, pero en PostgreSQL ese
-- `NOT EXISTS` ve el snapshot de `operator` al INICIO del statement, no las
-- filas que el propio INSERT va agregando. Si dos usuarios OPERADOR
-- compartían el mismo nombre normalizado (`lower(trim(name))`), ambos
-- pasaban el filtro y se insertaban dos operadores duplicados — y el UPDATE
-- del paso 2 (un JOIN sin desambiguar) repunteaba cada equipo a "el que sea"
-- de los dos, de forma no determinística. Se corrige deduplicando DENTRO del
-- propio SELECT del paso 1 (`DISTINCT ON` por nombre normalizado, antes de
-- aplicar el `NOT EXISTS` contra el catálogo preexistente), y haciendo el
-- paso 2 determinístico con el mismo patrón — así también cubre el caso de
-- catálogos que ya tuvieran duplicados de antes por otra vía (alta manual).

-- 1) Copia al catálogo cada usuario OPERADOR sin homónimo ya sembrado,
--    deduplicando primero entre los propios usuarios OPERADOR homónimos
--    (se queda con el más antiguo por `"createdAt"`, luego por `"id"` como
--    desempate estable) para que el INSERT no intente crear dos operadores
--    para el mismo nombre normalizado.
INSERT INTO "operator" ("id", "name", "is_active", "created_at", "updated_at")
SELECT
  'op' || replace(gen_random_uuid()::text, '-', ''),
  d."name",
  true,
  now(),
  now()
FROM (
  SELECT DISTINCT ON (lower(trim(u."name"))) u."name"
  FROM "user" u
  WHERE u."role" = 'OPERADOR'
  ORDER BY lower(trim(u."name")), u."createdAt", u."id"
) d
WHERE NOT EXISTS (
  SELECT 1 FROM "operator" o
  WHERE lower(trim(o."name")) = lower(trim(d."name"))
);

-- 2) Repunta la asignación de Flota del id de usuario al id de catálogo,
--    emparejando por el mismo criterio de nombre que el paso 1. El target se
--    elige de forma determinística (un único operador por nombre
--    normalizado, el más antiguo por `created_at`/`id`) por si el catálogo
--    ya tenía más de un operador homónimo antes de esta migración — sin
--    esto, un JOIN plano contra homónimos duplicados repuntearía cada fila
--    de `equipment` a un operador arbitrario.
UPDATE "equipment" e
SET "current_operator_id" = t."operator_id"
FROM "user" u
JOIN (
  SELECT DISTINCT ON (lower(trim(o."name")))
    lower(trim(o."name")) AS "norm_name",
    o."id" AS "operator_id"
  FROM "operator" o
  ORDER BY lower(trim(o."name")), o."created_at", o."id"
) t ON t."norm_name" = lower(trim(u."name"))
WHERE e."current_operator_id" = u."id"
  AND u."role" = 'OPERADOR';

-- 3) Defensivo: cualquier referencia que no se haya podido resolver contra
--    el catálogo se limpia a NULL — la FK del paso 4 no tolera un id
--    huérfano.
UPDATE "equipment"
SET "current_operator_id" = NULL
WHERE "current_operator_id" IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM "operator" o WHERE o."id" = "equipment"."current_operator_id"
  );

-- 4) FK real, igual a la que Prisma genera para `Equipment.currentOperator`.
ALTER TABLE "equipment" ADD CONSTRAINT "equipment_current_operator_id_fkey" FOREIGN KEY ("current_operator_id") REFERENCES "operator"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- 5) Se elimina el rol OPERADOR de la plataforma: notificaciones explícitas
--    primero (soft ref, sin FK), luego las filas `user` (`session`/`account`
--    caen en cascada).
DELETE FROM "notification"
WHERE "userId" IN (SELECT "id" FROM "user" WHERE "role" = 'OPERADOR');

DELETE FROM "user" WHERE "role" = 'OPERADOR';

-- 6) Nuevo default para usuarios nuevos sin rol explícito — en la práctica
--    inalcanzable hoy (`disableSignUp` + `CreateUserDto.role` obligatorio,
--    ver `src/auth/auth.ts`), se mantiene por consistencia con el generador.
ALTER TABLE "user" ALTER COLUMN "role" SET DEFAULT 'MANTENEDOR';
