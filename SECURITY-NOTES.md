# Deuda de seguridad diferida — smi-backend

Contexto: la demo actual corre **solo en `localhost`** (backend y frontend en
la misma máquina de desarrollo, sin exposición a internet). Los ítems abajo
son aceptables para ese escenario y quedan **explícitamente diferidos**, no
resueltos. El disparador para resolverlos es único y claro:

> **Cualquier exposición fuera de `localhost`** — deploy a un servidor
> compartido, túnel (ngrok/cloudflared), demo remota, staging, producción —
> obliga a cerrar TODOS los ítems de esta tabla antes de exponer.

| Severidad | Ítem | Acción | Cuándo |
|---|---|---|---|
| M2 | Sin rate limiting en `/sign-in/email` | Habilitar `rateLimit` en `auth.ts` con `customRules` estricto para `/api/auth/sign-in/email` (p. ej. 5 intentos / 60s) — ver skill `better-auth-security-best-practices` | Antes de exponer fuera de localhost |
| M3 | Postgres publica el puerto en `0.0.0.0:5433` | En `docker-compose.yml`, bindear a `127.0.0.1:5433:5432` | Antes de exponer fuera de localhost (o si la máquina de desarrollo comparte red) |
| B2 | Sin `helmet` | Agregar `helmet()` como middleware global en `main.ts` | Antes de exponer fuera de localhost |
| B3 | Cookies sin `useSecureCookies` / `sameSite: 'none'` para cross-domain | En `auth.ts` → `advanced.useSecureCookies: true` y `sameSite` acorde cuando frontend y backend estén en dominios distintos en prod | Cuando el frontend deje de compartir origin/red local con el backend |
| B4 | Expiración de sesión en el default de Better Auth (7 días) | Revisar `session.expiresIn`/`updateAge` según política real del negocio (ej. 8h para roles operativos en planta) | Antes de producción, junto con el equipo de producto |
| — | Credenciales seed compartidas (`Smi123456!`, incl. el usuario `admin@smi.local`) | Rotar o eliminar los 4 usuarios seed y crear cuentas reales con contraseñas únicas por persona | Antes de exponer fuera de localhost (aplica también si se comparte la máquina de desarrollo) |

## Ya resuelto en esta iteración (no diferido)

- **A1** — auto-registro público cerrado (`emailAndPassword.disableSignUp: true`); usuarios solo vía admin plugin/seed.
- **M1** — arranque falla rápido si `BETTER_AUTH_SECRET` falta o es débil (< 32 chars).
- **A2** — el seed de credenciales de desarrollo se niega a correr si `NODE_ENV=production`.
- **M4** — autorización por rol consolidada en el `@Roles()`/`AuthGuard` de `@thallesp/nestjs-better-auth` (se eliminó el guard/decorator propio en `src/common/`, que solo actuaba con `@UseGuards` manual — footgun de autorización silenciosa).
- **B1** — `ValidationPipe` global (`whitelist`+`forbidNonWhitelisted`+`transform`) agregado en `main.ts` al llegar los primeros DTOs de dominio (`UsersModule`: `CreateUserDto`/`UpdateUserDto`).
