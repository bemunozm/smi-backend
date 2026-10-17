import { Test } from '@nestjs/testing';

import { PrismaService } from '../common/prisma/prisma.service';
import { businessDayKey } from '../common/dates/business-time';
import { DashboardService, limitesDeHoy } from './dashboard.service';

// Mocks compartidos a nivel de archivo: las Tasks 2-4 agregan describes
// hermanos que reutilizan `prisma` y `service`.
let service: DashboardService;
const prisma = {
  equipment: { findMany: jest.fn() },
  registroHorometro: { findMany: jest.fn() },
  registroCombustible: { findMany: jest.fn() },
  trabajoExtraordinario: { findMany: jest.fn() },
  shift: { findMany: jest.fn() },
  produccionTurno: { findMany: jest.fn() },
  user: { findMany: jest.fn() },
  inventoryItem: { findFirst: jest.fn() },
};

const argDe = <T>(fn: jest.Mock, n: number, i: number): T =>
  (fn.mock.calls[n] as unknown[])[i] as T;

beforeEach(async () => {
  const mod = await Test.createTestingModule({
    providers: [DashboardService, { provide: PrismaService, useValue: prisma }],
  }).compile();
  service = mod.get(DashboardService);
  jest.clearAllMocks();
  prisma.user.findMany.mockResolvedValue([{ id: 'u1', name: 'Limbert V.' }]);
});

describe('businessDayKey', () => {
  it('un instante después de medianoche UTC sigue siendo el día local correcto', () => {
    // 2026-10-16 23:30 en Chile continental (UTC-3) = 2026-10-17T02:30Z
    expect(businessDayKey(new Date('2026-10-17T02:30:00.000Z'))).toBe(
      '2026-10-16',
    );
  });
});

describe('DashboardService.hoy', () => {
  const EQUIPOS = [
    { id: 'e1', internalCode: 'CG-002', status: 'OPERATIONAL' },
    { id: 'e2', internalCode: 'EX-001', status: 'OPERATIONAL' },
    { id: 'e3', internalCode: 'CM-006', status: 'IN_WORKSHOP' },
    { id: 'e4', internalCode: 'CN-007', status: 'OUT_OF_SERVICE' },
  ];

  it('clasifica en uso / disponible / inoperativo con totales', async () => {
    prisma.equipment.findMany.mockResolvedValue(EQUIPOS);
    prisma.registroHorometro.findMany.mockResolvedValue([
      {
        equipoId: 'e1',
        operador: 'Patricio Rojas',
        turno: 'DIURNO',
        supervisorId: 'u1',
      },
    ]);
    const res = await service.hoy();
    expect(res.totales).toEqual({ enUso: 1, disponibles: 1, inoperativos: 2 });
    const e1 = res.equipos.find((e) => e.equipmentId === 'e1');
    expect(e1).toMatchObject({
      estado: 'EN_USO',
      status: 'OPERATIONAL',
      operador: 'Patricio Rojas',
      turno: 'DIURNO',
      supervisor: 'Limbert V.',
    });
    expect(res.equipos.find((e) => e.equipmentId === 'e2')?.estado).toBe(
      'DISPONIBLE',
    );
    expect(res.equipos.find((e) => e.equipmentId === 'e4')?.estado).toBe(
      'INOPERATIVO',
    );
    expect(res.equipos.map((e) => e.status)).toEqual([
      'OPERATIONAL',
      'OPERATIONAL',
      'IN_WORKSHOP',
      'OUT_OF_SERVICE',
    ]);
  });

  it('una tarjeta abierta HOY gana sobre IN_WORKSHOP (opera de facto)', async () => {
    prisma.equipment.findMany.mockResolvedValue(EQUIPOS);
    prisma.registroHorometro.findMany.mockResolvedValue([
      {
        equipoId: 'e3',
        operador: 'Cristian Araya',
        turno: 'DIURNO',
        supervisorId: 'u1',
      },
    ]);
    const res = await service.hoy();
    expect(res.equipos.find((e) => e.equipmentId === 'e3')?.estado).toBe(
      'EN_USO',
    );
  });

  it('la consulta de tarjetas pide SOLO abiertas y de hoy', async () => {
    prisma.equipment.findMany.mockResolvedValue([]);
    prisma.registroHorometro.findMany.mockResolvedValue([]);
    await service.hoy();
    const { where } = argDe<{
      where: { valorFinal: unknown; fecha: { gte: unknown; lt: unknown } };
    }>(prisma.registroHorometro.findMany, 0, 0);
    expect(where.valorFinal).toBeNull();
    expect(where.fecha.gte).toBeInstanceOf(Date);
    expect(where.fecha.lt).toBeInstanceOf(Date);
  });

  it('supervisorId null o sin match en user sale como (sin asignar), en una sola consulta batch', async () => {
    prisma.equipment.findMany.mockResolvedValue([EQUIPOS[0], EQUIPOS[1]]);
    prisma.registroHorometro.findMany.mockResolvedValue([
      { equipoId: 'e1', operador: 'A', turno: 'DIURNO', supervisorId: null },
      {
        equipoId: 'e2',
        operador: 'B',
        turno: 'NOCTURNO',
        supervisorId: 'u-borrado',
      },
    ]);
    prisma.user.findMany.mockResolvedValue([]);
    const res = await service.hoy();
    expect(res.equipos.find((e) => e.equipmentId === 'e1')?.supervisor).toBe(
      '(sin asignar)',
    );
    expect(res.equipos.find((e) => e.equipmentId === 'e2')?.supervisor).toBe(
      '(sin asignar)',
    );
    expect(prisma.user.findMany).toHaveBeenCalledTimes(1);
  });
});

