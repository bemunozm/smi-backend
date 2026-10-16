import { BadRequestException, ConflictException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Test } from '@nestjs/testing';

import { DOMAIN_EVENTS } from '../../common/events/domain-events';

import { PrismaService } from '../../common/prisma/prisma.service';
import { ChangeLogService } from '../../change-log/change-log.service';
import { ReporteDiarioService } from './reporte-diario.service';
import type { CreateReporteDiarioDto } from './dto/create-reporte-diario.dto';

const USER = { id: 'u1', name: 'Supervisor SMI' };

/** Payload completo y válido; cada test muta lo que necesita. */
const base = (): CreateReporteDiarioDto => ({
  id: '7b0d8c1e-3f5a-4e6b-9c2d-1a2b3c4d5e6f',
  fecha: '2026-10-14',
  turno: 'DIURNO',
  produccion: [
    { seccion: 'INTERNOS', camiones: 5, vueltasPorCamion: 4 },
    { seccion: 'MINA_CALETA', camiones: 16, vueltasPorCamion: 3 },
    { seccion: 'MINERAS', camiones: 34, vueltasPorCamion: 1 },
  ],
  tolvas: [
    { tolva: 1, cargas: 2 },
    { tolva: 2, cargas: 2 },
    { tolva: 3, cargas: 4 },
  ],
  plantas: [{ plantaId: 'p1', producto: 'Sal gruesa granel' }],
  traspasos: [
    { tipo: 'INTERNOS', cantidad: 3 },
    { tipo: 'EXTERNOS', cantidad: 1 },
    { tipo: 'MINA_PUERTO', cantidad: 4 },
  ],
  empresaIds: ['e1'],
  personal: [{ rol: 'Jefe de turno mina', nombre: 'Álvaro Henríquez' }],
});

// Mocks y setup a nivel de archivo: los `describe` hermanos (update, etc.) los
// reutilizan.
let service: ReporteDiarioService;

/** Delegado de tabla de bloque hijo (produccionTurno, reporteTolva, ...). */
const bloque = () => ({ deleteMany: jest.fn(), createMany: jest.fn() });
const prisma = {
  reporteDiario: {
    create: jest.fn(),
    findUnique: jest.fn(),
    findMany: jest.fn(),
    update: jest.fn(),
  },
  planta: { findMany: jest.fn() },
  empresaExterna: { findMany: jest.fn() },
  produccionTurno: bloque(),
  reporteTolva: bloque(),
  reportePlanta: bloque(),
  reporteTraspaso: bloque(),
  reporteEmpresa: bloque(),
  reporteDiarioPersonal: bloque(),
  $transaction: jest.fn(),
};
const changeLog = { record: jest.fn(), findFor: jest.fn() };
const emitter = { emit: jest.fn() };

/** Argumento `i` de la llamada `n` de un mock. `jest.fn()` sin genérico tipa las llamadas como `any`. */
const argDe = <T>(fn: jest.Mock, n: number, i: number): T =>
  (fn.mock.calls[n] as unknown[])[i] as T;

beforeEach(async () => {
  const mod = await Test.createTestingModule({
    providers: [
      ReporteDiarioService,
      { provide: PrismaService, useValue: prisma },
      { provide: ChangeLogService, useValue: changeLog },
      { provide: EventEmitter2, useValue: emitter },
    ],
  }).compile();
  service = mod.get(ReporteDiarioService);
  jest.clearAllMocks();
  prisma.reporteDiario.findUnique.mockResolvedValue(null);
  prisma.reporteDiario.create.mockImplementation(
    ({ data }: { data: unknown }) => data,
  );
  prisma.planta.findMany.mockResolvedValue([{ id: 'p1' }]);
  prisma.empresaExterna.findMany.mockResolvedValue([{ id: 'e1' }]);
});

interface CreateData {
  supervisorId: string;
  supervisorNombre: string;
  createdById: string;
  produccion: { create: unknown[] };
  plantas: { create: unknown[] };
}

