-- Varias fotos al cerrar una intervención (hasta 10): tabla hija con la key
-- de cada foto y su posición. "intervencion"."fotoKey" se mantiene y se sigue
-- escribiendo con la primera foto (compatibilidad con un backend anterior).

-- CreateTable
CREATE TABLE "intervencion_foto" (
    "id" TEXT NOT NULL,
    "intervencionId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "orden" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "intervencion_foto_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "intervencion_foto_intervencionId_idx" ON "intervencion_foto"("intervencionId");

-- AddForeignKey
ALTER TABLE "intervencion_foto" ADD CONSTRAINT "intervencion_foto_intervencionId_fkey" FOREIGN KEY ("intervencionId") REFERENCES "intervencion"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Las intervenciones que ya tenían su única foto la conservan como la
-- primera (orden 0) de la tabla nueva. Una por intervención: el id derivado
-- del de la intervención es único.
INSERT INTO "intervencion_foto" ("id", "intervencionId", "key", "orden", "createdAt")
SELECT 'ifoto_' || "id", "id", "fotoKey", 0, "fecha"
FROM "intervencion"
WHERE "fotoKey" IS NOT NULL;
