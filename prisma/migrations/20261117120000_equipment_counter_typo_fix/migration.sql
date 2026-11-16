-- Pedido del cliente (16-11): el SEM05 mostraba un horómetro de 4.606 h con
-- lecturas recientes de ~2.628 h. El contador del equipo solo sube, así que
-- una lectura mal tipeada lo dejaba inflado para siempre, aunque después se
-- corrigiera o se borrara el registro. El código ya no deja que pase de
-- nuevo (tope de salto + el contador vuelve atrás al corregir); esto
-- regulariza los equipos que YA quedaron inflados.
--
-- Referencia de cada equipo = la MEDIANA de sus últimas 5 lecturas (tarjetas
-- de turno / horómetro de Flota, inicial y final, y cargas de combustible con
-- lectura). La mediana no se deja arrastrar por un solo typo, esté donde esté
-- (el registro con 4.606 puede seguir existiendo). Si el contador supera esa
-- referencia por más del salto posible (1.000 h / 20.000 km, mismo tope que
-- `SALTO_MAXIMO`), vuelve a la lectura más alta que esté dentro de ese rango.
-- Los registros no se tocan: el que tenga el typo se corrige a mano y, desde
-- ahora, corregirlo no vuelve a mover el contador hacia arriba.
--
-- Equipos sin lecturas o con contador coherente no entran en el WHERE.
WITH lecturas AS (
  SELECT equipo_id, "valorInicial" AS valor, fecha AS en
  FROM "RegistroHorometro"
  UNION ALL
  SELECT equipo_id, "valorFinal", COALESCE("fechaSalida", closed_at, fecha)
  FROM "RegistroHorometro"
  WHERE "valorFinal" IS NOT NULL
  UNION ALL
  SELECT equipo_id, lectura, fecha
  FROM "RegistroCombustible"
  WHERE lectura IS NOT NULL
),
recientes AS (
  SELECT equipo_id, valor,
         ROW_NUMBER() OVER (PARTITION BY equipo_id ORDER BY en DESC) AS n
  FROM lecturas
),
referencia AS (
  SELECT r.equipo_id,
         percentile_cont(0.5) WITHIN GROUP (ORDER BY r.valor) AS ref,
         CASE WHEN e.control_unit = 'HOURS' THEN 1000 ELSE 20000 END AS salto
  FROM recientes r
  JOIN equipment e ON e.id = r.equipo_id
  WHERE r.n <= 5
  GROUP BY r.equipo_id, e.control_unit
),
corregido AS (
  SELECT ref.equipo_id, MAX(l.valor) AS nuevo, ref.ref, ref.salto
  FROM referencia ref
  JOIN lecturas l ON l.equipo_id = ref.equipo_id
  WHERE l.valor <= ref.ref + ref.salto
  GROUP BY ref.equipo_id, ref.ref, ref.salto
)
UPDATE equipment e
SET current_hourmeter = CASE WHEN e.control_unit = 'HOURS' THEN c.nuevo ELSE e.current_hourmeter END,
    current_mileage   = CASE WHEN e.control_unit = 'KM'    THEN c.nuevo ELSE e.current_mileage   END
FROM corregido c
WHERE e.id = c.equipo_id
  AND (
    (e.control_unit = 'HOURS' AND e.current_hourmeter > c.ref + c.salto)
    OR (e.control_unit = 'KM' AND e.current_mileage > c.ref + c.salto)
  );
