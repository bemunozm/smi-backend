import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { EquipmentStatus, Prisma } from '@prisma/client';

import { ROLES } from '../auth/roles';
import type { Role } from '../auth/roles';
import { PrismaService } from '../common/prisma/prisma.service';
import { CreateEquipmentDto } from './dto/create-equipment.dto';
import { QueryEquipmentDto } from './dto/query-equipment.dto';
import {
  UpdateEquipmentAssignmentDto,
  UpdateEquipmentDto,
  UpdateEquipmentStatusDto,
} from './dto/update-equipment.dto';

/** Forma de `GET /api/equipment/resumen`, consumido por el dashboard (Benjamín). */
export interface ResumenFlota {
  total: number;
  disponibles: number;
  /** Conteo por cada valor del enum, incluidos los que están en cero. */
  porEstado: Record<EquipmentStatus, number>;
}

const ESTADOS: readonly EquipmentStatus[] = Object.values(EquipmentStatus);

/**
 * `include` compartido por `findAll`/`findOne`/`create`/`update`/`updateStatus`/
 * `updateAssignment` para poder derivar `currentFuelLevel`: el último
 * `RegistroHorometro` del equipo CON `nivelCombustible` no nulo (`where` +
 * ordenado por fecha desc) — si la lectura más reciente vino sin combustible
 * cargado, no queremos perder el último nivel real conocido. `currentOperatorId`/
 * `currentSupervisorId` son columnas propias de `Equipment` (soft refs a
 * `user.id`, ver `schema.prisma`) — no necesitan `include`, se resuelven
 * aparte con `resolveAssignedUsers` porque NO son una relación Prisma.
 */
export const EQUIPMENT_USAGE_INCLUDE = {
  horometros: {
    where: { nivelCombustible: { not: null } },
    orderBy: { fecha: 'desc' as const },
    take: 1,
    select: { nivelCombustible: true },
  },
} satisfies Prisma.EquipmentInclude;

export type EquipmentWithUsageRelations = Prisma.EquipmentGetPayload<{
  include: typeof EQUIPMENT_USAGE_INCLUDE;
}>;

/** Forma pública de un operador/supervisor asignado en la respuesta de Flota. */
export interface AssignedUserSummary {
  id: string;
  name: string;
}

/**
 * Turno abierto (flujo ENTRADA/SALIDA de dos pasos, Flota): el
 * `RegistroHorometro` más reciente del equipo con `valorFinal == null`. Le
 * dice al front si debe ofrecer "Registrar entrada" (`openShift == null`) o
 * "Registrar salida" (mostrando el contexto de la entrada).
 */
export interface OpenShiftSummary {
  id: string;
  valorInicial: number;
  operador: string;
  turno: string;
  fecha: Date;
}

/** Campos que `findAll`/`findOne`/`updateAssignment` agregan a la ficha cruda de Prisma. */
export interface EquipmentUsageFields {
  operator: AssignedUserSummary | null;
  supervisor: AssignedUserSummary | null;
  /** Derivado — NO es columna: `!!currentOperatorId`. */
  inUse: boolean;
  /** `nivelCombustible` del último `RegistroHorometro` del equipo, o `null` si no tiene lecturas. */
  currentFuelLevel: number | null;
  /** Turno de horómetro abierto del equipo, o `null` si no tiene uno en curso. */
  openShift: OpenShiftSummary | null;
  /** Estado de vigencia de R1/R2, derivado on-read de las columnas `*Expiry`. */
  documents: EquipmentDocumentsInfo;
}

/**
 * Umbral (en días) para pasar de `VIGENTE` a `POR_VENCER` en R1/R2.
 * Centralizado acá — nunca hardcodear el 30 inline — para que cualquier otro
 * consumidor futuro (ej. un cron de notificaciones) lea el mismo número.
 */
export const DOCUMENT_EXPIRY_WARNING_DAYS = 30;

