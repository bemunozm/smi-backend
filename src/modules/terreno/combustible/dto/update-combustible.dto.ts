import { IsOptional, IsString } from 'class-validator';

export class UpdateCombustibleDto {
  @IsOptional()
  @IsString()
  fotoUrl?: string;
}
