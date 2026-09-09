import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { PrismaService } from '../common/prisma/prisma.service';
import { CreateBranchDto } from './dto/create-branch.dto';
import { QueryBranchDto } from './dto/query-branch.dto';
import { UpdateBranchDto } from './dto/update-branch.dto';

@Injectable()
export class BranchService {
  constructor(private readonly prisma: PrismaService) {}

  findAll(filtros: QueryBranchDto) {
    const where: Prisma.BranchWhereInput = {};

    if (filtros.isActive !== undefined) where.isActive = filtros.isActive;
    if (filtros.q) {
      where.name = { contains: filtros.q, mode: 'insensitive' };
    }

    return this.prisma.branch.findMany({ where, orderBy: { name: 'asc' } });
  }

  async findOne(id: string) {
    const branch = await this.prisma.branch.findUnique({ where: { id } });
    if (!branch) {
      throw new NotFoundException(`Sucursal "${id}" no encontrada`);
    }
    return branch;
  }

  async create(dto: CreateBranchDto) {
    try {
      return await this.prisma.branch.create({ data: dto });
    } catch (error: unknown) {
      throw this.mapUniqueConstraintError(error, dto.name);
    }
  }

  async update(id: string, dto: UpdateBranchDto) {
    await this.assertExiste(id);
    try {
      return await this.prisma.branch.update({ where: { id }, data: dto });
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
