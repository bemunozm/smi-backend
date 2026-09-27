import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  Param,
  Patch,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import { Roles, Session } from '@thallesp/nestjs-better-auth';
import type { UserSession } from '@thallesp/nestjs-better-auth';
import type { Request } from 'express';

import { ROLES } from '../auth/roles';
import { CreateUserDto } from './dto/create-user.dto';
import { QueryUsersDto } from './dto/query-users.dto';
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

function isAdminSession(session: UserSession): boolean {
  const { role } = session.user;
  return Array.isArray(role)
    ? role.includes(ROLES.ADMIN)
    : role === ROLES.ADMIN;
}

// Solo ADMIN: gestión de usuarios es información sensible (roles, estado de
// baneo). El AuthGuard global ya exige sesión; @Roles restringe el rol.
@Roles([ROLES.ADMIN])
@Controller('users')
export class UsersController {
  constructor(private readonly usersService: UsersService) {}

  /**
   * `?role=` alimenta los pickers de operador/supervisor de la asignación de
   * Flota (`PATCH /api/equipment/:id/assignment`), por eso este método
   * SOBRESCRIBE el gate de clase (`@Roles([ROLES.ADMIN])`) para admitir
   * también SUPERVISOR — de lo contrario un supervisor podría asignar
   * equipos pero no listar a quién asignarles (mismo patrón de override por
   * método que `EquipmentController.updateStatus`). El resto de la gestión
   * de usuarios (crear/editar/banear) se mantiene ADMIN-only.
   *
   * Sin `?role=`, la respuesta es el directorio COMPLETO (email, rol, estado
   * de baneo de TODOS los usuarios, incluidos otros ADMIN) — eso se reserva
   * a ADMIN. Un SUPERVISOR que llame sin `?role=` se rechaza en vez de caer
   * silenciosamente al listado completo: de lo contrario podría enumerar
   * todo el directorio con la excusa de poblar un picker.
   */
  @Roles([ROLES.ADMIN, ROLES.SUPERVISOR])
  @Get()
  async findAll(
    @Query() query: QueryUsersDto,
    @Session() session: UserSession,
  ): Promise<UserListResponse> {
    if (!query.role && !isAdminSession(session)) {
      throw new ForbiddenException(
        'Debes indicar "?role=" para listar usuarios — el directorio completo es solo para ADMIN',
      );
    }
    const data = query.role
      ? await this.usersService.findByRole(query.role)
      : await this.usersService.findAll();
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
