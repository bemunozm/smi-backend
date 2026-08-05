import { Test } from '@nestjs/testing';
import { HallazgosService } from './hallazgos.service';
import { PrismaService } from '../../../common/prisma/prisma.service';

describe('HallazgosService', () => {
  let service: HallazgosService;
  const prisma = {
    equipo: { findUnique: jest.fn() },
    hallazgo: { create: jest.fn() },
  };

  beforeEach(async () => {
    const mod = await Test.createTestingModule({
      providers: [HallazgosService, { provide: PrismaService, useValue: prisma }],
    }).compile();
    service = mod.get(HallazgosService);
    jest.clearAllMocks();
    prisma.equipo.findUnique.mockResolvedValue({ id: 'e1' });
    prisma.hallazgo.create.mockImplementation(({ data }: any) => data);
  });

  it('crea con estado ABIERTO y guarda la prioridad', async () => {
    const res = await service.create({ equipoId: 'e1', descripcion: 'Fuga', prioridad: 'ALTA' } as any);
    expect(res.estado).toBe('ABIERTO');
    expect(res.prioridad).toBe('ALTA');
  });
});
