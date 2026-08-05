import {
  IsEmail,
  IsIn,
  IsNotEmpty,
  IsString,
  MinLength,
} from 'class-validator';

import { ALL_ROLES, type Role } from '../../auth/roles';

export class CreateUserDto {
  @IsString()
  @IsNotEmpty()
  name!: string;

  @IsEmail()
  email!: string;

  // Better Auth exige mínimo 8 caracteres por defecto para email/password.
  @IsString()
  @MinLength(8)
  password!: string;

  @IsIn(ALL_ROLES)
  role!: Role;
}
