import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ControlUnit } from '@prisma/client';

import { PrismaService } from '../../common/prisma/prisma.service';
import { CreateHorometroDto } from './dto/create-horometro.dto';
import { UpdateHorometroDto } from './dto/update-horometro.dto';

/** Contador que gobierna la unidad, con su unidad para el mensaje de error. */
interface ContadorActual {
  controlUnit: ControlUnit;
  currentHourmeter: number | null;
  currentMileage: number | null;
}

@Injectable()
export class HorometroService {
  constructor(private prisma: PrismaService) {}

  /**
   * Un horómetro no retrocede. Esta lectura **pisa el contador de la ficha**,
   * y ese contador alimenta el motor de mantenimiento preventivo (R6 de la
   * especificación del 21/09): si retrocede, una mantención que ya estaba por
   * vencer vuelve a quedar lejos y el equipo se pasa del umbral sin que nadie
   * se entere. Es la clase de error que no se ve hasta que rompe algo.
   *
   * Dos reglas, y las dos se validan acá y no solo en el formulario, porque
   * R4 pide que Terreno registre sin señal y sincronice después: un registro
   * encolado se reenvía sin pasar por la pantalla.
   */
  private assertLecturaValida(
    lectura: { valorInicial: number; valorFinal?: number | null },
    equipo: ContadorActual,
  ): void {
    const { valorInicial, valorFinal } = lectura;
    // Turno abierto: todavía no hay nada que validar ni contador que mover.
    if (valorFinal == null) return;

    if (valorFinal < valorInicial) {
      throw new BadRequestException(
        `El valor final (${valorFinal}) no puede ser menor que el inicial (${valorInicial}).`,
      );
    }

    const porHoras = equipo.controlUnit === ControlUnit.HOURS;
    const actual = porHoras ? equipo.currentHourmeter : equipo.currentMileage;
    const unidad = porHoras ? 'h' : 'km';

    // Sin lectura previa no hay contra qué comparar: la primera lectura manda.
    if (actual != null && valorFinal < actual) {
      throw new BadRequestException(
        `El valor final (${valorFinal} ${unidad}) es menor que el contador actual del equipo (${actual} ${unidad}). ` +
          'El contador no puede retroceder: revisá la lectura.',
      );
    }
  }

  async create(dto: CreateHorometroDto) {
    const equipo = await this.prisma.equipment.findUnique({
      where: { id: dto.equipoId },
    });
    if (!equipo) throw new NotFoundException('Equipo no encontrado');

    this.assertLecturaValida(dto, equipo);

    // El registro de terreno y el write del contador de la ficha van en la
    // misma transacción: si el update del equipo fallara, no debe quedar un
    // `RegistroHorometro` huérfano que la ficha muestre sin haber movido el
    // contador (o viceversa).
    return this.prisma.$transaction(async (tx) => {
      const registro = await tx.registroHorometro.create({
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

      // El write del valor actual solo aplica al contador que gobierna la
      // unidad (RFC T01 §2, MEJORA-3): HOURS pisa `currentHourmeter`, KM pisa
      // `currentMileage` — nunca los dos a la vez.
      if (dto.valorFinal != null) {
        if (equipo.controlUnit === ControlUnit.HOURS) {
          await tx.equipment.update({
            where: { id: dto.equipoId },
            data: { currentHourmeter: dto.valorFinal },
          });
          // TODO(motor-preventivo): disparar el umbral de Mantenimiento (Joaquín, guía §5).
        } else if (equipo.controlUnit === ControlUnit.KM) {
          await tx.equipment.update({
            where: { id: dto.equipoId },
            data: { currentMileage: dto.valorFinal },
          });
        }
      }

      return registro;
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
      // Con `valorFinal` hay que validar ANTES de escribir: si la lectura no
      // es válida, ni el registro ni el contador se tocan. El equipo se lee
      // una sola vez y se reusa para decidir qué contador pisar.
      let equipoValidado: ContadorActual | null = null;
      if (dto.valorFinal != null) {
        const previo = await tx.registroHorometro.findUnique({
          where: { id },
          select: { valorInicial: true, equipoId: true },
        });
        if (!previo) throw new NotFoundException('Registro no encontrado');

        const equipoActual = await tx.equipment.findUnique({
          where: { id: previo.equipoId },
          select: {
            controlUnit: true,
            currentHourmeter: true,
            currentMileage: true,
          },
        });
        if (!equipoActual) throw new NotFoundException('Equipo no encontrado');

        this.assertLecturaValida(
          { valorInicial: previo.valorInicial, valorFinal: dto.valorFinal },
          equipoActual,
        );
        equipoValidado = equipoActual;
      }

      const reg = await tx.registroHorometro.update({
        where: { id },
        data: dto,
      });

      if (dto.valorFinal != null && equipoValidado) {
        if (equipoValidado.controlUnit === ControlUnit.HOURS) {
          await tx.equipment.update({
            where: { id: reg.equipoId },
            data: { currentHourmeter: dto.valorFinal },
          });
        } else if (equipoValidado.controlUnit === ControlUnit.KM) {
          await tx.equipment.update({
            where: { id: reg.equipoId },
            data: { currentMileage: dto.valorFinal },
          });
        }
      }

      return reg;
    });
  }
}
