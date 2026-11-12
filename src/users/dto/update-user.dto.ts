import {
  IsBoolean,
  IsEmail,
  IsIn,
  IsOptional,
  IsString,
  MinLength,
} from 'class-validator';

import { ALL_ROLES, type Role } from '../../auth/roles';

export class UpdateUserDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  name?: string;

  @IsOptional()
  @IsEmail()
  email?: string;

  @IsOptional()
  @IsIn(ALL_ROLES)
  role?: Role;

  /** Un ADMIN que usa camioneta (RFC-camioneta-administradores). */
  @IsOptional()
  @IsBoolean()
  usesLightVehicle?: boolean;
}
