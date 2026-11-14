import {
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { EquipmentClass } from '@prisma/client';

import { todayInBusinessTimeZone } from '../common/dates/business-time';
import {
  DOMAIN_EVENTS,
  type ShiftEndedWithOpenCardsEvent,
} from '../common/events/domain-events';
import { PrismaService } from '../common/prisma/prisma.service';
import { formatDateOnly, hasShiftEnded, parseDateOnlyUtc } from './date-only';

/** Cada cuánto se revisa: el aviso sale a lo más 5 minutos después del cambio de turno. */
const REVISION_MS = 5 * 60 * 1000;
const PRIMERA_REVISION_MS = 60 * 1000;
/** Solo turnos de los últimos días: una tarjeta olvidada hace semanas no
 * merece un aviso nuevo el día que se despliega esto. */
const DIAS_HACIA_ATRAS = 2;

/**
 * Aviso de fin de turno: cuando termina el turno de un supervisor y le quedan
 * PESADOS abiertos, se le notifica (campana + push + correo) para que los
 * cierre. Mientras sigan abiertos, el supervisor del turno siguiente no los
 * ve en «Abrir equipo» (pedido del 13/11/2026, tras un turno nocturno que no
 * pudo registrar los equipos que el diurno dejó abiertos).
 *
 * Los livianos no cuentan: quedan abiertos a propósito hasta la carga de
 * combustible. El aviso sale una sola vez por turno (`openCardsReminderSentAt`,
 * reclamado con un `updateMany` condicional para que dos instancias no
 * avisen dos veces).
 */
@Injectable()
export class ShiftEndRemindersService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ShiftEndRemindersService.name);
  private timers: NodeJS.Timeout[] = [];

  constructor(
    private readonly prisma: PrismaService,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  onModuleInit(): void {
    // En los tests no corre: cada suite levantaría sus propios temporizadores.
    if (process.env.NODE_ENV === 'test') return;
    const primera = setTimeout(() => void this.run(), PRIMERA_REVISION_MS);
    const periodica = setInterval(() => void this.run(), REVISION_MS);
    primera.unref();
    periodica.unref();
    this.timers = [primera, periodica];
  }

  onModuleDestroy(): void {
    for (const t of this.timers) clearTimeout(t);
  }

  private async run(): Promise<void> {
    try {
      await this.checkEndedShifts();
    } catch (error) {
      this.logger.error(
        'No se pudieron revisar los turnos terminados con equipos abiertos',
        error instanceof Error ? error.stack : undefined,
      );
    }
  }

  /** Avisa los turnos terminados con pesados abiertos. Devuelve cuántos avisos salieron. */
  async checkEndedShifts(now: Date = new Date()): Promise<number> {
    const desde = parseDateOnlyUtc(todayInBusinessTimeZone(now));
    desde.setUTCDate(desde.getUTCDate() - DIAS_HACIA_ATRAS);

    const pesadosAbiertos = {
      valorFinal: null,
      equipo: { equipmentClass: EquipmentClass.HEAVY },
    };
    const turnos = await this.prisma.shift.findMany({
      where: {
        openCardsReminderSentAt: null,
        date: { gte: desde },
        cards: { some: pesadosAbiertos },
      },
      include: {
        cards: {
          where: pesadosAbiertos,
          select: { equipo: { select: { internalCode: true } } },
        },
      },
    });

    let avisados = 0;
    for (const turno of turnos) {
      const shiftDate = formatDateOnly(turno.date);
      if (!hasShiftEnded(shiftDate, turno.type, now)) continue;

      const { count } = await this.prisma.shift.updateMany({
        where: { id: turno.id, openCardsReminderSentAt: null },
        data: { openCardsReminderSentAt: now },
      });
      if (count === 0) continue;

      const equipmentCodes = [
        ...new Set(turno.cards.map((c) => c.equipo.internalCode)),
      ].sort();
      this.eventEmitter.emit(DOMAIN_EVENTS.SHIFT_ENDED_WITH_OPEN_CARDS, {
        supervisorId: turno.supervisorId,
        shiftId: turno.id,
        shiftDate,
        shiftType: turno.type,
        equipmentCodes,
      } satisfies ShiftEndedWithOpenCardsEvent);
      avisados++;
    }
    return avisados;
  }
}
