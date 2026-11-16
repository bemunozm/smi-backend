import type { EventEmitter2 } from '@nestjs/event-emitter';
import { Prisma } from '@prisma/client';

import { DOMAIN_EVENTS } from '../../common/events/domain-events';
import type { PrismaService } from '../../common/prisma/prisma.service';
import type { MaintenancePlansService } from '../maintenance-plans/maintenance-plans.service';
import { VencimientosService } from './vencimientos.service';

const HOY = new Date('2026-10-19T15:00:00.000Z');
const dia = (y: number, m: number, d: number) =>
  new Date(Date.UTC(y, m - 1, d));
const EQUIPO = { id: 'eq_1', internalCode: 'CL-001', licensePlate: 'ABCD-12' };

function p2002() {
  return new Prisma.PrismaClientKnownRequestError('dup', {
    code: 'P2002',
    clientVersion: 'x',
  });
}

describe('VencimientosService (Módulo 4)', () => {
  const tx = {
    $executeRaw: jest.fn(),
    ordenTrabajo: { findFirst: jest.fn(), create: jest.fn() },
  };
  const prisma = {
    equipmentDocument: { findMany: jest.fn() },
    documentExpiryAlert: { create: jest.fn() },
    equipment: { findMany: jest.fn(), findUnique: jest.fn() },
    maintenancePlan: { findMany: jest.fn() },
    maintenanceRecord: { findMany: jest.fn() },
    lightVehicleConfig: {
      findMany: jest.fn(),
      findUnique: jest.fn(),
      upsert: jest.fn(),
    },
    $transaction: jest.fn(),
  };
  const events = { emit: jest.fn() };
  const plans = { statusForAll: jest.fn() };
  let service: VencimientosService;

  beforeEach(() => {
    jest.resetAllMocks();
    service = new VencimientosService(
      prisma as unknown as PrismaService,
      events as unknown as EventEmitter2,
      plans as unknown as MaintenancePlansService,
    );
    prisma.$transaction.mockImplementation(
      (cb: (t: typeof tx) => Promise<unknown>) => cb(tx),
    );
    plans.statusForAll.mockResolvedValue([]);
    // Sin configuración guardada: valen los valores por defecto.
    prisma.lightVehicleConfig.findMany.mockResolvedValue([]);
    prisma.lightVehicleConfig.findUnique.mockResolvedValue(null);
    // Sin servicios registrados: vale el múltiplo de 10.000 km.
    prisma.maintenanceRecord.findMany.mockResolvedValue([]);
  });

  /** El último servicio registrado de un liviano (su ancla). */
  const servicio = (equipmentId: string, counterAt: number) => ({
    equipmentId,
    milestone: 10_000,
    cycle: 1,
    counterAt,
    doneAt: dia(2026, 9, 1),
  });

  describe('checkDocuments', () => {
    const doc = (over: Record<string, unknown>) => ({
      id: 'doc_1',
      type: 'TECHNICAL_INSPECTION',
      title: null,
      alertDaysBefore: 30,
      equipment: EQUIPO,
      ...over,
    });

    it('avisa al entrar en el plazo del documento, con su anticipación', async () => {
      prisma.equipmentDocument.findMany.mockResolvedValue([
        doc({ expiryDate: dia(2026, 11, 28), alertDaysBefore: 45 }),
        doc({
          id: 'doc_2',
          expiryDate: dia(2026, 11, 28),
          alertDaysBefore: 30,
        }),
      ]);

      expect(await service.checkDocuments(HOY)).toBe(1);
      expect(events.emit).toHaveBeenCalledWith(
        DOMAIN_EVENTS.DOCUMENT_EXPIRING,
        expect.objectContaining({
          documentId: 'doc_1',
          kind: 'POR_VENCER',
          documentLabel: 'Revisión técnica',
          licensePlate: 'ABCD-12',
          expiryDate: '2026-11-28',
          daysToExpiry: 40,
        }),
      );
    });

    it('no repite un aviso que ya salió', async () => {
      prisma.equipmentDocument.findMany.mockResolvedValue([
        doc({ expiryDate: dia(2026, 10, 1) }),
      ]);
      prisma.documentExpiryAlert.create.mockRejectedValue(p2002());

      expect(await service.checkDocuments(HOY)).toBe(0);
      expect(events.emit).not.toHaveBeenCalled();
    });

    it('un documento vencido avisa VENCIDO', async () => {
      prisma.equipmentDocument.findMany.mockResolvedValue([
        doc({ expiryDate: dia(2026, 10, 1), type: 'INSURANCE' }),
      ]);
      await service.checkDocuments(HOY);
      expect(prisma.documentExpiryAlert.create).toHaveBeenCalledWith({
        data: {
          documentId: 'doc_1',
          kind: 'VENCIDO',
          expiryDate: dia(2026, 10, 1),
        },
      });
      expect(events.emit).toHaveBeenCalledWith(
        DOMAIN_EVENTS.DOCUMENT_EXPIRING,
        expect.objectContaining({ kind: 'VENCIDO', documentLabel: 'Seguro' }),
      );
    });
  });

  describe('checkLightServices', () => {
    it('crea la orden de los 30.000 km a 1.000 km o menos, y avisa', async () => {
      prisma.equipment.findMany.mockResolvedValue([
        { ...EQUIPO, currentMileage: 29_400 },
        {
          id: 'eq_2',
          internalCode: 'CL-002',
          licensePlate: null,
          currentMileage: 25_000,
        },
      ]);
      prisma.maintenancePlan.findMany.mockResolvedValue([]);
      tx.ordenTrabajo.findFirst.mockResolvedValue(null);
      tx.ordenTrabajo.create.mockResolvedValue({ id: 'ot_1' });

      expect(await service.checkLightServices()).toBe(1);
      expect(tx.ordenTrabajo.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          equipoId: 'eq_1',
          tipo: 'PREVENTIVA',
          origen: 'PREVENTIVO',
          origenDetalle: 'Livianos: mantención de 30.000 km',
          prioridad: 'MEDIA',
        }) as unknown,
        select: { id: true },
      });
      expect(events.emit).toHaveBeenCalledWith(
        DOMAIN_EVENTS.LIGHT_SERVICE_DUE,
        expect.objectContaining({
          ordenId: 'ot_1',
          nextKm: 30_000,
          remainingKm: 600,
        }),
      );
    });

    it('no la repite y respeta la pauta propia del equipo', async () => {
      prisma.equipment.findMany.mockResolvedValue([
        { ...EQUIPO, currentMileage: 29_400 },
        {
          id: 'eq_2',
          internalCode: 'CL-002',
          licensePlate: null,
          currentMileage: 39_900,
        },
      ]);
      prisma.maintenancePlan.findMany.mockResolvedValue([
        { equipmentId: 'eq_2' },
      ]);
      tx.ordenTrabajo.findFirst.mockResolvedValue({ id: 'ya_existe' });

      expect(await service.checkLightServices()).toBe(0);
      expect(tx.ordenTrabajo.create).not.toHaveBeenCalled();
      // eq_2 tiene pauta: ni siquiera se busca su orden.
      expect(tx.ordenTrabajo.findFirst).toHaveBeenCalledTimes(1);
    });

    it('cuenta desde el último servicio registrado', async () => {
      prisma.equipment.findMany.mockResolvedValue([
        { ...EQUIPO, currentMileage: 42_700 },
      ]);
      prisma.maintenancePlan.findMany.mockResolvedValue([]);
      prisma.maintenanceRecord.findMany.mockResolvedValue([
        servicio('eq_1', 33_500),
      ]);
      tx.ordenTrabajo.findFirst.mockResolvedValue(null);
      tx.ordenTrabajo.create.mockResolvedValue({ id: 'ot_1' });

      // Sin ancla tocaría a los 50.000 (faltan 7.300); con el servicio de los
      // 33.500, a los 43.500: faltan 800 y ya avisa.
      expect(await service.checkLightServices()).toBe(1);
      expect(prisma.maintenanceRecord.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            equipmentId: { in: ['eq_1'] },
            planItemId: null,
            kind: 'SERVICIO',
            counterAt: { not: null },
          },
        }),
      );
      expect(tx.ordenTrabajo.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          titulo: 'Mantención 43.500 km · CL-001',
          origenDetalle: 'Livianos: mantención de 43.500 km',
          prioridad: 'MEDIA',
        }) as unknown,
        select: { id: true },
      });
    });

    it('no crea otra orden si el equipo ya tiene una preventiva abierta', async () => {
      prisma.equipment.findMany.mockResolvedValue([
        { ...EQUIPO, currentMileage: 29_400 },
      ]);
      prisma.maintenancePlan.findMany.mockResolvedValue([]);
      // Nada con este `origenDetalle`, pero sí una preventiva sin cerrar.
      tx.ordenTrabajo.findFirst.mockImplementation(
        ({ where }: { where: { estado?: unknown } }) =>
          Promise.resolve(where.estado ? { id: 'ot_abierta' } : null),
      );

      expect(await service.checkLightServices()).toBe(0);
      expect(tx.ordenTrabajo.create).not.toHaveBeenCalled();
      expect(events.emit).not.toHaveBeenCalled();
      expect(tx.ordenTrabajo.findFirst).toHaveBeenCalledWith({
        where: {
          equipoId: { in: ['eq_1', 'CL-001'] },
          origen: 'PREVENTIVO',
          estado: { in: ['PENDIENTE', 'ASIGNADA', 'EN_PROCESO'] },
        },
        select: { id: true },
      });
    });
  });

  describe('configuración del liviano («Asignar mantenciones»)', () => {
    it('el aviso en km configurado manda sobre los 1.000 de defecto', async () => {
      prisma.equipment.findMany.mockResolvedValue([
        { ...EQUIPO, currentMileage: 27_500 },
      ]);
      prisma.maintenancePlan.findMany.mockResolvedValue([]);
      prisma.lightVehicleConfig.findMany.mockResolvedValue([
        { equipmentId: 'eq_1', serviceAlertKm: 3_000 },
      ]);
      tx.ordenTrabajo.findFirst.mockResolvedValue(null);
      tx.ordenTrabajo.create.mockResolvedValue({ id: 'ot_1' });

      // A 2.500 km de los 30.000: con 1.000 no avisaría; con 3.000, sí.
      expect(await service.checkLightServices()).toBe(1);
    });

    it('un equipo pesado no tiene configuración de liviano', async () => {
      prisma.equipment.findUnique.mockResolvedValue({
        ...EQUIPO,
        brand: 'CAT',
        model: '336',
        equipmentClass: 'HEAVY',
        currentMileage: null,
      });
      await expect(service.lightConfig('eq_1', HOY)).rejects.toThrow(
        'no es liviano',
      );
    });
  });

  describe('calendar', () => {
    it('arma 12 meses por patente con documentos y la próxima mantención', async () => {
      prisma.equipment.findMany.mockResolvedValue([
        {
          ...EQUIPO,
          type: 'Camioneta',
          brand: 'Toyota',
          model: 'Hilux',
          controlUnit: 'KM',
          currentMileage: 23_500,
          currentHourmeter: null,
          documents: [
            {
              id: 'd1',
              type: 'CIRCULATION_PERMIT',
              title: null,
              expiryDate: dia(2027, 3, 31),
              alertDaysBefore: 30,
            },
          ],
        },
      ]);

      const cal = await service.calendar('2026-10', HOY);

      expect(cal.months).toHaveLength(12);
      expect(cal.months[0]).toBe('2026-10');
      expect(cal.months[11]).toBe('2027-09');
      const [eq] = cal.equipment;
      expect(eq.documents[0]).toMatchObject({
        label: 'Permiso de circulación',
        month: '2027-03',
        status: 'VIGENTE',
      });
      expect(eq.service).toEqual({
        source: 'LIVIANO',
        unit: 'km',
        nextAt: 30_000,
        remaining: 6_500,
        due: false,
      });
    });

    it('la próxima mantención del liviano cuenta desde su último servicio', async () => {
      prisma.equipment.findMany.mockResolvedValue([
        {
          ...EQUIPO,
          type: 'Camioneta',
          brand: 'Toyota',
          model: 'Hilux',
          controlUnit: 'KM',
          currentMileage: 23_500,
          currentHourmeter: null,
          documents: [],
        },
      ]);
      prisma.maintenanceRecord.findMany.mockResolvedValue([
        servicio('eq_1', 14_800),
      ]);

      const cal = await service.calendar('2026-10', HOY);

      expect(cal.equipment[0].service).toEqual({
        source: 'LIVIANO',
        unit: 'km',
        nextAt: 24_800,
        remaining: 1_300,
        due: false,
      });
    });

    it('con un equipo, trae solo ese liviano (la tarjeta de su ficha)', async () => {
      prisma.equipment.findMany.mockResolvedValue([]);
      await service.calendar(undefined, HOY, 'eq_1');
      const [{ where }] = prisma.equipment.findMany.mock.calls[0] as [
        { where: Record<string, unknown> },
      ];
      expect(where).toEqual({ equipmentClass: 'LIGHT', id: 'eq_1' });
    });

    it('rechaza un mes mal escrito', async () => {
      await expect(service.calendar('2026-13', HOY)).rejects.toThrow('YYYY-MM');
    });
  });
});
