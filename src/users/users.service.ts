import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { APIError } from 'better-auth';
import { fromNodeHeaders } from 'better-auth/node';
import type { Request } from 'express';

import { auth } from '../auth/auth';
import { PrismaService } from '../common/prisma/prisma.service';
import type { CreateUserDto } from './dto/create-user.dto';
import type { UpdateUserDto } from './dto/update-user.dto';
import type { UserResponseDto } from './dto/user-response.dto';
import { ROLES } from '../auth/roles';

// `select` explícito (no `select *`/objeto Prisma crudo): así el shape
// público nunca se desincroniza en silencio si el modelo Prisma gana campos
// nuevos (p. ej. banReason/banExpires, o algo que agregue un futuro plugin).
const USER_SELECT = {
  id: true,
  name: true,
  email: true,
  emailVerified: true,
  image: true,
  role: true,
  banned: true,
  createdAt: true,
  updatedAt: true,
} as const;

interface SelectedUser {
  id: string;
  name: string;
  email: string;
  emailVerified: boolean;
  image: string | null;
  role: string;
  banned: boolean | null;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Shape mínimo común entre una fila `select`-eada de Prisma y el `user` que
 * devuelven `auth.api.createUser`/`setRole`/`adminUpdateUser` — este último
 * puede traer `role`/`image`/`banned` como `undefined` (campos opcionales
 * del modelo interno de Better Auth) en vez de `null`, así que el mapper los
 * normaliza.
 */
interface AuthApiUserLike {
  id: string;
  name: string;
  email: string;
  emailVerified: boolean;
  image?: string | null | undefined;
  role?: string | string[] | undefined;
  banned?: boolean | null | undefined;
  createdAt: Date;
  updatedAt: Date;
}

// Códigos de Better Auth que representan un conflicto de recurso (email ya
// registrado) — se traducen a 409, a diferencia del resto de errores del
// plugin admin que Better Auth ya marca como BAD_REQUEST/FORBIDDEN/etc.
const CONFLICT_CODES: ReadonlySet<string> = new Set([
  'USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL',
  'USER_ALREADY_EXISTS',
]);

@Injectable()
export class UsersService {
  private readonly logger = new Logger(UsersService.name);

  constructor(private readonly prisma: PrismaService) {}

  async findAll(): Promise<UserResponseDto[]> {
    const users = await this.prisma.user.findMany({
      select: USER_SELECT,
      orderBy: { createdAt: 'asc' },
    });
    return users.map((user) => this.toResponseDto(user));
  }

  async findOne(id: string): Promise<UserResponseDto> {
    const user = await this.findSelectedUserOrThrow(id);
    return this.toResponseDto(user);
  }

  /**
   * Crea el usuario vía `auth.api.createUser` (plugin admin) — nunca un
   * insert directo a Prisma — para que el password quede hasheado como
   * Better Auth espera y el `role` quede validado contra `ac`/`roles`.
   * Reenvía los headers de la request entrante (cookie de sesión del ADMIN
   * que llama) para que Better Auth corra su propio `hasPermission` real en
   * vez de tratar la llamada como "server call de confianza" sin chequeo.
   */
  async create(dto: CreateUserDto, req: Request): Promise<UserResponseDto> {
    try {
      const result = await auth.api.createUser({
        headers: fromNodeHeaders(req.headers),
        body: {
          email: dto.email,
          password: dto.password,
          name: dto.name,
          role: dto.role,
        },
      });
      this.logger.log(`Usuario creado: ${result.user.email} (${dto.role})`);
      return this.toResponseDto(result.user);
    } catch (error) {
      return this.translateAuthApiError(error, 'No se pudo crear el usuario');
    }
  }

