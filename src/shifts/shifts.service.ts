/**
 * Supervisión en Terreno, Módulo A. La "tarjeta de
 * turno" es `RegistroHorometro` reutilizado (ver comentario de cabecera del
 * modelo en `schema.prisma`) — este servicio NO es un dominio nuevo de datos,
 * es un segundo flujo (abrir/cerrar en dos pasos, con id de cliente e
 * idempotencia) sobre la misma tabla que ya usa Flota.
 *
 * Contrato de idempotencia (léase esto antes de tocar `openCard`/`closeCard`):
 * un choque de constraint (P2002) dentro de un `$transaction` interactivo deja
 * la transacción de Postgres en estado ABORTADO — cualquier SELECT/UPDATE
 * posterior EN LA MISMA tx falla con "current transaction is aborted,
 * commands ignored until end of transaction block", enmascarando el error
 * real. Por eso el patrón acá es: si el `create`/`updateMany` que puede
 * chocar contra un índice único lanza P2002, se relanza un marcador propio
 * SIN hacer ninguna otra consulta dentro de esa tx, y recién AFUERA (tras el
 * rollback automático) se relee el estado real para decidir 200 (mío, ya
 * existe) vs 409 (de otro).
 */
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { ControlUnit, EquipmentStatus, Prisma } from '@prisma/client';
import type { UserSession } from '@thallesp/nestjs-better-auth';

import { ROLES, sessionHasRole } from '../auth/roles';
import { PrismaService } from '../common/prisma/prisma.service';
import { ERROR_CODES } from '../common/errors/error-codes';
import { assertExpectedLocked } from '../common/concurrency/assert-expected-locked';
import { type ExpectedValues } from '../common/concurrency/expected-fields';
import { resolveCloseRace } from '../common/idempotency/resolve-close-race';
import { DOMAIN_EVENTS } from '../common/events/domain-events';
import type { RecordEditedEvent } from '../common/events/domain-events';
import {
  ChangeLogService,
  diffFields,
  type Editor,
} from '../change-log/change-log.service';
import { toEditor } from '../change-log/current-editor.decorator';
import { OperatorsService } from '../operators/operators.service';
import { StorageService } from '../storage/storage.service';
import { reconcileEquipmentCounter } from '../equipment/equipment-counter';
import { formatBusinessDate } from '../common/dates/business-time';
import {
  computeClientClockSkewMs,
  resolveCapturedAt,
  resolveCapturedAtWithFallback,
} from '../common/dates/capture-time';
import {
  assertShiftDateWithinWindow,
  formatDateOnly,
  parseDateOnlyUtc,
} from './date-only';
import { adBlueError } from './adblue';
import { CloseShiftCardDto } from './dto/close-shift-card.dto';
import { UpdateShiftCardDto } from './dto/update-shift-card.dto';
import { OpenShiftCardDto } from './dto/open-shift-card.dto';
import { QueryShiftDto } from './dto/query-shift.dto';
import type { ShiftExitReportEmailStatus } from './shift-exit-report-email-status';

// El tipo de combustible por defecto del cierre de tarjeta está PENDIENTE de
// confirmar con el cliente. Nombrado como constante (no hardcodeado inline)
// para que ese ajuste, cuando llegue, sea un cambio de una línea.
export const DEFAULT_SHIFT_CLOSE_FUEL_TYPE = 'PETROLEO';

/** Ventana de "mis tarjetas" (URL estable, sin query params de
 * fecha, para que el front la pueda cachear offline) — abiertas + cerradas en
 * las últimas 48 h. */
const MINE_CLOSED_WINDOW_MS = 48 * 60 * 60 * 1000;

/** Marcador interno — NUNCA cruza el límite del service (ver comentario de
 * cabecera). Distingue "el `create` chocó contra un índice único" de
 * cualquier otro error dentro de `openCard`'s tx. */
class ShiftCardIdRaceError extends Error {}
/** Mismo criterio que `ShiftCardIdRaceError`, para `closeCard`'s tx. */
class ShiftCardCloseRaceError extends Error {}

const SHIFT_CARD_INCLUDE = {
  equipo: { select: { internalCode: true, type: true, controlUnit: true } },
  shift: {
    include: {
      exitReports: {
        select: {
          id: true,
          requestedAt: true,
          cardCount: true,
          emailStatus: true,
        },
      },
    },
  },
} satisfies Prisma.RegistroHorometroInclude;

type ShiftCardRecord = Prisma.RegistroHorometroGetPayload<{
  include: typeof SHIFT_CARD_INCLUDE;
}>;

export interface ShiftCardExitReportResponse {
  id: string;
  requestedAt: Date;
  cardCount: number;
  emailStatus: ShiftExitReportEmailStatus;
}

/**
 * Forma pública de una tarjeta de turno — la MISMA en `open`, `close` y
 * `mine` (decisión de diseño: un solo shape que el front maneja en los tres
 * casos, en vez de tres contratos parecidos-pero-no-iguales). NUNCA expone
 * `pumpPhotoKey`/`closeClientId` (keys crudas de storage / clave de
 * idempotencia interna).
 */
