-- Fase 1 del RFC "Supervisión en Terreno: Módulo A real + offline + roles/
-- operadores + cierre de R2": columnas nuevas de `RegistroHorometro`
-- (reutilizada como "tarjeta de turno" en Fase 2), `Shift`, `ShiftExitReport`,
-- `Operator` y el vínculo 1:1 `RegistroCombustible.registroHorometroId`.
--
-- Generada a mano con `prisma migrate diff --from-migrations ... --to-schema-
-- datamodel ... --shadow-database-url ...` (no con `migrate dev
-- --create-only`: el entorno no es interactivo, ver CONTRIBUTING.md) porque
-- `migrate dev` no soporta prompts en este shell. Verificada con el mismo
-- comando contra una shadow DB descartable: diff vacío tras aplicarla.

-- AlterTable
ALTER TABLE "RegistroCombustible" ADD COLUMN     "registro_horometro_id" TEXT;

-- AlterTable
ALTER TABLE "RegistroHorometro" DROP COLUMN "fotoUrl",
DROP COLUMN "fotoUrlSalida",
ADD COLUMN     "below_previous_reading" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "client_clock_skew_ms" INTEGER,
ADD COLUMN     "close_client_id" TEXT,
ADD COLUMN     "closed_at" TIMESTAMP(3),
ADD COLUMN     "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "fuel_liters" DOUBLE PRECISION,
ADD COLUMN     "observaciones" TEXT,
ADD COLUMN     "operator_id" TEXT,
ADD COLUMN     "pump_photo_key" TEXT,
ADD COLUMN     "shift_id" TEXT,
ADD COLUMN     "supervisor_id" TEXT;

-- CreateTable
CREATE TABLE "shift" (
    "id" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "type" TEXT NOT NULL,
    "supervisor_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "shift_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "shift_exit_report" (
    "id" TEXT NOT NULL,
    "shift_id" TEXT NOT NULL,
    "file_key" TEXT NOT NULL,
    "file_name" TEXT NOT NULL,
    "card_count" INTEGER NOT NULL,
    "requested_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by_id" TEXT NOT NULL,
    "email_status" TEXT NOT NULL DEFAULT 'PENDING',
    "notified_at" TIMESTAMP(3),

    CONSTRAINT "shift_exit_report_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "operator" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "rut" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "operator_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "shift_supervisor_id_date_type_key" ON "shift"("supervisor_id", "date", "type");

-- CreateIndex
CREATE INDEX "shift_exit_report_shift_id_idx" ON "shift_exit_report"("shift_id");

-- CreateIndex
CREATE UNIQUE INDEX "operator_rut_key" ON "operator"("rut");

-- CreateIndex
CREATE UNIQUE INDEX "RegistroCombustible_registro_horometro_id_key" ON "RegistroCombustible"("registro_horometro_id");

-- CreateIndex
CREATE UNIQUE INDEX "RegistroHorometro_close_client_id_key" ON "RegistroHorometro"("close_client_id");

-- CreateIndex
CREATE INDEX "RegistroHorometro_shift_id_idx" ON "RegistroHorometro"("shift_id");

-- CreateIndex
CREATE INDEX "RegistroHorometro_supervisor_id_idx" ON "RegistroHorometro"("supervisor_id");

-- AddForeignKey
ALTER TABLE "RegistroCombustible" ADD CONSTRAINT "RegistroCombustible_registro_horometro_id_fkey" FOREIGN KEY ("registro_horometro_id") REFERENCES "RegistroHorometro"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RegistroHorometro" ADD CONSTRAINT "RegistroHorometro_shift_id_fkey" FOREIGN KEY ("shift_id") REFERENCES "shift"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RegistroHorometro" ADD CONSTRAINT "RegistroHorometro_operator_id_fkey" FOREIGN KEY ("operator_id") REFERENCES "operator"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shift_exit_report" ADD CONSTRAINT "shift_exit_report_shift_id_fkey" FOREIGN KEY ("shift_id") REFERENCES "shift"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
