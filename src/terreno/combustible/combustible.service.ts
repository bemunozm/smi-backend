import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';

import type { RegistroCombustible } from '@prisma/client';

import { PrismaService } from '../../common/prisma/prisma.service';
import { StorageService } from '../../storage/storage.service';
import { CreateCombustibleDto } from './dto/create-combustible.dto';
import { UpdateCombustibleDto } from './dto/update-combustible.dto';

/** Forma de un registro en la API — nunca expone `fotoKey` (ver Diseño del
 * RFC R2-storage, "Combustible"): `fotoUrl` es la key firmada cuando existe
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
    if (dto.fotoUrl && dto.fotoKey) {
      throw new BadRequestException(
        'No se puede enviar "fotoUrl" y "fotoKey" juntos',
      );
    }

    const equipo = await this.prisma.equipment.findUnique({
      where: { id: dto.equipoId },
    });
    if (!equipo) throw new NotFoundException('Equipo no encontrado');

    // Reclama ANTES del `create` (fuera del try) — igual que
    // `EquipmentService.create`: si el claim falla no hay nada que revertir.
    const finalKey = dto.fotoKey
      ? await this.storage.claimTmp(dto.fotoKey, userId, 'fuel-photo')
      : undefined;

    // El `try/catch` cubre SOLO la escritura en Prisma (hallazgo BAJO B1 de
    // la revisión de seguridad, mismo patrón que `EquipmentService.create`):
    // antes acá `return this.shape(registro)` SIN `await` dentro del try
    // hacía que el rollback nunca se disparara igual por accidente — se deja
    // explícito para no depender de ese detalle.
    let registro: RegistroCombustible;
    try {
      registro = await this.prisma.registroCombustible.create({
        data: {
          equipoId: dto.equipoId,
          litros: dto.litros,
          tipo: dto.tipo,
          fotoUrl: dto.fotoUrl ?? null,
          fotoKey: finalKey ?? null,
          // Sin `fecha` en el DTO, se omite la key y Prisma aplica el
          // `@default(now())` del schema — comportamiento previo intacto.
          ...(dto.fecha ? { fecha: new Date(dto.fecha) } : {}),
        },
      });
    } catch (error: unknown) {
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
