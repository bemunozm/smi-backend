import { NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';

import { PrismaService } from '../common/prisma/prisma.service';
import { FichaService } from './ficha.service';

const EQUIPO_MOCK = {
  id: 'eq_1',
  codigo: 'EX-001',
  tipo: 'CAMION',
  marca: 'Volvo',
  modelo: 'FH',
  anio: 2020,
  estado: 'DISPONIBLE',
  horometroActual: 100,
  kilometrajeActual: 5000,
};

const COMBUSTIBLES_MOCK = [
  {
    id: 'c1',
    equipoId: 'eq_1',
    litros: 120,
    tipo: 'PETROLEO',
    fotoUrl: null,
    fecha: new Date('2026-08-01T10:00:00Z'),
  },
];

const HOROMETROS_MOCK = [
  {
    id: 'h1',
    equipoId: 'eq_1',
    operador: 'Juan',
    turno: 'DIURNO',
    valorInicial: 10,
    valorFinal: 20,
    nivelCombustible: 80,
    fecha: new Date('2026-07-30T10:00:00Z'),
  },
];

const TRABAJOS_EXTRA_MOCK = [
  {
    id: 't1',
    equipoId: 'eq_1',
    operador: 'Pedro',
    faena: 'Faena A',
    turno: 'DIURNO',
    horometroInicial: 10,
    horometroFinal: 15,
    totalHoras: 5,
    actividad: 'LIMPIEZA_CANCHA',
    descripcion: 'Limpieza de cancha',
    observaciones: null,
    fecha: new Date('2026-07-29T10:00:00Z'),
  },
];

const HALLAZGOS_MOCK = [
  {
    id: 'ha1',
    equipoId: 'eq_1',
    descripcion: 'Fuga de aceite',
    prioridad: 'CRITICA',
    estado: 'ABIERTO',
    fotoUrl: null,
    fecha: new Date('2026-08-02T10:00:00Z'),
  },
  {
    id: 'ha2',
    equipoId: 'eq_1',
    descripcion: 'Ruido extraño',
    prioridad: 'BAJA',
    estado: 'CERRADO',
    fotoUrl: null,
    fecha: new Date('2026-07-01T10:00:00Z'),
  },
];

const ORDENES_MOCK = [
  {
    id: 'ot1',
    equipoId: 'eq_1',
    asignadoAId: null,
    titulo: 'Cambio de aceite',
    estado: 'PENDIENTE',
    prioridad: 'MEDIA',
    tipo: 'PREVENTIVA',
    origen: 'MANUAL',
    origenDetalle: null,
    createdAt: new Date('2026-08-03T10:00:00Z'),
    updatedAt: new Date('2026-08-03T10:00:00Z'),
    intervenciones: [
      {
        id: 'iv1',
        ordenId: 'ot1',
        tipo: 'PREVENTIVA',
        detalle: 'Cambio de filtro',
        horasHombre: 2,
        horometro: 100,
        realizadaPorId: null,
        soloLectura: false,
        fecha: new Date('2026-08-03T11:00:00Z'),
      },
    ],
  },
  {
    id: 'ot2',
    equipoId: 'eq_1',
    asignadoAId: null,
    titulo: 'Reparación motor',
    estado: 'COMPLETADA',
    prioridad: 'ALTA',
    tipo: 'CORRECTIVA',
    origen: 'HALLAZGO',
    origenDetalle: 'ha1',
    createdAt: new Date('2026-06-01T10:00:00Z'),
    updatedAt: new Date('2026-06-05T10:00:00Z'),
    intervenciones: [],
  },
];

const ACTIVIDADES_MOCK = [
  {
    id: 'ac1',
    descripcion: 'Revisión general',
    origen: 'MANUAL',
    referencia: null,
    asignadoAId: null,
    equipoId: 'eq_1',
    hallazgoId: null,
    estado: 'PENDIENTE',
    createdAt: new Date('2026-07-15T10:00:00Z'),
    updatedAt: new Date('2026-07-15T10:00:00Z'),
  },
];

describe('FichaService', () => {
  let service: FichaService;

  const equipoFindUnique = jest.fn();
  const combustibleFindMany = jest.fn();
  const horometroFindMany = jest.fn();
  const trabajoExtraFindMany = jest.fn();
  const hallazgoFindMany = jest.fn();
  const ordenFindMany = jest.fn();
  const actividadFindMany = jest.fn();
  const combustibleCount = jest.fn();
  const horometroCount = jest.fn();
  const trabajoExtraCount = jest.fn();
  const hallazgoCount = jest.fn();
  const ordenCount = jest.fn();
  const actividadCount = jest.fn();

  beforeEach(async () => {
    [
      equipoFindUnique,
      combustibleFindMany,
      horometroFindMany,
      trabajoExtraFindMany,
      hallazgoFindMany,
      ordenFindMany,
      actividadFindMany,
      combustibleCount,
      horometroCount,
      trabajoExtraCount,
      hallazgoCount,
      ordenCount,
      actividadCount,
    ].forEach((m) => m.mockReset());

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        FichaService,
        {
          provide: PrismaService,
          useValue: {
            equipo: { findUnique: equipoFindUnique },
            registroCombustible: {
              findMany: combustibleFindMany,
              count: combustibleCount,
            },
            registroHorometro: {
              findMany: horometroFindMany,
              count: horometroCount,
            },
            trabajoExtraordinario: {
              findMany: trabajoExtraFindMany,
              count: trabajoExtraCount,
            },
            hallazgo: { findMany: hallazgoFindMany, count: hallazgoCount },
            ordenTrabajo: { findMany: ordenFindMany, count: ordenCount },
            actividad: { findMany: actividadFindMany, count: actividadCount },
          },
        },
      ],
    }).compile();

    service = module.get<FichaService>(FichaService);
  });

  function mockearOrigenesConDatos(): void {
    equipoFindUnique.mockResolvedValue(EQUIPO_MOCK);
    combustibleFindMany.mockResolvedValue(COMBUSTIBLES_MOCK);
    horometroFindMany.mockResolvedValue(HOROMETROS_MOCK);
    trabajoExtraFindMany.mockResolvedValue(TRABAJOS_EXTRA_MOCK);
    hallazgoFindMany.mockResolvedValue(HALLAZGOS_MOCK);
    ordenFindMany.mockResolvedValue(ORDENES_MOCK);
    actividadFindMany.mockResolvedValue(ACTIVIDADES_MOCK);

    combustibleCount.mockResolvedValue(COMBUSTIBLES_MOCK.length);
    horometroCount.mockResolvedValue(HOROMETROS_MOCK.length);
    trabajoExtraCount.mockResolvedValue(TRABAJOS_EXTRA_MOCK.length);
    // El servicio llama hallazgo.count dos veces en orden: total, luego
    // abiertos (estado !== 'CERRADO') — solo 'ha1' está ABIERTO.
    hallazgoCount
      .mockResolvedValueOnce(HALLAZGOS_MOCK.length)
      .mockResolvedValueOnce(1);
    // Idem ordenTrabajo.count: total, luego abiertas — solo 'ot1' está PENDIENTE.
    ordenCount
      .mockResolvedValueOnce(ORDENES_MOCK.length)
      .mockResolvedValueOnce(1);
    actividadCount.mockResolvedValue(ACTIVIDADES_MOCK.length);
  }

  function mockearOrigenesVacios(): void {
    equipoFindUnique.mockResolvedValue(EQUIPO_MOCK);
    combustibleFindMany.mockResolvedValue([]);
    horometroFindMany.mockResolvedValue([]);
    trabajoExtraFindMany.mockResolvedValue([]);
    hallazgoFindMany.mockResolvedValue([]);
    ordenFindMany.mockResolvedValue([]);
    actividadFindMany.mockResolvedValue([]);

    combustibleCount.mockResolvedValue(0);
    horometroCount.mockResolvedValue(0);
    trabajoExtraCount.mockResolvedValue(0);
    hallazgoCount.mockResolvedValue(0);
    ordenCount.mockResolvedValue(0);
    actividadCount.mockResolvedValue(0);
  }

  it('agrega los eventos de todos los orígenes en un solo timeline', async () => {
    mockearOrigenesConDatos();

    const ficha = await service.getFichaEquipo('eq_1');

    // 1 combustible + 1 horómetro + 1 trabajo extra + 2 hallazgos + 2 órdenes
    // + 1 intervención (de ot1) + 1 actividad = 9
    expect(ficha.timeline).toHaveLength(9);
    const tipos = ficha.timeline.map((e) => e.tipo).sort();
    expect(tipos).toEqual(
      [
        'COMBUSTIBLE',
        'HOROMETRO',
        'TRABAJO_EXTRA',
        'HALLAZGO',
        'HALLAZGO',
        'ORDEN_TRABAJO',
        'ORDEN_TRABAJO',
        'INTERVENCION',
        'ACTIVIDAD',
      ].sort(),
    );
  });

  it('ordena el timeline por fecha descendente', async () => {
    mockearOrigenesConDatos();

    const ficha = await service.getFichaEquipo('eq_1');

    // La intervención (2026-08-03T11:00) es el evento más reciente; la OT
    // "Reparación motor" (createdAt 2026-06-01) es el más antiguo.
    expect(ficha.timeline[0].id).toBe('iv1');
    expect(ficha.timeline[ficha.timeline.length - 1].id).toBe('ot2');

    const fechas = ficha.timeline.map((e) => new Date(e.fecha).getTime());
    const fechasOrdenadas = [...fechas].sort((a, b) => b - a);
    expect(fechas).toEqual(fechasOrdenadas);
  });

  it('calcula los contadores del resumen, incluidos los abiertos', async () => {
    mockearOrigenesConDatos();

    const ficha = await service.getFichaEquipo('eq_1');

    expect(ficha.resumen).toEqual({
      combustibles: 1,
      horometros: 1,
      trabajosExtra: 1,
      hallazgos: 2,
      hallazgosAbiertos: 1, // solo 'ha1' (ABIERTO); 'ha2' está CERRADO
      ordenes: 2,
      ordenesAbiertas: 1, // solo 'ot1' (PENDIENTE); 'ot2' está COMPLETADA
      actividades: 1,
    });
  });

  it('lanza NotFoundException cuando el equipo no existe', async () => {
    mockearOrigenesVacios();
    equipoFindUnique.mockResolvedValue(null);

    await expect(service.getFichaEquipo('missing')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('equipo existente sin eventos devuelve timeline y resumen vacíos', async () => {
    mockearOrigenesVacios();

    const ficha = await service.getFichaEquipo('eq_1');

    expect(ficha.timeline).toEqual([]);
    expect(ficha.resumen).toEqual({
      combustibles: 0,
      horometros: 0,
      trabajosExtra: 0,
      hallazgos: 0,
      hallazgosAbiertos: 0,
      ordenes: 0,
      ordenesAbiertas: 0,
      actividades: 0,
    });
  });
});
