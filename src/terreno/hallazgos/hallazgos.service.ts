import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Prisma } from '@prisma/client';

import { ERROR_CODES } from '../../common/errors/error-codes';
import { PrismaService } from '../../common/prisma/prisma.service';
import { assertReasonableCapturedAt } from '../../shifts/capture-time';
import { DOMAIN_EVENTS } from '../../common/events/domain-events';
import type { HallazgoCreatedEvent } from '../../common/events/domain-events';
import { StorageService } from '../../storage/storage.service';
import { CreateHallazgoDto } from './dto/create-hallazgo.dto';
import { UpdateHallazgoDto } from './dto/update-hallazgo.dto';

/**
 * Relación que toda lectura/escritura devuelve. Una sola definición para que
 * `create`, `findAll`, `findOne` y `update` entreguen la misma forma: el
 * outbox offline de la tablet inserta la respuesta de `create` en la misma
 * caché que alimenta el listado, y sin `equipo` la fila mostraría el
 * `equipoId` crudo en vez del código interno.
 */
const HALLAZGO_INCLUDE = {
  equipo: { select: { internalCode: true } },
} satisfies Prisma.HallazgoInclude;

/**
 * `createdById` es interno (solo sirve para el chequeo de propiedad en
 * reintentos): se omite en el SELECT de toda query cuyo resultado sale a la
 * API, en vez de filtrarlo después.
 */
const HALLAZGO_OMIT = {
  createdById: true,
} satisfies Prisma.HallazgoOmit;

type HallazgoWithEquipo = Prisma.HallazgoGetPayload<{
  include: typeof HALLAZGO_INCLUDE;
  omit: typeof HALLAZGO_OMIT;
}>;

/**
 * Forma de un hallazgo en la API — nunca expone `fotoKey` (igual que
 * `CombustibleResponse`: `fotoUrl` es la key firmada cuando hay `fotoKey`, o
 * el valor legacy tal cual cuando el registro no tiene key).
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
    // PRIMERO y antes de cualquier regla: un reintento offline debe devolver
    // la fila ya creada aunque el estado del mundo haya cambiado desde
    // entonces (equipo dado de baja, key tmp ya reclamada) — y sin repetir
    // el claim ni el evento.
    if (dto.id) {
      const existing = await this.findOwnedById(dto.id, userId);
      if (existing) return this.shape(existing);
    }

    const fecha = this.resolveFecha(dto.capturedAt);

    const equipo = await this.prisma.equipment.findUnique({
      where: { id: dto.equipoId },
    });
    if (!equipo) throw new NotFoundException('Equipo no encontrado');

    // Se reclama ANTES del `create` y fuera del try, igual que en
    // `CombustibleService`: si el claim falla, todavía no hay fila que revertir.
    const finalKey = dto.fotoKey
      ? await this.storage.claimTmp(dto.fotoKey, userId, 'hallazgo-photo')
      : undefined;

    let hallazgo: HallazgoWithEquipo;
    try {
      hallazgo = await this.prisma.hallazgo.create({
        data: {
          ...(dto.id ? { id: dto.id } : {}),
          equipoId: dto.equipoId,
          descripcion: dto.descripcion,
          prioridad: dto.prioridad,
          estado: 'ABIERTO',
          // `fotoUrl` (legacy) ya no es un campo de creación — ver
          // `CreateHallazgoDto`. Se omite la key: Prisma inserta NULL.
          fotoKey: finalKey ?? null,
          createdById: userId,
          fecha,
        },
        include: HALLAZGO_INCLUDE,
        omit: HALLAZGO_OMIT,
      });
    } catch (error: unknown) {
      // El objeto ya está reclamado en el bucket: si la fila no se escribe,
      // queda huérfano y hay que soltarlo.
      if (finalKey) {
        await this.storage.discard(finalKey);
      }

      if (dto.id && this.isUniqueViolation(error)) {
        // Carrera: otro reintento con el MISMO id ya ganó entre el chequeo
        // inicial y el insert. La foto reclamada por este intento ya se soltó;
        // la fila ganadora conserva la suya.
        const winner = await this.findOwnedById(dto.id, userId);
        if (winner) return this.shape(winner);
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
      include: HALLAZGO_INCLUDE,
      omit: HALLAZGO_OMIT,
    });
    return Promise.all(registros.map((r) => this.shape(r)));
  }

  async findOne(id: string) {
    const reg = await this.prisma.hallazgo.findUnique({
      where: { id },
      include: HALLAZGO_INCLUDE,
      omit: HALLAZGO_OMIT,
    });
    if (!reg) throw new NotFoundException('Hallazgo no encontrado');
    return this.shape(reg);
  }

  async update(id: string, dto: UpdateHallazgoDto) {
    return this.shape(
      await this.prisma.hallazgo.update({
        where: { id },
        data: dto,
        include: HALLAZGO_INCLUDE,
        omit: HALLAZGO_OMIT,
      }),
    );
  }

  /**
   * La fila con ese id si es del usuario (reintento propio); `null` si no
   * existe; 409 si el id ya lo ocupa otro usuario o una fila legacy sin dueño.
   */
  private async findOwnedById(
    id: string,
    userId: string,
  ): Promise<HallazgoWithEquipo | null> {
    const owned = await this.prisma.hallazgo.findFirst({
      where: { id, createdById: userId },
      include: HALLAZGO_INCLUDE,
      omit: HALLAZGO_OMIT,
    });
    if (owned) return owned;

    const taken = await this.prisma.hallazgo.findUnique({
      where: { id },
      select: { id: true },
    });
    if (taken) {
      throw new ConflictException({
        message: 'Ya existe un hallazgo con ese id de otro usuario',
        code: ERROR_CODES.ID_CONFLICT,
      });
    }
    return null;
  }

  /** `capturedAt` (hora del dispositivo) si viene y es razonable; si no, la
   * hora del servidor. */
  private resolveFecha(capturedAt: string | undefined): Date {
    if (!capturedAt) return new Date();
    const captured = new Date(capturedAt);
    assertReasonableCapturedAt(captured);
    return captured;
  }

  private isUniqueViolation(error: unknown): boolean {
    return (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === 'P2002'
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