export interface ShiftCardResponse {
  id: string;
  equipoId: string;
  equipo: { internalCode: string; type: string; controlUnit: ControlUnit };
  operatorId: string | null;
  /** Snapshot de texto (`RegistroHorometro.operador`) — se mantiene aunque el
   * operador del catálogo se renombre o desactive después. */
  operatorName: string;
  supervisorId: string | null;
  supervisorName: string | null;
  shift: {
    id: string;
    date: string;
    type: string;
    exitReports: ShiftCardExitReportResponse[];
  } | null;
  valorInicial: number;
  valorFinal: number | null;
  /** `valorFinal − valorInicial`, `null` si la tarjeta sigue abierta. */
  horasMaquina: number | null;
  fuelLiters: number | null;
  /** URL FIRMADA (`StorageService.sign`), nunca la key cruda. `null` si la
   * tarjeta no tiene foto (sigue abierta, o se cerró sin `fuelLiters`... la
   * foto es obligatoria igual, pero el campo puede faltar en datos legacy). */
  pumpPhotoUrl: string | null;
  observaciones: string | null;
  adBlue: boolean;
  adBlueLiters: number | null;
  belowPreviousReading: boolean;
  fecha: Date;
  fechaSalida: Date | null;
  createdAt: Date;
  closedAt: Date | null;
}

export interface ShiftCardSummaryResponse {
  id: string;
  equipoId: string;
  equipo: { internalCode: string; type: string; controlUnit: ControlUnit };
  operatorId: string | null;
  operatorName: string;
  valorInicial: number;
  valorFinal: number | null;
  horasMaquina: number | null;
  fecha: Date;
  fechaSalida: Date | null;
}

