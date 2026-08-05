import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Req,
} from '@nestjs/common';
import { Roles, Session } from '@thallesp/nestjs-better-auth';
import type { UserSession } from '@thallesp/nestjs-better-auth';
import type { Request } from 'express';

import { ROLES } from '../auth/roles';
import { CreateUserDto } from './dto/create-user.dto';
import { UpdateUserDto } from './dto/update-user.dto';
import type { UserResponseDto } from './dto/user-response.dto';
import { UsersService } from './users.service';

interface UserListResponse {
  data: UserResponseDto[];
  message: string;
}

interface UserDetailResponse {
  data: UserResponseDto;
  message: string;
}

interface UserDeletedResponse {
  data: { id: string };
  message: string;
}

function assertNonEmptyId(id: string): void {
  // Los ids de Better Auth son nanoid/cuid (no UUID) — validación simple de
  // string no vacío, no ParseUUIDPipe.
  if (!id || id.trim().length === 0) {
    throw new BadRequestException('El parámetro "id" no puede estar vacío');
  }
}

// Solo ADMIN: gestión de usuarios es información sensible (roles, estado de
// baneo). El AuthGuard global ya exige sesión; @Roles restringe el rol.
@Roles([ROLES.ADMIN])
@Controller('users')
export class UsersController {
  constructor(private readonly usersService: UsersService) {}

  @Get()
  async findAll(): Promise<UserListResponse> {
    const data = await this.usersService.findAll();
    return { data, message: 'ok' };
  }

  @Get(':id')
  async findOne(@Param('id') id: string): Promise<UserDetailResponse> {
    assertNonEmptyId(id);
    const data = await this.usersService.findOne(id);
    return { data, message: 'ok' };
  }

  @Post()
  async create(
    @Body() dto: CreateUserDto,
    @Req() req: Request,
  ): Promise<UserDetailResponse> {
    const data = await this.usersService.create(dto, req);
    return { data, message: 'Usuario creado' };
  }

  @Patch(':id')
  async update(
    @Param('id') id: string,
    @Body() dto: UpdateUserDto,
    @Session() session: UserSession,
    @Req() req: Request,
  ): Promise<UserDetailResponse> {
    assertNonEmptyId(id);
    const data = await this.usersService.update(id, dto, session.user.id, req);
    return { data, message: 'Usuario actualizado' };
  }

  @Delete(':id')
  async remove(
    @Param('id') id: string,
    @Session() session: UserSession,
    @Req() req: Request,
  ): Promise<UserDeletedResponse> {
    assertNonEmptyId(id);
    await this.usersService.remove(id, session.user.id, req);
    return { data: { id }, message: 'Usuario eliminado' };
  }
}