describe('limitesDeHoy', () => {
  it('día normal dura 24h', () => {
    const { gte, lt } = limitesDeHoy(new Date('2026-10-16T15:00:00.000Z'));
    expect(lt.getTime() - gte.getTime()).toBe(24 * 3_600_000);
    expect(businessDayKey(gte)).toBe('2026-10-16');
    expect(businessDayKey(new Date(lt.getTime() - 1))).toBe('2026-10-16');
    expect(businessDayKey(lt)).toBe('2026-10-17');
  });

  it('días de cambio de hora (23h y 25h) cierran en la medianoche local', () => {
    // Fechas reales de cambio de Chile 2026: se detectan por duración != 24h.
    for (const dia of [
      '2026-04-04',
      '2026-04-05',
      '2026-09-05',
      '2026-09-06',
    ]) {
      const { gte, lt } = limitesDeHoy(new Date(`${dia}T18:00:00.000Z`));
      expect(businessDayKey(gte)).toBe(dia);
      expect(businessDayKey(new Date(gte.getTime() - 1))).not.toBe(dia);
      expect(businessDayKey(new Date(lt.getTime() - 1))).toBe(dia);
      expect(businessDayKey(lt)).not.toBe(dia);
    }
    const horas = ['2026-04-04', '2026-04-05', '2026-09-05', '2026-09-06'].map(
      (d) => {
        const { gte, lt } = limitesDeHoy(new Date(`${d}T18:00:00.000Z`));
        return (lt.getTime() - gte.getTime()) / 3_600_000;
      },
    );
    expect(horas.some((h) => h !== 24)).toBe(true);
  });
});

describe('DashboardService.hoy (duplicados)', () => {
  it('dos tarjetas abiertas del mismo equipo: gana la más reciente', async () => {
    prisma.equipment.findMany.mockResolvedValue([
      { id: 'e1', internalCode: 'CG-002', status: 'OPERATIONAL' },
    ]);
    prisma.registroHorometro.findMany.mockResolvedValue([
      {
        equipoId: 'e1',
        operador: 'Vieja',
        turno: 'DIURNO',
        supervisorId: null,
      },
      {
        equipoId: 'e1',
        operador: 'Nueva',
        turno: 'NOCTURNO',
        supervisorId: null,
      },
    ]);
    const res = await service.hoy();
    const { orderBy } = argDe<{ orderBy: unknown }>(
      prisma.registroHorometro.findMany,
      0,
      0,
    );
    expect(orderBy).toEqual({ fecha: 'asc' });
    expect(res.equipos[0].operador).toBe('Nueva');
  });
});

