import { Test, TestingModule } from '@nestjs/testing';

import { PrismaService } from '../common/prisma/prisma.service';
import { UmbralesService } from './umbrales.service';

describe('UmbralesService', () => {
  let service: UmbralesService;
  const findMany = jest.fn();
  const create = jest.fn();

  beforeEach(async () => {
    findMany.mockReset();
    create.mockReset();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        UmbralesService,
        {
          provide: PrismaService,
          useValue: { umbralMantenimiento: { findMany, create } },
        },
      ],
    }).compile();

    service = module.get<UmbralesService>(UmbralesService);
  });

  it('findAll delega en Prisma con el select explícito', async () => {
    const umbral = {
      id: 'umbral_1',
      tipoEquipo: 'Excavadora',
      tipoMantencion: 'Mantención 250 h',
      umbralHoras: 250,
    };
    findMany.mockResolvedValue([umbral]);

    const result = await service.findAll();

    expect(result).toEqual([umbral]);
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        select: {
          id: true,
          tipoEquipo: true,
          tipoMantencion: true,
          umbralHoras: true,
        },
      }),
    );
  });

  it('create devuelve el umbral creado', async () => {
    const created = {
      id: 'umbral_2',
      tipoEquipo: 'Perforadora',
      tipoMantencion: 'Cambio de barra y filtros',
      umbralHoras: 200,
    };
    create.mockResolvedValue(created);

    const result = await service.create({
      tipoEquipo: 'Perforadora',
      tipoMantencion: 'Cambio de barra y filtros',
      umbralHoras: 200,
    });

    expect(result).toEqual(created);
  });
});
