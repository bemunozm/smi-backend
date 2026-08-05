-- CreateTable
CREATE TABLE "Equipo" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "codigo" TEXT NOT NULL,
    "tipo" TEXT NOT NULL,
    "marca" TEXT NOT NULL,
    "modelo" TEXT NOT NULL,
    "estado" TEXT NOT NULL DEFAULT 'OPERATIVO',
    "horometroActual" REAL NOT NULL DEFAULT 0,
    "kilometrajeActual" REAL NOT NULL DEFAULT 0
);

-- CreateTable
CREATE TABLE "RegistroCombustible" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "equipoId" TEXT NOT NULL,
    "litros" REAL NOT NULL,
    "fotoUrl" TEXT,
    "rendimiento" REAL,
    "fecha" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "RegistroCombustible_equipoId_fkey" FOREIGN KEY ("equipoId") REFERENCES "Equipo" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "RegistroHorometro" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "equipoId" TEXT NOT NULL,
    "operadorId" TEXT NOT NULL,
    "turno" TEXT NOT NULL,
    "valorInicial" REAL NOT NULL,
    "valorFinal" REAL,
    "fecha" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "RegistroHorometro_equipoId_fkey" FOREIGN KEY ("equipoId") REFERENCES "Equipo" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "TrabajoExtraordinario" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "equipoId" TEXT NOT NULL,
    "cliente" TEXT NOT NULL,
    "horasMaquina" REAL NOT NULL,
    "tonelaje" REAL,
    "tarifa" REAL NOT NULL,
    "monto" REAL NOT NULL,
    "fotoUrl" TEXT,
    "fecha" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "TrabajoExtraordinario_equipoId_fkey" FOREIGN KEY ("equipoId") REFERENCES "Equipo" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Hallazgo" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "equipoId" TEXT NOT NULL,
    "descripcion" TEXT NOT NULL,
    "criticidad" TEXT NOT NULL,
    "estado" TEXT NOT NULL DEFAULT 'ABIERTO',
    "fotoUrl" TEXT,
    "fecha" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Hallazgo_equipoId_fkey" FOREIGN KEY ("equipoId") REFERENCES "Equipo" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "Equipo_codigo_key" ON "Equipo"("codigo");
