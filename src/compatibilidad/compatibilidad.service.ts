import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  CompatibilidadEquipoInsumo,
  EstadoEquipo,
  Prisma,
  TipoInsumo,
  UnidadInsumo,
} from '@prisma/client';

import { PrismaService } from '../common/prisma/prisma.service';
import { evaluarMinimoBodega } from '../inventario/stock/minimo-efectivo';
import { SucursalesService } from '../sucursales/sucursales.service';
import { CreateCompatibilidadDto } from './dto/create-compatibilidad.dto';
import { QueryRepuestosDto } from './dto/query-repuestos.dto';
import { ReplicarCompatibilidadesDto } from './dto/replicar-compatibilidades.dto';
import { UpdateCompatibilidadDto } from './dto/update-compatibilidad.dto';

/** Un repuesto compatible, con el stock que decide si sirve de algo. */
export interface RepuestoCompatible {
  compatibilidadId: string;
  insumoId: string;
  codigo: string;
  nombre: string;
  descripcion: string | null;
  unidad: UnidadInsumo;
  tipo: TipoInsumo;
  nota: string | null;
  /** Saldo en la bodega consultada. */
  stockSucursal: number;
  /** Saldo sumado de todas las bodegas. */
  stockTotal: number;
  stockMinimo: number;
  bajoMinimo: boolean;
}

export interface RepuestosDeEquipo {
  equipo: {
    id: string;
    codigo: string;
    tipo: string;
    marca: string;
    modelo: string;
    estado: EstadoEquipo;
  };
  sucursalId: string;
  repuestos: RepuestoCompatible[];
}

/** Equipo compatible con un repuesto — la consulta inversa. */
export interface EquipoCompatible {
  compatibilidadId: string;
  equipoId: string;
  codigo: string;
  tipo: string;
  marca: string;
  modelo: string;
  estado: EstadoEquipo;
  nota: string | null;
}

/** Candidato desde el cual copiar compatibilidades (mismo marca + modelo). */
export interface OrigenReplicable {
  equipoId: string;
  codigo: string;
  cantidad: number;
}

