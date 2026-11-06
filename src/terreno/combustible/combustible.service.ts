import { Injectable, NotFoundException } from '@nestjs/common';

import type { Prisma } from '@prisma/client';

import { createOrReturn } from '../../common/idempotency/create-or-return';
import { PrismaService } from '../../common/prisma/prisma.service';
import { StorageService } from '../../storage/storage.service';
import { resolveNombresUsuarios } from '../common/registrado-por.util';
import { CreateCombustibleDto } from './dto/create-combustible.dto';
import { UpdateCombustibleDto } from './dto/update-combustible.dto';

/**
 * Include compartido por TODOS los read paths (`create`/`findAll`/`findOne`/
 * `update`): el outbox offline mete la respuesta del create en la caché del
 * listado (mismo contrato que `TRABAJO_EXTRA_INCLUDE`), así que las formas no
 * pueden divergir. `equipo.internalCode` lo usa la vista de Terreno;
 * `type`/`equipmentClass` y la tarjeta vinculada los usa la vista admin de
 * cargas de combustible.
 */
const COMBUSTIBLE_INCLUDE = {
  equipo: {
    select: { internalCode: true, type: true, equipmentClass: true },
  },
  registroHorometro: {
    select: { closedByName: true, closedById: true, supervisorId: true },
  },
} satisfies Prisma.RegistroCombustibleInclude;

/** Fila cruda con relaciones, tal como sale de Prisma con el include. */
type RegistroCombustibleRow = Prisma.RegistroCombustibleGetPayload<{
  include: typeof COMBUSTIBLE_INCLUDE;
}>;

/** Lo mínimo que `shape` necesita de una fila. Las relaciones son opcionales
 * para tolerar filas leídas sin include (no pasa en producción, pero sí en
 * resultados parciales de tests y en el GetPayload base). */
type FilaCombustible = {
  fotoUrl: string | null;
  fotoKey: string | null;
  registroHorometroId?: string | null;
  createdById?: string | null;
  registroHorometro?: {
    closedByName: string | null;
    closedById: string | null;
    supervisorId: string | null;
  } | null;
};

/** Forma de un registro en la API — nunca expone `fotoKey`, `createdById` ni
 * la relación `registroHorometro` cruda:
 * - `fotoUrl` es la key firmada cuando existe `fotoKey`, o el valor legacy tal
 *   cual si el registro no tiene `fotoKey`.
 * - `realizadoPor` es el NOMBRE ya resuelto de quien hizo la carga: para una
 *   carga nacida de cierre de tarjeta, el supervisor que la cerró (snapshot
 *   `closedByName`, con fallback a resolver `closedById`/`supervisorId`); para
 *   una carga manual, quien la creó (`createdById`).
 * - `origen` distingue la carga de cierre de tarjeta de la manual. */
export type CombustibleResponse<T> = Omit<
  T,
  'fotoKey' | 'createdById' | 'registroHorometro'
> & {
  fotoUrl: string | null;
  realizadoPor: string | null;
  origen: 'TARJETA' | 'MANUAL';
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
          include: COMBUSTIBLE_INCLUDE,
          omit: { createdById: false },
        });
        if (!existing) return null;
        return {
          ownerId: existing.createdById,
          result: () => this.shapeSolo(existing),
        };
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
        include: COMBUSTIBLE_INCLUDE,
        omit: { createdById: false },
      });
    } catch (error: unknown) {
      // Se descarta ANTES de que `createOrReturn` relea la carrera: la copia
      // del perdedor no queda en el bucket, la fila ganadora conserva la suya.
      if (finalKey) {
        await this.storage.discard(finalKey);
      }
      throw error;
    }

    return this.shapeSolo(registro);
  }

  async findAll() {
    const registros = await this.prisma.registroCombustible.findMany({
      orderBy: { fecha: 'desc' },
      include: COMBUSTIBLE_INCLUDE,
      omit: { createdById: false },
    });
    const nombres = await resolveNombresUsuarios(
      this.prisma,
      registros.flatMap((registro) => this.idsDe(registro)),
    );
    return Promise.all(
      registros.map((registro) => this.shape(registro, nombres)),
    );
  }

  async findOne(id: string) {
    const reg = await this.prisma.registroCombustible.findUnique({
      where: { id },
      include: COMBUSTIBLE_INCLUDE,
      omit: { createdById: false },
    });
    if (!reg) throw new NotFoundException('Registro no encontrado');
    return this.shapeSolo(reg);
  }

  async update(id: string, dto: UpdateCombustibleDto) {
    const registro = await this.prisma.registroCombustible.update({
      where: { id },
      data: dto,
      include: COMBUSTIBLE_INCLUDE,
      omit: { createdById: false },
    });
    return this.shapeSolo(registro);
  }

  /** Ids de usuario que `shape` podría necesitar resolver para una fila. */
  private idsDe(registro: FilaCombustible): Array<string | null | undefined> {
    return [
      registro.createdById,
      registro.registroHorometro?.closedById,
      registro.registroHorometro?.supervisorId,
    ];
  }

  /** `shape` para UNA fila: resuelve sus nombres y shapea. `findAll` no pasa
   * por acá — resuelve TODOS los ids del listado en un solo `findMany`. */
  private async shapeSolo<T extends FilaCombustible>(registro: T) {
    const nombres = await resolveNombresUsuarios(
      this.prisma,
      this.idsDe(registro),
    );
    return this.shape(registro, nombres);
  }

  /**
   * Genérico sobre `T` para preservar cualquier otro campo que traiga la fila
   * cruda (ej. el `equipo` del include), sin tener que listarlos a mano y
   * arriesgarse a que la vista de Terreno pierda un campo. Ver
   * `CombustibleResponse` para lo que agrega y lo que nunca sale.
   */
  private async shape<T extends FilaCombustible>(
    registro: T,
    nombres: ReadonlyMap<string, string>,
  ): Promise<CombustibleResponse<T>> {
    const { fotoKey, fotoUrl, createdById, registroHorometro, ...resto } =
      registro;
    const esDeTarjeta = Boolean(registro.registroHorometroId);
    const realizadoPor = esDeTarjeta
      ? (registroHorometro?.closedByName ??
        (registroHorometro?.closedById
          ? nombres.get(registroHorometro.closedById)
          : undefined) ??
        (registroHorometro?.supervisorId
          ? nombres.get(registroHorometro.supervisorId)
          : undefined) ??
        null)
      : createdById
        ? (nombres.get(createdById) ?? null)
        : null;
    return {
      ...resto,
      fotoUrl: fotoKey ? await this.storage.sign(fotoKey) : fotoUrl,
      realizadoPor,
      origen: esDeTarjeta ? 'TARJETA' : 'MANUAL',
    } as CombustibleResponse<T>;
  }
}
