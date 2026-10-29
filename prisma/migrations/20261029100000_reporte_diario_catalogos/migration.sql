-- Catálogos del Reporte diario (Módulo B): las plantas y las empresas externas.
-- Hasta ahora solo los creaba el seed (`prisma/seeds/reporte-diario.seed.ts`),
-- que NO corre en producción: el despliegue solo aplica migraciones, así que
-- «Operaciones en planta» quedaba sin filas. Mismos nombres y orden que el seed.
-- ON CONFLICT DO NOTHING: no duplica ni pisa lo que ya exista (si una base ya
-- los tenía, o el administrador desactivó alguno, queda como estaba).

INSERT INTO "planta" ("id", "nombre", "orden", "activa", "updated_at") VALUES
  (gen_random_uuid()::text, 'P.P.1', 0, true, CURRENT_TIMESTAMP),
  (gen_random_uuid()::text, 'P.P.2', 1, true, CURRENT_TIMESTAMP),
  (gen_random_uuid()::text, 'P.R.2', 2, true, CURRENT_TIMESTAMP),
  (gen_random_uuid()::text, 'P.P.4', 3, true, CURRENT_TIMESTAMP),
  (gen_random_uuid()::text, 'P.R.4', 4, true, CURRENT_TIMESTAMP),
  (gen_random_uuid()::text, 'Apoyo piso Mina-Puerto', 5, true, CURRENT_TIMESTAMP),
  (gen_random_uuid()::text, 'Apoyo piso externos', 6, true, CURRENT_TIMESTAMP),
  (gen_random_uuid()::text, 'Producto Camino', 7, true, CURRENT_TIMESTAMP),
  (gen_random_uuid()::text, 'Producto Fino', 8, true, CURRENT_TIMESTAMP),
  (gen_random_uuid()::text, 'Planta P.P.E', 9, true, CURRENT_TIMESTAMP)
ON CONFLICT ("nombre") DO NOTHING;

INSERT INTO "empresa_externa" ("id", "nombre", "activa", "updated_at") VALUES
  (gen_random_uuid()::text, 'Hyd', true, CURRENT_TIMESTAMP),
  (gen_random_uuid()::text, 'Casa Blanca', true, CURRENT_TIMESTAMP),
  (gen_random_uuid()::text, 'Coseducam', true, CURRENT_TIMESTAMP),
  (gen_random_uuid()::text, 'Sijam', true, CURRENT_TIMESTAMP)
ON CONFLICT ("nombre") DO NOTHING;
