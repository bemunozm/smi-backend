// PROVISIONAL — reemplazar por el guard de sesión de Better Auth (Sprint 0).
import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ROLES_KEY, Rol } from '../decorators/roles.decorator';

@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<Rol[]>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!required || required.length === 0) return true;

    const req = context.switchToHttp().getRequest<{ headers: Record<string, string> }>();
    const rol = req.headers['x-dev-role']?.toUpperCase();
    if (rol && required.includes(rol as Rol)) return true;
    throw new ForbiddenException(`Rol requerido: ${required.join(', ')}`);
  }
}
