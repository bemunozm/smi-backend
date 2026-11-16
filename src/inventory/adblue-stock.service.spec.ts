import { Test } from '@nestjs/testing';

import { AdBlueStockService } from './adblue-stock.service';
import { StockService } from './stock.service';

describe('AdBlueStockService', () => {
  let service: AdBlueStockService;
  const issue = jest.fn();
  const receive = jest.fn();
  const emitPending = jest.fn();

  /** El `tx` del dominio que registra la carga (cierre de tarjeta, panel). */
  const tx = { inventoryItem: { findFirst: jest.fn() } };
  const within = { tx: tx as never, events: [] };

  const bidones = {
    id: 'item_adblue',
    name: 'AdBlue bidón 10 L',
    unit: 'UNIT',
    contentPerUnit: 10,
    contentUnit: 'LITER',
    stocks: [{ branchId: 'b1', quantity: 100 }],
  };

  beforeEach(async () => {
    const mod = await Test.createTestingModule({
      providers: [
        AdBlueStockService,
        { provide: StockService, useValue: { issue, receive, emitPending } },
      ],
    }).compile();
    service = mod.get(AdBlueStockService);
    jest.clearAllMocks();
    tx.inventoryItem.findFirst.mockResolvedValue(bidones);
  });

  it('convierte litros a bidones y descuenta con ADBLUE_LOAD permitiendo saldo negativo', async () => {
    await service.discountLoad(within, {
      liters: 45,
      equipmentId: 'e1',
      performedById: 'sup_1',
      reference: 'card_1',
    });

    expect(issue).toHaveBeenCalledWith(
      expect.objectContaining({
        itemId: 'item_adblue',
        branchId: 'b1',
        quantity: 4.5,
        reason: 'ADBLUE_LOAD',
        equipmentId: 'e1',
        performedById: 'sup_1',
        reference: 'card_1',
        allowNegative: true,
      }),
      within,
    );
  });

  it('un ítem contado en litros descuenta 1:1', async () => {
    tx.inventoryItem.findFirst.mockResolvedValue({
      ...bidones,
      unit: 'LITER',
      contentPerUnit: null,
      contentUnit: null,
    });

    await service.discountLoad(within, { liters: 45, reference: 'card_1' });

    expect(issue).toHaveBeenCalledWith(
      expect.objectContaining({ quantity: 45 }),
      within,
    );
  });

  it('sin ítem AdBlue en el catálogo no descuenta nada (prueba «adblue» y «ad blue»)', async () => {
    tx.inventoryItem.findFirst.mockResolvedValue(null);

    await service.discountLoad(within, { liters: 10, reference: 'card_1' });

    expect(issue).not.toHaveBeenCalled();
    const agujas = tx.inventoryItem.findFirst.mock.calls.map(
      ([arg]: [{ where: { name: { contains: string } } }]) =>
        arg.where.name.contains,
    );
    expect(agujas).toEqual(['adblue', 'ad blue']);
  });

  it('sin fila de saldo en ninguna bodega no descuenta (no hay dónde imputar)', async () => {
    tx.inventoryItem.findFirst.mockResolvedValue({ ...bidones, stocks: [] });

    await service.discountLoad(within, { liters: 10, reference: 'card_1' });

    expect(issue).not.toHaveBeenCalled();
  });

  it('una unidad sin conversión posible (UNIT sin contenido) no descuenta', async () => {
    tx.inventoryItem.findFirst.mockResolvedValue({
      ...bidones,
      contentPerUnit: null,
      contentUnit: null,
    });

    await service.discountLoad(within, { liters: 10, reference: 'card_1' });

    expect(issue).not.toHaveBeenCalled();
  });

  it('con 0 litros no consulta ni descuenta', async () => {
    await service.discountLoad(within, { liters: 0, reference: 'card_1' });

    expect(tx.inventoryItem.findFirst).not.toHaveBeenCalled();
    expect(issue).not.toHaveBeenCalled();
  });

  it('restoreLoad devuelve la cantidad convertida como RETURN', async () => {
    await service.restoreLoad(within, {
      liters: 30,
      equipmentId: 'e1',
      performedById: 'adm_1',
      reference: 'card_1',
    });

    expect(receive).toHaveBeenCalledWith(
      expect.objectContaining({
        itemId: 'item_adblue',
        branchId: 'b1',
        quantity: 3,
        reason: 'RETURN',
        reference: 'card_1',
      }),
      within,
    );
    expect(issue).not.toHaveBeenCalled();
  });

  it('emitPending delega en StockService (los avisos salen tras confirmar la tx)', () => {
    const events = [{ itemId: 'i' }] as never;
    service.emitPending(events);

    expect(emitPending).toHaveBeenCalledWith(events);
  });
});
