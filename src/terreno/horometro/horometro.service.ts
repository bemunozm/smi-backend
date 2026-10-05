import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { EquipmentStatus, Prisma } from '@prisma/client';
import type { UserSession } from '@thallesp/nestjs-better-auth';

import { ROLES, sessionHasRole } from '../../auth/roles';
import { lockRow } from '../../common/concurrency/lock-row';
import {
  createOrReturn,
  isPrimaryKeyViolation,
} from '../../common/idempotency/create-or-return';
import { PrismaService } from '../../common/prisma/prisma.service';
import { ERROR_CODES } from '../../common/errors/error-codes';
import { resolveCloseRace } from '../../common/idempotency/resolve-close-race';
import { OperatorsService } from '../../operators/operators.service';
import { reconcileEquipmentCounter } from '../../equipment/equipment-counter';
import { resolveCapturedAt } from '../../common/dates/capture-time';
import { CreateHorometroDto } from './dto/create-horometro.dto';
import { SalidaHorometroDto } from './dto/salida-horometro.dto';

/**
 * Estas 3 columnas nunca deben viajar crudas hacia un cliente. `pumpPhotoKey`
 * es la KEY interna del bucket (la URL firmada se resuelve aparte,
 * `ShiftsService.shapeCard`) — Flota nunca la firma, así que exponerla acá
 * sería una fuga sin contrapartida. `closeClientId` es la clave de
 * idempotencia interna del cierre — filtrarla
 * permite reproducir el 403 de dueño de tarjeta por otro camino
 * (adivinar/copiar el id y reintentar el cierre de otro).
 * `clientClockSkewMs` es auditoría interna del desfase de reloj del
 * dispositivo, sin valor para el cliente.
 */
const HOROMETRO_INTERNAL_FIELDS_OMIT = {
  pumpPhotoKey: true,
  closeClientId: true,
  clientClockSkewMs: true,
} as const;

/** Reusado por el chequeo aplicativo (fast-path) y por la traducción del
 * P2002 que dispara el índice único parcial (garantía dura, ver migración
 * `..._horometro_open_turno_unique_index`) — ambos caminos deben devolver
 * el mismo mensaje al caller. */
const TURNO_ABIERTO_MSG =
  'El equipo ya tiene un turno en curso; registrá la salida antes de una nueva entrada.';

@Injectable()
export class HorometroService {
  constructor(
    private prisma: PrismaService,
    private readonly operators: OperatorsService,
  ) {}

  /**
   * ENTRADA del flujo de dos pasos (Flota): abre el turno del equipo. Un
   * equipo no puede tener dos turnos abiertos a la vez ("turno abierto" =
   * `valorFinal == null`), así que se rechaza si ya hay uno en curso — sin
   * este chequeo, la SALIDA posterior no sabría a cuál de los dos registros
   * abiertos cerrar.
   *
   * `session` permite grabar `supervisorId`, el rastro de quién abrió el turno.
   */
  async create(dto: CreateHorometroDto, session: UserSession) {
    const userId = session.user.id;
    const findRow = (id: string) =>
      this.prisma.registroHorometro.findUnique({
        where: { id },
        omit: HOROMETRO_INTERNAL_FIELDS_OMIT,
      });

    return createOrReturn({
      id: dto.id,
      userId,
      conflictMessage: 'Ya existe un registro con ese id de otro usuario',
      // El reintento propio devuelve el registro tal como está hoy (puede
      // estar cerrado ya) sin volver a validar equipo, operador ni turno.
      findExisting: async (id) => {
        const existing = await findRow(id);
        return existing
          ? { ownerId: existing.supervisorId, result: existing }
          : null;
      },
      create: async () => {
        try {
          return await this.createFresh(dto, session);
        } catch (error: unknown) {
          // Con el mismo id, dos envíos simultáneos también chocan contra el
          // índice del turno abierto del equipo (no solo contra la PK): si
          // el registro que ganó es mío, es mi propio reintento.
          if (dto.id && this.isOpenShiftConflict(error)) {
            const mine = await findRow(dto.id);
            if (mine?.supervisorId === userId) return mine;
          }
          throw error;
        }
      },
    });
  }

  private isOpenShiftConflict(error: unknown): boolean {
    return (
      error instanceof BadRequestException &&
      (error.getResponse() as { code?: string }).code ===
        ERROR_CODES.EQUIPMENT_BUSY
    );
  }

