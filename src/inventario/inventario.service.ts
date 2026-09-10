import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import {
  Insumo,
  MovimientoInventario,
  OrigenMovimiento,
  Prisma,
  TipoMovimiento,
} from '@prisma/client';

import { PrismaService } from '../common/prisma/prisma.service';
import { DOMAIN_EVENTS } from '../common/events/domain-events';
import type { InsumoLowStockEvent } from '../common/events/domain-events';
import { SucursalesService } from '../sucursales/sucursales.service';

/**
 * Cliente Prisma capaz de ejecutar la operación: o bien el servicio global, o
 * bien el `tx` de un `$transaction` abierto por otro dominio.
 */
export type ClientePrisma = PrismaService | Prisma.TransactionClient;

export interface RegistrarMovimientoInput {
  insumoId: string;
  /** Siempre positiva. El signo lo determina la operación que se invoca. */
  cantidad: number;
  origen: OrigenMovimiento;
  /**
   * Bodega donde ocurre el movimiento (RFC-11). **Opcional a propósito**: si no
   * viene se usa la sucursal principal. Eso mantiene compatible el contrato que
   * ya consumen Mantenimiento y Terreno, que todavía no razonan sobre bodegas.
   * Cuando esos dominios sepan en qué faena se ejecuta el trabajo, pasan a
   * mandarla explícita y este service no cambia.
   */
  sucursalId?: string | null;
  /** `user.id` de Better Auth de quien ejecuta la operación. */
  responsableId?: string | null;
  /** Unidad a la que se imputa el consumo, si aplica. */
  equipoId?: string | null;
  /** Id del documento que originó el movimiento (intervencionId, actividadId…). */
  referenciaId?: string | null;
  observacion?: string | null;
}

export interface AjustarPorConteoInput {
  insumoId: string;
  /** Stock real contado EN LA BODEGA que se está inventariando. */
  stockContado: number;
  /** Bodega del conteo. Si no viene, la principal. */
  sucursalId?: string | null;
  responsableId?: string | null;
  observacion?: string | null;
}

/** Input ya resuelto: la bodega dejó de ser opcional. */
type MovimientoResuelto = RegistrarMovimientoInput & { sucursalId: string };

/**
 * API de stock del dominio Inventario. **Es el único camino permitido para
 * mover saldos** — ningún otro dominio escribe `StockSucursal.stock` ni
 * `Insumo.stock` directamente (guía §5, "Cruces a coordinar": Mantenimiento y
 * Actividades consumen insumos vía esta función).
 *
 * Cada operación hace TRES cosas en la MISMA transacción: mueve el saldo de la
 * bodega, actualiza el total consolidado del insumo y deja el
 * `MovimientoInventario` con el `saldoResultante` de esa bodega. Por eso el
 * kardex siempre cuadra con el stock y se sostiene la invariante de RFC-11 §5.2:
 *
 *     Insumo.stock == Σ StockSucursal.stock
 *
 * ## Uso desde otro dominio (contrato acordado, RFC §5.1)
 *
 * ```ts
 * // En MantenimientoModule: importar InventarioModule e inyectar el service.
 * await this.prisma.$transaction(async (tx) => {
 *   const intervencion = await tx.intervencion.create({ data: { ... } });
 *
 *   for (const item of dto.insumos) {
 *     await this.inventario.registrarSalida(
 *       {
 *         insumoId: item.insumoId,
 *         cantidad: item.cantidad,
 *         origen: OrigenMovimiento.INTERVENCION,
 *         responsableId: session.user.id,
 *         equipoId: orden.equipoId,
 *         referenciaId: intervencion.id,
 *         // sucursalId: opcional — sin él se descuenta de la bodega principal.
 *       },
 *       tx, // ← se pasa el tx: la bitácora y los descuentos son todo-o-nada
 *     );
 *   }
 *
 *   return intervencion;
 * });
 * ```
 *
 * Si algún insumo no alcanza EN ESA BODEGA, `registrarSalida` lanza
 * `ConflictException` (409) y la transacción completa se revierte: no queda la
 * intervención a medias.
 */
