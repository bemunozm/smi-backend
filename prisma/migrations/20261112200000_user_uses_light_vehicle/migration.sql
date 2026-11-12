-- Administradores que usan camioneta (RFC-camioneta-administradores).
ALTER TABLE "user" ADD COLUMN "uses_light_vehicle" BOOLEAN NOT NULL DEFAULT false;
