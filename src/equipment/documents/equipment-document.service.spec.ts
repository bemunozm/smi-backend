import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { EquipmentDocumentType } from '@prisma/client';

import { PrismaService } from '../../common/prisma/prisma.service';
import { StorageService } from '../../storage/storage.service';
import { EquipmentDocumentService } from './equipment-document.service';

const USER_ID = 'user_1234567890123456789';

const RAW_DOCUMENT = {
  id: 'doc_1',
  equipmentId: 'eq_1',
  type: EquipmentDocumentType.TECHNICAL_INSPECTION,
  title: 'Revisión técnica 2026',
  expiryDate: null as Date | null,
  fileKey: 'equipment-documents/rt.pdf',
  fileName: 'Revisión Técnica.pdf' as string | null,
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
  const claimTmp = jest.fn();
  const discard = jest.fn();
  const deleteBestEffort = jest.fn();
  const sign = jest.fn();

  beforeEach(async () => {
    [
      equipmentFindUnique,
      documentCreate,
      documentFindMany,
      documentFindUnique,
      documentUpdate,
      documentDelete,
      claimTmp,
      discard,
      deleteBestEffort,
      sign,
    ].forEach((m) => m.mockReset());
    sign.mockResolvedValue('https://minio.local/signed/x');

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
        {
          provide: StorageService,
          useValue: { claimTmp, discard, deleteBestEffort, sign },
        },
      ],
    }).compile();

    service = module.get<EquipmentDocumentService>(EquipmentDocumentService);
  });

  describe('create', () => {
    it('crea el documento cuando el equipo existe, sin fileKey no llama a storage', async () => {
      equipmentFindUnique.mockResolvedValue({ id: 'eq_1' });
      documentCreate.mockResolvedValue({ ...RAW_DOCUMENT, fileKey: null });

      const dto = {
        type: EquipmentDocumentType.TECHNICAL_INSPECTION,
        title: 'Revisión técnica 2026',
      };
      const result = await service.create('eq_1', dto, USER_ID);

      expect(equipmentFindUnique).toHaveBeenCalledWith({
        where: { id: 'eq_1' },
        select: { id: true },
      });
      expect(claimTmp).not.toHaveBeenCalled();
      expect(documentCreate).toHaveBeenCalledWith({
        data: { equipmentId: 'eq_1', ...dto },
      });
      expect(result).toMatchObject({
        id: 'doc_1',
        equipmentId: 'eq_1',
        type: EquipmentDocumentType.TECHNICAL_INSPECTION,
        title: 'Revisión técnica 2026',
        expiryDate: null,
        fileUrl: null,
        status: 'SIN_DATO',
        daysToExpiry: null,
      });
      expect(result).not.toHaveProperty('fileKey');
    });

    it('con fileKey reclama la key tmp y crea con la key final + fileName', async () => {
      equipmentFindUnique.mockResolvedValue({ id: 'eq_1' });
      claimTmp.mockResolvedValue('equipment-documents/final.pdf');
      sign.mockResolvedValue('https://minio.local/signed/final.pdf');
      documentCreate.mockResolvedValue({
        ...RAW_DOCUMENT,
        fileKey: 'equipment-documents/final.pdf',
        fileName: 'Póliza Seguro.pdf',
      });

      const dto = {
        type: EquipmentDocumentType.INSURANCE,
        fileKey: 'tmp/user1234567890123456/raw.pdf',
        fileName: 'Póliza Seguro.pdf',
      };
      const result = await service.create('eq_1', dto, USER_ID);

      expect(claimTmp).toHaveBeenCalledWith(
        'tmp/user1234567890123456/raw.pdf',
        USER_ID,
        'equipment-document',
      );
      expect(documentCreate).toHaveBeenCalledWith({
        data: {
          equipmentId: 'eq_1',
          type: EquipmentDocumentType.INSURANCE,
          fileName: 'Póliza Seguro.pdf',
          fileKey: 'equipment-documents/final.pdf',
        },
      });
      expect(result).toMatchObject({
        fileUrl: 'https://minio.local/signed/final.pdf',
        fileName: 'Póliza Seguro.pdf',
      });
      expect(result).not.toHaveProperty('fileKey');
    });

    it('si el create en BD falla, descarta la copia nueva (rollback)', async () => {
      equipmentFindUnique.mockResolvedValue({ id: 'eq_1' });
      claimTmp.mockResolvedValue('equipment-documents/final.pdf');
      documentCreate.mockRejectedValue(new Error('boom'));

      await expect(
        service.create(
          'eq_1',
          {
            type: EquipmentDocumentType.INSURANCE,
            fileKey: 'tmp/user1234567890123456/raw.pdf',
          },
          USER_ID,
        ),
      ).rejects.toThrow('boom');

      expect(discard).toHaveBeenCalledWith('equipment-documents/final.pdf');
    });

    it('lanza NotFoundException si el equipo no existe y no llega a crear el documento', async () => {
      equipmentFindUnique.mockResolvedValue(null);

      await expect(
        service.create(
          'missing',
          { type: EquipmentDocumentType.INSURANCE },
          USER_ID,
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(documentCreate).not.toHaveBeenCalled();
      expect(claimTmp).not.toHaveBeenCalled();
    });

    it('si el shaping falla DESPUÉS de que la BD confirma el create, NO descarta la key ya persistida (hallazgo BAJO B1)', async () => {
      equipmentFindUnique.mockResolvedValue({ id: 'eq_1' });
      claimTmp.mockResolvedValue('equipment-documents/final.pdf');
      documentCreate.mockResolvedValue({
        ...RAW_DOCUMENT,
        fileKey: 'equipment-documents/final.pdf',
      });
      // `shape` llama a `sign` DESPUÉS de que el `create` en BD ya se
      // confirmó.
      sign.mockRejectedValue(new Error('sign boom'));

      await expect(
        service.create(
          'eq_1',
          {
            type: EquipmentDocumentType.INSURANCE,
            fileKey: 'tmp/user1234567890123456/raw.pdf',
          },
          USER_ID,
        ),
      ).rejects.toThrow('sign boom');

      expect(discard).not.toHaveBeenCalled();
    });
  });

  describe('findByEquipment', () => {
    it('devuelve los documentos del equipo, cada uno con su vigencia y fileUrl firmada', async () => {
      equipmentFindUnique.mockResolvedValue({ id: 'eq_1' });
      documentFindMany.mockResolvedValue([RAW_DOCUMENT]);
      sign.mockResolvedValue('https://minio.local/signed/rt.pdf');

      const result = await service.findByEquipment('eq_1');

      expect(documentFindMany).toHaveBeenCalledWith({
        where: { equipmentId: 'eq_1' },
        orderBy: { createdAt: 'desc' },
      });
      expect(sign).toHaveBeenCalledWith('equipment-documents/rt.pdf', {
        fileName: 'Revisión Técnica.pdf',
      });
      expect(result).toHaveLength(1);
      expect(result[0]).toMatchObject({
        id: 'doc_1',
        status: 'SIN_DATO',
        fileUrl: 'https://minio.local/signed/rt.pdf',
        fileName: 'Revisión Técnica.pdf',
      });
      expect(result[0]).not.toHaveProperty('fileKey');
    });

    it('fileUrl es null cuando el documento no tiene fileKey (y no llama a sign)', async () => {
      equipmentFindUnique.mockResolvedValue({ id: 'eq_1' });
      documentFindMany.mockResolvedValue([{ ...RAW_DOCUMENT, fileKey: null }]);

      const [doc] = await service.findByEquipment('eq_1');

      expect(sign).not.toHaveBeenCalled();
      expect(doc.fileUrl).toBeNull();
    });

    it('lanza NotFoundException si el equipo no existe', async () => {
      equipmentFindUnique.mockResolvedValue(null);

      await expect(service.findByEquipment('missing')).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(documentFindMany).not.toHaveBeenCalled();
    });
  });

  describe('update — fileKey tri-state', () => {
    it('undefined (omitido) no toca el archivo ni llama a storage', async () => {
      documentFindUnique.mockResolvedValue(RAW_DOCUMENT);
      documentUpdate.mockResolvedValue({
        ...RAW_DOCUMENT,
        title: 'RT actualizada',
      });

      const result = await service.update(
        'doc_1',
        { title: 'RT actualizada' },
        USER_ID,
      );

      expect(claimTmp).not.toHaveBeenCalled();
      expect(deleteBestEffort).not.toHaveBeenCalled();
      expect(documentUpdate).toHaveBeenCalledWith({
        where: { id: 'doc_1' },
        data: { title: 'RT actualizada' },
      });
      expect(result).toMatchObject({ title: 'RT actualizada' });
    });

    it('null limpia el archivo y borra el viejo DESPUÉS de que la BD confirma', async () => {
      documentFindUnique.mockResolvedValue(RAW_DOCUMENT);
      documentUpdate.mockResolvedValue({
        ...RAW_DOCUMENT,
        fileKey: null,
        fileName: null,
      });

      const result = await service.update(
        'doc_1',
        { fileKey: null, fileName: null },
        USER_ID,
      );

      expect(claimTmp).not.toHaveBeenCalled();
      expect(documentUpdate).toHaveBeenCalledWith({
        where: { id: 'doc_1' },
        data: { fileKey: null, fileName: null },
      });
      expect(deleteBestEffort).toHaveBeenCalledWith(
        'equipment-documents/rt.pdf',
      );
      expect(result.fileUrl).toBeNull();
    });

    it('una key nueva reclama, actualiza y borra la vieja DESPUÉS de que la BD confirma', async () => {
      documentFindUnique.mockResolvedValue(RAW_DOCUMENT);
      claimTmp.mockResolvedValue('equipment-documents/new.pdf');
      sign.mockResolvedValue('https://minio.local/signed/new.pdf');
      documentUpdate.mockResolvedValue({
        ...RAW_DOCUMENT,
        fileKey: 'equipment-documents/new.pdf',
      });

      const result = await service.update(
        'doc_1',
        { fileKey: 'tmp/user1234567890123456/new.pdf' },
        USER_ID,
      );

      expect(claimTmp).toHaveBeenCalledWith(
        'tmp/user1234567890123456/new.pdf',
        USER_ID,
        'equipment-document',
      );
      expect(documentUpdate).toHaveBeenCalledWith({
        where: { id: 'doc_1' },
        data: { fileKey: 'equipment-documents/new.pdf' },
      });
      expect(deleteBestEffort).toHaveBeenCalledWith(
        'equipment-documents/rt.pdf',
      );
      expect(result.fileUrl).toBe('https://minio.local/signed/new.pdf');
    });

    it('si la BD falla después de reclamar, descarta la copia nueva (rollback) y NO borra la vieja', async () => {
      documentFindUnique.mockResolvedValue(RAW_DOCUMENT);
      claimTmp.mockResolvedValue('equipment-documents/new.pdf');
      documentUpdate.mockRejectedValue(new Error('boom'));

      await expect(
        service.update(
          'doc_1',
          { fileKey: 'tmp/user1234567890123456/new.pdf' },
          USER_ID,
        ),
      ).rejects.toThrow('boom');

      expect(discard).toHaveBeenCalledWith('equipment-documents/new.pdf');
      expect(deleteBestEffort).not.toHaveBeenCalled();
    });

    it('un tmp ajeno (error de ownership) se propaga y nunca llega a actualizar', async () => {
      documentFindUnique.mockResolvedValue(RAW_DOCUMENT);
      claimTmp.mockRejectedValue(
        new BadRequestException(
          'No puedes usar un archivo temporal de otro usuario',
        ),
      );

      await expect(
        service.update(
          'doc_1',
          { fileKey: 'tmp/otro00000000000000000/x.pdf' },
          USER_ID,
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(documentUpdate).not.toHaveBeenCalled();
    });

    it('lanza NotFoundException si el documento no existe', async () => {
      documentFindUnique.mockResolvedValue(null);

      await expect(
        service.update('missing', { title: 'x' }, USER_ID),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(documentUpdate).not.toHaveBeenCalled();
    });

    it('si el shaping falla DESPUÉS de que la BD confirma el update, NO descarta la key nueva (hallazgo BAJO B1)', async () => {
      documentFindUnique.mockResolvedValue(RAW_DOCUMENT);
      claimTmp.mockResolvedValue('equipment-documents/new.pdf');
      documentUpdate.mockResolvedValue({
        ...RAW_DOCUMENT,
        fileKey: 'equipment-documents/new.pdf',
      });
      // `shape` llama a `sign` DESPUÉS de que el `update` en BD ya se
      // confirmó y de que el archivo viejo ya se borró.
      sign.mockRejectedValue(new Error('sign boom'));

      await expect(
        service.update(
          'doc_1',
          { fileKey: 'tmp/user1234567890123456/new.pdf' },
          USER_ID,
        ),
      ).rejects.toThrow('sign boom');

      expect(discard).not.toHaveBeenCalled();
      expect(deleteBestEffort).toHaveBeenCalledWith(
        'equipment-documents/rt.pdf',
      );
    });
  });

  describe('remove', () => {
    it('elimina el documento y borra el archivo del bucket', async () => {
      documentFindUnique.mockResolvedValue(RAW_DOCUMENT);

      await service.remove('doc_1');

      expect(documentDelete).toHaveBeenCalledWith({ where: { id: 'doc_1' } });
      expect(deleteBestEffort).toHaveBeenCalledWith(
        'equipment-documents/rt.pdf',
      );
    });

    it('sin fileKey no llama a deleteBestEffort', async () => {
      documentFindUnique.mockResolvedValue({ ...RAW_DOCUMENT, fileKey: null });

      await service.remove('doc_1');

      expect(deleteBestEffort).not.toHaveBeenCalled();
    });

    it('lanza NotFoundException si el documento no existe y no llega a borrar', async () => {
      documentFindUnique.mockResolvedValue(null);

      await expect(service.remove('missing')).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(documentDelete).not.toHaveBeenCalled();
    });
  });

  describe('getSignedFileUrl', () => {
    it('devuelve una url RECIÉN firmada con el fileName para disposition', async () => {
      documentFindUnique.mockResolvedValue(RAW_DOCUMENT);
      sign.mockResolvedValue('https://minio.local/signed/fresh.pdf');

      const url = await service.getSignedFileUrl('doc_1');

      expect(sign).toHaveBeenCalledWith('equipment-documents/rt.pdf', {
        fileName: 'Revisión Técnica.pdf',
      });
      expect(url).toBe('https://minio.local/signed/fresh.pdf');
    });

    it('null cuando el documento no tiene fileKey', async () => {
      documentFindUnique.mockResolvedValue({ ...RAW_DOCUMENT, fileKey: null });

      const url = await service.getSignedFileUrl('doc_1');

      expect(url).toBeNull();
      expect(sign).not.toHaveBeenCalled();
    });

    it('lanza NotFoundException si el documento no existe', async () => {
      documentFindUnique.mockResolvedValue(null);

      await expect(service.getSignedFileUrl('missing')).rejects.toBeInstanceOf(
        NotFoundException,
      );
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