export interface ShiftWithCardsResponse {
  id: string;
  date: string;
  type: string;
  supervisorId: string;
  cards: ShiftCardSummaryResponse[];
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/** Los datos de una tarjeta que se pueden corregir. */
type DatosTarjeta = {
  operatorId: string | null;
  valorInicial: number;
  valorFinal: number | null;
  fuelLiters: number | null;
  adBlue: boolean;
  adBlueLiters: number | null;
  observaciones: string | null;
};

/** Cómo se llama cada dato en el aviso, el historial y el mensaje de conflicto. */
const CAMPO_LABEL: Record<keyof DatosTarjeta, string> = {
  operatorId: 'Operador',
  valorInicial: 'Lectura inicial',
  valorFinal: 'Lectura final',
  fuelLiters: 'Litros de combustible',
  adBlue: 'AdBlue',
  adBlueLiters: 'Litros de AdBlue',
  observaciones: 'Observaciones',
};

/** Campos que solo existen una vez cerrada la tarjeta. */
const CAMPOS_DE_CIERRE = [
  'valorFinal',
  'fuelLiters',
  'adBlue',
  'adBlueLiters',
] as const satisfies readonly (keyof UpdateShiftCardDto)[];

/** Solo los campos de la tarjeta que admiten precondición `X-Expected`. */
function datosDeTarjeta(card: DatosTarjeta): DatosTarjeta {
  return {
    operatorId: card.operatorId,
    valorInicial: card.valorInicial,
    valorFinal: card.valorFinal,
    fuelLiters: card.fuelLiters,
    adBlue: card.adBlue,
    adBlueLiters: card.adBlueLiters,
    observaciones: card.observaciones,
  };
}

/** Los datos de la tarjeta tal como quedarían después de aplicar el body. */
function mezclarTarjeta(
  actual: DatosTarjeta,
  dto: UpdateShiftCardDto,
  operador: { id: string } | null,
): DatosTarjeta {
  const adBlue = dto.adBlue ?? actual.adBlue;
  return {
    operatorId: operador?.id ?? actual.operatorId,
    valorInicial: dto.valorInicial ?? actual.valorInicial,
    valorFinal: dto.valorFinal ?? actual.valorFinal,
    fuelLiters: dto.fuelLiters ?? actual.fuelLiters,
    adBlue,
    // Quitar el AdBlue sin decir los litros los limpia; con AdBlue se
    // conservan salvo que el body los cambie.
    adBlueLiters:
      dto.adBlueLiters !== undefined
        ? dto.adBlueLiters
        : adBlue
          ? actual.adBlueLiters
          : null,
    observaciones:
      dto.observaciones !== undefined
        ? dto.observaciones?.trim() || null
        : actual.observaciones,
  };
}

/** `DD-MM-YYYY` de una fecha de calendario (`Shift.date`, medianoche UTC). */
function formatDateOnlyForHumans(date: Date): string {
  const [year, month, day] = formatDateOnly(date).split('-');
  return `${day}-${month}-${year}`;
}

/** Resultado de una edición dentro de la transacción. */
interface ShiftCardEdit {
  card: ShiftCardRecord;
  /** `null` si no cambió nada: no hubo escritura ni corresponde avisar. */
  event: RecordEditedEvent | null;
}

@Injectable()
export class ShiftsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    private readonly operators: OperatorsService,
    private readonly changeLog: ChangeLogService,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  /**
   * `POST /api/shift-cards` — abre una tarjeta de turno. Idempotente por
   * `dto.id` (UUID del cliente): reintentar la MISMA request (mismo id,
   * mismo supervisor, mismo equipo) devuelve la tarjeta ya creada en vez de
   * fallar o duplicar.
   */
  async openCard(
    dto: OpenShiftCardDto,
    session: UserSession,
    clientTimeHeader?: string,
  ): Promise<ShiftCardResponse> {
    const now = new Date();
    // La hora del dispositivo nunca rechaza la apertura: fuera de ventana se
    // usa la del servidor y el desfase queda auditado.
    const { at: capturedAt, discardedSkewMs } = resolveCapturedAt(
      dto.capturedAt,
      now,
    );
    // Ventana razonable de `shiftDate` — antes de tocar cualquier estado
    // (ni el operador, ni menos el `Shift`, que sí escribe).
    assertShiftDateWithinWindow(dto.shiftDate, now);
    const clientClockSkewMs =
      computeClientClockSkewMs(clientTimeHeader, now) ?? discardedSkewMs;

    // Precondición pura de la request — antes de tocar el equipo/turno.
    const operator = await this.operators.assertActive(dto.operatorId);

    // Lectura del equipo ANTES del upsert del `Shift` (que sí escribe) —
    // así una request con un `equipoId` que no existe, o un equipo fuera de
    // servicio, no alcanza a crear un
    // `Shift` para una fecha arbitraria. El chequeo DENTRO de la tx (más
    // abajo) se mantiene igual — repetido a propósito: cierra la ventana de
    // carrera contra un cambio de estado concurrente del equipo; este
    // pre-check es solo un fast-path de solo lectura.
    const equipoPrecheck = await this.prisma.equipment.findUnique({
      where: { id: dto.equipoId },
      select: { status: true },
    });
    if (!equipoPrecheck) throw new NotFoundException('Equipo no encontrado');
    if (equipoPrecheck.status !== EquipmentStatus.OPERATIONAL) {
      throw new ConflictException({
        message: 'El equipo no está operativo',
        code: ERROR_CODES.EQUIPMENT_NOT_OPERATIONAL,
      });
    }

    const supervisorId = session.user.id;

    // Upsert del `Shift` por clave natural (supervisorId, date, type) FUERA
    // de la transacción de la tarjeta: el turno es un recurso
    // compartido entre tarjetas (y con el Módulo B) — no debe
    // depender de que ESTA tarjeta específica llegue a crearse.
    const shift = await this.upsertShift(
      supervisorId,
      dto.shiftDate,
      dto.shiftType,
    );

    try {
      const card = await this.prisma.$transaction(async (tx) => {
        const existing = await tx.registroHorometro.findUnique({
          where: { id: dto.id },
          include: SHIFT_CARD_INCLUDE,
        });
        if (existing) {
          if (
            existing.supervisorId === supervisorId &&
            existing.equipoId === dto.equipoId
          ) {
            // Reintento de la MISMA request (offline, red que cayó justo
            // después de que el servidor ya había creado la tarjeta) — se
            // devuelve tal cual, incluso si ya se cerró entre medio.
            return existing;
          }
          throw new ConflictException({
            message:
              'Ya existe una tarjeta con ese id para otro equipo o supervisor',
            code: ERROR_CODES.ID_CONFLICT,
          });
        }

        const equipo = await tx.equipment.findUnique({
          where: { id: dto.equipoId },
          select: {
            status: true,
            controlUnit: true,
            currentHourmeter: true,
            currentMileage: true,
          },
        });
        if (!equipo) throw new NotFoundException('Equipo no encontrado');

        // Un equipo fuera de servicio o en taller no puede abrir turno.
        if (equipo.status !== EquipmentStatus.OPERATIONAL) {
          throw new ConflictException({
            message: 'El equipo no está operativo',
            code: ERROR_CODES.EQUIPMENT_NOT_OPERATIONAL,
          });
        }

        // Fast-path aplicativo — la garantía dura es el índice único parcial
        // `(equipo_id) WHERE "valorFinal" IS NULL` (mismo índice que usa
        // Flota, ver migración `..._horometro_open_turno_unique_index`): si
        // el `create` de abajo choca contra él bajo una carrera, se traduce
        // el P2002 más abajo.
        const abierta = await tx.registroHorometro.findFirst({
          where: { equipoId: dto.equipoId, valorFinal: null },
          select: { supervisorId: true, fecha: true },
        });
        if (abierta) {
          const supervisorName = await this.resolveSupervisorName(
            tx,
            abierta.supervisorId,
          );
          throw new ConflictException({
            message: this.buildBusyMessage(supervisorName, abierta.fecha),
            code: ERROR_CODES.EQUIPMENT_BUSY,
          });
        }

        // Modo `'warn'` (exclusivo de la apertura de tarjeta):
        // una lectura menor que la vigente NO se rechaza ni mueve el
        // contador — se marca `belowPreviousReading` para auditoría.
        const { belowPrevious } = await reconcileEquipmentCounter(
          tx,
          dto.equipoId,
          equipo,
          dto.valorInicial,
          'warn',
        );

        try {
          return await tx.registroHorometro.create({
            data: {
              id: dto.id,
              equipoId: dto.equipoId,
              valorInicial: dto.valorInicial,
              turno: dto.shiftType,
              operador: operator.name,
              operatorId: operator.id,
              supervisorId,
              shiftId: shift.id,
              fecha: capturedAt,
              clientClockSkewMs: clientClockSkewMs ?? null,
              belowPreviousReading: belowPrevious,
            },
            include: SHIFT_CARD_INCLUDE,
          });
        } catch (error) {
          if (
            error instanceof Prisma.PrismaClientKnownRequestError &&
            error.code === 'P2002'
          ) {
            // Ver comentario de cabecera del archivo: NO seguir consultando
            // acá, la tx ya quedó abortada. Se relee afuera.
            throw new ShiftCardIdRaceError();
          }
          throw error;
        }
      });

      return this.shapeCard(card);
    } catch (error) {
      if (error instanceof ShiftCardIdRaceError) {
        return this.resolveOpenRace(dto.id, supervisorId, dto.equipoId);
      }
      throw error;
    }
  }

