import { IsIn, IsNumber, IsOptional, IsString } from 'class-validator';

export class CreateHorometroDto {
  @IsString()
  equipoId!: string;

  @IsString()
  operador!: string;

  @IsIn(['DIURNO', 'NOCTURNO'])
  turno!: string;

  @IsNumber()
  valorInicial!: number;

  @IsOptional()
  @IsNumber()
  valorFinal?: number;

  @IsOptional()
  @IsNumber()
  nivelCombustible?: number;
}
