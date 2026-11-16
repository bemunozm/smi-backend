-- AdBlue cargado junto con una carga manual de combustible (L); las cargas
-- nacidas de cierre de tarjeta lo resuelven desde su tarjeta vinculada.
ALTER TABLE "RegistroCombustible" ADD COLUMN     "ad_blue_litros" DOUBLE PRECISION;
