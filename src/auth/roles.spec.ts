import { ALL_ROLES, ROLES, sessionHasRole } from './roles';
import { roles } from './access-control';

describe('rol SUPERVISOR_TEMPORAL', () => {
  it('está en ROLES y en ALL_ROLES con el string exacto', () => {
    expect(ROLES.SUPERVISOR_TEMPORAL).toBe('SUPERVISOR_TEMPORAL');
    expect(ALL_ROLES).toContain('SUPERVISOR_TEMPORAL');
  });

  it('no equivale a SUPERVISOR en sessionHasRole', () => {
    expect(sessionHasRole('SUPERVISOR_TEMPORAL', ROLES.SUPERVISOR)).toBe(false);
    expect(
      sessionHasRole('SUPERVISOR_TEMPORAL', ROLES.SUPERVISOR_TEMPORAL),
    ).toBe(true);
  });

  it('está registrado en el control de acceso de Better Auth', () => {
    expect(roles[ROLES.SUPERVISOR_TEMPORAL]).toBeDefined();
  });
});
