import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  MovimientoInventario,
  OrigenMovimiento,
  Prisma,
  TipoMovimiento,
} from '@prisma/client';

import { PrismaService } from '../common/prisma/prisma.service';

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
  /** Stock real contado en bodega. */
  stockContado: number;
  responsableId?: string | null;
  observacion?: string | null;
}

/**
 * API de stock del dominio Inventario (Amin). **Es el único camino permitido
 * para mover `Insumo.stock`** — ningún otro dominio escribe esa columna
 * directamente (guía §5, "Cruces a coordinar": Mantenimiento y Actividades
 * consumen insumos vía esta función).
 *
 * Cada operación hace dos cosas en la MISMA transacción: mueve el saldo y deja
 * el `MovimientoInventario` con el `saldoResultante`. Por eso el kardex siempre
 * cuadra con el stock — no hay forma de mover uno sin el otro.
 *
 * ## Uso desde otro dominio (contrato acordado con Joaquín, RFC §5.1)
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
 *       },
 *       tx, // ← se pasa el tx: la bitácora y los descuentos son todo-o-nada
 *     );
 *   }
 *
 *   return intervencion;
 * });
 * ```
 *
 * Si algún insumo no alcanza, `registrarSalida` lanza `ConflictException` (409)
 * y la transacción completa se revierte: no queda la intervención a medias.
 */
@Injectable()
export class InventarioService {
  constructor(private readonly prisma: PrismaService) {}

  /** Suma stock: compra/reposición o devolución a bodega. */
  registrarEntrada(
    input: RegistrarMovimientoInput,
    tx?: Prisma.TransactionClient,
  ): Promise<MovimientoInventario> {
    return this.ejecutar((client) => this.aplicarEntrada(client, input), tx);
  }

  /**
   * Resta stock: consumo por intervención, actividad o trabajo extraordinario.
   * Lanza `ConflictException` si el saldo no alcanza — nunca deja stock negativo.
   */
  registrarSalida(
    input: RegistrarMovimientoInput,
    tx?: Prisma.TransactionClient,
  ): Promise<MovimientoInventario> {
    return this.ejecutar((client) => this.aplicarSalida(client, input), tx);
  }

  /**
   * Corrección tras conteo físico (requerimientos §5.1). Calcula la diferencia
   * contra el stock del sistema y la registra como ENTRADA o SALIDA con origen
   * `AJUSTE_FISICO`. Devuelve `null` si el conteo coincide con el sistema: no
   * hay nada que mover y ensuciar el kardex con un movimiento de cero sería
   * ruido.
   */
  ajustarPorConteo(
    input: AjustarPorConteoInput,
    tx?: Prisma.TransactionClient,
  ): Promise<MovimientoInventario | null> {
    return this.ejecutar(async (client) => {
      const insumo = await this.buscarInsumo(client, input.insumoId);
      const diferencia = input.stockContado - insumo.stock;

      if (diferencia === 0) return null;

      const comun = {
        insumoId: input.insumoId,
        cantidad: Math.abs(diferencia),
        origen: OrigenMovimiento.AJUSTE_FISICO,
        responsableId: input.responsableId,
        observacion:
          input.observacion ??
          `Conteo físico: ${insumo.stock} en sistema → ${input.stockContado} real`,
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

  private async aplicarEntrada(
    client: ClientePrisma,
    input: RegistrarMovimientoInput,
  ): Promise<MovimientoInventario> {
    this.assertCantidadPositiva(input.cantidad);
    await this.buscarInsumo(client, input.insumoId);

    const insumo = await client.insumo.update({
      where: { id: input.insumoId },
      data: { stock: { increment: input.cantidad } },
    });

    return this.registrar(client, input, TipoMovimiento.ENTRADA, insumo.stock);
  }

  private async aplicarSalida(
    client: ClientePrisma,
    input: RegistrarMovimientoInput,
  ): Promise<MovimientoInventario> {
    this.assertCantidadPositiva(input.cantidad);

    // Descuento condicional en UNA sola sentencia: el `where` incluye
    // `stock >= cantidad`, así que Postgres decide y aplica atómicamente. Leer
    // el stock primero y actualizar después dejaría una ventana en la que dos
    // salidas concurrentes podrían pasar ambas la validación y dejar el saldo
    // en negativo.
    const { count } = await client.insumo.updateMany({
      where: { id: input.insumoId, stock: { gte: input.cantidad } },
      data: { stock: { decrement: input.cantidad } },
    });

    if (count === 0) {
      // No se actualizó nada: o el insumo no existe, o no alcanzaba el stock.
      const insumo = await this.buscarInsumo(client, input.insumoId);
      throw new ConflictException(
        `Stock insuficiente de "${insumo.nombre}": disponible ${insumo.stock}, solicitado ${input.cantidad}`,
      );
    }

    const insumo = await this.buscarInsumo(client, input.insumoId);
    return this.registrar(client, input, TipoMovimiento.SALIDA, insumo.stock);
  }

  private registrar(
    client: ClientePrisma,
    input: RegistrarMovimientoInput,
    tipo: TipoMovimiento,
    saldoResultante: number,
  ): Promise<MovimientoInventario> {
    return client.movimientoInventario.create({
      data: {
        insumoId: input.insumoId,
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
