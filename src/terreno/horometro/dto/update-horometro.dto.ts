import { IsNumber, IsOptional, IsString } from 'class-validator';

export class UpdateHorometroDto {
  @IsOptional()
  @IsNumber()
  valorFinal?: number;

  @IsOptional()
  @IsString()
  fotoUrl?: string;
}
