import { Test } from '@nestjs/testing';
import { HorometroService } from './horometro.service';
import { PrismaService } from '../../common/prisma/prisma.service';

describe('HorometroService', () => {
  let service: HorometroService;
  const prisma = {
    equipment: { findUnique: jest.fn(), update: jest.fn() },
    registroHorometro: { create: jest.fn(), update: jest.fn() },
  };

  beforeEach(async () => {
    const mod = await Test.createTestingModule({
      providers: [
        HorometroService,
        { provide: PrismaService, useValue: prisma },
      ],
    }).compile();
    service = mod.get(HorometroService);
    jest.clearAllMocks();
    prisma.equipment.findUnique.mockResolvedValue({
      id: 'e1',
      controlUnit: 'HOURS',
      currentHourmeter: 100,
    });
    prisma.registroHorometro.create.mockImplementation(
      ({ data }: { data: Record<string, unknown> }) => ({
        id: 'r1',
        ...data,
      }),
    );
  });

  it('al cerrar turno actualiza currentHourmeter del equipo si controla por horas', async () => {
    await service.create({
      equipoId: 'e1',
      operador: 'Juan Rojas',
      turno: 'DIURNO',
      valorInicial: 100,
      valorFinal: 130,
      nivelCombustible: 75,
    });
    expect(prisma.equipment.update).toHaveBeenCalledWith({
      where: { id: 'e1' },
      data: { currentHourmeter: 130 },
    });
  });

  it('sin valorFinal no toca el equipo', async () => {
    await service.create({
      equipoId: 'e1',
      operador: 'Juan Rojas',
      turno: 'NOCTURNO',
      valorInicial: 100,
    });
    expect(prisma.equipment.update).not.toHaveBeenCalled();
  });

  it('si el equipo controla por kilometraje no escribe currentHourmeter', async () => {
    prisma.equipment.findUnique.mockResolvedValue({
      id: 'e1',
      controlUnit: 'KM',
      currentMileage: 5000,
    });

    await service.create({
      equipoId: 'e1',
      operador: 'Juan Rojas',
      turno: 'DIURNO',
      valorInicial: 100,
      valorFinal: 130,
    });

    expect(prisma.equipment.update).not.toHaveBeenCalled();
  });

  describe('update', () => {
    beforeEach(() => {
      prisma.registroHorometro.update.mockImplementation(
        ({
          where,
          data,
        }: {
          where: { id: string };
          data: Record<string, unknown>;
        }) => ({
          id: where.id,
          equipoId: 'e1',
          ...data,
        }),
      );
    });

    it('con controlUnit HOURS escribe currentHourmeter del equipo', async () => {
      prisma.equipment.findUnique.mockResolvedValue({
        id: 'e1',
        controlUnit: 'HOURS',
      });

      await service.update('r1', { valorFinal: 150 });

      expect(prisma.registroHorometro.update).toHaveBeenCalledWith({
        where: { id: 'r1' },
        data: { valorFinal: 150 },
      });
      expect(prisma.equipment.update).toHaveBeenCalledWith({
        where: { id: 'e1' },
        data: { currentHourmeter: 150 },
      });
    });

    it('con controlUnit KM NO pisa currentHourmeter', async () => {
      prisma.equipment.findUnique.mockResolvedValue({
        id: 'e1',
        controlUnit: 'KM',
      });

      await service.update('r1', { valorFinal: 150 });

      expect(prisma.equipment.update).not.toHaveBeenCalled();
    });

    it('sin valorFinal no consulta ni actualiza el equipo', async () => {
      await service.update('r1', {});

      expect(prisma.equipment.findUnique).not.toHaveBeenCalled();
      expect(prisma.equipment.update).not.toHaveBeenCalled();
    });
  });
});