export type DocumentStatus = 'VIGENTE' | 'POR_VENCER' | 'VENCIDO' | 'SIN_DATO';

/** Estado de vigencia de un documento individual (revisión técnica o seguro). */
export interface DocumentExpiryInfo {
  /** Fecha de vencimiento en ISO 8601, o `null` si no hay dato cargado. */
  expiry: string | null;
  status: DocumentStatus;
  /** Días de calendario hasta el vencimiento (negativo si ya venció), o `null` sin dato. */
  daysToExpiry: number | null;
}

/** Forma del campo `documents` en la respuesta de Flota (R1/R2). */
export interface EquipmentDocumentsInfo {
  technicalInspection: DocumentExpiryInfo;
  insurance: DocumentExpiryInfo;
}

/**
 * Días de calendario entre `now` y `expiry`, a granularidad de FECHA
 * (ignorando la hora) para evitar el off-by-one de restar dos timestamps
 * completos — sin esto, dos fechas del mismo día calendario pero con horas
 * distintas podrían dar un `daysToExpiry` fraccionario o corrido en ±1.
 * Ambas fechas se normalizan a medianoche UTC antes de restar.
 */
function daysBetweenDateOnly(now: Date, expiry: Date): number {
  const MS_PER_DAY = 24 * 60 * 60 * 1000;
  const nowUtc = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const expiryUtc = Date.UTC(
    expiry.getUTCFullYear(),
    expiry.getUTCMonth(),
    expiry.getUTCDate(),
  );
  return Math.round((expiryUtc - nowUtc) / MS_PER_DAY);
}

/**
 * Deriva `status`/`daysToExpiry` de un documento (R1/R2) on-read — no se
 * persiste, se recalcula en cada lectura contra el reloj actual. `now` es un
 * parámetro explícito (default `new Date()`) en vez de leer `Date.now()`
 * adentro, para que los tests puedan fijarlo sin mockear el reloj global.
 */
export function buildDocumentExpiryInfo(
  expiry: Date | null,
  now: Date = new Date(),
): DocumentExpiryInfo {
  if (!expiry) {
    return { expiry: null, status: 'SIN_DATO', daysToExpiry: null };
  }
  const daysToExpiry = daysBetweenDateOnly(now, expiry);
  const status: DocumentStatus =
    daysToExpiry < 0
      ? 'VENCIDO'
      : daysToExpiry <= DOCUMENT_EXPIRY_WARNING_DAYS
        ? 'POR_VENCER'
        : 'VIGENTE';
  return { expiry: expiry.toISOString(), status, daysToExpiry };
}

/**
 * Subset de campos que necesita el mapeo de errores de Prisma para construir
 * el mensaje. `licensePlate` acepta `null` porque `UpdateEquipmentDto` lo usa
 * para limpiar la columna (ver `update-equipment.dto.ts`); `create` nunca
 * manda `null` ahí, pero el tipo debe cubrir ambos DTOs.
 */
type UniqueFieldsDto = {
  internalCode?: string;
  licensePlate?: string | null;
};

@Injectable()
export class EquipmentService {
  constructor(private readonly prisma: PrismaService) {}

  async findAll(filtros: QueryEquipmentDto) {
    const where: Prisma.EquipmentWhereInput = {};

    if (filtros.status) where.status = filtros.status;
    if (filtros.equipmentClass) where.equipmentClass = filtros.equipmentClass;
    if (filtros.controlUnit) where.controlUnit = filtros.controlUnit;
    if (filtros.homeBranchId) where.homeBranchId = filtros.homeBranchId;
    if (filtros.type) {
      where.type = { equals: filtros.type, mode: 'insensitive' };
    }
    if (filtros.q) {
      where.OR = [
        { internalCode: { contains: filtros.q, mode: 'insensitive' } },
        { licensePlate: { contains: filtros.q, mode: 'insensitive' } },
        { brand: { contains: filtros.q, mode: 'insensitive' } },
        { model: { contains: filtros.q, mode: 'insensitive' } },
      ];
    }

    const equipos = await this.prisma.equipment.findMany({
      where,
      orderBy: { internalCode: 'asc' },
      include: EQUIPMENT_USAGE_INCLUDE,
    });

    return this.withUsageFields(equipos);
  }

