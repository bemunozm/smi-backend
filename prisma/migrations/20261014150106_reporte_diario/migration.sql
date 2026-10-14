-- CreateTable
CREATE TABLE "planta" (
    "id" TEXT NOT NULL,
    "nombre" TEXT NOT NULL,
    "orden" INTEGER NOT NULL,
    "activa" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "planta_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "empresa_externa" (
    "id" TEXT NOT NULL,
    "nombre" TEXT NOT NULL,
    "activa" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "empresa_externa_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reporte_diario" (
    "id" TEXT NOT NULL,
    "fecha" DATE NOT NULL,
    "turno" TEXT NOT NULL,
    "supervisor_id" TEXT NOT NULL,
    "supervisor_nombre" TEXT NOT NULL,
    "observaciones" TEXT,
    "created_by_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "reporte_diario_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "produccion_turno" (
    "id" TEXT NOT NULL,
    "reporte_id" TEXT NOT NULL,
    "seccion" TEXT NOT NULL,
    "camiones" INTEGER NOT NULL,
    "vueltas_por_camion" INTEGER NOT NULL,

    CONSTRAINT "produccion_turno_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reporte_tolva" (
    "id" TEXT NOT NULL,
    "reporte_id" TEXT NOT NULL,
    "tolva" INTEGER NOT NULL,
    "cargas" INTEGER NOT NULL,

    CONSTRAINT "reporte_tolva_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reporte_planta" (
    "id" TEXT NOT NULL,
    "reporte_id" TEXT NOT NULL,
    "planta_id" TEXT NOT NULL,
    "producto" TEXT NOT NULL,

    CONSTRAINT "reporte_planta_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reporte_traspaso" (
    "id" TEXT NOT NULL,
    "reporte_id" TEXT NOT NULL,
    "tipo" TEXT NOT NULL,
    "cantidad" INTEGER NOT NULL,

    CONSTRAINT "reporte_traspaso_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reporte_empresa" (
    "id" TEXT NOT NULL,
    "reporte_id" TEXT NOT NULL,
    "empresa_id" TEXT NOT NULL,

    CONSTRAINT "reporte_empresa_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reporte_diario_personal" (
    "id" TEXT NOT NULL,
    "reporte_id" TEXT NOT NULL,
    "rol" TEXT NOT NULL,
    "nombre" TEXT NOT NULL,
    "orden" INTEGER NOT NULL,

    CONSTRAINT "reporte_diario_personal_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "planta_nombre_key" ON "planta"("nombre");

-- CreateIndex
CREATE UNIQUE INDEX "empresa_externa_nombre_key" ON "empresa_externa"("nombre");

-- CreateIndex
CREATE UNIQUE INDEX "reporte_diario_fecha_turno_key" ON "reporte_diario"("fecha", "turno");

-- CreateIndex
CREATE UNIQUE INDEX "produccion_turno_reporte_id_seccion_key" ON "produccion_turno"("reporte_id", "seccion");

-- CreateIndex
CREATE UNIQUE INDEX "reporte_tolva_reporte_id_tolva_key" ON "reporte_tolva"("reporte_id", "tolva");

-- CreateIndex
CREATE UNIQUE INDEX "reporte_planta_reporte_id_planta_id_key" ON "reporte_planta"("reporte_id", "planta_id");

-- CreateIndex
CREATE UNIQUE INDEX "reporte_traspaso_reporte_id_tipo_key" ON "reporte_traspaso"("reporte_id", "tipo");

-- CreateIndex
CREATE UNIQUE INDEX "reporte_empresa_reporte_id_empresa_id_key" ON "reporte_empresa"("reporte_id", "empresa_id");

-- AddForeignKey
ALTER TABLE "produccion_turno" ADD CONSTRAINT "produccion_turno_reporte_id_fkey" FOREIGN KEY ("reporte_id") REFERENCES "reporte_diario"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reporte_tolva" ADD CONSTRAINT "reporte_tolva_reporte_id_fkey" FOREIGN KEY ("reporte_id") REFERENCES "reporte_diario"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reporte_planta" ADD CONSTRAINT "reporte_planta_reporte_id_fkey" FOREIGN KEY ("reporte_id") REFERENCES "reporte_diario"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reporte_planta" ADD CONSTRAINT "reporte_planta_planta_id_fkey" FOREIGN KEY ("planta_id") REFERENCES "planta"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reporte_traspaso" ADD CONSTRAINT "reporte_traspaso_reporte_id_fkey" FOREIGN KEY ("reporte_id") REFERENCES "reporte_diario"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reporte_empresa" ADD CONSTRAINT "reporte_empresa_reporte_id_fkey" FOREIGN KEY ("reporte_id") REFERENCES "reporte_diario"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reporte_empresa" ADD CONSTRAINT "reporte_empresa_empresa_id_fkey" FOREIGN KEY ("empresa_id") REFERENCES "empresa_externa"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reporte_diario_personal" ADD CONSTRAINT "reporte_diario_personal_reporte_id_fkey" FOREIGN KEY ("reporte_id") REFERENCES "reporte_diario"("id") ON DELETE CASCADE ON UPDATE CASCADE;
