import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, TipoInsumo, UnidadInsumo } from '@prisma/client';

import { PrismaService } from '../../common/prisma/prisma.service';
import { SucursalesService } from '../../sucursales/sucursales.service';
import { QueryStockDto } from './dto/query-stock.dto';
import { evaluarMinimoBodega } from './minimo-efectivo';
import { SetStockMinimoDto } from './dto/set-stock-minimo.dto';

/** Una fila de la pantalla "Stock por sucursal". */
export interface StockEnSucursal {
  insumoId: string;
  codigo: string;
  nombre: string;
  descripcion: string | null;
  unidad: UnidadInsumo;
  tipo: TipoInsumo;
  /** Saldo en la bodega consultada. */
  stock: number;
  /** Suma de todas las bodegas — el contexto que evita pedir una compra al pedo. */
  stockTotal: number;
  /** Umbral propio de esta bodega. `0` = no configurado (ver `evaluarMinimoBodega`). */
  stockMinimo: number;
  /** `false` cuando la bodega nunca ha manejado este insumo. */
  enBodega: boolean;
  bajoMinimo: boolean;
}

export interface StockPorSucursal {
  sucursalId: string;
  sucursalCodigo: string;
  sucursalNombre: string;
  stock: number;
  stockMinimo: number;
  bajoMinimo: boolean;
}

/** `GET /api/inventario/insumos/:id/stock` — dónde está este insumo. */
export interface DesgloseInsumo {
  insumoId: string;
  codigo: string;
  nombre: string;
  unidad: UnidadInsumo;
  stockTotal: number;
  sucursales: StockPorSucursal[];
}

const INSUMO_SELECT = {
  id: true,
  codigo: true,
  nombre: true,
  descripcion: true,
  unidad: true,
  tipo: true,
  stock: true,
  stockMinimo: true,
} satisfies Prisma.InsumoSelect;

/**
 * Lecturas de inventario **por bodega** (RFC-11). Es solo consulta: mover saldos
 * sigue siendo exclusividad de `InventarioService`.
 */
