import type { EventEmitter2 } from '@nestjs/event-emitter';

import { DOMAIN_EVENTS } from '../common/events/domain-events';
import type { PrismaService } from '../common/prisma/prisma.service';
import { hasShiftEnded } from './date-only';
import { ShiftEndRemindersService } from './shift-end-reminders.service';

// Noviembre: Chile continental está en UTC-3.
const santiago = (iso: string) => new Date(`${iso}-03:00`);

describe('hasShiftEnded', () => {
  it('el DIURNO termina a las 20:00 de su día', () => {
    expect(
      hasShiftEnded('2026-11-13', 'DIURNO', santiago('2026-11-13T19:59:00')),
    ).toBe(false);
    expect(
      hasShiftEnded('2026-11-13', 'DIURNO', santiago('2026-11-13T20:00:00')),
    ).toBe(true);
    expect(
      hasShiftEnded('2026-11-13', 'DIURNO', santiago('2026-11-14T03:00:00')),
    ).toBe(true);
  });

  it('el NOCTURNO termina a las 08:00 del día siguiente', () => {
    expect(
      hasShiftEnded('2026-11-13', 'NOCTURNO', santiago('2026-11-13T23:00:00')),
    ).toBe(false);
    expect(
      hasShiftEnded('2026-11-13', 'NOCTURNO', santiago('2026-11-14T07:59:00')),
    ).toBe(false);
    expect(
      hasShiftEnded('2026-11-13', 'NOCTURNO', santiago('2026-11-14T08:00:00')),
    ).toBe(true);
    expect(
      hasShiftEnded('2026-11-13', 'NOCTURNO', santiago('2026-11-15T01:00:00')),
    ).toBe(true);
  });

  it('un turno que todavía no empieza no terminó', () => {
    expect(
      hasShiftEnded('2026-11-14', 'DIURNO', santiago('2026-11-13T21:00:00')),
    ).toBe(false);
  });
});

describe('ShiftEndRemindersService', () => {
  const prisma = {
    shift: { findMany: jest.fn(), updateMany: jest.fn() },
  };
  const events = { emit: jest.fn() };
  let service: ShiftEndRemindersService;

  const turno = (over: Record<string, unknown> = {}) => ({
    id: 'shift_1',
    date: new Date(Date.UTC(2026, 10, 13)),
    type: 'DIURNO',
    supervisorId: 'sup_1',
    cards: [
      { equipo: { internalCode: 'EX-02' } },
      { equipo: { internalCode: 'CA-11' } },
    ],
    ...over,
  });

  beforeEach(() => {
    jest.resetAllMocks();
    service = new ShiftEndRemindersService(
      prisma as unknown as PrismaService,
      events as unknown as EventEmitter2,
    );
    prisma.shift.updateMany.mockResolvedValue({ count: 1 });
  });

  it('busca turnos recientes sin aviso con PESADOS abiertos', async () => {
    prisma.shift.findMany.mockResolvedValue([]);

    await service.checkEndedShifts(santiago('2026-11-13T20:05:00'));

    const [{ where }] = prisma.shift.findMany.mock.calls[0] as [
      { where: Record<string, unknown> },
    ];
    expect(where).toEqual({
      openCardsReminderSentAt: null,
      date: { gte: new Date(Date.UTC(2026, 10, 11)) },
      cards: {
        some: { valorFinal: null, equipo: { equipmentClass: 'HEAVY' } },
      },
    });
  });

  it('terminado el turno, avisa al supervisor una vez con los códigos ordenados', async () => {
    prisma.shift.findMany.mockResolvedValue([turno()]);
    const now = santiago('2026-11-13T20:05:00');

    await expect(service.checkEndedShifts(now)).resolves.toBe(1);

    expect(prisma.shift.updateMany).toHaveBeenCalledWith({
      where: { id: 'shift_1', openCardsReminderSentAt: null },
      data: { openCardsReminderSentAt: now },
    });
    expect(events.emit).toHaveBeenCalledWith(
      DOMAIN_EVENTS.SHIFT_ENDED_WITH_OPEN_CARDS,
      {
        supervisorId: 'sup_1',
        shiftId: 'shift_1',
        shiftDate: '2026-11-13',
        shiftType: 'DIURNO',
        equipmentCodes: ['CA-11', 'EX-02'],
      },
    );
  });

  it('no avisa un turno que todavía corre', async () => {
    prisma.shift.findMany.mockResolvedValue([turno()]);

    await expect(
      service.checkEndedShifts(santiago('2026-11-13T19:30:00')),
    ).resolves.toBe(0);

    expect(prisma.shift.updateMany).not.toHaveBeenCalled();
    expect(events.emit).not.toHaveBeenCalled();
  });

  it('si otra instancia ya lo reclamó, no repite el aviso', async () => {
    prisma.shift.findMany.mockResolvedValue([turno()]);
    prisma.shift.updateMany.mockResolvedValue({ count: 0 });

    await expect(
      service.checkEndedShifts(santiago('2026-11-13T20:05:00')),
    ).resolves.toBe(0);

    expect(events.emit).not.toHaveBeenCalled();
  });
});
