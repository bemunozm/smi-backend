import { Test } from '@nestjs/testing';

import { PrismaService } from '../common/prisma/prisma.service';
import { businessDayKey } from '../common/dates/business-time';
import { DashboardService } from './dashboard.service';

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
};

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
    expect(businessDayKey(new Date('2026-10-17T02:30:00.000Z'))).toBe('2026-10-16');
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
      { equipoId: 'e1', operador: 'Patricio Rojas', turno: 'DIURNO', supervisorId: 'u1' },
    ]);
    const res = await service.hoy();
    expect(res.totales).toEqual({ enUso: 1, disponibles: 1, inoperativos: 2 });
    const e1 = res.equipos.find((e) => e.equipmentId === 'e1');
    expect(e1).toMatchObject({
      estado: 'EN_USO',
      operador: 'Patricio Rojas',
      turno: 'DIURNO',
      supervisor: 'Limbert V.',
    });
    expect(res.equipos.find((e) => e.equipmentId === 'e2')?.estado).toBe('DISPONIBLE');
    expect(res.equipos.find((e) => e.equipmentId === 'e4')?.estado).toBe('INOPERATIVO');
  });

  it('una tarjeta abierta HOY gana sobre IN_WORKSHOP (opera de facto)', async () => {
    prisma.equipment.findMany.mockResolvedValue(EQUIPOS);
    prisma.registroHorometro.findMany.mockResolvedValue([
      { equipoId: 'e3', operador: 'Cristian Araya', turno: 'DIURNO', supervisorId: 'u1' },
    ]);
    const res = await service.hoy();
    expect(res.equipos.find((e) => e.equipmentId === 'e3')?.estado).toBe('EN_USO');
  });

  it('la consulta de tarjetas pide SOLO abiertas y de hoy', async () => {
    prisma.equipment.findMany.mockResolvedValue([]);
    prisma.registroHorometro.findMany.mockResolvedValue([]);
    await service.hoy();
    const where = prisma.registroHorometro.findMany.mock.calls[0][0].where;
    expect(where.valorFinal).toBeNull();
    expect(where.fecha.gte).toBeInstanceOf(Date);
    expect(where.fecha.lt).toBeInstanceOf(Date);
  });

  it('supervisorId null o sin match en user sale como (sin asignar), en una sola consulta batch', async () => {
    prisma.equipment.findMany.mockResolvedValue([EQUIPOS[0], EQUIPOS[1]]);
    prisma.registroHorometro.findMany.mockResolvedValue([
      { equipoId: 'e1', operador: 'A', turno: 'DIURNO', supervisorId: null },
      { equipoId: 'e2', operador: 'B', turno: 'NOCTURNO', supervisorId: 'u-borrado' },
    ]);
    prisma.user.findMany.mockResolvedValue([]);
    const res = await service.hoy();
    expect(res.equipos.find((e) => e.equipmentId === 'e1')?.supervisor).toBe('(sin asignar)');
    expect(res.equipos.find((e) => e.equipmentId === 'e2')?.supervisor).toBe('(sin asignar)');
    expect(prisma.user.findMany).toHaveBeenCalledTimes(1);
  });
});