describe('ReporteDiarioService.create', () => {
  it('crea el reporte con sus bloques anidados y el snapshot del supervisor', async () => {
    await service.create(base(), USER.id, USER.name);
    const { data } = argDe<{ data: CreateData }>(
      prisma.reporteDiario.create,
      0,
      0,
    );
    expect(data.supervisorId).toBe('u1');
    expect(data.supervisorNombre).toBe('Supervisor SMI');
    expect(data.createdById).toBe('u1');
    expect(data.produccion.create).toHaveLength(3);
    expect(data.plantas.create).toEqual([
      { plantaId: 'p1', producto: 'Sal gruesa granel' },
    ]);
  });

  it('un turno flojo (sin plantas, empresas ni tolvas) es un reporte válido', async () => {
    const dto = { ...base(), plantas: [], empresaIds: [], tolvas: [] };
    await service.create(dto, USER.id, USER.name);
    expect(prisma.reporteDiario.create).toHaveBeenCalled();
  });

  it('rechaza secciones repetidas aunque sean 3', async () => {
    const dto = base();
    dto.produccion[1] = {
      seccion: 'INTERNOS',
      camiones: 1,
      vueltasPorCamion: 1,
    };
    await expect(service.create(dto, USER.id, USER.name)).rejects.toThrow(
      BadRequestException,
    );
  });

  it('rechaza una planta inexistente o inactiva con mensaje claro', async () => {
    prisma.planta.findMany.mockResolvedValue([]);
    await expect(service.create(base(), USER.id, USER.name)).rejects.toThrow(
      /planta/i,
    );
  });

  it('rechaza plantaId repetido en el payload (replay sin formulario)', async () => {
    const dto = base();
    dto.plantas = [
      { plantaId: 'p1', producto: 'Sal gruesa' },
      { plantaId: 'p1', producto: 'Sal fina' },
    ];
    await expect(service.create(dto, USER.id, USER.name)).rejects.toThrow(
      BadRequestException,
    );
  });

  it('ya existe el turno (otro id) → 409 con fecha y turno en el mensaje', async () => {
    // El primer findUnique es la búsqueda por id (replay) — null; el segundo,
    // por fecha+turno — ocupado.
    prisma.reporteDiario.findUnique
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: 'otro', createdById: 'u2' });
    const err = await service
      .create(base(), USER.id, USER.name)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConflictException);
    expect((err as ConflictException).message).toBe(
      'Ya existe el reporte del turno DIURNO del 2026-10-14.',
    );
  });

  it('replay con el mismo id del MISMO usuario devuelve el existente sin crear', async () => {
    prisma.reporteDiario.findUnique.mockResolvedValueOnce({
      id: base().id,
      createdById: USER.id,
    });
    // findOne vuelve a leer con include:
    prisma.reporteDiario.findUnique.mockResolvedValueOnce({
      id: base().id,
      createdById: USER.id,
      produccion: [],
      tolvas: [],
      plantas: [],
      traspasos: [],
      empresas: [],
      personal: [],
    });
    const res = await service.create(base(), USER.id, USER.name);
    expect(prisma.reporteDiario.create).not.toHaveBeenCalled();
    expect(res.id).toBe(base().id);
    expect(res).not.toHaveProperty('createdById');
  });

  it('mismo id de OTRO usuario → conflicto, no devuelve el reporte ajeno', async () => {
    prisma.reporteDiario.findUnique.mockResolvedValueOnce({
      id: base().id,
      createdById: 'u-ajeno',
    });
    await expect(service.create(base(), USER.id, USER.name)).rejects.toThrow(
      ConflictException,
    );
  });

  it('la carrera que pasa el chequeo previo (P2002 de Prisma) sale como 409, no 500', async () => {
    const p2002 = Object.assign(new Error('Unique constraint failed'), {
      code: 'P2002',
    });
    prisma.reporteDiario.create.mockRejectedValue(p2002);
    await expect(service.create(base(), USER.id, USER.name)).rejects.toThrow(
      ConflictException,
    );
  });

  it('la respuesta no contiene createdById', async () => {
    const res = await service.create(base(), USER.id, USER.name);
    expect(res).not.toHaveProperty('createdById');
  });

  it('el chequeo previo usa el unique compuesto fecha_turno', async () => {
    await service.create(base(), USER.id, USER.name);
    expect(prisma.reporteDiario.findUnique).toHaveBeenCalledWith({
      where: {
        fecha_turno: { fecha: new Date('2026-10-14'), turno: 'DIURNO' },
      },
      select: { id: true },
    });
  });

  it('rechaza tolvas repetidas', async () => {
    const dto = base();
    dto.tolvas = [
      { tolva: 1, cargas: 1 },
      { tolva: 1, cargas: 2 },
    ];
    await expect(service.create(dto, USER.id, USER.name)).rejects.toThrow(
      BadRequestException,
    );
  });

  it('rechaza traspasos repetidos', async () => {
    const dto = base();
    dto.traspasos = [
      { tipo: 'INTERNOS', cantidad: 1 },
      { tipo: 'INTERNOS', cantidad: 2 },
    ];
    await expect(service.create(dto, USER.id, USER.name)).rejects.toThrow(
      BadRequestException,
    );
  });

  it('rechaza empresaIds repetidos', async () => {
    const dto = { ...base(), empresaIds: ['e1', 'e1'] };
    await expect(service.create(dto, USER.id, USER.name)).rejects.toThrow(
      BadRequestException,
    );
  });

  it('rechaza una empresa inexistente o inactiva con mensaje claro', async () => {
    prisma.empresaExterna.findMany.mockResolvedValue([]);
    const err = await service
      .create(base(), USER.id, USER.name)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BadRequestException);
    expect((err as BadRequestException).message).toMatch(/empresa/i);
  });
});

