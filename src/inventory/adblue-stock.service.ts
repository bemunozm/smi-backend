import { Injectable, Logger } from '@nestjs/common';
import { MovementReason } from '@prisma/client';

import { formatNumber } from '../common/format/number';
import {
  StockService,
  type PendingStockEvents,
  type PrismaClientLike,
  type StockTransaction,
} from './stock.service';

/** Carga de AdBlue a descontar del ítem AdBlue (o a devolverle). */
export interface AdBlueLoadInput {
  /** Litros declarados. Con ≤ 0 no se hace nada. */
  liters: number;
  /** Equipo al que se cargó — queda imputado en el asiento del kardex. */
  equipmentId?: string | null;
  /** `user.id` de quien registró la carga. */
  performedById?: string | null;
  /** Id de la tarjeta o de la carga manual que originó el asiento. */
  reference: string;
  notes?: string | null;
}

interface AdBlueTarget {
  itemId: string;
  itemName: string;
  branchId: string;
  /** Litros → unidad del ítem (bidones o litros). */
  toUnits: (liters: number) => number;
}

/** Evita colas binarias (45/10 → 4.500000000000001) sin perder medios bidones. */
const round4 = (n: number) => Number(n.toFixed(4));

/**
 * Conecta el AdBlue declarado en terreno (cierre de tarjeta de turno, carga
 * manual del panel) con el ítem AdBlue de Inventario: cada carga descuenta el
 * saldo y deja su asiento `ADBLUE_LOAD` en el kardex, y una corrección o un
 * borrado devuelven la diferencia (`RETURN`). Pedido del cliente (16-11): el
 * saldo del dashboard tiene que ir bajando con lo que los supervisores cargan.
 *
 * El descuento nunca bloquea el flujo de terreno: sin ítem AdBlue en el
 * catálogo, sin bodega con fila de saldo o sin forma de convertir litros a la
 * unidad del ítem, no se descuenta nada (queda en el log). Con saldo
 * insuficiente SÍ se descuenta y la bodega queda en negativo
 * (`allowNegative`): el AdBlue ya está en el camión, y el número en rojo es
 * lo que manda al administrador a recontar.
 */
@Injectable()
export class AdBlueStockService {
  private readonly logger = new Logger(AdBlueStockService.name);

  constructor(private readonly stock: StockService) {}

  /**
   * Descuenta una carga dentro de la transacción del dominio que la registra.
   * El dedupe es del llamador: se invoca solo cuando la carga NACE (o por la
   * diferencia, al corregirla).
   */
  async discountLoad(
    within: StockTransaction,
    input: AdBlueLoadInput,
  ): Promise<void> {
    if (input.liters <= 0) return;
    const target = await this.resolve(within.tx);
    if (!target) return;
    const quantity = round4(target.toUnits(input.liters));
    if (quantity <= 0) return;
    await this.stock.issue(
      {
        itemId: target.itemId,
        branchId: target.branchId,
        quantity,
        reason: MovementReason.ADBLUE_LOAD,
        performedById: input.performedById ?? null,
        equipmentId: input.equipmentId ?? null,
        reference: input.reference,
        notes:
          input.notes ?? `Carga de AdBlue: ${formatNumber(input.liters)} L`,
        allowNegative: true,
      },
      within,
    );
  }

  /**
   * Devuelve al saldo una carga corregida hacia abajo o eliminada. `RETURN` y
   * no un borrado del asiento original: el kardex es bitácora, se corrige con
   * un asiento nuevo que se explica solo.
   */
  async restoreLoad(
    within: StockTransaction,
    input: AdBlueLoadInput,
  ): Promise<void> {
    if (input.liters <= 0) return;
    const target = await this.resolve(within.tx);
    if (!target) return;
    const quantity = round4(target.toUnits(input.liters));
    if (quantity <= 0) return;
    await this.stock.receive(
      {
        itemId: target.itemId,
        branchId: target.branchId,
        quantity,
        reason: MovementReason.RETURN,
        performedById: input.performedById ?? null,
        equipmentId: input.equipmentId ?? null,
        reference: input.reference,
        notes:
          input.notes ??
          `Devolución por corrección de carga de AdBlue: ${formatNumber(input.liters)} L`,
      },
      within,
    );
  }

  /** Avisos de stock bajo acumulados en la transacción — emitir TRAS confirmar. */
  emitPending(events: PendingStockEvents): void {
    this.stock.emitPending(events);
  }

  /**
   * Ítem AdBlue + bodega + conversión, o `null` si falta cualquiera. Misma
   * heurística de nombre que `DashboardService.adBlueStock` (primero
   * «adblue», después «ad blue»); la bodega es la fila de saldo con más
   * existencia — las cargas de terreno no dicen bodega, y la que más tiene es
   * la que de verdad surte a la faena.
   */
  private async resolve(
    client: PrismaClientLike,
  ): Promise<AdBlueTarget | null> {
    for (const needle of ['adblue', 'ad blue']) {
      const item = await client.inventoryItem.findFirst({
        where: {
          isActive: true,
          name: { contains: needle, mode: 'insensitive' },
        },
        orderBy: { name: 'asc' },
        select: {
          id: true,
          name: true,
          unit: true,
          contentPerUnit: true,
          contentUnit: true,
          stocks: {
            select: { branchId: true, quantity: true },
            orderBy: [{ quantity: 'desc' }, { branchId: 'asc' }],
            take: 1,
          },
        },
      });
      if (!item) continue;

      const branchId = item.stocks[0]?.branchId;
      if (!branchId) {
        this.logger.warn(
          `El ítem AdBlue "${item.name}" no tiene saldo en ninguna bodega: la carga no se descuenta.`,
        );
        return null;
      }

      // Bidón de N litros, o ítem contado directamente en litros.
      const enBidones =
        item.contentPerUnit != null &&
        (item.contentUnit ?? 'LITER') === 'LITER';
      if (enBidones) {
        const porUnidad = item.contentPerUnit as number;
        return {
          itemId: item.id,
          itemName: item.name,
          branchId,
          toUnits: (liters) => liters / porUnidad,
        };
      }
      if (item.unit === 'LITER') {
        return {
          itemId: item.id,
          itemName: item.name,
          branchId,
          toUnits: (liters) => liters,
        };
      }
      this.logger.warn(
        `El ítem AdBlue "${item.name}" se cuenta en ${item.unit} sin contenido por unidad: no hay cómo convertir litros y la carga no se descuenta.`,
      );
      return null;
    }
    return null;
  }
}