export interface ResultadoReplicacion {
  copiadas: number;
  /** Ya estaban declaradas en el destino; no se duplican. */
  omitidas: number;
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

const EQUIPO_SELECT = {
  id: true,
  codigo: true,
  tipo: true,
  marca: true,
  modelo: true,
  estado: true,
} satisfies Prisma.EquipoSelect;

/**
 * Compatibilidad repuesto ↔ equipo (RFC-12).
 *
 * Responde las dos direcciones de la misma pregunta:
 * - `repuestosDeEquipo`: el mantenedor abre una OT y quiere saber qué le pone.
 * - `equiposDeInsumo`: bodega recibe un repuesto y quiere saber si vale la pena
 *   reponerlo.
 *
 * La primera cruza con el stock de la bodega porque "sirve" sin "lo tengo" no
 * resuelve nada: la decisión real es usar / pedir traslado / comprar.
 */
@Injectable()
export class CompatibilidadService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly sucursales: SucursalesService,
  ) {}

  async repuestosDeEquipo(
    equipoId: string,
    filtros: QueryRepuestosDto,
  ): Promise<RepuestosDeEquipo> {
    const equipo = await this.buscarEquipo(equipoId);

    const sucursalId = filtros.sucursalId
      ? (await this.sucursales.findOne(filtros.sucursalId)).id
      : await this.sucursales.resolverPrincipal();

    // Una sola consulta: las compatibilidades del equipo, con el insumo y —
    // embebido— su saldo en esa bodega (0..1 filas por el `@@unique` de
    // `StockSucursal`). Es el join que la Opción B de RFC-12 (reglas por
    // marca/modelo en texto libre) no habría permitido hacer de forma confiable.
    const compatibilidades =
      await this.prisma.compatibilidadEquipoInsumo.findMany({
        where: { equipoId },
        include: {
          insumo: {
            select: {
              ...INSUMO_SELECT,
              stocks: {
                where: { sucursalId },
                select: { stock: true, stockMinimo: true },
              },
            },
          },
        },
        orderBy: { insumo: { nombre: 'asc' } },
      });

    const repuestos = compatibilidades.map((fila): RepuestoCompatible => {
      const saldo = fila.insumo.stocks[0];
      const stockSucursal = saldo?.stock ?? 0;
      const { stockMinimo, bajoMinimo } = evaluarMinimoBodega(
        stockSucursal,
        saldo?.stockMinimo,
      );

      return {
        compatibilidadId: fila.id,
        insumoId: fila.insumo.id,
        codigo: fila.insumo.codigo,
        nombre: fila.insumo.nombre,
        descripcion: fila.insumo.descripcion,
        unidad: fila.insumo.unidad,
        tipo: fila.insumo.tipo,
        nota: fila.nota,
        stockSucursal,
        stockTotal: fila.insumo.stock,
        stockMinimo,
        bajoMinimo,
      };
    });

    return {
      equipo,
      sucursalId,
      repuestos: filtros.soloConStock
        ? repuestos.filter((repuesto) => repuesto.stockSucursal > 0)
        : repuestos,
    };
  }

  /** En qué equipos se usa este repuesto. */
  async equiposDeInsumo(insumoId: string): Promise<EquipoCompatible[]> {
    await this.buscarInsumo(insumoId);

    const compatibilidades =
      await this.prisma.compatibilidadEquipoInsumo.findMany({
        where: { insumoId },
        include: { equipo: { select: EQUIPO_SELECT } },
        orderBy: { equipo: { codigo: 'asc' } },
      });

    return compatibilidades.map((fila) => ({
      compatibilidadId: fila.id,
      equipoId: fila.equipo.id,
      codigo: fila.equipo.codigo,
      tipo: fila.equipo.tipo,
      marca: fila.equipo.marca,
      modelo: fila.equipo.modelo,
      estado: fila.equipo.estado,
      nota: fila.nota,
    }));
  }

  async create(
    dto: CreateCompatibilidadDto,
    declaradaPorId: string,
  ): Promise<CompatibilidadEquipoInsumo> {
    const [equipo, insumo] = await Promise.all([
      this.buscarEquipo(dto.equipoId),
      this.buscarInsumo(dto.insumoId),
    ]);

    try {
      return await this.prisma.compatibilidadEquipoInsumo.create({
        data: {
          equipoId: dto.equipoId,
          insumoId: dto.insumoId,
          nota: dto.nota,
          declaradaPorId,
        },
      });
    } catch (error: unknown) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        throw new ConflictException(
          `${insumo.codigo} ya está declarado como compatible con ${equipo.codigo}.`,
        );
      }
      throw error;
    }
  }

  async update(
    id: string,
    dto: UpdateCompatibilidadDto,
  ): Promise<CompatibilidadEquipoInsumo> {
    await this.buscarCompatibilidad(id);
    return this.prisma.compatibilidadEquipoInsumo.update({
      where: { id },
      data: { nota: dto.nota ?? null },
    });
  }

  async remove(id: string): Promise<void> {
    await this.buscarCompatibilidad(id);
    await this.prisma.compatibilidadEquipoInsumo.delete({ where: { id } });
  }

  /**
   * Equipos del mismo marca + modelo que YA tienen compatibilidades declaradas.
   * Alimenta el aviso "copiá las N de <código>" cuando el equipo abierto no
   * tiene ninguna.
   *
   * El match por `marca`/`modelo` se usa acá —y solo acá— como **sugerencia**:
   * si por un typo no encuentra candidatos, lo peor que pasa es que no aparezca
   * el atajo. Usarlo como fuente de verdad de la compatibilidad (Opción B del
   * RFC) habría hecho que ese mismo typo dejara una máquina sin repuestos.
   */
  async origenesReplicables(equipoId: string): Promise<OrigenReplicable[]> {
    const equipo = await this.buscarEquipo(equipoId);

    const candidatos = await this.prisma.equipo.findMany({
      where: {
        id: { not: equipoId },
        marca: { equals: equipo.marca, mode: 'insensitive' },
        modelo: { equals: equipo.modelo, mode: 'insensitive' },
        repuestosCompatibles: { some: {} },
      },
      select: {
        id: true,
        codigo: true,
        _count: { select: { repuestosCompatibles: true } },
      },
      orderBy: { codigo: 'asc' },
    });

    return candidatos.map((candidato) => ({
      equipoId: candidato.id,
      codigo: candidato.codigo,
      cantidad: candidato._count.repuestosCompatibles,
    }));
  }

  async replicar(
    destinoId: string,
    dto: ReplicarCompatibilidadesDto,
    declaradaPorId: string,
  ): Promise<ResultadoReplicacion> {
    const [destino, origen] = await Promise.all([
      this.buscarEquipo(destinoId),
      this.buscarEquipo(dto.origenId),
    ]);

    if (destino.id === origen.id) {
      throw new ConflictException(
        'El equipo de origen y el de destino son el mismo.',
      );
    }

    // Se exige mismo marca+modelo: copiar los repuestos de una excavadora a un
    // camión sería propagar información falsa a escala, y esta acción existe
    // justamente para ahorrar trabajo, no para saltarse el criterio.
    const mismoModelo =
      destino.marca.trim().toLowerCase() ===
        origen.marca.trim().toLowerCase() &&
      destino.modelo.trim().toLowerCase() ===
        origen.modelo.trim().toLowerCase();

    if (!mismoModelo) {
      throw new ConflictException(
        `${origen.codigo} (${origen.marca} ${origen.modelo}) no comparte marca y modelo con ${destino.codigo} (${destino.marca} ${destino.modelo}).`,
      );
    }

    const aCopiar = await this.prisma.compatibilidadEquipoInsumo.findMany({
      where: { equipoId: origen.id },
      select: { insumoId: true, nota: true },
    });

    if (aCopiar.length === 0) {
      throw new ConflictException(
        `${origen.codigo} no tiene repuestos declarados para copiar.`,
      );
    }

    // `skipDuplicates` en vez de fallar: la acción tiene que poder repetirse sin
    // consecuencias. Si el destino ya tenía la mitad declarada, se completan las
    // que faltan en vez de obligar a limpiar primero.
    const { count } = await this.prisma.compatibilidadEquipoInsumo.createMany({
      data: aCopiar.map((fila) => ({
        equipoId: destino.id,
        insumoId: fila.insumoId,
        nota: fila.nota,
        declaradaPorId,
      })),
      skipDuplicates: true,
    });

    return { copiadas: count, omitidas: aCopiar.length - count };
  }

  private async buscarEquipo(id: string) {
    const equipo = await this.prisma.equipo.findUnique({
      where: { id },
      select: EQUIPO_SELECT,
    });
    if (!equipo) throw new NotFoundException(`Equipo "${id}" no encontrado`);
    return equipo;
  }

  private async buscarInsumo(id: string) {
    const insumo = await this.prisma.insumo.findUnique({
      where: { id },
      select: { id: true, codigo: true },
    });
    if (!insumo) throw new NotFoundException(`Insumo "${id}" no encontrado`);
    return insumo;
  }

  private async buscarCompatibilidad(id: string) {
    const fila = await this.prisma.compatibilidadEquipoInsumo.findUnique({
      where: { id },
    });
    if (!fila) {
      throw new NotFoundException(`Compatibilidad "${id}" no encontrada`);
    }
    return fila;
  }
}
