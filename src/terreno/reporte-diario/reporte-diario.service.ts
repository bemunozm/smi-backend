import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Prisma } from '@prisma/client';

import { createOrReturn } from '../../common/idempotency/create-or-return';
import { PrismaService } from '../../common/prisma/prisma.service';
import { DOMAIN_EVENTS } from '../../common/events/domain-events';
import type { RecordEditedEvent } from '../../common/events/domain-events';
import { parseDateOnlyUtc } from '../../shifts/date-only';
import {
  ChangeLogService,
  diffFields,
  type ComparableField,
  type Editor,
} from '../../change-log/change-log.service';
import {
  CreateReporteDiarioDto,
  SECCIONES,
  SECCION_LABEL,
  TRASPASO_LABEL,
} from './dto/create-reporte-diario.dto';
import { UpdateReporteDiarioDto } from './dto/update-reporte-diario.dto';
import { FindReportesQueryDto } from './dto/find-reportes-query.dto';

/**
 * Relación que toda lectura/escritura devuelve — una sola forma para que el
 * outbox offline pueda insertar la respuesta del create en la misma caché del
 * listado (mismo criterio que `TRABAJO_EXTRA_INCLUDE`).
 */
export const REPORTE_INCLUDE = {
  produccion: true,
  tolvas: { orderBy: { tolva: 'asc' } },
  plantas: {
    include: { planta: { select: { nombre: true } } },
    orderBy: { planta: { nombre: 'asc' } },
  },
  traspasos: { orderBy: { tipo: 'asc' } },
  empresas: {
    include: { empresa: { select: { nombre: true } } },
    orderBy: { empresa: { nombre: 'asc' } },
  },
  personal: { orderBy: { orden: 'asc' } },
} satisfies Prisma.ReporteDiarioInclude;

/** Un reporte tal como sale a la API: sin `createdById`. */
export type ReporteDiarioResponse = Omit<
  Prisma.ReporteDiarioGetPayload<{ include: typeof REPORTE_INCLUDE }>,
  'createdById'
>;

const esP2002 = (e: unknown) =>
  typeof e === 'object' &&
  e !== null &&
  (e as { code?: string }).code === 'P2002';

/** Cada bloque comparado como UNA línea legible: así el historial de cambios
 * dice «Camiones: … → …» en vez de un JSON. */
type ResumenReporte = {
  produccion: string;
  tolvas: string;
  plantas: string;
  traspasos: string;
  empresas: string;
  personal: string;
  observaciones: string;
};

const VACIO = '—';

function resumir(r: {
  produccion: { seccion: string; camiones: number; vueltasPorCamion: number }[];
  tolvas: { tolva: number; cargas: number }[];
  plantas: { producto: string; planta: { nombre: string } }[];
  traspasos: { tipo: string; cantidad: number }[];
  empresas: { empresa: { nombre: string } }[];
  personal: { rol: string; nombre: string }[];
  observaciones: string | null;
}): ResumenReporte {
  const porSeccion = new Map(r.produccion.map((p) => [p.seccion, p]));
  return {
    produccion: SECCIONES.map((s) => {
      const p = porSeccion.get(s);
      return p
        ? `${SECCION_LABEL[s]} ${p.camiones}×${p.vueltasPorCamion}`
        : `${SECCION_LABEL[s]} ${VACIO}`;
    }).join(' · '),
    tolvas:
      r.tolvas.map((t) => `Tolva ${t.tolva}: ${t.cargas}`).join(' · ') || VACIO,
    plantas:
      r.plantas.map((p) => `${p.planta.nombre}: ${p.producto}`).join(' · ') ||
      VACIO,
    traspasos:
      r.traspasos
        .map((t) => `${TRASPASO_LABEL[t.tipo]}: ${t.cantidad}`)
        .join(' · ') || VACIO,
    empresas: r.empresas.map((e) => e.empresa.nombre).join(', ') || VACIO,
    personal:
      r.personal.map((p) => `${p.rol}: ${p.nombre}`).join(' · ') || VACIO,
    observaciones: r.observaciones ?? VACIO,
  };
}

const CAMPOS_REPORTE: readonly ComparableField<ResumenReporte>[] = [
  { field: 'produccion', label: 'Camiones' },
  { field: 'tolvas', label: 'Alimentación PPE' },
  { field: 'plantas', label: 'Plantas' },
  { field: 'traspasos', label: 'Traspasos' },
  { field: 'empresas', label: 'Empresas externas' },
  { field: 'personal', label: 'Personal del turno' },
  { field: 'observaciones', label: 'Observaciones' },
];

@Injectable()
export class ReporteDiarioService {
  constructor(
    private prisma: PrismaService,
    private changeLog: ChangeLogService,
    private eventEmitter: EventEmitter2,
  ) {}