  private async createFresh(dto: CreateHorometroDto, session: UserSession) {
    const now = new Date();
    const { at: fecha, discardedSkewMs } = resolveCapturedAt(
      dto.capturedAt,
      now,
    );

    // Validación del operador de catálogo (OBLIGATORIO, mismo patrón que
    // Trabajos extra) ANTES de la transacción: es una precondición pura de la
    // request, no depende de ningún estado que la tx necesite leer de forma
    // consistente. El snapshot `operador` se arma acá con el nombre del
    // catálogo — el cliente no lo manda.
    const operator = await this.operators.assertActive(dto.operatorId);

    // El registro de terreno y el write del contador de la ficha van en la
    // misma transacción: si el update del equipo fallara, no debe quedar un
    // `RegistroHorometro` huérfano que la ficha muestre sin haber movido el
    // contador (o viceversa). El fetch del equipo y el chequeo de turno
    // abierto también van dentro del `tx` — el primero para leer los
    // contadores vigentes de forma consistente con el resto de la
    // transacción, el segundo para cerrar la ventana de carrera entre dos
    // ENTRADA casi simultáneas del mismo equipo.
    return this.prisma.$transaction(async (tx) => {
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

      const turnoAbierto = await tx.registroHorometro.findFirst({
        where: { equipoId: dto.equipoId, valorFinal: null },
        select: { id: true },
      });
      if (turnoAbierto) {
        throw this.turnoAbiertoError();
      }

      // El fast-path de arriba (`findFirst`) no cierra la ventana de carrera
      // bajo READ COMMITTED: dos ENTRADA casi simultáneas del mismo equipo
      // pueden pasarlo las dos. La garantía dura es el índice único parcial
      // de Postgres sobre `(equipo_id) WHERE "valorFinal" IS NULL`; si el
      // `create` de abajo choca contra él, Prisma lo reporta como P2002 y acá
      // se traduce al mismo 400 que el chequeo aplicativo.
      let registro;
      try {
        registro = await tx.registroHorometro.create({
          omit: HOROMETRO_INTERNAL_FIELDS_OMIT,
          data: {
            ...(dto.id ? { id: dto.id } : {}),
            fecha,
            equipoId: dto.equipoId,
            operador: operator.name,
            operatorId: operator.id,
            turno: dto.turno,
            valorInicial: dto.valorInicial,
            nivelCombustible: dto.nivelCombustible ?? null,
            supervisorId: session.user.id,
            // Hora del dispositivo descartada por desfase: queda auditado.
            clientClockSkewMs: discardedSkewMs ?? null,
          },
        });
      } catch (error) {
        // Un choque con la PK es la carrera de dos reintentos con el mismo
        // id: lo resuelve `createOrReturn`, no es un turno ya abierto.
        if (isPrimaryKeyViolation(error)) throw error;
        if (
          error instanceof Prisma.PrismaClientKnownRequestError &&
          error.code === 'P2002'
        ) {
          throw this.turnoAbiertoError();
        }
        throw error;
      }

      // El write del valor actual solo aplica al contador que gobierna la
      // unidad: HOURS pisa `currentHourmeter`, KM pisa
      // `currentMileage` — nunca los dos a la vez. Flota SIEMPRE en modo
      // `'reject'` — el modo `'warn'` es exclusivo de la apertura de tarjeta
      // de turno (`ShiftsService.openCard`).
      // TODO(motor-preventivo): disparar el umbral de Mantenimiento.
      await reconcileEquipmentCounter(
        tx,
        dto.equipoId,
        equipo,
        dto.valorInicial,
        'reject',
      );

      return registro;
    });
  }

