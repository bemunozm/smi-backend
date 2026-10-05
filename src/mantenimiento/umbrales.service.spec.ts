import { Test, TestingModule } from '@nestjs/testing';

import { ERROR_CODES } from '../common/errors/error-codes';
import { PrismaService } from '../common/prisma/prisma.service';
import { UmbralesService } from './umbrales.service';

describe('UmbralesService', () => {
  let service: UmbralesService;
  const findMany = jest.fn();
  const create = jest.fn();
  const findUnique = jest.fn();

  beforeEach(async () => {
    findMany.mockReset();
    create.mockReset();
    findUnique.mockReset();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        UmbralesService,
        {
          provide: PrismaService,
          useValue: { umbralMantenimiento: { findMany, create, findUnique } },
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

    const result = await service.create(
      {
        tipoEquipo: 'Perforadora',
        tipoMantencion: 'Cambio de barra y filtros',
        umbralHoras: 200,
      },
      'user_1',
    );

    expect(result).toEqual(created);
    const [{ data }] = create.mock.calls[0] as [
      { data: Record<string, unknown> },
    ];
    expect(data).toMatchObject({ createdById: 'user_1' });
  });

  describe('id del cliente (reintento offline)', () => {
    const ID = '11111111-1111-4111-8111-111111111111';
    const dto = {
      id: ID,
      tipoEquipo: 'Perforadora',
      tipoMantencion: 'Cambio de barra',
      umbralHoras: 200,
    };

    it('replay del mismo usuario: devuelve la fila sin createdById y sin crear', async () => {
      findUnique.mockResolvedValue({
        id: ID,
        tipoEquipo: 'Perforadora',
        tipoMantencion: 'Cambio de barra',
        umbralHoras: 200,
        createdById: 'user_1',
      });

      const result = await service.create(dto, 'user_1');

      expect(result).toEqual({
        id: ID,
        tipoEquipo: 'Perforadora',
        tipoMantencion: 'Cambio de barra',
        umbralHoras: 200,
      });
      expect(create).not.toHaveBeenCalled();
    });

    it('id ocupado por otro usuario: 409 ID_CONFLICT', async () => {
      findUnique.mockResolvedValue({ id: ID, createdById: 'otro' });

      await expect(service.create(dto, 'user_1')).rejects.toMatchObject({
        response: { code: ERROR_CODES.ID_CONFLICT },
      });
    });
  });
});