  /**
   * Agregación para el KPI "equipos disponibles" del dashboard. Existe como
   * endpoint propio para que el front no tenga que traerse la flota completa
   * solo para contar (ver `DASHBOARD-CONTRACTS.md` en smi-frontend).
   */
  async resumen(): Promise<ResumenFlota> {
    const [total, agrupado] = await Promise.all([
      this.prisma.equipment.count(),
      this.prisma.equipment.groupBy({ by: ['status'], _count: { _all: true } }),
    ]);

    // `groupBy` omite los estados sin filas; el dashboard necesita las 3
    // claves siempre presentes, así que se parte de un mapa en cero.
    const porEstado = Object.fromEntries(
      ESTADOS.map((estado) => [estado, 0]),
    ) as Record<EquipmentStatus, number>;

    for (const fila of agrupado) {
      porEstado[fila.status] = fila._count._all;
    }

    return {
      total,
      disponibles: porEstado[EquipmentStatus.OPERATIONAL],
      porEstado,
    };
  }

  /**
   * Ficha del equipo. Incluye el conteo de registros asociados de los otros
   * dominios (solo lectura) para que la ficha muestre actividad real sin tener
   * que pedirle un endpoint a cada dueño. La línea de tiempo consolidada
   * (requerimientos §5.5) es de Benjamín — esto no la reemplaza.
   */
  async findOne(id: string) {
    const equipment = await this.prisma.equipment.findUnique({
      where: { id },
      include: {
        homeBranch: true,
        _count: {
          select: {
            combustibles: true,
            horometros: true,
            trabajosExtra: true,
            hallazgos: true,
            stockMovements: true,
          },
        },
        stockMovements: {
          orderBy: { occurredAt: 'desc' },
          take: 10,
          include: {
            item: { select: { sku: true, name: true, unit: true } },
          },
        },
        ...EQUIPMENT_USAGE_INCLUDE,
      },
    });

    if (!equipment) {
      throw new NotFoundException(`Equipo "${id}" no encontrado`);
    }
    const [shaped] = await this.withUsageFields([equipment]);
    return shaped;
  }

  /**
   * Devuelve la ficha recién creada ya enriquecida con `operator`/`supervisor`/
   * `inUse`/`currentFuelLevel` — mismo shaping que `findAll`/`findOne` (via
   * `EQUIPMENT_USAGE_INCLUDE` + `withUsageFields`). Sin esto el front, que
   * valida la respuesta contra `EquipmentResponseSchema` (esos 4 campos son
   * obligatorios), la rechaza con un ZodError aunque el equipo se haya creado
   * bien en la BD.
   */
  async create(dto: CreateEquipmentDto) {
    try {
      const equipment = await this.prisma.equipment.create({
        data: dto,
        include: EQUIPMENT_USAGE_INCLUDE,
      });
      const [shaped] = await this.withUsageFields([equipment]);
      return shaped;
    } catch (error: unknown) {
      throw this.mapPrismaError(error, dto);
    }
  }

  /** Mismo shaping que `create` — ver docstring de arriba. */
  async update(id: string, dto: UpdateEquipmentDto) {
    await this.assertExiste(id);
    try {
      const equipment = await this.prisma.equipment.update({
        where: { id },
        data: dto,
        include: EQUIPMENT_USAGE_INCLUDE,
      });
      const [shaped] = await this.withUsageFields([equipment]);
      return shaped;
    } catch (error: unknown) {
      throw this.mapPrismaError(error, dto);
    }
  }

