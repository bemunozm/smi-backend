import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';

import { CreateTrabajoExtraDto } from './create-trabajo-extra.dto';

function base(overrides: Record<string, unknown> = {}) {
  return {
    equipoId: 'e1',
    operatorId: 'op1',
    faena: 'Faena Norte',
    turno: 'DIURNO',
    horometroInicial: 100,
    horometroFinal: 108.5,
    actividades: ['LIMPIEZA_CANCHA'],
    descripcion: 'Limpieza de cancha tras turno',
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

  describe('turno', () => {
    it('rechaza un valor fuera de DIURNO/NOCTURNO', async () => {
      const dto = plainToInstance(
        CreateTrabajoExtraDto,
        base({ turno: 'VESPERTINO' }),
      );
      expect(await validate(dto)).not.toHaveLength(0);
    });
  });
});
