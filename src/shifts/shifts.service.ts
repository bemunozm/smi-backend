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
import {
  ControlUnit,
  EquipmentClass,
  EquipmentStatus,
  Prisma,
} from '@prisma/client';
import type { UserSession } from '@thallesp/nestjs-better-auth';

import { ROLES, sessionHasRole, type Role } from '../auth/roles';
import { PrismaService } from '../common/prisma/prisma.service';
import { ERROR_CODES } from '../common/errors/error-codes';
import { assertExpectedLocked } from '../common/concurrency/assert-expected-locked';
import { type ExpectedValues } from '../common/concurrency/expected-fields';
import { resolveCloseRace } from '../common/idempotency/resolve-close-race';
import { createOrReturn } from '../common/idempotency/create-or-return';
import { lockRow } from '../common/concurrency/lock-row';
import { DOMAIN_EVENTS } from '../common/events/domain-events';
import type {
  FuelLoadedEvent,
  RecordEditedEvent,
} from '../common/events/domain-events';
import {
  ChangeLogService,
  diffFields,
  type Editor,
} from '../change-log/change-log.service';
import { toEditor } from '../change-log/current-editor.decorator';
import { OperatorsService } from '../operators/operators.service';
import { StorageService } from '../storage/storage.service';
import { AdBlueStockService } from '../inventory/adblue-stock.service';
import type { PendingStockEvents } from '../inventory/stock.service';
import {
  reconcileEquipmentCounter,
  releaseRemovedReading,
} from '../equipment/equipment-counter';
import { formatNumber } from '../common/format/number';
import { assertChecklistNotPending } from '../mantenimiento/daily-checklists/checklist-gate';
import {
  businessDayInstant,
  businessDayKey,
  formatBusinessDate,
  formatBusinessDateTime,
  isPastBusinessDay,
  todayInBusinessTimeZone,
} from '../common/dates/business-time';
import {
  computeClientClockSkewMs,
  resolveCapturedAt,
  resolveCapturedAtWithFallback,
} from '../common/dates/capture-time';
import {
  assertShiftDateWithinWindow,
  formatDateOnly,
  fuelDateForShiftDay,
  isPastShift,
  parseDateOnlyUtc,
  shiftDayOf,
} from './date-only';
import { adBlueError } from './adblue';
import { AdminCloseShiftCardDto } from './dto/admin-close-shift-card.dto';
import { CloseShiftCardDto } from './dto/close-shift-card.dto';
import { CreateShiftCardFuelLoadDto } from './dto/create-shift-card-fuel-load.dto';
import { RegisterClosedShiftCardDto } from './dto/register-closed-shift-card.dto';
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
/** Mismo criterio, para la edición que mueve una tarjeta ABIERTA a otro
 * equipo: el P2002 del índice parcial de tarjeta abierta se traduce AFUERA
 * de la tx abortada (409 `EQUIPMENT_BUSY`). */
class ShiftCardMoveRaceError extends Error {}

/** Lo que se lee de cada carga registrada con la tarjeta abierta (respuesta
 * de la tarjeta y borrado de la tarjeta). */
const CARGA_EN_CURSO_SELECT = {
  id: true,
  litros: true,
  lectura: true,
  adBlueLitros: true,
  fotoKey: true,
  fecha: true,
  createdAt: true,
  // El `select` explícito gana al omit global del campo.
  createdById: true,
} satisfies Prisma.RegistroCombustibleSelect;

