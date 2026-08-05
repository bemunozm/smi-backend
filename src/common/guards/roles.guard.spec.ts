import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { RolesGuard } from './roles.guard';

function build(role: string | undefined, required: string[] | undefined) {
  const reflector = { getAllAndOverride: () => required } as unknown as Reflector;
  const guard = new RolesGuard(reflector);
  const context = {
    switchToHttp: () => ({ getRequest: () => ({ headers: role ? { 'x-dev-role': role } : {} }) }),
    getHandler: () => null,
    getClass: () => null,
  } as unknown as ExecutionContext;
  return { guard, context };
}

describe('RolesGuard', () => {
  it('permite cuando no hay roles requeridos', () => {
    const { guard, context } = build(undefined, undefined);
    expect(guard.canActivate(context)).toBe(true);
  });

  it('permite cuando el rol coincide', () => {
    const { guard, context } = build('supervisor', ['SUPERVISOR', 'ADMIN']);
    expect(guard.canActivate(context)).toBe(true);
  });

  it('rechaza cuando el rol no coincide', () => {
    const { guard, context } = build('operador', ['ADMIN']);
    expect(() => guard.canActivate(context)).toThrow(ForbiddenException);
  });
});
