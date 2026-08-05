import { Test } from '@nestjs/testing';
import { HorometroService } from './horometro.service';
import { PrismaService } from '../../common/prisma/prisma.service';

describe('HorometroService', () => {
  let service: HorometroService;
  const prisma = {
    equipo: { findUnique: jest.fn(), update: jest.fn() },
    registroHorometro: { create: jest.fn() },
  };

  beforeEach(async () => {
    const mod = await Test.createTestingModule({
      providers: [HorometroService, { provide: PrismaService, useValue: prisma }],
    }).compile();
    service = mod.get(HorometroService);
    jest.clearAllMocks();
    prisma.equipo.findUnique.mockResolvedValue({ id: 'e1', horometroActual: 100 });
    prisma.registroHorometro.create.mockImplementation(({ data }: any) => ({ id: 'r1', ...data }));
  });

  it('al cerrar turno actualiza horometroActual del equipo', async () => {
    await service.create({
      equipoId: 'e1', operador: 'Juan Rojas', turno: 'DIURNO', valorInicial: 100, valorFinal: 130, nivelCombustible: 75,
    } as any);
    expect(prisma.equipo.update).toHaveBeenCalledWith({ where: { id: 'e1' }, data: { horometroActual: 130 } });
  });

  it('sin valorFinal no toca el equipo', async () => {
    await service.create({
      equipoId: 'e1', operador: 'Juan Rojas', turno: 'NOCTURNO', valorInicial: 100,
    } as any);
    expect(prisma.equipo.update).not.toHaveBeenCalled();
  });
});