describe('DashboardService.equipos', () => {
  beforeEach(() => {
    prisma.equipment.findMany.mockResolvedValue([
      { id: 'e1', internalCode: 'CG-002' },
      { id: 'e2', internalCode: 'EX-001' },
    ]);
    prisma.registroCombustible.findMany.mockResolvedValue([]);
    prisma.registroHorometro.findMany.mockResolvedValue([]);
  });

  it('suma horas de tarjetas cerradas y litros; serie diaria por día de negocio', async () => {
    prisma.registroHorometro.findMany.mockResolvedValue([
      // 2026-10-02 10:00 Chile = 13:00Z
      {
        equipoId: 'e1',
        valorInicial: 100,
        valorFinal: 106,
        fecha: new Date('2026-10-02T13:00:00.000Z'),
      },
      {
        equipoId: 'e1',
        valorInicial: 106,
        valorFinal: 110,
        fecha: new Date('2026-10-03T13:00:00.000Z'),
      },
    ]);
    prisma.registroCombustible.findMany.mockResolvedValue([
      {
        equipoId: 'e1',
        litros: 50,
        fecha: new Date('2026-10-02T13:00:00.000Z'),
      },
    ]);
    const res = await service.equipos({
      desde: '2026-10-01',
      hasta: '2026-10-03',
    });
    const e1 = res.find((x) => x.equipmentId === 'e1')!;
    expect(e1.horas).toBe(10);
    expect(e1.litros).toBe(50);
    expect(e1.rendimiento).toBe(5);
    expect(e1.serieDiaria).toEqual([
      { fecha: '2026-10-01', horas: 0, opero: false },
      { fecha: '2026-10-02', horas: 6, opero: true },
      { fecha: '2026-10-03', horas: 4, opero: true },
    ]);
  });

  it('TODOS los equipos salen, con ceros cuando no hubo actividad', async () => {
    const res = await service.equipos({
      desde: '2026-10-01',
      hasta: '2026-10-01',
    });
    expect(res).toHaveLength(2);
    expect(res[1]).toMatchObject({ horas: 0, litros: 0, rendimiento: null });
  });

  it('rendimiento: litros>0 con horas=0 → null (nunca Infinity); litros 0 con horas>0 → 0', async () => {
    prisma.registroCombustible.findMany.mockResolvedValue([
      {
        equipoId: 'e1',
        litros: 30,
        fecha: new Date('2026-10-01T13:00:00.000Z'),
      },
    ]);
    prisma.registroHorometro.findMany.mockResolvedValue([
      {
        equipoId: 'e2',
        valorInicial: 10,
        valorFinal: 14,
        fecha: new Date('2026-10-01T13:00:00.000Z'),
      },
    ]);
    const res = await service.equipos({
      desde: '2026-10-01',
      hasta: '2026-10-01',
    });
    expect(res.find((x) => x.equipmentId === 'e1')?.rendimiento).toBeNull();
    expect(res.find((x) => x.equipmentId === 'e2')?.rendimiento).toBe(0);
  });

  it('una tarjeta que abre antes de medianoche local no se corre de día', async () => {
    // 2026-10-02 23:30 Chile (UTC-3) = 2026-10-03T02:30Z
    prisma.registroHorometro.findMany.mockResolvedValue([
      {
        equipoId: 'e1',
        valorInicial: 0,
        valorFinal: 2,
        fecha: new Date('2026-10-03T02:30:00.000Z'),
      },
    ]);
    const res = await service.equipos({
      desde: '2026-10-02',
      hasta: '2026-10-02',
    });
    expect(res.find((x) => x.equipmentId === 'e1')?.serieDiaria[0]).toEqual({
      fecha: '2026-10-02',
      horas: 2,
      opero: true,
    });
  });

  it('litros se recortan al día de negocio: carga fuera del rango no suma', async () => {
    // 2026-10-01 01:00Z = 2026-09-30 22:00 Chile: fuera de un rango que empieza 10-01
    // 2026-10-01 15:00Z = 2026-10-01 12:00 Chile: dentro
    prisma.registroCombustible.findMany.mockResolvedValue([
      {
        equipoId: 'e1',
        litros: 20,
        fecha: new Date('2026-10-01T01:00:00.000Z'),
      },
      {
        equipoId: 'e1',
        litros: 15,
        fecha: new Date('2026-10-01T15:00:00.000Z'),
      },
    ]);
    const res = await service.equipos({
      desde: '2026-10-01',
      hasta: '2026-10-01',
    });
    expect(res.find((x) => x.equipmentId === 'e1')?.litros).toBe(15);
  });

  it('tarjeta cerrada dentro de la ventana SQL pero fuera del día de negocio se descarta', async () => {
    // 2026-10-02T06:00Z = 2026-10-02 03:00 Chile: día siguiente al rango 10-01
    prisma.registroHorometro.findMany.mockResolvedValue([
      {
        equipoId: 'e1',
        valorInicial: 100,
        valorFinal: 106,
        fecha: new Date('2026-10-02T06:00:00.000Z'),
      },
    ]);
    const res = await service.equipos({
      desde: '2026-10-01',
      hasta: '2026-10-01',
    });
    const e1 = res.find((x) => x.equipmentId === 'e1')!;
    expect(e1.horas).toBe(0);
    expect(e1.serieDiaria[0].opero).toBe(false);
  });

  it('desde > hasta devuelve equipos con serie vacía, no error', async () => {
    const res = await service.equipos({
      desde: '2026-12-01',
      hasta: '2026-01-01',
    });
    expect(res[0].serieDiaria).toEqual([]);
    expect(res[0].horas).toBe(0);
  });
});

