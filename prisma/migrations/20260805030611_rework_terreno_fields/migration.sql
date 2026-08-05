/*
  Warnings:

  - You are about to drop the column `criticidad` on the `Hallazgo` table. All the data in the column will be lost.
  - You are about to drop the column `rendimiento` on the `RegistroCombustible` table. All the data in the column will be lost.
  - You are about to drop the column `operadorId` on the `RegistroHorometro` table. All the data in the column will be lost.
  - You are about to drop the column `cliente` on the `TrabajoExtraordinario` table. All the data in the column will be lost.
  - You are about to drop the column `fotoUrl` on the `TrabajoExtraordinario` table. All the data in the column will be lost.
  - You are about to drop the column `horasMaquina` on the `TrabajoExtraordinario` table. All the data in the column will be lost.
  - You are about to drop the column `monto` on the `TrabajoExtraordinario` table. All the data in the column will be lost.
  - You are about to drop the column `tarifa` on the `TrabajoExtraordinario` table. All the data in the column will be lost.
  - You are about to drop the column `tonelaje` on the `TrabajoExtraordinario` table. All the data in the column will be lost.
  - Added the required column `prioridad` to the `Hallazgo` table without a default value. This is not possible if the table is not empty.
  - Added the required column `tipo` to the `RegistroCombustible` table without a default value. This is not possible if the table is not empty.
  - Added the required column `operador` to the `RegistroHorometro` table without a default value. This is not possible if the table is not empty.
  - Added the required column `actividad` to the `TrabajoExtraordinario` table without a default value. This is not possible if the table is not empty.
  - Added the required column `descripcion` to the `TrabajoExtraordinario` table without a default value. This is not possible if the table is not empty.
  - Added the required column `faena` to the `TrabajoExtraordinario` table without a default value. This is not possible if the table is not empty.
  - Added the required column `horometroFinal` to the `TrabajoExtraordinario` table without a default value. This is not possible if the table is not empty.
  - Added the required column `horometroInicial` to the `TrabajoExtraordinario` table without a default value. This is not possible if the table is not empty.
  - Added the required column `operador` to the `TrabajoExtraordinario` table without a default value. This is not possible if the table is not empty.
  - Added the required column `totalHoras` to the `TrabajoExtraordinario` table without a default value. This is not possible if the table is not empty.
  - Added the required column `turno` to the `TrabajoExtraordinario` table without a default value. This is not possible if the table is not empty.

*/
-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Hallazgo" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "equipoId" TEXT NOT NULL,
    "descripcion" TEXT NOT NULL,
    "prioridad" TEXT NOT NULL,
    "estado" TEXT NOT NULL DEFAULT 'ABIERTO',
    "fotoUrl" TEXT,
    "fecha" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Hallazgo_equipoId_fkey" FOREIGN KEY ("equipoId") REFERENCES "Equipo" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
INSERT INTO "new_Hallazgo" ("descripcion", "equipoId", "estado", "fecha", "fotoUrl", "id") SELECT "descripcion", "equipoId", "estado", "fecha", "fotoUrl", "id" FROM "Hallazgo";
DROP TABLE "Hallazgo";
ALTER TABLE "new_Hallazgo" RENAME TO "Hallazgo";
CREATE TABLE "new_RegistroCombustible" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "equipoId" TEXT NOT NULL,
    "litros" REAL NOT NULL,
    "tipo" TEXT NOT NULL,
    "fotoUrl" TEXT,
    "fecha" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "RegistroCombustible_equipoId_fkey" FOREIGN KEY ("equipoId") REFERENCES "Equipo" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
INSERT INTO "new_RegistroCombustible" ("equipoId", "fecha", "fotoUrl", "id", "litros") SELECT "equipoId", "fecha", "fotoUrl", "id", "litros" FROM "RegistroCombustible";
DROP TABLE "RegistroCombustible";
ALTER TABLE "new_RegistroCombustible" RENAME TO "RegistroCombustible";
CREATE TABLE "new_RegistroHorometro" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "equipoId" TEXT NOT NULL,
    "operador" TEXT NOT NULL,
    "turno" TEXT NOT NULL,
    "valorInicial" REAL NOT NULL,
    "valorFinal" REAL,
    "nivelCombustible" REAL,
    "fecha" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "RegistroHorometro_equipoId_fkey" FOREIGN KEY ("equipoId") REFERENCES "Equipo" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
INSERT INTO "new_RegistroHorometro" ("equipoId", "fecha", "id", "turno", "valorFinal", "valorInicial") SELECT "equipoId", "fecha", "id", "turno", "valorFinal", "valorInicial" FROM "RegistroHorometro";
DROP TABLE "RegistroHorometro";
ALTER TABLE "new_RegistroHorometro" RENAME TO "RegistroHorometro";
CREATE TABLE "new_TrabajoExtraordinario" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "equipoId" TEXT NOT NULL,
    "operador" TEXT NOT NULL,
    "faena" TEXT NOT NULL,
    "turno" TEXT NOT NULL,
    "horometroInicial" REAL NOT NULL,
    "horometroFinal" REAL NOT NULL,
    "totalHoras" REAL NOT NULL,
    "actividad" TEXT NOT NULL,
    "descripcion" TEXT NOT NULL,
    "observaciones" TEXT,
    "fecha" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "TrabajoExtraordinario_equipoId_fkey" FOREIGN KEY ("equipoId") REFERENCES "Equipo" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
INSERT INTO "new_TrabajoExtraordinario" ("equipoId", "fecha", "id") SELECT "equipoId", "fecha", "id" FROM "TrabajoExtraordinario";
DROP TABLE "TrabajoExtraordinario";
ALTER TABLE "new_TrabajoExtraordinario" RENAME TO "TrabajoExtraordinario";
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