describe('ReporteDiarioService.findAll', () => {
  // `service` y `prisma` del describe raíz; findMany devuelve [] por defecto.

  it('sin filtros lista todo, fecha desc', async () => {
    prisma.reporteDiario.findMany.mockResolvedValue([]);
    await service.findAll({});
    const cualquiera: unknown = expect.anything();
    expect(prisma.reporteDiario.findMany).toHaveBeenCalledWith({
      where: {},
      orderBy: [{ fecha: 'desc' }, { turno: 'asc' }],
      include: cualquiera,
    });
  });

  it('desde/hasta acotan la fecha y turno filtra exacto', async () => {
    prisma.reporteDiario.findMany.mockResolvedValue([]);
    await service.findAll({
      desde: '2026-10-01',
      hasta: '2026-10-14',
      turno: 'DIURNO',
    });
    const { where } = argDe<{
      where: { turno?: string; fecha?: unknown };
    }>(prisma.reporteDiario.findMany, 0, 0);
    expect(where.turno).toBe('DIURNO');
    expect(where.fecha).toEqual({
      gte: new Date('2026-10-01'),
      lte: new Date('2026-10-14'),
    });
  });

  it('las filas devueltas no llevan createdById', async () => {
    prisma.reporteDiario.findMany.mockResolvedValue([
      { id: 'r1', createdById: 'u1', turno: 'DIURNO' },
    ]);
    const res = await service.findAll({});
    expect(res).toHaveLength(1);
    expect(res[0]).not.toHaveProperty('createdById');
  });

  it('un rango invertido o sin reportes devuelve [], no error', async () => {
    prisma.reporteDiario.findMany.mockResolvedValue([]);
    const res = await service.findAll({
      desde: '2026-12-01',
      hasta: '2026-01-01',
    });
    expect(res).toEqual([]);
  });
});

