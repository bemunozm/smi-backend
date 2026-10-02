import { Test } from '@nestjs/testing';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { TrabajosExtraService } from './trabajos-extra.service';
import { PrismaService } from '../../common/prisma/prisma.service';
import { ChangeLogService } from '../../change-log/change-log.service';
import { DOMAIN_EVENTS } from '../../common/events/domain-events';

describe('TrabajosExtraService', () => {
  let service: TrabajosExtraService;
  const prisma = {
    equipment: { findUnique: jest.fn() },
    trabajoExtraordinario: {
      create: jest.fn(),
      findUnique: jest.fn(),
      update: jest.fn(),
    },
    // Se mockea para probar que un turno abierto ya NO bloquea el trabajo.
    registroHorometro: { findFirst: jest.fn() },
    // La edición y su registro de cambios van en una sola transacción.
    $transaction: jest.fn(),
  };
  const eventEmitter = { emit: jest.fn() };
  const changeLog = { record: jest.fn(), findFor: jest.fn() };

  beforeEach(async () => {
    const mod = await Test.createTestingModule({
      providers: [
        TrabajosExtraService,
        { provide: PrismaService, useValue: prisma },
        { provide: EventEmitter2, useValue: eventEmitter },
        { provide: ChangeLogService, useValue: changeLog },
      ],
    }).compile();
    service = mod.get(TrabajosExtraService);
    jest.clearAllMocks();
    prisma.equipment.findUnique.mockResolvedValue({
      id: 'e1',
      internalCode: 'CA-011',
    });
    prisma.registroHorometro.findFirst.mockResolvedValue(null);
    prisma.trabajoExtraordinario.create.mockImplementation(
      ({ data }: { data: Record<string, unknown> }) => data,
    );
  });

  it('calcula totalHoras = horometroFinal - horometroInicial', async () => {
    const res = await service.create({
      equipoId: 'e1',
      operador: 'Juan Rojas',
      faena: 'Rajo Norte',
      turno: 'DIURNO',
      horometroInicial: 1200,
      horometroFinal: 1212,
      actividades: ['REGULACION_CARGA'],
      descripcion: 'Carga de material',
    });
    expect(res.totalHoras).toBe(12);
  });

  /**
   * El caso que antes pasaba en silencio: guardaba `totalHoras: 0` y devolvía
   * 201, dejando en la base un trabajo de cero horas indistinguible de uno
   * legítimo. Estas horas respaldan un cobro, así que el registro tiene que
   * fallar, no inventar un cero.
   */
  it('rechaza el horómetro final menor que el inicial en vez de guardar cero', async () => {
    const invertido = {
      equipoId: 'e1',
      operador: 'Juan Rojas',
      faena: 'Patillo',
      turno: 'NOCTURNO',
      horometroInicial: 5400,
      horometroFinal: 5388,
      actividades: ['HACER_PETRIL'],
      descripcion: 'Horómetro tipeado al revés',
    };

    await expect(service.create(invertido)).rejects.toThrow(
      /no puede ser menor/,
    );
    expect(prisma.trabajoExtraordinario.create).not.toHaveBeenCalled();
  });

  /** Un trabajo que de verdad duró cero sí se guarda: el rechazo es por menor, no por igual. */
  it('acepta inicial y final iguales', async () => {
    const res = await service.create({
      equipoId: 'e1',
      operador: 'Juan Rojas',
      faena: 'Kainita',
      turno: 'DIURNO',
      horometroInicial: 900,
      horometroFinal: 900,
      actividades: ['LIMPIEZA_CANCHA'],
      descripcion: 'Se canceló antes de empezar',
    });
    expect(res.totalHoras).toBe(0);
  });

  describe('actividades', () => {
    const trabajo = {
      equipoId: 'e1',
      operador: 'Juan Rojas',
      faena: 'Patillo',
      turno: 'DIURNO' as const,
      horometroInicial: 1200,
      horometroFinal: 1212,
      descripcion: 'Carga de material',
    };

    it('guarda varias actividades en un mismo trabajo', async () => {
      const res = await service.create({
        ...trabajo,
        actividades: ['SOLTAR_MATERIAL', 'LIMPIEZA_CANCHA'],
      });
      expect(res.actividades).toEqual(['SOLTAR_MATERIAL', 'LIMPIEZA_CANCHA']);
      expect(res.otraActividad).toBeNull();
    });

    /**
     * «Otro» sin texto deja la actividad registrada como «otro» a secas: el
     * trabajo no se podría justificar ni cobrar.
     */
    it('exige el texto cuando se elige Otro', async () => {
      await expect(
        service.create({ ...trabajo, actividades: ['OTRO'] }),
      ).rejects.toThrow(/describí cuál fue/);
      expect(prisma.trabajoExtraordinario.create).not.toHaveBeenCalled();
    });

    it('guarda el texto de Otro junto a las demás actividades', async () => {
      const res = await service.create({
        ...trabajo,
        actividades: ['HACER_PETRIL', 'OTRO'],
        otraActividad: '  Despeje de acceso a romana  ',
      });
      expect(res.otraActividad).toBe('Despeje de acceso a romana');
    });

    /** Un texto sin haber elegido «Otro» contradiría la lista: se descarta. */
    it('descarta el texto si no se eligió Otro', async () => {
      const res = await service.create({
        ...trabajo,
        actividades: ['HACER_PETRIL'],
        otraActividad: 'texto huérfano',
      });
      expect(res.otraActividad).toBeNull();
    });
  });
  /**
   * Acta N.° 004, punto 4: el trabajo extraordinario usa la misma máquina
   * del turno, que tiene tiempos en ralentí. Antes esto se rechazaba; un
   * equipo con turno abierto ahora tiene que poder registrar su trabajo.
   */
  it('acepta el trabajo aunque el equipo tenga un turno en curso', async () => {
    prisma.registroHorometro.findFirst.mockResolvedValue({ id: 'h1' });

    const res = await service.create({
      equipoId: 'e1',
      operador: 'Juan Rojas',
      faena: 'Patillo',
      turno: 'DIURNO',
      horometroInicial: 1200,
      horometroFinal: 1212,
      actividades: ['REGULACION_CARGA'],
      descripcion: 'Carga de material',
    });

    expect(prisma.trabajoExtraordinario.create).toHaveBeenCalled();
    expect(res.equipoId).toBe('e1');
  });

  /**
   * Acta N.° 004, R13: un trabajo ya registrado se edita sin autorización,
   * pero cada cambio queda registrado (quién, qué dato, antes y después) y
   * se le avisa al administrador.
   */
  describe('update', () => {
    const editor = { id: 'u1', name: 'Limbert Villacorta' };
    const guardado = {
      id: 't1',
      equipoId: 'e1',
      equipo: { internalCode: 'CA-011' },
      operador: 'Juan Rojas',
      faena: 'Patillo',
      turno: 'DIURNO',
      horometroInicial: 1200,
      horometroFinal: 1212,
      totalHoras: 12,
      actividades: ['REGULACION_CARGA'],
      otraActividad: null,
      descripcion: 'Carga de material',
      observaciones: null,
      fecha: new Date(2026, 9, 1, 10, 0),
    };

    beforeEach(() => {
      prisma.trabajoExtraordinario.findUnique.mockResolvedValue(guardado);
      prisma.trabajoExtraordinario.update.mockImplementation(
        ({ data }: { data: Record<string, unknown> }) => ({
          ...guardado,
          ...data,
        }),
      );
      prisma.$transaction.mockImplementation(
        (fn: (tx: typeof prisma) => unknown) => fn(prisma),
      );
    });

    it('guarda el cambio, recalcula las horas y lo registra con su antes y después', async () => {
      const res = await service.update(
        't1',
        { horometroFinal: 1214.5 },
        editor,
      );

      expect(res.totalHoras).toBe(14.5);
      expect(changeLog.record).toHaveBeenCalledWith(
        prisma,
        'trabajo_extra',
        't1',
        editor,
        [
          {
            field: 'horometroFinal',
            label: 'Horómetro final',
            before: '1.212 h',
            after: '1.214,5 h',
          },
        ],
      );
    });

    it('avisa al administrador quién cambió qué', async () => {
      await service.update('t1', { operador: 'Pedro Soto' }, editor);

      expect(eventEmitter.emit).toHaveBeenCalledWith(
        DOMAIN_EVENTS.RECORD_EDITED,
        expect.objectContaining({
          entity: 'trabajo_extra',
          entityId: 't1',
          editedBy: 'Limbert Villacorta',
          changes: [
            { label: 'Operador', before: 'Juan Rojas', after: 'Pedro Soto' },
          ],
        }),
      );
    });

    /** El aviso dice el código del equipo, no su id interno. */
    it('registra el cambio de equipo con sus códigos', async () => {
      prisma.equipment.findUnique.mockResolvedValue({
        id: 'e2',
        internalCode: 'CM-003',
      });

      await service.update('t1', { equipoId: 'e2' }, editor);

      const llamada = changeLog.record.mock.calls[0] as unknown[];
      const cambios = llamada[4] as { before: string; after: string }[];
      expect(cambios).toEqual([
        expect.objectContaining({
          label: 'Equipo',
          before: 'CA-011',
          after: 'CM-003',
        }),
      ]);
    });

    /** Las reglas se aplican al registro combinado, no solo a lo que vino. */
    it('rechaza un final menor que el inicial ya guardado', async () => {
      await expect(
        service.update('t1', { horometroFinal: 1100 }, editor),
      ).rejects.toThrow(/no puede ser menor/);
      expect(prisma.$transaction).not.toHaveBeenCalled();
      expect(eventEmitter.emit).not.toHaveBeenCalled();
    });

    /** Guardar sin cambiar nada no es un cambio: no se registra ni se avisa. */
    it('no registra ni avisa si nada cambió', async () => {
      await service.update('t1', { operador: 'Juan Rojas' }, editor);

      expect(prisma.$transaction).not.toHaveBeenCalled();
      expect(changeLog.record).not.toHaveBeenCalled();
      expect(eventEmitter.emit).not.toHaveBeenCalled();
    });
  });
});