  async create(
    dto: CreateReporteDiarioDto,
    userId: string,
    userName: string,
  ): Promise<ReporteDiarioResponse> {
    // La búsqueda por id va PRIMERO: un reintento offline devuelve la fila ya
    // creada aunque el estado del mundo haya cambiado desde entonces.
    return createOrReturn({
      id: dto.id,
      userId,
      conflictMessage: 'Ya existe un reporte con ese id de otro usuario',
      findExisting: async (id) => {
        const owner = await this.prisma.reporteDiario.findUnique({
          where: { id },
          select: { createdById: true },
        });
        if (!owner) return null;
        return {
          ownerId: owner.createdById,
          result: () => this.findOne(id),
        };
      },
      create: () => this.createFresh(dto, userId, userName),
    });
  }

  private async createFresh(
    dto: CreateReporteDiarioDto,
    userId: string,
    userName: string,
  ): Promise<ReporteDiarioResponse> {
    this.validarBloques(dto);
    await this.validarCatalogos(dto);

    const fecha = parseDateOnlyUtc(dto.fecha);
    const ocupado = await this.prisma.reporteDiario.findUnique({
      where: { fecha_turno: { fecha, turno: dto.turno } },
      select: { id: true },
    });
    if (ocupado) {
      throw new ConflictException(
        `Ya existe el reporte del turno ${dto.turno} del ${dto.fecha}.`,
      );
    }

    try {
      const creado = await this.prisma.reporteDiario.create({
        data: {
          ...(dto.id ? { id: dto.id } : {}),
          fecha,
          turno: dto.turno,
          supervisorId: userId,
          supervisorNombre: userName,
          createdById: userId,
          observaciones: dto.observaciones?.trim() || null,
          produccion: { create: dto.produccion },
          tolvas: { create: dto.tolvas },
          plantas: { create: dto.plantas },
          traspasos: { create: dto.traspasos },
          empresas: {
            create: dto.empresaIds.map((empresaId) => ({ empresaId })),
          },
          personal: {
            create: dto.personal.map((p, orden) => ({ ...p, orden })),
          },
        },
        include: REPORTE_INCLUDE,
      });
      return this.sinCreatedById(creado);
    } catch (e) {
      // Carrera: dos envíos del mismo turno pasaron el chequeo previo a la vez.
      if (esP2002(e)) {
        throw new ConflictException(
          `Ya existe el reporte del turno ${dto.turno} del ${dto.fecha}.`,
        );
      }
      throw e;
    }
  }

  async findOne(id: string): Promise<ReporteDiarioResponse> {
    const reporte = await this.prisma.reporteDiario.findUnique({
      where: { id },
      include: REPORTE_INCLUDE,
    });
    if (!reporte) throw new NotFoundException('Reporte no encontrado');
    return this.sinCreatedById(reporte);
  }

  async findAll(query: FindReportesQueryDto): Promise<ReporteDiarioResponse[]> {
    const fecha =
      query.desde || query.hasta
        ? {
            ...(query.desde ? { gte: parseDateOnlyUtc(query.desde) } : {}),
            ...(query.hasta ? { lte: parseDateOnlyUtc(query.hasta) } : {}),
          }
        : undefined;
    const filas = await this.prisma.reporteDiario.findMany({
      where: {
        ...(fecha ? { fecha } : {}),
        ...(query.turno ? { turno: query.turno } : {}),
      },
      orderBy: [{ fecha: 'desc' }, { turno: 'asc' }],
      include: REPORTE_INCLUDE,
    });
    return filas.map((reporte) => this.sinCreatedById(reporte));
  }