describe('DashboardService.supervisores', () => {
  it('agrupa horas y equipos distintos por tipo de turno y por supervisor', async () => {
    prisma.registroHorometro.findMany.mockResolvedValue([
      {
        equipoId: 'e1',
        turno: 'DIURNO',
        supervisorId: 'u1',
        valorInicial: 0,
        valorFinal: 6,
        fecha: new Date('2026-10-02T13:00:00.000Z'),
      },
      {
        equipoId: 'e2',
        turno: 'DIURNO',
        supervisorId: 'u1',
        valorInicial: 0,
        valorFinal: 4,
        fecha: new Date('2026-10-02T13:00:00.000Z'),
      },
      {
        equipoId: 'e1',
        turno: 'NOCTURNO',
        supervisorId: 'u2',
        valorInicial: 6,
        valorFinal: 9,
        fecha: new Date('2026-10-03T01:00:00.000Z'),
      },
    ]);
    prisma.shift.findMany.mockResolvedValue([
      { supervisorId: 'u1' },
      { supervisorId: 'u1' },
      { supervisorId: 'u2' },
    ]);
    prisma.user.findMany.mockResolvedValue([
      { id: 'u1', name: 'Limbert' },
      { id: 'u2', name: 'José' },
    ]);
    const res = await service.supervisores({
      desde: '2026-10-01',
      hasta: '2026-10-05',
    });
    expect(res.porTurno.DIURNO).toEqual({ horas: 10, equipos: 2 });
    expect(res.porTurno.NOCTURNO).toEqual({ horas: 3, equipos: 1 });
    const u1 = res.porSupervisor.find((s) => s.supervisorId === 'u1')!;
    expect(u1).toMatchObject({
      nombre: 'Limbert',
      horas: 10,
      equipos: 2,
      turnos: 2,
    });
  });

  it('rango sin tarjetas: ambas claves de porTurno existen en cero', async () => {
    prisma.registroHorometro.findMany.mockResolvedValue([]);
    prisma.shift.findMany.mockResolvedValue([]);
    prisma.user.findMany.mockResolvedValue([]);
    const res = await service.supervisores({
      desde: '2026-10-01',
      hasta: '2026-10-05',
    });
    expect(res.porTurno.DIURNO).toEqual({ horas: 0, equipos: 0 });
    expect(res.porTurno.NOCTURNO).toEqual({ horas: 0, equipos: 0 });
  });

  it('supervisor sin usuario sale como (sin asignar)', async () => {
    prisma.registroHorometro.findMany.mockResolvedValue([
      {
        equipoId: 'e1',
        turno: 'DIURNO',
        supervisorId: 'u-x',
        valorInicial: 0,
        valorFinal: 1,
        fecha: new Date('2026-10-02T13:00:00.000Z'),
      },
    ]);
    prisma.shift.findMany.mockResolvedValue([]);
    prisma.user.findMany.mockResolvedValue([]);
    const res = await service.supervisores({
      desde: '2026-10-01',
      hasta: '2026-10-05',
    });
    expect(res.porSupervisor[0].nombre).toBe('(sin asignar)');
  });
});

