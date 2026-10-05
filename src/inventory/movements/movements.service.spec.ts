import { Test, TestingModule } from '@nestjs/testing';
import { MovementDirection, MovementReason } from '@prisma/client';

import { ERROR_CODES } from '../../common/errors/error-codes';
import { PrismaService } from '../../common/prisma/prisma.service';
import { prismaError } from '../../common/testing/fixtures';
import { StockService } from '../stock.service';
import { MovementsService } from './movements.service';

const ID = '11111111-1111-4111-8111-111111111111';
const USER = 'user_1';

describe('MovementsService.create', () => {
  let service: MovementsService;
  const findUnique = jest.fn();
  const issue = jest.fn();
  const receive = jest.fn();

  const dto = {
    id: ID,
    itemId: 'item_1',
    branchId: 'branch_1',
    direction: MovementDirection.OUT,
    reason: MovementReason.INTERVENTION,
    quantity: 5,
  };
  const stored = {
    id: ID,
    itemId: 'item_1',
    branchId: 'branch_1',
    direction: MovementDirection.OUT,
    reason: MovementReason.INTERVENTION,
    quantity: 5,
    resultingBalance: 45,
    performedById: USER,
  };

  beforeEach(async () => {
    [findUnique, issue, receive].forEach((m) => m.mockReset());

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        MovementsService,
        {
          provide: PrismaService,
          useValue: { stockMovement: { findUnique } },
        },
        { provide: StockService, useValue: { issue, receive } },
      ],
    }).compile();
    service = module.get(MovementsService);
  });

  it('con id nuevo crea el asiento con ese id y lo imputa a quien lo registra', async () => {
    findUnique.mockResolvedValue(null);
    issue.mockResolvedValue(stored);

    await expect(service.create(dto, USER)).resolves.toBe(stored);

    expect(issue).toHaveBeenCalledWith(
      expect.objectContaining({ id: ID, performedById: USER }),
    );
  });

  it('replay del mismo usuario: devuelve el asiento original (con su saldo resultante) sin mover stock', async () => {
    findUnique.mockResolvedValue(stored);

    const result = await service.create(dto, USER);

    expect(result).toBe(stored);
    expect(result.resultingBalance).toBe(45);
    expect(issue).not.toHaveBeenCalled();
    expect(receive).not.toHaveBeenCalled();
  });

  it('id ocupado por otro usuario: 409 ID_CONFLICT sin mover stock', async () => {
    findUnique.mockResolvedValue({ ...stored, performedById: 'otro' });

    await expect(service.create(dto, USER)).rejects.toMatchObject({
      response: { code: ERROR_CODES.ID_CONFLICT },
    });
    expect(issue).not.toHaveBeenCalled();
  });

  describe('el replay solo acepta un movimiento manual del mismo tipo', () => {
    it.each([
      ['un traspaso', MovementReason.TRANSFER],
      ['un ajuste por conteo', MovementReason.PHYSICAL_ADJUSTMENT],
    ])(
      'un id que es %s es 409 ID_CONFLICT, aunque sea del mismo usuario',
      async (_label, reason) => {
        findUnique.mockResolvedValue({ ...stored, reason });

        await expect(service.create(dto, USER)).rejects.toMatchObject({
          response: { code: ERROR_CODES.ID_CONFLICT },
        });
        expect(issue).not.toHaveBeenCalled();
        expect(receive).not.toHaveBeenCalled();
      },
    );

    it('un id de una entrada reutilizado en una salida es 409 ID_CONFLICT', async () => {
      findUnique.mockResolvedValue({
        ...stored,
        direction: MovementDirection.IN,
      });

      await expect(service.create(dto, USER)).rejects.toMatchObject({
        response: { code: ERROR_CODES.ID_CONFLICT },
      });
    });

    it('un id de otro ítem es 409 ID_CONFLICT', async () => {
      findUnique.mockResolvedValue({ ...stored, itemId: 'item_2' });

      await expect(service.create(dto, USER)).rejects.toMatchObject({
        response: { code: ERROR_CODES.ID_CONFLICT },
      });
    });
  });

  it('reintento concurrente de una salida ya aplicada: devuelve el asiento ganador, no INSUFFICIENT_STOCK', async () => {
    findUnique.mockResolvedValueOnce(null).mockResolvedValueOnce(stored);
    issue.mockRejectedValue(
      Object.assign(new Error('Existencia insuficiente'), {
        response: { code: ERROR_CODES.INSUFFICIENT_STOCK },
      }),
    );

    await expect(service.create(dto, USER)).resolves.toBe(stored);
  });

  it('carrera sobre la PK: el perdedor devuelve el asiento ganador', async () => {
    findUnique.mockResolvedValueOnce(null).mockResolvedValueOnce(stored);
    issue.mockRejectedValue(prismaError('P2002', { target: ['id'] }));

    await expect(service.create(dto, USER)).resolves.toBe(stored);
  });

  it('una salida sin existencia suficiente propaga el 409 INSUFFICIENT_STOCK del servicio de saldos', async () => {
    findUnique.mockResolvedValue(null);
    const insufficient = Object.assign(new Error('Existencia insuficiente'), {
      response: { code: ERROR_CODES.INSUFFICIENT_STOCK },
    });
    issue.mockRejectedValue(insufficient);

    await expect(service.create(dto, USER)).rejects.toBe(insufficient);
  });

  it('una entrada va por receive', async () => {
    findUnique.mockResolvedValue(null);
    receive.mockResolvedValue({ ...stored, direction: MovementDirection.IN });

    await service.create({ ...dto, direction: MovementDirection.IN }, USER);

    expect(receive).toHaveBeenCalledTimes(1);
    expect(issue).not.toHaveBeenCalled();
  });
});
