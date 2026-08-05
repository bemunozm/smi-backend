import { IsOptional, IsString } from 'class-validator';

export class UpdateTrabajoExtraDto {
  @IsOptional()
  @IsString()
  fotoUrl?: string;
}
