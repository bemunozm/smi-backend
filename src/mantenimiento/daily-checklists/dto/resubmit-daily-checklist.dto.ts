import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Min,
  ValidateNested,
} from 'class-validator';

import { DailyChecklistEntryDto } from './submit-daily-checklist.dto';

/**
 * El checklist corregido tras un rechazo del supervisor: el mismo equipo y
 * día, con todo lo declarado de nuevo. Vuelve a quedar por validar.
 */
export class ResubmitDailyChecklistDto {
  /**
   * El envío que se está corrigiendo (`submissionCount` del rechazado). Hace
   * idempotente el reintento sin señal: si ya se reenvió, se devuelve tal cual.
   */
  @IsInt()
  @Min(1)
  submission!: number;

  @IsNumber(
    { allowNaN: false, allowInfinity: false },
    { message: 'Anota el horómetro u odómetro del equipo.' },
  )
  counter!: number;

  @IsOptional()
  @IsString()
  branchId?: string;

  @IsArray()
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => DailyChecklistEntryDto)
  entries!: DailyChecklistEntryDto[];
}