const SHIFT_CARD_INCLUDE = {
  equipo: {
    select: {
      internalCode: true,
      type: true,
      controlUnit: true,
      equipmentClass: true,
    },
  },
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
  // Cargas registradas con la tarjeta ABIERTA, sin cerrarla (solo livianos),
  // en el orden en que se cargaron.
  cargasEnCurso: {
    select: CARGA_EN_CURSO_SELECT,
    orderBy: [{ fecha: 'asc' }, { createdAt: 'asc' }],
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
 * Una carga de combustible registrada con la tarjeta ABIERTA, sin cerrarla
 * (`POST /api/shift-cards/:id/fuel-loads`, solo livianos). NUNCA expone la
 * key de la foto ni el `createdById`.
 */
export interface ShiftCardFuelLoadResponse {
  id: string;
  liters: number;
  /** Km del liviano al cargar. */
  reading: number;
  adBlueLiters: number | null;
  /** URL FIRMADA de la foto del surtidor (`StorageService.sign`). */
  pumpPhotoUrl: string | null;
  /** Día de negocio al que quedó fechada la carga (regla del turno de quien
   * carga, igual que el cierre). */
  fecha: Date;
  /** Cuándo se registró (hora del servidor). */
  createdAt: Date;
  /** Quién la registró; `null` si la cuenta ya no existe. */
  createdByName: string | null;
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
  equipo: {
    internalCode: string;
    type: string;
    controlUnit: ControlUnit;
    /** `LIGHT`: la tarjeta va por km, sin operador, y la cierra cualquier supervisor. */
    equipmentClass: EquipmentClass;
  };
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
  /** Por qué se cerró sin combustible; `null` si tiene litros o no se dijo. */
  noFuelReason: string | null;
  adBlue: boolean;
  adBlueLiters: number | null;
  belowPreviousReading: boolean;
  fecha: Date;
  fechaSalida: Date | null;
  createdAt: Date;
  closedAt: Date | null;
  /** Quién la cerró (en los livianos, puede no ser quien la abrió). */
  closedById: string | null;
  closedByName: string | null;
  /** El turno en que se cerró: ahí entra en el reporte de salida. */
  closedShift: { id: string; date: string; type: string } | null;
  /** Cargas registradas con la tarjeta abierta, sin cerrarla (solo
   * livianos), de la más vieja a la más nueva. Vacío si no hay. No incluye
   * la carga del cierre, que sigue en `fuelLiters`/`pumpPhotoUrl`. */
  fuelLoads: ShiftCardFuelLoadResponse[];
}

export interface ShiftCardSummaryResponse {
  id: string;
  equipoId: string;
  equipo: {
    internalCode: string;
    type: string;
    controlUnit: ControlUnit;
    /** Para que el informe de producción excluya camionetas del resumen de un
     * turno pasado, igual que lo hace con "mis tarjetas". */
    equipmentClass: EquipmentClass;
  };
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
  /** Reportes de salida ya enviados del turno — la carga histórica avisa con
   * esto que el turno elegido ya fue reportado. */
  exitReports: {
    id: string;
    requestedAt: Date;
    cardCount: number;
    emailStatus: string;
  }[];
}

/** El primer rol reconocible de la sesión, que puede venir como lista o
 * como «A,B» (mismo formato que admite `sessionHasRole`); `null` si ninguno
 * lo es. Solo para textos (el aviso `fuel.loaded`). */
export function primerRolConocido(
  role: string | string[] | null | undefined,
): Role | null {
  if (!role) return null;
  const roles = Array.isArray(role) ? role : role.split(',');
  const conocidos = Object.values(ROLES) as string[];
  const primero = roles.map((r) => r.trim()).find((r) => conocidos.includes(r));
  return (primero as Role | undefined) ?? null;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/** Los datos de una tarjeta que se pueden corregir. */
type DatosTarjeta = {
  operatorId: string | null;
  equipoId: string;
  turno: string;
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
  equipoId: 'Equipo',
  turno: 'Turno',
  valorInicial: 'Lectura inicial',
  valorFinal: 'Lectura final',
  fuelLiters: 'Litros de combustible',
  adBlue: 'AdBlue',
  adBlueLiters: 'Litros de AdBlue',
  observaciones: 'Observaciones',
};

/** `DIURNO`/`NOCTURNO` como se muestran en avisos e historial. */
const TURNO_LABEL: Record<string, string> = {
  DIURNO: 'Diurno',
  NOCTURNO: 'Nocturno',
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
    equipoId: card.equipoId,
    turno: card.turno,
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
    equipoId: dto.equipoId ?? actual.equipoId,
    turno: dto.turno ?? actual.turno,
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
    private readonly adBlueStock: AdBlueStockService,
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
    // El supervisor temporal trabaja con horario libre: no hay turno ni día
    // reportado que validar. Su tarjeta nace sin `Shift` (`shiftId: null`),
    // marcada `temporal`, y se cierra después junto con las demás en su
    // informe (`closeCard(..., { viaInforme: true })`). El `shiftDate` que
    // igual manda el DTO se ignora; `shiftType` queda como `turno` solo
    // porque la columna es obligatoria.
    const esTemporal = sessionHasRole(
      session.user.role,
      ROLES.SUPERVISOR_TEMPORAL,
    );
    // Día del checklist que libera el equipo: el del `shiftDate` reportado,
    // o —sin turno, en el temporal— el día de turno que marca el reloj (a
    // las 02:00 sigue corriendo el de ayer, mismo criterio que `shiftDayOf`).
    const checklistDay = parseDateOnlyUtc(
      esTemporal ? shiftDayOf(now) : dto.shiftDate,
    );
    // Ventana razonable de `shiftDate` — antes de tocar cualquier estado
    // (ni el operador, ni menos el `Shift`, que sí escribe).
    if (!esTemporal) assertShiftDateWithinWindow(dto.shiftDate, now);
    // Carga histórica (turno YA TERMINADO de un día pasado — `isPastShift`
    // exceptúa al nocturno de anoche que sigue corriendo de madrugada): el
    // estado ACTUAL del equipo no dice nada de ese día (hoy puede estar en
    // taller y la semana pasada haber trabajado), así que no bloquea la
    // apertura; y la tarjeta se fecha DENTRO de ese día de negocio, que es
    // por donde agrupan el dashboard y las fichas (`createdAt` conserva
    // cuándo se cargó de verdad).
    // (El temporal nunca es carga histórica: abre en vivo, sin día reportado.)
    const pastShift =
      !esTemporal && isPastShift(dto.shiftDate, dto.shiftType, now);
    const clientClockSkewMs =
      computeClientClockSkewMs(clientTimeHeader, now) ?? discardedSkewMs;

    // Precondición pura de la request — antes de tocar el equipo/turno. En
    // los livianos no hay operador (la camioneta la maneja el supervisor).
    const operator = dto.operatorId
      ? await this.operators.assertActive(dto.operatorId)
      : null;

    // Lectura del equipo ANTES del upsert del `Shift` (que sí escribe) —
    // así una request con un `equipoId` que no existe, o un equipo fuera de
    // servicio, no alcanza a crear un
    // `Shift` para una fecha arbitraria. El chequeo DENTRO de la tx (más
    // abajo) se mantiene igual — repetido a propósito: cierra la ventana de
    // carrera contra un cambio de estado concurrente del equipo; este
    // pre-check es solo un fast-path de solo lectura.
    const equipoPrecheck = await this.prisma.equipment.findUnique({
      where: { id: dto.equipoId },
      select: { status: true, equipmentClass: true },
    });
    if (!equipoPrecheck) throw new NotFoundException('Equipo no encontrado');
    // El mantenedor y el prevencionista solo se mueven en camioneta: un
    // pesado lo abre el supervisor, con su operador.
    if (
      (sessionHasRole(session.user.role, ROLES.MANTENEDOR) ||
        sessionHasRole(session.user.role, ROLES.PREVENCIONISTA)) &&
      equipoPrecheck.equipmentClass !== EquipmentClass.LIGHT
    ) {
      throw new ForbiddenException(
        'Solo puedes registrar el uso de vehículos livianos.',
      );
    }
    if (!operator && equipoPrecheck.equipmentClass !== EquipmentClass.LIGHT) {
      throw new BadRequestException('Elige el operador del equipo.');
    }
    if (!pastShift && equipoPrecheck.status !== EquipmentStatus.OPERATIONAL) {
      throw new ConflictException({
        message: 'El equipo no está operativo',
        code: ERROR_CODES.EQUIPMENT_NOT_OPERATIONAL,
      });
    }
    // Módulo 3: con el checklist del día por validar o rechazado, el equipo
    // no se libera (se repite dentro de la tx, igual que el estado).
    await assertChecklistNotPending(this.prisma, dto.equipoId, checklistDay);

    const supervisorId = session.user.id;

    // Upsert del `Shift` por clave natural (supervisorId, date, type) FUERA
    // de la transacción de la tarjeta: el turno es un recurso
    // compartido entre tarjetas (y con el Módulo B) — no debe
    // depender de que ESTA tarjeta específica llegue a crearse.
    // El temporal no tiene turno: ni se crea uno.
    const shift = esTemporal
      ? null
      : await this.upsertShift(supervisorId, dto.shiftDate, dto.shiftType);

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

        // Un equipo fuera de servicio o en taller no puede abrir turno —
        // salvo en la carga histórica de un día pasado (ver `pastShift`).
        if (!pastShift && equipo.status !== EquipmentStatus.OPERATIONAL) {
          throw new ConflictException({
            message: 'El equipo no está operativo',
            code: ERROR_CODES.EQUIPMENT_NOT_OPERATIONAL,
          });
        }
        await assertChecklistNotPending(tx, dto.equipoId, checklistDay);

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
              operador: operator?.name ?? '',
              operatorId: operator?.id ?? null,
              supervisorId,
              shiftId: shift?.id ?? null,
              temporal: esTemporal,
              fecha: pastShift
                ? businessDayInstant(
                    dto.shiftDate,
                    dto.shiftType === 'NOCTURNO' ? '20:30' : '12:00',
                  )
                : capturedAt,
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
   *
   * La tarjeta del supervisor temporal (`temporal`) no se cierra por acá:
   * se cierra con su informe, que llama con `opts.viaInforme` (sin turno de
   * quien cierra y con `closedShiftId = null`). Sin él, 409 `TEMPORAL_CARD`
   * — salvo el ADMIN, que puede cerrar cualquier tarjeta.
   */
  async closeCard(
    id: string,
    dto: CloseShiftCardDto,
    session: UserSession,
    opts?: { viaInforme?: boolean },
  ): Promise<ShiftCardResponse> {
    const viaInforme = opts?.viaInforme === true;
    const now = new Date();

    const card = await this.prisma.registroHorometro.findUnique({
      where: { id },
      // `shift` para fechar la carga de combustible en el día del turno en
      // que se ABRIÓ la tarjeta (ver `fuelShiftDay` más abajo).
      include: { shift: { select: { date: true, type: true } } },
    });
    if (!card) {
      throw new NotFoundException({
        message: 'Tarjeta no encontrada',
        code: ERROR_CODES.CARD_NOT_FOUND,
      });
    }

    const isAdmin = sessionHasRole(session.user.role, ROLES.ADMIN);
    // La tarjeta del supervisor temporal se cierra con su informe, junto con
    // las demás de su jornada — ni él ni otro supervisor la cierran suelta
    // (el ADMIN sí, como cualquier otra). Antes del chequeo de dueño: un
    // liviano temporal ajeno no debe llegar ni a decir «no es tuya».
    if (card.temporal && !viaInforme && !isAdmin) {
      throw this.temporalCard();
    }

    // El chequeo de dueño va INMEDIATAMENTE después del 404, ANTES que el
    // replay idempotente de abajo. Si no, un
    // supervisor B que reenviara (adivinado, filtrado, o simplemente
    // reintentado a mano) el `closeClientId` de una tarjeta A ajena caería en
    // la rama de replay, que devolvería la tarjeta COMPLETA de A —incluida la
    // URL firmada de su foto— sin pasar nunca por este chequeo.
    // Un vehículo LIVIANO lo puede cerrar cualquier supervisor: la carga de
    // combustible se hace a veces 24–48 h después, en otro turno, y no
    // siempre por quien abrió la tarjeta (pedido del cliente, 24/10). Los
    // pesados mantienen la regla de dueño — y la tarjeta temporal también,
    // aunque sea de un liviano: solo su supervisor la cierra (con el informe).
    const equipoCierre = await this.prisma.equipment.findUnique({
      where: { id: card.equipoId },
      select: { equipmentClass: true },
    });
    const esLiviano = equipoCierre?.equipmentClass === EquipmentClass.LIGHT;
    const cualquieraCierra = esLiviano && !card.temporal;
    if (
      card.supervisorId !== session.user.id &&
      !isAdmin &&
      !cualquieraCierra
    ) {
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
        message: `La lectura final (${formatNumber(dto.valorFinal)}) no puede ser menor que la inicial (${formatNumber(card.valorInicial)})`,
        code: ERROR_CODES.HOURMETER_BELOW_INITIAL,
      });
    }

    // Sin `fuelLiters` = 0 L; que pueda omitirse (solo el liviano con cargas
    // en curso) se valida en la tx, con la tarjeta tomada.
    const fuelLiters = dto.fuelLiters ?? 0;

    // La foto del surtidor respalda la CARGA: sin combustible (corte de luz,
    // no hubo carga) se cierra sin ella; con litros sigue siendo obligatoria.
    if (fuelLiters > 0 && !dto.tmpPhotoKey) {
      throw new BadRequestException({
        message:
          'Falta la foto del surtidor: es obligatoria cuando se carga combustible.',
        code: ERROR_CODES.FUEL_PHOTO_REQUIRED,
      });
    }

    // El liviano entra en el reporte de salida del turno de quien lo cierra.
    let closedShiftId: string | null = null;
    // Día de turno al que queda REPORTADA la tarjeta — ahí se fecha la carga
    // de combustible aunque el cierre real caiga en otro día de calendario,
    // incluso pasadas las 08:00 del día siguiente (pedido del cliente,
    // 13-11): pesados → el turno en que se abrió (`card.shift`, con fallback
    // por reloj de apertura); livianos → el turno de quien cierra (abajo).
    let fuelShiftDay = card.shift
      ? { day: formatDateOnly(card.shift.date), type: card.shift.type }
      : { day: shiftDayOf(card.fecha), type: card.turno };
    // Una tarjeta temporal NUNCA entra a un turno — ni cerrada por su informe
    // ni cerrada suelta por el ADMIN (que si no la colgaría de SU `Shift` y
    // se filtraría a su reporte de salida): no se exige ni se crea el turno
    // de quien cierra, `closedShiftId` queda `null` y la carga se fecha por
    // el reloj de apertura (`shiftDayOf(card.fecha)`, arriba).
    const sinTurno = viaInforme || card.temporal;
    if (esLiviano && !sinTurno) {
      if (!dto.shiftDate || !dto.shiftType) {
        throw new BadRequestException(
          'Falta el turno de quien cierra la tarjeta del liviano.',
        );
      }
      assertShiftDateWithinWindow(dto.shiftDate, now);
      closedShiftId = (
        await this.upsertShift(session.user.id, dto.shiftDate, dto.shiftType)
      ).id;
      fuelShiftDay = { day: dto.shiftDate, type: dto.shiftType };
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

    // Carga histórica: tarjeta de un día de negocio PASADO que se abrió HOY
    // (backfill). Su cierre se fecha en ese día histórico (reusando el
    // instante sintético que dejó la apertura) para que el dashboard y las
    // fichas agrupen la salida y el combustible donde corresponden. La doble
    // condición deja fuera al NOCTURNO vivo cerrado de madrugada y a la
    // tarjeta olvidada de hace días (createdAt viejo): esos cierres siguen
    // con la hora real.
    const esCargaHistorica =
      card.fecha != null &&
      card.createdAt != null &&
      isPastBusinessDay(businessDayKey(card.fecha), now) &&
      businessDayKey(card.createdAt) === todayInBusinessTimeZone(now);

    // Reclama la foto ANTES de la transacción (mismo patrón que
    // `CombustibleService.create`): si `claimTmp` falla (tmp vencido/ajeno),
    // todavía no hay nada que descartar. `claimTmp` traduce un tmp
    // vencido/inexistente a 400 `TMP_KEY_EXPIRED`. Sin foto (cierre sin
    // carga, 16/11/2026) no hay nada que reclamar.
    const pumpPhotoKey = dto.tmpPhotoKey
      ? await this.storage.claimTmp(
          dto.tmpPhotoKey,
          session.user.id,
          'fuel-photo',
        )
      : null;

    // `closed` se declara AFUERA del `try` y `this.shapeCard(closed!)` (que
    // llama `StorageService.sign`) corre
    // DESPUÉS de él — antes, `shapeCard` vivía DENTRO del mismo `try` que el
    // `catch` de abajo descarta `pumpPhotoKey`. Si `sign()` fallaba (red al
    // bucket) DESPUÉS de que la transacción ya hizo commit, ese `catch`
    // igual descartaba el objeto ya persistido en la fila — un objeto vivo,
    // referenciado en la base, borrado por un fallo post-commit ajeno a él.
    let closed: ShiftCardRecord | null;
    // La carga nacida del cierre (si hubo litros): la avisa `fuel.loaded`.
    // (`as`: se asigna dentro del callback de la tx; sin él TS la deja en `null`.)
    let cargaCierreId = null as string | null;
    const stockEvents: PendingStockEvents = [];
    try {
      closed = await this.prisma.$transaction(async (tx) => {
        // `updateMany` (no `update`) porque la condición de carrera vive en
        // el `where`: si otra request ya cerró la tarjeta entre el
        // `findUnique` de arriba y acá, `count` da 0 en vez de lanzar.
        const result = await tx.registroHorometro.updateMany({
          where: { id, valorFinal: null },
          data: {
            valorFinal: dto.valorFinal,
            fechaSalida: esCargaHistorica ? card.fecha : capturedAt,
            closedAt: now,
            closeClientId: dto.closeClientId,
            closedById: session.user.id,
            closedByName: session.user.name?.trim() || session.user.email,
            closedShiftId,
            fuelLiters,
            pumpPhotoKey,
            observaciones: dto.observaciones ?? null,
            noFuelReason: fuelLiters > 0 ? null : dto.noFuelReason || null,
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
        // Dentro de la tx, después del `updateMany` (que ya tiene la fila
        // tomada): una carga en curso concurrente o quedó confirmada antes y
        // se ve acá, o espera y encuentra la tarjeta cerrada.
        await this.assertFinalCoversFuelLoads(tx, id, dto.valorFinal);
        // El liviano que ya cargó con la tarjeta abierta cierra solo con km
        // final y observaciones: litros, foto, AdBlue y motivo sin carga son
        // opcionales. Sin cargas en curso (y siempre en un pesado, que no
        // puede tenerlas) los litros siguen siendo obligatorios.
        const cargasPrevias = await tx.registroCombustible.count({
          where: { tarjetaEnCursoId: id },
        });
        if (dto.fuelLiters === undefined && cargasPrevias === 0) {
          throw new BadRequestException({
            message: 'Indica los litros cargados al cerrar (0 si no cargó).',
            code: ERROR_CODES.FUEL_LITERS_REQUIRED,
          });
        }
        if (cargasPrevias > 0 && fuelLiters === 0 && dto.noFuelReason) {
          // Con cargas en curso no hubo «cierre sin carga»: no se guarda.
          await tx.registroHorometro.update({
            where: { id },
            data: { noFuelReason: null },
          });
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
        if (fuelLiters > 0) {
          const creada = await tx.registroCombustible.create({
            select: { id: true },
            data: {
              equipoId: card.equipoId,
              litros: fuelLiters,
              tipo: DEFAULT_SHIFT_CLOSE_FUEL_TYPE,
              // Comparte la MISMA key que la tarjeta — así la carga aparece
              // sola en la ficha y en el historial de combustible sin
              // duplicar la foto.
              fotoKey: pumpPhotoKey,
              // Cierre vivo: la carga se fecha en el día del turno reportado
              // (`fuelShiftDay`), no en el día de calendario del cierre.
              fecha: esCargaHistorica
                ? card.fecha
                : fuelDateForShiftDay(
                    photoCapturedAt,
                    fuelShiftDay.day,
                    fuelShiftDay.type,
                  ),
              registroHorometroId: id,
            },
          });
          cargaCierreId = creada.id;
        }

        // El AdBlue declarado descuenta el ítem AdBlue de Inventario en la
        // MISMA transacción del cierre (el reintento idempotente de arriba
        // nunca llega acá, así que no se descuenta dos veces).
        if (dto.adBlue && (dto.adBlueLiters ?? 0) > 0) {
          await this.adBlueStock.discountLoad(
            { tx, events: stockEvents },
            {
              liters: dto.adBlueLiters as number,
              equipmentId: card.equipoId,
              performedById: session.user.id,
              reference: id,
            },
          );
        }

        return tx.registroHorometro.findUnique({
          where: { id },
          include: SHIFT_CARD_INCLUDE,
        });
      });
    } catch (error) {
      // Cualquier falla DESPUÉS del claim exige descartar la copia recién
      // creada — nunca dejar un objeto huérfano en el bucket.
      if (pumpPhotoKey) await this.storage.discard(pumpPhotoKey);

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
    // Un aviso de stock bajo dentro de una transacción revertida alertaría de
    // un saldo que nunca existió: se emite recién confirmada.
    this.adBlueStock.emitPending(stockEvents);

    // Carga de combustible de una camioneta al cerrar → aviso al admin (los
    // pesados no avisan). Recién confirmada, y nunca en el replay (que vuelve
    // antes, sin crear carga).
    if (esLiviano && cargaCierreId && closed) {
      this.emitFuelLoaded({
        cargaId: cargaCierreId,
        cardId: id,
        equipmentId: card.equipoId,
        equipmentCode: closed.equipo.internalCode,
        liters: fuelLiters,
        reading: dto.valorFinal,
        unit: closed.equipo.controlUnit === ControlUnit.HOURS ? 'h' : 'km',
        origin: 'CIERRE',
        session,
      });
    }

    return this.shapeCard(closed!);
  }

  /**
   * `POST /api/shift-cards/:id/fuel-loads` — carga de combustible en una
   * tarjeta de liviano ABIERTA, SIN cerrarla (pedido del cliente: a veces se
   * carga y la camioneta se sigue usando). Se puede repetir; la tarjeta se
   * cierra después con el cierre normal. Los pesados no cambian: cargar
   * sigue siendo cerrar (400 `FUEL_LOAD_LIGHT_ONLY`).
   *
   * La carga es una fila de `RegistroCombustible` con `tarjetaEnCursoId`
   * (1:N) — NUNCA `registroHorometroId`, que sigue siendo la 1:1 del cierre
   * que sincronizan `syncFuelRecord`/la edición. Lleva su propia `lectura`
   * (km al cargar), su AdBlue y su `createdById`: para el resto del sistema
   * es una carga con lectura propia, como la manual del panel.
   *
   * Idempotente por `dto.id` (PK de la carga, generado por el cliente): el
   * reintento propio devuelve la tarjeta sin repetir efectos (claim de la
   * foto, contador, descuento de AdBlue); un id de otro usuario es 409
   * `ID_CONFLICT`. Devuelve la tarjeta completa (con `fuelLoads`).
   */
  async addFuelLoad(
    id: string,
    dto: CreateShiftCardFuelLoadDto,
    session: UserSession,
  ): Promise<ShiftCardResponse> {
    return createOrReturn({
      id: dto.id,
      userId: session.user.id,
      conflictMessage: 'Ya existe una carga con ese id de otro usuario',
      findExisting: async (loadId) => {
        const existing = await this.prisma.registroCombustible.findUnique({
          where: { id: loadId },
          select: { createdById: true, tarjetaEnCursoId: true },
        });
        if (!existing) return null;
        return {
          // Un id que ya usó OTRA fila (otra tarjeta, o una carga que no es
          // de tarjeta en curso) es un choque aunque sea del mismo usuario:
          // devolver esta tarjeta haría creer que la carga quedó acá.
          ownerId:
            existing.tarjetaEnCursoId === id ? existing.createdById : null,
          result: async () => this.shapeCard(await this.reloadCard(id)),
        };
      },
      create: () => this.createFuelLoad(id, dto, session),
    });
  }

  private async createFuelLoad(
    id: string,
    dto: CreateShiftCardFuelLoadDto,
    session: UserSession,
  ): Promise<ShiftCardResponse> {
    const now = new Date();
    const card = await this.prisma.registroHorometro.findUnique({
      where: { id },
      select: {
        equipoId: true,
        valorInicial: true,
        valorFinal: true,
        closedAt: true,
        temporal: true,
        equipo: {
          select: {
            internalCode: true,
            equipmentClass: true,
            controlUnit: true,
            currentHourmeter: true,
            currentMileage: true,
          },
        },
      },
    });
    if (!card) throw this.cardNotFound();
    // La tarjeta temporal informa su combustible al cerrarse con el informe:
    // no admite cargas en curso de nadie (ni del ADMIN), que quedarían
    // colgando de una tarjeta que no se cierra por el flujo normal.
    if (card.temporal) throw this.temporalCard();

    // Sin chequeo de dueño: un liviano lo puede cerrar cualquier supervisor
    // (ver `closeCard`), y cargarle combustible es parte de ese mismo flujo.
    if (card.equipo.equipmentClass !== EquipmentClass.LIGHT) {
      throw new BadRequestException({
        message:
          'Solo los vehículos livianos registran cargas sin cerrar la tarjeta: en un equipo pesado la carga se informa al cerrarla.',
        code: ERROR_CODES.FUEL_LOAD_LIGHT_ONLY,
      });
    }
    if (card.valorFinal != null) {
      throw new ConflictException({
        message: this.buildAlreadyClosedMessage(card.closedAt),
        code: ERROR_CODES.ALREADY_CLOSED,
      });
    }
    if (dto.reading < card.valorInicial) {
      throw new BadRequestException({
        message: `La lectura al cargar (${formatNumber(dto.reading)}) no puede ser menor que la inicial de la tarjeta (${formatNumber(card.valorInicial)})`,
        code: ERROR_CODES.HOURMETER_BELOW_INITIAL,
      });
    }
    if (dto.shiftDate) assertShiftDateWithinWindow(dto.shiftDate, now);

    // Hora del dispositivo: fuera de rango cae a la del servidor (nunca
    // rechaza, ver `capture-time.ts`); la EXIF de la foto, inválida, se
    // ignora — mismo trato que el cierre.
    const { at: capturedAt } = resolveCapturedAt(dto.capturedAt, now);
    const photoCapturedAt = resolveCapturedAtWithFallback(
      dto.photoCapturedAt,
      capturedAt,
      now,
    );
    // Misma regla de fechado que el cierre del liviano: la carga va al día
    // del turno de quien la registra. Sin turno informado manda el reloj
    // (`shiftDayOf`): solo la madrugada cae en otro día de calendario, y esa
    // hora siempre es del NOCTURNO.
    const fecha =
      dto.shiftDate && dto.shiftType
        ? fuelDateForShiftDay(photoCapturedAt, dto.shiftDate, dto.shiftType)
        : fuelDateForShiftDay(
            photoCapturedAt,
            shiftDayOf(photoCapturedAt),
            'NOCTURNO',
          );

    // Reclama la foto ANTES de la transacción (mismo patrón que el cierre):
    // si falla, todavía no hay nada que descartar.
    const fotoKey = await this.storage.claimTmp(
      dto.tmpPhotoKey,
      session.user.id,
      'fuel-photo',
    );

    const stockEvents: PendingStockEvents = [];
    try {
      await this.prisma.$transaction(async (tx) => {
        // Bloquea la tarjeta: un cierre concurrente espera a que esta carga
        // se confirme (queda ANTES del cierre) o, si ganó él, acá se ve ya
        // cerrada y la carga se rechaza.
        await lockRow(tx, 'registroHorometro', id);
        const vigente = await tx.registroHorometro.findUnique({
          where: { id },
          select: { valorFinal: true, closedAt: true },
        });
        if (!vigente) throw this.cardNotFound();
        if (vigente.valorFinal != null) {
          throw new ConflictException({
            message: this.buildAlreadyClosedMessage(vigente.closedAt),
            code: ERROR_CODES.ALREADY_CLOSED,
          });
        }

        await tx.registroCombustible.create({
          data: {
            id: dto.id,
            createdById: session.user.id,
            equipoId: card.equipoId,
            litros: dto.liters,
            tipo: DEFAULT_SHIFT_CLOSE_FUEL_TYPE,
            fotoKey,
            fecha,
            lectura: dto.reading,
            adBlueLitros: dto.adBlueLiters ?? null,
            tarjetaEnCursoId: id,
          },
        });

        // Modo 'warn', igual que el alta manual con lectura: adelanta el km
        // del equipo, nunca lo retrocede ni rechaza la carga.
        await reconcileEquipmentCounter(
          tx,
          card.equipoId,
          card.equipo,
          dto.reading,
          'warn',
        );

        // El AdBlue de la carga descuenta Inventario en la misma transacción
        // (el reintento idempotente nunca llega acá).
        if ((dto.adBlueLiters ?? 0) > 0) {
          await this.adBlueStock.discountLoad(
            { tx, events: stockEvents },
            {
              liters: dto.adBlueLiters as number,
              equipmentId: card.equipoId,
              performedById: session.user.id,
              reference: dto.id,
            },
          );
        }
      });
    } catch (error) {
      // Nunca dejar la copia reclamada huérfana en el bucket. Se descarta
      // ANTES de que `createOrReturn` relea una posible carrera por el id.
      await this.storage.discard(fotoKey);
      throw error;
    }
    this.adBlueStock.emitPending(stockEvents);
    // Recién confirmada; el reintento idempotente nunca pasa por acá.
    this.emitFuelLoaded({
      cargaId: dto.id,
      cardId: id,
      equipmentId: card.equipoId,
      equipmentCode: card.equipo.internalCode,
      liters: dto.liters,
      reading: dto.reading,
      unit: card.equipo.controlUnit === ControlUnit.HOURS ? 'h' : 'km',
      origin: 'TARJETA_ABIERTA',
      session,
    });

    return this.shapeCard(await this.reloadCard(id));
  }

  /**
   * `POST /api/shift-cards/closed` — registro histórico de un turno YA
   * TERMINADO: la tarjeta nace CERRADA (apertura + cierre + combustible en
   * una sola transacción). Al no existir nunca una fila con `valorFinal:
   * null`, el backfill no pisa el índice parcial de tarjeta abierta ni choca
   * con una tarjeta abierta HOY del mismo equipo — el presente no interfiere
   * en el pasado ni al revés. Por lo mismo acá NO hay chequeo de
   * `EQUIPMENT_BUSY` ni de equipo operativo (misma relajación que la
   * apertura con `pastShift`); el checklist del día sí sigue siendo
   * requisito. Idempotente por `dto.id` (replay devuelve la existente sin
   * reclamar la foto de nuevo) y por `closeClientId` (`@unique`).
   */
  async registerClosedCard(
    dto: RegisterClosedShiftCardDto,
    session: UserSession,
    clientTimeHeader?: string,
  ): Promise<ShiftCardResponse> {
    const now = new Date();
    assertShiftDateWithinWindow(dto.shiftDate, now);
    if (!isPastShift(dto.shiftDate, dto.shiftType, now)) {
      throw new BadRequestException({
        message:
          'El turno aún no termina: regístralo abriendo y cerrando la tarjeta.',
        code: ERROR_CODES.SHIFT_NOT_FINISHED,
      });
    }
    // `fecha` es SIEMPRE el instante sintético del día histórico — la hora
    // del dispositivo solo se audita como desfase, igual que en la apertura.
    const { discardedSkewMs } = resolveCapturedAt(dto.capturedAt, now);
    const clientClockSkewMs =
      computeClientClockSkewMs(clientTimeHeader, now) ?? discardedSkewMs;

    if (dto.valorFinal < dto.valorInicial) {
      throw new BadRequestException({
        message: `La lectura final (${formatNumber(dto.valorFinal)}) no puede ser menor que la inicial (${formatNumber(dto.valorInicial)})`,
        code: ERROR_CODES.HOURMETER_BELOW_INITIAL,
      });
    }

    const operator = dto.operatorId
      ? await this.operators.assertActive(dto.operatorId)
      : null;

    const equipoPrecheck = await this.prisma.equipment.findUnique({
      where: { id: dto.equipoId },
      select: { equipmentClass: true },
    });
    if (!equipoPrecheck) throw new NotFoundException('Equipo no encontrado');
    if (
      (sessionHasRole(session.user.role, ROLES.MANTENEDOR) ||
        sessionHasRole(session.user.role, ROLES.PREVENCIONISTA)) &&
      equipoPrecheck.equipmentClass !== EquipmentClass.LIGHT
    ) {
      throw new ForbiddenException(
        'Solo puedes registrar el uso de vehículos livianos.',
      );
    }
    if (!operator && equipoPrecheck.equipmentClass !== EquipmentClass.LIGHT) {
      throw new BadRequestException('Elige el operador del equipo.');
    }
    await assertChecklistNotPending(
      this.prisma,
      dto.equipoId,
      parseDateOnlyUtc(dto.shiftDate),
    );

    const supervisorId = session.user.id;

    // Replay ANTES de reclamar la foto (mismo criterio que el cierre): un
    // reintento cuyo registro ya está aplicado no reclama la key de nuevo.
    const previa = await this.prisma.registroHorometro.findUnique({
      where: { id: dto.id },
      include: SHIFT_CARD_INCLUDE,
    });
    if (previa) {
      if (
        previa.supervisorId === supervisorId &&
        previa.equipoId === dto.equipoId
      ) {
        return this.shapeCard(previa);
      }
      throw new ConflictException({
        message:
          'Ya existe una tarjeta con ese id para otro equipo o supervisor',
        code: ERROR_CODES.ID_CONFLICT,
      });
    }

    const shift = await this.upsertShift(
      supervisorId,
      dto.shiftDate,
      dto.shiftType,
    );
    const historicalInstant = businessDayInstant(
      dto.shiftDate,
      dto.shiftType === 'NOCTURNO' ? '20:30' : '12:00',
    );

    const pumpPhotoKey = await this.storage.claimTmp(
      dto.tmpPhotoKey,
      session.user.id,
      'fuel-photo',
    );

    let created: ShiftCardRecord | null;
    // La carga nacida del registro (si hubo litros): la avisa `fuel.loaded`.
    // (`as`: se asigna dentro del callback de la tx; sin él TS la deja en `null`.)
    let cargaRegistradaId = null as string | null;
    const stockEvents: PendingStockEvents = [];
    try {
      created = await this.prisma.$transaction(async (tx) => {
        const equipo = await tx.equipment.findUnique({
          where: { id: dto.equipoId },
          select: {
            equipmentClass: true,
            controlUnit: true,
            currentHourmeter: true,
            currentMileage: true,
          },
        });
        if (!equipo) throw new NotFoundException('Equipo no encontrado');
        await assertChecklistNotPending(
          tx,
          dto.equipoId,
          parseDateOnlyUtc(dto.shiftDate),
        );

        // `belowPreviousReading` espeja el flujo de dos pasos: la INICIAL se
        // compara contra el contador vigente ANTES de reconciliar, y la
        // FINAL reconcilia en modo `'warn'` (una lectura histórica menor se
        // audita, nunca mueve el contador hacia atrás — ver el comentario
        // del cierre sobre por qué acá jamás va `'reject'`).
        const vigente =
          equipo.controlUnit === ControlUnit.HOURS
            ? equipo.currentHourmeter
            : equipo.currentMileage;
        const initialBelow = vigente != null && dto.valorInicial < vigente;
        const { belowPrevious } = await reconcileEquipmentCounter(
          tx,
          dto.equipoId,
          equipo,
          dto.valorFinal,
          'warn',
        );

        const esLiviano = equipo.equipmentClass === EquipmentClass.LIGHT;

        try {
          const card = await tx.registroHorometro.create({
            data: {
              id: dto.id,
              equipoId: dto.equipoId,
              valorInicial: dto.valorInicial,
              valorFinal: dto.valorFinal,
              turno: dto.shiftType,
              operador: operator?.name ?? '',
              operatorId: operator?.id ?? null,
              supervisorId,
              shiftId: shift.id,
              fecha: historicalInstant,
              fechaSalida: historicalInstant,
              closedAt: now,
              closeClientId: dto.closeClientId,
              closedById: session.user.id,
              closedByName: session.user.name?.trim() || session.user.email,
              // El liviano entra en el reporte de salida del turno de quien
              // lo registra — mismo criterio que el cierre normal.
              closedShiftId: esLiviano ? shift.id : null,
              fuelLiters: dto.fuelLiters,
              pumpPhotoKey,
              observaciones: dto.observaciones ?? null,
              adBlue: dto.adBlue ?? false,
              adBlueLiters: dto.adBlue ? (dto.adBlueLiters ?? null) : null,
              clientClockSkewMs: clientClockSkewMs ?? null,
              belowPreviousReading: initialBelow || belowPrevious,
            },
            include: SHIFT_CARD_INCLUDE,
          });

          if (dto.fuelLiters > 0) {
            // Mismo criterio que el cierre: `lectura` queda null porque su
            // lectura ES el `valorFinal` de la tarjeta vinculada.
            const creada = await tx.registroCombustible.create({
              select: { id: true },
              data: {
                equipoId: dto.equipoId,
                litros: dto.fuelLiters,
                tipo: DEFAULT_SHIFT_CLOSE_FUEL_TYPE,
                fotoKey: pumpPhotoKey,
                fecha: historicalInstant,
                registroHorometroId: dto.id,
              },
            });
            cargaRegistradaId = creada.id;
          }

          // Igual que el cierre vivo: el AdBlue del turno histórico también
          // descuenta Inventario (la carrera por `id` relee afuera y no pasa
          // por acá, así que el reintento no duplica el asiento).
          if (dto.adBlue && (dto.adBlueLiters ?? 0) > 0) {
            await this.adBlueStock.discountLoad(
              { tx, events: stockEvents },
              {
                liters: dto.adBlueLiters as number,
                equipmentId: dto.equipoId,
                performedById: session.user.id,
                reference: dto.id,
              },
            );
          }

          return card;
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
    } catch (error) {
      // Cualquier falla DESPUÉS del claim exige descartar la copia recién
      // creada — nunca dejar un objeto huérfano en el bucket.
      await this.storage.discard(pumpPhotoKey);

      if (error instanceof ShiftCardIdRaceError) {
        // `id` (PK) o `closeClientId` (@unique) chocaron en una carrera —
        // se relee AFUERA de la tx abortada. No se usa `resolveOpenRace`:
        // su rama de miss asume una tarjeta abierta (EQUIPMENT_BUSY), que
        // acá no existe.
        const existing = await this.prisma.registroHorometro.findUnique({
          where: { id: dto.id },
          include: SHIFT_CARD_INCLUDE,
        });
        if (
          existing &&
          existing.supervisorId === supervisorId &&
          existing.equipoId === dto.equipoId
        ) {
          return this.shapeCard(existing);
        }
        throw new ConflictException({
          message: 'Ya existe un registro con ese identificador',
          code: ERROR_CODES.ID_CONFLICT,
        });
      }
      throw error;
    }
    this.adBlueStock.emitPending(stockEvents);

    // Mismo aviso que el cierre vivo: camioneta con litros → admin. El replay
    // por `dto.id` vuelve antes y nunca llega acá.
    if (
      cargaRegistradaId &&
      created &&
      created.equipo.equipmentClass === EquipmentClass.LIGHT
    ) {
      this.emitFuelLoaded({
        cargaId: cargaRegistradaId,
        cardId: dto.id,
        equipmentId: dto.equipoId,
        equipmentCode: created.equipo.internalCode,
        liters: dto.fuelLiters,
        reading: dto.valorFinal,
        unit: created.equipo.controlUnit === ControlUnit.HOURS ? 'h' : 'km',
        origin: 'CIERRE',
        session,
      });
    }

    return this.shapeCard(created);
  }

  /**
   * `PATCH /api/shift-cards/:id` — corrige una tarjeta ya enviada. Solo el
   * supervisor dueño o un ADMIN; la SECRETARIA, solo una tarjeta temporal.
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

    // Turno de destino: upsert FUERA de la transacción, igual que en
    // `openCard` — el `Shift` es un recurso compartido entre tarjetas y con
    // el Módulo B, no debe depender de que ESTA edición se confirme. Mismo
    // día y mismo supervisor del turno original, solo cambia el tipo; una
    // tarjeta legacy sin `Shift` solo corrige su columna `turno`.
    const shiftDestino =
      dto.turno !== undefined &&
      previa.shift != null &&
      dto.turno !== previa.shift.type
        ? await this.upsertShift(
            previa.shift.supervisorId,
            formatDateOnly(previa.shift.date),
            dto.turno,
          )
        : null;

    let edit: ShiftCardEdit;
    const stockEvents: PendingStockEvents = [];
    try {
      edit = await this.prisma.$transaction((tx): Promise<ShiftCardEdit> =>
        this.applyEdit(
          tx,
          id,
          dto,
          operator,
          editor,
          expected,
          shiftDestino,
          stockEvents,
        ),
      );
    } catch (error) {
      if (error instanceof ShiftCardMoveRaceError) {
        // Carrera contra el índice parcial de tarjeta abierta al mover una
        // ABIERTA a otro equipo (alguien le abrió tarjeta entre el pre-check
        // y el update) — mismo contrato que `resolveOpenRace`.
        throw new ConflictException({
          message: 'El equipo ya tiene una tarjeta de turno abierta',
          code: ERROR_CODES.EQUIPMENT_BUSY,
        });
      }
      throw error;
    }
    const { card, event } = edit;
    this.adBlueStock.emitPending(stockEvents);

    if (event) this.eventEmitter.emit(DOMAIN_EVENTS.RECORD_EDITED, event);
    return this.shapeCard(card);
  }

  /** `GET /api/shift-cards/:id/changes` — dueño o ADMIN. */
  async findChanges(id: string, session: UserSession) {
    await this.findOwnedCard(id, session);
    return this.changeLog.findFor('shift_card', id);
  }

  /**
   * `DELETE /api/shift-cards/:id` — elimina una tarjeta, abierta o cerrada
   * (dueño o ADMIN). Borra también la carga de combustible nacida de su
   * cierre; ambas dejan su propia fila `DELETE` en el historial dentro de la
   * MISMA transacción (un borrado sin rastro es justo lo que el registro de
   * actividad debe impedir) y se avisa al administrador, igual que una
   * edición. Eliminar una ABIERTA además libera el "slot" de uso del equipo
   * (la fila abierta y la asignación, mismo trato que `adminCloseCard`). La
   * foto del surtidor se suelta best-effort DESPUÉS del borrado (si este
   * falla, la foto sigue donde debe): la comparten solo la tarjeta y su
   * carga vinculada, y acá se van las dos.
   *
   * Las cargas registradas con la tarjeta ABIERTA (`cargasEnCurso`, solo
   * livianos) se van con ella, igual que la del cierre: cada una deja su
   * `DELETE` en el historial, devuelve su AdBlue a Inventario (lo había
   * descontado ella, no la tarjeta), suelta su lectura del contador y su
   * foto (propia, no compartida) best-effort después del borrado.
   *
   * Los contadores del equipo no se tocan: nunca retroceden (misma política
   * que la edición de lecturas).
   */
  async removeCard(id: string, session: UserSession): Promise<void> {
    // Sin `cargasEnCurso`: se releen bajo el bloqueo, dentro de la tx.
    const card = await this.prisma.registroHorometro.findUnique({
      where: { id },
      include: {
        equipo: SHIFT_CARD_INCLUDE.equipo,
        shift: SHIFT_CARD_INCLUDE.shift,
      },
    });
    if (!card) throw this.cardNotFound();
    const isAdmin = sessionHasRole(session.user.role, ROLES.ADMIN);
    if (card.supervisorId !== session.user.id && !isAdmin) {
      throw new ForbiddenException({
        message: 'No puedes eliminar la tarjeta de otro supervisor',
        code: ERROR_CODES.NOT_OWNER,
      });
    }
    const abierta = card.valorFinal === null;
    const editor = toEditor(session.user);
    // Qué decía la tarjeta al borrarla, ya legible — el `before` del
    // historial. `after` queda en «—»: después del borrado no hay registro.
    const borrado = (field: string, label: string, before: string) => ({
      field,
      label,
      before,
      after: '—',
    });
    const rotuloTurno = card.shift
      ? `${TURNO_LABEL[card.shift.type] ?? card.shift.type} del ${formatDateOnlyForHumans(card.shift.date)}`
      : `${TURNO_LABEL[card.turno] ?? card.turno} del ${formatBusinessDate(card.fecha)}`;
    const resumen = [
      borrado('equipoId', CAMPO_LABEL.equipoId, card.equipo.internalCode),
      borrado('operatorId', CAMPO_LABEL.operatorId, card.operador),
      borrado('turno', CAMPO_LABEL.turno, rotuloTurno),
      borrado(
        'valorInicial',
        CAMPO_LABEL.valorInicial,
        formatNumber(card.valorInicial),
      ),
      borrado(
        'valorFinal',
        CAMPO_LABEL.valorFinal,
        card.valorFinal != null ? formatNumber(card.valorFinal) : '—',
      ),
      borrado(
        'fuelLiters',
        CAMPO_LABEL.fuelLiters,
        card.fuelLiters != null ? formatNumber(card.fuelLiters) : '—',
      ),
    ];

    const vinculada = await this.prisma.registroCombustible.findUnique({
      where: { registroHorometroId: id },
      select: { id: true, litros: true, fecha: true },
    });
    // Se releen DENTRO de la transacción, con la tarjeta bloqueada: una
    // carga en curso concurrente (`addFuelLoad` también bloquea la tarjeta)
    // o quedó confirmada antes y se borra acá, o espera y ve la tarjeta ya
    // borrada (404). Afuera solo se usan para soltar sus fotos.
    let cargasEnCurso: ShiftCardRecord['cargasEnCurso'] = [];

    const stockEvents: PendingStockEvents = [];
    await this.prisma.$transaction(async (tx) => {
      if (!(await lockRow(tx, 'registroHorometro', id))) {
        throw this.cardNotFound();
      }
      cargasEnCurso = await tx.registroCombustible.findMany({
        where: { tarjetaEnCursoId: id },
        select: CARGA_EN_CURSO_SELECT,
      });
      await this.changeLog.record(
        tx,
        'shift_card',
        id,
        editor,
        resumen,
        'DELETE',
      );
      if (vinculada) {
        await this.changeLog.record(
          tx,
          'combustible',
          vinculada.id,
          editor,
          [
            borrado('equipo', 'Equipo', card.equipo.internalCode),
            borrado('litros', 'Litros', formatNumber(vinculada.litros)),
            borrado('fecha', 'Fecha', formatBusinessDateTime(vinculada.fecha)),
            borrado('origen', 'Origen', 'Cierre de tarjeta'),
          ],
          'DELETE',
        );
        await tx.registroCombustible.delete({ where: { id: vinculada.id } });
      }
      for (const carga of cargasEnCurso) {
        await this.changeLog.record(
          tx,
          'combustible',
          carga.id,
          editor,
          [
            borrado('equipo', 'Equipo', card.equipo.internalCode),
            borrado('litros', 'Litros', formatNumber(carga.litros)),
            borrado('fecha', 'Fecha', formatBusinessDateTime(carga.fecha)),
            borrado(
              'lectura',
              'Lectura',
              carga.lectura != null ? formatNumber(carga.lectura) : '—',
            ),
            borrado('origen', 'Origen', 'Carga con tarjeta en curso'),
          ],
          'DELETE',
        );
        if ((carga.adBlueLitros ?? 0) > 0) {
          await this.adBlueStock.restoreLoad(
            { tx, events: stockEvents },
            {
              liters: carga.adBlueLitros as number,
              equipmentId: card.equipoId,
              performedById: editor.id,
              reference: carga.id,
              notes: `Devolución por tarjeta eliminada: AdBlue ${formatNumber(carga.adBlueLitros as number)} L`,
            },
          );
        }
      }
      if (cargasEnCurso.length > 0) {
        const { count } = await tx.registroCombustible.deleteMany({
          where: { id: { in: cargasEnCurso.map((carga) => carga.id) } },
        });
        // Con la tarjeta bloqueada no debería faltar ninguna; si faltara
        // (otra vía de borrado), su AdBlue ya se habría devuelto dos veces:
        // se revierte todo y se pide reintentar.
        if (count !== cargasEnCurso.length) {
          throw new ConflictException({
            message:
              'Las cargas de la tarjeta cambiaron mientras se eliminaba. Vuelve a intentarlo.',
            code: ERROR_CODES.STALE_UPDATE,
          });
        }
      }
      // El AdBlue que la tarjeta había descontado vuelve al saldo: borrar el
      // registro deja el inventario como si la carga no se hubiera declarado.
      if (card.adBlue && (card.adBlueLiters ?? 0) > 0) {
        await this.adBlueStock.restoreLoad(
          { tx, events: stockEvents },
          {
            liters: card.adBlueLiters as number,
            equipmentId: card.equipoId,
            performedById: editor.id,
            reference: id,
            notes: `Devolución por tarjeta eliminada: AdBlue ${formatNumber(card.adBlueLiters as number)} L`,
          },
        );
      }
      await tx.registroHorometro.delete({ where: { id } });
      // Si la lectura de esta tarjeta había fijado el contador del equipo
      // (p. ej. un typo), el contador vuelve a la más alta que queda.
      await releaseRemovedReading(
        tx,
        card.equipoId,
        Math.max(
          card.valorInicial,
          card.valorFinal ?? card.valorInicial,
          ...cargasEnCurso.map((carga) => carga.lectura ?? 0),
        ),
      );
      if (abierta) {
        // El uso en curso desaparece con la fila: se suelta también la
        // asignación del equipo (mismo trato que `adminCloseCard`).
        await tx.equipment.update({
          where: { id: card.equipoId },
          data: { currentOperatorId: null, currentSupervisorId: null },
        });
      }
    });
    this.adBlueStock.emitPending(stockEvents);

    const event: RecordEditedEvent = {
      entity: 'shift_card',
      entityId: id,
      entityArticle: 'la',
      entityLabel: `tarjeta de turno de ${card.equipo.internalCode} del ${
        card.shift
          ? formatDateOnlyForHumans(card.shift.date)
          : formatBusinessDate(card.fecha)
      }`,
      editedBy: editor.name,
      deleted: true,
      changes: resumen.map(({ label, before, after }) => ({
        label,
        before,
        after,
      })),
    };
    this.eventEmitter.emit(DOMAIN_EVENTS.RECORD_EDITED, event);

    if (card.pumpPhotoKey) {
      await this.storage.deleteBestEffort(card.pumpPhotoKey);
    }
    for (const carga of cargasEnCurso) {
      if (carga.fotoKey) await this.storage.deleteBestEffort(carga.fotoKey);
    }
  }

  private async applyEdit(
    tx: Prisma.TransactionClient,
    id: string,
    dto: UpdateShiftCardDto,
    operator: { id: string; name: string } | null,
    editor: Editor,
    expected: ExpectedValues | undefined,
    /** Turno al que se mueve la tarjeta cuando la edición corrige `turno`
     * (upserteado por `update()` FUERA de esta transacción). */
    shiftDestino: { id: string; date: Date; type: string } | null = null,
    /** Buzón de avisos de stock del descuento de AdBlue — `update()` los
     * emite DESPUÉS de confirmar la transacción. */
    stockEvents: PendingStockEvents = [],
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

    // Cambio de máquina: debe existir y ser de la MISMA clase que la
    // original (un pesado va en horas y exige operador; un liviano va en km
    // y no lleva) — cruzar la clase cambiaría las reglas de la tarjeta.
    const equipoNuevo =
      dto.equipoId !== undefined && dto.equipoId !== actual.equipoId
        ? await tx.equipment.findUnique({
            where: { id: dto.equipoId },
            select: {
              internalCode: true,
              equipmentClass: true,
              controlUnit: true,
              currentHourmeter: true,
              currentMileage: true,
            },
          })
        : null;
    if (dto.equipoId !== undefined && dto.equipoId !== actual.equipoId) {
      if (!equipoNuevo) {
        throw new NotFoundException('Equipo no encontrado');
      }
      if (equipoNuevo.equipmentClass !== actual.equipo.equipmentClass) {
        throw new BadRequestException(
          actual.equipo.equipmentClass === EquipmentClass.LIGHT
            ? 'La tarjeta es de un vehículo liviano: elige otro liviano.'
            : 'La tarjeta es de un equipo pesado: elige otro equipo pesado.',
        );
      }
      // Mover una tarjeta ABIERTA ocupa el "slot" de uso del equipo destino:
      // mismo chequeo que la apertura (una sola abierta por equipo). El
      // índice parcial de tarjeta abierta es la garantía dura — una carrera
      // se traduce afuera como `EQUIPMENT_BUSY` (`ShiftCardMoveRaceError`).
      // No se exige equipo operativo ni checklist: es una corrección de algo
      // que ya salió, no un despacho nuevo.
      if (actual.valorFinal == null) {
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
      }
    }

    if (
      despues.valorFinal != null &&
      despues.valorFinal < despues.valorInicial
    ) {
      throw new BadRequestException({
        message: `La lectura final (${formatNumber(despues.valorFinal)}) no puede ser menor que la inicial (${formatNumber(despues.valorInicial)})`,
        code: ERROR_CODES.HOURMETER_BELOW_INITIAL,
      });
    }
    // Las cargas registradas con la tarjeta abierta fijan km intermedios: la
    // corrección no puede dejar la inicial por encima de ninguna ni la final
    // por debajo (la fila ya está bloqueada, así que no entra otra carga).
    const lecturasCargas = actual.cargasEnCurso
      .map((carga) => carga.lectura)
      .filter((lectura): lectura is number => lectura != null);
    // Solo si la edición toca las lecturas: corregir observaciones, operador
    // o turno no debe fallar por datos viejos.
    if (lecturasCargas.length > 0) {
      const minima = Math.min(...lecturasCargas);
      if (
        despues.valorInicial !== antes.valorInicial &&
        despues.valorInicial > minima
      ) {
        throw new BadRequestException({
          message: `La lectura inicial (${formatNumber(despues.valorInicial)}) no puede ser mayor que la de una carga de combustible registrada en la tarjeta (${formatNumber(minima)})`,
          code: ERROR_CODES.INITIAL_ABOVE_FUEL_LOAD,
        });
      }
      if (
        despues.valorFinal != null &&
        despues.valorFinal !== antes.valorFinal
      ) {
        this.assertReadingCoversFuelLoads(
          despues.valorFinal,
          Math.max(...lecturasCargas),
        );
      }
    }
    const adBlueProblema = adBlueError(despues.adBlue, despues.adBlueLiters);
    if (adBlueProblema) throw new BadRequestException(adBlueProblema);

    const nombreOperador = operadorNuevo?.name ?? actual.operador;
    const nombres = new Map<string | null, string>([
      [actual.operatorId, actual.operador],
      [despues.operatorId, nombreOperador],
    ]);
    const codigosEquipo = new Map<string, string>([
      [actual.equipoId, actual.equipo.internalCode],
      [
        despues.equipoId,
        equipoNuevo?.internalCode ?? actual.equipo.internalCode,
      ],
    ]);
    const cambios = diffFields<DatosTarjeta>(antes, despues, [
      {
        field: 'operatorId',
        label: CAMPO_LABEL.operatorId,
        format: (v) => nombres.get(v as string | null) ?? '—',
      },
      {
        field: 'equipoId',
        label: CAMPO_LABEL.equipoId,
        format: (v) => codigosEquipo.get(v as string) ?? '—',
      },
      {
        field: 'turno',
        label: CAMPO_LABEL.turno,
        format: (v) => TURNO_LABEL[v as string] ?? (v as string),
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

    const cambioEquipo = despues.equipoId !== antes.equipoId;
    const cambioTurno = despues.turno !== antes.turno;
    const datos: Prisma.RegistroHorometroUncheckedUpdateInput = {
      operatorId: despues.operatorId,
      operador: nombreOperador,
      equipoId: despues.equipoId,
      turno: despues.turno,
      valorInicial: despues.valorInicial,
      valorFinal: despues.valorFinal,
      fuelLiters: despues.fuelLiters,
      adBlue: despues.adBlue,
      adBlueLiters: despues.adBlueLiters,
      observaciones: despues.observaciones,
    };
    if (cambioTurno && shiftDestino) {
      datos.shiftId = shiftDestino.id;
      // El cierre de un pesado queda en el MISMO turno de la tarjeta y se
      // mueve con ella; solo el liviano cerrado por otro supervisor apunta a
      // un turno ajeno, que no se toca.
      if (actual.closedShiftId === actual.shiftId) {
        datos.closedShiftId = shiftDestino.id;
      }
    }
    // Modo `'warn'`, igual que la apertura y el cierre: la edición solo sube
    // el contador del equipo, nunca lo baja ni falla. La lectura vale sobre
    // el equipo al que QUEDA la tarjeta (el contador del original no se baja,
    // misma política de nunca retroceder). En una cerrada manda la lectura
    // final; en una ABIERTA que cambia de máquina, la inicial — lo mismo que
    // hace la apertura sobre su equipo.
    const lecturaParaContador =
      despues.valorFinal != null &&
      (despues.valorFinal !== antes.valorFinal || cambioEquipo)
        ? despues.valorFinal
        : despues.valorFinal == null && cambioEquipo
          ? despues.valorInicial
          : null;
    if (lecturaParaContador != null) {
      const equipo =
        equipoNuevo ??
        (await tx.equipment.findUnique({
          where: { id: actual.equipoId },
          select: {
            controlUnit: true,
            currentHourmeter: true,
            currentMileage: true,
          },
        }));
      if (equipo) {
        const { belowPrevious } = await reconcileEquipmentCounter(
          tx,
          despues.equipoId,
          equipo,
          lecturaParaContador,
          'warn',
        );
        if (belowPrevious && !actual.belowPreviousReading) {
          datos.belowPreviousReading = true;
        }
      }
    }

    try {
      await tx.registroHorometro.update({ where: { id }, data: datos });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        // Chocó el índice parcial de tarjeta abierta al mover el equipo (ver
        // comentario de cabecera del archivo: NO seguir consultando acá, la
        // tx ya quedó abortada — se traduce en `update()`).
        throw new ShiftCardMoveRaceError();
      }
      throw error;
    }
    // Corregir una lectura (o mover la tarjeta a otra máquina) le quita al
    // equipo original esa lectura: si era la que había fijado su contador,
    // el contador vuelve a la más alta que queda registrada.
    if (
      cambioEquipo ||
      despues.valorInicial !== antes.valorInicial ||
      despues.valorFinal !== antes.valorFinal
    ) {
      await releaseRemovedReading(
        tx,
        antes.equipoId,
        Math.max(antes.valorInicial, antes.valorFinal ?? antes.valorInicial),
      );
    }
    if ((despues.fuelLiters ?? 0) !== (antes.fuelLiters ?? 0)) {
      await this.syncFuelRecord(tx, actual, despues.fuelLiters ?? 0);
    }
    // El descuento de Inventario sigue a la corrección POR LA DIFERENCIA: más
    // litros descuenta lo que falta, menos litros (o quitar el AdBlue) los
    // devuelve. El asiento original no se toca — el kardex es bitácora.
    const adBlueAntes = antes.adBlue ? (antes.adBlueLiters ?? 0) : 0;
    const adBlueDespues = despues.adBlue ? (despues.adBlueLiters ?? 0) : 0;
    const adBlueDelta = adBlueDespues - adBlueAntes;
    if (adBlueDelta !== 0) {
      const movimiento = {
        liters: Math.abs(adBlueDelta),
        equipmentId: despues.equipoId,
        performedById: editor.id,
        reference: id,
        notes: `Corrección de tarjeta: AdBlue de ${formatNumber(adBlueAntes)} L a ${formatNumber(adBlueDespues)} L`,
      };
      const within = { tx, events: stockEvents };
      if (adBlueDelta > 0) {
        await this.adBlueStock.discountLoad(within, movimiento);
      } else {
        await this.adBlueStock.restoreLoad(within, movimiento);
      }
    }
    if (cambioEquipo || cambioTurno) {
      // La carga nacida del cierre sigue a la tarjeta: mismo equipo y, si se
      // movió el turno QUE LA REPORTA (el de la tarjeta, o el del cierre, que
      // en un pesado es el mismo), la misma regla de fechado del cierre. El
      // liviano cerrado por otro supervisor conserva la fecha de ESE turno.
      const vinculada = await tx.registroCombustible.findUnique({
        where: { registroHorometroId: id },
        select: { id: true },
      });
      if (vinculada) {
        const data: Prisma.RegistroCombustibleUncheckedUpdateInput = {};
        if (cambioEquipo) data.equipoId = despues.equipoId;
        const reporteSeMueve =
          actual.closedShiftId == null ||
          actual.closedShiftId === actual.shiftId;
        if (cambioTurno && reporteSeMueve) {
          const realInstant =
            actual.fechaSalida ?? actual.closedAt ?? new Date();
          data.fecha = shiftDestino
            ? fuelDateForShiftDay(
                realInstant,
                formatDateOnly(shiftDestino.date),
                shiftDestino.type,
              )
            : fuelDateForShiftDay(
                realInstant,
                shiftDayOf(actual.fecha),
                despues.turno,
              );
        }
        if (Object.keys(data).length > 0) {
          await tx.registroCombustible.update({
            where: { id: vinculada.id },
            data,
          });
        }
      }
    }
    // Las cargas registradas con la tarjeta abierta (livianos) también
    // siguen a la tarjeta si cambia de máquina: su km es del equipo al que
    // queda. Su fecha NO se mueve con el turno: quedó fechada en el turno de
    // quien cargó, igual que el liviano cerrado por otro supervisor.
    if (cambioEquipo && actual.cargasEnCurso.length > 0) {
      await tx.registroCombustible.updateMany({
        where: { tarjetaEnCursoId: id },
        data: { equipoId: despues.equipoId },
      });
      const lecturaCargas = Math.max(
        ...actual.cargasEnCurso.map((carga) => carga.lectura ?? 0),
      );
      await releaseRemovedReading(tx, antes.equipoId, lecturaCargas);
      if (equipoNuevo) {
        await reconcileEquipmentCounter(
          tx,
          despues.equipoId,
          equipoNuevo,
          lecturaCargas,
          'warn',
        );
      }
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
      // Misma regla del día de turno que el cierre: la carga se fecha en el
      // día del turno en que quedó reportada la tarjeta — el turno de quien
      // cerró el liviano (`closedShiftId`, soft ref sin relación Prisma: se
      // resuelve acá) o el turno de la tarjeta.
      const closedShift = card.closedShiftId
        ? await tx.shift.findUnique({
            where: { id: card.closedShiftId },
            select: { date: true, type: true },
          })
        : null;
      const reportedShift = closedShift ?? card.shift;
      const realInstant = card.fechaSalida ?? card.closedAt ?? new Date();
      await tx.registroCombustible.create({
        data: {
          equipoId: card.equipoId,
          litros: liters,
          tipo: DEFAULT_SHIFT_CLOSE_FUEL_TYPE,
          fotoKey: card.pumpPhotoKey,
          fecha: reportedShift
            ? fuelDateForShiftDay(
                realInstant,
                formatDateOnly(reportedShift.date),
                reportedShift.type,
              )
            : fuelDateForShiftDay(
                realInstant,
                shiftDayOf(card.fecha),
                card.turno,
              ),
          registroHorometroId: card.id,
        },
      });
    } else if (vinculada) {
      await tx.registroCombustible.delete({ where: { id: vinculada.id } });
    }
  }

  /**
   * La tarjeta si existe y la sesión es su dueña o ADMIN; si no, 404 / 403.
   * La SECRETARIA solo corrige tarjetas del supervisor temporal (lecturas y
   * litros desde el detalle de su informe): cualquier otra, 403.
   */
  private async findOwnedCard(id: string, session: UserSession) {
    const card = await this.prisma.registroHorometro.findUnique({
      where: { id },
      select: {
        supervisorId: true,
        operatorId: true,
        valorFinal: true,
        temporal: true,
        // El turno al que pertenece: la clave del `Shift` de destino cuando la
        // edición corrige el turno (mismo día y supervisor, otro tipo).
        shift: { select: { type: true, date: true, supervisorId: true } },
      },
    });
    if (!card) throw this.cardNotFound();

    const isAdmin = sessionHasRole(session.user.role, ROLES.ADMIN);
    const secretariaEnTemporal =
      card.temporal && sessionHasRole(session.user.role, ROLES.SECRETARIA);
    if (card.supervisorId !== session.user.id && !isAdmin) {
      if (secretariaEnTemporal) return card;
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

  /** Avisa al administrador la carga de combustible de una camioneta
   * (`fuel.loaded`). Solo después de confirmar la transacción. */
  private emitFuelLoaded(
    input: Omit<FuelLoadedEvent, 'actorId' | 'actorName' | 'actorRole'> & {
      session: UserSession;
    },
  ): void {
    const { session, ...datos } = input;
    const event: FuelLoadedEvent = {
      ...datos,
      actorId: session.user.id,
      actorName: session.user.name?.trim() || session.user.email,
      actorRole: primerRolConocido(session.user.role),
    };
    this.eventEmitter.emit(DOMAIN_EVENTS.FUEL_LOADED, event);
  }

  /** 400 `READING_BELOW_FUEL_LOAD` si la lectura final queda por debajo del
   * km de una carga registrada con la tarjeta abierta. */
  private assertReadingCoversFuelLoads(
    valorFinal: number,
    maxLecturaCargas: number | null,
  ): void {
    if (maxLecturaCargas == null || valorFinal >= maxLecturaCargas) return;
    throw new BadRequestException({
      message: `La lectura final (${formatNumber(valorFinal)}) no puede ser menor que la de una carga de combustible registrada en la tarjeta (${formatNumber(maxLecturaCargas)})`,
      code: ERROR_CODES.READING_BELOW_FUEL_LOAD,
    });
  }

  /** Igual que `assertReadingCoversFuelLoads`, leyendo las cargas de la
   * tarjeta en la transacción del cierre. */
  private async assertFinalCoversFuelLoads(
    tx: Prisma.TransactionClient,
    cardId: string,
    valorFinal: number,
  ): Promise<void> {
    const { _max } = await tx.registroCombustible.aggregate({
      where: { tarjetaEnCursoId: cardId },
      _max: { lectura: true },
    });
    this.assertReadingCoversFuelLoads(valorFinal, _max.lectura);
  }

  /** 409 de una tarjeta del supervisor temporal fuera de su informe. */
  private temporalCard(): ConflictException {
    return new ConflictException({
      message: 'Esta tarjeta se cierra con el informe del supervisor temporal.',
      code: ERROR_CODES.TEMPORAL_CARD,
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
    const esTemporal = sessionHasRole(
      session.user.role,
      ROLES.SUPERVISOR_TEMPORAL,
    );
    const cutoff = new Date(Date.now() - MINE_CLOSED_WINDOW_MS);

    // Además de las propias: las tarjetas de livianos ABIERTAS (cualquiera
    // las puede cerrar) y las de livianos que cerró este supervisor. Las del
    // supervisor temporal son privadas: él ve solo las suyas (todas
    // temporales), y nadie más que el ADMIN ve un liviano temporal ajeno —
    // no lo puede cerrar (`TEMPORAL_CARD`). Las propias de un no-temporal
    // nunca son temporales, así que esa rama no necesita el filtro.
    const visibles: Prisma.RegistroHorometroWhereInput = isAdmin
      ? {}
      : esTemporal
        ? { supervisorId: session.user.id, temporal: true }
        : {
            OR: [
              { supervisorId: session.user.id },
              {
                equipo: { equipmentClass: EquipmentClass.LIGHT },
                temporal: false,
                OR: [{ valorFinal: null }, { closedById: session.user.id }],
              },
            ],
          };
    const cards = await this.prisma.registroHorometro.findMany({
      where: {
        AND: [
          visibles,
          { OR: [{ valorFinal: null }, { closedAt: { gte: cutoff } }] },
        ],
      },
      orderBy: { fecha: 'desc' },
      include: SHIFT_CARD_INCLUDE,
    });

    return this.shapeCards(cards);
  }

  /** Las tarjetas de un turno, de la más reciente a la más vieja, con la forma
   * de `mine` (`GET /shift-reports/:id/cards`, «Ver registro» del informe). */
  async cardsOfShift(shiftId: string): Promise<ShiftCardResponse[]> {
    const cards = await this.prisma.registroHorometro.findMany({
      where: { shiftId },
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
              select: {
                internalCode: true,
                type: true,
                controlUnit: true,
                equipmentClass: true,
              },
            },
          },
          orderBy: { fecha: 'desc' },
        },
        // Para la carga histórica: el frontend avisa si el turno elegido ya
        // tiene su reporte de salida enviado (campo aditivo — el Módulo B
        // ignora claves extra).
        exitReports: {
          select: {
            id: true,
            requestedAt: true,
            cardCount: true,
            // `emailStatus` para que el modo pasado pueda mostrar el MISMO
            // panel de reporte del flujo vivo (línea de estado del correo).
            emailStatus: true,
          },
        },
      },
    });

    return shifts.map((shift) => ({
      id: shift.id,
      date: formatDateOnly(shift.date),
      type: shift.type,
      supervisorId: shift.supervisorId,
      exitReports: shift.exitReports,
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

  /**
   * `POST /api/shift-cards/:id/admin-close` — el ADMINISTRADOR cierra un uso
   * que quedó colgado: el equipo pasó a fuera de servicio con la tarjeta
   * abierta, o el supervisor se fue sin cerrarla (pedido del 13/11/2026,
   * SANY 02). Sin foto ni combustible: se cierra con la lectura final que
   * diga el administrador (la inicial = 0 h si no trabajó) y queda anotado
   * quién y por qué. También suelta la asignación del equipo (operador y
   * supervisor a cargo), para que deje de figurar «En uso».
   */
  async adminCloseCard(
    id: string,
    dto: AdminCloseShiftCardDto,
    session: UserSession,
  ): Promise<ShiftCardResponse> {
    const card = await this.prisma.registroHorometro.findUnique({
      where: { id },
      select: {
        equipoId: true,
        valorInicial: true,
        valorFinal: true,
        closedAt: true,
        observaciones: true,
        belowPreviousReading: true,
      },
    });
    if (!card) {
      throw new NotFoundException({
        message: 'Tarjeta no encontrada',
        code: ERROR_CODES.CARD_NOT_FOUND,
      });
    }
    if (card.valorFinal != null) {
      throw new ConflictException({
        message: this.buildAlreadyClosedMessage(card.closedAt),
        code: ERROR_CODES.ALREADY_CLOSED,
      });
    }
    if (dto.valorFinal < card.valorInicial) {
      throw new BadRequestException({
        message: `La lectura final (${formatNumber(dto.valorFinal)}) no puede ser menor que la inicial (${formatNumber(card.valorInicial)})`,
        code: ERROR_CODES.HOURMETER_BELOW_INITIAL,
      });
    }

    const now = new Date();
    const adminName = session.user.name?.trim() || session.user.email;
    const nota = `Cerrada por la administración (${adminName}): ${dto.motivo || 'uso sin cerrar'}.`;
    const observaciones = card.observaciones
      ? `${card.observaciones}\n${nota}`
      : nota;

    await this.prisma.$transaction(async (tx) => {
      const result = await tx.registroHorometro.updateMany({
        where: { id, valorFinal: null },
        data: {
          valorFinal: dto.valorFinal,
          fechaSalida: now,
          closedAt: now,
          closedById: session.user.id,
          closedByName: adminName,
          observaciones,
        },
      });
      if (result.count !== 1) {
        throw new ConflictException({
          message: 'La tarjeta ya fue cerrada',
          code: ERROR_CODES.ALREADY_CLOSED,
        });
      }
      // Mismo resguardo que el cierre normal: el km final no puede quedar
      // por debajo de una carga ya registrada con la tarjeta abierta.
      await this.assertFinalCoversFuelLoads(tx, id, dto.valorFinal);

      const equipo = await tx.equipment.findUnique({
        where: { id: card.equipoId },
        select: {
          controlUnit: true,
          currentHourmeter: true,
          currentMileage: true,
        },
      });
      if (equipo) {
        // `warn`, igual que el cierre normal: solo audita, nunca bloquea.
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
        await tx.equipment.update({
          where: { id: card.equipoId },
          data: { currentOperatorId: null, currentSupervisorId: null },
        });
      }
    });

    return this.shapeCard(await this.reloadCard(id));
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
    } desde el ${formatBusinessDateTime(since)}`;
  }

  private buildAlreadyClosedMessage(closedAt: Date | null): string {
    return closedAt
      ? `La tarjeta ya fue cerrada el ${formatBusinessDateTime(closedAt)}`
      : 'La tarjeta ya fue cerrada';
  }

  private async shapeCards(
    cards: readonly ShiftCardRecord[],
  ): Promise<ShiftCardResponse[]> {
    // Supervisores y quienes registraron cargas en curso, en UNA consulta.
    const supervisorIds = Array.from(
      new Set(
        cards
          .flatMap((card) => [
            card.supervisorId,
            ...card.cargasEnCurso.map((carga) => carga.createdById),
          ])
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
    const closedShiftIds = Array.from(
      new Set(
        cards
          .map((card) => card.closedShiftId)
          .filter((id): id is string => id != null),
      ),
    );
    const closedShifts =
      closedShiftIds.length > 0
        ? await this.prisma.shift.findMany({
            where: { id: { in: closedShiftIds } },
            select: { id: true, date: true, type: true },
          })
        : [];
    const closedShiftsById = new Map(closedShifts.map((s) => [s.id, s]));

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
        // Solo vale mientras la tarjeta no tenga litros (una corrección
        // posterior que agrega la carga lo deja sin sentido), ni al cierre ni
        // en cargas hechas con la tarjeta abierta.
        noFuelReason:
          card.fuelLiters || card.cargasEnCurso.length > 0
            ? null
            : card.noFuelReason,
        adBlue: card.adBlue,
        adBlueLiters: card.adBlueLiters,
        belowPreviousReading: card.belowPreviousReading,
        fecha: card.fecha,
        fechaSalida: card.fechaSalida,
        createdAt: card.createdAt,
        closedAt: card.closedAt,
        closedById: card.closedById,
        closedByName: card.closedByName,
        closedShift: (() => {
          const s = card.closedShiftId
            ? closedShiftsById.get(card.closedShiftId)
            : undefined;
          return s
            ? { id: s.id, date: formatDateOnly(s.date), type: s.type }
            : null;
        })(),
        fuelLoads: await Promise.all(
          card.cargasEnCurso.map(async (carga) => ({
            id: carga.id,
            liters: carga.litros,
            // Siempre la trae (la exige el alta); `?? 0` solo por el tipo.
            reading: carga.lectura ?? 0,
            adBlueLiters: carga.adBlueLitros,
            pumpPhotoUrl: carga.fotoKey
              ? await this.storage.sign(carga.fotoKey)
              : null,
            fecha: carga.fecha,
            createdAt: carga.createdAt ?? carga.fecha,
            createdByName: carga.createdById
              ? (supervisorsById.get(carga.createdById) ?? null)
              : null,
          })),
        ),
      })),
    );
  }

  private async shapeCard(card: ShiftCardRecord): Promise<ShiftCardResponse> {
    const [shaped] = await this.shapeCards([card]);
    return shaped;
  }
}
