import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';

import type { Prisma } from '@prisma/client';

import {
  ChangeLogService,
  diffFields,
  type ComparableField,
  type Editor,
} from '../../change-log/change-log.service';
import { formatBusinessDateTime } from '../../common/dates/business-time';
import { ERROR_CODES } from '../../common/errors/error-codes';
import { createOrReturn } from '../../common/idempotency/create-or-return';
import { PrismaService } from '../../common/prisma/prisma.service';
import { reconcileEquipmentCounter } from '../../equipment/equipment-counter';
import { StorageService } from '../../storage/storage.service';
import { resolveNombresUsuarios } from '../common/registrado-por.util';
import { CreateCombustibleDto } from './dto/create-combustible.dto';
import { UpdateCombustibleDto } from './dto/update-combustible.dto';

/** Los datos de una carga manual que el panel puede corregir. */
interface DatosCarga {
  litros: number;
  tipo: string;
  fecha: Date;
  lectura: number | null;
}

/** Cómo se lee cada dato en el historial de cambios del administrador. */
const TIPO_LABEL: Record<string, string> = {
  PETROLEO: 'Petróleo',
  BENCINA: 'Bencina',
};
const CAMPOS_CARGA: readonly ComparableField<DatosCarga>[] = [
  { field: 'litros', label: 'Litros' },
  {
    field: 'tipo',
    label: 'Combustible',
    format: (v) => (typeof v === 'string' && TIPO_LABEL[v]) || String(v),
  },
  {
    field: 'fecha',
    label: 'Fecha',
    format: (v) => (v instanceof Date ? formatBusinessDateTime(v) : String(v)),
  },
  { field: 'lectura', label: 'Lectura' },
];

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
    select: {
      internalCode: true,
      type: true,
      equipmentClass: true,
      controlUnit: true,
    },
  },
  registroHorometro: {
    select: {
      closedByName: true,
      closedById: true,
      supervisorId: true,
      valorFinal: true,
    },
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
  lectura?: number | null;
  registroHorometroId?: string | null;
  createdById?: string | null;
  registroHorometro?: {
    closedByName: string | null;
    closedById: string | null;
    supervisorId: string | null;
    valorFinal?: number | null;
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
 * - `origen` distingue la carga de cierre de tarjeta de la manual.
 * - `lectura` es el contador del equipo AL CARGAR (horómetro en pesados, km
 *   en livianos): la propia de la carga (alta manual) o, en cargas de
 *   tarjeta, el `valorFinal` de la tarjeta vinculada. */
export type CombustibleResponse<T> = Omit<
  T,
  'fotoKey' | 'createdById' | 'registroHorometro' | 'lectura'
> & {
  fotoUrl: string | null;
  realizadoPor: string | null;
  origen: 'TARJETA' | 'MANUAL';
  lectura: number | null;
};

@Injectable()
export class CombustibleService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    private readonly changeLog: ChangeLogService,
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
      // Carga + contador en UNA transacción: si la reconciliación lanzara,
      // la carga no queda a medias.
      registro = await this.prisma.$transaction(async (tx) => {
        const creado = await tx.registroCombustible.create({
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
            lectura: dto.lectura ?? null,
          },
          include: COMBUSTIBLE_INCLUDE,
          omit: { createdById: false },
        });
        if (dto.lectura != null) {
          // Modo 'warn': una carga histórica puede traer una lectura menor
          // que el contador vigente — se guarda en la carga igual y el
          // contador NO retrocede ni se rechaza (ver comentario del schema).
          await reconcileEquipmentCounter(
            tx,
            dto.equipoId,
            equipo,
            dto.lectura,
            'warn',
          );
        }
        return creado;
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

  /**
   * Corrección de una carga MANUAL desde el panel (solo ADMIN en el
   * controller). Una carga nacida de un cierre de tarjeta se corrige editando
   * la TARJETA (`PATCH /shift-cards/:id` sincroniza `litros` vía
   * `syncFuelRecord` y deja historial) — editarla por acá las haría divergir,
   * por eso se rechaza. Una `lectura` nueva reconcilia el contador del equipo
   * en modo `warn`, igual que el alta: solo avanza, nunca retrocede. El
   * cambio queda en el historial (`ChangeLog`, entity `combustible`) en la
   * misma transacción — es lo que el registro de actividad muestra.
   */
  async update(id: string, dto: UpdateCombustibleDto, editor: Editor) {
    if (
      dto.litros === undefined &&
      dto.tipo === undefined &&
      dto.fecha === undefined &&
      dto.lectura === undefined
    ) {
      throw new BadRequestException(
        'Indica al menos un dato a corregir de la carga',
      );
    }

    const previa = await this.prisma.registroCombustible.findUnique({
      where: { id },
      select: {
        equipoId: true,
        registroHorometroId: true,
        litros: true,
        tipo: true,
        fecha: true,
        lectura: true,
      },
    });
    if (!previa) throw new NotFoundException('Registro no encontrado');
    if (previa.registroHorometroId) {
      throw new ConflictException({
        message:
          'Esta carga nació del cierre de una tarjeta de turno: corrígela editando esa tarjeta.',
        code: ERROR_CODES.FUEL_LOAD_FROM_CARD,
      });
    }

    const despues: DatosCarga = {
      litros: dto.litros ?? previa.litros,
      tipo: dto.tipo ?? previa.tipo,
      fecha: dto.fecha !== undefined ? new Date(dto.fecha) : previa.fecha,
      lectura: dto.lectura ?? previa.lectura,
    };
    const cambios = diffFields<DatosCarga>(previa, despues, CAMPOS_CARGA);

    // Edición + historial en UNA transacción: una corrección sin su registro
    // es justo lo que el historial debe impedir.
    const registro = await this.prisma.$transaction(async (tx) => {
      const editado = await tx.registroCombustible.update({
        where: { id },
        data: {
          ...(dto.litros !== undefined ? { litros: dto.litros } : {}),
          ...(dto.tipo !== undefined ? { tipo: dto.tipo } : {}),
          ...(dto.fecha !== undefined ? { fecha: new Date(dto.fecha) } : {}),
          ...(dto.lectura !== undefined ? { lectura: dto.lectura } : {}),
        },
        include: COMBUSTIBLE_INCLUDE,
        omit: { createdById: false },
      });
      if (cambios.length > 0) {
        await this.changeLog.record(tx, 'combustible', id, editor, cambios);
      }
      return editado;
    });

    if (dto.lectura !== undefined) {
      const equipo = await this.prisma.equipment.findUnique({
        where: { id: previa.equipoId },
        select: { controlUnit: true, currentHourmeter: true, currentMileage: true },
      });
      if (equipo) {
        // `warn`: la lectura corregida hacia abajo no retrocede el contador
        // (si quedó inflado por el typo, se corrige en la ficha del equipo).
        await reconcileEquipmentCounter(
          this.prisma,
          previa.equipoId,
          equipo,
          dto.lectura,
          'warn',
        );
      }
    }

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
    const {
      fotoKey,
      fotoUrl,
      createdById,
      registroHorometro,
      lectura,
      ...resto
    } = registro;
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
      // La propia de la carga (alta manual), o el valorFinal de la tarjeta
      // que la originó — es la MISMA lectura física al momento de cargar.
      lectura: lectura ?? registroHorometro?.valorFinal ?? null,
    } as CombustibleResponse<T>;
  }
}
