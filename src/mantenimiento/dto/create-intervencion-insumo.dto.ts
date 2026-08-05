import { IsInt, IsNotEmpty, IsString, Min } from 'class-validator';

export class CreateIntervencionInsumoDto {
  @IsString()
  @IsNotEmpty()
  insumoId!: string;

  @IsInt()
  @Min(1)
  cantidad!: number;
}
