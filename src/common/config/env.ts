/**
 * Fuente única de verdad de variables de entorno, validadas al cargar este
 * módulo (import-time, fail-fast).
 *
 * Por qué no vive en `ConfigModule`/`ConfigService` de Nest: `src/auth/auth.ts`
 * construye `betterAuth(...)` en import-time (antes de que exista cualquier
 * contenedor de DI de Nest), así que no puede inyectar un `ConfigService`.
 * En vez de tener dos mecanismos de validación de env (uno para `auth.ts`,
 * otro para el resto de la app), todo el mundo — `auth.ts`, `main.ts`, y a
 * futuro los módulos de dominio vía `ConfigModule.forRoot({ isGlobal: true })`
 * — lee de este único objeto `env`.
 *
 * `dotenv/config` se importa acá (no en cada consumidor) para que este sea
 * el único punto que garantiza que `.env` ya está cargado.
 */
import 'dotenv/config';
import { join } from 'node:path';

export interface AppEnv {
  databaseUrl: string;
  betterAuthSecret: string;
  betterAuthUrl: string;
  frontendUrl: string;
  port: number;
  smtpHost: string | undefined;
  smtpPort: number | undefined;
  smtpUser: string | undefined;
  smtpPass: string | undefined;
  smtpFrom: string | undefined;
  smtpSecure: boolean;
  pythonBin: string;
  ocrModelsDir: string;
  ocrThreads: number;
  storageEndpoint: string;
  storagePublicEndpoint: string | undefined;
  storageBucket: string;
  storageAccessKeyId: string;
  storageSecretAccessKey: string;
  storageRegion: string;
  storageForcePathStyle: boolean;
  storageSignedUrlTtlSeconds: number;
}

const MIN_SECRET_LENGTH = 32;
const DEFAULT_FRONTEND_URL = 'http://localhost:5173';
const DEFAULT_PORT = 3000;
const DEFAULT_OCR_THREADS = 2;

// `NODE_ENV` no se usaba en ningún otro lado del backend hasta ahora — acá
// es la única señal para decidir si las vars de STORAGE_* son obligatorias
// (producción, R2) o si se puede caer al MinIO local del docker-compose
// (cualquier otro valor, incluido "test" que usa Jest por defecto).
const isProduction = process.env.NODE_ENV === 'production';

// Deben calzar con `MINIO_ROOT_USER`/`MINIO_ROOT_PASSWORD` de `docker-compose.yml`
// para que el boot funcione en local sin tocar `.env`. Las credenciales se
// exportan (no solo el endpoint/bucket) para que `StorageService.onModuleInit`
// pueda comparar las credenciales EFECTIVAS contra estos defaults y avisar si
// un despliegue real quedó corriendo con ellas (ver SECURITY-NOTES.md, hallazgo
// BAJO B2 de la revisión de seguridad de R2-storage).
const DEFAULT_DEV_STORAGE_ENDPOINT = 'http://localhost:9000';
const DEFAULT_DEV_STORAGE_BUCKET = 'smi-files';
export const DEFAULT_DEV_STORAGE_ACCESS_KEY_ID = 'smi_dev_admin';
export const DEFAULT_DEV_STORAGE_SECRET_ACCESS_KEY = 'smi_dev_admin_secret';
const DEFAULT_DEV_STORAGE_REGION = 'us-east-1';
const DEFAULT_STORAGE_SIGNED_URL_TTL_SECONDS = 3600;
export const MIN_STORAGE_SIGNED_URL_TTL_SECONDS = 60;
// NO es 604800 (el máximo real de SigV4/`getSignedUrl`): `StorageService.sign`
// firma con `expiresIn = TTL + W` donde `W = floor(TTL/2)` (ver Diseño del
// RFC R2-storage, "Firma") — con TTL=604800 eso daría expiresIn=907200,
// que el SDK rechaza. 403200 es el máximo TTL tal que TTL + floor(TTL/2)
// == 604800 exacto (403200 + 201600 = 604800) — ver env.spec.ts.
export const MAX_STORAGE_SIGNED_URL_TTL_SECONDS = 403200;

