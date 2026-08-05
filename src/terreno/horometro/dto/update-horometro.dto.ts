import { IsNumber, IsOptional } from 'class-validator';

export class UpdateHorometroDto {
  @IsOptional()
  @IsNumber()
  valorFinal?: number;
}
