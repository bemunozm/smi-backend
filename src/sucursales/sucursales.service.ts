import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, Sucursal } from '@prisma/client';

import { PrismaService } from '../common/prisma/prisma.service';
import { CreateSucursalDto } from './dto/create-sucursal.dto';
import { QuerySucursalesDto } from './dto/query-sucursales.dto';
import { UpdateSucursalDto } from './dto/update-sucursal.dto';

/** El service global o el `tx` de una transacción ya abierta por otro dominio. */
type ClientePrisma = PrismaService | Prisma.TransactionClient;

/**
 * Bodegas de la operación (RFC-11). Además del CRUD, es el dueño de dos reglas
 * que el resto del sistema da por ciertas:
 *
 * 1. **Existe exactamente una sucursal principal.** Es la bodega que se asume
 *    cuando un dominio que todavía no razona sobre ubicaciones (Mantenimiento,
 *    Terreno) registra un movimiento sin indicarla.
 * 2. **Una sucursal con historial no se borra.** El kardex la referencia con
 *    `onDelete: Restrict`; acá se bloquea antes, con un mensaje que explica qué
 *    hacer en su lugar (desactivarla).
 */
@Injectable()
export class SucursalesService {
  constructor(private readonly prisma: PrismaService) {}

  findAll(filtros: QuerySucursalesDto): Promise<Sucursal[]> {
    return this.prisma.sucursal.findMany({
      where: filtros.activa === undefined ? {} : { activa: filtros.activa },
      // La principal primero: es la que la UI preselecciona.
      orderBy: [{ esPrincipal: 'desc' }, { nombre: 'asc' }],
    });
  }

  async findOne(id: string): Promise<Sucursal> {
    const sucursal = await this.prisma.sucursal.findUnique({ where: { id } });
    if (!sucursal)
      throw new NotFoundException(`Sucursal "${id}" no encontrada`);
    return sucursal;
  }

  /**
   * Bodega por defecto. La usan los movimientos que llegan sin `sucursalId`
   * (contrato con Mantenimiento y Terreno — RFC-11 §5.3).
   *
   * Si no hay ninguna marcada, cae a la más antigua en vez de fallar: es un
   * estado alcanzable solo si alguien tocó la BD a mano, y en ese caso es mejor
   * que el inventario siga operando sobre una bodega real que reventar cada
   * movimiento del sistema.
   */
  async resolverPrincipal(
    client: ClientePrisma = this.prisma,
  ): Promise<string> {
    const principal = await client.sucursal.findFirst({
      where: { esPrincipal: true },
      orderBy: { createdAt: 'asc' },
    });
    if (principal) return principal.id;

    const primera = await client.sucursal.findFirst({
      orderBy: { createdAt: 'asc' },
    });
    if (!primera) {
      throw new ConflictException(
        'No hay ninguna sucursal registrada. Crea al menos una bodega antes de mover stock.',
      );
    }
    return primera.id;
  }

  /** Valida que la sucursal exista y esté operativa antes de imputarle stock. */
  async assertOperativa(
    sucursalId: string,
    client: ClientePrisma = this.prisma,
  ): Promise<Sucursal> {
    const sucursal = await client.sucursal.findUnique({
      where: { id: sucursalId },
    });
    if (!sucursal) {
      throw new NotFoundException(`Sucursal "${sucursalId}" no encontrada`);
    }
    if (!sucursal.activa) {
      throw new ConflictException(
        `La sucursal ${sucursal.codigo} está desactivada y no admite movimientos de stock.`,
      );
    }
    return sucursal;
  }

  async create(dto: CreateSucursalDto): Promise<Sucursal> {
    try {
      return await this.prisma.$transaction(async (tx) => {
        // Primera bodega del sistema: es principal aunque no lo pidan. Dejar el
        // sistema sin principal rompería el fallback de los movimientos.
        const hayAlguna = (await tx.sucursal.count()) > 0;
        const esPrincipal = dto.esPrincipal ?? !hayAlguna;

        if (esPrincipal) await this.desmarcarPrincipales(tx);

        return tx.sucursal.create({
          data: {
            codigo: dto.codigo,
            nombre: dto.nombre,
            direccion: dto.direccion,
            esPrincipal,
          },
        });
      });
    } catch (error: unknown) {
      throw this.traducirCodigoDuplicado(error, dto.codigo);
    }
  }

  async update(id: string, dto: UpdateSucursalDto): Promise<Sucursal> {
    const actual = await this.findOne(id);

    // Desactivar la principal dejaría al sistema sin bodega por defecto y todo
    // movimiento sin `sucursalId` explícito fallaría.
    if (dto.activa === false && actual.esPrincipal) {
      throw new ConflictException(
        `${actual.codigo} es la sucursal principal. Marca otra como principal antes de desactivarla.`,
      );
    }

    // Quitar la marca de principal sin dar una nueva deja el mismo hueco.
    if (dto.esPrincipal === false && actual.esPrincipal) {
      throw new ConflictException(
        'Debe haber siempre una sucursal principal. Marca otra como principal en lugar de desmarcar ésta.',
      );
    }

    return this.prisma.$transaction(async (tx) => {
      if (dto.esPrincipal === true && !actual.esPrincipal) {
        await this.desmarcarPrincipales(tx);
      }
      return tx.sucursal.update({ where: { id }, data: dto });
    });
  }

  /**
   * Baja física. Se bloquea si la bodega tiene kardex o saldo: su historial es
   * parte de la auditoría del inventario. La alternativa correcta —
   * desactivarla— va en el mensaje.
   */
  async remove(id: string): Promise<void> {
    const sucursal = await this.prisma.sucursal.findUnique({
      where: { id },
      include: {
        _count: { select: { movimientos: true, stocks: true } },
      },
    });

    if (!sucursal)
      throw new NotFoundException(`Sucursal "${id}" no encontrada`);

    if (sucursal.esPrincipal) {
      throw new ConflictException(
        `${sucursal.codigo} es la sucursal principal y no se puede eliminar. Marca otra como principal primero.`,
      );
    }

    if (sucursal._count.movimientos > 0) {
      throw new ConflictException(
        `${sucursal.codigo} tiene ${sucursal._count.movimientos} movimiento(s) en el kardex y no se puede eliminar sin perder ese historial. Desactívala en su lugar.`,
      );
    }

    const conSaldo = await this.prisma.stockSucursal.count({
      where: { sucursalId: id, stock: { gt: 0 } },
    });
    if (conSaldo > 0) {
      throw new ConflictException(
        `${sucursal.codigo} todavía tiene ${conSaldo} insumo(s) con saldo. Traslada o consume ese stock antes de eliminarla.`,
      );
    }

    await this.prisma.sucursal.delete({ where: { id } });
  }

  private desmarcarPrincipales(
    tx: Prisma.TransactionClient,
  ): Promise<Prisma.BatchPayload> {
    return tx.sucursal.updateMany({
      where: { esPrincipal: true },
      data: { esPrincipal: false },
    });
  }

  private traducirCodigoDuplicado(error: unknown, codigo: string): unknown {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === 'P2002'
    ) {
      return new ConflictException(
        `Ya existe una sucursal con el código "${codigo}"`,
      );
    }
    return error;
  }
}
