import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Operator, Prisma } from '@prisma/client';
import type { UserSession } from '@thallesp/nestjs-better-auth';

import { ROLES, sessionHasRole } from '../auth/roles';
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
import { ERROR_CODES } from '../common/errors/error-codes';
import { normalizeRut } from './rut';
import { CreateOperatorDto } from './dto/create-operator.dto';
import { QueryOperatorDto } from './dto/query-operator.dto';
import { UpdateOperatorDto } from './dto/update-operator.dto';

/** `createdById` es interno: no sale en ninguna respuesta. */
const OPERATOR_OMIT = { createdById: true } satisfies Prisma.OperatorOmit;
const OPERATOR_OMIT_RUT = {
  createdById: true,
  rut: true,
} satisfies Prisma.OperatorOmit;

/** Un operador tal como sale a la API. */
export type OperatorResponse = Omit<Operator, 'createdById'>;

/** Cómo se nombra cada dato en el mensaje de conflicto (`STALE_UPDATE`). */
const CAMPO_LABEL: Record<string, string> = {
  name: 'Nombre',
  rut: 'RUT',
  isActive: 'Activo',
};

@Injectable()
export class OperatorsService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * `rut` es PII y `GET /api/operators`
   * está abierto a CUALQUIER sesión (lectura sin `@Roles()`, ver
   * `OperatorsController`) — un MANTENEDOR no necesita ver el RUT de los
   * operadores del catálogo para elegir uno en el selector del Módulo A.
   * `session` es OPCIONAL: `undefined` (uso interno, ej. `assertActive` vía
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
      return this.prisma.operator.findMany({
        where,
        orderBy: { name: 'asc' },
        omit: OPERATOR_OMIT,
      });
    }
    return this.prisma.operator.findMany({
      where,
      orderBy: { name: 'asc' },
      omit: OPERATOR_OMIT_RUT,
    });
  }

  /**
   * Sobrecargas (no solo un `session?` suelto): sin `session` (uso interno,
   * ej. `assertActive` acá abajo) el tipo estático sigue siendo `Operator`
   * completo — `assertActive` declara `Promise<Operator>` y necesita que
   * TypeScript sepa, en tiempo de compilación, que ESE call-site específico
   * nunca puede volver `Omit<Operator, 'rut'>`.
   */
  async findOne(id: string): Promise<OperatorResponse>;
  async findOne(
    id: string,
    session: UserSession,
  ): Promise<OperatorResponse | Omit<OperatorResponse, 'rut'>>;
  async findOne(id: string, session?: UserSession) {
    const operator = this.hasRutAccess(session)
      ? await this.prisma.operator.findUnique({
          where: { id },
          omit: OPERATOR_OMIT,
        })
      : await this.prisma.operator.findUnique({
          where: { id },
          omit: OPERATOR_OMIT_RUT,
        });
    if (!operator) {
      throw new NotFoundException(`Operador "${id}" no encontrado`);
    }
    return operator;
  }

  async create(dto: CreateOperatorDto, userId: string) {
    return createOrReturn({
      id: dto.id,
      userId,
      conflictMessage: 'Ya existe un operador con ese id de otro usuario',
      findExisting: async (id) => {
        const owner = await this.prisma.operator.findUnique({
          where: { id },
          select: { createdById: true },
        });
        if (!owner) return null;
        return { ownerId: owner.createdById, result: () => this.findOne(id) };
      },
      create: () => this.createFresh(dto, userId),
    });
  }

  private async createFresh(dto: CreateOperatorDto, userId: string) {
    // `rut` ya pasó `IsChileanRut` en el DTO (dígito verificador correcto) —
    // acá se normaliza SIEMPRE al formato canónico `12345678-K` antes de
    // persistir, para que dos entradas del mismo RUT con puntuación distinta
    // ("12.345.678-5" vs "12345678-5") choquen contra el `@unique` en vez de
    // guardarse como dos operadores distintos.
    const data: Prisma.OperatorCreateInput = {
      ...dto,
      ...(dto.rut !== undefined ? { rut: normalizeRut(dto.rut) } : {}),
      createdById: userId,
    };

    try {
      return await this.prisma.operator.create({ data, omit: OPERATOR_OMIT });
    } catch (error: unknown) {
      // Un choque con la PK es la carrera de dos reintentos con el mismo id:
      // lo resuelve `createOrReturn`, no es un RUT repetido.
      if (isPrimaryKeyViolation(error)) throw error;
      throw this.mapUniqueConstraintError(error, data.rut ?? undefined);
    }
  }

  async update(id: string, dto: UpdateOperatorDto, expected?: ExpectedFields) {
    await this.assertExiste(id);

    const data: Prisma.OperatorUpdateInput = {
      ...dto,
      ...(dto.rut !== undefined ? { rut: normalizeRut(dto.rut) } : {}),
    };

    const write = (db: Prisma.TransactionClient) =>
      db.operator.update({ where: { id }, data, omit: OPERATOR_OMIT });
    try {
      if (!expected) return await write(this.prisma);
      return await this.prisma.$transaction(async (tx) => {
        await assertExpectedLocked({
          tx,
          table: 'operator',
          id,
          expected,
          read: (db) =>
            db.operator.findUnique({
              where: { id },
              select: { name: true, rut: true, isActive: true },
            }),
          desired: definedFields({
            ...dto,
            ...(dto.rut !== undefined ? { rut: normalizeRut(dto.rut) } : {}),
          }),
          labels: CAMPO_LABEL,
          notFoundMessage: `Operador "${id}" no encontrado`,
        });
        return write(tx);
      });
    } catch (error: unknown) {
      throw this.mapUniqueConstraintError(
        error,
        typeof data.rut === 'string' ? data.rut : undefined,
      );
    }
  }

  /**
   * Baja física. Solo se permite si ningún `RegistroHorometro` NI ningún
   * `TrabajoExtraordinario` lo referencia (histórico) NI ningún `Equipment`
   * lo tiene como operador ACTUAL (`currentOperatorId`, FK real ahora que el
   * operador dejó de ser usuario de la plataforma): en los tres
   * casos el FK es `SetNull`, así que un borrado físico dejaría esos
   * registros/esa asignación sin operador de catálogo de forma silenciosa.
   * Con historial o asignación vigente, se sugiere desactivarlo — mismo
   * criterio que `BranchService.remove`. El `code` en el body de la
   * excepción es el passthrough del filtro global (ver
   * `HttpExceptionFilter`), para que un caller programático distinga este
   * 409 de otros sin parsear el mensaje.
   */
  async remove(id: string): Promise<void> {
    const operator = await this.prisma.operator.findUnique({
      where: { id },
      include: {
        _count: {
          select: {
            horometros: true,
            trabajosExtra: true,
            assignedEquipment: true,
          },
        },
      },
    });

    if (!operator) {
      throw new NotFoundException(`Operador "${id}" no encontrado`);
    }

    if (operator._count.horometros > 0) {
      throw new ConflictException({
        message: `El operador "${operator.name}" tiene ${operator._count.horometros} registro(s) asociados y no se puede eliminar. Desactívalo (isActive=false) para retirarlo de los selectores conservando la referencia de los registros.`,
        code: ERROR_CODES.OPERATOR_IN_USE,
      });
    }

    if (operator._count.trabajosExtra > 0) {
      throw new ConflictException({
        message: `El operador "${operator.name}" tiene ${operator._count.trabajosExtra} trabajo(s) extraordinario(s) asociados y no se puede eliminar. Desactívalo (isActive=false) para retirarlo de los selectores conservando la referencia de los registros.`,
        code: ERROR_CODES.OPERATOR_IN_USE,
      });
    }

    if (operator._count.assignedEquipment > 0) {
      throw new ConflictException({
        message: `El operador "${operator.name}" está asignado a ${operator._count.assignedEquipment} equipo(s) y no se puede eliminar. Desasígnalo o desactívalo (isActive=false) en vez de borrarlo.`,
        code: ERROR_CODES.OPERATOR_IN_USE,
      });
    }

    await this.prisma.operator.delete({ where: { id } });
  }

  /**
   * Valida que el operador exista y esté activo — precondición compartida
   * por los flujos que asignan un operador del catálogo
   * (`ShiftsService.openCard`, RFC Supervisión en Terreno;
   * `HorometroService.create` de Flota y `TrabajosExtraService.create`): un
   * operador desactivado no debe poder quedar asignado a un registro nuevo,
   * aunque su historial pasado se conserve (`onDelete: SetNull`, ver
   * schema). 404 si el id no existe
   * (typo); 409 `OPERATOR_INACTIVE` si existe pero está dado de baja — el
   * `code` es el passthrough del filtro global.
   */
  async assertActive(id: string): Promise<OperatorResponse> {
    const operator = await this.findOne(id);
    if (!operator.isActive) {
      throw new ConflictException({
        message: `El operador "${operator.name}" está inactivo`,
        code: ERROR_CODES.OPERATOR_INACTIVE,
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
