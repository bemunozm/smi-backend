/**
 * Pipeline de configuración de la app, extraído de `main.ts` para que los
 * tests e2e (`test/*.e2e-spec.ts`) levanten EXACTAMENTE el mismo Nest app
 * (CORS, `ValidationPipe`, prefijo `/api`, estáticos de `/uploads`) que
 * corre en producción — en vez de reimplementar (y potencialmente
 * desincronizar) su propio subset de esa configuración.
 *
 * `NEST_APP_CREATE_OPTIONS` cubre la parte que NO se puede aplicar sobre un
 * `app` ya creado (el `bodyParser: false` se decide en `NestFactory.create`/
 * `TestingModule.createNestApplication`, antes de que exista la instancia) —
 * exportado como un único objeto para que main.ts y los e2e lo compartan sin
 * duplicar el literal.
 */
import { ValidationPipe } from '@nestjs/common';
import type { NestApplicationOptions } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { Response } from 'express';
import { extname, join } from 'path';

import { env } from './common/config/env';

// Extensiones que se sirven `inline` (se ven bien embebidas en un <img>) —
// cualquier otra (hoy solo `.pdf`, ver `imageOrPdfFileFilter`) se fuerza a
// descargar (`Content-Disposition: attachment`) en vez de renderizarse en la
// pestaña, ver hallazgo ALTO A1 de la revisión de seguridad de R2-storage.
const INLINE_STATIC_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp']);

// Better Auth necesita el body sin parsear; el paquete
// @thallesp/nestjs-better-auth re-agrega los parsers por defecto para el
// resto de las rutas.
export const NEST_APP_CREATE_OPTIONS: NestApplicationOptions = {
  bodyParser: false,
};

export function configureApp(app: NestExpressApplication): void {
  // Tier 1 #1: única fuente de verdad de CORS (ver comentario en
  // app.module.ts sobre `disableTrustedOriginsCors`). Methods completos,
  // incluido PATCH, a diferencia del enableCors interno de AuthModule.
  app.enableCors({
    origin: env.frontendUrl,
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  });

  // SECURITY-NOTES.md #B1 (resuelto): con los primeros DTOs de dominio
  // (UsersModule) ya hay body propio que validar fuera de Better Auth.
  // `whitelist` descarta props no declaradas en el DTO; `forbidNonWhitelisted`
  // rechaza la request si venían props extra (en vez de solo ignorarlas).
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );

  // Prefijo global para las rutas propias de la API. No afecta al handler
  // de Better Auth: éste se registra como middleware crudo sobre su propio
  // basePath ('/api/auth'), al margen del prefijo global de Nest.
  app.setGlobalPrefix('api');

  // Sirve las imágenes subidas (módulo terreno/uploads) en
  // http://localhost:PORT/uploads/... — fuera del prefijo /api.
  //
  // `setHeaders` (hallazgo ALTO A1 de la revisión de seguridad): aunque
  // `UploadsController` ya solo escribe a disco archivos cuyos bytes reales
  // matchearon una firma soportada (jpg/png/webp/pdf, ver
  // `detectFileSignature`), estos headers son defensa en profundidad para
  // que el navegador NUNCA reinterprete/ejecute lo servido acá como HTML/JS
  // aunque algún día un archivo inesperado termine en la carpeta:
  //   - `X-Content-Type-Options: nosniff` — el browser no adivina un tipo
  //     distinto al `Content-Type` que ya calcula `express.static` por
  //     extensión, cerrando el MIME-sniffing que habilita el XSS.
  //   - `Content-Security-Policy: default-src 'none'; sandbox` — aunque
  //     igual se sirviera un HTML, no podría ejecutar scripts, cargar
  //     recursos externos ni tener origin propio (sandbox sin `allow-*`).
  //   - `Content-Disposition: attachment` en todo lo que no sea imagen
  //     (hoy: PDF) — se descarga en vez de abrirse inline en la pestaña.
  app.useStaticAssets(join(process.cwd(), 'uploads'), {
    prefix: '/uploads/',
    setHeaders: (res: Response, path: string) => {
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
      if (!INLINE_STATIC_EXTENSIONS.has(extname(path).toLowerCase())) {
        res.setHeader('Content-Disposition', 'attachment');
      }
    },
  });
}
