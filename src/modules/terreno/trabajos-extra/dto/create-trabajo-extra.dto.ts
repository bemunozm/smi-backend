import { IsNumber, IsOptional, IsPositive, IsString } from 'class-validator';

export class CreateTrabajoExtraDto {
  @IsString()
  equipoId: string;

  @IsString()
  cliente: string;

  @IsNumber()
  @IsPositive()
  horasMaquina: number;

  @IsOptional()
  @IsNumber()
  tonelaje?: number;

  @IsNumber()
  @IsPositive()
  tarifa: number;

  @IsOptional()
  @IsString()
  fotoUrl?: string;
}
