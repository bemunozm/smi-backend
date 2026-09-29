/**
 * Reporte de salida de turno (RFC Supervisión en Terreno): genera el
 * PDF con pdfmake, lo sube a storage privado y crea la fila `ShiftExitReport`
 * — idempotente por `dto.id` (UUID del cliente), mismo estilo que
 * `ShiftsService.openCard`/`closeCard` (ver el comentario de cabecera de
 * `shifts.service.ts` sobre por qué el P2002 se maneja FUERA de la tx: acá no
 * hay `$transaction` porque el `create` de la fila es la única escritura, así
 * que no hace falta esa coreografía — un P2002 simplemente se atrapa
 * directo).
 */
import {
  ConflictException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Prisma } from '@prisma/client';
import type { UserSession } from '@thallesp/nestjs-better-auth';

import { ROLES, sessionHasRole } from '../auth/roles';
import { PrismaService } from '../common/prisma/prisma.service';
import { DOMAIN_EVENTS } from '../common/events/domain-events';
import type { ShiftExitReportSentEvent } from '../common/events/domain-events';
import { ERROR_CODES } from '../common/errors/error-codes';
import { StorageService } from '../storage/storage.service';
import { assertReasonableCapturedAt } from './capture-time';
import { assertShiftDateWithinWindow, parseDateOnlyUtc } from './date-only';
import { CreateShiftReportDto } from './dto/create-shift-report.dto';
import { renderPdfBuffer } from './pdf/pdf-renderer';
import {
  buildShiftExitReportDocDefinition,
  type ShiftReportCardInput,
} from './pdf/shift-report.pdf';
import {
  SHIFT_EXIT_REPORT_EMAIL_STATUS_INITIAL,
  type ShiftExitReportEmailStatus,
} from './shift-exit-report-email-status';

const CARDS_INCLUDE = {
  equipo: { select: { internalCode: true, type: true } },
} satisfies Prisma.RegistroHorometroInclude;

type CardWithEquipo = Prisma.RegistroHorometroGetPayload<{
  include: typeof CARDS_INCLUDE;
}>;

export interface ShiftReportResponse {
  id: string;
  shiftId: string;
  fileName: string;
  cardCount: number;
  requestedAt: Date;
  createdAt: Date;
  emailStatus: ShiftExitReportEmailStatus;
  /** Ids de `cardIds` que llegaron en la request pero NO se encontraron para
   * este turno (offline: pueden estar encoladas en el outbox del
   * dispositivo). El PDF se genera igual con las que SÍ se encontraron. */
  missingCardIds: string[];
}

/** Adjunto de correo del reporte de salida — `NotificationsListener` lo pide
 * por `reportId` en vez de leer storage directamente: el listener no debe
 * conocer cómo se guarda un `ShiftExitReport`. */
export interface ShiftReportAttachment {
  filename: string;
  content: Buffer;
  contentType: string;
}

// Tope de reportes por turno en una ventana — cada reporte genera un PDF
// (CPU) + sube al bucket + potencialmente
// dispara correos a ADMIN y a los destinatarios externos, así que un loop
// (bug de cliente o abuso deliberado) reenviando el mismo turno sin id
// repetido puede generar un aluvión de PDFs y correos.
export const REPORT_RATE_LIMIT_WINDOW_MS = 10 * 60 * 1000; // 10 minutos
export const REPORT_RATE_LIMIT_MAX_PER_WINDOW = 3;

// El nombre del supervisor (`session.user.name`) viaja sin más validación
// que la de Better Auth hacia el PDF y el asunto/cuerpo del correo — un
// nombre absurdamente largo podría deformar el
// layout del PDF o el asunto del correo. 120 (no un valor más chico): mismo
// tope que `CreateUserDto.name`/`CreateOperatorDto.name`.
const SUPERVISOR_NAME_MAX_LENGTH = 120;

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function buildFileName(shiftDate: string, shiftType: string): string {
  return `reporte-salida-${shiftDate}-${shiftType.toLowerCase()}.pdf`;
}

function truncate(value: string, maxLength: number): string {
  return value.length > maxLength ? value.slice(0, maxLength) : value;
}

