-- Módulo 4: configuración de mantención y avisos de los vehículos livianos.

-- CreateTable
CREATE TABLE "light_vehicle_config" (
    "equipment_id" TEXT NOT NULL,
    "service_alert_km" INTEGER NOT NULL DEFAULT 1000,
    "technical_inspection_alert_days" INTEGER NOT NULL DEFAULT 30,
    "circulation_permit_alert_days" INTEGER NOT NULL DEFAULT 30,
    "insurance_alert_days" INTEGER NOT NULL DEFAULT 30,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "updated_by_id" TEXT,

    CONSTRAINT "light_vehicle_config_pkey" PRIMARY KEY ("equipment_id")
);
