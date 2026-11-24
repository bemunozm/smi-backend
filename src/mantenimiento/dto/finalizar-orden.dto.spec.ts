import 'reflect-metadata';

import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';

import { CreateIntervencionDto } from './create-intervencion.dto';
import { FinalizarOrdenDto } from './finalizar-orden.dto';

const ID = '7f1c2a3b-4d5e-4f60-8a71-9b8c7d6e5f40';

function base(overrides: Record<string, unknown> = {}) {
  return {
    id: ID,
    tipo: 'PREVENTIVA',
    detalle: 'Cambio de aceite y filtros',
    ...overrides,
  };
}

const errores = async (body: Record<string, unknown>) =>
  (await validate(plainToInstance(FinalizarOrdenDto, body))).map(
    (e) => e.property,
  );

describe('FinalizarOrdenDto', () => {
  it('acepta un cierre completo', async () => {
    expect(
      await errores(
        base({
          horasHombre: 2,
          horometro: 1_250,
          fotoKey: 'tmp/u1/foto.jpg',
          branchId: 'faena',
          insumos: [{ insumoId: 'item_1', cantidad: 2 }],
          equipmentStatus: 'OPERATIONAL',
          lecturaMantencion: 1_240,
        }),
      ),
    ).toEqual([]);
  });

  it('el id es obligatorio (clave de idempotencia) y debe ser UUID v4', async () => {
    expect(await errores(base({ id: undefined }))).toEqual(['id']);
    expect(await errores(base({ id: 'no-es-uuid' }))).toEqual(['id']);
  });

  it('valida la lectura y el estado del equipo como el PATCH de la orden', async () => {
    expect(await errores(base({ lecturaMantencion: -1 }))).toEqual([
      'lecturaMantencion',
    ]);
    expect(await errores(base({ lecturaMantencion: 1_000_001 }))).toEqual([
      'lecturaMantencion',
    ]);
    expect(await errores(base({ equipmentStatus: 'ROTO' }))).toEqual([
      'equipmentStatus',
    ]);
  });

  it('valida los campos de la intervención (insumos anidados)', async () => {
    expect(await errores(base({ detalle: '' }))).toEqual(['detalle']);
    expect(
      await errores(base({ insumos: [{ insumoId: 'x', cantidad: 0 }] })),
    ).toEqual(['insumos']);
  });

  it('el alta suelta de intervenciones sigue aceptando el id opcional', async () => {
    const dto = plainToInstance(CreateIntervencionDto, {
      tipo: 'CORRECTIVA',
      detalle: 'x',
    });
    expect(await validate(dto)).toHaveLength(0);
  });
  it('fotoKeys: hasta 10 keys no vacías; 11 → error', async () => {
    const keys = (n: number) =>
      Array.from({ length: n }, (_, i) => `tmp/u1/${i}.jpg`);
    expect(await errores(base({ fotoKeys: keys(10) }))).toEqual([]);
    expect(await errores(base({ fotoKeys: keys(11) }))).toEqual(['fotoKeys']);
    expect(await errores(base({ fotoKeys: ['tmp/u1/a.jpg', ''] }))).toEqual([
      'fotoKeys',
    ]);
    expect(await errores(base({ fotoKeys: 'tmp/u1/a.jpg' }))).toEqual([
      'fotoKeys',
    ]);
  });

  it('el alta suelta de intervenciones también acepta fotoKeys', async () => {
    const dto = plainToInstance(CreateIntervencionDto, {
      tipo: 'CORRECTIVA',
      detalle: 'x',
      fotoKeys: Array.from({ length: 11 }, (_, i) => `tmp/u1/${i}.jpg`),
    });
    expect((await validate(dto)).map((e) => e.property)).toEqual(['fotoKeys']);
  });
});
