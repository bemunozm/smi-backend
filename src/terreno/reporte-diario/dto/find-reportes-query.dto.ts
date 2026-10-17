import { IsIn, IsOptional } from 'class-validator';

import { IsDateOnly } from '../../../shifts/date-only';
import { SHIFT_TYPES, type ShiftType } from '../../../shifts/shift-type';

export class FindReportesQueryDto {
  @IsOptional()
  @IsDateOnly()
  desde?: string;

  @IsOptional()
  @IsDateOnly()
  hasta?: string;

  @IsOptional()
  @IsIn(SHIFT_TYPES)
  turno?: ShiftType;
}