  /**
   * Actualiza rol (vía `auth.api.setRole`) y/o name/email (vía
   * `auth.api.adminUpdateUser`) — son dos endpoints distintos del plugin
   * admin, así que se llaman por separado cuando corresponde y se
   * re-consulta el usuario al final para devolver el estado consolidado.
   *
   * Guard rail anti-lockout: un ADMIN no puede quitarse su propio rol ADMIN.
   */
  async update(
    id: string,
    dto: UpdateUserDto,
    actingAdminId: string,
    req: Request,
  ): Promise<UserResponseDto> {
    await this.findSelectedUserOrThrow(id);

    if (
      id === actingAdminId &&
      dto.role !== undefined &&
      dto.role !== ROLES.ADMIN
    ) {
      throw new ForbiddenException('No puedes quitarte tu propio rol de ADMIN');
    }

    const headers = fromNodeHeaders(req.headers);

    if (dto.role !== undefined) {
      try {
        await auth.api.setRole({
          headers,
          body: { userId: id, role: dto.role },
        });
      } catch (error) {
        this.translateAuthApiError(
          error,
          'No se pudo actualizar el rol del usuario',
        );
      }
    }

    const otherFields: Record<string, string> = {};
    if (dto.name !== undefined) {
      otherFields.name = dto.name;
    }
    if (dto.email !== undefined) {
      otherFields.email = dto.email;
    }

    if (Object.keys(otherFields).length > 0) {
      try {
        await auth.api.adminUpdateUser({
          headers,
          body: { userId: id, data: otherFields },
        });
      } catch (error) {
        this.translateAuthApiError(error, 'No se pudo actualizar el usuario');
      }
    }

    this.logger.log(`Usuario actualizado: ${id}`);
    return this.findOne(id);
  }

  /**
   * Elimina el usuario (sesiones + accounts incluidos) vía
   * `auth.api.removeUser`. Guard rail anti-lockout: un ADMIN no puede
   * eliminarse a sí mismo.
   */
  async remove(id: string, actingAdminId: string, req: Request): Promise<void> {
    await this.findSelectedUserOrThrow(id);

    if (id === actingAdminId) {
      throw new ForbiddenException('No puedes eliminarte a ti mismo');
    }

    try {
      await auth.api.removeUser({
        headers: fromNodeHeaders(req.headers),
        body: { userId: id },
      });
      this.logger.log(`Usuario eliminado: ${id}`);
    } catch (error) {
      this.translateAuthApiError(error, 'No se pudo eliminar el usuario');
    }
  }

  private async findSelectedUserOrThrow(id: string): Promise<SelectedUser> {
    const user = await this.prisma.user.findUnique({
      where: { id },
      select: USER_SELECT,
    });

    if (!user) {
      throw new NotFoundException(`Usuario con id "${id}" no encontrado`);
    }

    return user;
  }

  private toResponseDto(user: SelectedUser | AuthApiUserLike): UserResponseDto {
    return {
      id: user.id,
      name: user.name,
      email: user.email,
      emailVerified: user.emailVerified,
      image: user.image ?? null,
      role: this.normalizeRole(user.role),
      banned: user.banned ?? null,
      createdAt: user.createdAt.toISOString(),
      updatedAt: user.updatedAt.toISOString(),
    };
  }

  private normalizeRole(role: string | string[] | undefined): string {
    if (!role) {
      return ROLES.OPERADOR;
    }
    return Array.isArray(role) ? (role[0] ?? ROLES.OPERADOR) : role;
  }

  /**
   * Traduce errores de `auth.api.*` (instancias de `APIError`, ver
   * better-call) a excepciones Nest — el filtro global ya las formatea a
   * `{data,message}`. El email duplicado es el único código que Better Auth
   * marca como BAD_REQUEST pero que a nivel de nuestra API es más correcto
   * exponer como 409 Conflict.
   */
  private translateAuthApiError(
    error: unknown,
    fallbackMessage: string,
  ): never {
    if (error instanceof APIError) {
      const code = error.body?.code;
      const message = error.body?.message ?? error.message ?? fallbackMessage;

      if (code && CONFLICT_CODES.has(code)) {
        throw new ConflictException(message);
      }

      switch (error.status) {
        case 'FORBIDDEN':
          throw new ForbiddenException(message);
        case 'UNAUTHORIZED':
          throw new UnauthorizedException(message);
        case 'NOT_FOUND':
          throw new NotFoundException(message);
        default:
          throw new BadRequestException(message);
      }
    }

    this.logger.error(
      fallbackMessage,
      error instanceof Error ? error.stack : undefined,
    );
    throw new BadRequestException(fallbackMessage);
  }
}