@Injectable()
export class ShiftReportsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  async create(
    dto: CreateShiftReportDto,
    session: UserSession,
  ): Promise<ShiftReportResponse> {
    const now = new Date();
    assertReasonableCapturedAt(new Date(dto.requestedAt), now);

    const existing = await this.prisma.shiftExitReport.findUnique({
      where: { id: dto.id },
    });
    if (existing) {
      if (existing.createdById !== session.user.id) {
        throw new ConflictException({
          message: 'Ya existe un reporte con ese id de otro supervisor',
          code: ERROR_CODES.ID_CONFLICT,
        });
      }
      // Reintento de la MISMA request (offline) — se devuelve tal cual, SIN
      // generar un PDF nuevo ni emitir el evento de nuevo, y SIN pasar por
      // la ventana de fechas ni el rate limit de abajo (un replay legítimo
      // puede llegar días después del turno original, o ser el 4to intento
      // del MISMO id tras un 429 — ninguno de los dos debe bloquearlo).
      return this.shape(
        existing,
        await this.computeMissingCardIds(existing.shiftId, dto.cardIds),
      );
    }

    // Ventana razonable de `shiftDate` — DESPUÉS del replay (ver comentario
    // de arriba), sobre una request que SÍ va a crear un reporte nuevo.
    assertShiftDateWithinWindow(dto.shiftDate, now);

    const shift = await this.prisma.shift.findUnique({
      where: {
        supervisorId_date_type: {
          // El turno SIEMPRE es el propio del usuario de la sesión, aun para
          // ADMIN — ver Diseño del RFC Supervisión en Terreno §Reporte
          // ("mantenerlo simple").
          supervisorId: session.user.id,
          date: parseDateOnlyUtc(dto.shiftDate),
          type: dto.shiftType,
        },
      },
    });
    if (!shift) {
      throw new NotFoundException({
        message: 'No hay un turno abierto para esa fecha y tipo',
        code: ERROR_CODES.SHIFT_NOT_FOUND,
      });
    }

    // Tope de reportes NUEVOS por turno en una ventana — DESPUÉS del replay
    // (un reintento del mismo id nunca cuenta ni se limita) y DESPUÉS de
    // resolver el turno (necesita
    // `shift.id`), ANTES de renderizar el PDF (el trabajo caro).
    const recentReportsCount = await this.prisma.shiftExitReport.count({
      where: {
        shiftId: shift.id,
        createdAt: {
          gte: new Date(now.getTime() - REPORT_RATE_LIMIT_WINDOW_MS),
        },
      },
    });
    if (recentReportsCount >= REPORT_RATE_LIMIT_MAX_PER_WINDOW) {
      throw new HttpException(
        {
          message:
            'Demasiados reportes seguidos para este turno. Espera unos minutos.',
          code: ERROR_CODES.REPORT_RATE_LIMITED,
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    const cards = await this.prisma.registroHorometro.findMany({
      where: { id: { in: dto.cardIds }, shiftId: shift.id },
      include: CARDS_INCLUDE,
      orderBy: { equipo: { internalCode: 'asc' } },
    });
    if (cards.length === 0) {
      throw new ConflictException({
        message: 'Ninguna de las tarjetas indicadas pertenece a este turno',
        code: ERROR_CODES.NO_CARDS,
      });
    }

    const foundIds = new Set(cards.map((card) => card.id));
    const missingCardIds = dto.cardIds.filter((id) => !foundIds.has(id));

    // `session.user.name` viaja sin más límite que el de Better Auth hacia
    // el PDF y hacia el asunto/cuerpo del correo (vía el evento de abajo) —
    // se trunca UNA vez acá y se reusa en ambos
    // destinos, en vez de truncar cada uno por separado.
    const supervisorName = truncate(
      session.user.name,
      SUPERVISOR_NAME_MAX_LENGTH,
    );

    const buffer = await renderPdfBuffer(
      buildShiftExitReportDocDefinition({
        shiftDate: dto.shiftDate,
        shiftType: dto.shiftType,
        supervisorName,
        generatedAt: now,
        requestedAt: new Date(dto.requestedAt),
        cards: cards.map((card) => this.toCardInput(card)),
      }),
    );

    const fileName = buildFileName(dto.shiftDate, dto.shiftType);
    const fileKey = await this.storage.putServerFile(
      'shift-exit-report',
      buffer,
      {
        id: dto.id,
        date: now,
      },
    );

    let report;
    try {
      report = await this.prisma.shiftExitReport.create({
        data: {
          id: dto.id,
          shiftId: shift.id,
          fileKey,
          fileName,
          cardCount: cards.length,
          requestedAt: new Date(dto.requestedAt),
          createdById: session.user.id,
          emailStatus: SHIFT_EXIT_REPORT_EMAIL_STATUS_INITIAL,
        },
      });
    } catch (error: unknown) {
      await this.storage.deleteBestEffort(fileKey);

      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        // Carrera: otra request con el MISMO id ya ganó (reintento
        // concurrente, offline). Se relee y se devuelve tal cual, o 409 si
        // resulta ser de otro usuario.
        const race = await this.prisma.shiftExitReport.findUnique({
          where: { id: dto.id },
        });
        if (race && race.createdById === session.user.id) {
          return this.shape(race, missingCardIds);
        }
        throw new ConflictException({
          message: 'Ya existe un reporte con ese id de otro supervisor',
          code: ERROR_CODES.ID_CONFLICT,
        });
      }
      throw error;
    }

    // DESPUÉS del commit — nunca antes (ver Diseño del RFC §Reporte): un
    // fallo del listener (correo/notificación) no debe poder impedir que la
    // fila ya persistida se devuelva al cliente.
    this.eventEmitter.emit(DOMAIN_EVENTS.SHIFT_EXIT_REPORT_SENT, {
      reportId: report.id,
      shiftId: report.shiftId,
      fileKey: report.fileKey,
      fileName: report.fileName,
      cardCount: report.cardCount,
      supervisorName,
      shiftDate: dto.shiftDate,
      shiftType: dto.shiftType,
    } satisfies ShiftExitReportSentEvent);

    return this.shape(report, missingCardIds);
  }

  /**
   * `GET /api/shift-reports/:id/file` — URL firmada RECIÉN generada (mismo
   * patrón que `EquipmentDocumentService.getSignedFileUrl`). ADMIN o el
   * creador del reporte; cualquier otro → 403 `NOT_OWNER`.
   */
  async getSignedFileUrl(id: string, session: UserSession): Promise<string> {
    const report = await this.prisma.shiftExitReport.findUnique({
      where: { id },
    });
    if (!report) {
      throw new NotFoundException('Reporte no encontrado');
    }

    const isAdmin = sessionHasRole(session.user.role, ROLES.ADMIN);
    if (report.createdById !== session.user.id && !isAdmin) {
      throw new ForbiddenException({
        message: 'No puedes descargar el reporte de otro supervisor',
        code: ERROR_CODES.NOT_OWNER,
      });
    }

    return this.storage.sign(report.fileKey, { fileName: report.fileName });
  }

  /**
   * Actualiza `emailStatus`/`notifiedAt` tras procesar `shift.exit-report` —
   * único punto de escritura de esta columna, para que `NotificationsListener`
   * no dependa de Prisma directamente sobre un modelo que no le pertenece.
   * Solo transiciona desde el `'PENDING'` inicial: si el evento se
   * reprocesara (redelivery) no debe pisar un estado terminal ya guardado.
   */
  async markEmailStatus(
    reportId: string,
    status: ShiftExitReportEmailStatus,
  ): Promise<void> {
    await this.prisma.shiftExitReport.updateMany({
      where: {
        id: reportId,
        emailStatus: SHIFT_EXIT_REPORT_EMAIL_STATUS_INITIAL,
      },
      data: { emailStatus: status, notifiedAt: new Date() },
    });
  }

  /**
   * Adjunto de correo del reporte: `NotificationsListener` no inyecta
   * `StorageService` para bajar el PDF — se lo pide a este service, dueño de
   * `ShiftExitReport` y de su `fileKey`.
   */
  async getAttachment(reportId: string): Promise<ShiftReportAttachment> {
    const report = await this.prisma.shiftExitReport.findUnique({
      where: { id: reportId },
    });
    if (!report) {
      throw new NotFoundException('Reporte no encontrado');
    }

    const content = await this.storage.getObjectBuffer(report.fileKey);
    return {
      filename: report.fileName,
      content,
      contentType: 'application/pdf',
    };
  }

  private toCardInput(card: CardWithEquipo): ShiftReportCardInput {
    return {
      equipoInternalCode: card.equipo.internalCode,
      equipoType: card.equipo.type,
      operatorName: card.operador,
      valorInicial: card.valorInicial,
      valorFinal: card.valorFinal,
      horasMaquina:
        card.valorFinal !== null
          ? round2(card.valorFinal - card.valorInicial)
          : null,
      fuelLiters: card.fuelLiters,
      observaciones: card.observaciones,
    };
  }

  private async computeMissingCardIds(
    shiftId: string,
    cardIds: readonly string[],
  ): Promise<string[]> {
    const found = await this.prisma.registroHorometro.findMany({
      where: { id: { in: [...cardIds] }, shiftId },
      select: { id: true },
    });
    const foundIds = new Set(found.map((card) => card.id));
    return cardIds.filter((id) => !foundIds.has(id));
  }

  private shape(
    report: {
      id: string;
      shiftId: string;
      fileName: string;
      cardCount: number;
      requestedAt: Date;
      createdAt: Date;
      emailStatus: string;
    },
    missingCardIds: string[],
  ): ShiftReportResponse {
    return {
      id: report.id,
      shiftId: report.shiftId,
      fileName: report.fileName,
      cardCount: report.cardCount,
      requestedAt: report.requestedAt,
      createdAt: report.createdAt,
      // La columna Prisma es `String` (ver `shift-exit-report-email-status.ts`);
      // este service es el ÚNICO que la escribe (`create`/`markEmailStatus`),
      // siempre con uno de los 4 valores del union, así que el cast es seguro
      // por construcción — no un `any` disfrazado.
      emailStatus: report.emailStatus as ShiftExitReportEmailStatus,
      missingCardIds,
    };
  }
}
