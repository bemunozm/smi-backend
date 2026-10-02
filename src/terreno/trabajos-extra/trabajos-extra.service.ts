import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { ERROR_CODES } from '../../common/errors/error-codes';
import { PrismaService } from '../../common/prisma/prisma.service';
import { OperatorsService } from '../../operators/operators.service';
import { assertReasonableCapturedAt } from '../../shifts/capture-time';
import { CreateTrabajoExtraDto } from './dto/create-trabajo-extra.dto';
import { UpdateTrabajoExtraDto } from './dto/update-trabajo-extra.dto';

/**
 * Relación que toda lectura/escritura devuelve. Una sola definición para que
 * `create`, `findAll`, `findOne` y `update` entreguen la misma forma: el
 * outbox offline de la tablet inserta la respuesta de `create` en la misma
 * caché que alimenta el listado, y sin `equipo` la fila mostraría el
 * `equipoId` crudo en vez del código interno.
 */
const TRABAJO_EXTRA_INCLUDE = {
  equipo: { select: { internalCode: true } },
} satisfies Prisma.TrabajoExtraordinarioInclude;

/**
 * `createdById` es interno (solo sirve para el chequeo de propiedad en
 * reintentos): se omite en el SELECT de toda query cuyo resultado sale a la
 * API, en vez de filtrarlo después.
 */
const TRABAJO_EXTRA_OMIT = {
  createdById: true,
} satisfies Prisma.TrabajoExtraordinarioOmit;

export type TrabajoExtraResponse = Prisma.TrabajoExtraordinarioGetPayload<{
  include: typeof TRABAJO_EXTRA_INCLUDE;
  omit: typeof TRABAJO_EXTRA_OMIT;
}>;

@Injectable()
export class TrabajosExtraService {
  constructor(
    private prisma: PrismaService,
    private readonly operators: OperatorsService,
  ) {}

