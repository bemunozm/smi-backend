import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { EquipmentStatus, Prisma } from '@prisma/client';
import type { UserSession } from '@thallesp/nestjs-better-auth';

import { ROLES, sessionHasRole } from '../../auth/roles';
import { PrismaService } from '../../common/prisma/prisma.service';
import { OperatorsService } from '../../operators/operators.service';
import { reconcileEquipmentCounter } from './equipment-counter';
import { CreateHorometroDto } from './dto/create-horometro.dto';
import { SalidaHorometroDto } from './dto/salida-horometro.dto';

/**
 * M1(b) de la auditoría de seguridad: estas 3 columnas nunca deben viajar
 * crudas hacia un cliente. `pumpPhotoKey` es la KEY interna del bucket (la
 * URL firmada se resuelve aparte, `ShiftsService.shapeCard`) — Flota nunca
 * la firma, así que exponerla acá era simplemente una fuga sin contrapartida.
 * `closeClientId` es la clave de idempotencia interna del cierre (Supervisión
 * en Terreno) — filtrarla permite reproducir el 403 que M1(a) cierra por
 * otro camino (adivinar/copiar el id y reintentar el cierre de otro).
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
   * `session` (RFC Supervisión en Terreno, Fase 2) graba `supervisorId` —
   * antes este flujo no dejaba rastro de quién abrió el turno.
   */
  async create(dto: CreateHorometroDto, session: UserSession) {
    // Validación del operador de catálogo (si viene) ANTES de la
    // transacción: es una precondición pura de la request, no depende de
    // ningún estado que la tx necesite leer de forma consistente.
    const operator = dto.operatorId
      ? await this.operators.assertActive(dto.operatorId)
      : undefined;

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

      // R1 (RFC Supervisión en Terreno §Diseño): un equipo fuera de servicio
      // o en taller no puede iniciar un turno nuevo.
      if (equipo.status !== EquipmentStatus.OPERATIONAL) {
        throw new ConflictException({
          message: 'El equipo no está operativo',
          code: 'EQUIPMENT_NOT_OPERATIONAL',
        });
      }

      const turnoAbierto = await tx.registroHorometro.findFirst({
        where: { equipoId: dto.equipoId, valorFinal: null },
        select: { id: true },
      });
      if (turnoAbierto) {
        throw new BadRequestException(TURNO_ABIERTO_MSG);
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
          data: {
            equipoId: dto.equipoId,
            operador: dto.operador,
            operatorId: operator?.id ?? null,
            turno: dto.turno,
            valorInicial: dto.valorInicial,
            nivelCombustible: dto.nivelCombustible ?? null,
            supervisorId: session.user.id,
          },
        });
      } catch (error) {
        if (
          error instanceof Prisma.PrismaClientKnownRequestError &&
          error.code === 'P2002'
        ) {
          throw new BadRequestException(TURNO_ABIERTO_MSG);
        }
        throw error;
      }

      // El write del valor actual solo aplica al contador que gobierna la
      // unidad (RFC T01 §2, MEJORA-3): HOURS pisa `currentHourmeter`, KM pisa
      // `currentMileage` — nunca los dos a la vez. Flota SIEMPRE en modo
      // `'reject'` (RFC Supervisión en Terreno §Diseño: "Flota keeps using
      // reject") — el modo `'warn'` es exclusivo de la apertura de tarjeta de
      // turno (`ShiftsService.openCard`).
      // TODO(motor-preventivo): disparar el umbral de Mantenimiento (Joaquín, guía §5).
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
   * `session` (RFC Supervisión en Terreno, Fase 2): si la tarjeta pertenece a
   * un turno de Supervisión en Terreno (`shiftId != null`), este endpoint
   * legacy de Flota YA NO la cierra — se cierra desde
   * `POST /api/shift-cards/:id/close`, que además exige litros y foto. Salvo
   * ADMIN, que puede cerrar cualquier tarjeta desde cualquiera de los dos
   * flujos (respuesta a Q5 del RFC: "tarjetas sin cerrar, las cierra el
   * ADMIN").
   */
  async salida(id: string, dto: SalidaHorometroDto, session: UserSession) {
    const now = new Date();
    return this.prisma.$transaction(async (tx) => {
      const registro = await tx.registroHorometro.findUnique({
        where: { id },
      });
      if (!registro) throw new NotFoundException('Registro no encontrado');

      if (registro.valorFinal != null) {
        throw new ConflictException('El turno ya está cerrado');
      }

      if (
        registro.shiftId != null &&
        !sessionHasRole(session.user.role, ROLES.ADMIN)
      ) {
        throw new ConflictException({
          message:
            'Esta tarjeta se cierra desde el Registro de equipo, con litros y foto',
          code: 'SHIFT_CARD_CLOSE_ELSEWHERE',
        });
      }

      if (dto.valorFinal < registro.valorInicial) {
        throw new BadRequestException(
          'La lectura final no puede ser menor que la inicial',
        );
      }

      const cerrado = await tx.registroHorometro.update({
        where: { id },
        data: {
          valorFinal: dto.valorFinal,
          fechaSalida: now,
          // Info (auditoría de seguridad): antes NO se seteaba acá —
          // `closedAt` quedaba `null` para una tarjeta de Supervisión en
          // Terreno que un ADMIN cierra por este flujo legacy de Flota, así
          // que jamás entraba a la ventana de "cerradas en las últimas 48h"
          // de `ShiftsService.mine` (que filtra por `closedAt >= cutoff`).
          closedAt: now,
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
