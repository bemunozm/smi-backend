-- CreateEnum
CREATE TYPE "ChecklistStatus" AS ENUM ('SUBMITTED', 'ACCEPTED', 'REJECTED');

-- CreateEnum
CREATE TYPE "ChecklistEntryStatus" AS ENUM ('MAINTAINED', 'CHECKED', 'NOT_CHECKED');

-- CreateTable
CREATE TABLE "checklist_item" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "requires_photo" BOOLEAN NOT NULL DEFAULT false,
    "requires_temperature" BOOLEAN NOT NULL DEFAULT false,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "checklist_item_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "daily_checklist" (
    "id" TEXT NOT NULL,
    "equipment_id" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "counter" DOUBLE PRECISION NOT NULL,
    "status" "ChecklistStatus" NOT NULL DEFAULT 'SUBMITTED',
    "mechanic_id" TEXT NOT NULL,
    "mechanic_name" TEXT NOT NULL,
    "submitted_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "branch_id" TEXT,
    "created_by_id" TEXT,

    CONSTRAINT "daily_checklist_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "daily_checklist_entry" (
    "id" TEXT NOT NULL,
    "checklist_id" TEXT NOT NULL,
    "item_id" TEXT,
    "item_name" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "status" "ChecklistEntryStatus" NOT NULL,
    "description" TEXT,
    "note" TEXT,
    "temperature" DOUBLE PRECISION,
    "photo_keys" TEXT[],
    "supplies" JSONB,

    CONSTRAINT "daily_checklist_entry_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "daily_checklist_status_idx" ON "daily_checklist"("status");

-- CreateIndex
CREATE INDEX "daily_checklist_date_idx" ON "daily_checklist"("date");

-- CreateIndex
CREATE UNIQUE INDEX "daily_checklist_equipment_id_date_key" ON "daily_checklist"("equipment_id", "date");

-- CreateIndex
CREATE INDEX "daily_checklist_entry_checklist_id_idx" ON "daily_checklist_entry"("checklist_id");

-- AddForeignKey
ALTER TABLE "daily_checklist_entry" ADD CONSTRAINT "daily_checklist_entry_checklist_id_fkey" FOREIGN KEY ("checklist_id") REFERENCES "daily_checklist"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "daily_checklist_entry" ADD CONSTRAINT "daily_checklist_entry_item_id_fkey" FOREIGN KEY ("item_id") REFERENCES "checklist_item"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- Catálogo inicial: los ítems de la planilla del mantenedor (anexo del Acta
-- N.° 006), sin cambio de aceite ni filtros (son la pauta de mantención).
-- Los críticos (R24) exigen foto. Ajustado con Joaquín sobre la lista del
-- acta: el A/C sale de los críticos y no pide temperatura (en faena no
-- siempre hay con qué medirla; si el cliente la pide se vuelve a activar con
-- `requires_temperature`), la bocina tampoco lleva foto y las cuatro luces
-- (bajas, freno, retroceso, estacionamiento) sí. «Nivel de aceite» no está en
-- la planilla en papel, pero la especificación lo lista como crítico.
INSERT INTO "checklist_item" ("id", "name", "position", "requires_photo", "requires_temperature") VALUES
  ('chk_aire_acondicionado', 'Aire acondicionado', 1, false, false),
  ('chk_alarma_retroceso', 'Alarma de retroceso', 2, true, false),
  ('chk_asiento', 'Asiento', 3, false, false),
  ('chk_baterias', 'Baterías y bornes', 4, true, false),
  ('chk_bocinas', 'Bocinas', 5, false, false),
  ('chk_chapa_puerta', 'Chapa de puerta', 6, false, false),
  ('chk_engrase', 'Engrase', 7, false, false),
  ('chk_extintor', 'Extintor del equipo', 8, false, false),
  ('chk_focos_led', 'Focos LED (delanteros / traseros)', 9, true, false),
  ('chk_fugas', 'Fugas de aceite / refrigerante', 10, false, false),
  ('chk_joystick', 'Joystick', 11, false, false),
  ('chk_limpiaparabrisas', 'Limpiaparabrisas (plumillas / brazo)', 12, true, false),
  ('chk_luces_bajas', 'Luces bajas', 13, true, false),
  ('chk_luces_freno', 'Luces de freno', 14, true, false),
  ('chk_luces_retroceso', 'Luces de retroceso', 15, true, false),
  ('chk_luces_estacionamiento', 'Luces de estacionamiento', 16, true, false),
  ('chk_mangueras', 'Mangueras hidráulicas', 17, false, false),
  ('chk_neumaticos', 'Neumáticos', 18, false, false),
  ('chk_nivel_aceite', 'Nivel de aceite', 19, true, false),
  ('chk_pastillas_freno', 'Pastillas de frenos', 20, true, false),
  ('chk_radio_base', 'Radio base', 21, false, false);