  /**
   * SALIDA del flujo de dos pasos (Flota): cierra el turno que `create()`
   * abrió. Vuelve a cuadrar el contador del equipo, esta vez a `valorFinal`.
   *
   * `session`: si la tarjeta pertenece a
   * un turno de Supervisión en Terreno (`shiftId != null`), este endpoint
   * de Flota no la cierra — se cierra desde
   * `POST /api/shift-cards/:id/close`, que además exige litros y foto. Salvo
   * ADMIN, que puede cerrar cualquier tarjeta desde cualquiera de los dos
   * flujos (las tarjetas sin cerrar las cierra el ADMIN).
   */
  async salida(id: string, dto: SalidaHorometroDto, session: UserSession) {
    const now = new Date();
    const { at: fechaSalida, discardedSkewMs } = resolveCapturedAt(
      dto.capturedAt,
      now,
    );

    try {
      return await this.prisma.$transaction(async (tx) => {
        // La fila se bloquea antes de leerla: dos cierres simultáneos de la
        // misma tarjeta se serializan, y el segundo ve el cierre del primero
        // en vez de pisarlo.
        await lockRow(tx, 'registroHorometro', id);
        const registro = await tx.registroHorometro.findUnique({
          where: { id },
        });
        if (!registro) throw this.cardNotFoundError();

        if (registro.valorFinal != null) {
          // Reintento del mismo cierre (misma `closeClientId`): ya está hecho.
          if (
            dto.closeClientId !== undefined &&
            registro.closeClientId === dto.closeClientId
          ) {
            return tx.registroHorometro.findUniqueOrThrow({
              where: { id },
              omit: HOROMETRO_INTERNAL_FIELDS_OMIT,
            });
          }
          throw this.alreadyClosedError();
        }

        if (
          registro.shiftId != null &&
          !sessionHasRole(session.user.role, ROLES.ADMIN)
        ) {
          throw new ConflictException({
            message:
              'Esta tarjeta se cierra desde el Registro de equipo, con litros y foto',
            code: ERROR_CODES.SHIFT_CARD_CLOSE_ELSEWHERE,
          });
        }

        if (dto.valorFinal < registro.valorInicial) {
          throw new BadRequestException({
            message: 'La lectura final no puede ser menor que la inicial',
            code: ERROR_CODES.HOURMETER_BELOW_INITIAL,
          });
        }

        const cerrado = await tx.registroHorometro.update({
          where: { id },
          omit: HOROMETRO_INTERNAL_FIELDS_OMIT,
          data: {
            valorFinal: dto.valorFinal,
            fechaSalida,
            // Se setea `closedAt` para que una tarjeta de Terreno cerrada por
            // un ADMIN entre a la ventana de "cerradas en las últimas 48 h"
            // de `ShiftsService.mine` (filtra por `closedAt >= cutoff`).
            closedAt: now,
            // Se audita el desfase sin pisar el que dejó la apertura.
            ...(discardedSkewMs !== undefined &&
            registro.clientClockSkewMs === null
              ? { clientClockSkewMs: discardedSkewMs }
              : {}),
            ...(dto.closeClientId !== undefined
              ? { closeClientId: dto.closeClientId }
              : {}),
            ...(dto.nivelCombustible != null
              ? { nivelCombustible: dto.nivelCombustible }
              : {}),
          },
        });

        const equipo = await tx.equipment.findUnique({
          where: { id: registro.equipoId },
          select: {
            controlUnit: true,
            currentHourmeter: true,
            currentMileage: true,
          },
        });
        if (equipo) {
          await reconcileEquipmentCounter(
            tx,
            registro.equipoId,
            equipo,
            dto.valorFinal,
            'reject',
          );
        }

        return cerrado;
      });
    } catch (error: unknown) {
      // `closeClientId` es `@unique` en toda la tabla: chocar acá es que el
      // id de cierre ya lo usa otra tarjeta. Se releer FUERA de la
      // transacción (la de Postgres quedó abortada).
      if (
        dto.closeClientId !== undefined &&
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        return this.resolveCloseRace(id, dto.closeClientId);
      }
      throw error;
    }
  }

  /** Mismo criterio que el cierre de Terreno (ver `resolveCloseRace`). */
  private async resolveCloseRace(id: string, closeClientId: string) {
    const existing = await this.prisma.registroHorometro.findUnique({
      where: { id },
    });
    return resolveCloseRace({
      existing,
      closeClientId,
      replay: () =>
        this.prisma.registroHorometro.findUniqueOrThrow({
          where: { id },
          omit: HOROMETRO_INTERNAL_FIELDS_OMIT,
        }),
      alreadyClosed: () => this.alreadyClosedError(),
    });
  }

  private turnoAbiertoError(): BadRequestException {
    return new BadRequestException({
      message: TURNO_ABIERTO_MSG,
      code: ERROR_CODES.EQUIPMENT_BUSY,
    });
  }

  private cardNotFoundError(): NotFoundException {
    return new NotFoundException({
      message: 'Registro no encontrado',
      code: ERROR_CODES.CARD_NOT_FOUND,
    });
  }

  private alreadyClosedError(): ConflictException {
    return new ConflictException({
      message: 'El turno ya está cerrado',
      code: ERROR_CODES.ALREADY_CLOSED,
    });
  }

  findAll() {
    return this.prisma.registroHorometro.findMany({
      orderBy: { fecha: 'desc' },
      include: { equipo: { select: { internalCode: true } } },
      omit: HOROMETRO_INTERNAL_FIELDS_OMIT,
    });
  }

  async findOne(id: string) {
    const reg = await this.prisma.registroHorometro.findUnique({
      where: { id },
      omit: HOROMETRO_INTERNAL_FIELDS_OMIT,
    });
    if (!reg) throw new NotFoundException('Registro no encontrado');
    return reg;
  }
}