  async create(dto: CreateTrabajoExtraDto, userId: string) {
    // PRIMERO y antes de cualquier regla: un reintento offline debe devolver
    // la fila ya creada aunque el estado del mundo haya cambiado desde
    // entonces (operador desactivado, turno abierto después, etc.).
    if (dto.id) {
      const existing = await this.findOwnedById(dto.id, userId);
      if (existing) return existing;
    }

    const fecha = this.resolveFecha(dto.capturedAt);

    const equipo = await this.prisma.equipment.findUnique({
      where: { id: dto.equipoId },
    });
    if (!equipo) throw new NotFoundException('Equipo no encontrado');

    /**
     * Operador del catálogo — obligatorio (RFC Supervisión en Terreno). Se
     * valida justo después del chequeo de equipo (la precondición más
     * barata primero: un 404 de equipo no debería depender de resolver el
     * operador) y ANTES de las reglas más caras de abajo (turno en curso,
     * horómetro, actividades) — así un operador inactivo/inexistente falla
     * rápido, sin gastar esas otras consultas. `operador` (snapshot) se arma
     * acá con el nombre del catálogo — el cliente ya no lo manda.
     */
    const operator = await this.operators.assertActive(dto.operatorId);

    /**
     * Un equipo con turno en curso está **ocupado**: no se le puede cargar un
     * trabajo extraordinario hasta que se cierre la tarjeta.
     *
     * El motivo es el cobro. Las horas del trabajo extraordinario y las del
     * turno se facturan por separado, y mientras el turno sigue abierto no se
     * sabe cuáles serán sus horas — así que las del trabajo podrían quedar
     * contadas dos veces, una acá y otra dentro del turno cuando se cierre.
     *
     * «Turno en curso» es la misma definición que usa `HorometroService`:
     * un `RegistroHorometro` con `valorFinal` en null. Esa regla ya está
     * respaldada por el índice único parcial sobre `(equipo_id) WHERE
     * "valorFinal" IS NULL`, así que como mucho hay un turno abierto por
     * equipo y esta consulta devuelve uno o ninguno.
     */
    const turnoAbierto = await this.prisma.registroHorometro.findFirst({
      where: { equipoId: dto.equipoId, valorFinal: null },
      select: { id: true },
    });
    if (turnoAbierto) {
      throw new BadRequestException({
        message:
          `El equipo ${equipo.internalCode} tiene un turno en curso y está ocupado. ` +
          'Cerrá la tarjeta del turno antes de registrar un trabajo extraordinario.',
        code: ERROR_CODES.EQUIPMENT_ON_SHIFT,
      });
    }

    /**
     * Un horómetro no retrocede: si el final es menor que el inicial, alguien
     * se equivocó al tipear.
     *
     * Antes esto era `Math.max(0, final - inicial)`, que guardaba **0 horas en
     * silencio** y dejaba el error invisible en la base — indistinguible de un
     * trabajo legítimo que duró cero. Y como estas horas respaldan un cobro,
     * un cero inventado es peor que un rechazo.
     *
     * El formulario ya lo valida (`trabajoExtraFormSchema` tiene un `.refine()`),
     * pero eso no alcanza: la especificación pide que Terreno funcione sin
     * conexión y sincronice después (R4), así que un registro encolado se
     * reenvía sin pasar por el formulario.
     */
    if (dto.horometroFinal < dto.horometroInicial) {
      throw new BadRequestException(
        `El horómetro final (${dto.horometroFinal}) no puede ser menor que el inicial (${dto.horometroInicial}).`,
      );
    }

    /**
     * «Otro» sin texto no dice nada: la actividad quedaría registrada como
     * «otro» a secas y el trabajo no se podría justificar ni cobrar. Si se
     * eligió, el texto es obligatorio; si no se eligió, se descarta para que
     * no quede un texto huérfano contradiciendo la lista.
     */
    const eligioOtro = dto.actividades.includes('OTRO');
    const otraActividad = dto.otraActividad?.trim();
    if (eligioOtro && !otraActividad) {
      throw new BadRequestException(
        'Elegiste «Otro» como actividad: describí cuál fue.',
      );
    }

    const totalHoras = Number(
      (dto.horometroFinal - dto.horometroInicial).toFixed(2),
    );
    try {
      return await this.prisma.trabajoExtraordinario.create({
        data: {
          ...(dto.id ? { id: dto.id } : {}),
          createdById: userId,
          fecha,
          equipoId: dto.equipoId,
          operatorId: operator.id,
          operador: operator.name,
          faena: dto.faena,
          turno: dto.turno,
          horometroInicial: dto.horometroInicial,
          horometroFinal: dto.horometroFinal,
          totalHoras,
          actividades: dto.actividades,
          otraActividad: eligioOtro ? otraActividad : null,
          descripcion: dto.descripcion,
          observaciones: dto.observaciones ?? null,
        },
        include: TRABAJO_EXTRA_INCLUDE,
        omit: TRABAJO_EXTRA_OMIT,
      });
    } catch (error: unknown) {
      // Carrera: otro reintento con el MISMO id ya ganó entre el chequeo
      // inicial y el insert.
      if (
        dto.id &&
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        const winner = await this.findOwnedById(dto.id, userId);
        if (winner) return winner;
      }
      throw error;
    }
  }

  /**
   * La fila con ese id si es del usuario (reintento propio); `null` si no
   * existe; 409 si el id ya lo ocupa otro usuario o una fila legacy sin dueño.
   */
  private async findOwnedById(
    id: string,
    userId: string,
  ): Promise<TrabajoExtraResponse | null> {
    const owned = await this.prisma.trabajoExtraordinario.findFirst({
      where: { id, createdById: userId },
      include: TRABAJO_EXTRA_INCLUDE,
      omit: TRABAJO_EXTRA_OMIT,
    });
    if (owned) return owned;

    const taken = await this.prisma.trabajoExtraordinario.findUnique({
      where: { id },
      select: { id: true },
    });
    if (taken) {
      throw new ConflictException({
        message: 'Ya existe un trabajo con ese id de otro usuario',
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

  findAll(): Promise<TrabajoExtraResponse[]> {
    return this.prisma.trabajoExtraordinario.findMany({
      orderBy: { fecha: 'desc' },
      include: TRABAJO_EXTRA_INCLUDE,
      omit: TRABAJO_EXTRA_OMIT,
    });
  }

  async findOne(id: string): Promise<TrabajoExtraResponse> {
    const reg = await this.prisma.trabajoExtraordinario.findUnique({
      where: { id },
      include: TRABAJO_EXTRA_INCLUDE,
      omit: TRABAJO_EXTRA_OMIT,
    });
    if (!reg) throw new NotFoundException('Registro no encontrado');
    return reg;
  }

  update(
    id: string,
    dto: UpdateTrabajoExtraDto,
  ): Promise<TrabajoExtraResponse> {
    return this.prisma.trabajoExtraordinario.update({
      where: { id },
      data: dto,
      include: TRABAJO_EXTRA_INCLUDE,
      omit: TRABAJO_EXTRA_OMIT,
    });
  }
}
