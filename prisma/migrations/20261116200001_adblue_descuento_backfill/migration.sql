-- Pedido del cliente (16-11): el AdBlue declarado por los supervisores (al
-- cerrar tarjetas de turno) y el de las cargas manuales nunca descontó el
-- ítem AdBlue de Inventario — el saldo del dashboard se quedaba quieto. El
-- código nuevo descuenta cada carga al registrarse; esta migración regulariza
-- lo YA declarado con UN asiento agregado de salida (`ADBLUE_LOAD`).
--
-- Solo se descuenta lo declarado DESPUÉS del primer movimiento del ítem: el
-- saldo con que el ítem entró a Inventario se contó físicamente en ese
-- momento, así que lo consumido antes ya está reflejado ahí — restarlo de
-- nuevo lo descontaría dos veces.
--
-- Defensiva a propósito: sin ítem AdBlue, sin fila de saldo, sin cargas
-- posteriores o sin forma de convertir litros a la unidad del ítem, no hace
-- nada (el descuento vivo tampoco lo haría).
DO $$
DECLARE
  v_item RECORD;
  v_stock RECORD;
  v_baseline timestamp;
  v_litros double precision;
  v_unidades double precision;
  v_balance double precision;
BEGIN
  -- Mismo par de agujas que el dashboard (`adBlueStock`): primero «adblue»,
  -- si no hay, «ad blue»; en empate, por nombre ascendente.
  SELECT id, content_per_unit, content_unit, unit INTO v_item
  FROM inventory_item
  WHERE is_active AND lower(name) LIKE '%adblue%'
  ORDER BY name ASC
  LIMIT 1;
  IF v_item.id IS NULL THEN
    SELECT id, content_per_unit, content_unit, unit INTO v_item
    FROM inventory_item
    WHERE is_active AND lower(name) LIKE '%ad blue%'
    ORDER BY name ASC
    LIMIT 1;
  END IF;
  IF v_item.id IS NULL THEN RETURN; END IF;

  -- La bodega con más existencia del ítem (misma regla que el descuento vivo).
  SELECT id, branch_id, quantity INTO v_stock
  FROM stock
  WHERE item_id = v_item.id
  ORDER BY quantity DESC, branch_id ASC
  LIMIT 1;
  IF v_stock.id IS NULL THEN RETURN; END IF;

  SELECT COALESCE(MIN(occurred_at), 'epoch'::timestamp) INTO v_baseline
  FROM stock_movement
  WHERE item_id = v_item.id;

  -- AdBlue declarado después de la línea base: tarjetas cerradas con AdBlue
  -- (las abiertas aún no lo declaran) + cargas manuales del panel (las
  -- vinculadas a tarjeta no llevan AdBlue propio: su fuente es la tarjeta).
  SELECT COALESCE(SUM(l), 0) INTO v_litros FROM (
    SELECT rh.ad_blue_liters AS l
    FROM "RegistroHorometro" rh
    WHERE rh.ad_blue
      AND rh.ad_blue_liters > 0
      AND rh."valorFinal" IS NOT NULL
      AND COALESCE(rh.closed_at, rh."fechaSalida") > v_baseline
    UNION ALL
    SELECT rc.ad_blue_litros
    FROM "RegistroCombustible" rc
    WHERE rc.registro_horometro_id IS NULL
      AND rc.ad_blue_litros > 0
      AND COALESCE(rc.created_at, rc.fecha) > v_baseline
  ) cargas;
  IF v_litros <= 0 THEN RETURN; END IF;

  -- Litros → unidad del ítem: bidón de N litros, o 1:1 si se cuenta en litros.
  IF v_item.content_per_unit IS NOT NULL
     AND COALESCE(v_item.content_unit, 'LITER') = 'LITER' THEN
    v_unidades := v_litros / v_item.content_per_unit;
  ELSIF v_item.unit = 'LITER' THEN
    v_unidades := v_litros;
  ELSE
    RETURN;
  END IF;

  -- Puede dejar el saldo negativo: el AdBlue ya está en los camiones, y el
  -- número en rojo es justo lo que le dice al administrador que recuente.
  UPDATE stock SET quantity = quantity - v_unidades
  WHERE id = v_stock.id
  RETURNING quantity INTO v_balance;

  INSERT INTO stock_movement
    (id, item_id, branch_id, direction, reason, quantity, resulting_balance,
     reference, notes, occurred_at)
  VALUES (
    'adblue_backfill_' || substr(md5(random()::text || clock_timestamp()::text), 1, 20),
    v_item.id,
    v_stock.branch_id,
    'OUT',
    'ADBLUE_LOAD',
    v_unidades,
    v_balance,
    'adblue-backfill',
    'Regularización: ' || to_char(v_litros, 'FM999999990.##')
      || ' L de AdBlue ya declarados en tarjetas de turno y cargas manuales, '
      || 'descontados al conectar las cargas con Inventario.',
    now()
  );
END $$;
