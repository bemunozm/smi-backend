import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';

import { CreateTrabajoExtraDto } from './create-trabajo-extra.dto';
import { UpdateTrabajoExtraDto } from './update-trabajo-extra.dto';

function base(overrides: Record<string, unknown> = {}) {
  return {
    equipoId: 'e1',
    operatorId: 'op1',
    faena: 'Faena Norte',
    turno: 'DIURNO',
    horometroInicial: 100,
    horometroFinal: 108.5,
    detalle: [{ actividad: 'LIMPIEZA_CANCHA', lugar: 'TRANSPORTE', horas: 2 }],
    descripcion: 'Limpieza de cancha tras turno',
    reportNumero: '4509',
    fotoKey: 'tmp/u1/report.jpg',
    ...overrides,
  };
}

describe('CreateTrabajoExtraDto', () => {
  it('acepta un body válido', async () => {
    const dto = plainToInstance(CreateTrabajoExtraDto, base());
    expect(await validate(dto)).toHaveLength(0);
  });

  describe('horometroInicial/horometroFinal — límites', () => {
    it.each(['horometroInicial', 'horometroFinal'])(
      '%s rechaza negativo',
      async (field) => {
        const dto = plainToInstance(
          CreateTrabajoExtraDto,
          base({ [field]: -1 }),
        );
        expect(await validate(dto)).not.toHaveLength(0);
      },
    );

    it.each(['horometroInicial', 'horometroFinal'])(
      '%s acepta el máximo (1_000_000)',
      async (field) => {
        const dto = plainToInstance(
          CreateTrabajoExtraDto,
          base({ [field]: 1_000_000 }),
        );
        expect(await validate(dto)).toHaveLength(0);
      },
    );

    it.each(['horometroInicial', 'horometroFinal'])(
      '%s rechaza por encima del máximo',
      async (field) => {
        const dto = plainToInstance(
          CreateTrabajoExtraDto,
          base({ [field]: 1_000_001 }),
        );
        expect(await validate(dto)).not.toHaveLength(0);
      },
    );

    it.each(['horometroInicial', 'horometroFinal'])(
      '%s rechaza NaN e Infinity',
      async (field) => {
        const nanDto = plainToInstance(
          CreateTrabajoExtraDto,
          base({ [field]: NaN }),
        );
        const infDto = plainToInstance(
          CreateTrabajoExtraDto,
          base({ [field]: Infinity }),
        );
        expect(await validate(nanDto)).not.toHaveLength(0);
        expect(await validate(infDto)).not.toHaveLength(0);
      },
    );
  });

  describe('observaciones — normalización + límite', () => {
    it('normaliza CRLF y colapsa saltos de línea antes de validar', async () => {
      const dto = plainToInstance(
        CreateTrabajoExtraDto,
        base({ observaciones: '  linea1\r\n\r\n\r\nlinea2  ' }),
      );
      expect(dto.observaciones).toBe('linea1\n\nlinea2');
      expect(await validate(dto)).toHaveLength(0);
    });

    it('acepta hasta 1000 caracteres (ya normalizados)', async () => {
      const dto = plainToInstance(
        CreateTrabajoExtraDto,
        base({ observaciones: 'a'.repeat(1000) }),
      );
      expect(await validate(dto)).toHaveLength(0);
    });

    it('rechaza más de 1000 caracteres', async () => {
      const dto = plainToInstance(
        CreateTrabajoExtraDto,
        base({ observaciones: 'a'.repeat(1001) }),
      );
      expect(await validate(dto)).not.toHaveLength(0);
    });

    it('es opcional', async () => {
      const dto = plainToInstance(CreateTrabajoExtraDto, base());
      expect(await validate(dto)).toHaveLength(0);
    });
  });

  describe('descripcion/faena — tope de longitud', () => {
    it('descripcion rechaza más de 1000 caracteres', async () => {
      const dto = plainToInstance(
        CreateTrabajoExtraDto,
        base({ descripcion: 'a'.repeat(1001) }),
      );
      expect(await validate(dto)).not.toHaveLength(0);
    });

    it('faena rechaza más de 100 caracteres', async () => {
      const dto = plainToInstance(
        CreateTrabajoExtraDto,
        base({ faena: 'a'.repeat(101) }),
      );
      expect(await validate(dto)).not.toHaveLength(0);
    });

    it('faena acepta el máximo (100)', async () => {
      const dto = plainToInstance(
        CreateTrabajoExtraDto,
        base({ faena: 'a'.repeat(100) }),
      );
      expect(await validate(dto)).toHaveLength(0);
    });
  });

  describe('fecha — registro de días pasados', () => {
    it('acepta una fecha date-only válida', async () => {
      const dto = plainToInstance(
        CreateTrabajoExtraDto,
        base({ fecha: '2026-10-15' }),
      );
      expect(await validate(dto)).toHaveLength(0);
    });

    it('rechaza un formato que no es YYYY-MM-DD', async () => {
      const dto = plainToInstance(
        CreateTrabajoExtraDto,
        base({ fecha: '15-10-2026' }),
      );
      expect(await validate(dto)).not.toHaveLength(0);
    });
  });

  describe('turno', () => {
    it('rechaza un valor fuera de DIURNO/NOCTURNO', async () => {
      const dto = plainToInstance(
        CreateTrabajoExtraDto,
        base({ turno: 'VESPERTINO' }),
      );
      expect(await validate(dto)).not.toHaveLength(0);
    });
  });

  /**
   * El N° de Report lo asigna la base (`numero`, autoincrement): el cliente no
   * lo elige al crear ni lo cambia al editar. Con `forbidNonWhitelisted` (la
   * misma config que `app.setup.ts`) mandarlo es un 400.
   */
  describe('numero — lo asigna la base, nunca el usuario', () => {
    const estricto = { whitelist: true, forbidNonWhitelisted: true };

    it('al crear, mandar un número se rechaza', async () => {
      const dto = plainToInstance(CreateTrabajoExtraDto, base({ numero: 999 }));
      const errores = await validate(dto, estricto);
      expect(errores.map((e) => e.property)).toContain('numero');
    });

    it('al editar, cambiar el número se rechaza', async () => {
      const dto = plainToInstance(UpdateTrabajoExtraDto, { numero: 1 });
      const errores = await validate(dto, estricto);
      expect(errores.map((e) => e.property)).toContain('numero');
    });
  });
});

