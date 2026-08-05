import { IsIn, IsNumber, IsOptional, IsPositive, IsString } from 'class-validator';

export class CreateCombustibleDto {
  @IsString()
  equipoId!: string;

  @IsNumber()
  @IsPositive()
  litros!: number;

  @IsIn(['PETROLEO', 'BENCINA'])
  tipo!: string;

  @IsOptional()
  @IsString()
  fotoUrl?: string;
}