@Injectable()
export class InventarioService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly eventEmitter: EventEmitter2,
    private readonly sucursales: SucursalesService,
  ) {}

  /** Suma stock en una bodega: compra/reposición o devolución. */
  registrarEntrada(
    input: RegistrarMovimientoInput,
    tx?: Prisma.TransactionClient,
  ): Promise<MovimientoInventario> {
    return this.ejecutar(
      async (client) =>
        this.aplicarEntrada(client, await this.resolver(client, input)),
      tx,
    );
  }

  /**
   * Resta stock de una bodega: consumo por intervención, actividad o trabajo
   * extraordinario. Lanza `ConflictException` si el saldo de esa bodega no
   * alcanza — nunca deja stock negativo.
   */
  registrarSalida(
    input: RegistrarMovimientoInput,
    tx?: Prisma.TransactionClient,
  ): Promise<MovimientoInventario> {
    return this.ejecutar(
      async (client) =>
        this.aplicarSalida(client, await this.resolver(client, input)),
      tx,
    );
  }

  /**
   * Corrección tras conteo físico DE UNA BODEGA (requerimientos §5.1). Calcula
   * la diferencia contra el saldo que el sistema tiene en esa sucursal y la
   * registra como ENTRADA o SALIDA con origen `AJUSTE_FISICO`. Devuelve `null`
   * si el conteo coincide: no hay nada que mover y ensuciar el kardex con un
   * movimiento de cero sería ruido.
   */
  ajustarPorConteo(
    input: AjustarPorConteoInput,
    tx?: Prisma.TransactionClient,
  ): Promise<MovimientoInventario | null> {
    return this.ejecutar(async (client) => {
      const insumo = await this.buscarInsumo(client, input.insumoId);
      const sucursalId = await this.resolverSucursal(client, input.sucursalId);
      const stockActual = await this.saldoEnSucursal(
        client,
        input.insumoId,
        sucursalId,
      );
      const diferencia = input.stockContado - stockActual;

      if (diferencia === 0) return null;

      const comun: MovimientoResuelto = {
        insumoId: input.insumoId,
        sucursalId,
        cantidad: Math.abs(diferencia),
        origen: OrigenMovimiento.AJUSTE_FISICO,
        responsableId: input.responsableId,
        observacion:
          input.observacion ??
          `Conteo físico de ${insumo.nombre}: ${stockActual} en sistema → ${input.stockContado} real`,
      };

      return diferencia > 0
        ? this.aplicarEntrada(client, comun)
        : this.aplicarSalida(client, comun);
    }, tx);
  }

  /**
   * Corre `operacion` dentro de una transacción. Si el llamador ya abrió una
   * (`tx`), se reutiliza — así el descuento de stock puede ser atómico junto
   * con la escritura del otro dominio. Si no, se abre una propia.
   */
  private ejecutar<T>(
    operacion: (client: ClientePrisma) => Promise<T>,
    tx?: Prisma.TransactionClient,
  ): Promise<T> {
    if (tx) return operacion(tx);
    return this.prisma.$transaction((nuevoTx) => operacion(nuevoTx));
  }

  /** Completa la bodega y verifica que admita movimientos. */
  private async resolver(
    client: ClientePrisma,
    input: RegistrarMovimientoInput,
  ): Promise<MovimientoResuelto> {
    return {
      ...input,
      sucursalId: await this.resolverSucursal(client, input.sucursalId),
    };
  }

  private async resolverSucursal(
    client: ClientePrisma,
    sucursalId?: string | null,
  ): Promise<string> {
    if (!sucursalId) return this.sucursales.resolverPrincipal(client);
    await this.sucursales.assertOperativa(sucursalId, client);
    return sucursalId;
  }

  private async aplicarEntrada(
    client: ClientePrisma,
    input: MovimientoResuelto,
  ): Promise<MovimientoInventario> {
    this.assertCantidadPositiva(input.cantidad);
    await this.buscarInsumo(client, input.insumoId);

    // `upsert`: la primera vez que un insumo llega a una bodega no existe su
    // fila de saldo. Crearla acá evita tener que sembrar N×M filas vacías.
    const saldo = await client.stockSucursal.upsert({
      where: {
        insumoId_sucursalId: {
          insumoId: input.insumoId,
          sucursalId: input.sucursalId,
        },
      },
      create: {
        insumoId: input.insumoId,
        sucursalId: input.sucursalId,
        stock: input.cantidad,
      },
      update: { stock: { increment: input.cantidad } },
    });

    await this.sincronizarTotal(client, input.insumoId, input.cantidad);

    return this.registrar(client, input, TipoMovimiento.ENTRADA, saldo.stock);
  }

  private async aplicarSalida(
    client: ClientePrisma,
    input: MovimientoResuelto,
  ): Promise<MovimientoInventario> {
    this.assertCantidadPositiva(input.cantidad);

    // Descuento condicional en UNA sola sentencia: el `where` incluye
    // `stock >= cantidad`, así que Postgres decide y aplica atómicamente. Leer
    // el saldo primero y actualizar después dejaría una ventana en la que dos
    // salidas concurrentes podrían pasar ambas la validación y dejar la bodega
    // en negativo. Repartir el saldo en N filas (una por bodega) haría esa
    // ventana N veces más probable, así que la garantía se mantiene acá.
    const { count } = await client.stockSucursal.updateMany({
      where: {
        insumoId: input.insumoId,
        sucursalId: input.sucursalId,
        stock: { gte: input.cantidad },
      },
      data: { stock: { decrement: input.cantidad } },
    });

    if (count === 0) {
      // No se actualizó nada: o el insumo no existe, o no había saldo suficiente
      // EN ESA BODEGA. El mensaje distingue los dos casos porque la acción a
      // tomar es distinta: pedir una compra, o traer stock de otra sucursal.
      throw await this.explicarSalidaFallida(client, input);
    }

    const saldo = await this.saldoEnSucursal(
      client,
      input.insumoId,
      input.sucursalId,
    );

    const insumo = await this.sincronizarTotal(
      client,
      input.insumoId,
      -input.cantidad,
    );

    const movimiento = await this.registrar(
      client,
      input,
      TipoMovimiento.SALIDA,
      saldo,
    );

    // Cruce de mínimo (evita spam): solo se emite la primera vez que el
    // stock queda en o bajo el mínimo, no en cada salida subsiguiente
    // mientras siga bajo. `stockAntes` se deriva del descuento atómico de
    // arriba (stock post + lo descontado) — no hace falta otra query.
    //
    // Se compara contra el TOTAL de la empresa (`Insumo.stock`), que es lo que
    // este evento ya significaba antes de que el inventario fuera multi-bodega.
    // La alerta equivalente POR SUCURSAL es PROD-14 y tiene su propio umbral
    // (`StockSucursal.stockMinimo`): cambiar acá la semántica del evento le
    // alteraría el criterio a ese ticket sin que nadie lo decidiera.
    const stockAntes = insumo.stock + input.cantidad;
    if (stockAntes > insumo.stockMinimo && insumo.stock <= insumo.stockMinimo) {
      this.eventEmitter.emit(DOMAIN_EVENTS.INSUMO_LOW_STOCK, {
        insumoId: insumo.id,
        nombre: insumo.nombre,
        stock: insumo.stock,
        stockMinimo: insumo.stockMinimo,
      } satisfies InsumoLowStockEvent);
    }

    return movimiento;
  }

  /**
   * Mantiene `Insumo.stock` como suma de las bodegas (RFC-11 §5.2). Va en la
   * misma transacción que el movimiento de `StockSucursal`: o se aplican los
   * dos, o ninguno. Es un `increment` relativo y no un `SUM` recalculado para
   * no serializar las escrituras de bodegas distintas sobre el mismo insumo.
   *
   * Devuelve el insumo ya actualizado para que el llamador evalúe el cruce de
   * mínimo sin pagar otra query.
   */
  private sincronizarTotal(
    client: ClientePrisma,
    insumoId: string,
    delta: number,
  ): Promise<Insumo> {
    return client.insumo.update({
      where: { id: insumoId },
      data: { stock: { increment: delta } },
    });
  }

  private async saldoEnSucursal(
    client: ClientePrisma,
    insumoId: string,
    sucursalId: string,
  ): Promise<number> {
    const fila = await client.stockSucursal.findUnique({
      where: { insumoId_sucursalId: { insumoId, sucursalId } },
      select: { stock: true },
    });
    // Sin fila = la bodega nunca recibió este insumo. Eso es saldo 0, no un
    // error: así la pantalla de stock puede listar el catálogo completo por
    // bodega sin exigir que exista una fila por cada combinación.
    return fila?.stock ?? 0;
  }

  private async explicarSalidaFallida(
    client: ClientePrisma,
    input: MovimientoResuelto,
  ): Promise<ConflictException | NotFoundException> {
    const insumo = await client.insumo.findUnique({
      where: { id: input.insumoId },
      select: { nombre: true },
    });
    if (!insumo) {
      return new NotFoundException(`Insumo "${input.insumoId}" no encontrado`);
    }

    const [disponible, sucursal, total] = await Promise.all([
      this.saldoEnSucursal(client, input.insumoId, input.sucursalId),
      client.sucursal.findUnique({
        where: { id: input.sucursalId },
        select: { codigo: true },
      }),
      client.insumo.findUnique({
        where: { id: input.insumoId },
        select: { stock: true },
      }),
    ]);

    const enOtrasBodegas = (total?.stock ?? 0) - disponible;
    const pista =
      enOtrasBodegas > 0 ? ` Hay ${enOtrasBodegas} en otras sucursales.` : '';

    return new ConflictException(
      `Stock insuficiente de "${insumo.nombre}" en ${sucursal?.codigo ?? 'la sucursal'}: disponible ${disponible}, solicitado ${input.cantidad}.${pista}`,
    );
  }

  private registrar(
    client: ClientePrisma,
    input: MovimientoResuelto,
    tipo: TipoMovimiento,
    saldoResultante: number,
  ): Promise<MovimientoInventario> {
    return client.movimientoInventario.create({
      data: {
        insumoId: input.insumoId,
        sucursalId: input.sucursalId,
        tipo,
        origen: input.origen,
        cantidad: input.cantidad,
        saldoResultante,
        responsableId: input.responsableId ?? null,
        equipoId: input.equipoId ?? null,
        referenciaId: input.referenciaId ?? null,
        observacion: input.observacion ?? null,
      },
    });
  }

  private async buscarInsumo(client: ClientePrisma, insumoId: string) {
    const insumo = await client.insumo.findUnique({ where: { id: insumoId } });
    if (!insumo)
      throw new NotFoundException(`Insumo "${insumoId}" no encontrado`);
    return insumo;
  }

  private assertCantidadPositiva(cantidad: number): void {
    if (!Number.isFinite(cantidad) || cantidad <= 0) {
      throw new ConflictException(
        'La cantidad del movimiento debe ser mayor a 0',
      );
    }
  }
}
