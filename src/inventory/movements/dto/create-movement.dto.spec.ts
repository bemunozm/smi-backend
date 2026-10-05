import 'reflect-metadata';
import { MovementDirection, MovementReason } from '@prisma/client';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';

import { CreateMovementDto } from './create-movement.dto';

const base = {
  itemId: 'item_1',
  branchId: 'branch_1',
  direction: MovementDirection.OUT,
  reason: MovementReason.INTERVENTION,
  quantity: 5,
};

async function errorsOf(overrides: Record<string, unknown>) {
  return validate(
    plainToInstance(CreateMovementDto, { ...base, ...overrides }),
    {
      whitelist: true,
      forbidNonWhitelisted: true,
    },
  );
}

describe('CreateMovementDto', () => {
  it.each([
    MovementReason.PURCHASE,
    MovementReason.RETURN,
    MovementReason.INTERVENTION,
    MovementReason.ACTIVITY,
    MovementReason.EXTRAORDINARY_WORK,
  ])('acepta el motivo manual %s', async (reason) => {
    expect(await errorsOf({ reason })).toHaveLength(0);
  });

  it.each([MovementReason.TRANSFER, MovementReason.PHYSICAL_ADJUSTMENT])(
    'rechaza el motivo reservado %s: nace de su propio endpoint',
    async (reason) => {
      const errors = await errorsOf({ reason });

      expect(errors).toHaveLength(1);
      expect(errors[0].property).toBe('reason');
    },
  );

  it('rechaza un motivo que no existe', async () => {
    expect(await errorsOf({ reason: 'OTRO' })).not.toHaveLength(0);
  });

  it('acota la referencia libre', async () => {
    expect(await errorsOf({ reference: 'x'.repeat(121) })).not.toHaveLength(0);
    expect(await errorsOf({ reference: 'x'.repeat(120) })).toHaveLength(0);
  });
});
