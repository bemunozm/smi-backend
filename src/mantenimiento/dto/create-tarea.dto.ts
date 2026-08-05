import { IsNotEmpty, IsString } from 'class-validator';

export class CreateTareaDto {
  @IsString()
  @IsNotEmpty()
  texto!: string;
}
