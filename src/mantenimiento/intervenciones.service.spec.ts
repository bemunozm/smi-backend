import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';

import { PrismaService } from '../common/prisma/prisma.service';
import { StockService } from '../inventory/stock.service';
import { StorageService } from '../storage/storage.service';
import { IntervencionesService } from './intervenciones.service';

const MOCK_INTERVENCION = {
  id: 'intervencion_1',
  ordenId: 'orden_1',
  tipo: 'CORRECTIVA',
  detalle: 'Aislado el circuito',
  horasHombre: 1.5,
  horometro: null,
  fotoKey: null,
  soloLectura: false,
  fecha: new Date('2026-01-03T00:00:00.000Z'),
  insumos: [{ id: 'insumo_row_1', insumoId: 'item_1', cantidad: 2 }],
};

const MOCK_RESPONSE = {
  id: 'intervencion_1',
  ordenId: 'orden_1',
  tipo: 'CORRECTIVA',
  detalle: 'Aislado el circuito',
  horasHombre: 1.5,
  horometro: null,
  fotoUrl: null,
  soloLectura: false,
  insumos: [{ id: 'insumo_row_1', insumoId: 'item_1', cantidad: 2 }],
  fecha: '2026-01-03T00:00:00.000Z',
};

const DTO_CON_INSUMOS = {
  tipo: 'CORRECTIVA' as const,
  detalle: 'Aislado el circuito',
  horasHombre: 1.5,
  branchId: 'branch_1',
  insumos: [{ insumoId: 'item_1', cantidad: 2 }],
};

