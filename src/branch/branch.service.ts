import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';

import {
  assertExpectedLocked,
  definedFields,
} from '../common/concurrency/assert-expected-locked';
import type { ExpectedFields } from '../common/concurrency/expected-fields';
import {
  createOrReturn,
  isPrimaryKeyViolation,
} from '../common/idempotency/create-or-return';
import { PrismaService } from '../common/prisma/prisma.service';
import { CreateBranchDto } from './dto/create-branch.dto';
import { QueryBranchDto } from './dto/query-branch.dto';
import { UpdateBranchDto } from './dto/update-branch.dto';

/** `createdById` es interno: no sale en ninguna respuesta. */
const BRANCH_OMIT = { createdById: true } satisfies Prisma.BranchOmit;

/** Cómo se nombra cada dato en el mensaje de conflicto (`STALE_UPDATE`). */
const CAMPO_LABEL: Record<string, string> = {
  name: 'Nombre',
  address: 'Dirección',
  isActive: 'Activa',
};

const UPDATE_FIELDS = {
  name: true,
  address: true,
  isActive: true,
} satisfies Prisma.BranchSelect;

@Injectable()
export class BranchService {
  constructor(private readonly prisma: PrismaService) {}

  findAll(filtros: QueryBranchDto) {
    const where: Prisma.BranchWhereInput = {};

    if (filtros.isActive !== undefined) where.isActive = filtros.isActive;
    if (filtros.q) {
      where.name = { contains: filtros.q, mode: 'insensitive' };
    }

    return this.prisma.branch.findMany({
      where,
      orderBy: { name: 'asc' },
      omit: BRANCH_OMIT,
    });
  }

  async findOne(id: string) {
    const branch = await this.prisma.branch.findUnique({
      where: { id },
      omit: BRANCH_OMIT,
    });
    if (!branch) {
      throw new NotFoundException(`Sucursal "${id}" no encontrada`);
    }
    return branch;
  }

  async create(dto: CreateBranchDto, userId: string) {
    return createOrReturn({
      id: dto.id,
      userId,
      conflictMessage: 'Ya existe una sucursal con ese id de otro usuario',
      findExisting: async (id) => {
        const branch = await this.prisma.branch.findUnique({ where: { id } });
        if (!branch) return null;
        const { createdById, ...result } = branch;
        return { ownerId: createdById, result };
      },
      create: async () => {
        try {
          return await this.prisma.branch.create({
            data: { ...dto, createdById: userId },
            omit: BRANCH_OMIT,
          });
        } catch (error: unknown) {
          // Un choque con la PK es la carrera de dos reintentos con el mismo
          // id: lo resuelve `createOrReturn`, no es un nombre repetido.
          if (isPrimaryKeyViolation(error)) throw error;
          throw this.mapUniqueConstraintError(error, dto.name);
        }
      },
    });
  }

  async update(id: string, dto: UpdateBranchDto, expected?: ExpectedFields) {
    await this.assertExiste(id);
    const write = (db: Prisma.TransactionClient) =>
      db.branch.update({ where: { id }, data: dto, omit: BRANCH_OMIT });
    try {
      if (!expected) return await write(this.prisma);
      return await this.prisma.$transaction(async (tx) => {
        await assertExpectedLocked({
          tx,
          table: 'branch',
          id,
          expected,
          read: (db) =>
            db.branch.findUnique({ where: { id }, select: UPDATE_FIELDS }),
          desired: definedFields(dto),
          labels: CAMPO_LABEL,
          notFoundMessage: `Sucursal "${id}" no encontrada`,
        });
        return write(tx);
      });
    } catch (error: unknown) {
      throw this.mapUniqueConstraintError(error, dto.name);
    }
  }

  /**
   * Baja física. Solo se permite si no tiene equipos homologados (`Equipment
   * .homeBranch`): el FK es `SetNull`, así que un borrado físico dejaría esos
   * equipos sin sucursal base de forma silenciosa. Con historial, se sugiere
   * desactivarla (`isActive=false`) — el mismo criterio de baja lógica que
   * usa `Equipment.status = OUT_OF_SERVICE` en vez de borrar filas.
   */
  async remove(id: string): Promise<void> {
    const branch = await this.prisma.branch.findUnique({
      where: { id },
      include: { _count: { select: { homedEquipment: true } } },
    });

    if (!branch) {
      throw new NotFoundException(`Sucursal "${id}" no encontrada`);
    }

    if (branch._count.homedEquipment > 0) {
      throw new ConflictException(
        `La sucursal "${branch.name}" tiene ${branch._count.homedEquipment} equipo(s) asociados y no se puede eliminar. ` +
          'Desactívala (isActive=false) para retirarla de los selectores conservando la referencia de los equipos.',
      );
    }

    await this.prisma.branch.delete({ where: { id } });
  }

  private async assertExiste(id: string): Promise<void> {
    const existe = await this.prisma.branch.findUnique({
      where: { id },
      select: { id: true },
    });
    if (!existe) throw new NotFoundException(`Sucursal "${id}" no encontrada`);
  }

  private mapUniqueConstraintError(error: unknown, name?: string): unknown {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === 'P2002'
    ) {
      return new ConflictException(
        `Ya existe una sucursal con el nombre "${name}"`,
      );
    }
    return error;
  }
}
