import { Injectable, NotFoundException } from '@nestjs/common';

import type { Prisma } from '@prisma/client';

import { createOrReturn } from '../../common/idempotency/create-or-return';
import { PrismaService } from '../../common/prisma/prisma.service';
import { StorageService } from '../../storage/storage.service';
import { CreateCombustibleDto } from './dto/create-combustible.dto';
import { UpdateCombustibleDto } from './dto/update-combustible.dto';

/** Un registro tal como sale a la API: sin `createdById`. */
type RegistroCombustibleRow = Omit<
  Prisma.RegistroCombustibleGetPayload<object>,
  'createdById'
>;

/** Forma de un registro en la API — nunca expone `fotoKey`:
 * `fotoUrl` es la key firmada cuando existe
 * `fotoKey`, o el valor legacy tal cual si el registro no tiene `fotoKey`. */
export type CombustibleResponse<T> = Omit<T, 'fotoKey'> & {
  fotoUrl: string | null;
};

@Injectable()
export class CombustibleService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
  ) {}

  async create(dto: CreateCombustibleDto, userId: string) {
    return createOrReturn({
      id: dto.id,
      userId,
      conflictMessage: 'Ya existe una carga con ese id de otro usuario',
      // El reintento propio devuelve la carga con su foto firmada de nuevo; no
      // reclama la key tmp ni toca nada.
      findExisting: async (id) => {
        const existing = await this.prisma.registroCombustible.findUnique({
          where: { id },
          omit: { createdById: false },
        });
        if (!existing) return null;
        const { createdById, ...registro } = existing;
        return { ownerId: createdById, result: () => this.shape(registro) };
      },
      create: () => this.createFresh(dto, userId),
    });
  }

  private async createFresh(dto: CreateCombustibleDto, userId: string) {
    const equipo = await this.prisma.equipment.findUnique({
      where: { id: dto.equipoId },
    });
    if (!equipo) throw new NotFoundException('Equipo no encontrado');

    // Reclama ANTES del `create` (fuera del try) — igual que
    // `EquipmentService.create`: si el claim falla no hay nada que revertir.
    const finalKey = dto.fotoKey
      ? await this.storage.claimTmp(dto.fotoKey, userId, 'fuel-photo')
      : undefined;

    // El `try/catch` cubre SOLO la escritura en Prisma (mismo patrón que
    // `EquipmentService.create`):
    // antes acá `return this.shape(registro)` SIN `await` dentro del try
    // hacía que el rollback nunca se disparara igual por accidente — se deja
    // explícito para no depender de ese detalle.
    let registro: RegistroCombustibleRow;
    try {
      registro = await this.prisma.registroCombustible.create({
        data: {
          ...(dto.id ? { id: dto.id } : {}),
          createdById: userId,
          equipoId: dto.equipoId,
          litros: dto.litros,
          tipo: dto.tipo,
          // `fotoUrl` (legacy) no es un campo de creación — ver
          // `CreateCombustibleDto`. Se omite la key: Prisma inserta NULL
          // (siempre `null` para filas nuevas).
          fotoKey: finalKey ?? null,
          // Sin `fecha` en el DTO, se omite la key y Prisma aplica el
          // `@default(now())` del schema — comportamiento previo intacto.
          ...(dto.fecha ? { fecha: new Date(dto.fecha) } : {}),
        },
      });
    } catch (error: unknown) {
      // Se descarta ANTES de que `createOrReturn` relea la carrera: la copia
      // del perdedor no queda en el bucket, la fila ganadora conserva la suya.
      if (finalKey) {
        await this.storage.discard(finalKey);
      }
      throw error;
    }

    return this.shape(registro);
  }

  async findAll() {
    const registros = await this.prisma.registroCombustible.findMany({
      orderBy: { fecha: 'desc' },
      include: { equipo: { select: { internalCode: true } } },
    });
    return Promise.all(registros.map((registro) => this.shape(registro)));
  }

  async findOne(id: string) {
    const reg = await this.prisma.registroCombustible.findUnique({
      where: { id },
    });
    if (!reg) throw new NotFoundException('Registro no encontrado');
    return this.shape(reg);
  }

  async update(id: string, dto: UpdateCombustibleDto) {
    const registro = await this.prisma.registroCombustible.update({
      where: { id },
      data: dto,
    });
    return this.shape(registro);
  }

  /**
   * Nunca devuelve `fotoKey` — solo `fotoUrl`, firmada cuando el registro
   * tiene `fotoKey` (subida nueva por R2/MinIO) o el valor legacy tal cual
   * (subida vieja por `/api/uploads`, Terreno sigue usándola). Genérico
   * sobre `T` para preservar cualquier otro campo que traiga la fila cruda
   * (ej. el `equipo: {internalCode}` de `findAll`), sin tener que listarlos
   * a mano y arriesgarse a que la vista de Terreno pierda un campo.
   */
  private async shape<
    T extends { fotoUrl: string | null; fotoKey: string | null },
  >(registro: T): Promise<CombustibleResponse<T>> {
    const { fotoKey, fotoUrl, ...resto } = registro;
    return {
      ...resto,
      fotoUrl: fotoKey ? await this.storage.sign(fotoKey) : fotoUrl,
    } as CombustibleResponse<T>;
  }
}
