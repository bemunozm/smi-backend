import { BadRequestException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Prisma } from '@prisma/client';

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

  describe('fotoUrl legacy — solo LECTURA, no se puede crear con ella', () => {
    it('findOne devuelve fotoUrl legacy tal cual cuando el registro no tiene fotoKey (dato histórico — fotoUrl no está en el DTO de creación)', async () => {
      prisma.registroCombustible.findUnique.mockResolvedValue({
        id: 'c1',
        equipoId: 'e1',
        litros: 30,
        tipo: 'BENCINA',
        fotoUrl: '/uploads/carga-123.jpg',
        fotoKey: null,
        fecha: new Date(),
      });

      const res = await service.findOne('c1');

      expect(sign).not.toHaveBeenCalled();
      expect(res.fotoUrl).toBe('/uploads/carga-123.jpg');
      expect(res).not.toHaveProperty('fotoKey');
    });
  });

  describe('fotoKey — R2/MinIO', () => {
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

    it('si el shaping falla DESPUÉS de que la BD confirma el create, NO descarta la key ya persistida', async () => {
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

  describe('id del cliente (reintento offline)', () => {
    const ID = '11111111-1111-4111-8111-111111111111';
    const dto = {
      id: ID,
      equipoId: 'e1',
      litros: 30,
      tipo: 'BENCINA',
      fotoKey: 'tmp/user1234567890123456/raw.jpg',
    };
    const stored = {
      id: ID,
      equipoId: 'e1',
      litros: 30,
      tipo: 'BENCINA',
      fotoUrl: null,
      fotoKey: 'fuel-photos/final.jpg',
      fecha: new Date(),
    };

    beforeEach(() => {
      prisma.registroCombustible.findUnique.mockReset();
      sign.mockResolvedValue('https://minio.local/signed/final.jpg');
    });

    it('replay del mismo usuario: devuelve la carga con la foto firmada de nuevo, sin reclamar ni crear', async () => {
      prisma.registroCombustible.findUnique.mockResolvedValue({
        ...stored,
        createdById: USER_ID,
      });

      const res = await service.create(dto, USER_ID);

      expect(res.fotoUrl).toBe('https://minio.local/signed/final.jpg');
      expect(res).not.toHaveProperty('fotoKey');
      expect(res).not.toHaveProperty('createdById');
      expect(claimTmp).not.toHaveBeenCalled();
      expect(prisma.registroCombustible.create).not.toHaveBeenCalled();
    });

    it('id ocupado por otro usuario: 409 ID_CONFLICT y no toca el storage', async () => {
      prisma.registroCombustible.findUnique.mockResolvedValue({
        ...stored,
        createdById: 'otro',
      });

      await expect(service.create(dto, USER_ID)).rejects.toMatchObject({
        response: { code: 'ID_CONFLICT' },
      });
      expect(claimTmp).not.toHaveBeenCalled();
      expect(sign).not.toHaveBeenCalled();
    });

    it('carrera sobre la PK: el perdedor descarta su copia de la foto y devuelve la fila ganadora', async () => {
      prisma.equipment.findUnique.mockResolvedValue({ id: 'e1' });
      claimTmp.mockResolvedValue('fuel-photos/perdedora.jpg');
      prisma.registroCombustible.findUnique
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({ ...stored, createdById: USER_ID });
      prisma.registroCombustible.create.mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError('unique', {
          code: 'P2002',
          clientVersion: 'test',
          meta: { target: ['id'] },
        }),
      );

      const res = await service.create(dto, USER_ID);

      expect(discard).toHaveBeenCalledWith('fuel-photos/perdedora.jpg');
      expect(res.fotoUrl).toBe('https://minio.local/signed/final.jpg');
    });

    it('con id nuevo reclama la foto y guarda el dueño', async () => {
      prisma.equipment.findUnique.mockResolvedValue({ id: 'e1' });
      prisma.registroCombustible.findUnique.mockResolvedValue(null);
      claimTmp.mockResolvedValue('fuel-photos/final.jpg');

      await service.create(dto, USER_ID);

      const [{ data }] = prisma.registroCombustible.create.mock.calls[0] as [
        { data: Record<string, unknown> },
      ];
      expect(data).toMatchObject({ id: ID, createdById: USER_ID });
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

    it('update no toca fotoKey (UpdateCombustibleDto no tiene campos propios) y re-shapea la salida', async () => {
      prisma.registroCombustible.update.mockResolvedValue({
        id: 'c1',
        equipoId: 'e1',
        litros: 20,
        tipo: 'PETROLEO',
        fotoUrl: '/uploads/legacy.jpg',
        fotoKey: null,
        fecha: new Date(),
      });

      const res = await service.update('c1', {});

      expect(prisma.registroCombustible.update).toHaveBeenCalledWith({
        where: { id: 'c1' },
        data: {},
      });
      // El registro YA tenía fotoUrl legacy antes de este update (dato
      // histórico) — se sigue devolviendo tal cual, aunque el DTO de update
      // no tenga forma de escribirlo.
      expect(res.fotoUrl).toBe('/uploads/legacy.jpg');
      expect(res).not.toHaveProperty('fotoKey');
    });
  });
});
