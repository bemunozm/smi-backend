import { Injectable, NotFoundException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import type { Hallazgo } from '@prisma/client';

import { PrismaService } from '../../common/prisma/prisma.service';
import { DOMAIN_EVENTS } from '../../common/events/domain-events';
import type { HallazgoCreatedEvent } from '../../common/events/domain-events';
import { StorageService } from '../../storage/storage.service';
import { CreateHallazgoDto } from './dto/create-hallazgo.dto';
import { UpdateHallazgoDto } from './dto/update-hallazgo.dto';

/**
 * Forma de un hallazgo en la API — nunca expone `fotoKey`, igual que
 * `CombustibleResponse`: `fotoUrl` es la key firmada cuando hay `fotoKey`, o
 * el valor legacy tal cual cuando el registro no tiene key.
 */
export type HallazgoResponse<T> = Omit<T, 'fotoKey'> & {
  fotoUrl: string | null;
};

@Injectable()
export class HallazgosService {
  constructor(
    private prisma: PrismaService,
    private eventEmitter: EventEmitter2,
    private readonly storage: StorageService,
  ) {}

  async create(dto: CreateHallazgoDto, userId: string) {
    const equipo = await this.prisma.equipment.findUnique({
      where: { id: dto.equipoId },
    });
    if (!equipo) throw new NotFoundException('Equipo no encontrado');

    // Se reclama ANTES del `create` y fuera del try, igual que en
    // `CombustibleService`: si el claim falla, todavía no hay fila que revertir.
    const finalKey = dto.fotoKey
      ? await this.storage.claimTmp(dto.fotoKey, userId, 'hallazgo-photo')
      : undefined;

    let hallazgo: Hallazgo;
    try {
      hallazgo = await this.prisma.hallazgo.create({
        data: {
          equipoId: dto.equipoId,
          descripcion: dto.descripcion,
          prioridad: dto.prioridad,
          estado: 'ABIERTO',
          // `fotoUrl` (legacy) ya no es un campo de creación — ver
          // `CreateHallazgoDto`. Se omite la key: Prisma inserta NULL.
          fotoKey: finalKey ?? null,
        },
      });
    } catch (error: unknown) {
      // El objeto ya está reclamado en el bucket: si la fila no se escribe,
      // queda huérfano y hay que soltarlo.
      if (finalKey) {
        await this.storage.discard(finalKey);
      }
      throw error;
    }

    this.eventEmitter.emit(DOMAIN_EVENTS.HALLAZGO_CREATED, {
      hallazgoId: hallazgo.id,
      equipoId: hallazgo.equipoId,
      prioridad: hallazgo.prioridad,
      descripcion: hallazgo.descripcion,
    } satisfies HallazgoCreatedEvent);

    return this.shape(hallazgo);
  }

  async findAll() {
    const registros = await this.prisma.hallazgo.findMany({
      orderBy: { fecha: 'desc' },
      include: { equipo: { select: { internalCode: true } } },
    });
    return Promise.all(registros.map((r) => this.shape(r)));
  }

  async findOne(id: string) {
    const reg = await this.prisma.hallazgo.findUnique({ where: { id } });
    if (!reg) throw new NotFoundException('Hallazgo no encontrado');
    return this.shape(reg);
  }

  async update(id: string, dto: UpdateHallazgoDto) {
    return this.shape(
      await this.prisma.hallazgo.update({ where: { id }, data: dto }),
    );
  }

  /**
   * Nunca devuelve `fotoKey` — solo `fotoUrl`, firmada cuando el registro
   * tiene key (subida nueva por R2/MinIO) o el valor legacy tal cual (subida
   * vieja por `/api/uploads`). Genérico sobre `T` para no perder los campos
   * extra que traiga la fila, como el `equipo: { internalCode }` de `findAll`.
   */
  private async shape<
    T extends { fotoUrl: string | null; fotoKey: string | null },
  >(registro: T): Promise<HallazgoResponse<T>> {
    const { fotoKey, fotoUrl, ...resto } = registro;
    return {
      ...resto,
      fotoUrl: fotoKey ? await this.storage.sign(fotoKey) : fotoUrl,
    } as HallazgoResponse<T>;
  }
}