describe('ReporteDiarioService.update', () => {
  const EDITOR = { id: 'u1', name: 'Supervisor SMI' };
  const guardado = () => ({
    id: 'r1',
    fecha: new Date('2026-10-14'),
    turno: 'DIURNO',
    observaciones: null,
    produccion: [
      { seccion: 'INTERNOS', camiones: 5, vueltasPorCamion: 4 },
      { seccion: 'MINA_CALETA', camiones: 16, vueltasPorCamion: 3 },
      { seccion: 'MINERAS', camiones: 34, vueltasPorCamion: 1 },
    ],
    tolvas: [],
    plantas: [],
    traspasos: [],
    empresas: [],
    personal: [],
  });

  beforeEach(() => {
    prisma.$transaction.mockImplementation(
      (fn: (tx: unknown) => Promise<unknown>) => fn(prisma),
    );
  });

  it('reemplaza el bloque enviado y registra el diff en ChangeLog', async () => {
    const despues = {
      ...guardado(),
      produccion: [
        { seccion: 'INTERNOS', camiones: 6, vueltasPorCamion: 4 },
        { seccion: 'MINA_CALETA', camiones: 16, vueltasPorCamion: 3 },
        { seccion: 'MINERAS', camiones: 34, vueltasPorCamion: 1 },
      ],
    };
    prisma.reporteDiario.findUnique
      .mockResolvedValueOnce(guardado())
      .mockResolvedValueOnce(despues);
    await service.update('r1', { produccion: despues.produccion }, EDITOR);
    expect(prisma.produccionTurno.deleteMany).toHaveBeenCalledWith({
      where: { reporteId: 'r1' },
    });
    expect(changeLog.record).toHaveBeenCalledWith(
      prisma,
      'reporte_diario',
      'r1',
      EDITOR,
      expect.arrayContaining([expect.objectContaining({ label: 'Camiones' })]),
    );
    // Cambio solo de bloques: la fila padre se toca igual (updatedAt).
    expect(prisma.reporteDiario.update).toHaveBeenCalledWith({
      where: { id: 'r1' },
      data: { updatedAt: expect.any(Date) as unknown },
    });
    expect(emitter.emit).toHaveBeenCalledTimes(1);
    const [evento, payload] = emitter.emit.mock.calls[0] as [
      string,
      {
        entity: string;
        entityId: string;
        editedBy: string;
        entityLabel: string;
        changes: { label: string }[];
      },
    ];
    expect(evento).toBe(DOMAIN_EVENTS.RECORD_EDITED);
    expect(payload.entity).toBe('reporte_diario');
    expect(payload.entityId).toBe('r1');
    expect(payload.editedBy).toBe('Supervisor SMI');
    expect(payload.entityLabel).toMatch(/14-10-2026|14\/10\/2026/);
    expect(payload.entityLabel).toContain('DIURNO');
    expect(payload.changes.map((c) => c.label)).toContain('Camiones');
  });

  it('una edición sin cambios reales no escribe ChangeLog', async () => {
    prisma.reporteDiario.findUnique
      .mockResolvedValueOnce(guardado())
      .mockResolvedValueOnce(guardado());
    await service.update('r1', { produccion: guardado().produccion }, EDITOR);
    expect(changeLog.record).not.toHaveBeenCalled();
    expect(emitter.emit).not.toHaveBeenCalled();
    expect(prisma.reporteDiario.update).not.toHaveBeenCalled();
  });

  it('un bloque vacío queda como «—» en el diff, no como texto roto', async () => {
    const con = {
      ...guardado(),
      plantas: [
        { plantaId: 'p1', producto: 'Sal', planta: { nombre: 'P.P.1' } },
      ],
    };
    prisma.reporteDiario.findUnique
      .mockResolvedValueOnce(con)
      .mockResolvedValueOnce(guardado());
    prisma.planta.findMany.mockResolvedValue([]);
    await service.update('r1', { plantas: [] }, EDITOR);
    const diff = argDe<{ label: string; after: unknown }[]>(
      changeLog.record,
      0,
      4,
    );
    const plantas = diff.find((d) => d.label === 'Plantas');
    expect(plantas?.after).toBe('—');
  });

  it('findChanges delega en ChangeLogService.findFor', async () => {
    await service.findChanges('r1');
    expect(changeLog.findFor).toHaveBeenCalledWith('reporte_diario', 'r1');
  });
});
