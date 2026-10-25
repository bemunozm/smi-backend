-- Livianos en Registro de equipo: la tarjeta la puede cerrar otro supervisor,
-- y entra en el reporte de salida del turno en que se cierra.

-- AlterTable
ALTER TABLE "RegistroHorometro" ADD COLUMN "closed_by_id" TEXT,
ADD COLUMN "closed_by_name" TEXT,
ADD COLUMN "closed_shift_id" TEXT;

-- CreateIndex
CREATE INDEX "RegistroHorometro_closed_shift_id_idx" ON "RegistroHorometro"("closed_shift_id");