function required(name: string): string {
  const value = process.env[name];
  if (!value || value.trim().length === 0) {
    throw new Error(
      `Missing required env var: ${name}. Revisa tu .env (ver .env.example).`,
    );
  }
  return value;
}

function validateSecret(value: string): string {
  if (value.length < MIN_SECRET_LENGTH) {
    throw new Error(
      `BETTER_AUTH_SECRET is missing or too weak (need >= ${MIN_SECRET_LENGTH} chars). Generate with: openssl rand -base64 32`,
    );
  }
  return value;
}

function parsePort(rawValue: string | undefined): number {
  if (rawValue === undefined || rawValue.trim().length === 0) {
    return DEFAULT_PORT;
  }
  const parsed = Number(rawValue);
  if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 65535) {
    throw new Error(`Invalid PORT env var: "${rawValue}"`);
  }
  return parsed;
}

/** Igual que `parsePort`, pero sin default: `undefined` cuando no viene seteada (SMTP es opcional). */
function parseOptionalPort(rawValue: string | undefined): number | undefined {
  if (rawValue === undefined || rawValue.trim().length === 0) {
    return undefined;
  }
  const parsed = Number(rawValue);
  if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 65535) {
    throw new Error(`Invalid SMTP_PORT env var: "${rawValue}"`);
  }
  return parsed;
}

function optional(name: string): string | undefined {
  const value = process.env[name];
  return value && value.trim().length > 0 ? value : undefined;
}

function parseBoolean(rawValue: string | undefined): boolean {
  return rawValue?.trim().toLowerCase() === 'true';
}

/** Igual que `parsePort` pero sin tope de 65535 (es un contador de hilos, no un puerto). */
function parseOcrThreads(rawValue: string | undefined): number {
  if (rawValue === undefined || rawValue.trim().length === 0) {
    return DEFAULT_OCR_THREADS;
  }
  const parsed = Number(rawValue);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`Invalid OCR_THREADS env var: "${rawValue}"`);
  }
  return parsed;
}

/**
 * Fuera de producción cae al default (para no romper el boot local ni los
 * specs, que no configuran `.env` de storage). Con `NODE_ENV=production`
 * pasa a ser obligatoria — mismo mensaje de error que `required()`.
 */
function requiredInProductionOr(name: string, devDefault: string): string {
  const value = optional(name);
  if (value !== undefined) {
    return value;
  }
  if (isProduction) {
    return required(name);
  }
  return devDefault;
}

function parseStorageForcePathStyle(rawValue: string | undefined): boolean {
  if (rawValue === undefined || rawValue.trim().length === 0) {
    // MinIO local necesita path-style (no hay subdominio por bucket). R2 y
    // S3 real funcionan con virtual-hosted-style por defecto en producción.
    return !isProduction;
  }
  return parseBoolean(rawValue);
}

export function parseStorageSignedUrlTtlSeconds(
  rawValue: string | undefined,
): number {
  if (rawValue === undefined || rawValue.trim().length === 0) {
    return DEFAULT_STORAGE_SIGNED_URL_TTL_SECONDS;
  }
  const parsed = Number(rawValue);
  if (
    !Number.isInteger(parsed) ||
    parsed < MIN_STORAGE_SIGNED_URL_TTL_SECONDS ||
    parsed > MAX_STORAGE_SIGNED_URL_TTL_SECONDS
  ) {
    throw new Error(
      `Invalid STORAGE_SIGNED_URL_TTL_SECONDS env var: "${rawValue}" (debe ser un entero entre ${MIN_STORAGE_SIGNED_URL_TTL_SECONDS} y ${MAX_STORAGE_SIGNED_URL_TTL_SECONDS})`,
    );
  }
  return parsed;
}

