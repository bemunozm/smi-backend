import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ControlUnit, Prisma } from '@prisma/client';

import { PrismaService } from '../../common/prisma/prisma.service';
import { CreateHorometroDto } from './dto/create-horometro.dto';
import { SalidaHorometroDto } from './dto/salida-horometro.dto';
import { UpdateHorometroDto } from './dto/update-horometro.dto';

/** Reusado por el chequeo aplicativo (fast-path) y por la traducción del
 * P2002 que dispara el índice único parcial (garantía dura, ver migración
 * `..._horometro_open_turno_unique_index`) — ambos caminos deben devolver
 * el mismo mensaje al caller. */
const TURNO_ABIERTO_MSG =
  'El equipo ya tiene un turno en curso; registrá la salida antes de una nueva entrada.';

/** Contadores vigentes de la ficha del equipo que gobiernan la reconciliación
 * (guía §4): solo uno de los dos aplica, según `controlUnit`. */
type EquipoContador = {
  controlUnit: ControlUnit;
  currentHourmeter: number | null;
  currentMileage: number | null;
};

@Injectable()
export class HorometroService {
  constructor(private prisma: PrismaService) {}

  /**
   * ENTRADA del flujo de dos pasos (Flota): abre el turno del equipo. Un
   * equipo no puede tener dos turnos abiertos a la vez ("turno abierto" =
   * `valorFinal == null`), así que se rechaza si ya hay uno en curso — sin
   * este chequeo, la SALIDA posterior no sabría a cuál de los dos registros
   * abiertos cerrar.
   */
  async create(dto: CreateHorometroDto) {
    // El registro de terreno y el write del contador de la ficha van en la
    // misma transacción: si el update del equipo fallara, no debe quedar un
    // `RegistroHorometro` huérfano que la ficha muestre sin haber movido el
    // contador (o viceversa). El fetch del equipo y el chequeo de turno
    // abierto también van dentro del `tx` — el primero para leer los
    // contadores vigentes de forma consistente con el resto de la
    // transacción, el segundo para cerrar la ventana de carrera entre dos
    // ENTRADA casi simultáneas del mismo equipo.
    return this.prisma.$transaction(async (tx) => {
      const equipo = await tx.equipment.findUnique({
        where: { id: dto.equipoId },
        select: {
          controlUnit: true,
          currentHourmeter: true,
          currentMileage: true,
        },
      });
      if (!equipo) throw new NotFoundException('Equipo no encontrado');

      const turnoAbierto = await tx.registroHorometro.findFirst({
        where: { equipoId: dto.equipoId, valorFinal: null },
        select: { id: true },
      });
      if (turnoAbierto) {
        throw new BadRequestException(TURNO_ABIERTO_MSG);
      }

      // El fast-path de arriba (`findFirst`) no cierra la ventana de carrera
      // bajo READ COMMITTED: dos ENTRADA casi simultáneas del mismo equipo
      // pueden pasarlo las dos. La garantía dura es el índice único parcial
      // de Postgres sobre `(equipo_id) WHERE "valorFinal" IS NULL`; si el
      // `create` de abajo choca contra él, Prisma lo reporta como P2002 y acá
      // se traduce al mismo 400 que el chequeo aplicativo.
      let registro;
      try {
        registro = await tx.registroHorometro.create({
          data: {
            equipoId: dto.equipoId,
            operador: dto.operador,
            turno: dto.turno,
            valorInicial: dto.valorInicial,
            valorFinal: dto.valorFinal ?? null,
            nivelCombustible: dto.nivelCombustible ?? null,
            fotoUrl: dto.fotoUrl ?? null,
          },
        });
      } catch (error) {
        if (
          error instanceof Prisma.PrismaClientKnownRequestError &&
          error.code === 'P2002'
        ) {
          throw new BadRequestException(TURNO_ABIERTO_MSG);
        }
        throw error;
      }

      // El write del valor actual solo aplica al contador que gobierna la
      // unidad (RFC T01 §2, MEJORA-3): HOURS pisa `currentHourmeter`, KM pisa
      // `currentMileage` — nunca los dos a la vez. El contador se cuadra a la
      // lectura más reciente que se conoce del equipo: `valorFinal` si el
      // caller lo mandó (flujo de un paso de Terreno, que cierra el turno al
      // toque), o si no `valorInicial` (flujo de dos pasos de Flota, que solo
      // abre el turno acá).
      // TODO(motor-preventivo): disparar el umbral de Mantenimiento (Joaquín, guía §5).
      await this.reconcileEquipmentCounter(
        tx,
        dto.equipoId,
        equipo,
        dto.valorFinal ?? dto.valorInicial,
      );

      return registro;
    });
  }

