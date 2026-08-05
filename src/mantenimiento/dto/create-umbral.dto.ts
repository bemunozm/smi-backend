import { IsInt, IsNotEmpty, IsString, Min } from 'class-validator';

export class CreateUmbralDto {
  @IsString()
  @IsNotEmpty()
  tipoEquipo!: string;

  @IsString()
  @IsNotEmpty()
  tipoMantencion!: string;

  @IsInt()
  @Min(1)
  umbralHoras!: number;
}
