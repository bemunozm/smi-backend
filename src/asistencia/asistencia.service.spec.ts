import { BadRequestException } from '@nestjs/common';
import { Test } from '@nestjs/testing';

import { PrismaService } from '../common/prisma/prisma.service';
import { AsistenciaService } from './asistencia.service';

/** Instante UTC — los días se derivan en la zona de negocio (Chile). */
const d = (iso: string) => new Date(iso);
/** `Shift.date` es `@db.Date`: medianoche UTC. */
const dia = (ymd: string) => new Date(`${ymd}T00:00:00.000Z`);

const SUP1 = {
  id: 'sup1',
  name: 'Juan Pérez',
  role: 'SUPERVISOR',
  banned: false,
};
const SUP2 = {
  id: 'sup2',
  name: 'Ana Soto',
  role: 'SUPERVISOR',
  banned: false,
};
const OP1 = { id: 'op1', name: 'Pedro Rojas', isActive: true };
const OP2 = { id: 'op2', name: 'Luis Díaz', isActive: false };

const tarjeta = (over: Record<string, unknown> = {}) => ({
  supervisorId: 'sup1',
  operatorId: 'op1',
  fecha: d('2026-11-07T15:00:00.000Z'),
  shift: { date: dia('2026-11-07') },
  ...over,
});

