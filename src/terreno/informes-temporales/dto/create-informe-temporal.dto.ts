import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayNotEmpty,
  IsArray,
  IsBoolean,
  IsEmpty,
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  ValidateNested,
} from 'class-validator';

import { normalizeObservaciones } from '../../../common/normalize-observaciones';
import { CloseShiftCardDto } from '../../../shifts/dto/close-shift-card.dto';
import { IsDateOnly } from '../../../shifts/date-only';
import { SHIFT_TYPES, type ShiftType } from '../../../shifts/shift-type';

/** Tope de personas por actividad (lo valida el servicio: depende de cuál). */
export const MAX_PERSONAL_POR_ACTIVIDAD = 10;

/** Una persona del informe, en la actividad 1 o 2. */
export class PersonalInformeDto {
  @IsIn([1, 2])
  actividad!: 1 | 2;

  /** Operador del catálogo, si lo es; el personal de apoyo va solo con
   * nombre. Ids `cuid`/UUID: se valida como string, no como UUID. */
  @IsOptional()
  @IsString()
  @MaxLength(64)
  operatorId?: string | null;

  /** Snapshot del nombre: el informe no cambia si el operador se renombra. */
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  nombre!: string;
}

/**
 * El cierre de UNA tarjeta dentro del informe: los mismos campos que
 * `POST /shift-cards/:id/close` más `cardId`. El turno de quien cierra
 * (`shiftDate`/`shiftType`) no aplica — la tarjeta temporal nunca entra a un
 * turno — así que se rechaza si llega (el repo no trae `@nestjs/mapped-types`
 * para un `OmitType`; `@IsEmpty` sobre el campo heredado logra lo mismo).
 */
export class CierreTemporalDto extends CloseShiftCardDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(64)
  cardId!: string;

  @IsEmpty({ message: 'El cierre del informe no lleva turno' })
  shiftDate?: string = undefined;

  @IsEmpty({ message: 'El cierre del informe no lleva turno' })
  shiftType?: ShiftType = undefined;
}

/**
 * `POST /api/informes-temporales` — el cierre agrupado del supervisor
 * temporal: cierra todas sus tarjetas abiertas y registra el informe de la
 * jornada en una sola acción (sin `Shift` ni reporte de salida).
 */
export class CreateInformeTemporalDto {
  /** UUID generado por el cliente: el reintento offline del envío es
   * idempotente (se relee por este id en vez de crear otro). */
  @IsUUID()
  id!: string;

  @IsDateOnly()
  fecha!: string;

  @IsIn(SHIFT_TYPES)
  turno!: ShiftType;

  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  actividad1!: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  actividad2?: string;

  /** Máx. 10 por actividad y la 2 solo con `actividad2`: lo valida el
   * servicio (depende de otros campos). */
  @IsArray()
  @ArrayMaxSize(2 * MAX_PERSONAL_POR_ACTIVIDAD)
  @ValidateNested({ each: true })
  @Type(() => PersonalInformeDto)
  personal!: PersonalInformeDto[];

  /** Mismo normalizado + tope que el resto de observaciones de Terreno. */
  @IsOptional()
  @Transform(({ value }: { value: unknown }) => normalizeObservaciones(value))
  @IsString()
  @MaxLength(1000)
  observaciones?: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  supervisorResponsable1!: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  supervisorResponsable2?: string;

  @IsBoolean()
  fotosEnviadas!: boolean;

  @IsBoolean()
  infoSubidaApp!: boolean;

  @IsArray()
  @ArrayNotEmpty({
    message: 'El informe tiene que cerrar al menos una tarjeta',
  })
  @ArrayMaxSize(20)
  @ValidateNested({ each: true })
  @Type(() => CierreTemporalDto)
  cierres!: CierreTemporalDto[];
}
