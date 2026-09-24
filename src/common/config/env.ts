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
}

const MIN_SECRET_LENGTH = 32;
const DEFAULT_FRONTEND_URL = 'http://localhost:5173';
const DEFAULT_PORT = 3000;
const DEFAULT_OCR_THREADS = 2;

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
};
