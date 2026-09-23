import { NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { EquipmentDocumentType } from '@prisma/client';

import { PrismaService } from '../../common/prisma/prisma.service';
import { EquipmentDocumentService } from './equipment-document.service';

const RAW_DOCUMENT = {
  id: 'doc_1',
  equipmentId: 'eq_1',
  type: EquipmentDocumentType.TECHNICAL_INSPECTION,
  title: 'Revisión técnica 2026',
  expiryDate: null as Date | null,
  fileUrl: '/uploads/rt.pdf',
  notes: null as string | null,
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
  updatedAt: new Date('2026-01-01T00:00:00.000Z'),
};

describe('EquipmentDocumentService', () => {
  let service: EquipmentDocumentService;

  const equipmentFindUnique = jest.fn();
  const documentCreate = jest.fn();
  const documentFindMany = jest.fn();
  const documentFindUnique = jest.fn();
  const documentUpdate = jest.fn();
  const documentDelete = jest.fn();

  beforeEach(async () => {
    [
      equipmentFindUnique,
      documentCreate,
      documentFindMany,
      documentFindUnique,
      documentUpdate,
      documentDelete,
    ].forEach((m) => m.mockReset());

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        EquipmentDocumentService,
        {
          provide: PrismaService,
          useValue: {
            equipment: { findUnique: equipmentFindUnique },
            equipmentDocument: {
              create: documentCreate,
              findMany: documentFindMany,
              findUnique: documentFindUnique,
              update: documentUpdate,
              delete: documentDelete,
            },
          },
        },
      ],
    }).compile();

    service = module.get<EquipmentDocumentService>(EquipmentDocumentService);
  });

  describe('create', () => {
    it('crea el documento cuando el equipo existe', async () => {
      equipmentFindUnique.mockResolvedValue({ id: 'eq_1' });
      documentCreate.mockResolvedValue(RAW_DOCUMENT);

      const dto = {
        type: EquipmentDocumentType.TECHNICAL_INSPECTION,
        title: 'Revisión técnica 2026',
        fileUrl: '/uploads/rt.pdf',
      };
      const result = await service.create('eq_1', dto);

      expect(equipmentFindUnique).toHaveBeenCalledWith({
        where: { id: 'eq_1' },
        select: { id: true },
      });
      expect(documentCreate).toHaveBeenCalledWith({
        data: { equipmentId: 'eq_1', ...dto },
      });
      expect(result).toMatchObject({
        id: 'doc_1',
        equipmentId: 'eq_1',
        type: EquipmentDocumentType.TECHNICAL_INSPECTION,
        title: 'Revisión técnica 2026',
        expiryDate: null,
        fileUrl: '/uploads/rt.pdf',
        status: 'SIN_DATO',
        daysToExpiry: null,
      });
    });

    it('lanza NotFoundException si el equipo no existe y no llega a crear el documento', async () => {
      equipmentFindUnique.mockResolvedValue(null);

      await expect(
        service.create('missing', {
          type: EquipmentDocumentType.INSURANCE,
        }),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(documentCreate).not.toHaveBeenCalled();
    });
  });

  describe('findByEquipment', () => {
    it('devuelve los documentos del equipo, cada uno con su vigencia derivada', async () => {
      equipmentFindUnique.mockResolvedValue({ id: 'eq_1' });
      documentFindMany.mockResolvedValue([RAW_DOCUMENT]);

      const result = await service.findByEquipment('eq_1');

      expect(documentFindMany).toHaveBeenCalledWith({
        where: { equipmentId: 'eq_1' },
        orderBy: { createdAt: 'desc' },
      });
      expect(result).toHaveLength(1);
      expect(result[0]).toMatchObject({ id: 'doc_1', status: 'SIN_DATO' });
    });

    it('lanza NotFoundException si el equipo no existe', async () => {
      equipmentFindUnique.mockResolvedValue(null);

      await expect(service.findByEquipment('missing')).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(documentFindMany).not.toHaveBeenCalled();
    });
  });

  describe('update', () => {
    it('actualiza el documento en el caso feliz', async () => {
      documentFindUnique.mockResolvedValue(RAW_DOCUMENT);
      documentUpdate.mockResolvedValue({
        ...RAW_DOCUMENT,
        title: 'RT actualizada',
      });

      const result = await service.update('doc_1', { title: 'RT actualizada' });

      expect(documentUpdate).toHaveBeenCalledWith({
        where: { id: 'doc_1' },
        data: { title: 'RT actualizada' },
      });
      expect(result).toMatchObject({ title: 'RT actualizada' });
    });

    it('limpia expiryDate/title/fileUrl/notes cuando se envía null explícito', async () => {
      documentFindUnique.mockResolvedValue(RAW_DOCUMENT);
      documentUpdate.mockResolvedValue({
        ...RAW_DOCUMENT,
        title: null,
        fileUrl: null,
        notes: null,
      });

      await service.update('doc_1', {
        title: null,
        expiryDate: null,
        fileUrl: null,
        notes: null,
      });

      expect(documentUpdate).toHaveBeenCalledWith({
        where: { id: 'doc_1' },
        data: { title: null, expiryDate: null, fileUrl: null, notes: null },
      });
    });

    it('lanza NotFoundException si el documento no existe', async () => {
      documentFindUnique.mockResolvedValue(null);

      await expect(
        service.update('missing', { title: 'x' }),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(documentUpdate).not.toHaveBeenCalled();
    });
  });

  describe('remove', () => {
    it('elimina el documento en el caso feliz', async () => {
      documentFindUnique.mockResolvedValue(RAW_DOCUMENT);

      await service.remove('doc_1');

      expect(documentDelete).toHaveBeenCalledWith({ where: { id: 'doc_1' } });
    });

    it('lanza NotFoundException si el documento no existe y no llega a borrar', async () => {
      documentFindUnique.mockResolvedValue(null);

      await expect(service.remove('missing')).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(documentDelete).not.toHaveBeenCalled();
    });
  });

  describe('vigencia — los 4 buckets de status (via findByEquipment)', () => {
    const NOW_ISO_TODAY = new Date();

    it('SIN_DATO sin expiryDate cargado', async () => {
      equipmentFindUnique.mockResolvedValue({ id: 'eq_1' });
      documentFindMany.mockResolvedValue([
        { ...RAW_DOCUMENT, expiryDate: null },
      ]);

      const [doc] = await service.findByEquipment('eq_1');

      expect(doc).toMatchObject({ status: 'SIN_DATO', daysToExpiry: null });
    });

    it('VENCIDO cuando expiryDate ya pasó', async () => {
      const ayer = new Date(NOW_ISO_TODAY.getTime() - 2 * 24 * 60 * 60 * 1000);
      equipmentFindUnique.mockResolvedValue({ id: 'eq_1' });
      documentFindMany.mockResolvedValue([
        { ...RAW_DOCUMENT, expiryDate: ayer },
      ]);

      const [doc] = await service.findByEquipment('eq_1');

      expect(doc.status).toBe('VENCIDO');
      expect(doc.daysToExpiry).toBeLessThan(0);
    });

    it('POR_VENCER dentro del umbral de 30 días', async () => {
      const enDiez = new Date(
        NOW_ISO_TODAY.getTime() + 10 * 24 * 60 * 60 * 1000,
      );
      equipmentFindUnique.mockResolvedValue({ id: 'eq_1' });
      documentFindMany.mockResolvedValue([
        { ...RAW_DOCUMENT, expiryDate: enDiez },
      ]);

      const [doc] = await service.findByEquipment('eq_1');

      expect(doc.status).toBe('POR_VENCER');
    });

    it('VIGENTE más allá del umbral de 30 días', async () => {
      const enCien = new Date(
        NOW_ISO_TODAY.getTime() + 100 * 24 * 60 * 60 * 1000,
      );
      equipmentFindUnique.mockResolvedValue({ id: 'eq_1' });
      documentFindMany.mockResolvedValue([
        { ...RAW_DOCUMENT, expiryDate: enCien },
      ]);

      const [doc] = await service.findByEquipment('eq_1');

      expect(doc.status).toBe('VIGENTE');
    });
  });
});
