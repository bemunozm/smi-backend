import { ConflictException, NotFoundException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { TrabajosExtraService } from './trabajos-extra.service';
import { PrismaService } from '../../common/prisma/prisma.service';
import { OperatorsService } from '../../operators/operators.service';
import { CreateTrabajoExtraDto } from './dto/create-trabajo-extra.dto';

describe('TrabajosExtraService', () => {
  let service: TrabajosExtraService;
  const prisma = {
    equipment: { findUnique: jest.fn() },
    trabajoExtraordinario: { create: jest.fn() },
    // Un equipo con turno en curso está ocupado y no admite trabajos extra.
    registroHorometro: { findFirst: jest.fn() },
  };
  const assertActive = jest.fn();

  beforeEach(async () => {
    const mod = await Test.createTestingModule({
      providers: [
        TrabajosExtraService,
        { provide: PrismaService, useValue: prisma },
        { provide: OperatorsService, useValue: { assertActive } },
      ],
    }).compile();
    service = mod.get(TrabajosExtraService);
    jest.clearAllMocks();
    prisma.equipment.findUnique.mockResolvedValue({
      id: 'e1',
      internalCode: 'CA-011',
    });
    // Por defecto el equipo está libre: sin turno en curso.
    prisma.registroHorometro.findFirst.mockResolvedValue(null);
    prisma.trabajoExtraordinario.create.mockImplementation(
      ({ data }: { data: Record<string, unknown> }) => data,
    );
    // Operador del catálogo por defecto — activo. Los tests de
    // operatorId/OPERATOR_INACTIVE sobreescriben esto.
    assertActive.mockResolvedValue({
      id: 'op_1',
      name: 'Juan Rojas',
      isActive: true,
    });
  });

  it('calcula totalHoras = horometroFinal - horometroInicial', async () => {
    const res = await service.create({
      equipoId: 'e1',
      operatorId: 'op_1',
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
      operatorId: 'op_1',
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
      operatorId: 'op_1',
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
      operatorId: 'op_1',
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
   * Un equipo con turno en curso está ocupado. Las horas del trabajo
   * extraordinario y las del turno se facturan por separado, y mientras el
   * turno siga abierto no se sabe cuáles serán sus horas — las del trabajo
   * podrían terminar contadas dos veces.
   */
  it('rechaza el trabajo si el equipo tiene un turno en curso', async () => {
    prisma.registroHorometro.findFirst.mockResolvedValue({ id: 'h1' });

    await expect(
      service.create({
        equipoId: 'e1',
        operatorId: 'op_1',
        faena: 'Patillo',
        turno: 'DIURNO',
        horometroInicial: 1200,
        horometroFinal: 1212,
        actividades: ['REGULACION_CARGA'],
        descripcion: 'Carga de material',
      }),
    ).rejects.toThrow(/tiene un turno en curso/);
    expect(prisma.trabajoExtraordinario.create).not.toHaveBeenCalled();
  });

  it('lanza NotFoundException si el equipo no existe', async () => {
    prisma.equipment.findUnique.mockResolvedValue(null);

    await expect(
      service.create({
        equipoId: 'missing',
        operatorId: 'op_1',
        faena: 'Patillo',
        turno: 'DIURNO',
        horometroInicial: 1200,
        horometroFinal: 1212,
        actividades: ['REGULACION_CARGA'],
        descripcion: 'Carga de material',
      }),
    ).rejects.toBeInstanceOf(NotFoundException);

    // El equipo se chequea ANTES que el operador (precondición más barata
    // primero): con equipo inexistente, ni siquiera se llega a validar el
    // operador.
    expect(assertActive).not.toHaveBeenCalled();
    expect(prisma.trabajoExtraordinario.create).not.toHaveBeenCalled();
  });

  // RFC Supervisión en Terreno, Anexo 2 ("operador del catálogo en Trabajos
  // extra + snapshot único"): `operador` sale del DTO — el cliente manda
  // solo `operatorId`, y el servidor arma el snapshot desde el catálogo.
  describe('operatorId (catálogo)', () => {
    it('valida el operador vía OperatorsService.assertActive y arma el snapshot desde el catálogo', async () => {
      assertActive.mockResolvedValue({
        id: 'op_9',
        name: 'Patricio Rojas',
        isActive: true,
      });

      const res = await service.create({
        equipoId: 'e1',
        operatorId: 'op_9',
        faena: 'Rajo Norte',
        turno: 'DIURNO',
        horometroInicial: 1200,
        horometroFinal: 1212,
        actividades: ['REGULACION_CARGA'],
        descripcion: 'Carga de material',
      });

      expect(assertActive).toHaveBeenCalledWith('op_9');
      // El snapshot viene SIEMPRE del catálogo (`operator.name`), nunca de
      // texto que hubiera mandado el cliente — el DTO ni siquiera tiene un
      // campo `operador` que pudiera contradecirlo.
      expect(res.operador).toBe('Patricio Rojas');
      expect(res.operatorId).toBe('op_9');
    });

    it('propaga el 404 si el operador no existe, sin llegar a las reglas de turno/horómetro', async () => {
      assertActive.mockRejectedValue(
        new NotFoundException('Operador "op_missing" no encontrado'),
      );

      await expect(
        service.create({
          equipoId: 'e1',
          operatorId: 'op_missing',
          faena: 'Rajo Norte',
          turno: 'DIURNO',
          horometroInicial: 1200,
          horometroFinal: 1212,
          actividades: ['REGULACION_CARGA'],
          descripcion: 'Carga de material',
        }),
      ).rejects.toBeInstanceOf(NotFoundException);

      // Falla rápido: ni siquiera se llega a consultar si el equipo tiene
      // turno en curso.
      expect(prisma.registroHorometro.findFirst).not.toHaveBeenCalled();
      expect(prisma.trabajoExtraordinario.create).not.toHaveBeenCalled();
    });

    it('propaga el 409 OPERATOR_INACTIVE si el operador existe pero está dado de baja', async () => {
      assertActive.mockRejectedValue(
        new ConflictException({
          message: 'El operador "Juan Rojas" está inactivo',
          code: 'OPERATOR_INACTIVE',
        }),
      );

      expect.assertions(3);
      try {
        await service.create({
          equipoId: 'e1',
          operatorId: 'op_1',
          faena: 'Rajo Norte',
          turno: 'DIURNO',
          horometroInicial: 1200,
          horometroFinal: 1212,
          actividades: ['REGULACION_CARGA'],
          descripcion: 'Carga de material',
        });
      } catch (error: unknown) {
        expect(error).toBeInstanceOf(ConflictException);
        expect((error as ConflictException).getResponse()).toMatchObject({
          code: 'OPERATOR_INACTIVE',
        });
        expect(prisma.trabajoExtraordinario.create).not.toHaveBeenCalled();
      }
    });
  });
});

// O2-equivalente para Trabajos extra: `operatorId` es obligatorio y
// `operador` sale del DTO — con `forbidNonWhitelisted: true` global, mandar
// `operador` en el body es un 400. Mismo patrón que el bloque
// `CreateHorometroDto — límites` de `horometro.service.spec.ts`.
describe('CreateTrabajoExtraDto — operatorId obligatorio, operador fuera del DTO', () => {
  const base = {
    equipoId: 'e1',
    operatorId: 'op_1',
    faena: 'Rajo Norte',
    turno: 'DIURNO',
    horometroInicial: 1200,
    horometroFinal: 1212,
    actividades: ['REGULACION_CARGA'],
    descripcion: 'Carga de material',
  };

  it('acepta el body con operatorId', async () => {
    const dto = plainToInstance(CreateTrabajoExtraDto, base);
    expect(await validate(dto)).toHaveLength(0);
  });

  it('rechaza si falta operatorId', async () => {
    const dto = plainToInstance(CreateTrabajoExtraDto, {
      equipoId: base.equipoId,
      faena: base.faena,
      turno: base.turno,
      horometroInicial: base.horometroInicial,
      horometroFinal: base.horometroFinal,
      actividades: base.actividades,
      descripcion: base.descripcion,
    });
    expect(await validate(dto)).not.toHaveLength(0);
  });

  it('rechaza operatorId vacío', async () => {
    const dto = plainToInstance(CreateTrabajoExtraDto, {
      ...base,
      operatorId: '',
    });
    expect(await validate(dto)).not.toHaveLength(0);
  });

  it('rechaza el body si manda operador — forbidNonWhitelisted lo tumba', async () => {
    const dto = plainToInstance(CreateTrabajoExtraDto, {
      ...base,
      operador: 'Juan Rojas',
    });
    const errors = await validate(dto, {
      whitelist: true,
      forbidNonWhitelisted: true,
    });
    expect(errors.length).toBeGreaterThan(0);
  });
});