  /** Mismo shaping que `create` — ver docstring de arriba. */
  async updateStatus(id: string, dto: UpdateEquipmentStatusDto) {
    await this.assertExiste(id);
    const equipment = await this.prisma.equipment.update({
      where: { id },
      data: { status: dto.status },
      include: EQUIPMENT_USAGE_INCLUDE,
    });
    const [shaped] = await this.withUsageFields([equipment]);
    return shaped;
  }

  /**
   * Asigna/libera la asignación de uso ACTUAL del equipo (operador +
   * supervisor a cargo ahora mismo — NO historial de sesiones). Cada campo es
   * independiente: `undefined` (propiedad omitida) deja esa asignación
   * intacta, `null` explícito la libera, un id la reemplaza — previa
   * validación de que el usuario existe y tiene el rol correspondiente, para
   * que el listado ("en uso por…") nunca muestre a alguien con el rol
   * equivocado.
   */
  async updateAssignment(id: string, dto: UpdateEquipmentAssignmentDto) {
    await this.assertExiste(id);

    const data: Prisma.EquipmentUpdateInput = {};

    if (dto.operatorId !== undefined) {
      if (dto.operatorId === null) {
        data.currentOperatorId = null;
      } else {
        await this.assertUserWithRole(dto.operatorId, ROLES.OPERADOR);
        data.currentOperatorId = dto.operatorId;
      }
    }

    if (dto.supervisorId !== undefined) {
      if (dto.supervisorId === null) {
        data.currentSupervisorId = null;
      } else {
        await this.assertUserWithRole(dto.supervisorId, ROLES.SUPERVISOR);
        data.currentSupervisorId = dto.supervisorId;
      }
    }

    const equipment = await this.prisma.equipment.update({
      where: { id },
      data,
      include: EQUIPMENT_USAGE_INCLUDE,
    });

    const [shaped] = await this.withUsageFields([equipment]);
    return shaped;
  }

  /**
   * Baja física. Solo se permite si la unidad no tiene historial: un equipo con
   * registros de terreno o movimientos de inventario es parte de la
   * trazabilidad del sistema y se retira con `status = OUT_OF_SERVICE`, no
   * borrándolo.
   */
  async remove(id: string): Promise<void> {
    const equipment = await this.prisma.equipment.findUnique({
      where: { id },
      include: {
        _count: {
          select: {
            combustibles: true,
            horometros: true,
            trabajosExtra: true,
            hallazgos: true,
            stockMovements: true,
          },
        },
      },
    });

    if (!equipment) {
      throw new NotFoundException(`Equipo "${id}" no encontrado`);
    }

    const registros =
      equipment._count.combustibles +
      equipment._count.horometros +
      equipment._count.trabajosExtra +
      equipment._count.hallazgos +
      equipment._count.stockMovements;

    if (registros > 0) {
      throw new ConflictException(
        `El equipo ${equipment.internalCode} tiene ${registros} registro(s) asociados y no se puede eliminar. ` +
          'Cámbialo a estado "Fuera de servicio" para retirarlo de la operación conservando su historial.',
      );
    }

    await this.prisma.equipment.delete({ where: { id } });
  }

  private async assertExiste(id: string): Promise<void> {
    const existe = await this.prisma.equipment.findUnique({
      where: { id },
      select: { id: true },
    });
    if (!existe) throw new NotFoundException(`Equipo "${id}" no encontrado`);
  }

  /**
   * Agrega `operator`/`supervisor`/`inUse`/`currentFuelLevel`/`openShift` a
   * cada fila cruda de Prisma. Resuelve los usuarios asignados y los turnos
   * abiertos con UNA consulta batch cada uno (no N+1): junta los ids de toda
   * la lista y arma el mapa de vuelta — mismo patrón que `resolveAssignedUsers`.
   */
  private async withUsageFields<
    T extends {
      id: string;
      currentOperatorId: string | null;
      currentSupervisorId: string | null;
      technicalInspectionExpiry: Date | null;
      insuranceExpiry: Date | null;
      horometros: ReadonlyArray<{ nivelCombustible: number | null }>;
    },
  >(
    equipos: readonly T[],
  ): Promise<Array<Omit<T, 'horometros'> & EquipmentUsageFields>> {
    const [usuariosPorId, turnosAbiertosPorEquipo] = await Promise.all([
      this.resolveAssignedUsers(
        equipos.flatMap((e) => [e.currentOperatorId, e.currentSupervisorId]),
      ),
      this.resolveOpenShifts(equipos.map((e) => e.id)),
    ]);
    return equipos.map((equipo) =>
      this.shapeUsage(equipo, usuariosPorId, turnosAbiertosPorEquipo),
    );
  }