describe('AsistenciaService', () => {
  let service: AsistenciaService;
  const prisma = {
    registroHorometro: { findMany: jest.fn() },
    trabajoExtraordinario: { findMany: jest.fn() },
    user: { findMany: jest.fn() },
    operator: { findMany: jest.fn() },
  };

  beforeEach(async () => {
    const mod = await Test.createTestingModule({
      providers: [
        AsistenciaService,
        { provide: PrismaService, useValue: prisma },
      ],
    }).compile();
    service = mod.get(AsistenciaService);
    jest.clearAllMocks();
    prisma.registroHorometro.findMany.mockResolvedValue([]);
    prisma.trabajoExtraordinario.findMany.mockResolvedValue([]);
    prisma.user.findMany.mockResolvedValue([SUP1, SUP2]);
    prisma.operator.findMany.mockResolvedValue([OP1, OP2]);
  });

  const persona = (res: { personas: Array<{ id: string }> }, id: string) =>
    res.personas.find((p) => p.id === id);

  it('la X cae en el día del TURNO: tarjeta del 7 subida el 8 marca el 7, y dos tarjetas del mismo día valen una sola X', async () => {
    prisma.registroHorometro.findMany.mockResolvedValue([
      // Subida el 8 (fecha = instante del dispositivo) pero del turno del 7.
      tarjeta({ fecha: d('2026-11-08T14:00:00.000Z') }),
      // Segunda tarjeta del mismo turno/día: no duplica la X.
      tarjeta({}),
    ]);

    const res = await service.mes('2026-11');

    expect(persona(res, 'sup1')).toMatchObject({ dias: [7], total: 1 });
    expect(persona(res, 'op1')).toMatchObject({ dias: [7], total: 1 });
  });

  it('un nocturno que cruza medianoche vale UNA sola X, en el día del turno', async () => {
    prisma.registroHorometro.findMany.mockResolvedValue([
      tarjeta({
        fecha: d('2026-11-07T23:30:00.000Z'), // 20:30 en Chile, día 7
        fechaSalida: d('2026-11-08T09:00:00.000Z'), // 06:00 del 8
        closedAt: d('2026-11-08T09:00:00.000Z'),
        shift: { date: dia('2026-11-07') },
      }),
    ]);

    const res = await service.mes('2026-11');

    expect(persona(res, 'sup1')).toMatchObject({ dias: [7], total: 1 });
    expect(persona(res, 'op1')).toMatchObject({ dias: [7], total: 1 });
  });

  it('una tarjeta sin turno usa el día de NEGOCIO de su fecha (23:00 de Chile sigue siendo ese día)', async () => {
    prisma.registroHorometro.findMany.mockResolvedValue([
      // 2026-11-08T02:00Z = 23:00 del día 7 en Chile.
      tarjeta({ shift: null, fecha: d('2026-11-08T02:00:00.000Z') }),
    ]);

    const res = await service.mes('2026-11');

    expect(persona(res, 'sup1')).toMatchObject({ dias: [7] });
    expect(persona(res, 'op1')).toMatchObject({ dias: [7] });
  });

  it('un Report (trabajo extra) marca la X del operador en su día, no la del supervisor', async () => {
    prisma.trabajoExtraordinario.findMany.mockResolvedValue([
      { operatorId: 'op1', fecha: d('2026-11-10T12:00:00.000Z') },
    ]);

    const res = await service.mes('2026-11');

    expect(persona(res, 'op1')).toMatchObject({ dias: [10], total: 1 });
    expect(persona(res, 'sup1')).toMatchObject({ dias: [], total: 0 });
  });

  it('una tarjeta de un mes vecino que entra por el margen de la query NO marca X en este mes', async () => {
    prisma.registroHorometro.findMany.mockResolvedValue([
      tarjeta({
        shift: { date: dia('2026-10-31') },
        fecha: d('2026-10-31T15:00:00.000Z'),
      }),
    ]);

    const res = await service.mes('2026-11');

    expect(persona(res, 'sup1')).toMatchObject({ dias: [], total: 0 });
  });

  it('quien no tiene rol SUPERVISOR (mantenedor con tarjetas de camioneta) no aparece ni suma', async () => {
    prisma.user.findMany.mockResolvedValue([
      SUP1,
      SUP2,
      {
        id: 'mant1',
        name: 'Mantenedor Uno',
        role: 'MANTENEDOR',
        banned: false,
      },
    ]);
    prisma.registroHorometro.findMany.mockResolvedValue([
      tarjeta({ supervisorId: 'mant1', operatorId: null }),
    ]);

    const res = await service.mes('2026-11');

    expect(persona(res, 'mant1')).toBeUndefined();
  });

  it('roster: activos sin X aparecen en 0; operador inactivo con X aparece; id sin usuario sale como «(usuario eliminado)»', async () => {
    prisma.registroHorometro.findMany.mockResolvedValue([
      tarjeta({ supervisorId: 'ghost', operatorId: 'op2' }),
    ]);

    const res = await service.mes('2026-11');

    // Activos sin ninguna X igual tienen fila (como el Excel).
    expect(persona(res, 'sup1')).toMatchObject({ dias: [], total: 0 });
    expect(persona(res, 'op1')).toMatchObject({ dias: [], total: 0 });
    // Inactivo con X en el mes: aparece con su historial.
    expect(persona(res, 'op2')).toMatchObject({ tipo: 'OPERADOR', dias: [7] });
    // Id con X que ya no existe como usuario.
    expect(persona(res, 'ghost')).toMatchObject({
      tipo: 'SUPERVISOR',
      nombre: '(usuario eliminado)',
      dias: [7],
    });
  });

  it('ordena supervisores primero y alfabético dentro de cada grupo; dias viene ascendente', async () => {
    prisma.registroHorometro.findMany.mockResolvedValue([
      tarjeta({ shift: { date: dia('2026-11-09') } }),
      tarjeta({}),
    ]);

    const res = await service.mes('2026-11');

    // Luis Díaz (inactivo, sin X este mes) NO aparece — regla del roster.
    const tipos = res.personas.map((p) => p.tipo);
    expect(tipos).toEqual(['SUPERVISOR', 'SUPERVISOR', 'OPERADOR']);
    expect(res.personas.map((p) => p.nombre)).toEqual([
      'Ana Soto',
      'Juan Pérez',
      'Pedro Rojas',
    ]);
    expect(persona(res, 'sup1')).toMatchObject({ dias: [7, 9], total: 2 });
  });

  it('informa los días reales del mes (febrero bisiesto 2028 → 29)', async () => {
    const res = await service.mes('2028-02');
    expect(res).toMatchObject({ mes: '2028-02', dias: 29 });
    expect((await service.mes('2026-11')).dias).toBe(30);
  });

  it('mes inválido → BadRequest', async () => {
    await expect(service.mes('2026-13')).rejects.toBeInstanceOf(
      BadRequestException,
    );
    await expect(service.mes('noviembre')).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });
});
