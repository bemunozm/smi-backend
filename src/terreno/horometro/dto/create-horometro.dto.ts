import {
  IsIn,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  Min,
} from 'class-validator';

export class CreateHorometroDto {
  @IsString()
  equipoId!: string;

  @IsString()
  operador!: string;

  @IsIn(['DIURNO', 'NOCTURNO'])
  turno!: string;

  @IsNumber()
  @Min(0)
  valorInicial!: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  valorFinal?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(100)
  nivelCombustible?: number;

  @IsOptional()
  @IsString()
  fotoUrl?: string;
}
