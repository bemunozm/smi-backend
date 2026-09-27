import { Test } from '@nestjs/testing';
import { TrabajosExtraService } from './trabajos-extra.service';
import { PrismaService } from '../../common/prisma/prisma.service';

describe('TrabajosExtraService', () => {
  let service: TrabajosExtraService;
  const prisma = {
    equipment: { findUnique: jest.fn() },
    trabajoExtraordinario: { create: jest.fn() },
  };

  beforeEach(async () => {
    const mod = await Test.createTestingModule({
      providers: [
        TrabajosExtraService,
        { provide: PrismaService, useValue: prisma },
      ],
    }).compile();
    service = mod.get(TrabajosExtraService);
    jest.clearAllMocks();
    prisma.equipment.findUnique.mockResolvedValue({ id: 'e1' });
    prisma.trabajoExtraordinario.create.mockImplementation(
      ({ data }: { data: Record<string, unknown> }) => data,
    );
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
    });
    expect(res.totalHoras).toBe(12);
  });

  /**
   * El caso que antes pasaba en silencio: guardaba `totalHoras: 0` y devolvía
   * 201, dejando en la base un trabajo de cero horas indistinguible de uno
   * legítimo. Estas horas respaldan un cobro, así que el registro tiene que
   * fallar, no inventar un cero.
   */
  it('rechaza el horómetro final menor que el inicial en vez de guardar cero', async () => {
    const invertido = {
      equipoId: 'e1',
      operador: 'Juan Rojas',
      faena: 'Patillo',
      turno: 'NOCTURNO',
      horometroInicial: 5400,
      horometroFinal: 5388,
      actividad: 'HACER_PETRIL',
      descripcion: 'Horómetro tipeado al revés',
    };

    await expect(service.create(invertido)).rejects.toThrow(/no puede ser menor/);
    expect(prisma.trabajoExtraordinario.create).not.toHaveBeenCalled();
  });

  /** Un trabajo que de verdad duró cero sí se guarda: el rechazo es por menor, no por igual. */
  it('acepta inicial y final iguales', async () => {
    const res = await service.create({
      equipoId: 'e1',
      operador: 'Juan Rojas',
      faena: 'Kainita',
      turno: 'DIURNO',
      horometroInicial: 900,
      horometroFinal: 900,
      actividad: 'LIMPIEZA_CANCHA',
      descripcion: 'Se canceló antes de empezar',
    });
    expect(res.totalHoras).toBe(0);
  });
});
