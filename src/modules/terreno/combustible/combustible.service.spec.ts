import { Test } from '@nestjs/testing';
import { CombustibleService } from './combustible.service';
import { PrismaService } from '../../../prisma/prisma.service';

describe('CombustibleService', () => {
  let service: CombustibleService;
  const prisma = {
    equipo: { findUnique: jest.fn() },
    registroCombustible: { create: jest.fn() },
  };

  beforeEach(async () => {
    const mod = await Test.createTestingModule({
      providers: [CombustibleService, { provide: PrismaService, useValue: prisma }],
    }).compile();
    service = mod.get(CombustibleService);
    jest.clearAllMocks();
    prisma.registroCombustible.create.mockImplementation(({ data }: any) => data);
  });

  it('calcula rendimiento = delta / litros', async () => {
    prisma.equipo.findUnique.mockResolvedValue({ id: 'e1', horometroActual: 100 });
    const res = await service.create({ equipoId: 'e1', litros: 10, lecturaActual: 150 } as any);
    expect(res.rendimiento).toBe(5);
  });

  it('deja rendimiento null si no hay lecturaActual', async () => {
    prisma.equipo.findUnique.mockResolvedValue({ id: 'e1', horometroActual: 100 });
    const res = await service.create({ equipoId: 'e1', litros: 10 } as any);
    expect(res.rendimiento).toBeNull();
  });
});