  /**
   * SALIDA del flujo de dos pasos (Flota): cierra el turno que `create()`
   * abrió. Vuelve a cuadrar el contador del equipo, esta vez a `valorFinal`.
   */
  async salida(id: string, dto: SalidaHorometroDto) {
    return this.prisma.$transaction(async (tx) => {
      const registro = await tx.registroHorometro.findUnique({
        where: { id },
      });
      if (!registro) throw new NotFoundException('Registro no encontrado');

      if (registro.valorFinal != null) {
        throw new ConflictException('El turno ya está cerrado');
      }
      if (dto.valorFinal < registro.valorInicial) {
        throw new BadRequestException(
          'La lectura final no puede ser menor que la inicial',
        );
      }

      const cerrado = await tx.registroHorometro.update({
        where: { id },
        data: {
          valorFinal: dto.valorFinal,
          fotoUrlSalida: dto.fotoUrlSalida ?? null,
          fechaSalida: new Date(),
          ...(dto.nivelCombustible != null
            ? { nivelCombustible: dto.nivelCombustible }
            : {}),
        },
      });

      const equipo = await tx.equipment.findUnique({
        where: { id: registro.equipoId },
        select: {
          controlUnit: true,
          currentHourmeter: true,
          currentMileage: true,
        },
      });
      if (equipo) {
        await this.reconcileEquipmentCounter(
          tx,
          registro.equipoId,
          equipo,
          dto.valorFinal,
        );
      }

      return cerrado;
    });
  }

  findAll() {
    return this.prisma.registroHorometro.findMany({
      orderBy: { fecha: 'desc' },
      include: { equipo: { select: { internalCode: true } } },
    });
  }

  async findOne(id: string) {
    const reg = await this.prisma.registroHorometro.findUnique({
      where: { id },
    });
    if (!reg) throw new NotFoundException('Registro no encontrado');
    return reg;
  }

  async update(id: string, dto: UpdateHorometroDto) {
    // Mismo criterio de atomicidad que `create()`: el registro editado y el
    // write del contador (si `valorFinal` cambia) van en la misma transacción.
    return this.prisma.$transaction(async (tx) => {
      const reg = await tx.registroHorometro.update({
        where: { id },
        data: dto,
      });

      if (dto.valorFinal != null) {
        const equipo = await tx.equipment.findUnique({
          where: { id: reg.equipoId },
          select: {
            controlUnit: true,
            currentHourmeter: true,
            currentMileage: true,
          },
        });
        if (equipo) {
          await this.reconcileEquipmentCounter(
            tx,
            reg.equipoId,
            equipo,
            dto.valorFinal,
          );
        }
      }

      return reg;
    });
  }

  /**
   * Único punto donde se lee/escribe el contador de uso de la ficha del
   * equipo (`currentHourmeter`/`currentMileage`), reusado por `create()`,
   * `salida()` y `update()` — antes triplicado con un `if/else` por método.
   *
   * Guarda monotónica (decisión de producto, hallazgo B1): el contador de un
   * equipo NUNCA retrocede. Una lectura menor que la vigente es casi siempre
   * un typo o un OCR mal leído; el reemplazo físico de horómetro (el único
   * caso legítimo de una lectura menor) se maneja como flujo aparte a
   * futuro, no acá. Si el contador vigente es `null` (equipo sin lectura
   * previa) no hay piso: se acepta cualquier valor ≥ 0 (ya validado por el
   * DTO con `@Min(0)`).
   */
  private async reconcileEquipmentCounter(
    tx: Prisma.TransactionClient,
    equipoId: string,
    equipo: EquipoContador,
    nuevoValor: number,
  ): Promise<void> {
    const esHoras = equipo.controlUnit === ControlUnit.HOURS;
    const vigente = esHoras ? equipo.currentHourmeter : equipo.currentMileage;
    const unidad = esHoras ? 'h' : 'km';
    const nombreContador = esHoras ? 'horómetro' : 'kilometraje';

    if (vigente != null && nuevoValor < vigente) {
      throw new BadRequestException(
        `La lectura (${nuevoValor} ${unidad}) no puede ser menor que el ${nombreContador} actual del equipo (${vigente} ${unidad})`,
      );
    }

    if (esHoras) {
      await tx.equipment.update({
        where: { id: equipoId },
        data: { currentHourmeter: nuevoValor },
      });
    } else if (equipo.controlUnit === ControlUnit.KM) {
      await tx.equipment.update({
        where: { id: equipoId },
        data: { currentMileage: nuevoValor },
      });
    }
  }
}
