import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';

import { CreateInformeTemporalDto } from './create-informe-temporal.dto';
import { UpdateInformeTemporalDto } from './update-informe-temporal.dto';

function cierre(overrides: Record<string, unknown> = {}) {
  return {
    cardId: 'card1',
    closeClientId: '0b0e2c55-4a5c-4d3e-9b8a-2f6d7e1c9a01',
    valorFinal: 1210,
    fuelLiters: 0,
    capturedAt: '2026-11-24T18:00:00.000Z',
    ...overrides,
  };
}

function base(overrides: Record<string, unknown> = {}) {
  return {
    id: '7c1d2e3f-4a5b-4c6d-8e7f-9a0b1c2d3e4f',
    fecha: '2026-11-24',
    turno: 'DIURNO',
    actividad1: 'Limpieza de cancha',
    personal: [{ actividad: 1, operatorId: 'op1', nombre: 'Juan Rojas' }],
    supervisorResponsable1: 'Pedro Soto',
    fotosEnviadas: true,
    infoSubidaApp: false,
    cierres: [cierre()],
    ...overrides,
  };
}

const estricto = { whitelist: true, forbidNonWhitelisted: true };

describe('CreateInformeTemporalDto', () => {
  it('acepta un body válido', async () => {
    const dto = plainToInstance(CreateInformeTemporalDto, base());
    expect(await validate(dto, estricto)).toHaveLength(0);
  });

  it('rechaza cierres vacío', async () => {
    const dto = plainToInstance(
      CreateInformeTemporalDto,
      base({ cierres: [] }),
    );
    const errores = await validate(dto, estricto);
    expect(errores.map((e) => e.property)).toContain('cierres');
  });

  it('rechaza un turno inválido', async () => {
    const dto = plainToInstance(
      CreateInformeTemporalDto,
      base({ turno: 'VESPERTINO' }),
    );
    const errores = await validate(dto, estricto);
    expect(errores.map((e) => e.property)).toContain('turno');
  });

  it('valida cada cierre anidado (closeClientId no UUID)', async () => {
    const dto = plainToInstance(
      CreateInformeTemporalDto,
      base({ cierres: [cierre({ closeClientId: 'x' })] }),
    );
    const errores = await validate(dto, estricto);
    expect(errores.map((e) => e.property)).toContain('cierres');
  });

  it('rechaza el turno de quien cierra dentro del cierre (no aplica al temporal)', async () => {
    const dto = plainToInstance(
      CreateInformeTemporalDto,
      base({ cierres: [cierre({ shiftDate: '2026-11-24' })] }),
    );
    const errores = await validate(dto, estricto);
    expect(errores.map((e) => e.property)).toContain('cierres');
  });

  it('rechaza personal con actividad distinta de 1 o 2', async () => {
    const dto = plainToInstance(
      CreateInformeTemporalDto,
      base({ personal: [{ actividad: 3, nombre: 'Juan' }] }),
    );
    const errores = await validate(dto, estricto);
    expect(errores.map((e) => e.property)).toContain('personal');
  });

  it('rechaza una fecha que no es YYYY-MM-DD', async () => {
    const dto = plainToInstance(
      CreateInformeTemporalDto,
      base({ fecha: '24-11-2026' }),
    );
    const errores = await validate(dto, estricto);
    expect(errores.map((e) => e.property)).toContain('fecha');
  });
});

describe('textos obligatorios con solo espacios', () => {
  it.each(['actividad1', 'supervisorResponsable1'])(
    'crear: %s con solo espacios se rechaza',
    async (campo) => {
      const dto = plainToInstance(
        CreateInformeTemporalDto,
        base({ [campo]: '   ' }),
      );
      const errores = await validate(dto, estricto);
      expect(errores.map((e) => e.property)).toContain(campo);
    },
  );

  it.each(['actividad1', 'supervisorResponsable1'])(
    'corregir: %s con solo espacios se rechaza',
    async (campo) => {
      const dto = plainToInstance(UpdateInformeTemporalDto, {
        [campo]: ' \t ',
      });
      const errores = await validate(dto, estricto);
      expect(errores.map((e) => e.property)).toContain(campo);
    },
  );

  it('corregir: un texto con espacios alrededor sigue valiendo', async () => {
    const dto = plainToInstance(UpdateInformeTemporalDto, {
      actividad1: '  Limpieza  ',
    });
    expect(await validate(dto, estricto)).toHaveLength(0);
  });
});
