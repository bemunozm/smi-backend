import { IsOptional } from 'class-validator';

import { IsDateOnly } from '../../../shifts/date-only';

/** `GET /api/informes-temporales?desde&hasta` — rango inclusivo sobre `fecha`. */
export class QueryInformesTemporalesDto {
  @IsOptional()
  @IsDateOnly()
  desde?: string;

  @IsOptional()
  @IsDateOnly()
  hasta?: string;
}
