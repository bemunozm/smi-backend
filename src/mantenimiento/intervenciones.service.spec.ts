import { NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';

import { PrismaService } from '../common/prisma/prisma.service';
import { IntervencionesService } from './intervenciones.service';

const MOCK_INTERVENCION = {
  id: 'intervencion_1',
  ordenId: 'orden_1',
  tipo: 'CORRECTIVA',
  detalle: 'Aislado el circuito',
  horasHombre: 1.5,
  horometro: null,
  soloLectura: false,
  fecha: new Date('2026-01-03T00:00:00.000Z'),
  insumos: [{ id: 'insumo_row_1', insumoId: 'ORG-008', cantidad: 2 }],
};

describe('IntervencionesService', () => {
  let service: IntervencionesService;
  const ordenTrabajoFindUnique = jest.fn();
  const intervencionFindMany = jest.fn();
  const transaction = jest.fn();
  const txIntervencionCreate = jest.fn();

  beforeEach(async () => {
    ordenTrabajoFindUnique.mockReset();
    intervencionFindMany.mockReset();
    transaction.mockReset();
    txIntervencionCreate.mockReset();

    transaction.mockImplementation(
      async (callback: (tx: unknown) => Promise<unknown>) =>
        callback({ intervencion: { create: txIntervencionCreate } }),
    );

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        IntervencionesService,
        {
          provide: PrismaService,
          useValue: {
            ordenTrabajo: { findUnique: ordenTrabajoFindUnique },
            intervencion: { findMany: intervencionFindMany },
            $transaction: transaction,
          },
        },
      ],
    }).compile();

    service = module.get<IntervencionesService>(IntervencionesService);
  });

  it('findAllByOrden lanza NotFoundException si la orden no existe', async () => {
    ordenTrabajoFindUnique.mockResolvedValue(null);

    await expect(service.findAllByOrden('missing')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('findAllByOrden serializa `fecha` a ISO', async () => {
    ordenTrabajoFindUnique.mockResolvedValue({ id: 'orden_1' });
    intervencionFindMany.mockResolvedValue([MOCK_INTERVENCION]);

    const result = await service.findAllByOrden('orden_1');

    expect(result).toEqual([
      {
        id: 'intervencion_1',
        ordenId: 'orden_1',
        tipo: 'CORRECTIVA',
        detalle: 'Aislado el circuito',
        horasHombre: 1.5,
        horometro: null,
        soloLectura: false,
        insumos: [{ id: 'insumo_row_1', insumoId: 'ORG-008', cantidad: 2 }],
        fecha: '2026-01-03T00:00:00.000Z',
      },
    ]);
  });

  it('create lanza NotFoundException si la orden no existe', async () => {
    ordenTrabajoFindUnique.mockResolvedValue(null);

    await expect(
      service.create('missing', { tipo: 'CORRECTIVA', detalle: 'x' }),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(transaction).not.toHaveBeenCalled();
  });

  it('create arma la Intervencion + IntervencionInsumo en una sola transacción', async () => {
    ordenTrabajoFindUnique.mockResolvedValue({ id: 'orden_1' });
    txIntervencionCreate.mockResolvedValue(MOCK_INTERVENCION);

    const result = await service.create('orden_1', {
      tipo: 'CORRECTIVA',
      detalle: 'Aislado el circuito',
      horasHombre: 1.5,
      insumos: [{ insumoId: 'ORG-008', cantidad: 2 }],
    });

    expect(transaction).toHaveBeenCalledTimes(1);

    interface CapturedCreateArgs {
      data: {
        ordenId: string;
        insumos?: { create: { insumoId: string; cantidad: number }[] };
      };
    }
    const [args] = txIntervencionCreate.mock.calls[0] as unknown as [
      CapturedCreateArgs,
    ];
    expect(args.data.ordenId).toBe('orden_1');
    expect(args.data.insumos).toEqual({
      create: [{ insumoId: 'ORG-008', cantidad: 2 }],
    });

    expect(result.id).toBe('intervencion_1');
  });
});