@Injectable()
export class StockService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly sucursales: SucursalesService,
  ) {}

  /**
   * Catálogo de insumos con el saldo que tiene la bodega consultada.
   *
   * Se resuelve con UNA consulta: los insumos y, embebido, su `StockSucursal`
   * de esa sucursal (0..1 filas por el `@@unique`). Hacer una query por insumo
   * sería N+1 sobre la pantalla más visitada del módulo.
   */
  async listar(
    filtros: QueryStockDto,
  ): Promise<{ sucursalId: string; items: StockEnSucursal[] }> {
    const sucursalId = filtros.sucursalId
      ? (await this.sucursales.findOne(filtros.sucursalId)).id
      : await this.sucursales.resolverPrincipal();

    const insumos = await this.prisma.insumo.findMany({
      where: this.buildWhere(filtros, sucursalId),
      select: {
        ...INSUMO_SELECT,
        stocks: {
          where: { sucursalId },
          select: { stock: true, stockMinimo: true },
        },
      },
      orderBy: { nombre: 'asc' },
    });

    const items = insumos.map((insumo): StockEnSucursal => {
      const fila = insumo.stocks[0];
      const stock = fila?.stock ?? 0;
      const { stockMinimo, bajoMinimo } = evaluarMinimoBodega(
        stock,
        fila?.stockMinimo,
      );

      return {
        insumoId: insumo.id,
        codigo: insumo.codigo,
        nombre: insumo.nombre,
        descripcion: insumo.descripcion,
        unidad: insumo.unidad,
        tipo: insumo.tipo,
        stock,
        stockTotal: insumo.stock,
        stockMinimo,
        enBodega: fila !== undefined,
        bajoMinimo,
      };
    });

    // `bajoMinimo` depende de una fila que puede no existir (el insumo que esta
    // bodega nunca manejó) y de una regla que Prisma no sabe expresar en su
    // `where`, así que este filtro se aplica sobre el resultado. El costo es
    // acotado: el catálogo de insumos es un maestro, no una tabla que crece con
    // la operación (esa es `MovimientoInventario`, que sí se filtra en SQL).
    return {
      sucursalId,
      items: filtros.bajoStock
        ? items.filter((item) => item.bajoMinimo)
        : items,
    };
  }

  /** Dónde está repartido un insumo. Alimenta el desglose expandible de la tabla. */
  async desglosePorSucursal(insumoId: string): Promise<DesgloseInsumo> {
    const insumo = await this.prisma.insumo.findUnique({
      where: { id: insumoId },
      select: INSUMO_SELECT,
    });
    if (!insumo) {
      throw new NotFoundException(`Insumo "${insumoId}" no encontrado`);
    }

    // Se parte de las sucursales, no de las filas de stock: una bodega sin fila
    // debe aparecer en el desglose con 0. Si se listaran los `StockSucursal`,
    // las bodegas vacías desaparecerían y "no hay en ninguna parte" sería
    // indistinguible de "no consulté esa bodega".
    const sucursales = await this.prisma.sucursal.findMany({
      where: { activa: true },
      orderBy: [{ esPrincipal: 'desc' }, { nombre: 'asc' }],
      select: {
        id: true,
        codigo: true,
        nombre: true,
        stocks: {
          where: { insumoId },
          select: { stock: true, stockMinimo: true },
        },
      },
    });

    return {
      insumoId: insumo.id,
      codigo: insumo.codigo,
      nombre: insumo.nombre,
      unidad: insumo.unidad,
      stockTotal: insumo.stock,
      sucursales: sucursales.map((sucursal): StockPorSucursal => {
        const fila = sucursal.stocks[0];
        const stock = fila?.stock ?? 0;
        const { stockMinimo, bajoMinimo } = evaluarMinimoBodega(
          stock,
          fila?.stockMinimo,
        );

        return {
          sucursalId: sucursal.id,
          sucursalCodigo: sucursal.codigo,
          sucursalNombre: sucursal.nombre,
          stock,
          stockMinimo,
          bajoMinimo,
        };
      }),
    };
  }

  /**
   * Fija el umbral de reposición propio de una bodega. Se hace con `upsert`
   * porque la fila de saldo puede no existir todavía: configurar el mínimo
   * ANTES de que llegue el primer repuesto es el caso normal, no la excepción.
   */
  async setStockMinimo(dto: SetStockMinimoDto): Promise<void> {
    const insumo = await this.prisma.insumo.findUnique({
      where: { id: dto.insumoId },
      select: { id: true },
    });
    if (!insumo) {
      throw new NotFoundException(`Insumo "${dto.insumoId}" no encontrado`);
    }
    await this.sucursales.findOne(dto.sucursalId);

    await this.prisma.stockSucursal.upsert({
      where: {
        insumoId_sucursalId: {
          insumoId: dto.insumoId,
          sucursalId: dto.sucursalId,
        },
      },
      create: {
        insumoId: dto.insumoId,
        sucursalId: dto.sucursalId,
        stock: 0,
        stockMinimo: dto.stockMinimo,
      },
      update: { stockMinimo: dto.stockMinimo },
    });
  }

  private buildWhere(
    filtros: QueryStockDto,
    sucursalId: string,
  ): Prisma.InsumoWhereInput {
    const where: Prisma.InsumoWhereInput = {};

    if (filtros.q) {
      where.OR = [
        { codigo: { contains: filtros.q, mode: 'insensitive' } },
        { nombre: { contains: filtros.q, mode: 'insensitive' } },
      ];
    }

    if (filtros.tipo) where.tipo = filtros.tipo;

    if (filtros.soloEnBodega) {
      where.stocks = { some: { sucursalId } };
    }

    return where;
  }
}