describe('DashboardService.mantenedores', () => {
  it('suma trabajos extraordinarios por equipo y total', async () => {
    const fecha = new Date('2026-10-02T13:00:00.000Z');
    prisma.trabajoExtraordinario.findMany.mockResolvedValue([
      {
        equipoId: 'e1',
        totalHoras: 3,
        fecha,
        equipo: { internalCode: 'CG-002' },
      },
      {
        equipoId: 'e1',
        totalHoras: 2,
        fecha,
        equipo: { internalCode: 'CG-002' },
      },
      {
        equipoId: 'e2',
        totalHoras: 5,
        fecha,
        equipo: { internalCode: 'EX-001' },
      },
    ]);
    const res = await service.mantenedores({
      desde: '2026-10-01',
      hasta: '2026-10-31',
    });
    expect(res.total).toEqual({ horas: 10, trabajos: 3 });
    expect(res.porEquipo).toEqual([
      { equipmentId: 'e1', internalCode: 'CG-002', horas: 5, trabajos: 2 },
      { equipmentId: 'e2', internalCode: 'EX-001', horas: 5, trabajos: 1 },
    ]);
  });
});

describe('DashboardService.vueltas', () => {
  it('agrega camiones×vueltas POR SECCIÓN con serie diaria y sin total general', async () => {
    prisma.produccionTurno.findMany.mockResolvedValue([
      {
        seccion: 'INTERNOS',
        camiones: 5,
        vueltasPorCamion: 4,
        reporte: { fecha: new Date('2026-10-02T00:00:00.000Z') },
      },
      {
        seccion: 'INTERNOS',
        camiones: 6,
        vueltasPorCamion: 5,
        reporte: { fecha: new Date('2026-10-03T00:00:00.000Z') },
      },
      {
        seccion: 'MINA_CALETA',
        camiones: 16,
        vueltasPorCamion: 3,
        reporte: { fecha: new Date('2026-10-02T00:00:00.000Z') },
      },
    ]);
    const res = await service.vueltas({
      desde: '2026-10-02',
      hasta: '2026-10-03',
    });
    expect(res).not.toHaveProperty('total');
    const internos = res.porSeccion.find((s) => s.seccion === 'INTERNOS')!;
    expect(internos.vueltasTotales).toBe(50); // 5×4 + 6×5
    expect(internos.serieDiaria).toEqual([
      { fecha: '2026-10-02', vueltas: 20 },
      { fecha: '2026-10-03', vueltas: 30 },
    ]);
    // Las 3 secciones siempre presentes, aunque sin datos:
    expect(res.porSeccion.map((s) => s.seccion)).toEqual([
      'INTERNOS',
      'MINA_CALETA',
      'MINERAS',
    ]);
    expect(res.porSeccion[2].vueltasTotales).toBe(0);
  });
});

