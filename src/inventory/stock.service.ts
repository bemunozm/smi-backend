import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import {
  MovementDirection,
  MovementReason,
  Prisma,
  StockMovement,
} from '@prisma/client';

import { assertExpected } from '../common/concurrency/expected-fields';
import { ERROR_CODES } from '../common/errors/error-codes';
import {
  createOrReturn,
  type ExistingRecord,
} from '../common/idempotency/create-or-return';
import { formatNumber } from '../common/format/number';
import { PrismaService } from '../common/prisma/prisma.service';
import { DOMAIN_EVENTS } from '../common/events/domain-events';
import type { ItemLowStockEvent } from '../common/events/domain-events';

/**
 * Cliente Prisma capaz de ejecutar la operación: o bien el servicio global, o
 * bien el `tx` de un `$transaction` abierto por otro dominio.
 */
export type PrismaClientLike = PrismaService | Prisma.TransactionClient;

/**
 * Avisos de existencia baja que una operación fue acumulando. Se emiten recién
 * cuando la transacción que los originó confirmó: un aviso de una transacción
 * que luego se revierte alerta de un saldo que nunca existió.
 */
export type PendingStockEvents = ItemLowStockEvent[];

/**
 * Transacción abierta por otro dominio, junto con el buzón de avisos que ese
 * dominio debe vaciar con `StockService.emitPending` DESPUÉS de confirmar.
 */
export interface StockTransaction {
  tx: Prisma.TransactionClient;
  events: PendingStockEvents;
}

export interface StockMovementInput {
  /** PK del asiento cuando el cliente la genera (reintento idempotente). */
  id?: string;
  itemId: string;
  /**
   * Bodega cuyo saldo se mueve. **Obligatorio**: con existencias por sucursal,
   * un movimiento sin bodega se imputaría a una elegida por el sistema y el
   * descuadre solo aparecería en el siguiente conteo físico.
   */
  branchId: string;
  /** Siempre > 0. El signo lo determina la operación que se invoca. */
  quantity: number;
  reason: MovementReason;
  /** `user.id` de Better Auth de quien ejecuta la operación. */
  performedById?: string | null;
  /** Unidad a la que se imputa el consumo, si aplica. */
  equipmentId?: string | null;
  /** Agrupa los dos asientos de un traspaso, o apunta al documento de origen. */
  reference?: string | null;
  /** Guía de despacho, orden de compra o factura que respalda el movimiento. */
  documentNumber?: string | null;
  notes?: string | null;
}

export interface TransferResult {
  reference: string;
  out: StockMovement;
  in: StockMovement;
  sourceBranchName: string;
  destinationBranchName: string;
}

export interface AdjustToCountInput {
  /** PK del asiento de ajuste cuando el cliente la genera. */
  id?: string;
  itemId: string;
  branchId: string;
  /** Cantidad real contada EN esa bodega. */
  countedQuantity: number;
  /**
   * Existencia que quien contó veía en el sistema. Si otro movimiento la
   * cambió mientras contaba, el ajuste se rechaza (`STALE_UPDATE`) en vez de
   * pisar ese movimiento con un conteo viejo.
   */
  expectedQuantity?: number;
  performedById?: string | null;
  notes?: string | null;
}

/**
 * API de existencias del dominio Inventario. **Es el único camino permitido
 * para mover `Stock.quantity`** — ningún otro dominio la escribe directamente.
 *
 * Cada operación hace dos cosas en la MISMA transacción: mueve el saldo de la
 * bodega y deja el `StockMovement` con el `resultingBalance`. Por eso el kardex
 * siempre cuadra con la existencia: no hay forma de mover uno sin el otro.
 *
 * A diferencia del modelo anterior, **no hay total denormalizado que mantener**
 * `Stock` es la única fuente del saldo y el consolidado se calcula
 * sumando sus filas.
 *
 * ## Uso desde otro dominio
 *
 * ```ts
 * const events: PendingStockEvents = [];
 * const intervention = await this.prisma.$transaction(async (tx) => {
 *   const intervention = await tx.intervencion.create({ data: { ... } });
 *
 *   for (const line of dto.items) {
 *     await this.stock.issue(
 *       {
 *         itemId: line.itemId,
 *         branchId: dto.branchId,
 *         quantity: line.quantity,
 *         reason: MovementReason.INTERVENTION,
 *         performedById: session.user.id,
 *         equipmentId: order.equipmentId,
 *         reference: intervention.id,
 *       },
 *       { tx, events }, // ← la bitácora y los descuentos son todo-o-nada
 *     );
 *   }
 *
 *   return intervention;
 * });
 * // Los avisos (`ITEM_LOW_STOCK`) se emiten SOLO tras confirmar la
 * // transacción: dentro de ella, un rollback dejaría avisos de algo que no pasó.
 * this.stock.emitPending(events);
 * ```
 *
 * Si algún ítem no alcanza EN ESA BODEGA, `issue` lanza `ConflictException`
 * (409) y la transacción completa se revierte.
 */
