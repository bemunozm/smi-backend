import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Operator, Prisma } from '@prisma/client';
import type { UserSession } from '@thallesp/nestjs-better-auth';

import { ROLES, sessionHasRole } from '../auth/roles';
import { PrismaService } from '../common/prisma/prisma.service';
import { normalizeRut } from './rut';
import { CreateOperatorDto } from './dto/create-operator.dto';
import { QueryOperatorDto } from './dto/query-operator.dto';
import { UpdateOperatorDto } from './dto/update-operator.dto';

@Injectable()
export class OperatorsService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * B4(a) de la auditoría de seguridad: `rut` es PII y `GET /api/operators`
   * está abierto a CUALQUIER sesión (lectura sin `@Roles()`, ver
   * `OperatorsController`) — un OPERADOR o MANTENEDOR no necesita ver el RUT
   * de sus compañeros para elegir uno en el selector del Módulo A. `session`
   * es OPCIONAL: `undefined` (uso interno, ej. `assertActive` vía
   * `this.findOne(id)`) se trata como confiable — nunca se serializa de
   * vuelta a un cliente sin pasar antes por acá con la sesión real.
   */
  private hasRutAccess(session?: UserSession): boolean {
    if (!session) return true;
    return (
      sessionHasRole(session.user.role, ROLES.ADMIN) ||
      sessionHasRole(session.user.role, ROLES.SUPERVISOR)
    );
  }

  findAll(filtros: QueryOperatorDto, session?: UserSession) {
    const where: Prisma.OperatorWhereInput = {};

    if (filtros.isActive !== undefined) where.isActive = filtros.isActive;
    if (filtros.q) {
      where.name = { contains: filtros.q, mode: 'insensitive' };
    }

    if (this.hasRutAccess(session)) {
      return this.prisma.operator.findMany({ where, orderBy: { name: 'asc' } });
    }
    return this.prisma.operator.findMany({
      where,
      orderBy: { name: 'asc' },
      omit: { rut: true },
    });
  }

  /**
   * Sobrecargas (no solo un `session?` suelto): sin `session` (uso interno,
   * ej. `assertActive` acá abajo) el tipo estático sigue siendo `Operator`
   * completo — `assertActive` declara `Promise<Operator>` y necesita que
   * TypeScript sepa, en tiempo de compilación, que ESE call-site específico
   * nunca puede volver `Omit<Operator, 'rut'>`.
   */
  async findOne(id: string): Promise<Operator>;
  async findOne(
    id: string,
    session: UserSession,
  ): Promise<Operator | Omit<Operator, 'rut'>>;
  async findOne(id: string, session?: UserSession) {
    const operator = this.hasRutAccess(session)
      ? await this.prisma.operator.findUnique({ where: { id } })
      : await this.prisma.operator.findUnique({
          where: { id },
          omit: { rut: true },
        });
    if (!operator) {
      throw new NotFoundException(`Operador "${id}" no encontrado`);
    }
    return operator;
  }

  async create(dto: CreateOperatorDto) {
    // `rut` ya pasó `IsChileanRut` en el DTO (dígito verificador correcto) —
    // acá se normaliza SIEMPRE al formato canónico `12345678-K` antes de
    // persistir, para que dos entradas del mismo RUT con puntuación distinta
    // ("12.345.678-5" vs "12345678-5") choquen contra el `@unique` en vez de
    // guardarse como dos operadores distintos.
    const data: Prisma.OperatorCreateInput = {
      ...dto,
      ...(dto.rut !== undefined ? { rut: normalizeRut(dto.rut) } : {}),
    };

    try {
      return await this.prisma.operator.create({ data });
    } catch (error: unknown) {
      throw this.mapUniqueConstraintError(error, data.rut ?? undefined);
    }
  }

  async update(id: string, dto: UpdateOperatorDto) {
    await this.assertExiste(id);

    const data: Prisma.OperatorUpdateInput = {
      ...dto,
      ...(dto.rut !== undefined ? { rut: normalizeRut(dto.rut) } : {}),
    };

    try {
      return await this.prisma.operator.update({ where: { id }, data });
    } catch (error: unknown) {
      throw this.mapUniqueConstraintError(
        error,
        typeof data.rut === 'string' ? data.rut : undefined,
      );
    }
  }

  /**
   * Baja física. Solo se permite si ningún `RegistroHorometro` lo referencia
   * (histórico de tarjetas): el FK es `SetNull`, así que un borrado físico
   * dejaría esos registros sin operador de catálogo de forma silenciosa. Con
   * historial, se sugiere desactivarlo — mismo criterio que
   * `BranchService.remove`. El `code` en el body de la excepción es el nuevo
   * passthrough del filtro global (ver `HttpExceptionFilter`), para que un
   * caller programático distinga este 409 de otros sin parsear el mensaje.
   */
  async remove(id: string): Promise<void> {
    const operator = await this.prisma.operator.findUnique({
      where: { id },
      include: { _count: { select: { horometros: true } } },
    });

    if (!operator) {
      throw new NotFoundException(`Operador "${id}" no encontrado`);
    }

    if (operator._count.horometros > 0) {
      throw new ConflictException({
        message: `El operador "${operator.name}" tiene ${operator._count.horometros} registro(s) asociados y no se puede eliminar. Desactívalo (isActive=false) para retirarlo de los selectores conservando la referencia de los registros.`,
        code: 'OPERATOR_IN_USE',
      });
    }

    await this.prisma.operator.delete({ where: { id } });
  }

  /**
   * Valida que el operador exista y esté activo — precondición compartida
   * por los flujos que abren un turno con operador del catálogo
   * (`ShiftsService.openCard` y `HorometroService.create` de Flota, RFC
   * Supervisión en Terreno Fase 2): un operador desactivado no debe poder
   * quedar asignado a una tarjeta nueva, aunque su historial pasado se
   * conserve (`onDelete: SetNull`, ver schema). 404 si el id no existe
   * (typo); 409 `OPERATOR_INACTIVE` si existe pero está dado de baja — el
   * `code` es el passthrough del filtro global.
   */
  async assertActive(id: string): Promise<Operator> {
    const operator = await this.findOne(id);
    if (!operator.isActive) {
      throw new ConflictException({
        message: `El operador "${operator.name}" está inactivo`,
        code: 'OPERATOR_INACTIVE',
      });
    }
    return operator;
  }

  private async assertExiste(id: string): Promise<void> {
    const existe = await this.prisma.operator.findUnique({
      where: { id },
      select: { id: true },
    });
    if (!existe) {
      throw new NotFoundException(`Operador "${id}" no encontrado`);
    }
  }

  private mapUniqueConstraintError(error: unknown, rut?: string): unknown {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === 'P2002'
    ) {
      return new ConflictException(`Ya existe un operador con el RUT "${rut}"`);
    }
    return error;
  }
}
