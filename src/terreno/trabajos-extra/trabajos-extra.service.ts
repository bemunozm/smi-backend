import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';
import { CreateTrabajoExtraDto } from './dto/create-trabajo-extra.dto';
import { UpdateTrabajoExtraDto } from './dto/update-trabajo-extra.dto';

@Injectable()
export class TrabajosExtraService {
  constructor(private prisma: PrismaService) {}

  async create(dto: CreateTrabajoExtraDto) {
    const equipo = await this.prisma.equipment.findUnique({
      where: { id: dto.equipoId },
    });
    if (!equipo) throw new NotFoundException('Equipo no encontrado');

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
      throw new BadRequestException(
        `El equipo ${equipo.internalCode} tiene un turno en curso y está ocupado. ` +
          'Cerrá la tarjeta del turno antes de registrar un trabajo extraordinario.',
      );
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

    const totalHoras = Number(
      (dto.horometroFinal - dto.horometroInicial).toFixed(2),
    );
    return this.prisma.trabajoExtraordinario.create({
      data: {
        equipoId: dto.equipoId,
        operador: dto.operador,
        faena: dto.faena,
        turno: dto.turno,
        horometroInicial: dto.horometroInicial,
        horometroFinal: dto.horometroFinal,
        totalHoras,
        actividad: dto.actividad,
        descripcion: dto.descripcion,
        observaciones: dto.observaciones ?? null,
      },
    });
  }

  findAll() {
    return this.prisma.trabajoExtraordinario.findMany({
      orderBy: { fecha: 'desc' },
      include: { equipo: { select: { internalCode: true } } },
    });
  }

  async findOne(id: string) {
    const reg = await this.prisma.trabajoExtraordinario.findUnique({
      where: { id },
    });
    if (!reg) throw new NotFoundException('Registro no encontrado');
    return reg;
  }

  update(id: string, dto: UpdateTrabajoExtraDto) {
    return this.prisma.trabajoExtraordinario.update({
      where: { id },
      data: dto,
    });
  }
}