  private shapeUsage<
    T extends {
      id: string;
      currentOperatorId: string | null;
      currentSupervisorId: string | null;
      technicalInspectionExpiry: Date | null;
      insuranceExpiry: Date | null;
      horometros: ReadonlyArray<{ nivelCombustible: number | null }>;
    },
  >(
    equipo: T,
    usuariosPorId: ReadonlyMap<string, AssignedUserSummary>,
    turnosAbiertosPorEquipo: ReadonlyMap<string, OpenShiftSummary>,
  ): Omit<T, 'horometros'> & EquipmentUsageFields {
    const { horometros, currentOperatorId, currentSupervisorId, ...resto } =
      equipo;
    return {
      ...resto,
      currentOperatorId,
      currentSupervisorId,
      operator: currentOperatorId
        ? (usuariosPorId.get(currentOperatorId) ?? null)
        : null,
      supervisor: currentSupervisorId
        ? (usuariosPorId.get(currentSupervisorId) ?? null)
        : null,
      inUse: currentOperatorId != null,
      currentFuelLevel: horometros[0]?.nivelCombustible ?? null,
      openShift: turnosAbiertosPorEquipo.get(equipo.id) ?? null,
      documents: {
        technicalInspection: buildDocumentExpiryInfo(
          equipo.technicalInspectionExpiry,
        ),
        insurance: buildDocumentExpiryInfo(equipo.insuranceExpiry),
      },
    } as Omit<T, 'horometros'> & EquipmentUsageFields;
  }

  /**
   * `{id,name}` de los usuarios asignados, en UNA consulta batch. Devuelve
   * mapa vacío sin consultar si no hay ningún id (caso común: ningún equipo
   * "en uso" en la página). `currentOperatorId`/`currentSupervisorId` son
   * soft refs sin FK (ver `schema.prisma`) — un id sin fila en `user` (dato
   * huérfano) simplemente no aparece en el mapa y `shapeUsage` lo trata como
   * `null`, en vez de reventar la respuesta completa.
   */
  private async resolveAssignedUsers(
    ids: ReadonlyArray<string | null>,
  ): Promise<ReadonlyMap<string, AssignedUserSummary>> {
    const idsUnicos = Array.from(
      new Set(ids.filter((id): id is string => id != null)),
    );
    if (idsUnicos.length === 0) return new Map();

    const usuarios = await this.prisma.user.findMany({
      where: { id: { in: idsUnicos } },
      select: { id: true, name: true },
    });
    return new Map(usuarios.map((u) => [u.id, u]));
  }

  /**
   * `openShift` de cada equipo, en UNA consulta batch (no N+1). No se puede
   * resolver vía `EQUIPMENT_USAGE_INCLUDE` porque Prisma no permite incluir
   * la misma relación (`horometros`) dos veces con `where` distintos en un
   * mismo `include` — por eso va como consulta aparte, igual que
   * `resolveAssignedUsers`. `distinct: ['equipoId']` + `orderBy: { fecha:
   * 'desc' }` hace que Postgres devuelva, por cada equipo, solo su
   * `RegistroHorometro` abierto MÁS RECIENTE (equivalente a `DISTINCT ON`).
   */
  private async resolveOpenShifts(
    equipoIds: readonly string[],
  ): Promise<ReadonlyMap<string, OpenShiftSummary>> {
    const idsUnicos = Array.from(new Set(equipoIds));
    if (idsUnicos.length === 0) return new Map();

    const turnos = await this.prisma.registroHorometro.findMany({
      where: { equipoId: { in: idsUnicos }, valorFinal: null },
      orderBy: { fecha: 'desc' },
      distinct: ['equipoId'],
      select: {
        id: true,
        equipoId: true,
        valorInicial: true,
        operador: true,
        turno: true,
        fecha: true,
      },
    });

    return new Map(
      turnos.map((turno) => [
        turno.equipoId,
        {
          id: turno.id,
          valorInicial: turno.valorInicial,
          operador: turno.operador,
          turno: turno.turno,
          fecha: turno.fecha,
        },
      ]),
    );
  }