  /**
   * `POST /api/shift-cards/:id/close` — cierra una tarjeta abierta. Requiere
   * litros (0 permitido) y SIEMPRE una foto (aun con 0 L). Idempotente por
   * `dto.closeClientId`.
   */
  async closeCard(
    id: string,
    dto: CloseShiftCardDto,
    session: UserSession,
  ): Promise<ShiftCardResponse> {
    const now = new Date();

    const card = await this.prisma.registroHorometro.findUnique({
      where: { id },
    });
    if (!card) {
      throw new NotFoundException({
        message: 'Tarjeta no encontrada',
        code: ERROR_CODES.CARD_NOT_FOUND,
      });
    }

    // El chequeo de dueño va INMEDIATAMENTE después del 404, ANTES que el
    // replay idempotente de abajo. Si no, un
    // supervisor B que reenviara (adivinado, filtrado, o simplemente
    // reintentado a mano) el `closeClientId` de una tarjeta A ajena caería en
    // la rama de replay, que devolvería la tarjeta COMPLETA de A —incluida la
    // URL firmada de su foto— sin pasar nunca por este chequeo.
    const isAdmin = sessionHasRole(session.user.role, ROLES.ADMIN);
    if (card.supervisorId !== session.user.id && !isAdmin) {
      throw new ForbiddenException({
        message: 'No puedes cerrar la tarjeta de otro supervisor',
        code: ERROR_CODES.NOT_OWNER,
      });
    }

    if (card.valorFinal != null) {
      if (card.closeClientId === dto.closeClientId) {
        // Reintento del cierre YA aplicado — se devuelve tal cual, SIN
        // reclamar la foto de nuevo (`claimTmp` ni se llama).
        return this.shapeCard(await this.reloadCard(id));
      }
      throw new ConflictException({
        message: this.buildAlreadyClosedMessage(card.closedAt),
        code: ERROR_CODES.ALREADY_CLOSED,
      });
    }

    if (dto.valorFinal < card.valorInicial) {
      throw new BadRequestException({
        message: `La lectura final (${dto.valorFinal}) no puede ser menor que la inicial (${card.valorInicial})`,
        code: ERROR_CODES.HOURMETER_BELOW_INITIAL,
      });
    }

    const { at: capturedAt, discardedSkewMs } = resolveCapturedAt(
      dto.capturedAt,
      now,
    );
    // `photoCapturedAt` es EXIF del dispositivo (puede no parsear, ej.
    // `"2026-W01"`, o venir con el reloj de la cámara mal
    // configurado) — a diferencia de `capturedAt`, fuera de rango o
    // inválido se IGNORA (cae a `capturedAt`), nunca rechaza el cierre.
    const photoCapturedAt = resolveCapturedAtWithFallback(
      dto.photoCapturedAt,
      capturedAt,
      now,
    );

    // Reclama la foto ANTES de la transacción (mismo patrón que
    // `CombustibleService.create`): si `claimTmp` falla (tmp vencido/ajeno),
    // todavía no hay nada que descartar. `claimTmp` traduce un tmp
    // vencido/inexistente a 400 `TMP_KEY_EXPIRED`.
    const pumpPhotoKey = await this.storage.claimTmp(
      dto.tmpPhotoKey,
      session.user.id,
      'fuel-photo',
    );

    // `closed` se declara AFUERA del `try` y `this.shapeCard(closed!)` (que
    // llama `StorageService.sign`) corre
    // DESPUÉS de él — antes, `shapeCard` vivía DENTRO del mismo `try` que el
    // `catch` de abajo descarta `pumpPhotoKey`. Si `sign()` fallaba (red al
    // bucket) DESPUÉS de que la transacción ya hizo commit, ese `catch`
    // igual descartaba el objeto ya persistido en la fila — un objeto vivo,
    // referenciado en la base, borrado por un fallo post-commit ajeno a él.
    let closed: ShiftCardRecord | null;
    try {
      closed = await this.prisma.$transaction(async (tx) => {
        // `updateMany` (no `update`) porque la condición de carrera vive en
        // el `where`: si otra request ya cerró la tarjeta entre el
        // `findUnique` de arriba y acá, `count` da 0 en vez de lanzar.
        const result = await tx.registroHorometro.updateMany({
          where: { id, valorFinal: null },
          data: {
            valorFinal: dto.valorFinal,
            fechaSalida: capturedAt,
            closedAt: now,
            closeClientId: dto.closeClientId,
            fuelLiters: dto.fuelLiters,
            pumpPhotoKey,
            observaciones: dto.observaciones ?? null,
            adBlue: dto.adBlue ?? false,
            adBlueLiters: dto.adBlue ? (dto.adBlueLiters ?? null) : null,
            // Hora del dispositivo descartada por desfase: se audita sin pisar
            // la marca que la apertura ya haya dejado.
            ...(discardedSkewMs !== undefined && card.clientClockSkewMs === null
              ? { clientClockSkewMs: discardedSkewMs }
              : {}),
          },
        });

        if (result.count !== 1) {
          throw new ShiftCardCloseRaceError();
        }

        // Reconciliación en modo `'warn'` (NUNCA `'reject'` acá): el
        // contador VIGENTE del equipo puede ser mayor que `valorInicial`
        // (la tarjeta se abrió en
        // modo `'warn'` con una lectura por debajo del contador,
        // `belowPreviousReading`) y seguir siendo mayor que `valorFinal` en
        // el cierre — el ≥ inicial ya se validó arriba, pero eso NO
        // garantiza que `valorFinal` alcance al vigente. Si acá se usara
        // `'reject'`, esa tarjeta NUNCA podría cerrarse: el `reject`
        // lanzaría DESPUÉS de reclamar la foto (el catch de abajo la
        // descartaría) y CUALQUIER reintento —incluido el offline— repetiría
        // el mismo rechazo para siempre, dejando la operación encallada en
        // `needs_attention`. El cierre solo AUDITA (marca
        // `belowPreviousReading`, sin des-marcarlo si ya venía en `true`
        // desde la apertura) — nunca bloquea.
        const equipo = await tx.equipment.findUnique({
          where: { id: card.equipoId },
          select: {
            controlUnit: true,
            currentHourmeter: true,
            currentMileage: true,
          },
        });
        if (equipo) {
          const { belowPrevious } = await reconcileEquipmentCounter(
            tx,
            card.equipoId,
            equipo,
            dto.valorFinal,
            'warn',
          );
          if (belowPrevious && !card.belowPreviousReading) {
            await tx.registroHorometro.update({
              where: { id },
              data: { belowPreviousReading: true },
            });
          }
        }

        // NO se reusa `CombustibleService.create` (tiene su propio claim y
        // rechaza 0 L) — acá 0 L es válido y la key ya está reclamada.
        if (dto.fuelLiters > 0) {
          await tx.registroCombustible.create({
            data: {
              equipoId: card.equipoId,
              litros: dto.fuelLiters,
              tipo: DEFAULT_SHIFT_CLOSE_FUEL_TYPE,
              // Comparte la MISMA key que la tarjeta — así la carga aparece
              // sola en la ficha y en el historial de combustible sin
              // duplicar la foto.
              fotoKey: pumpPhotoKey,
              fecha: photoCapturedAt,
              registroHorometroId: id,
            },
          });
        }

        return tx.registroHorometro.findUnique({
          where: { id },
          include: SHIFT_CARD_INCLUDE,
        });
      });
    } catch (error) {
      // Cualquier falla DESPUÉS del claim exige descartar la copia recién
      // creada — nunca dejar un objeto huérfano en el bucket.
      await this.storage.discard(pumpPhotoKey);

      if (error instanceof ShiftCardCloseRaceError) {
        return this.resolveCloseRace(id, dto.closeClientId);
      }
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        // `closeClientId` es `@unique` — un doble submit concurrente con el
        // MISMO closeClientId puede chocar acá en vez de vía `count === 0`
        // (ver comentario de cabecera). Mismo desenlace: se relee y se
        // devuelve la existente.
        return this.resolveCloseRace(id, dto.closeClientId);
      }

      throw error;
    }

