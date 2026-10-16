import { IsOptional } from 'class-validator';

import { IsDateOnly } from '../../shifts/date-only';

export class DashboardRangeDto {
  @IsOptional()
  @IsDateOnly()
  desde?: string;

  @IsOptional()
  @IsDateOnly()
  hasta?: string;
}
