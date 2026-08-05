import { IsIn, IsNumber, IsOptional, IsString } from 'class-validator';

export class CreateHorometroDto {
  @IsString()
  equipoId: string;

  @IsString()
  operadorId: string;

  @IsIn(['MANANA', 'TARDE', 'NOCHE'])
  turno: string;

  @IsNumber()
  valorInicial: number;

  @IsOptional()
  @IsNumber()
  valorFinal?: number;
}