    return this.shapeCard(closed!);
  }

  /**
   * `PATCH /api/shift-cards/:id` — corrige una tarjeta ya enviada. Solo el supervisor dueño o un ADMIN.
   *
   * Es seguro de reintentar desde la cola offline: la fila se bloquea
   * (`FOR UPDATE`) y se relee dentro de la transacción, y `X-Expected` deja
   * pasar el reintento de una edición ya aplicada (el dato ya vale lo que se
   * quiere) pero rechaza una pisada sobre un cambio ajeno (409
   * `STALE_UPDATE`). Lo que cambió queda en `ChangeLog` en la misma
   * transacción; si no cambió nada, no se escribe ni se avisa.
   */
  async update(
    id: string,
    dto: UpdateShiftCardDto,
    session: UserSession,
    expected?: ExpectedValues,
  ): Promise<ShiftCardResponse> {
    const camposRecibidos = Object.values(dto).some((v) => v !== undefined);
    if (!camposRecibidos) {
      throw new BadRequestException(
        'Indica al menos un dato a corregir de la tarjeta',
      );
    }

    const previa = await this.findOwnedCard(id, session);
    this.assertClosedFieldsAllowed(dto, previa.valorFinal);

    // Si el operador no cambia no se exige que siga activo: se conserva lo
    // guardado, igual que en trabajos extra.
    const operator =
      dto.operatorId !== undefined && dto.operatorId !== previa.operatorId
        ? await this.operators.assertActive(dto.operatorId)
        : null;
    const editor = toEditor(session.user);

    const { card, event } = await this.prisma.$transaction(
      (tx): Promise<ShiftCardEdit> =>
        this.applyEdit(tx, id, dto, operator, editor, expected),
    );

    if (event) this.eventEmitter.emit(DOMAIN_EVENTS.RECORD_EDITED, event);
    return this.shapeCard(card);
  }

  /** `GET /api/shift-cards/:id/changes` — dueño o ADMIN. */
  async findChanges(id: string, session: UserSession) {
    await this.findOwnedCard(id, session);
    return this.changeLog.findFor('shift_card', id);
  }

  private async applyEdit(
    tx: Prisma.TransactionClient,
    id: string,
    dto: UpdateShiftCardDto,
    operator: { id: string; name: string } | null,
    editor: Editor,
    expected: ExpectedValues | undefined,
  ): Promise<ShiftCardEdit> {
    // Un operador que cambió entre la validación y el bloqueo (carrera
    // improbable) se valida de nuevo en vez de guardarse sin chequear.
    const resolverOperador = async (
      actual: ShiftCardRecord,
    ): Promise<{ id: string; name: string } | null> => {
      if (
        dto.operatorId === undefined ||
        dto.operatorId === actual.operatorId
      ) {
        return null;
      }
      return operator?.id === dto.operatorId
        ? operator
        : this.operators.assertActive(dto.operatorId);
    };
    const resuelto: { operador: { id: string; name: string } | null } = {
      operador: null,
    };

    // Bloquea la fila, la relee y compara `X-Expected`: lo que sigue se calcula
    // sobre el valor vigente, serializado contra ediciones y cierres
    // concurrentes de la misma tarjeta.
    const actual = await assertExpectedLocked({
      tx,
      table: 'registroHorometro',
      id,
      expected,
      read: (t) =>
        t.registroHorometro.findUnique({
          where: { id },
          include: SHIFT_CARD_INCLUDE,
        }),
      comparable: datosDeTarjeta,
      desired: async (vigente) => {
        this.assertClosedFieldsAllowed(dto, vigente.valorFinal);
        resuelto.operador = await resolverOperador(vigente);
        return { ...mezclarTarjeta(vigente, dto, resuelto.operador) };
      },
      labels: CAMPO_LABEL,
      notFoundMessage: 'Tarjeta no encontrada',
      notFoundError: () => this.cardNotFound(),
    });
    const operadorNuevo = resuelto.operador;
    const antes = datosDeTarjeta(actual);
    const despues = mezclarTarjeta(actual, dto, operadorNuevo);

    if (
      despues.valorFinal != null &&
      despues.valorFinal < despues.valorInicial
    ) {
      throw new BadRequestException({
        message: `La lectura final (${despues.valorFinal}) no puede ser menor que la inicial (${despues.valorInicial})`,
        code: ERROR_CODES.HOURMETER_BELOW_INITIAL,
      });
    }
    const adBlueProblema = adBlueError(despues.adBlue, despues.adBlueLiters);
    if (adBlueProblema) throw new BadRequestException(adBlueProblema);

    const nombreOperador = operadorNuevo?.name ?? actual.operador;
    const nombres = new Map<string | null, string>([
      [actual.operatorId, actual.operador],
      [despues.operatorId, nombreOperador],
    ]);
    const cambios = diffFields<DatosTarjeta>(antes, despues, [
      {
        field: 'operatorId',
        label: CAMPO_LABEL.operatorId,
        format: (v) => nombres.get(v as string | null) ?? '—',
      },
      { field: 'valorInicial', label: CAMPO_LABEL.valorInicial },
      { field: 'valorFinal', label: CAMPO_LABEL.valorFinal },
      { field: 'fuelLiters', label: CAMPO_LABEL.fuelLiters },
      {
        field: 'adBlue',
        label: CAMPO_LABEL.adBlue,
        format: (v) => (v ? 'Sí' : 'No'),
      },
      { field: 'adBlueLiters', label: CAMPO_LABEL.adBlueLiters },
      { field: 'observaciones', label: CAMPO_LABEL.observaciones },
    ]);
    if (cambios.length === 0) return { card: actual, event: null };

    const datos: Prisma.RegistroHorometroUncheckedUpdateInput = {
      operatorId: despues.operatorId,
      operador: nombreOperador,
      valorInicial: despues.valorInicial,
      valorFinal: despues.valorFinal,
      fuelLiters: despues.fuelLiters,
      adBlue: despues.adBlue,
      adBlueLiters: despues.adBlueLiters,
      observaciones: despues.observaciones,
    };
    if (despues.valorFinal != null && despues.valorFinal !== antes.valorFinal) {
      // Modo `'warn'`, igual que el cierre: la edición solo sube el contador
      // del equipo, nunca lo baja ni falla.
      const equipo = await tx.equipment.findUnique({
        where: { id: actual.equipoId },
        select: {
          controlUnit: true,
          currentHourmeter: true,
          currentMileage: true,
        },
      });
      if (equipo) {
        const { belowPrevious } = await reconcileEquipmentCounter(
          tx,
          actual.equipoId,
          equipo,
          despues.valorFinal,
          'warn',
        );
        if (belowPrevious && !actual.belowPreviousReading) {
          datos.belowPreviousReading = true;
        }
      }
    }

    await tx.registroHorometro.update({ where: { id }, data: datos });
    if ((despues.fuelLiters ?? 0) !== (antes.fuelLiters ?? 0)) {
      await this.syncFuelRecord(tx, actual, despues.fuelLiters ?? 0);
    }
    await this.changeLog.record(tx, 'shift_card', id, editor, cambios);

    const card = await tx.registroHorometro.findUnique({
      where: { id },
      include: SHIFT_CARD_INCLUDE,
    });
    if (!card) throw this.cardNotFound();

    return {
      card,
      event: {
        entity: 'shift_card',
        entityId: id,
        entityArticle: 'la',
        // El turno al que pertenece la tarjeta, no la hora en que se abrió: un
        // turno nocturno abierto de noche cruza la medianoche.
        entityLabel: `tarjeta de turno de ${actual.equipo.internalCode} del ${
          actual.shift
            ? formatDateOnlyForHumans(actual.shift.date)
            : formatBusinessDate(actual.fecha)
        }`,
        editedBy: editor.name,
        changes: cambios.map(({ label, before, after }) => ({
          label,
          before,
          after,
        })),
      },
    };
  }

  /**
   * Mantiene la carga de combustible vinculada (1:1 por `registroHorometroId`)
   * coherente con los litros de la tarjeta: existe si y solo si hay litros.
   * Comparte la foto de la tarjeta, así que borrar la fila nunca borra el
   * objeto del bucket.
   */
  private async syncFuelRecord(
    tx: Prisma.TransactionClient,
    card: ShiftCardRecord,
    liters: number,
  ): Promise<void> {
    const vinculada = await tx.registroCombustible.findUnique({
      where: { registroHorometroId: card.id },
      select: { id: true },
    });

    if (liters > 0 && vinculada) {
      await tx.registroCombustible.update({
        where: { id: vinculada.id },
        data: { litros: liters },
      });
    } else if (liters > 0) {
      await tx.registroCombustible.create({
        data: {
          equipoId: card.equipoId,
          litros: liters,
          tipo: DEFAULT_SHIFT_CLOSE_FUEL_TYPE,
          fotoKey: card.pumpPhotoKey,
          fecha: card.fechaSalida ?? card.closedAt ?? new Date(),
          registroHorometroId: card.id,
        },
      });
    } else if (vinculada) {
      await tx.registroCombustible.delete({ where: { id: vinculada.id } });
    }
  }

  /** La tarjeta si existe y la sesión es su dueña o ADMIN; si no, 404 / 403. */
  private async findOwnedCard(id: string, session: UserSession) {
    const card = await this.prisma.registroHorometro.findUnique({
      where: { id },
      select: { supervisorId: true, operatorId: true, valorFinal: true },
    });
    if (!card) throw this.cardNotFound();

    const isAdmin = sessionHasRole(session.user.role, ROLES.ADMIN);
    if (card.supervisorId !== session.user.id && !isAdmin) {
      throw new ForbiddenException({
        message: 'No puedes modificar la tarjeta de otro supervisor',
        code: ERROR_CODES.NOT_OWNER,
      });
    }
    return card;
  }

  /** Lectura final, combustible y AdBlue solo existen al cerrar. */
  private assertClosedFieldsAllowed(
    dto: UpdateShiftCardDto,
    valorFinal: number | null,
  ): void {
    if (valorFinal !== null) return;
    const tocados = CAMPOS_DE_CIERRE.filter((c) => dto[c] !== undefined);
    if (tocados.length === 0) return;
    throw new ConflictException({
      message: `La tarjeta sigue abierta: ${tocados
        .map((c) => CAMPO_LABEL[c])
        .join(', ')} se informan al cerrarla`,
      code: ERROR_CODES.CARD_NOT_CLOSED,
    });
  }

  private cardNotFound(): NotFoundException {
    return new NotFoundException({
      message: 'Tarjeta no encontrada',
      code: ERROR_CODES.CARD_NOT_FOUND,
    });
  }

  /**
   * `GET /api/shift-cards/mine` — URL estable (sin query params de fecha,
   * cacheable offline): abiertas + cerradas en las últimas 48 h. SUPERVISOR
   * ve las suyas, ADMIN ve todas.
   */
  async mine(session: UserSession): Promise<ShiftCardResponse[]> {
    const isAdmin = sessionHasRole(session.user.role, ROLES.ADMIN);
    const cutoff = new Date(Date.now() - MINE_CLOSED_WINDOW_MS);

    const cards = await this.prisma.registroHorometro.findMany({
      where: {
        ...(isAdmin ? {} : { supervisorId: session.user.id }),
        OR: [{ valorFinal: null }, { closedAt: { gte: cutoff } }],
      },
      orderBy: { fecha: 'desc' },
      include: SHIFT_CARD_INCLUDE,
    });

    return this.shapeCards(cards);
  }

  /**
   * `GET /api/shifts?date&type` — contrato compartido con el Módulo B
   * ("lista viva"). Deliberadamente MÁS liviano que `ShiftCardResponse` (sin
   * `pumpPhotoUrl` firmada ni nombres de supervisor): el Módulo B no
   * necesita la foto y firmar N urls en cada poll de la lista viva sería
   * costo innecesario.
   */
  async findShifts(
    query: QueryShiftDto,
    session: UserSession,
  ): Promise<ShiftWithCardsResponse[]> {
    const isAdmin = sessionHasRole(session.user.role, ROLES.ADMIN);
    const date = parseDateOnlyUtc(query.date);

    const shifts = await this.prisma.shift.findMany({
      where: {
        date,
        type: query.type,
        ...(isAdmin ? {} : { supervisorId: session.user.id }),
      },
      include: {
        cards: {
          include: {
            equipo: {
              select: { internalCode: true, type: true, controlUnit: true },
            },
          },
          orderBy: { fecha: 'desc' },
        },
      },
    });

    return shifts.map((shift) => ({
      id: shift.id,
      date: formatDateOnly(shift.date),
      type: shift.type,
      supervisorId: shift.supervisorId,
      cards: shift.cards.map((card) => ({
        id: card.id,
        equipoId: card.equipoId,
        equipo: card.equipo,
        operatorId: card.operatorId,
        operatorName: card.operador,
        valorInicial: card.valorInicial,
        valorFinal: card.valorFinal,
        horasMaquina:
          card.valorFinal != null
            ? round2(card.valorFinal - card.valorInicial)
            : null,
        fecha: card.fecha,
        fechaSalida: card.fechaSalida,
      })),
    }));
  }

  /** Upsert por clave natural `(supervisorId, date, type)`. Prisma compila
   * `upsert` a un `INSERT ... ON CONFLICT` atómico cuando la DB lo soporta,
   * pero igual se re-lee una vez ante un P2002 —
   * defensa en profundidad ante cualquier caso borde del motor. */
  private async upsertShift(supervisorId: string, date: string, type: string) {
    const dbDate = parseDateOnlyUtc(date);
    const where = {
      supervisorId_date_type: { supervisorId, date: dbDate, type },
    };

    try {
      return await this.prisma.shift.upsert({
        where,
        create: { supervisorId, date: dbDate, type },
        update: {},
      });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        const existing = await this.prisma.shift.findUnique({ where });
        if (existing) return existing;
      }
      throw error;
    }
  }

  /** Se relee FUERA de la tx tras el rollback (ver comentario de cabecera
   * del archivo): mía → 200 (misma request, ganó la carrera del lado
   * contrario); si no → 409 `EQUIPMENT_BUSY`. */
  private async resolveOpenRace(
    id: string,
    supervisorId: string,
    equipoId: string,
  ): Promise<ShiftCardResponse> {
    const existing = await this.prisma.registroHorometro.findUnique({
      where: { id },
      include: SHIFT_CARD_INCLUDE,
    });
    if (
      existing &&
      existing.supervisorId === supervisorId &&
      existing.equipoId === equipoId
    ) {
      return this.shapeCard(existing);
    }

    const abierta = await this.prisma.registroHorometro.findFirst({
      where: { equipoId, valorFinal: null },
      select: { supervisorId: true, fecha: true },
    });
    const supervisorName = abierta
      ? await this.resolveSupervisorName(this.prisma, abierta.supervisorId)
      : null;

    throw new ConflictException({
      message: abierta
        ? this.buildBusyMessage(supervisorName, abierta.fecha)
        : 'El equipo ya tiene una tarjeta de turno abierta',
      code: ERROR_CODES.EQUIPMENT_BUSY,
    });
  }

  /** Mismo criterio que `resolveOpenRace`, para el cierre (ver
   * `resolveCloseRace`). */
  private async resolveCloseRace(
    id: string,
    closeClientId: string,
  ): Promise<ShiftCardResponse> {
    const existing = await this.prisma.registroHorometro.findUnique({
      where: { id },
      include: SHIFT_CARD_INCLUDE,
    });
    return resolveCloseRace({
      existing,
      closeClientId,
      replay: (card) => this.shapeCard(card),
      alreadyClosed: () =>
        new ConflictException({
          message: this.buildAlreadyClosedMessage(existing?.closedAt ?? null),
          code: ERROR_CODES.ALREADY_CLOSED,
        }),
    });
  }

  private async reloadCard(id: string): Promise<ShiftCardRecord> {
    const card = await this.prisma.registroHorometro.findUnique({
      where: { id },
      include: SHIFT_CARD_INCLUDE,
    });
    if (!card) {
      throw new NotFoundException({
        message: 'Tarjeta no encontrada',
        code: ERROR_CODES.CARD_NOT_FOUND,
      });
    }
    return card;
  }

  /** Estructuralmente compatible con `Prisma.TransactionClient` Y con
   * `PrismaService` (superset) — permite un solo helper para resolver un
   * nombre de usuario tanto DENTRO de una tx (`tx.user...`) como afuera
   * (`this.prisma.user...`), sin castear. */
  private async resolveSupervisorName(
    client: Prisma.TransactionClient,
    supervisorId: string | null,
  ): Promise<string | null> {
    if (!supervisorId) return null;
    const user = await client.user.findUnique({
      where: { id: supervisorId },
      select: { name: true },
    });
    return user?.name ?? null;
  }

  private buildBusyMessage(supervisorName: string | null, since: Date): string {
    return `El equipo ya tiene una tarjeta de turno abierta por ${
      supervisorName ?? 'otro supervisor'
    } desde ${since.toISOString()}`;
  }

  private buildAlreadyClosedMessage(closedAt: Date | null): string {
    return closedAt
      ? `La tarjeta ya fue cerrada el ${closedAt.toISOString()}`
      : 'La tarjeta ya fue cerrada';
  }

  private async shapeCards(
    cards: readonly ShiftCardRecord[],
  ): Promise<ShiftCardResponse[]> {
    const supervisorIds = Array.from(
      new Set(
        cards
          .map((card) => card.supervisorId)
          .filter((id): id is string => id != null),
      ),
    );
    const supervisors =
      supervisorIds.length > 0
        ? await this.prisma.user.findMany({
            where: { id: { in: supervisorIds } },
            select: { id: true, name: true },
          })
        : [];
    const supervisorsById = new Map(supervisors.map((s) => [s.id, s.name]));

    return Promise.all(
      cards.map(async (card) => ({
        id: card.id,
        equipoId: card.equipoId,
        equipo: card.equipo,
        operatorId: card.operatorId,
        operatorName: card.operador,
        supervisorId: card.supervisorId,
        supervisorName: card.supervisorId
          ? (supervisorsById.get(card.supervisorId) ?? null)
          : null,
        shift: card.shift
          ? {
              id: card.shift.id,
              date: formatDateOnly(card.shift.date),
              type: card.shift.type,
              // La columna Prisma es `String` (ver
              // `shift-exit-report-email-status.ts`) — `ShiftReportsService`
              // es el único writer, siempre con uno de los 4 valores del
              // union, así que el cast es seguro por construcción.
              exitReports: card.shift.exitReports.map((report) => ({
                ...report,
                emailStatus: report.emailStatus as ShiftExitReportEmailStatus,
              })),
            }
          : null,
        valorInicial: card.valorInicial,
        valorFinal: card.valorFinal,
        horasMaquina:
          card.valorFinal != null
            ? round2(card.valorFinal - card.valorInicial)
            : null,
        fuelLiters: card.fuelLiters,
        pumpPhotoUrl: card.pumpPhotoKey
          ? await this.storage.sign(card.pumpPhotoKey)
          : null,
        observaciones: card.observaciones,
        adBlue: card.adBlue,
        adBlueLiters: card.adBlueLiters,
        belowPreviousReading: card.belowPreviousReading,
        fecha: card.fecha,
        fechaSalida: card.fechaSalida,
        createdAt: card.createdAt,
        closedAt: card.closedAt,
      })),
    );
  }

  private async shapeCard(card: ShiftCardRecord): Promise<ShiftCardResponse> {
    const [shaped] = await this.shapeCards([card]);
    return shaped;
  }
}
