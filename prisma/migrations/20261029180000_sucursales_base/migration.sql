-- Sucursales (bodegas) base del inventario. Hasta ahora solo las creaba el seed
-- (`prisma/seed.ts`, `BRANCHES`), que NO corre en producción, y no hay pantalla
-- para crearlas: sin ninguna, el alta de ítems con existencia inicial fallaba
-- con «branchId must be longer than or equal to 1 characters». Mismos nombres
-- que el seed. ON CONFLICT DO NOTHING: no duplica ni pisa lo que ya exista.

INSERT INTO "branch" ("id", "name", "address", "is_active", "updated_at") VALUES
  (gen_random_uuid()::text, 'Casa Matriz', 'Iquique', true, CURRENT_TIMESTAMP),
  (gen_random_uuid()::text, 'Faena', 'Faena minera, s/n', true, CURRENT_TIMESTAMP)
ON CONFLICT ("name") DO NOTHING;
