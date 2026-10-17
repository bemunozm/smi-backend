import { IsOptional } from 'class-validator';

import { IsDateOnly } from '../../shifts/date-only';

export class ResumenDiaQueryDto {
  @IsOptional()
  @IsDateOnly()
  fecha?: string;
}
