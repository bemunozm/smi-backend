import { NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';

import { PrismaService } from '../common/prisma/prisma.service';
import { UsersService } from './users.service';

const MOCK_USER = {
  id: 'user_1',
  name: 'Admin SMI',
  email: 'admin@smi.local',
  emailVerified: false,
  image: null,
  role: 'ADMIN',
  banned: false,
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
  updatedAt: new Date('2026-01-02T00:00:00.000Z'),
};

describe('UsersService', () => {
  let service: UsersService;
  const findMany = jest.fn();
  const findUnique = jest.fn();

  beforeEach(async () => {
    findMany.mockReset();
    findUnique.mockReset();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        UsersService,
        {
          provide: PrismaService,
          useValue: { user: { findMany, findUnique } },
        },
      ],
    }).compile();

    service = module.get<UsersService>(UsersService);
  });

  it('findAll maps Prisma rows to the public DTO with ISO dates', async () => {
    findMany.mockResolvedValue([MOCK_USER]);

    const result = await service.findAll();

    expect(result).toEqual([
      {
        id: 'user_1',
        name: 'Admin SMI',
        email: 'admin@smi.local',
        emailVerified: false,
        image: null,
        role: 'ADMIN',
        banned: false,
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-02T00:00:00.000Z',
      },
    ]);
  });

  it('findOne throws NotFoundException when the user does not exist', async () => {
    findUnique.mockResolvedValue(null);

    await expect(service.findOne('missing')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('findOne returns the mapped DTO when the user exists', async () => {
    findUnique.mockResolvedValue(MOCK_USER);

    const result = await service.findOne('user_1');

    expect(result.email).toBe('admin@smi.local');
    expect(result.createdAt).toBe('2026-01-01T00:00:00.000Z');
  });
});
