import { BadRequestException } from '@nestjs/common';
import { Test } from '@nestjs/testing';

import { PrismaService } from '../../common/prisma/prisma.service';
import { StorageService } from '../../storage/storage.service';
import { CombustibleService } from './combustible.service';

const USER_ID = 'user_1234567890123456789';

describe('CombustibleService', () => {
  let service: CombustibleService;
  const prisma = {
    equipment: { findUnique: jest.fn() },
    registroCombustible: {
      create: jest.fn(),
      update: jest.fn(),
      findUnique: jest.fn(),
      findMany: jest.fn(),
    },
  };
  const claimTmp = jest.fn();
  const discard = jest.fn();
  const sign = jest.fn();

  beforeEach(async () => {
    const mod = await Test.createTestingModule({
      providers: [
        CombustibleService,
        { provide: PrismaService, useValue: prisma },
        {
          provide: StorageService,
          useValue: { claimTmp, discard, deleteBestEffort: jest.fn(), sign },
        },
      ],
    }).compile();
    service = mod.get(CombustibleService);
    jest.clearAllMocks();
    prisma.registroCombustible.create.mockImplementation(
      ({ data }: { data: Record<string, unknown> }) => data,
    );
    prisma.registroCombustible.update.mockImplementation(
      ({ data }: { data: Record<string, unknown> }) => data,
    );
  });

  it('guarda litros y tipo de combustible', async () => {
    prisma.equipment.findUnique.mockResolvedValue({ id: 'e1' });
    const res = await service.create(
      { equipoId: 'e1', litros: 120, tipo: 'PETROLEO' },
      USER_ID,
    );
    expect(res.litros).toBe(120);
    expect(res.tipo).toBe('PETROLEO');
  });

  it('rechaza si el equipo no existe', async () => {
    prisma.equipment.findUnique.mockResolvedValue(null);
    await expect(
      service.create({ equipoId: 'x', litros: 10, tipo: 'BENCINA' }, USER_ID),
    ).rejects.toThrow();
  });

  it('persiste la fecha provista (ej. EXIF de la foto) en vez del default', async () => {
    prisma.equipment.findUnique.mockResolvedValue({ id: 'e1' });
    const res = await service.create(
      {
        equipoId: 'e1',
        litros: 50,
        tipo: 'PETROLEO',
        fecha: '2026-01-15T10:30:00.000Z',
      },
      USER_ID,
    );
    expect(res.fecha).toEqual(new Date('2026-01-15T10:30:00.000Z'));
  });

  it('sin fecha, no manda la key `fecha` a Prisma y cae al @default(now())', async () => {
    prisma.equipment.findUnique.mockResolvedValue({ id: 'e1' });
    const res = await service.create(
      { equipoId: 'e1', litros: 50, tipo: 'PETROLEO' },
      USER_ID,
    );
    expect('fecha' in res).toBe(false);
  });

  describe('fotoUrl legacy — sigue pasando tal cual', () => {
    it('persiste fotoUrl legacy y la devuelve tal cual (sin fotoKey, no llama a storage)', async () => {
      prisma.equipment.findUnique.mockResolvedValue({ id: 'e1' });

      const res = await service.create(
        {
          equipoId: 'e1',
          litros: 30,
          tipo: 'BENCINA',
          fotoUrl: '/uploads/carga-123.jpg',
        },
        USER_ID,
      );

      expect(claimTmp).not.toHaveBeenCalled();
      expect(sign).not.toHaveBeenCalled();
      expect(res.fotoUrl).toBe('/uploads/carga-123.jpg');
      expect(res).not.toHaveProperty('fotoKey');
    });
  });

  describe('fotoKey — R2/MinIO, aditivo sobre fotoUrl legacy', () => {
    it('rechaza con 400 si llegan fotoUrl y fotoKey juntos, sin llamar a storage ni crear', async () => {
      prisma.equipment.findUnique.mockResolvedValue({ id: 'e1' });

      await expect(
        service.create(
          {
            equipoId: 'e1',
            litros: 30,
            tipo: 'BENCINA',
            fotoUrl: '/uploads/x.jpg',
            fotoKey: 'tmp/user1234567890123456/x.jpg',
          },
          USER_ID,
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(claimTmp).not.toHaveBeenCalled();
      expect(prisma.registroCombustible.create).not.toHaveBeenCalled();
    });

    it('con fotoKey reclama la key tmp y la respuesta trae fotoUrl firmada (nunca fotoKey)', async () => {
      prisma.equipment.findUnique.mockResolvedValue({ id: 'e1' });
      claimTmp.mockResolvedValue('fuel-photos/final.jpg');
      sign.mockResolvedValue('https://minio.local/signed/final.jpg');

      const res = await service.create(
        {
          equipoId: 'e1',
          litros: 30,
          tipo: 'BENCINA',
          fotoKey: 'tmp/user1234567890123456/raw.jpg',
        },
        USER_ID,
      );

      expect(claimTmp).toHaveBeenCalledWith(
        'tmp/user1234567890123456/raw.jpg',
        USER_ID,
        'fuel-photo',
      );
      expect(res.fotoUrl).toBe('https://minio.local/signed/final.jpg');
      expect(res).not.toHaveProperty('fotoKey');
    });

    it('si el create en BD falla después de reclamar, descarta la copia nueva (rollback)', async () => {
      prisma.equipment.findUnique.mockResolvedValue({ id: 'e1' });
      claimTmp.mockResolvedValue('fuel-photos/final.jpg');
      prisma.registroCombustible.create.mockRejectedValue(new Error('boom'));

      await expect(
        service.create(
          {
            equipoId: 'e1',
            litros: 30,
            tipo: 'BENCINA',
            fotoKey: 'tmp/user1234567890123456/raw.jpg',
          },
          USER_ID,
        ),
      ).rejects.toThrow('boom');

      expect(discard).toHaveBeenCalledWith('fuel-photos/final.jpg');
    });

    it('un tmp ajeno (error de ownership) se propaga y nunca llega a crear', async () => {
      prisma.equipment.findUnique.mockResolvedValue({ id: 'e1' });
      claimTmp.mockRejectedValue(
        new BadRequestException(
          'No puedes usar un archivo temporal de otro usuario',
        ),
      );

      await expect(
        service.create(
          {
            equipoId: 'e1',
            litros: 30,
            tipo: 'BENCINA',
            fotoKey: 'tmp/otro00000000000000000/raw.jpg',
          },
          USER_ID,
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.registroCombustible.create).not.toHaveBeenCalled();
    });

    it('si el shaping falla DESPUÉS de que la BD confirma el create, NO descarta la key ya persistida (hallazgo BAJO B1)', async () => {
      prisma.equipment.findUnique.mockResolvedValue({ id: 'e1' });
      claimTmp.mockResolvedValue('fuel-photos/final.jpg');
      prisma.registroCombustible.create.mockResolvedValue({
        id: 'c1',
        equipoId: 'e1',
        litros: 30,
        tipo: 'BENCINA',
        fotoUrl: null,
        fotoKey: 'fuel-photos/final.jpg',
        fecha: new Date(),
      });
      // `shape` llama a `sign` DESPUÉS de que el `create` en BD ya se
      // confirmó.
      sign.mockRejectedValue(new Error('sign boom'));

      await expect(
        service.create(
          {
            equipoId: 'e1',
            litros: 30,
            tipo: 'BENCINA',
            fotoKey: 'tmp/user1234567890123456/raw.jpg',
          },
          USER_ID,
        ),
      ).rejects.toThrow('sign boom');

      expect(discard).not.toHaveBeenCalled();
    });
  });

  describe('findAll/findOne/update — shape', () => {
    it('findAll mantiene el include equipo.internalCode que usa la vista de Terreno', async () => {
      prisma.registroCombustible.findMany.mockResolvedValue([
        {
          id: 'c1',
          equipoId: 'e1',
          litros: 20,
          tipo: 'PETROLEO',
          fotoUrl: null,
          fotoKey: null,
          fecha: new Date(),
          equipo: { internalCode: 'EX-001' },
        },
      ]);

      const [res] = await service.findAll();

      expect(prisma.registroCombustible.findMany).toHaveBeenCalledWith({
        orderBy: { fecha: 'desc' },
        include: { equipo: { select: { internalCode: true } } },
      });
      expect(res).toMatchObject({ equipo: { internalCode: 'EX-001' } });
      expect(res).not.toHaveProperty('fotoKey');
    });

    it('findOne firma fotoUrl cuando el registro tiene fotoKey', async () => {
      prisma.registroCombustible.findUnique.mockResolvedValue({
        id: 'c1',
        equipoId: 'e1',
        litros: 20,
        tipo: 'PETROLEO',
        fotoUrl: null,
        fotoKey: 'fuel-photos/x.jpg',
        fecha: new Date(),
      });
      sign.mockResolvedValue('https://minio.local/signed/x.jpg');

      const res = await service.findOne('c1');

      expect(res.fotoUrl).toBe('https://minio.local/signed/x.jpg');
      expect(res).not.toHaveProperty('fotoKey');
    });

    it('update no toca fotoKey (fuera de alcance del DTO de update) y re-shapea la salida', async () => {
      prisma.registroCombustible.update.mockResolvedValue({
        id: 'c1',
        equipoId: 'e1',
        litros: 20,
        tipo: 'PETROLEO',
        fotoUrl: '/uploads/legacy.jpg',
        fotoKey: null,
        fecha: new Date(),
      });

      const res = await service.update('c1', {
        fotoUrl: '/uploads/legacy.jpg',
      });

      expect(prisma.registroCombustible.update).toHaveBeenCalledWith({
        where: { id: 'c1' },
        data: { fotoUrl: '/uploads/legacy.jpg' },
      });
      expect(res.fotoUrl).toBe('/uploads/legacy.jpg');
      expect(res).not.toHaveProperty('fotoKey');
    });
  });
});
