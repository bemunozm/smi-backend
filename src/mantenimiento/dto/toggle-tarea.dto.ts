import { IsBoolean } from 'class-validator';

export class ToggleTareaDto {
  @IsBoolean()
  hecha!: boolean;
}
