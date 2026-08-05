-- CreateTable
CREATE TABLE "Equipo" (
    "id" TEXT NOT NULL,
    "codigo" TEXT NOT NULL,
    "tipo" TEXT NOT NULL,
    "marca" TEXT NOT NULL,
    "modelo" TEXT NOT NULL,
    "estado" TEXT NOT NULL DEFAULT 'OPERATIVO',
    "horometroActual" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "kilometrajeActual" DOUBLE PRECISION NOT NULL DEFAULT 0,

    CONSTRAINT "Equipo_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RegistroCombustible" (
    "id" TEXT NOT NULL,
    "equipoId" TEXT NOT NULL,
    "litros" DOUBLE PRECISION NOT NULL,
    "tipo" TEXT NOT NULL,
    "fotoUrl" TEXT,
    "fecha" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RegistroCombustible_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RegistroHorometro" (
    "id" TEXT NOT NULL,
    "equipoId" TEXT NOT NULL,
    "operador" TEXT NOT NULL,
    "turno" TEXT NOT NULL,
    "valorInicial" DOUBLE PRECISION NOT NULL,
    "valorFinal" DOUBLE PRECISION,
    "nivelCombustible" DOUBLE PRECISION,
    "fecha" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RegistroHorometro_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TrabajoExtraordinario" (
    "id" TEXT NOT NULL,
    "equipoId" TEXT NOT NULL,
    "operador" TEXT NOT NULL,
    "faena" TEXT NOT NULL,
    "turno" TEXT NOT NULL,
    "horometroInicial" DOUBLE PRECISION NOT NULL,
    "horometroFinal" DOUBLE PRECISION NOT NULL,
    "totalHoras" DOUBLE PRECISION NOT NULL,
    "actividad" TEXT NOT NULL,
    "descripcion" TEXT NOT NULL,
    "observaciones" TEXT,
    "fecha" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TrabajoExtraordinario_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Hallazgo" (
    "id" TEXT NOT NULL,
    "equipoId" TEXT NOT NULL,
    "descripcion" TEXT NOT NULL,
    "prioridad" TEXT NOT NULL,
    "estado" TEXT NOT NULL DEFAULT 'ABIERTO',
    "fotoUrl" TEXT,
    "fecha" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Hallazgo_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Equipo_codigo_key" ON "Equipo"("codigo");

-- AddForeignKey
ALTER TABLE "RegistroCombustible" ADD CONSTRAINT "RegistroCombustible_equipoId_fkey" FOREIGN KEY ("equipoId") REFERENCES "Equipo"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RegistroHorometro" ADD CONSTRAINT "RegistroHorometro_equipoId_fkey" FOREIGN KEY ("equipoId") REFERENCES "Equipo"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TrabajoExtraordinario" ADD CONSTRAINT "TrabajoExtraordinario_equipoId_fkey" FOREIGN KEY ("equipoId") REFERENCES "Equipo"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Hallazgo" ADD CONSTRAINT "Hallazgo_equipoId_fkey" FOREIGN KEY ("equipoId") REFERENCES "Equipo"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