describe('IntervencionesService', () => {
  let service: IntervencionesService;
  const ordenTrabajoFindUnique = jest.fn();
  const intervencionFindMany = jest.fn();
  const intervencionFindUnique = jest.fn();
  const equipmentFindUnique = jest.fn();
  const transaction = jest.fn();
  const txIntervencionCreate = jest.fn();
  const stockIssue = jest.fn();
  const stockEmitPending = jest.fn();
  const storageClaimTmp = jest.fn();
  const storageSign = jest.fn();
  const storageDiscard = jest.fn();

  beforeEach(async () => {
    for (const mock of [
      ordenTrabajoFindUnique,
      intervencionFindMany,
      intervencionFindUnique,
      equipmentFindUnique,
      transaction,
      txIntervencionCreate,
      stockIssue,
      stockEmitPending,
      storageClaimTmp,
      storageSign,
      storageDiscard,
    ]) {
      mock.mockReset();
    }

    transaction.mockImplementation(
      async (callback: (tx: unknown) => Promise<unknown>) =>
        callback({ intervencion: { create: txIntervencionCreate } }),
    );
    intervencionFindUnique.mockResolvedValue(null);
    equipmentFindUnique.mockResolvedValue(null);
    stockIssue.mockResolvedValue({});

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        IntervencionesService,
        {
          provide: PrismaService,
          useValue: {
            ordenTrabajo: { findUnique: ordenTrabajoFindUnique },
            intervencion: {
              findMany: intervencionFindMany,
              findUnique: intervencionFindUnique,
            },
            equipment: { findUnique: equipmentFindUnique },
            $transaction: transaction,
          },
        },
        {
          provide: StockService,
          useValue: { issue: stockIssue, emitPending: stockEmitPending },
        },
        {
          provide: StorageService,
          useValue: {
            claimTmp: storageClaimTmp,
            sign: storageSign,
            discard: storageDiscard,
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

  it('findAllByOrden serializa `fecha` a ISO y expone fotoUrl (null sin foto)', async () => {
    ordenTrabajoFindUnique.mockResolvedValue({ id: 'orden_1', equipoId: 'EQ-1' });
    intervencionFindMany.mockResolvedValue([MOCK_INTERVENCION]);

    const result = await service.findAllByOrden('orden_1');

    expect(result).toEqual([MOCK_RESPONSE]);
  });

  it('create lanza NotFoundException si la orden no existe', async () => {
    ordenTrabajoFindUnique.mockResolvedValue(null);

    await expect(
      service.create('missing', { tipo: 'CORRECTIVA', detalle: 'x' }, 'user_1'),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(transaction).not.toHaveBeenCalled();
  });

  it('create con insumos descuenta stock EN LA MISMA transacción (reason INTERVENTION, reference = orden)', async () => {
    ordenTrabajoFindUnique.mockResolvedValue({ id: 'orden_1', equipoId: 'EQ-1' });
    // `EQ-1` no es un id de equipo pero sí un código interno.
    equipmentFindUnique.mockImplementation((args: { where: Record<string, string> }) =>
      Promise.resolve('internalCode' in args.where ? { id: 'equip_1' } : null),
    );
    txIntervencionCreate.mockResolvedValue(MOCK_INTERVENCION);

    const result = await service.create('orden_1', DTO_CON_INSUMOS, 'user_1');

    expect(transaction).toHaveBeenCalledTimes(1);
    expect(stockIssue).toHaveBeenCalledTimes(1);
    const [input, within] = stockIssue.mock.calls[0] as [
      Record<string, unknown>,
      { tx: unknown; events: unknown[] },
    ];
    expect(input).toEqual({
      itemId: 'item_1',
      branchId: 'branch_1',
      quantity: 2,
      reason: 'INTERVENTION',
      performedById: 'user_1',
      equipmentId: 'equip_1',
      reference: 'orden_1',
    });
    expect(within.tx).toBeDefined();
    expect(stockEmitPending).toHaveBeenCalledWith(within.events);
    expect(result.id).toBe('intervencion_1');
  });

  it('insumos sin bodega: 400 y no se crea ni descuenta nada', async () => {
    ordenTrabajoFindUnique.mockResolvedValue({ id: 'orden_1', equipoId: 'EQ-1' });

    await expect(
      service.create(
        'orden_1',
        { ...DTO_CON_INSUMOS, branchId: undefined },
        'user_1',
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(transaction).not.toHaveBeenCalled();
    expect(stockIssue).not.toHaveBeenCalled();
  });

  it('equipo del orden no resoluble: el descuento sale igual, con equipmentId null', async () => {
    ordenTrabajoFindUnique.mockResolvedValue({ id: 'orden_1', equipoId: 'ZZ-999' });
    txIntervencionCreate.mockResolvedValue(MOCK_INTERVENCION);

    await service.create('orden_1', DTO_CON_INSUMOS, 'user_1');

    const [input] = stockIssue.mock.calls[0] as [Record<string, unknown>];
    expect(input.equipmentId).toBeNull();
  });

  it('si el descuento falla (sin stock), no queda intervención y la foto reclamada se suelta', async () => {
    ordenTrabajoFindUnique.mockResolvedValue({ id: 'orden_1', equipoId: 'EQ-1' });
    storageClaimTmp.mockResolvedValue('intervencion-photos/final.jpg');
    txIntervencionCreate.mockResolvedValue(MOCK_INTERVENCION);
    stockIssue.mockRejectedValue(new ConflictException('Existencia insuficiente'));

    await expect(
      service.create(
        'orden_1',
        { ...DTO_CON_INSUMOS, fotoKey: 'tmp/user_1/foto.jpg' },
        'user_1',
      ),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(storageDiscard).toHaveBeenCalledWith('intervencion-photos/final.jpg');
    expect(stockEmitPending).not.toHaveBeenCalled();
  });

  it('la foto se reclama y la respuesta expone fotoUrl firmada, nunca la key', async () => {
    ordenTrabajoFindUnique.mockResolvedValue({ id: 'orden_1', equipoId: 'EQ-1' });
    storageClaimTmp.mockResolvedValue('intervencion-photos/final.jpg');
    storageSign.mockResolvedValue('https://signed.example/foto.jpg');
    txIntervencionCreate.mockResolvedValue({
      ...MOCK_INTERVENCION,
      fotoKey: 'intervencion-photos/final.jpg',
      insumos: [],
    });

    const result = await service.create(
      'orden_1',
      { tipo: 'CORRECTIVA', detalle: 'x', fotoKey: 'tmp/user_1/foto.jpg' },
      'user_1',
    );

    expect(storageClaimTmp).toHaveBeenCalledWith(
      'tmp/user_1/foto.jpg',
      'user_1',
      'intervencion-photo',
    );
    expect(result.fotoUrl).toBe('https://signed.example/foto.jpg');
    expect(result).not.toHaveProperty('fotoKey');
  });

  it('reintento con el mismo id del mismo usuario: devuelve la fila y NO vuelve a descontar', async () => {
    ordenTrabajoFindUnique.mockResolvedValue({ id: 'orden_1', equipoId: 'EQ-1' });
    intervencionFindUnique.mockResolvedValue({
      ...MOCK_INTERVENCION,
      createdById: 'user_1',
    });

    const result = await service.create(
      'orden_1',
      { ...DTO_CON_INSUMOS, id: 'intervencion_1' },
      'user_1',
    );

    expect(result).toEqual(MOCK_RESPONSE);
    expect(transaction).not.toHaveBeenCalled();
    expect(stockIssue).not.toHaveBeenCalled();
  });
});
