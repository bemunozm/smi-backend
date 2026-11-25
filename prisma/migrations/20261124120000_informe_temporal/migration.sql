-- AlterTable
ALTER TABLE "RegistroHorometro" ADD COLUMN     "informe_temporal_id" TEXT,
ADD COLUMN     "temporal" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "informe_temporal" (
    "id" TEXT NOT NULL,
    "numero" SERIAL NOT NULL,
    "fecha" DATE NOT NULL,
    "turno" TEXT NOT NULL,
    "actividad1" TEXT NOT NULL,
    "actividad2" TEXT,
    "personal" JSONB NOT NULL,
    "observaciones" TEXT,
    "supervisorResponsable1" TEXT NOT NULL,
    "supervisorResponsable2" TEXT,
    "supervisorId" TEXT NOT NULL,
    "supervisorNombre" TEXT NOT NULL,
    "inicio" TIMESTAMP(3) NOT NULL,
    "fin" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "informe_temporal_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "informe_temporal_numero_key" ON "informe_temporal"("numero");

-- CreateIndex
CREATE INDEX "informe_temporal_fecha_idx" ON "informe_temporal"("fecha");

-- CreateIndex
CREATE INDEX "RegistroHorometro_informe_temporal_id_idx" ON "RegistroHorometro"("informe_temporal_id");

-- CreateIndex
CREATE INDEX "RegistroHorometro_supervisor_id_temporal_idx" ON "RegistroHorometro"("supervisor_id", "temporal");

-- AddForeignKey
ALTER TABLE "RegistroHorometro" ADD CONSTRAINT "RegistroHorometro_informe_temporal_id_fkey" FOREIGN KEY ("informe_temporal_id") REFERENCES "informe_temporal"("id") ON DELETE SET NULL ON UPDATE CASCADE;