  async update(
    id: string,
    dto: UpdateReporteDiarioDto,
    editor: Editor,
  ): Promise<ReporteDiarioResponse> {
    this.validarBloques({
      produccion: dto.produccion ?? SECCIONES.map((seccion) => ({ seccion })),
      tolvas: dto.tolvas ?? [],
      plantas: dto.plantas ?? [],
      traspasos: dto.traspasos ?? [],
      empresaIds: dto.empresaIds ?? [],
    });
    await this.validarCatalogos({
      plantas: dto.plantas ?? [],
      empresaIds: dto.empresaIds ?? [],
    });

    const { reporte, diff, fecha, turno } = await this.prisma.$transaction(
      async (tx) => {
        const antes = await tx.reporteDiario.findUnique({
          where: { id },
          include: REPORTE_INCLUDE,
        });
        if (!antes) throw new NotFoundException('Reporte no encontrado');

        if (dto.produccion) {
          await tx.produccionTurno.deleteMany({ where: { reporteId: id } });
          await tx.produccionTurno.createMany({
            data: dto.produccion.map((p) => ({ ...p, reporteId: id })),
          });
        }
        if (dto.tolvas) {
          await tx.reporteTolva.deleteMany({ where: { reporteId: id } });
          await tx.reporteTolva.createMany({
            data: dto.tolvas.map((t) => ({ ...t, reporteId: id })),
          });
        }
        if (dto.plantas) {
          await tx.reportePlanta.deleteMany({ where: { reporteId: id } });
          await tx.reportePlanta.createMany({
            data: dto.plantas.map((p) => ({ ...p, reporteId: id })),
          });
        }
        if (dto.traspasos) {
          await tx.reporteTraspaso.deleteMany({ where: { reporteId: id } });
          await tx.reporteTraspaso.createMany({
            data: dto.traspasos.map((t) => ({ ...t, reporteId: id })),
          });
        }
        if (dto.empresaIds) {
          await tx.reporteEmpresa.deleteMany({ where: { reporteId: id } });
          await tx.reporteEmpresa.createMany({
            data: dto.empresaIds.map((empresaId) => ({
              empresaId,
              reporteId: id,
            })),
          });
        }
        if (dto.personal) {
          await tx.reporteDiarioPersonal.deleteMany({
            where: { reporteId: id },
          });
          await tx.reporteDiarioPersonal.createMany({
            data: dto.personal.map((p, orden) => ({
              ...p,
              orden,
              reporteId: id,
            })),
          });
        }
        if (dto.observaciones !== undefined) {
          await tx.reporteDiario.update({
            where: { id },
            data: { observaciones: dto.observaciones.trim() || null },
          });
        }

        const despues = await tx.reporteDiario.findUnique({
          where: { id },
          include: REPORTE_INCLUDE,
        });
        if (!despues) throw new NotFoundException('Reporte no encontrado');

        const diff = diffFields<ResumenReporte>(
          resumir(antes),
          resumir(despues),
          CAMPOS_REPORTE,
        );
        if (diff.length > 0) {
          // Un cambio solo de bloques no toca la fila padre: se marca para que
          // `updatedAt` refleje la corrección.
          await tx.reporteDiario.update({
            where: { id },
            data: { updatedAt: new Date() },
          });
          await this.changeLog.record(tx, 'reporte_diario', id, editor, diff);
        }
        return {
          reporte: this.sinCreatedById(despues),
          diff,
          fecha: despues.fecha,
          turno: despues.turno,
        };
      },
    );

    if (diff.length > 0) {
      this.eventEmitter.emit(DOMAIN_EVENTS.RECORD_EDITED, {
        entity: 'reporte_diario',
        entityId: id,
        entityArticle: 'el',
        // `fecha` es @db.Date (UTC medianoche): se formatea en UTC para no
        // retroceder un día al convertir a la zona de negocio.
        entityLabel: `reporte diario del ${fecha.toLocaleDateString('es-CL', { timeZone: 'UTC' })} (${turno})`,
        editedBy: editor.name,
        changes: diff.map(({ label, before, after }) => ({
          label,
          before,
          after,
        })),
      } satisfies RecordEditedEvent);
    }
    return reporte;
  }

  /** Los cambios de un reporte, del más reciente al más viejo. */
  findChanges(id: string) {
    return this.changeLog.findFor('reporte_diario', id);
  }

  /** El tipo ya lo omite, pero Prisma devuelve la columna: se quita en runtime. */
  private sinCreatedById<T extends { createdById: string }>(
    reporte: T,
  ): Omit<T, 'createdById'> {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { createdById: _omitido, ...resto } = reporte;
    return resto;
  }

  /** Reglas internas de los bloques; lo que el DTO no puede expresar. */
  private validarBloques(dto: {
    produccion: { seccion: string }[];
    tolvas: { tolva: number }[];
    plantas: { plantaId: string }[];
    traspasos: { tipo: string }[];
    empresaIds: string[];
  }): void {
    const secciones = new Set(dto.produccion.map((p) => p.seccion));
    if (secciones.size !== SECCIONES.length) {
      throw new BadRequestException(
        'El reporte debe traer las 3 secciones de camiones, sin repetir.',
      );
    }
    const repetido = <T>(xs: T[]) => new Set(xs).size !== xs.length;
    if (repetido(dto.tolvas.map((t) => t.tolva))) {
      throw new BadRequestException('Hay una tolva repetida en el reporte.');
    }
    if (repetido(dto.plantas.map((p) => p.plantaId))) {
      throw new BadRequestException('Hay una planta repetida en el reporte.');
    }
    if (repetido(dto.traspasos.map((t) => t.tipo))) {
      throw new BadRequestException('Hay un traspaso repetido en el reporte.');
    }
    if (repetido(dto.empresaIds)) {
      throw new BadRequestException('Hay una empresa repetida en el reporte.');
    }
  }

  /** Las plantas y empresas referidas deben existir y estar activas. */
  private async validarCatalogos(dto: {
    plantas: { plantaId: string }[];
    empresaIds: string[];
  }): Promise<void> {
    const plantaIds = dto.plantas.map((p) => p.plantaId);
    if (plantaIds.length > 0) {
      const activas = await this.prisma.planta.findMany({
        where: { id: { in: plantaIds }, activa: true },
        select: { id: true },
      });
      if (activas.length !== plantaIds.length) {
        throw new BadRequestException(
          'Hay una planta que no existe o está inactiva.',
        );
      }
    }
    if (dto.empresaIds.length > 0) {
      const activas = await this.prisma.empresaExterna.findMany({
        where: { id: { in: dto.empresaIds }, activa: true },
        select: { id: true },
      });
      if (activas.length !== dto.empresaIds.length) {
        throw new BadRequestException(
          'Hay una empresa que no existe o está inactiva.',
        );
      }
    }
  }
}