describe('DashboardService.resumenDia', () => {
  const HOY = new Date(); // el servicio usa "ahora"; los datos se mockean
  const card = (
    id: string,
    equipoId: string,
    code: string,
    turno: string,
    valorInicial: number,
    valorFinal: number | null,
  ) => ({
    id,
    equipoId,
    turno,
    valorInicial,
    valorFinal,
    equipo: { internalCode: code },
  });
  const carga = (
    equipoId: string,
    litros: number,
    registroHorometroId: string | null,
  ) => ({
    equipoId,
    litros,
    registroHorometroId,
    fecha: HOY,
    equipo: { internalCode: { e0: 'AA-001', e1: 'CG-002' }[equipoId] },
  });

  beforeEach(() => {
    prisma.registroHorometro.findMany.mockResolvedValue([]);
    prisma.registroCombustible.findMany.mockResolvedValue([]);
    prisma.trabajoExtraordinario.findMany.mockResolvedValue([]);
    prisma.produccionTurno.findMany.mockResolvedValue([]);
    prisma.inventoryItem.findFirst.mockResolvedValue(null);
  });

  it('hm día/noche de cerradas y lecturas con tarjeta abierta en curso', async () => {
    prisma.registroHorometro.findMany.mockResolvedValue([
      card('t2', 'e2', 'EX-001', 'NOCTURNO', 50, 54.5),
      card('t1', 'e1', 'CG-002', 'DIURNO', 100, 106),
      card('t3', 'e1', 'CG-002', 'NOCTURNO', 106, null),
    ]);
    const res = await service.resumenDia();
    expect(res.fecha).toBe(businessDayKey(new Date()));
    expect(res.hm).toEqual({ total: 10.5, dia: 6, noche: 4.5 });
    expect(res.lecturas).toEqual([
      {
        id: 't1',
        internalCode: 'CG-002',
        turno: 'DIURNO',
        inicial: 100,
        final: 106,
        avance: 6,
      },
      {
        id: 't3',
        internalCode: 'CG-002',
        turno: 'NOCTURNO',
        inicial: 106,
        final: null,
        avance: null,
      },
      {
        id: 't2',
        internalCode: 'EX-001',
        turno: 'NOCTURNO',
        inicial: 50,
        final: 54.5,
        avance: 4.5,
      },
    ]);
    const where = argDe<{ where: { fecha: unknown } }>(
      prisma.registroHorometro.findMany,
      0,
      0,
    ).where;
    expect(where.fecha).toEqual(limitesDeHoy());
  });

  it('diésel: vinculada va al turno de su tarjeta, sin vínculo solo al total; porHm', async () => {
    prisma.registroHorometro.findMany.mockResolvedValue([
      card('t1', 'e1', 'CG-002', 'DIURNO', 100, 104),
      card('t2', 'e1', 'CG-002', 'NOCTURNO', 104, 108),
    ]);
    prisma.registroCombustible.findMany.mockResolvedValue([
      carga('e1', 40, 't1'),
      carga('e1', 60, 't2'),
      carga('e1', 20, null),
    ]);
    const res = await service.resumenDia();
    expect(res.diesel).toEqual({ total: 120, dia: 40, noche: 60, porHm: 15 });
  });

  it('descarta cargas fuera del día de negocio (ventana ampliada)', async () => {
    prisma.registroCombustible.findMany.mockResolvedValue([
      carga('e1', 10, null),
      {
        equipoId: 'e1',
        litros: 99,
        registroHorometroId: null,
        equipo: { internalCode: 'CG-002' },
        fecha: new Date(Date.now() - 3 * 86_400_000),
      },
    ]);
    const res = await service.resumenDia();
    expect(res.diesel.total).toBe(10);
  });

  it('porHm es null con 0 hm', async () => {
    prisma.registroCombustible.findMany.mockResolvedValue([
      carga('e1', 30, null),
    ]);
    const res = await service.resumenDia();
    expect(res.hm.total).toBe(0);
    expect(res.diesel.porHm).toBeNull();
  });

  it('reports: horas por equipo de hoy, orden desc', async () => {
    prisma.trabajoExtraordinario.findMany.mockResolvedValue([
      {
        equipoId: 'e1',
        totalHoras: 1.5,
        fecha: HOY,
        equipo: { internalCode: 'CG-002' },
      },
      {
        equipoId: 'e2',
        totalHoras: 4,
        fecha: HOY,
        equipo: { internalCode: 'EX-001' },
      },
      {
        equipoId: 'e1',
        totalHoras: 1,
        fecha: HOY,
        equipo: { internalCode: 'CG-002' },
      },
    ]);
    const res = await service.resumenDia();
    expect(res.reports).toEqual({
      totalHoras: 6.5,
      porEquipo: [
        { internalCode: 'EX-001', horas: 4 },
        { internalCode: 'CG-002', horas: 2.5 },
      ],
    });
  });

  it('producción de hoy: vueltas por sección sin ampliar la fecha', async () => {
    prisma.produccionTurno.findMany.mockResolvedValue([
      { seccion: 'INTERNOS', camiones: 5, vueltasPorCamion: 4 },
      { seccion: 'INTERNOS', camiones: 2, vueltasPorCamion: 3 },
      { seccion: 'MINA_CALETA', camiones: 16, vueltasPorCamion: 3 },
    ]);
    const res = await service.resumenDia();
    expect(res.produccion).toEqual({
      internos: 26,
      minaCaleta: 48,
      mineras: 0,
    });
    const w = argDe<{ where: { reporte: { fecha: Date } } }>(
      prisma.produccionTurno.findMany,
      0,
      0,
    ).where;
    expect(w.reporte.fecha.toISOString()).toBe(
      `${businessDayKey(new Date())}T00:00:00.000Z`,
    );
  });

  it('adBlue: null sin ítem; con ítem suma stocks', async () => {
    expect((await service.resumenDia()).adBlue).toBeNull();
    prisma.inventoryItem.findFirst.mockReset();
    prisma.inventoryItem.findFirst.mockResolvedValue({
      id: 'i1',
      name: 'AdBlue 20L',
      unit: 'LITER',
      stocks: [{ quantity: 100 }, { quantity: 50.5 }],
    });
    expect((await service.resumenDia()).adBlue).toEqual({
      itemId: 'i1',
      nombre: 'AdBlue 20L',
      stock: 150.5,
      unidad: 'LITER',
    });
  });

  it('adBlue: reintenta con "ad blue" (con espacio) si "adblue" no existe', async () => {
    prisma.inventoryItem.findFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        id: 'i2',
        name: 'Ad Blue',
        unit: 'LITER',
        stocks: [],
      });
    const res = await service.resumenDia();
    expect(res.adBlue).toMatchObject({ itemId: 'i2', stock: 0 });
  });

  describe('filtro por fecha', () => {
    const primerWhere = (m: jest.Mock): Record<string, unknown> =>
      (m.mock.calls[0] as [{ where: Record<string, unknown> }])[0].where;
    it('el param fecha fija los límites de tarjetas y el eco de fecha', async () => {
      const res = await service.resumenDia('2026-10-15');
      expect(res.fecha).toBe('2026-10-15');
      const { gte, lt } = primerWhere(prisma.registroHorometro.findMany)
        .fecha as { gte: Date; lt: Date };
      // Una tarjeta del 15 (mediodía Chile) entra; una del 16 no.
      const del15 = new Date('2026-10-15T15:00:00.000Z');
      const del16 = new Date('2026-10-16T15:00:00.000Z');
      expect(del15 >= gte && del15 < lt).toBe(true);
      expect(del16 >= gte && del16 < lt).toBe(false);
      expect(businessDayKey(gte)).toBe('2026-10-15');
      expect(businessDayKey(lt)).toBe('2026-10-16');
    });

    it('descarta cargas fuera del día objetivo', async () => {
      prisma.registroCombustible.findMany.mockResolvedValue([
        {
          ...carga('e1', 40, null),
          fecha: new Date('2026-10-15T15:00:00.000Z'),
        },
        {
          ...carga('e1', 99, null),
          fecha: new Date('2026-10-16T15:00:00.000Z'),
        },
      ]);
      const res = await service.resumenDia('2026-10-15');
      expect(res.diesel.total).toBe(40);
    });

    it('producción usa el día del param (@db.Date)', async () => {
      await service.resumenDia('2026-10-15');
      expect(primerWhere(prisma.produccionTurno.findMany)).toEqual({
        reporte: { fecha: new Date('2026-10-15T00:00:00.000Z') },
      });
    });

    it('sin param = hoy', async () => {
      const res = await service.resumenDia();
      const hoy = businessDayKey(new Date());
      expect(res.fecha).toBe(hoy);
      expect(primerWhere(prisma.produccionTurno.findMany)).toEqual({
        reporte: { fecha: new Date(`${hoy}T00:00:00.000Z`) },
      });
    });
  });

  it('operacionPorEquipo: total = día + noche + no vinculados; solo con actividad', async () => {
    prisma.registroHorometro.findMany.mockResolvedValue([
      card('t1', 'e1', 'CG-002', 'DIURNO', 100, 106),
      card('t2', 'e1', 'CG-002', 'NOCTURNO', 106, 110),
      card('t3', 'e3', 'ZZ-009', 'DIURNO', 5, null),
    ]);
    prisma.registroCombustible.findMany.mockResolvedValue([
      carga('e1', 40, 't1'),
      carga('e1', 30, 't2'),
      carga('e1', 10, null),
      carga('e0', 7, null),
    ]);
    const res = await service.resumenDia();
    expect(res.operacionPorEquipo).toEqual([
      {
        internalCode: 'AA-001',
        dia: { hm: 0, litros: 0 },
        noche: { hm: 0, litros: 0 },
        total: { hm: 0, litros: 7 },
      },
      {
        internalCode: 'CG-002',
        dia: { hm: 6, litros: 40 },
        noche: { hm: 4, litros: 30 },
        total: { hm: 10, litros: 80 },
      },
    ]);
  });
});
