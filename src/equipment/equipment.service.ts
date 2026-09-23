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
import { buildDocumentExpiryInfo } from './document-expiry';
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
  /**
   * Estado MÁS URGENTE entre los `EquipmentDocument` del equipo que tienen
   * `expiryDate` cargado (VENCIDO gana sobre POR_VENCER); `null` si ninguno
   * está vencido o por vencer (incluye el caso sin documentos). Alimenta el
   * badge del listado — el detalle completo de documentos se sirve por
   * `GET /api/equipment/:equipmentId/documents` (`EquipmentDocumentController`),
   * no acá, para no inflar la respuesta de la lista de equipos.
   */
  documentsAlert: DocumentsAlert;
}

export type DocumentsAlert = 'VENCIDO' | 'POR_VENCER' | null;

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
   * registros de terreno, movimientos de inventario o documentos (RT, seguro,
   * permisos, certificaciones) es parte de la trazabilidad del sistema y se
   * retira con `status = OUT_OF_SERVICE`, no borrándolo. `documents` cuenta acá
   * porque su FK tiene `onDelete: Cascade`: sin este guard, un equipo con solo
   * documentos se borraría en silencio junto con sus archivos adjuntos.
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
            documents: true,
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
      equipment._count.stockMovements +
      equipment._count.documents;

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
   * Agrega `operator`/`supervisor`/`inUse`/`currentFuelLevel`/`openShift`/
   * `documentsAlert` a cada fila cruda de Prisma. Resuelve los usuarios
   * asignados, los turnos abiertos y la alerta de documentos con UNA consulta
   * batch cada uno (no N+1): junta los ids de toda la lista y arma el mapa de
   * vuelta — mismo patrón que `resolveAssignedUsers`.
   */
  private async withUsageFields<
    T extends {
      id: string;
      currentOperatorId: string | null;
      currentSupervisorId: string | null;
      horometros: ReadonlyArray<{ nivelCombustible: number | null }>;
    },
  >(
    equipos: readonly T[],
  ): Promise<Array<Omit<T, 'horometros'> & EquipmentUsageFields>> {
    const [usuariosPorId, turnosAbiertosPorEquipo, alertasPorEquipo] =
      await Promise.all([
        this.resolveAssignedUsers(
          equipos.flatMap((e) => [e.currentOperatorId, e.currentSupervisorId]),
        ),
        this.resolveOpenShifts(equipos.map((e) => e.id)),
        this.resolveDocumentsAlerts(equipos.map((e) => e.id)),
      ]);
    return equipos.map((equipo) =>
      this.shapeUsage(
        equipo,
        usuariosPorId,
        turnosAbiertosPorEquipo,
        alertasPorEquipo,
      ),
    );
  }

  private shapeUsage<
    T extends {
      id: string;
      currentOperatorId: string | null;
      currentSupervisorId: string | null;
      horometros: ReadonlyArray<{ nivelCombustible: number | null }>;
    },
  >(
    equipo: T,
    usuariosPorId: ReadonlyMap<string, AssignedUserSummary>,
    turnosAbiertosPorEquipo: ReadonlyMap<string, OpenShiftSummary>,
    alertasPorEquipo: ReadonlyMap<string, DocumentsAlert>,
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
      documentsAlert: alertasPorEquipo.get(equipo.id) ?? null,
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
   * `documentsAlert` de cada equipo, en UNA consulta batch (no N+1) — mismo
   * patrón que `resolveOpenShifts`. Trae solo `equipmentId`/`expiryDate` de
   * los `EquipmentDocument` CON `expiryDate` cargado (el resto no puede
   * generar alerta) y se queda, por equipo, con el estado más urgente
   * (VENCIDO > POR_VENCER); un equipo sin documentos vencidos/por vencer
   * simplemente no entra en el mapa y `shapeUsage` lo trata como `null`.
   */
  private async resolveDocumentsAlerts(
    equipoIds: readonly string[],
  ): Promise<ReadonlyMap<string, DocumentsAlert>> {
    const idsUnicos = Array.from(new Set(equipoIds));
    if (idsUnicos.length === 0) return new Map();

    const documentos = await this.prisma.equipmentDocument.findMany({
      where: { equipmentId: { in: idsUnicos }, expiryDate: { not: null } },
      select: { equipmentId: true, expiryDate: true },
    });

    const alertas = new Map<string, DocumentsAlert>();
    for (const documento of documentos) {
      const { status } = buildDocumentExpiryInfo(documento.expiryDate);
      if (status !== 'VENCIDO' && status !== 'POR_VENCER') continue;

      // VENCIDO ya es la urgencia máxima: si el equipo ya tiene una alerta
      // VENCIDO registrada, ningún otro documento puede subirla más.
      if (alertas.get(documento.equipmentId) === 'VENCIDO') continue;

      alertas.set(documento.equipmentId, status);
    }

    return alertas;
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
