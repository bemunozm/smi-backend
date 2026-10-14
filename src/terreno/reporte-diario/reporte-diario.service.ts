import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { createOrReturn } from '../../common/idempotency/create-or-return';
import { PrismaService } from '../../common/prisma/prisma.service';
import { ChangeLogService } from '../../change-log/change-log.service';
import {
  CreateReporteDiarioDto,
  SECCIONES,
} from './dto/create-reporte-diario.dto';

/**
 * Relación que toda lectura/escritura devuelve — una sola forma para que el
 * outbox offline pueda insertar la respuesta del create en la misma caché del
 * listado (mismo criterio que `TRABAJO_EXTRA_INCLUDE`).
 */
export const REPORTE_INCLUDE = {
  produccion: true,
  tolvas: { orderBy: { tolva: 'asc' } },
  plantas: { include: { planta: { select: { nombre: true } } } },
  traspasos: true,
  empresas: { include: { empresa: { select: { nombre: true } } } },
  personal: { orderBy: { orden: 'asc' } },
} satisfies Prisma.ReporteDiarioInclude;

/** Un reporte tal como sale a la API: sin `createdById`. */
export type ReporteDiarioResponse = Omit<
  Prisma.ReporteDiarioGetPayload<{ include: typeof REPORTE_INCLUDE }>,
  'createdById'
>;

const esP2002 = (e: unknown) =>
  typeof e === 'object' && e !== null && (e as { code?: string }).code === 'P2002';

@Injectable()
export class ReporteDiarioService {
  constructor(
    private prisma: PrismaService,
    private changeLog: ChangeLogService,
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

    const fecha = new Date(dto.fecha);
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
          empresas: { create: dto.empresaIds.map((empresaId) => ({ empresaId })) },
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
