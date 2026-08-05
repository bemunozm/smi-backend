import { IsIn, IsOptional } from 'class-validator';

export class UpdateHallazgoDto {
  @IsOptional()
  @IsIn(['ABIERTO', 'EN_PROCESO', 'CERRADO'])
  estado?: string;
}
