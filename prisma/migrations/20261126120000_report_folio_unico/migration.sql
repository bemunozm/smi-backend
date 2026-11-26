-- El N° de report (folio del papel) pasa a ser EL número del Report y es
-- único. Se guarda normalizado: sin espacios ni ceros a la izquierda
-- ("04615" -> "4615"), igual que lo guarda el servicio desde ahora.
UPDATE "TrabajoExtraordinario"
SET "report_numero" = COALESCE(NULLIF(ltrim(btrim("report_numero"), '0'), ''), '0')
WHERE "report_numero" ~ '^\s*[0-9]+\s*$'
  AND "report_numero" <> COALESCE(NULLIF(ltrim(btrim("report_numero"), '0'), ''), '0');

-- Un folio vacío no es un folio (legacy): NULL no choca con el índice único.
UPDATE "TrabajoExtraordinario" SET "report_numero" = NULL WHERE btrim("report_numero") = '';

-- Falla a propósito si quedan folios repetidos: se borran antes del deploy
-- (tools/prod-fixes/2026-11-26-report-folio-y-informes-a-antes-del-deploy.sql).
-- CreateIndex
CREATE UNIQUE INDEX "TrabajoExtraordinario_report_numero_key" ON "TrabajoExtraordinario"("report_numero");