  /**
   * Valida, para `updateAssignment`, que el usuario exista y tenga
   * exactamente el rol esperado (OPERADOR para `operatorId`, SUPERVISOR para
   * `supervisorId`) — sin esto, el listado "en uso por" podría mostrar a un
   * ADMIN o MANTENEDOR como si estuviera operando la máquina. Tampoco admite
   * un usuario BANEADO (mismo criterio `banned: { not: true }` que
   * `UsersService.findByRole`, que alimenta el picker): sin este chequeo,
   * un `PATCH :id/assignment` que mande el id directo (sin pasar por el
   * picker) podía asignar a alguien baneado igual.
   */
  private async assertUserWithRole(userId: string, role: Role): Promise<void> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, role: true, banned: true },
    });
    if (!user) {
      throw new BadRequestException(`El usuario "${userId}" no existe`);
    }
    if (user.role !== role) {
      throw new BadRequestException(
        `El usuario "${userId}" no tiene el rol ${role}`,
      );
    }
    if (user.banned) {
      throw new BadRequestException(
        `El usuario "${userId}" está baneado y no puede ser asignado`,
      );
    }
  }

  /**
   * Traduce los errores conocidos de Prisma a excepciones Nest legibles.
   * Sin esto, `create`/`update` re-lanzan el error crudo de Prisma y el
   * filtro global lo convierte en un 500 genérico ("Internal server error"),
   * incluso para errores de INPUT del usuario (código duplicado, sucursal
   * inexistente) que deberían ser 4xx.
   */
  private mapPrismaError(error: unknown, dto: UniqueFieldsDto): unknown {
    if (!(error instanceof Prisma.PrismaClientKnownRequestError)) {
      return error;
    }

    if (error.code === 'P2002') {
      return this.mapUniqueConstraintError(error, dto);
    }

    // FK inválida: hoy la única FK de `Equipment` es `homeBranchId`
    // (`homeBranch`), así que el mensaje puede ser específico sin necesidad
    // de inspeccionar `error.meta` ni hacer un `findUnique` extra de Branch
    // solo para validar su existencia.
    if (error.code === 'P2003') {
      return new BadRequestException('La sucursal indicada no existe');
    }

    return error;
  }

  /**
   * `Equipment` tiene DOS columnas únicas (`internalCode`, `licensePlate`);
   * se inspecciona `meta.target` del error de Prisma para devolver un
   * `ConflictException` específico de cuál chocó, en vez de un genérico.
   */
  private mapUniqueConstraintError(
    error: Prisma.PrismaClientKnownRequestError,
    dto: UniqueFieldsDto,
  ): ConflictException {
    const target = error.meta?.target;
    const targetStr = Array.isArray(target)
      ? target.join(',')
      : typeof target === 'string'
        ? target
        : '';

    if (targetStr.includes('internal_code')) {
      return new ConflictException(
        `Ya existe un equipo con el código "${dto.internalCode}"`,
      );
    }
    if (targetStr.includes('license_plate')) {
      return new ConflictException(
        `Ya existe un equipo con la patente "${dto.licensePlate}"`,
      );
    }
    return new ConflictException(
      'Ya existe un equipo con esos datos únicos (código o patente)',
    );
  }
}
