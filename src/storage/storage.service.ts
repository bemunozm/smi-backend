/**
 * Cliente S3-compatible (MinIO en local, Cloudflare R2 en producción) para
 * los 3 usos de Flota — ver Diseño del RFC R2-storage. Los clientes S3 son
 * perezosos (se crean recién al primer uso real), igual que el transport de
 * `MailService` (ver `src/mail/mail.service.ts`).
 *
 * IMPORTANTE: nunca loguear una URL firmada ni las credenciales — una URL
 * firmada ES una credencial de acceso temporal al archivo.
 */
import {
  BadRequestException,
  Injectable,
  Logger,
  OnModuleInit,
  ServiceUnavailableException,
  UnsupportedMediaTypeException,
} from '@nestjs/common';
import {
  CopyObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  PutObjectCommand,
  S3Client,
  type S3ClientConfig,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

import {
  DEFAULT_DEV_STORAGE_ACCESS_KEY_ID,
  DEFAULT_DEV_STORAGE_SECRET_ACCESS_KEY,
  env,
} from '../common/config/env';
import { buildContentDisposition } from './content-disposition';
import { detectFileSignature } from './file-signature';
import {
  assertOwnedTmpKey,
  buildFinalKey,
  buildTmpKey,
  type FileKind,
} from './storage-keys';

const TMP_CACHE_CONTROL = 'private, max-age=31536000, immutable';
const NETWORK_ERROR_CODES = new Set([
  'ECONNREFUSED',
  'ENOTFOUND',
  'ETIMEDOUT',
  'ECONNRESET',
  'EAI_AGAIN',
]);
const MAX_MEMOIZED_SIGNED_URLS = 500;

export interface SignOptions {
  readonly fileName?: string;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

function readString(
  record: Record<string, unknown> | undefined,
  key: string,
): string | undefined {
  const value = record?.[key];
  return typeof value === 'string' ? value : undefined;
}

/** Cubre tanto errores planos (`error.code`) como el `cause` que envuelve el SDK. */
function getNetworkErrorCode(error: unknown): string | undefined {
  const record = asRecord(error);
  return (
    readString(record, 'code') ?? readString(asRecord(record?.cause), 'code')
  );
}

/** Los SDK de AWS exponen el código de error S3 en `.name` o, en algunos casos, `.Code`. */
function getAwsErrorName(error: unknown): string | undefined {
  const record = asRecord(error);
  return readString(record, 'name') ?? readString(record, 'Code');
}

@Injectable()
export class StorageService implements OnModuleInit {
  private readonly logger = new Logger(StorageService.name);
  private client: S3Client | undefined;
  private signerClient: S3Client | undefined;
  private readonly signedUrlCache = new Map<string, string>();

  /** `HeadBucket` no bloqueante — solo avisa si el bucket no es alcanzable. */
  async onModuleInit(): Promise<void> {
    this.warnIfUsingDevCredentials();

    try {
      await this.getClient().send(
        new HeadBucketCommand({ Bucket: env.storageBucket }),
      );
    } catch (error) {
      this.logger.warn(
        `No se pudo verificar el bucket de storage "${env.storageBucket}" — ` +
          `¿MinIO está arriba? En local: "docker compose up -d minio minio-init". ` +
          `(${this.describeError(error)})`,
      );
    }
  }

  /**
   * Aviso best-effort (nunca bloquea el boot) para que un despliegue real no
   * quede corriendo en silencio con las credenciales de desarrollo de MinIO
   * — ver SECURITY-NOTES.md, hallazgo BAJO B2 de la revisión de seguridad.
   * Dispara si:
   *   (a) las credenciales efectivas son EXACTAMENTE las del MinIO de
   *       `docker-compose.yml` pero el endpoint NO es localhost (alguien
   *       pegó las credenciales de ejemplo en un `.env` real apuntando a un
   *       bucket remoto), o
   *   (b) `NODE_ENV` no es `"production"` (recordatorio general en
   *       cualquier arranque local/test/staging — con `NODE_ENV=production`
   *       las `STORAGE_*` ya son obligatorias vía `requiredInProductionOr`,
   *       así que caer en dev-defaults ahí solo puede pasar por (a)).
   */
  private warnIfUsingDevCredentials(): void {
    const usingDevCredentials =
      env.storageAccessKeyId === DEFAULT_DEV_STORAGE_ACCESS_KEY_ID &&
      env.storageSecretAccessKey === DEFAULT_DEV_STORAGE_SECRET_ACCESS_KEY;
    const endpointIsLocalhost = this.isLocalhostEndpoint(env.storageEndpoint);
    const notProduction = process.env.NODE_ENV !== 'production';

    if ((usingDevCredentials && !endpointIsLocalhost) || notProduction) {
      this.logger.warn(
        'Storage usando credenciales de desarrollo (MinIO local) — en ' +
          'producción definir NODE_ENV=production y STORAGE_*',
      );
    }
  }

  private isLocalhostEndpoint(endpoint: string): boolean {
    try {
      const { hostname } = new URL(endpoint);
      return hostname === 'localhost' || hostname === '127.0.0.1';
    } catch {
      return false;
    }
  }

  /** Sube a `tmp/<userId>/…`. Lanza 415 si los bytes no matchean un formato soportado. */
  async putTmp(userId: string, buffer: Buffer): Promise<string> {
    const signature = detectFileSignature(buffer);
    if (!signature) {
      throw new UnsupportedMediaTypeException(
        'El archivo no es una imagen (JPEG/PNG/WebP) ni un PDF válido',
      );
    }

    const key = buildTmpKey(userId, signature.ext);
    try {
      await this.getClient().send(
        new PutObjectCommand({
          Bucket: env.storageBucket,
          Key: key,
          Body: buffer,
          ContentType: signature.contentType,
          CacheControl: TMP_CACHE_CONTROL,
        }),
      );
    } catch (error) {
      if (this.isNetworkError(error)) {
        throw new ServiceUnavailableException(
          'El almacenamiento de archivos no está disponible, intenta de nuevo',
        );
      }
      throw error;
    }
    return key;
  }

  /**
   * Copia `tmp/<userId>/…` a una key final nueva bajo el prefijo de `kind`.
   * NO borra el tmp (lo limpia el lifecycle a 1 día) — el llamador (servicio
   * de dominio) decide si además hay que borrar una key vieja reemplazada.
   */
  async claimTmp(
    tmpKey: string,
    userId: string,
    kind: FileKind,
  ): Promise<string> {
    const { ext } = assertOwnedTmpKey(tmpKey, userId, kind);
    const finalKey = buildFinalKey(kind, ext);

    try {
      await this.getClient().send(
        new CopyObjectCommand({
          Bucket: env.storageBucket,
          CopySource: this.buildCopySource(tmpKey),
          Key: finalKey,
        }),
      );
    } catch (error) {
      if (this.isNoSuchKey(error)) {
        throw new BadRequestException(
          'El archivo temporal expiró o no existe, súbelo de nuevo',
        );
      }
      throw error;
    }

    return finalKey;
  }

  /** Alias semántico de `deleteBestEffort`, para cuando se descarta una copia recién creada. */
  async discard(key: string): Promise<void> {
    await this.deleteBestEffort(key);
  }

  /**
   * `DeleteObject` individual — NUNCA batch (ver Diseño del RFC). Nunca
   * lanza: un objeto huérfano se resuelve manualmente o vía lifecycle, pero
   * un borrado best-effort fallido no debe tumbar el flujo de dominio que ya
   * persistió en la base de datos.
   */
  async deleteBestEffort(key: string): Promise<void> {
    try {
      await this.getClient().send(
        new DeleteObjectCommand({ Bucket: env.storageBucket, Key: key }),
      );
    } catch (error) {
      this.logger.warn(
        `No se pudo borrar el objeto "${key}" (${this.describeError(error)})`,
      );
    }
  }

  /**
   * URL firmada con ventana estable (ver Diseño del RFC, "Firma"): dentro de
   * la misma ventana de `W = floor(TTL/2)` segundos siempre se devuelve la
   * MISMA url (memoizada), para no romper formularios abiertos, aprovechar
   * el caché HTTP y no llenar el service worker de URLs distintas para el
   * mismo archivo. `expiresIn = TTL + W` asegura que la url siga siendo
   * válida hasta el final de la ventana en la que se emitió.
   */
  async sign(key: string, opts?: SignOptions): Promise<string> {
    const ttlSeconds = env.storageSignedUrlTtlSeconds;
    const windowSeconds = Math.floor(ttlSeconds / 2);
    const nowSeconds = Math.floor(Date.now() / 1000);
    const windowIndex = Math.floor(nowSeconds / windowSeconds);
    const signingDate = new Date(windowIndex * windowSeconds * 1000);
    const expiresIn = ttlSeconds + windowSeconds;

    const fileName = opts?.fileName;
    const cacheKey = `${key}::${fileName ?? ''}::${windowIndex}`;
    const cached = this.signedUrlCache.get(cacheKey);
    if (cached) {
      return cached;
    }

    const command = new GetObjectCommand({
      Bucket: env.storageBucket,
      Key: key,
      ResponseContentDisposition: fileName
        ? buildContentDisposition(fileName, key)
        : undefined,
    });

    const url = await getSignedUrl(this.getSignerClient(), command, {
      expiresIn,
      signingDate,
    });

    this.memoize(cacheKey, url);
    return url;
  }

  private memoize(cacheKey: string, url: string): void {
    if (this.signedUrlCache.size >= MAX_MEMOIZED_SIGNED_URLS) {
      const [oldestKey] = this.signedUrlCache.keys();
      this.signedUrlCache.delete(oldestKey);
    }
    this.signedUrlCache.set(cacheKey, url);
  }

  /** `CopySource` de S3 es `bucket/key`, con cada segmento URL-encoded. */
  private buildCopySource(tmpKey: string): string {
    const encodedKey = tmpKey.split('/').map(encodeURIComponent).join('/');
    return `${encodeURIComponent(env.storageBucket)}/${encodedKey}`;
  }

  private getClient(): S3Client {
    if (!this.client) {
      this.client = new S3Client(this.buildClientConfig(env.storageEndpoint));
    }
    return this.client;
  }

  /** Cliente separado para firmar: usa el endpoint PÚBLICO cuando difiere del interno. */
  private getSignerClient(): S3Client {
    if (!this.signerClient) {
      const endpoint = env.storagePublicEndpoint ?? env.storageEndpoint;
      this.signerClient = new S3Client(this.buildClientConfig(endpoint));
    }
    return this.signerClient;
  }

  private buildClientConfig(endpoint: string): S3ClientConfig {
    return {
      endpoint,
      region: env.storageRegion,
      forcePathStyle: env.storageForcePathStyle,
      credentials: {
        accessKeyId: env.storageAccessKeyId,
        secretAccessKey: env.storageSecretAccessKey,
      },
      // MinIO y R2 no siempre negocian los headers de checksum CRC32 igual
      // que S3 real — "WHEN_REQUIRED" solo los exige cuando la operación
      // realmente los necesita, en vez del default más estricto del SDK.
      requestChecksumCalculation: 'WHEN_REQUIRED',
      responseChecksumValidation: 'WHEN_REQUIRED',
    };
  }

  private isNetworkError(error: unknown): boolean {
    const code = getNetworkErrorCode(error);
    return code !== undefined && NETWORK_ERROR_CODES.has(code);
  }

  private isNoSuchKey(error: unknown): boolean {
    const name = getAwsErrorName(error);
    return name === 'NoSuchKey' || name === 'NotFound';
  }

  private describeError(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}
