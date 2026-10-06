import { Logger } from '@nestjs/common';

import { env } from '../common/config/env';
import { OcrService } from './ocr.service';

// El worker real (dos modelos ONNX) NO corre en CI (ver
// `ocr.integration.spec.ts` para eso, opcional): acá se mockea `fetch`
// global. Los timers falsos solo se activan en el test de timeout — el resto
// resuelve promesas sin depender del reloj.

const DEGRADED = { value: null, status: 'UNREADABLE', confidence: 0 };
const OK_RESPONSE = {
  value: '183.089',
  status: 'CONFIRMED',
  confidence: 0.42,
  florence: { liters: '183.089', confidence: 0.42, raw: '183.089' },
  crnn: { liters: '183.089', confidence: 0.87, raw: '183089' },
  ms: 612.3,
};
const READ_URL = `${env.ocrWorkerUrl}/read`;
const HEALTH_URL = `${env.ocrWorkerUrl}/health`;

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** Un `fetch` que no responde hasta que se aborte su `signal` (worker colgado). */
function hangingUntilAborted(
  _input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  return new Promise((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => {
      reject(new DOMException('The operation was aborted', 'AbortError'));
    });
  });
}

describe('OcrService', () => {
  let service: OcrService;
  let fetchMock: jest.SpiedFunction<typeof fetch>;
  let logSpy: jest.SpyInstance;
  let warnSpy: jest.SpyInstance;
  const image = Buffer.from('fake-jpeg-bytes');

  beforeEach(() => {
    logSpy = jest
      .spyOn(Logger.prototype, 'log')
      .mockImplementation(() => undefined);
    warnSpy = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    fetchMock = jest.spyOn(globalThis, 'fetch');
    service = new OcrService();
  });

  afterEach(() => {
    service.onModuleDestroy();
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('devuelve la lectura del worker (value, status, confidence)', async () => {
    fetchMock.mockResolvedValue(jsonResponse(OK_RESPONSE));

    const result = await service.readFuelValue(image);

    expect(result).toEqual({
      value: '183.089',
      status: 'CONFIRMED',
      confidence: 0.42,
    });
  });

  it('manda los bytes de la foto tal cual por POST /read', async () => {
    fetchMock.mockResolvedValue(jsonResponse(OK_RESPONSE));

    await service.readFuelValue(image);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(READ_URL);
    expect(init?.method).toBe('POST');
    expect(Buffer.from(init?.body as Uint8Array).equals(image)).toBe(true);
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  it('propaga REVIEW y UNREADABLE tal como los reporta el worker', async () => {
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse({ ...OK_RESPONSE, status: 'REVIEW', confidence: 0.3 }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          ...OK_RESPONSE,
          value: null,
          status: 'UNREADABLE',
          confidence: 0,
        }),
      );

    await expect(service.readFuelValue(image)).resolves.toEqual({
      value: '183.089',
      status: 'REVIEW',
      confidence: 0.3,
    });
    await expect(service.readFuelValue(image)).resolves.toEqual(DEGRADED);
  });

  describe('cola serial', () => {
    it('no manda la segunda request hasta que la primera resolvió', async () => {
      const first = deferred<Response>();
      fetchMock
        .mockReturnValueOnce(first.promise)
        .mockResolvedValueOnce(
          jsonResponse({ ...OK_RESPONSE, value: '200.000' }),
        );

      const p1 = service.readFuelValue(image);
      const p2 = service.readFuelValue(image);
      await new Promise((resolve) => setImmediate(resolve));

      expect(fetchMock).toHaveBeenCalledTimes(1);

      first.resolve(jsonResponse(OK_RESPONSE));
      const [r1, r2] = await Promise.all([p1, p2]);

      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(r1.value).toBe('183.089');
      expect(r2.value).toBe('200.000');
    });

    it('una request fallida no envenena la cola de las siguientes', async () => {
      fetchMock
        .mockRejectedValueOnce(new TypeError('fetch failed'))
        .mockResolvedValueOnce(jsonResponse(OK_RESPONSE));

      const [r1, r2] = await Promise.all([
        service.readFuelValue(image),
        service.readFuelValue(image),
      ]);

      expect(r1).toEqual(DEGRADED);
      expect(r2.status).toBe('CONFIRMED');
    });
  });

  describe('backpressure', () => {
    it('degrada de inmediato la request que excede el cupo (6) sin encolarla', async () => {
      const gate = deferred<Response>();
      fetchMock.mockReturnValue(gate.promise);

      const accepted = Array.from({ length: 6 }, () =>
        service.readFuelValue(image),
      );
      const overflow = await service.readFuelValue(image);

      expect(overflow).toEqual(DEGRADED);

      // La serial deja solo 1 en vuelo; las otras 5 esperan. La séptima no
      // llegó a encolarse: tras liberar, se hacen exactamente 6 fetch.
      gate.resolve(jsonResponse(OK_RESPONSE));
      fetchMock.mockImplementation(() =>
        Promise.resolve(jsonResponse(OK_RESPONSE)),
      );
      const results = await Promise.all(accepted);

      expect(results.every((r) => r.status === 'CONFIRMED')).toBe(true);
      expect(fetchMock).toHaveBeenCalledTimes(6);
    });

    it('libera el cupo cuando las pendientes resuelven', async () => {
      fetchMock.mockImplementation(() =>
        Promise.resolve(jsonResponse(OK_RESPONSE)),
      );

      await Promise.all(
        Array.from({ length: 6 }, () => service.readFuelValue(image)),
      );
      const after = await service.readFuelValue(image);

      expect(after.status).toBe('CONFIRMED');
    });
  });

  describe('degradación', () => {
    it('timeout: aborta el fetch y degrada', async () => {
      jest.useFakeTimers();
      fetchMock.mockImplementation(hangingUntilAborted);

      const pending = service.readFuelValue(image);
      await jest.advanceTimersByTimeAsync(10_000);
      const result = await pending;

      expect(result).toEqual(DEGRADED);
      expect(fetchMock.mock.calls[0][1]?.signal?.aborted).toBe(true);
    });

    it('un timeout no deja a la cola esperando: la siguiente request se manda', async () => {
      jest.useFakeTimers();
      fetchMock
        .mockImplementationOnce(hangingUntilAborted)
        .mockResolvedValueOnce(jsonResponse(OK_RESPONSE));

      const first = service.readFuelValue(image);
      const second = service.readFuelValue(image);
      await jest.advanceTimersByTimeAsync(10_000);

      await expect(first).resolves.toEqual(DEGRADED);
      await expect(second).resolves.toMatchObject({ status: 'CONFIRMED' });
    });

    it('conexión rechazada (worker caído)', async () => {
      fetchMock.mockRejectedValue(
        new TypeError('fetch failed', {
          cause: Object.assign(new Error('connect ECONNREFUSED'), {
            code: 'ECONNREFUSED',
          }),
        }),
      );

      await expect(service.readFuelValue(image)).resolves.toEqual(DEGRADED);
    });

    it('503 (worker todavía cargando los modelos)', async () => {
      fetchMock.mockResolvedValue(
        jsonResponse({ error: 'models not loaded yet' }, 503),
      );

      await expect(service.readFuelValue(image)).resolves.toEqual(DEGRADED);
    });

    it('4xx del worker (ej. 413) degrada sin intentar leer el cuerpo como lectura', async () => {
      fetchMock.mockResolvedValue(jsonResponse(OK_RESPONSE, 413));

      await expect(service.readFuelValue(image)).resolves.toEqual(DEGRADED);
    });

    it('cuerpo que no es JSON', async () => {
      fetchMock.mockResolvedValue(
        new Response('<html>bad gateway</html>', { status: 200 }),
      );

      await expect(service.readFuelValue(image)).resolves.toEqual(DEGRADED);
    });

    it.each([
      ['status desconocido', { ...OK_RESPONSE, status: 'MAYBE' }],
      ['confidence no numérica', { ...OK_RESPONSE, confidence: '0.9' }],
      ['value numérico', { ...OK_RESPONSE, value: 183.089 }],
      ['sin status', { value: '1.000', confidence: 0.5 }],
      ['null', null],
      ['un array', [OK_RESPONSE]],
    ])('JSON con shape inválido: %s', async (_label, body) => {
      fetchMock.mockResolvedValue(jsonResponse(body));

      await expect(service.readFuelValue(image)).resolves.toEqual(DEGRADED);
    });

    it('acepta la respuesta sin `id` (el protocolo HTTP no lo usa)', async () => {
      fetchMock.mockResolvedValue(
        jsonResponse({ value: '10.000', status: 'REVIEW', confidence: 0.5 }),
      );

      await expect(service.readFuelValue(image)).resolves.toEqual({
        value: '10.000',
        status: 'REVIEW',
        confidence: 0.5,
      });
    });
  });

  describe('onModuleInit', () => {
    it('consulta /health solo para loguear y no lanza si el worker no responde', async () => {
      fetchMock.mockRejectedValue(new TypeError('fetch failed'));

      expect(() => service.onModuleInit()).not.toThrow();
      await new Promise((resolve) => setImmediate(resolve));

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe(HEALTH_URL);
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('inalcanzable'),
      );
    });

    it('loguea que el worker está listo cuando /health responde ready', async () => {
      fetchMock.mockResolvedValue(
        jsonResponse({ ready: true, version: 'litros-v1', reads: 0 }),
      );

      service.onModuleInit();
      await new Promise((resolve) => setImmediate(resolve));

      expect(logSpy).toHaveBeenCalledWith(
        expect.stringContaining('version=litros-v1'),
      );
    });

    it('loguea un aviso si /health responde 503 (cargando modelos)', async () => {
      fetchMock.mockResolvedValue(jsonResponse({ ready: false }, 503));

      service.onModuleInit();
      await new Promise((resolve) => setImmediate(resolve));

      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('todavia no esta listo'),
      );
    });
  });

  describe('onModuleDestroy', () => {
    it('aborta la request en vuelo, que resuelve degradada', async () => {
      fetchMock.mockImplementation(hangingUntilAborted);

      const pending = service.readFuelValue(image);
      await new Promise((resolve) => setImmediate(resolve));
      service.onModuleDestroy();

      await expect(pending).resolves.toEqual(DEGRADED);
      expect(fetchMock.mock.calls[0][1]?.signal?.aborted).toBe(true);
    });

    it('las pendientes encoladas degradan sin llegar a mandarse', async () => {
      fetchMock.mockImplementation(hangingUntilAborted);

      const first = service.readFuelValue(image);
      const queued = service.readFuelValue(image);
      await new Promise((resolve) => setImmediate(resolve));
      service.onModuleDestroy();

      await expect(first).resolves.toEqual(DEGRADED);
      await expect(queued).resolves.toEqual(DEGRADED);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('después de destruido, una lectura nueva degrada sin hacer fetch', async () => {
      service.onModuleDestroy();

      await expect(service.readFuelValue(image)).resolves.toEqual(DEGRADED);
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });
});
