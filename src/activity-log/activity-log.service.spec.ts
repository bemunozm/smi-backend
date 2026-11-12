import { BadRequestException } from '@nestjs/common';
import { Test } from '@nestjs/testing';

import { PrismaService } from '../common/prisma/prisma.service';
import { ActivityLogService } from './activity-log.service';
import type { ActivityEvent } from './activity-log.service';

/** Instante UTC — el día de negocio se deriva en la zona de Chile. */
const d = (iso: string) => new Date(iso);
/** Fecha de calendario (`@db.Date`): medianoche UTC. */
const dia = (ymd: string) => new Date(`${ymd}T00:00:00.000Z`);

describe('ActivityLogService', () => {
  let service: ActivityLogService;
  const prisma = {
    registroCombustible: { findMany: jest.fn() },
    registroHorometro: { findMany: jest.fn() },
    reporteDiario: { findMany: jest.fn() },
    trabajoExtraordinario: { findMany: jest.fn() },
    hallazgo: { findMany: jest.fn() },
    ordenTrabajo: { findMany: jest.fn() },
    intervencion: { findMany: jest.fn() },
    shiftExitReport: { findMany: jest.fn() },
    changeLog: { findMany: jest.fn() },
    equipment: { findMany: jest.fn() },
    user: { findMany: jest.fn() },
  };

  beforeEach(async () => {
    const mod = await Test.createTestingModule({
      providers: [
        ActivityLogService,
        { provide: PrismaService, useValue: prisma },
      ],
    }).compile();
    service = mod.get(ActivityLogService);
    jest.clearAllMocks();
    for (const tabla of Object.values(prisma)) {
      tabla.findMany.mockResolvedValue([]);
    }
    prisma.user.findMany.mockResolvedValue([
      { id: 'sup1', name: 'Juan Pérez' },
    ]);
  });

  const evento = (res: { events: ActivityEvent[] }, id: string) =>
    res.events.find((e) => e.id === id);

  describe('validación del rango', () => {
    it.each([
      ['12-11-2026', '2026-11-12'],
      ['2026-11-12', 'mañana'],
    ])('una fecha con otro formato da 400 (%s, %s)', async (from, to) => {
      await expect(service.feed(from, to)).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it('un rango invertido da 400', async () => {
      await expect(
        service.feed('2026-11-12', '2026-11-01'),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('más de 92 días da 400', async () => {
      await expect(
        service.feed('2026-01-01', '2026-06-01'),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  it('una carga registrada HOY con fecha de un día pasado sale retroactiva, con sus dos fechas', async () => {
    prisma.registroCombustible.findMany.mockResolvedValue([
      {
        id: 'c1',
        litros: 120,
        tipo: 'PETROLEO',
        // Día de negocio de la carga: el 8.
        fecha: d('2026-11-08T18:00:00.000Z'),
        // Registrada (hora de servidor) el 12.
        createdAt: d('2026-11-12T14:00:00.000Z'),
        createdById: 'sup1',
        registroHorometroId: null,
        equipo: { internalCode: 'CAM-31' },
        registroHorometro: null,
      },
    ]);

    const res = await service.feed('2026-11-12', '2026-11-12');

    expect(evento(res, 'fuel:created:c1')).toMatchObject({
      kind: 'FUEL_LOAD',
      action: 'CREATED',
      dataDate: '2026-11-08',
      backdated: true,
      actorName: 'Juan Pérez',
      summary: 'CAM-31 · 120 L petróleo · manual',
    });
  });

  it('una carga del mismo día NO es retroactiva', async () => {
    prisma.registroCombustible.findMany.mockResolvedValue([
      {
        id: 'c2',
        litros: 40,
        tipo: 'BENCINA',
        fecha: d('2026-11-12T13:00:00.000Z'),
        createdAt: d('2026-11-12T13:05:00.000Z'),
        createdById: 'sup1',
        registroHorometroId: null,
        equipo: { internalCode: 'CA-011' },
        registroHorometro: null,
      },
    ]);

    const res = await service.feed('2026-11-12', '2026-11-12');

    expect(evento(res, 'fuel:created:c2')).toMatchObject({ backdated: false });
  });

  it('la carga nacida de un cierre de tarjeta firma con quien CERRÓ y lo dice en el resumen', async () => {
    prisma.registroCombustible.findMany.mockResolvedValue([
      {
        id: 'c3',
        litros: 80,
        tipo: 'PETROLEO',
        fecha: d('2026-11-12T13:00:00.000Z'),
        createdAt: d('2026-11-12T13:00:00.000Z'),
        createdById: null,
        registroHorometroId: 'rh1',
        equipo: { internalCode: 'SEM-656' },
        registroHorometro: {
          closedById: 'sup2',
          closedByName: 'Ana Soto',
          supervisorId: 'sup1',
        },
      },
    ]);

    const res = await service.feed('2026-11-12', '2026-11-12');

    expect(evento(res, 'fuel:created:c3')).toMatchObject({
      actorName: 'Ana Soto',
      summary: 'SEM-656 · 80 L petróleo · cierre de tarjeta',
    });
  });

  it('una tarjeta da DOS eventos — apertura y cierre — en el día del TURNO, cada uno con su autor', async () => {
    prisma.registroHorometro.findMany.mockResolvedValue([
      {
        id: 'rh1',
        operador: 'Pedro Rojas',
        turno: 'DIURNO',
        fecha: d('2026-11-12T11:00:00.000Z'),
        createdAt: d('2026-11-12T11:00:00.000Z'),
        closedAt: d('2026-11-12T21:30:00.000Z'),
        closedById: 'sup2',
        closedByName: 'Ana Soto',
        supervisorId: 'sup1',
        fuelLiters: 95,
        equipo: { internalCode: 'WA470' },
        shift: { date: dia('2026-11-12') },
      },
    ]);

    const res = await service.feed('2026-11-12', '2026-11-12');

    expect(evento(res, 'card:created:rh1')).toMatchObject({
      kind: 'SHIFT_CARD',
      action: 'CREATED',
      dataDate: '2026-11-12',
      actorName: 'Juan Pérez',
      summary: 'WA470 · Pedro Rojas · turno día',
    });
    expect(evento(res, 'card:closed:rh1')).toMatchObject({
      action: 'CLOSED',
      actorName: 'Ana Soto',
      summary: 'WA470 · Pedro Rojas · turno día · 95 L al cierre',
    });
  });

  it('una tarjeta abierta (sin `closedAt`) no inventa el evento de cierre', async () => {
    prisma.registroHorometro.findMany.mockResolvedValue([
      {
        id: 'rh2',
        operador: 'Pedro Rojas',
        turno: 'NOCTURNO',
        fecha: d('2026-11-12T11:00:00.000Z'),
        createdAt: d('2026-11-12T11:00:00.000Z'),
        closedAt: null,
        closedById: null,
        closedByName: null,
        supervisorId: 'sup1',
        fuelLiters: null,
        equipo: { internalCode: 'WA470' },
        shift: null,
      },
    ]);

    const res = await service.feed('2026-11-12', '2026-11-12');

    expect(evento(res, 'card:created:rh2')).toBeDefined();
    expect(evento(res, 'card:closed:rh2')).toBeUndefined();
  });

  it('un reporte diario subido al día siguiente del turno queda retroactivo, firmado con el snapshot si la cuenta ya no existe', async () => {
    prisma.reporteDiario.findMany.mockResolvedValue([
      {
        id: 'rd1',
        fecha: dia('2026-11-11'),
        turno: 'NOCTURNO',
        supervisorId: 'borrado',
        supervisorNombre: 'Carlos Pinto',
        createdAt: d('2026-11-12T12:00:00.000Z'),
      },
    ]);

    const res = await service.feed('2026-11-12', '2026-11-12');

    expect(evento(res, 'report:created:rd1')).toMatchObject({
      kind: 'DAILY_REPORT',
      dataDate: '2026-11-11',
      backdated: true,
      actorName: 'Carlos Pinto',
    });
  });

  it('OTs e intervenciones resuelven el equipo por el lookup de soft refs', async () => {
    prisma.ordenTrabajo.findMany.mockResolvedValue([
      {
        id: 'ot1',
        titulo: 'Cambio de aceite',
        equipoId: 'e1',
        createdAt: d('2026-11-12T12:00:00.000Z'),
        createdById: 'sup1',
      },
    ]);
    prisma.intervencion.findMany.mockResolvedValue([
      {
        id: 'i1',
        detalle: 'Se cambió el filtro',
        fecha: d('2026-11-12T16:00:00.000Z'),
        realizadaPorId: 'sup1',
        createdById: null,
        orden: { titulo: 'Cambio de aceite', equipoId: 'e1' },
      },
    ]);
    prisma.equipment.findMany.mockResolvedValue([
      { id: 'e1', internalCode: 'SEM-656' },
    ]);

    const res = await service.feed('2026-11-12', '2026-11-12');

    expect(evento(res, 'ot:created:ot1')).toMatchObject({
      kind: 'WORK_ORDER',
      action: 'CREATED',
      summary: 'Cambio de aceite · SEM-656',
    });
    expect(evento(res, 'ot:closed:i1')).toMatchObject({
      action: 'CLOSED',
      summary: 'Cambio de aceite · SEM-656',
    });
  });

  it('el historial de cambios entra con su módulo: UPDATE como edición y DELETE como eliminación, con el detalle', async () => {
    const cambio = {
      field: 'litros',
      label: 'Litros',
      before: '100',
      after: '120',
    };
    prisma.changeLog.findMany.mockResolvedValue([
      {
        id: 'cl1',
        entity: 'shift_card',
        action: 'UPDATE',
        userId: 'sup1',
        userName: 'Juan Pérez',
        changes: [cambio],
        createdAt: d('2026-11-12T15:00:00.000Z'),
      },
      {
        id: 'cl2',
        entity: 'hallazgo',
        action: 'DELETE',
        userId: 'adm1',
        userName: 'Admin',
        changes: [cambio, cambio],
        createdAt: d('2026-11-12T16:00:00.000Z'),
      },
    ]);

    const res = await service.feed('2026-11-12', '2026-11-12');

    expect(evento(res, 'log:cl1')).toMatchObject({
      kind: 'SHIFT_CARD',
      action: 'UPDATED',
      actorName: 'Juan Pérez',
      summary: 'Tarjeta de turno · 1 dato',
      changes: [cambio],
      dataDate: null,
      backdated: false,
    });
    expect(evento(res, 'log:cl2')).toMatchObject({
      kind: 'FINDING',
      action: 'DELETED',
      summary: 'Hallazgo · 2 datos',
    });
  });

  it('lo actuado FUERA del rango se descarta aunque la ventana ancha lo traiga, y el feed sale del más reciente al más viejo', async () => {
    prisma.trabajoExtraordinario.findMany.mockResolvedValue([
      {
        id: 'te1',
        numero: 7,
        fecha: d('2026-11-12T13:00:00.000Z'),
        operador: 'Pedro Rojas',
        totalHoras: 5.5,
        createdAt: d('2026-11-12T13:00:00.000Z'),
        createdById: 'sup1',
        equipo: { internalCode: 'CAM-31' },
      },
      {
        // Registrado el 13 (día de negocio siguiente): fuera del rango pedido.
        id: 'te2',
        numero: 8,
        fecha: d('2026-11-13T13:00:00.000Z'),
        operador: 'Pedro Rojas',
        totalHoras: 2,
        createdAt: d('2026-11-13T13:00:00.000Z'),
        createdById: 'sup1',
        equipo: { internalCode: 'CAM-31' },
      },
    ]);
    prisma.hallazgo.findMany.mockResolvedValue([
      {
        id: 'h1',
        tipo: 'ZONA',
        descripcion: 'Camino cortado',
        prioridad: 'ALTA',
        faena: 'Patillo',
        lugar: 'Ruta interna',
        fecha: d('2026-11-12T17:00:00.000Z'),
        createdAt: d('2026-11-12T17:00:00.000Z'),
        createdById: 'sup1',
        equipo: null,
      },
    ]);

    const res = await service.feed('2026-11-12', '2026-11-12');

    expect(res.events.map((e) => e.id)).toEqual([
      'finding:created:h1',
      'extra:created:te1',
    ]);
    expect(evento(res, 'extra:created:te1')).toMatchObject({
      summary: 'N° 7 · CAM-31 · Pedro Rojas · 5,5 h',
    });
    expect(evento(res, 'finding:created:h1')).toMatchObject({
      summary: 'Ruta interna · Patillo · Camino cortado',
    });
  });

  it('sin `from`/`to` cubre los últimos 7 días terminando hoy', async () => {
    const res = await service.feed();

    expect(res.to >= res.from).toBe(true);
    const dias =
      (dia(res.to).getTime() - dia(res.from).getTime()) / (24 * 60 * 60 * 1000);
    expect(dias).toBe(6);
  });
});
