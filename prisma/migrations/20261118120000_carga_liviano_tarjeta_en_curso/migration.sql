-- Cargas de combustible registradas en una tarjeta de liviano ABIERTA sin
-- cerrarla (POST /api/shift-cards/:id/fuel-loads). FK opcional y NO único
-- (1:N): la carga del cierre sigue siendo la 1:1 de "registro_horometro_id".

-- AlterTable
ALTER TABLE "RegistroCombustible" ADD COLUMN     "tarjeta_en_curso_id" TEXT;

-- CreateIndex
CREATE INDEX "RegistroCombustible_tarjeta_en_curso_id_idx" ON "RegistroCombustible"("tarjeta_en_curso_id");

-- AddForeignKey
ALTER TABLE "RegistroCombustible" ADD CONSTRAINT "RegistroCombustible_tarjeta_en_curso_id_fkey" FOREIGN KEY ("tarjeta_en_curso_id") REFERENCES "RegistroHorometro"("id") ON DELETE SET NULL ON UPDATE CASCADE;