@Injectable()
export class StockService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  /** Suma saldo en una bodega: compra/reposición, devolución o entrada de traspaso. */
  receive(input: StockMovementInput): Promise<StockMovement>;
  receive(
    input: StockMovementInput,
    within: StockTransaction,
  ): Promise<StockMovement>;
  receive(
    input: StockMovementInput,
    within?: StockTransaction,
  ): Promise<StockMovement> {
    return this.run((client) => this.applyIncoming(client, input), within);
  }

  /**
   * Resta saldo de una bodega. Lanza `ConflictException` si no alcanza — nunca
   * deja existencia negativa.
   */
  issue(input: StockMovementInput): Promise<StockMovement>;
  issue(
    input: StockMovementInput,
    within: StockTransaction,
  ): Promise<StockMovement>;
  issue(
    input: StockMovementInput,
    within?: StockTransaction,
  ): Promise<StockMovement> {
    return this.run(
      (client, events) => this.applyOutgoing(client, input, events),
      within,
    );
  }

  /**
   * Corrección tras conteo físico DE UNA BODEGA. Calcula la diferencia contra
   * el saldo que el sistema tiene ahí y la registra como IN u OUT con
   * `PHYSICAL_ADJUSTMENT`. Devuelve `null` si el conteo coincide: ensuciar el
   * kardex con un asiento de cero sería ruido.
   *
   * La fila de saldo se bloquea antes de leerla: dos conteos (o un conteo y un
   * movimiento) sobre la misma bodega se serializan, y la precondición
   * `expectedQuantity` se evalúa contra el saldo que de verdad quedó.
   */
  adjustToCount(input: AdjustToCountInput): Promise<StockMovement | null>;
  adjustToCount(
    input: AdjustToCountInput,
    within: StockTransaction,
  ): Promise<StockMovement | null>;
  adjustToCount(
    input: AdjustToCountInput,
    within?: StockTransaction,
  ): Promise<StockMovement | null> {
    return this.run(async (client, events) => {
      const item = await this.findItem(client, input.itemId);
      await this.assertBranchExists(client, input.branchId);

      const current = await this.lockedBalanceAt(
        client,
        input.itemId,
        input.branchId,
        input.countedQuantity,
      );

      assertExpected(
        { quantity: current },
        input.expectedQuantity !== undefined
          ? { quantity: input.expectedQuantity }
          : undefined,
        { quantity: input.countedQuantity },
        { quantity: 'existencia' },
      );

      const difference = input.countedQuantity - current;

      if (difference === 0) return null;

      const common: StockMovementInput = {
        id: input.id,
        itemId: input.itemId,
        branchId: input.branchId,
        quantity: Math.abs(difference),
        reason: MovementReason.PHYSICAL_ADJUSTMENT,
        performedById: input.performedById,
        notes:
          input.notes ??
          `Conteo físico de ${item.name}: ${formatNumber(current)} en sistema → ${formatNumber(input.countedQuantity)} real`,
      };

      return difference > 0
        ? this.applyIncoming(client, common)
        : this.applyOutgoing(client, common, events);
    }, within);
  }

  /**
   * Fija el umbral de reposición propio de una bodega. `upsert` porque
   * configurar el mínimo ANTES de que llegue el primer material es el caso
   * normal, no la excepción: la fila de saldo puede no existir todavía.
   */
  async setMinimum(input: {
    itemId: string;
    branchId: string;
    minimumQuantity: number;
  }): Promise<{ itemId: string; branchId: string; minimumQuantity: number }> {
    await this.findItem(this.prisma, input.itemId);
    await this.assertBranchExists(this.prisma, input.branchId);

    const stock = await this.prisma.stock.upsert({
      where: {
        itemId_branchId: { itemId: input.itemId, branchId: input.branchId },
      },
      create: {
        itemId: input.itemId,
        branchId: input.branchId,
        quantity: 0,
        minimumQuantity: input.minimumQuantity,
      },
      update: { minimumQuantity: input.minimumQuantity },
    });

    return {
      itemId: stock.itemId,
      branchId: stock.branchId,
      minimumQuantity: stock.minimumQuantity,
    };
  }

  /**
   * Traspaso entre bodegas: **dos asientos en UNA transacción** (salida en el
   * origen + entrada en el destino) que comparten `reference` y llevan
   * `reason = TRANSFER`.
   *
   * Que sea una sola transacción es lo que impide el peor resultado posible:
   * que la existencia salga de una bodega y no llegue a la otra. Si el origen
   * no alcanza, `issue` lanza y no se escribe nada.
   */
  async transfer(
    input: {
      /** PK del asiento de SALIDA cuando el cliente la genera: hace al
       *  traspaso reintentable sin duplicarse. */
      id?: string;
      itemId: string;
      sourceBranchId: string;
      destinationBranchId: string;
      quantity: number;
      /** Guía de despacho del traspaso. Va en los DOS asientos: es el mismo
       *  papel el que ampara la salida y la entrada. */
      documentNumber?: string | null;
      notes?: string | null;
    },
    performedById: string,
  ): Promise<TransferResult> {
    return createOrReturn({
      id: input.id,
      userId: performedById,
      conflictMessage: 'Ya existe un traspaso con ese id de otro usuario',
      findExisting: (id) => this.findTransfer(id),
      create: () => this.transferFresh(input, performedById),
    });
  }

  /**
   * El traspaso ya registrado cuya SALIDA tiene ese id, con la misma forma que
   * devuelve uno recién hecho. Un id que pertenece a otro tipo de asiento no
   * es un reintento de este traspaso: es 409, igual que un id ajeno.
   */
  private async findTransfer(
    id: string,
  ): Promise<ExistingRecord<TransferResult> | null> {
    const out = await this.prisma.stockMovement.findUnique({ where: { id } });
    if (!out) return null;

    const isTransferOut =
      out.reason === MovementReason.TRANSFER &&
      out.direction === MovementDirection.OUT &&
      out.reference !== null &&
      out.destinationBranchId !== null;
    if (!isTransferOut) {
      throw new ConflictException({
        message: 'Ya existe un movimiento con ese id que no es un traspaso',
        code: ERROR_CODES.ID_CONFLICT,
      });
    }

    const reference = out.reference!;
    const destinationBranchId = out.destinationBranchId!;

    return {
      ownerId: out.performedById,
      result: async () => {
        const [incoming, branches] = await Promise.all([
          // La entrada se identifica por TODO lo que la hace la contraparte de
          // esta salida: la `reference` sola la puede repetir un asiento
          // manual con el mismo texto.
          this.prisma.stockMovement.findFirstOrThrow({
            where: {
              reference,
              reason: MovementReason.TRANSFER,
              direction: MovementDirection.IN,
              itemId: out.itemId,
              branchId: destinationBranchId,
              sourceBranchId: out.branchId,
              performedById: out.performedById,
            },
          }),
          this.prisma.branch.findMany({
            where: { id: { in: [out.branchId, destinationBranchId] } },
            select: { id: true, name: true },
          }),
        ]);
        const nameOf = (branchId: string) =>
          branches.find((b) => b.id === branchId)?.name ?? branchId;

        return {
          reference,
          out,
          in: incoming,
          sourceBranchName: nameOf(out.branchId),
          destinationBranchName: nameOf(destinationBranchId),
        };
      },
    };
  }

  private async transferFresh(
    input: {
      id?: string;
      itemId: string;
      sourceBranchId: string;
      destinationBranchId: string;
      quantity: number;
      documentNumber?: string | null;
      notes?: string | null;
    },
    performedById: string,
  ): Promise<TransferResult> {
    if (input.sourceBranchId === input.destinationBranchId) {
      throw new ConflictException(
        'El origen y el destino del traspaso son la misma sucursal.',
      );
    }

    const [source, destination] = await Promise.all([
      this.assertBranchExists(this.prisma, input.sourceBranchId),
      this.assertBranchExists(this.prisma, input.destinationBranchId),
    ]);

    // `reference` se genera acá, ANTES de la transacción, para que los dos
    // asientos lo compartan y el kardex pueda mostrarlos apareados. Con id del
    // cliente es determinista: un reintento vuelve a calcular la misma.
    const reference = input.id
      ? `transfer_${input.id}`
      : `transfer_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;

    const events: PendingStockEvents = [];
    const result = await this.prisma.$transaction(async (tx) => {
      await this.lockTransferRows(
        tx,
        input.itemId,
        input.sourceBranchId,
        input.destinationBranchId,
      );

      const outgoing = await this.applyOutgoing(
        tx,
        {
          id: input.id,
          itemId: input.itemId,
          branchId: input.sourceBranchId,
          quantity: input.quantity,
          reason: MovementReason.TRANSFER,
          performedById,
          reference,
          documentNumber: input.documentNumber ?? null,
          notes: input.notes ?? `Traspaso a ${destination.name}`,
        },
        events,
      );

      const incoming = await this.applyIncoming(tx, {
        itemId: input.itemId,
        branchId: input.destinationBranchId,
        quantity: input.quantity,
        reason: MovementReason.TRANSFER,
        performedById,
        reference,
        documentNumber: input.documentNumber ?? null,
        notes: input.notes ?? `Traspaso desde ${source.name}`,
      });

      // Cada asiento guarda su contraparte para que el renglón del kardex se
      // explique solo ("salida hacia X" / "entrada desde Y").
      await tx.stockMovement.update({
        where: { id: outgoing.id },
        data: { destinationBranchId: input.destinationBranchId },
      });
      await tx.stockMovement.update({
        where: { id: incoming.id },
        data: { sourceBranchId: input.sourceBranchId },
      });

      // Con la contraparte ya anotada: es la misma forma que reconstruye un
      // reintento al releer los asientos.
      return {
        reference,
        out: { ...outgoing, destinationBranchId: input.destinationBranchId },
        in: { ...incoming, sourceBranchId: input.sourceBranchId },
        sourceBranchName: source.name,
        destinationBranchName: destination.name,
      };
    });

    this.emitPending(events);
    return result;
  }

  /**
   * Bloquea las dos filas de saldo del traspaso EN ORDEN por `branchId`, antes
   * de mover nada. Sin un orden común, A→B y B→A del mismo ítem se esperan
   * entre sí (cada una retiene el saldo de su origen y pide el del destino) y
   * Postgres aborta una con un deadlock. La fila del destino puede no existir
   * todavía: se crea vacía (se revierte con la transacción si el traspaso
   * falla) para tener algo que bloquear. La del origen no se crea: sin ella el
   * traspaso falla por existencia insuficiente.
   */
  private async lockTransferRows(
    client: PrismaClientLike,
    itemId: string,
    sourceBranchId: string,
    destinationBranchId: string,
  ): Promise<void> {
    const branchIds = [sourceBranchId, destinationBranchId].sort();
    for (const branchId of branchIds) {
      if (branchId === destinationBranchId) {
        await client.stock.upsert({
          where: { itemId_branchId: { itemId, branchId } },
          create: { itemId, branchId, quantity: 0 },
          update: {},
        });
      }
      await client.$queryRaw`
        SELECT id FROM stock
        WHERE item_id = ${itemId} AND branch_id = ${branchId}
        FOR UPDATE`;
    }
  }

  /**
   * Emite los avisos acumulados. Quien abrió la transacción lo llama DESPUÉS de
   * confirmarla; nunca dentro de ella ni en un reintento que no escribió nada.
   */
  emitPending(events: PendingStockEvents): void {
    for (const event of events) {
      this.eventEmitter.emit(DOMAIN_EVENTS.ITEM_LOW_STOCK, event);
    }
  }

  /**
   * Corre `operation` dentro de una transacción. Si el llamador ya abrió una,
   * se reutiliza — así el descuento puede ser atómico junto con la escritura
   * del otro dominio, y es ese llamador quien emite los avisos al confirmar.
   * Si no, la abre acá y emite apenas confirma.
   */
  private async run<T>(
    operation: (
      client: PrismaClientLike,
      events: PendingStockEvents,
    ) => Promise<T>,
    within?: StockTransaction,
  ): Promise<T> {
    if (within) return operation(within.tx, within.events);

    const events: PendingStockEvents = [];
    const result = await this.prisma.$transaction((tx) =>
      operation(tx, events),
    );
    this.emitPending(events);
    return result;
  }

  private async applyIncoming(
    client: PrismaClientLike,
    input: StockMovementInput,
  ): Promise<StockMovement> {
    this.assertPositive(input.quantity);
    await this.findItem(client, input.itemId);
    await this.assertBranchExists(client, input.branchId);

    // `upsert`: la primera vez que un ítem llega a una bodega no existe su fila
    // de saldo. Crearla acá evita sembrar N×M filas vacías.
    const stock = await client.stock.upsert({
      where: {
        itemId_branchId: { itemId: input.itemId, branchId: input.branchId },
      },
      create: {
        itemId: input.itemId,
        branchId: input.branchId,
        quantity: input.quantity,
      },
      update: { quantity: { increment: input.quantity } },
    });

    return this.record(client, input, MovementDirection.IN, stock.quantity);
  }

  private async applyOutgoing(
    client: PrismaClientLike,
    input: StockMovementInput,
    events: PendingStockEvents,
  ): Promise<StockMovement> {
    this.assertPositive(input.quantity);
    // Se valida la bodega ANTES del descuento: sin esto, una salida contra una
    // sucursal desactivada (o inexistente) no fallaba con un mensaje claro,
    // simplemente no encontraba fila y se reportaba como "existencia
    // insuficiente" — que manda a comprar material que en realidad está.
    await this.assertBranchExists(client, input.branchId);

    // Descuento condicional en UNA sola sentencia: el `where` incluye
    // `quantity >= N`, así que Postgres decide y aplica atómicamente. Leer el
    // saldo primero y actualizar después dejaría una ventana en la que dos
    // salidas concurrentes pasan ambas la validación y dejan la bodega en
    // negativo.
    const { count } = await client.stock.updateMany({
      where: {
        itemId: input.itemId,
        branchId: input.branchId,
        quantity: { gte: input.quantity },
      },
      data: { quantity: { decrement: input.quantity } },
    });

    if (count === 0) {
      // No se actualizó nada: o el ítem no existe, o no alcanzaba el saldo EN
      // ESA BODEGA. El mensaje distingue los dos casos porque la acción a tomar
      // es distinta: comprar, o traer de otra sucursal.
      throw await this.explainFailedIssue(client, input);
    }

    const stock = await client.stock.findUnique({
      where: {
        itemId_branchId: { itemId: input.itemId, branchId: input.branchId },
      },
      select: { quantity: true, minimumQuantity: true },
    });
    const balance = stock?.quantity ?? 0;

    const movement = await this.record(
      client,
      input,
      MovementDirection.OUT,
      balance,
    );

    await this.queueIfBelowMinimum(client, input, stock, balance, events);

    return movement;
  }

  /**
   * Encola el aviso cuando el saldo de la bodega CRUZA su mínimo hacia abajo. Solo en el
   * cruce, no en cada salida posterior mientras siga bajo — si no, la primera
   * mantención larga llena el centro de notificaciones y se dejan de leer.
   *
   * `minimumQuantity = 0` significa "esta bodega no fijó umbral" y no alerta.
   * El umbral de una bodega y el de la empresa no son la misma magnitud, y
   * heredar uno como el otro enciende la alerta en todas las filas a la vez.
   */
  private async queueIfBelowMinimum(
    client: PrismaClientLike,
    input: StockMovementInput,
    stock: { minimumQuantity: number } | null,
    balance: number,
    events: PendingStockEvents,
  ): Promise<void> {
    const minimum = stock?.minimumQuantity ?? 0;
    if (minimum <= 0) return;

    const balanceBefore = balance + input.quantity;
    const crossed = balanceBefore > minimum && balance <= minimum;
    if (!crossed) return;

    // Se consultan nombres SOLO cuando la alerta se dispara: en el camino
    // normal (la enorme mayoría de las salidas) no se paga ninguna query extra.
    const [item, branch] = await Promise.all([
      client.inventoryItem.findUnique({
        where: { id: input.itemId },
        select: { name: true },
      }),
      client.branch.findUnique({
        where: { id: input.branchId },
        select: { name: true },
      }),
    ]);

    events.push({
      itemId: input.itemId,
      itemName: item?.name ?? input.itemId,
      branchId: input.branchId,
      branchName: branch?.name ?? input.branchId,
      quantity: balance,
      minimumQuantity: minimum,
    });
  }

  private async explainFailedIssue(
    client: PrismaClientLike,
    input: StockMovementInput,
  ): Promise<ConflictException | NotFoundException> {
    const item = await client.inventoryItem.findUnique({
      where: { id: input.itemId },
      select: { name: true },
    });
    if (!item) {
      return new NotFoundException(`Ítem "${input.itemId}" no encontrado`);
    }

    const [available, branch, total] = await Promise.all([
      this.balanceAt(client, input.itemId, input.branchId),
      client.branch.findUnique({
        where: { id: input.branchId },
        select: { name: true },
      }),
      client.stock.aggregate({
        where: { itemId: input.itemId },
        _sum: { quantity: true },
      }),
    ]);

    const elsewhere = (total._sum.quantity ?? 0) - available;
    const hint =
      elsewhere > 0
        ? ` Hay ${formatNumber(elsewhere)} en otras sucursales.`
        : '';

    return new ConflictException({
      message: `Existencia insuficiente de "${item.name}" en ${branch?.name ?? 'la sucursal'}: disponible ${formatNumber(available)}, solicitado ${formatNumber(input.quantity)}.${hint}`,
      code: ERROR_CODES.INSUFFICIENT_STOCK,
    });
  }

  private record(
    client: PrismaClientLike,
    input: StockMovementInput,
    direction: MovementDirection,
    resultingBalance: number,
  ): Promise<StockMovement> {
    return client.stockMovement.create({
      data: {
        ...(input.id ? { id: input.id } : {}),
        itemId: input.itemId,
        branchId: input.branchId,
        direction,
        reason: input.reason,
        quantity: input.quantity,
        resultingBalance,
        performedById: input.performedById ?? null,
        equipmentId: input.equipmentId ?? null,
        reference: input.reference ?? null,
        documentNumber: input.documentNumber ?? null,
        notes: input.notes ?? null,
      },
    });
  }

  /**
   * Saldo de un ítem en una bodega. Sin fila = la bodega nunca recibió el ítem;
   * eso es saldo 0, no un error: así la pantalla puede listar el catálogo
   * completo por bodega sin exigir una fila por cada combinación.
   */
  private async balanceAt(
    client: PrismaClientLike,
    itemId: string,
    branchId: string,
  ): Promise<number> {
    const stock = await client.stock.findUnique({
      where: { itemId_branchId: { itemId, branchId } },
      select: { quantity: true },
    });
    return stock?.quantity ?? 0;
  }

  /**
   * Saldo de una bodega bajo bloqueo de su fila (`FOR UPDATE`). Sin fila el
   * saldo es 0 y no hay nada que bloquear: si el conteo es 0 no se crea nada;
   * si es mayor, se crea la fila vacía para poder bloquearla y que un ingreso
   * concurrente no se sume encima del conteo.
   */
  private async lockedBalanceAt(
    client: PrismaClientLike,
    itemId: string,
    branchId: string,
    countedQuantity: number,
  ): Promise<number> {
    const existing = await client.stock.findUnique({
      where: { itemId_branchId: { itemId, branchId } },
      select: { id: true },
    });
    if (!existing) {
      if (countedQuantity === 0) return 0;
      await client.stock.upsert({
        where: { itemId_branchId: { itemId, branchId } },
        create: { itemId, branchId, quantity: 0 },
        update: {},
      });
    }

    const rows = await client.$queryRaw<{ quantity: number }[]>`
      SELECT quantity FROM stock
      WHERE item_id = ${itemId} AND branch_id = ${branchId}
      FOR UPDATE`;
    return rows[0]?.quantity ?? 0;
  }

  private async findItem(client: PrismaClientLike, itemId: string) {
    const item = await client.inventoryItem.findUnique({
      where: { id: itemId },
      select: { id: true, name: true },
    });
    if (!item) throw new NotFoundException(`Ítem "${itemId}" no encontrado`);
    return item;
  }

  private async assertBranchExists(
    client: PrismaClientLike,
    branchId: string,
  ): Promise<{ id: string; name: string }> {
    const branch = await client.branch.findUnique({
      where: { id: branchId },
      select: { id: true, name: true, isActive: true },
    });
    if (!branch) {
      throw new NotFoundException(`Sucursal "${branchId}" no encontrada`);
    }
    if (!branch.isActive) {
      throw new ConflictException(
        `La sucursal "${branch.name}" está desactivada y no admite movimientos de existencias.`,
      );
    }
    return { id: branch.id, name: branch.name };
  }

  private assertPositive(quantity: number): void {
    if (!Number.isFinite(quantity) || quantity <= 0) {
      throw new ConflictException(
        'La cantidad del movimiento debe ser mayor a 0',
      );
    }
  }
}
