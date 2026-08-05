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

  it('calcula totalHoras = horometroFinal - horometroInicial', async () => {
    const res = await service.create({
      equipoId: 'e1',
      operador: 'Juan Rojas',
      faena: 'Rajo Norte',
      turno: 'DIURNO',
      horometroInicial: 1200,
      horometroFinal: 1212,
      actividad: 'REGULACION_CARGA',
      descripcion: 'Carga de material',
    } as any);
    expect(res.totalHoras).toBe(12);
  });
});
