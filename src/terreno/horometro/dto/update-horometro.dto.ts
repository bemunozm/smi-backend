import { IsNumber, IsOptional, IsString, Min } from 'class-validator';

export class UpdateHorometroDto {
  @IsOptional()
  @IsNumber()
  @Min(0)
  valorFinal?: number;

  @IsOptional()
  @IsString()
  fotoUrl?: string;
}
