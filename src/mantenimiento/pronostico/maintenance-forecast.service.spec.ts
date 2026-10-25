import type { PrismaService } from '../../common/prisma/prisma.service';
import type { MaintenancePlansService } from '../maintenance-plans/maintenance-plans.service';
import { MaintenanceForecastService } from './maintenance-forecast.service';

const NOW = new Date('2026-10-24T15:00:00.000Z');
const haceDias = (n: number) =>
  new Date(NOW.getTime() - n * 24 * 60 * 60 * 1000);

function build() {
  const prisma = {
    equipment: { findMany: jest.fn(), findUnique: jest.fn() },
    registroHorometro: { findMany: jest.fn().mockResolvedValue([]) },
  };
  const plans = { statusForAll: jest.fn().mockResolvedValue([]) };
  const service = new MaintenanceForecastService(
    prisma as unknown as PrismaService,
    plans as unknown as MaintenancePlansService,
  );
  return { prisma, plans, service };
}

const PESADO = {
  id: 'eq_p',
  equipmentClass: 'HEAVY',
  controlUnit: 'HOURS',
  currentMileage: null,
};
const LIVIANO = {
  id: 'eq_l',
  equipmentClass: 'LIGHT',
  controlUnit: 'KM',
  currentMileage: 29530,
};

describe('MaintenanceForecastService', () => {
  it('pesado con pauta: estima con sus horas máquina; liviano sin pauta: ciclo de 10.000 km', async () => {
    const { prisma, plans, service } = build();
    prisma.equipment.findMany.mockResolvedValue([PESADO, LIVIANO]);
    plans.statusForAll.mockResolvedValue([
      {
        equipmentId: 'eq_p',
        unit: 'h',
        alertBefore: 50,
        status: { next: { dueAt: 2250, remaining: 100 } },
      },
    ]);
    prisma.registroHorometro.findMany.mockResolvedValue([
      // Pesado: 20 h por día durante 10 días.
      {
        equipoId: 'eq_p',
        fecha: haceDias(10),
        valorInicial: 1950,
        fechaSalida: haceDias(10),
        closedAt: haceDias(10),
        valorFinal: 1950,
        belowPreviousReading: false,
      },
      {
        equipoId: 'eq_p',
        fecha: NOW,
        valorInicial: 2150,
        fechaSalida: null,
        closedAt: null,
        valorFinal: null,
        belowPreviousReading: false,
      },
    ]);

    const filas = await service.forAll(NOW);

    expect(prisma.equipment.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { status: { not: 'OUT_OF_SERVICE' } } }),
    );
    const pesado = filas.find((f) => f.equipmentId === 'eq_p')!;
    expect(pesado).toMatchObject({
      unit: 'h',
      source: 'PAUTA',
      nextAt: 2250,
      remaining: 100,
      status: 'ESTIMADA',
      dailyUsage: 20,
      estimatedDate: '2026-10-29',
    });
    // El liviano no tiene lecturas todavía: se sabe lo que falta, no la fecha.
    expect(filas.find((f) => f.equipmentId === 'eq_l')).toMatchObject({
      unit: 'km',
      source: 'LIVIANO',
      nextAt: 30000,
      remaining: 470,
      status: 'FALTAN_DATOS',
      estimatedDate: null,
    });
  });

  it('un pesado sin pauta no tiene próxima mantención: no aparece', async () => {
    const { prisma, service } = build();
    prisma.equipment.findMany.mockResolvedValue([PESADO]);

    expect(await service.forAll(NOW)).toEqual([]);
    expect(prisma.registroHorometro.findMany).not.toHaveBeenCalled();
  });

  it('fuera de servicio no se estima', async () => {
    const { prisma, service } = build();
    prisma.equipment.findUnique.mockResolvedValue({
      ...LIVIANO,
      status: 'OUT_OF_SERVICE',
    });

    expect(await service.forEquipment('eq_l', NOW)).toBeNull();
  });
});