describe('CreateTrabajoExtraDto — report nulo', () => {
  /** Lo mínimo de un nulo: N°, foto, faena y turno (fecha opcional). */
  const nulo = (overrides: Record<string, unknown> = {}) => ({
    nulo: true,
    faena: 'Patillo',
    turno: 'DIURNO',
    reportNumero: '4510',
    fotoKey: 'tmp/u1/nulo.jpg',
    fecha: '2026-11-20',
    ...overrides,
  });
  const errores = async (body: Record<string, unknown>) =>
    (await validate(plainToInstance(CreateTrabajoExtraDto, body))).map(
      (e) => e.property,
    );

  it('acepta solo N°, fecha y foto (sin equipo, operador, horómetros ni actividades)', async () => {
    expect(await errores(nulo())).toEqual([]);
  });

  it('acepta equipo, operador y motivo opcionales', async () => {
    expect(
      await errores(
        nulo({ equipoId: 'e1', operatorId: 'op1', descripcion: 'Tachado' }),
      ),
    ).toEqual([]);
  });

  it('exige la foto y el N° igual que un Report normal', async () => {
    expect(await errores(nulo({ fotoKey: undefined }))).toContain('fotoKey');
    expect(await errores(nulo({ fotoKey: '' }))).toContain('fotoKey');
    expect(await errores(nulo({ reportNumero: '' }))).toContain('reportNumero');
    expect(await errores(nulo({ reportNumero: '45A' }))).toContain(
      'reportNumero',
    );
  });

  it.each([
    ['horometroInicial', 0],
    ['horometroFinal', 10],
    [
      'detalle',
      [{ actividad: 'LIMPIEZA_CANCHA', lugar: 'TRANSPORTE', horas: 1 }],
    ],
    ['otraActividad', 'algo'],
  ])('rechaza %s en un nulo', async (campo, valor) => {
    const dto = plainToInstance(
      CreateTrabajoExtraDto,
      nulo({ [campo]: valor }),
    );
    const res = await validate(dto);
    const delNulo = res.find((e) => e.property === 'nulo');
    expect(delNulo?.constraints).toMatchObject({
      nuloSinTrabajo: 'Un report nulo no lleva horómetros ni actividades.',
    });
  });

  it('un operador vacío en un nulo se rechaza (si viene, se valida)', async () => {
    expect(await errores(nulo({ operatorId: '' }))).toContain('operatorId');
  });

  it('`nulo` no booleano → error', async () => {
    expect(await errores(nulo({ nulo: 'si' }))).toContain('nulo');
  });

  it('sin `nulo` (o en false) sigue exigiendo todo lo de un Report normal', async () => {
    for (const body of [
      { ...nulo(), nulo: undefined },
      { ...nulo(), nulo: false },
    ]) {
      const props = await errores(body);
      expect(props).toEqual(
        expect.arrayContaining([
          'equipoId',
          'operatorId',
          'horometroInicial',
          'horometroFinal',
          'detalle',
          'descripcion',
        ]),
      );
    }
  });
});
