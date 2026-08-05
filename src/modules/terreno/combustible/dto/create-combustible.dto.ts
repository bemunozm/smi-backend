import { IsNumber, IsOptional, IsPositive, IsString } from 'class-validator';

export class CreateCombustibleDto {
  @IsString()
  equipoId: string;

  @IsNumber()
  @IsPositive()
  litros: number;

  @IsOptional()
  @IsString()
  fotoUrl?: string;

  @IsOptional()
  @IsNumber()
  lecturaActual?: number;
}
