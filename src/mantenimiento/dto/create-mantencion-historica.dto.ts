import { TipoOT } from '@prisma/client';
import {
  IsEnum,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

import { IsDateOnly } from '../../shifts/date-only';

/**
 * `POST /api/mantenimiento/ordenes/historica` — registra una mantención que
 * se hizo ANTES de usar la aplicación (equipos antiguos que entran a Flota
 * con historia previa). Crea una OT ya COMPLETADA cuya única tarea lleva
 * `hechaAt` en la fecha declarada: así la ficha del equipo
 * (`ultimaMantencion`) y el registro «Mantenciones» del admin la fechan igual
 * que una mantención real del taller, sin un modelo paralelo.
 */
export class CreateMantencionHistoricaDto {
  /** Id de Flota o código interno del equipo — misma tolerancia que el resto
   * de las OT (`resolveEquipmentId`); se guarda el código interno. */
  @IsString()
  @IsNotEmpty()
  equipoId!: string;

  /** `YYYY-MM-DD` en que se hizo la mantención. El servicio exige que no sea
   * futura (hoy en horario de faena incluido). */
  @IsDateOnly()
  fecha!: string;

  @IsOptional()
  @IsEnum(TipoOT)
  tipo?: TipoOT;

  /** Qué mantención fue — es el título de la OT y el texto de su tarea
   * («Cambio de aceite y filtros», «Mantención 10.000 km»…). */
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  titulo!: string;

  /**
   * Quién la hizo — texto libre (snapshot en `TareaOT.hechaPorNombre`, el
   * mismo campo que llena el taller al completar una tarea): la hizo alguien
   * que puede no ser usuario del sistema (un taller externo, un mecánico de
   * antes). Alimenta la columna «Mantenedor» del registro y el «Realizada
   * por» del detalle.
   */
  @IsOptional()
  @IsString()
  @MaxLength(120)
  realizadaPor?: string;

  /**
   * Lectura del equipo al momento de la mantención: kilometraje si es
   * liviano, horómetro si es pesado (la unidad la decide el `controlUnit`
   * del equipo; mismos topes que los horómetros de Terreno). Queda como nota
   * de la tarea, visible en el detalle de la mantención.
   */
  @IsOptional()
  @IsNumber({ allowNaN: false, allowInfinity: false })
  @Min(0)
  @Max(1_000_000)
  lectura?: number;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  observaciones?: string;
}
