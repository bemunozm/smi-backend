import { IsIn, IsOptional, IsString } from 'class-validator';

export class CreateHallazgoDto {
  @IsString()
  equipoId: string;

  @IsString()
  descripcion: string;

  @IsIn(['BAJA', 'MEDIA', 'ALTA', 'CRITICA'])
  prioridad: string;

  @IsOptional()
  @IsString()
  fotoUrl?: string;
}
