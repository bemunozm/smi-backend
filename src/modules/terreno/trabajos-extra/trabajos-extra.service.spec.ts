import { Test } from '@nestjs/testing';
import { TrabajosExtraService } from './trabajos-extra.service';
import { PrismaService } from '../../../prisma/prisma.service';

describe('TrabajosExtraService', () => {
  let service: TrabajosExtraService;
  const prisma = {
    equipo: { findUnique: jest.fn() },
    trabajoExtraordinario: { create: jest.fn() },
  };

  beforeEach(async () => {
    const mod = await Test.createTestingModule({
      providers: [TrabajosExtraService, { provide: PrismaService, useValue: prisma }],
    }).compile();
    service = mod.get(TrabajosExtraService);
    jest.clearAllMocks();
    prisma.equipo.findUnique.mockResolvedValue({ id: 'e1' });
    prisma.trabajoExtraordinario.create.mockImplementation(({ data }: any) => data);
  });

  it('calcula monto = horasMaquina * tarifa', async () => {
    const res = await service.create({
      equipoId: 'e1', cliente: 'X', horasMaquina: 12, tarifa: 85000,
    } as any);
    expect(res.monto).toBe(1020000);
  });
});