export const env: AppEnv = {
  databaseUrl: required('DATABASE_URL'),
  betterAuthSecret: validateSecret(required('BETTER_AUTH_SECRET')),
  betterAuthUrl: required('BETTER_AUTH_URL'),
  frontendUrl: process.env.FRONTEND_URL ?? DEFAULT_FRONTEND_URL,
  port: parsePort(process.env.PORT),
  // SMTP: todas opcionales a propósito (ver mail/mail.service.ts) — sin
  // host/user/pass configurados, MailService queda en no-op y el boot no se
  // rompe para quien no tenga credenciales de correo en su entorno.
  smtpHost: optional('SMTP_HOST'),
  smtpPort: parseOptionalPort(process.env.SMTP_PORT),
  smtpUser: optional('SMTP_USER'),
  smtpPass: optional('SMTP_PASS'),
  smtpFrom: optional('SMTP_FROM'),
  smtpSecure: parseBoolean(process.env.SMTP_SECURE),
  // Binario de python usado por OcrService para lanzar el worker persistente
  // (ver ocr-python/worker.py). Default 'python3' (así queda en el VPS tras
  // `apt install python3`); en Windows local hace falta apuntarlo al
  // python 3.12 que tiene las deps de ocr-python/requirements.txt
  // instaladas (ver ocr-python/README.md), ej.
  // "C:/Users/<user>/AppData/Local/Programs/Python/Python312/python.exe".
  pythonBin: optional('PYTHON_BIN') ?? 'python3',
  // Carpeta con los 6 archivos de modelo (fuera de git, ver
  // ocr-python/README.md y ocr-python/models.manifest.json). Default:
  // ocr-python/models relativo al cwd del proceso Nest.
  ocrModelsDir:
    optional('OCR_MODELS_DIR') ?? join(process.cwd(), 'ocr-python', 'models'),
  // Hilos para las sesiones ONNX de Florence + el pool global de cv2 dentro
  // del worker (el CRNN queda fijo en 1 hilo, ver ocr-python/worker.py).
  ocrThreads: parseOcrThreads(process.env.OCR_THREADS),
  // Almacenamiento de archivos de Flota (StorageService) — bucket S3-compatible
  // privado, MinIO en local / Cloudflare R2 en producción (ver docker-compose.yml
  // y .env.example). Fuera de producción, defaults calzan con el MinIO del
  // compose para no romper el boot de quien no configuró `.env` para esto.
  storageEndpoint: requiredInProductionOr(
    'STORAGE_ENDPOINT',
    DEFAULT_DEV_STORAGE_ENDPOINT,
  ),
  // Host público (browser-facing) para FIRMAR urls cuando difiere del interno
  // (ej. reverse proxy / dominio distinto al que usa el backend para hablar
  // con el bucket). Siempre opcional, incluso en producción: si no viene, se
  // firma con el mismo endpoint interno.
  storagePublicEndpoint: optional('STORAGE_PUBLIC_ENDPOINT'),
  storageBucket: requiredInProductionOr(
    'STORAGE_BUCKET',
    DEFAULT_DEV_STORAGE_BUCKET,
  ),
  storageAccessKeyId: requiredInProductionOr(
    'STORAGE_ACCESS_KEY_ID',
    DEFAULT_DEV_STORAGE_ACCESS_KEY_ID,
  ),
  storageSecretAccessKey: requiredInProductionOr(
    'STORAGE_SECRET_ACCESS_KEY',
    DEFAULT_DEV_STORAGE_SECRET_ACCESS_KEY,
  ),
  storageRegion: requiredInProductionOr(
    'STORAGE_REGION',
    DEFAULT_DEV_STORAGE_REGION,
  ),
  storageForcePathStyle: parseStorageForcePathStyle(
    process.env.STORAGE_FORCE_PATH_STYLE,
  ),
  storageSignedUrlTtlSeconds: parseStorageSignedUrlTtlSeconds(
    process.env.STORAGE_SIGNED_URL_TTL_SECONDS,
  ),
};
