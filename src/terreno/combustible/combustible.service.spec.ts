import { Test } from '@nestjs/testing';
import { CombustibleService } from './combustible.service';
import { PrismaService } from '../../common/prisma/prisma.service';

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

  it('guarda litros y tipo de combustible', async () => {
    prisma.equipo.findUnique.mockResolvedValue({ id: 'e1' });
    const res = await service.create({ equipoId: 'e1', litros: 120, tipo: 'PETROLEO' } as any);
    expect(res.litros).toBe(120);
    expect(res.tipo).toBe('PETROLEO');
  });

  it('rechaza si el equipo no existe', async () => {
    prisma.equipo.findUnique.mockResolvedValue(null);
    await expect(service.create({ equipoId: 'x', litros: 10, tipo: 'BENCINA' } as any)).rejects.toThrow();
  });
});
