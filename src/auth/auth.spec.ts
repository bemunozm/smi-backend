import { env } from '../common/config/env';
import { auth } from './auth';

/**
 * Detrás del proxy (Traefik) Better Auth solo ve la IP real del cliente si
 * `advanced.ipAddress.ipAddressHeaders` apunta al header correcto.
 */
describe('auth — IP del cliente', () => {
  it('recibe los headers de IP configurados en env', () => {
    expect(auth.options.advanced?.ipAddress?.ipAddressHeaders).toEqual([
      ...env.authIpAddressHeaders,
    ]);
  });
});
