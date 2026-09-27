import { Logger } from '@nestjs/common';
import {
  BadRequestException,
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
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

import { env } from '../common/config/env';
import { buildTmpKey } from './storage-keys';
import { StorageService } from './storage.service';

jest.mock('@aws-sdk/s3-request-presigner');

const mockedGetSignedUrl = getSignedUrl as jest.MockedFunction<
  typeof getSignedUrl
>;

const USER_ID = 'testuser1234567890123456';
const JPEG_BUFFER = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
const GARBAGE_BUFFER = Buffer.from('no soy una imagen', 'utf8');

/**
 * `jest.SpyInstance` sin genéricos tipa `.mock.calls` como `any[][]` — este
 * helper concentra en un solo lugar el `as unknown as` que hace falta para
 * leer el comando real que se le pasó a `S3Client.prototype.send` (mismo
 * patrón que `ocr.service.spec.ts` usa para `child.stdin.write`).
 */
function sentCommand<T>(spy: jest.SpyInstance, callIndex = 0): T {
  const calls = spy.mock.calls as unknown as [T][];
  return calls[callIndex][0];
}

describe('StorageService', () => {
  let service: StorageService;
  let sendSpy: jest.SpyInstance;

  beforeEach(() => {
    service = new StorageService();
    sendSpy = jest.spyOn(S3Client.prototype, 'send');
    mockedGetSignedUrl.mockReset();
    mockedGetSignedUrl.mockResolvedValue('https://minio.local/signed-url');
  });

  afterEach(() => {
    sendSpy.mockRestore();
    jest.restoreAllMocks();
  });

  describe('putTmp', () => {
    it('sube el buffer y devuelve una key tmp/<userId>/<uuid>.jpg', async () => {
      sendSpy.mockResolvedValue({});

      const key = await service.putTmp(USER_ID, JPEG_BUFFER);

      expect(key).toMatch(new RegExp(`^tmp/${USER_ID}/.+\\.jpg$`));
      expect(sendSpy).toHaveBeenCalledTimes(1);
      const command = sentCommand<PutObjectCommand>(sendSpy);
      expect(command).toBeInstanceOf(PutObjectCommand);
      expect(command.input.Key).toBe(key);
      expect(command.input.ContentType).toBe('image/jpeg');
      expect(command.input.CacheControl).toBe(
        'private, max-age=31536000, immutable',
      );
    });

    it('rechaza bytes no reconocidos con 415 y NO llama a S3', async () => {
      await expect(service.putTmp(USER_ID, GARBAGE_BUFFER)).rejects.toThrow(
        UnsupportedMediaTypeException,
      );
      expect(sendSpy).not.toHaveBeenCalled();
    });

    it('mapea un error de red a ServiceUnavailableException', async () => {
      const networkError = Object.assign(new Error('connect ECONNREFUSED'), {
        code: 'ECONNREFUSED',
      });
      sendSpy.mockRejectedValue(networkError);

      await expect(service.putTmp(USER_ID, JPEG_BUFFER)).rejects.toThrow(
        ServiceUnavailableException,
      );
    });

    it('un error que no es de red se propaga tal cual', async () => {
      const otherError = new Error('algo raro pasó');
      sendSpy.mockRejectedValue(otherError);

      await expect(service.putTmp(USER_ID, JPEG_BUFFER)).rejects.toThrow(
        'algo raro pasó',
      );
    });
  });

  describe('claimTmp', () => {
    it('copia a una key final nueva bajo el prefijo del kind', async () => {
      sendSpy.mockResolvedValue({});
      const tmpKey = buildTmpKey(USER_ID, 'jpg');

      const finalKey = await service.claimTmp(
        tmpKey,
        USER_ID,
        'equipment-photo',
      );

      expect(finalKey).toMatch(/^equipment-photos\/.+\.jpg$/);
      expect(sendSpy).toHaveBeenCalledTimes(1);
      const command = sentCommand<CopyObjectCommand>(sendSpy);
      expect(command).toBeInstanceOf(CopyObjectCommand);
      expect(command.input.Key).toBe(finalKey);
      expect(command.input.CopySource).toBe(`${env.storageBucket}/${tmpKey}`);
    });

    it('rechaza una key tmp de otro usuario sin llamar a S3', async () => {
      const tmpKey = buildTmpKey('otroUsuario00000000000000', 'jpg');

      await expect(
        service.claimTmp(tmpKey, USER_ID, 'equipment-photo'),
      ).rejects.toThrow(BadRequestException);
      expect(sendSpy).not.toHaveBeenCalled();
    });

    it('rechaza una extensión no válida para el kind sin llamar a S3', async () => {
      const tmpKey = buildTmpKey(USER_ID, 'pdf');

      await expect(
        service.claimTmp(tmpKey, USER_ID, 'equipment-photo'),
      ).rejects.toThrow(BadRequestException);
      expect(sendSpy).not.toHaveBeenCalled();
    });

    it('mapea NoSuchKey a un 400 en español', async () => {
      const tmpKey = buildTmpKey(USER_ID, 'jpg');
      const noSuchKeyError = Object.assign(new Error('not found'), {
        name: 'NoSuchKey',
      });
      sendSpy.mockRejectedValue(noSuchKeyError);

      await expect(
        service.claimTmp(tmpKey, USER_ID, 'equipment-photo'),
      ).rejects.toThrow(
        'El archivo temporal expiró o no existe, súbelo de nuevo',
      );
    });

    it('mapea NotFound (variante de MinIO) al mismo 400', async () => {
      const tmpKey = buildTmpKey(USER_ID, 'jpg');
      const notFoundError = Object.assign(new Error('not found'), {
        name: 'NotFound',
      });
      sendSpy.mockRejectedValue(notFoundError);

      await expect(
        service.claimTmp(tmpKey, USER_ID, 'equipment-photo'),
      ).rejects.toThrow(BadRequestException);
    });

    it('un error de copy que no es NoSuchKey se propaga tal cual', async () => {
      const tmpKey = buildTmpKey(USER_ID, 'jpg');
      sendSpy.mockRejectedValue(new Error('boom'));

      await expect(
        service.claimTmp(tmpKey, USER_ID, 'equipment-photo'),
      ).rejects.toThrow('boom');
    });
  });

  describe('discard / deleteBestEffort', () => {
    it('deleteBestEffort no lanza cuando S3 responde bien', async () => {
      sendSpy.mockResolvedValue({});
      await expect(
        service.deleteBestEffort('equipment-photos/x.jpg'),
      ).resolves.toBeUndefined();
      const command = sentCommand<DeleteObjectCommand>(sendSpy);
      expect(command).toBeInstanceOf(DeleteObjectCommand);
    });

    it('deleteBestEffort NUNCA lanza, incluso si S3 falla — solo loguea warn', async () => {
      const warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
      sendSpy.mockRejectedValue(new Error('bucket caído'));

      await expect(
        service.deleteBestEffort('equipment-photos/x.jpg'),
      ).resolves.toBeUndefined();
      expect(warnSpy).toHaveBeenCalledTimes(1);
    });

    it('discard es un alias de deleteBestEffort (tampoco lanza)', async () => {
      const warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
      sendSpy.mockRejectedValue(new Error('bucket caído'));

      await expect(service.discard('tmp/x/y.jpg')).resolves.toBeUndefined();
      expect(warnSpy).toHaveBeenCalledTimes(1);
    });

    it('nunca hace batch: siempre un DeleteObjectCommand por llamada', async () => {
      sendSpy.mockResolvedValue({});
      await service.deleteBestEffort('a.jpg');
      await service.deleteBestEffort('b.jpg');
      expect(sendSpy).toHaveBeenCalledTimes(2);
      const calls = sendSpy.mock.calls as unknown as [DeleteObjectCommand][];
      for (const [command] of calls) {
        expect(command).toBeInstanceOf(DeleteObjectCommand);
      }
    });
  });

  describe('sign', () => {
    const REAL_DATE_NOW = Date.now;

    afterEach(() => {
      Date.now = REAL_DATE_NOW;
    });

    it('devuelve la MISMA url dentro de la misma ventana (memo)', async () => {
      Date.now = jest.fn(() => 1_700_000_000_000);
      mockedGetSignedUrl.mockResolvedValueOnce('https://minio.local/signed-1');

      const first = await service.sign('equipment-photos/x.jpg');
      const second = await service.sign('equipment-photos/x.jpg');

      expect(first).toBe('https://minio.local/signed-1');
      expect(second).toBe('https://minio.local/signed-1');
      expect(mockedGetSignedUrl).toHaveBeenCalledTimes(1);
    });

    it('firma de nuevo (url distinta) al cambiar de ventana', async () => {
      const ttl = 3600;
      const windowSeconds = Math.floor(ttl / 2); // 1800

      Date.now = jest.fn(() => 1_700_000_000_000);
      mockedGetSignedUrl.mockResolvedValueOnce('https://minio.local/signed-1');
      const first = await service.sign('equipment-photos/x.jpg');

      Date.now = jest.fn(() => 1_700_000_000_000 + windowSeconds * 1000);
      mockedGetSignedUrl.mockResolvedValueOnce('https://minio.local/signed-2');
      const second = await service.sign('equipment-photos/x.jpg');

      expect(first).toBe('https://minio.local/signed-1');
      expect(second).toBe('https://minio.local/signed-2');
      expect(mockedGetSignedUrl).toHaveBeenCalledTimes(2);
    });

    it('calcula expiresIn = TTL + W y signingDate alineado a la ventana', async () => {
      const ttl = 3600;
      const windowSeconds = Math.floor(ttl / 2);
      const nowMs = 1_700_000_000_000;
      Date.now = jest.fn(() => nowMs);

      await service.sign('equipment-photos/x.jpg');

      expect(mockedGetSignedUrl).toHaveBeenCalledTimes(1);
      const optionsArg = mockedGetSignedUrl.mock.calls[0][2];
      expect(optionsArg?.expiresIn).toBe(ttl + windowSeconds);

      const nowSeconds = Math.floor(nowMs / 1000);
      const windowIndex = Math.floor(nowSeconds / windowSeconds);
      const expectedSigningDate = new Date(windowIndex * windowSeconds * 1000);
      expect(optionsArg?.signingDate).toEqual(expectedSigningDate);
    });

    it('sin fileName no manda ResponseContentDisposition', async () => {
      await service.sign('equipment-photos/x.jpg');
      const command = mockedGetSignedUrl.mock.calls[0][1] as GetObjectCommand;
      expect(command.input.ResponseContentDisposition).toBeUndefined();
    });

    it('con fileName arma el ResponseContentDisposition inline', async () => {
      await service.sign('equipment-documents/x.pdf', {
        fileName: 'revision-tecnica.pdf',
      });
      const command = mockedGetSignedUrl.mock.calls[0][1] as GetObjectCommand;
      expect(command.input.ResponseContentDisposition).toBe(
        `inline; filename="revision-tecnica.pdf"; filename*=UTF-8''revision-tecnica.pdf`,
      );
    });

    it('memoiza por separado la misma key con fileName distinto', async () => {
      Date.now = jest.fn(() => 1_700_000_000_000);
      await service.sign('equipment-documents/x.pdf', { fileName: 'a.pdf' });
      await service.sign('equipment-documents/x.pdf', { fileName: 'b.pdf' });
      expect(mockedGetSignedUrl).toHaveBeenCalledTimes(2);
    });
  });

  describe('onModuleInit', () => {
    // `warnIfUsingDevCredentials` (hallazgo BAJO B2 de la revisión de
    // seguridad) dispara siempre que `NODE_ENV !== 'production'` — estos
    // tests fuerzan `NODE_ENV = 'production'` para aislar el warn del
    // `HeadBucket` (que es lo que ya cubrían antes de ese hallazgo) del warn
    // de credenciales dev, que se prueba aparte más abajo.
    const originalNodeEnv = process.env.NODE_ENV;

    afterEach(() => {
      if (originalNodeEnv === undefined) {
        delete process.env.NODE_ENV;
      } else {
        process.env.NODE_ENV = originalNodeEnv;
      }
    });

    it('no lanza y no loguea warn si el bucket responde y NODE_ENV=production', async () => {
      process.env.NODE_ENV = 'production';
      const warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
      sendSpy.mockResolvedValue({});

      await expect(service.onModuleInit()).resolves.toBeUndefined();
      expect(warnSpy).not.toHaveBeenCalled();
      const command = sentCommand<HeadBucketCommand>(sendSpy);
      expect(command).toBeInstanceOf(HeadBucketCommand);
    });

    it('no lanza pero loguea warn si el bucket no responde (MinIO abajo), con NODE_ENV=production', async () => {
      process.env.NODE_ENV = 'production';
      const warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
      sendSpy.mockRejectedValue(new Error('connect ECONNREFUSED'));

      await expect(service.onModuleInit()).resolves.toBeUndefined();
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(warnSpy.mock.calls[0][0]).toContain(
        'docker compose up -d minio minio-init',
      );
    });

    it('loguea warn de credenciales dev si NODE_ENV no es "production", aunque el bucket responda (hallazgo BAJO B2)', async () => {
      process.env.NODE_ENV = 'development';
      const warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
      sendSpy.mockResolvedValue({});

      await expect(service.onModuleInit()).resolves.toBeUndefined();
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(warnSpy.mock.calls[0][0]).toContain('credenciales de desarrollo');
    });

    it('loguea warn de credenciales dev si las credenciales default apuntan a un endpoint no-localhost, incluso con NODE_ENV=production', async () => {
      process.env.NODE_ENV = 'production';
      const warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
      sendSpy.mockResolvedValue({});
      const originalEndpoint = env.storageEndpoint;
      env.storageEndpoint = 'https://real-bucket.r2.cloudflarestorage.com';

      try {
        await expect(service.onModuleInit()).resolves.toBeUndefined();
        expect(warnSpy).toHaveBeenCalledTimes(1);
        expect(warnSpy.mock.calls[0][0]).toContain(
          'credenciales de desarrollo',
        );
      } finally {
        env.storageEndpoint = originalEndpoint;
      }
    });
  });
});
