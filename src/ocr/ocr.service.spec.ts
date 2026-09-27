import { Test, TestingModule } from '@nestjs/testing';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { PassThrough } from 'node:stream';

import { OcrService } from './ocr.service';

// El worker python real (dos modelos ONNX) NO corre en CI (ver
// `ocr.integration.spec.ts` para eso, opcional) — acá mockeamos `spawn` +
// sus streams (stdin/stdout/stderr son PassThrough reales, así que el
// parser JSON-lines real del servicio -- vía `node:readline` -- se ejercita
// sin mockear nada de eso) para testear: arranque, readiness, correlación
// por id, timeout -> restart, crash -> restart, degradación, cola serial,
// limpieza del temporal, y kill en destroy.
//
// Timers: a propósito se usan timers REALES (no `jest.useFakeTimers`) — los
// streams/readline/fs reales dependen del loop de eventos real, y mezclarlos
// con fake timers es frágil (el timer de un request puede quedar agendado
// con el reloj real ANTES de instalar el fake, y nunca avanza). El costo es
// que los tests de timeout/backoff esperan tiempo real de pared (ver los
// `it(..., TIMEOUT)` con margen).
jest.mock('node:child_process');

const mockedSpawn = spawn as unknown as jest.Mock;

/** Doble de `ChildProcessWithoutNullStreams` con streams reales (PassThrough)
 * para que el `readline`/JSON-parsing real del servicio se ejercite de punta
 * a punta, y un `kill()` espiable para verificar restart/destroy. */
class FakeChildProcess extends EventEmitter {
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();
  kill = jest.fn(() => true);
}

function createFakeChild(): FakeChildProcess {
  return new FakeChildProcess();
}

function writeLine(stream: PassThrough, obj: unknown): void {
  stream.write(`${JSON.stringify(obj)}\n`);
}

/** Espera real (timers reales) — da tiempo a que I/O real (writeFile,
 * streams/readline) termine de propagarse. */
function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Espera hasta que `predicate()` sea true, reintentando en vez de dormir un
 * tiempo fijo — bajo carga (27 suites de jest corriendo en paralelo) un
 * `wait(30)` fijo puede no alcanzar para que el próximo write/parse real se
 * propague, y fallar de forma intermitente en vez de determinística.
 */
async function waitFor(
  predicate: () => boolean,
  timeoutMs = 3_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error(
        `waitFor: condicion no se cumplio dentro de ${timeoutMs}ms`,
      );
    }
    await wait(10);
  }
}

async function countOcrTempFiles(): Promise<number> {
  const entries = await readdir(tmpdir());
  return entries.filter((name) => name.startsWith('smi-ocr-fuel-')).length;
}

/** Igual que `waitFor`, pero para predicados que necesitan I/O (ej. contar temporales en disco). */
async function waitForAsync(
  predicate: () => Promise<boolean>,
  timeoutMs = 3_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await predicate()) return;
    if (Date.now() > deadline) {
      throw new Error(
        `waitForAsync: condicion no se cumplio dentro de ${timeoutMs}ms`,
      );
    }
    await wait(10);
  }
}

/** Shape interno de `PendingRequest` (no exportado por `ocr.service.ts`) — usado solo para el test de la linea 3b, que necesita simular la remocion de `pending` que en produccion hace un timeout real (10s, no configurable). */
interface PendingRequestInternal {
  resolve: (result: unknown) => void;
  timeoutHandle: NodeJS.Timeout;
}

/**
 * Espera hasta que el servicio haya mandado al menos `atLeast` requests al
 * stdin del worker (poll, no un sleep fijo — ver `waitFor`) y devuelve
 * `{id, path}` de la última. Cubre tanto "ya mandó la primera" como, en el
 * test de cola serial, "ya mandó la segunda" (que solo pasa una vez resuelta
 * la primera — un round-trip completo: respuesta -> parseo -> resolve ->
 * `.then()` de la cola -> siguiente `write`).
 */
async function waitForWrittenRequest(
  writeSpy: jest.SpyInstance,
  atLeast = 1,
): Promise<{ id: string; path: string }> {
  await waitFor(() => writeSpy.mock.calls.length >= atLeast);
  const calls = writeSpy.mock.calls as unknown as [string][];
  const raw = calls[calls.length - 1][0];
  return JSON.parse(raw.trim()) as { id: string; path: string };
}

const READY_LINE = { ready: true, version: 'litros-v1' };

/** Lanza el worker fake y lo deja "ready" — patrón repetido en casi todos los tests. */
async function bootReadyWorker(
  service: OcrService,
  child: FakeChildProcess,
): Promise<void> {
  service.onModuleInit();
  await wait(100);
  writeLine(child.stdout, READY_LINE);
  await wait(100);
}

describe('OcrService', () => {
  let service: OcrService;

  beforeEach(async () => {
    mockedSpawn.mockReset();
    const module: TestingModule = await Test.createTestingModule({
      providers: [OcrService],
    }).compile();
    service = module.get(OcrService);
  });

  afterEach(() => {
    service.onModuleDestroy();
  });

  it('se degrada a UNREADABLE mientras el worker todavia no mando la linea de ready', async () => {
    const child = createFakeChild();
    mockedSpawn.mockReturnValue(child);
    service.onModuleInit();
    await wait(30);

    const result = await service.readFuelValue(Buffer.from('fake-jpeg'));

    expect(result).toEqual({
      value: null,
      status: 'UNREADABLE',
      confidence: 0,
    });
  });

  it('correlaciona la respuesta por id y devuelve el shape nuevo (sin digits)', async () => {
    const child = createFakeChild();
    mockedSpawn.mockReturnValue(child);
    await bootReadyWorker(service, child);

    const writeSpy = jest.spyOn(child.stdin, 'write');
    const resultPromise = service.readFuelValue(Buffer.from('fake-jpeg'));

    const { id } = await waitForWrittenRequest(writeSpy);
    writeLine(child.stdout, {
      id,
      value: '183.089',
      status: 'CONFIRMED',
      confidence: 0.6563,
      florence: {
        liters: '183.089',
        confidence: 0.9997,
        raw: 'L: 1 8 3 . 0 8 9',
      },
      crnn: { liters: '183.089', confidence: 0.6563, raw: '183.089' },
      ms: 509.5,
    });

    const result = await resultPromise;

    expect(result).toEqual({
      value: '183.089',
      status: 'CONFIRMED',
      confidence: 0.6563,
    });
    expect(result).not.toHaveProperty('digits');
  });

  it('ignora una linea no-JSON en stdout sin romper la correlacion de la respuesta real', async () => {
    const child = createFakeChild();
    mockedSpawn.mockReturnValue(child);
    await bootReadyWorker(service, child);

    const writeSpy = jest.spyOn(child.stdin, 'write');
    const resultPromise = service.readFuelValue(Buffer.from('fake-jpeg'));
    const { id } = await waitForWrittenRequest(writeSpy);

    child.stdout.write('esto no es json en absoluto\n');
    await wait(30);
    writeLine(child.stdout, {
      id,
      value: null,
      status: 'UNREADABLE',
      confidence: 0,
      florence: null,
      crnn: null,
      ms: 12.3,
    });

    const result = await resultPromise;

    expect(result).toEqual({
      value: null,
      status: 'UNREADABLE',
      confidence: 0,
    });
  });

  it('respeta la cola serial: no manda la segunda request hasta que la primera resuelve', async () => {
    const child = createFakeChild();
    mockedSpawn.mockReturnValue(child);
    await bootReadyWorker(service, child);

    const writeSpy = jest.spyOn(child.stdin, 'write');
    const first = service.readFuelValue(Buffer.from('fake-1'));
    const second = service.readFuelValue(Buffer.from('fake-2'));

    const { id: id1 } = await waitForWrittenRequest(writeSpy);
    expect(writeSpy).toHaveBeenCalledTimes(1); // la segunda todavia no se mando

    writeLine(child.stdout, {
      id: id1,
      value: '1.000',
      status: 'CONFIRMED',
      confidence: 0.9,
      florence: null,
      crnn: null,
      ms: 1,
    });
    await first;

    const { id: id2 } = await waitForWrittenRequest(writeSpy, 2);
    expect(id2).not.toEqual(id1);
    writeLine(child.stdout, {
      id: id2,
      value: '2.000',
      status: 'CONFIRMED',
      confidence: 0.9,
      florence: null,
      crnn: null,
      ms: 1,
    });
    await second;
  });

  it('hace timeout a los 10s, degrada esa request y mata+reinicia el worker', async () => {
    const child1 = createFakeChild();
    const child2 = createFakeChild();
    mockedSpawn.mockReturnValueOnce(child1).mockReturnValueOnce(child2);
    await bootReadyWorker(service, child1);

    const resultPromise = service.readFuelValue(Buffer.from('fake-jpeg'));
    await wait(30);
    expect(child1.kill).not.toHaveBeenCalled();

    const result = await resultPromise; // el propio timeout (10s reales) resuelve esto

    expect(result).toEqual({
      value: null,
      status: 'UNREADABLE',
      confidence: 0,
    });
    expect(child1.kill).toHaveBeenCalledTimes(1);

    await wait(1_300); // primer paso del backoff (1000ms) + margen
    expect(mockedSpawn).toHaveBeenCalledTimes(2);
  }, 15_000);

  it('si el worker termina solo (exit) reinicia con backoff y degrada la request en vuelo', async () => {
    const child1 = createFakeChild();
    const child2 = createFakeChild();
    mockedSpawn.mockReturnValueOnce(child1).mockReturnValueOnce(child2);
    await bootReadyWorker(service, child1);

    const resultPromise = service.readFuelValue(Buffer.from('fake-jpeg'));
    await wait(30);

    child1.emit('exit', 1, null);
    const result = await resultPromise;

    expect(result).toEqual({
      value: null,
      status: 'UNREADABLE',
      confidence: 0,
    });

    await wait(1_300);
    expect(mockedSpawn).toHaveBeenCalledTimes(2);
  }, 5_000);

  it('usa la extension del archivo original en el path que le manda al worker', async () => {
    const child = createFakeChild();
    mockedSpawn.mockReturnValue(child);
    await bootReadyWorker(service, child);

    const writeSpy = jest.spyOn(child.stdin, 'write');
    const resultPromise = service.readFuelValueFrom(
      Buffer.from('fake-png'),
      'foto.png',
    );

    const { id, path } = await waitForWrittenRequest(writeSpy);
    expect(path).toEqual(expect.stringContaining('.png'));

    writeLine(child.stdout, {
      id,
      value: null,
      status: 'UNREADABLE',
      confidence: 0,
      florence: null,
      crnn: null,
      ms: 1,
    });
    await resultPromise;
  });

  it('limpia el archivo temporal despues de una corrida exitosa', async () => {
    const child = createFakeChild();
    mockedSpawn.mockReturnValue(child);
    await bootReadyWorker(service, child);

    const before = await countOcrTempFiles();
    const writeSpy = jest.spyOn(child.stdin, 'write');
    const resultPromise = service.readFuelValue(Buffer.from('fake-jpeg'));
    const { id } = await waitForWrittenRequest(writeSpy);
    writeLine(child.stdout, {
      id,
      value: '183.089',
      status: 'CONFIRMED',
      confidence: 0.9,
      florence: null,
      crnn: null,
      ms: 1,
    });
    await resultPromise;

    const after = await countOcrTempFiles();
    expect(after).toBe(before);
  });

  it('limpia el archivo temporal incluso en degradacion inmediata (worker no listo)', async () => {
    const child = createFakeChild();
    mockedSpawn.mockReturnValue(child);
    service.onModuleInit();
    await wait(30);
    const before = await countOcrTempFiles();

    await service.readFuelValue(Buffer.from('fake-jpeg'));

    const after = await countOcrTempFiles();
    expect(after).toBe(before);
  });

  it('onModuleDestroy mata el worker y no dispara mas restarts', async () => {
    const child = createFakeChild();
    mockedSpawn.mockReturnValue(child);
    await bootReadyWorker(service, child);

    service.onModuleDestroy();

    expect(child.kill).toHaveBeenCalledTimes(1);

    await wait(1_300);
    expect(mockedSpawn).toHaveBeenCalledTimes(1);
  });

  it('backpressure: con MAX_PENDING_REQUESTS (6) en cola/vuelo contra un worker lento, la 7ma degrada de inmediato sin tocar el filesystem, y el cupo se libera para las que vengan despues', async () => {
    const child = createFakeChild();
    mockedSpawn.mockReturnValue(child);
    await bootReadyWorker(service, child);

    const writeSpy = jest.spyOn(child.stdin, 'write');
    const before = await countOcrTempFiles();

    // 6 requests concurrentes contra un worker "lento" (no le respondemos
    // todavia) -- las 6 deben ser ACEPTADAS: la 1ra se manda al worker, las
    // otras 5 quedan encoladas detras de `queueTail` (cola serial), pero
    // las 6 cuentan para el cupo de `MAX_PENDING_REQUESTS`.
    const inFlight = Array.from({ length: 6 }, (_, i) =>
      service.readFuelValue(Buffer.from(`fake-${i}`)),
    );

    await waitForAsync(async () => (await countOcrTempFiles()) - before >= 6);
    expect(writeSpy).toHaveBeenCalledTimes(1); // solo la 1ra ya se le mando al worker (serial)

    // La 7ma excede el cupo: degrada YA -- sin escribir temporal ni encolar.
    const seventh = await service.readFuelValue(Buffer.from('fake-7th'));
    expect(seventh).toEqual({
      value: null,
      status: 'UNREADABLE',
      confidence: 0,
    });
    expect(await countOcrTempFiles()).toBe(before + 6); // no hay 7mo temporal
    expect(writeSpy).toHaveBeenCalledTimes(1); // la 7ma nunca llego a encolarse/mandarse

    // Se drena la cola serial respondiendole a cada una en orden -- asi se
    // ejercita el decremento del contador en la via de "exito" para las 6.
    for (let i = 0; i < 6; i++) {
      const { id } = await waitForWrittenRequest(writeSpy, i + 1);
      writeLine(child.stdout, {
        id,
        value: '1.000',
        status: 'CONFIRMED',
        confidence: 0.9,
        florence: null,
        crnn: null,
        ms: 1,
      });
    }
    await Promise.all(inFlight);

    expect(await countOcrTempFiles()).toBe(before); // todos los temporales se limpiaron
    expect(writeSpy).toHaveBeenCalledTimes(6);

    // El cupo volvio a 0 (contador decrementado en las 6 vias de exito):
    // una request nueva ya NO degrada de inmediato, llega normal al worker.
    const resultPromise = service.readFuelValue(Buffer.from('fake-after'));
    const { id } = await waitForWrittenRequest(writeSpy, 7);
    writeLine(child.stdout, {
      id,
      value: '2.000',
      status: 'CONFIRMED',
      confidence: 0.9,
      florence: null,
      crnn: null,
      ms: 1,
    });
    const result = await resultPromise;
    expect(result).toEqual({
      value: '2.000',
      status: 'CONFIRMED',
      confidence: 0.9,
    });
  });

  it('si child.stdin.write lanza sincrono (EPIPE), esa request degrada y el servicio sigue funcionando para la siguiente', async () => {
    const child = createFakeChild();
    mockedSpawn.mockReturnValue(child);
    await bootReadyWorker(service, child);

    const writeSpy = jest
      .spyOn(child.stdin, 'write')
      .mockImplementationOnce(() => {
        throw new Error('EPIPE: write after end');
      });

    const first = await service.readFuelValue(Buffer.from('fake-1'));

    expect(first).toEqual({
      value: null,
      status: 'UNREADABLE',
      confidence: 0,
    });
    expect(writeSpy).toHaveBeenCalledTimes(1);
    expect(child.kill).not.toHaveBeenCalled(); // no crashea el proceso, no dispara restart

    // La siguiente request usa el MISMO worker (ya sin el mock roto, que
    // solo aplicaba una vez) y funciona normal de punta a punta.
    const resultPromise = service.readFuelValue(Buffer.from('fake-2'));
    const { id } = await waitForWrittenRequest(writeSpy, 2);
    writeLine(child.stdout, {
      id,
      value: '5.000',
      status: 'CONFIRMED',
      confidence: 0.9,
      florence: null,
      crnn: null,
      ms: 1,
    });
    const result = await resultPromise;

    expect(result).toEqual({
      value: '5.000',
      status: 'CONFIRMED',
      confidence: 0.9,
    });
    expect(mockedSpawn).toHaveBeenCalledTimes(1); // sigue siendo el mismo worker, nunca se reinicio
  });

  it('una respuesta tardia con un id ya removido de pending (como deja un timeout/restart real) se ignora y no afecta la siguiente request', async () => {
    const child = createFakeChild();
    mockedSpawn.mockReturnValue(child);
    await bootReadyWorker(service, child);

    const writeSpy = jest.spyOn(child.stdin, 'write');
    void service.readFuelValue(Buffer.from('fake-1'));
    const { id } = await waitForWrittenRequest(writeSpy);

    // Simula el estado que deja un timeout real (10s de pared, no
    // reproducible rapido en test ya que `REQUEST_TIMEOUT_MS` no es
    // configurable por env): un timeout resuelve la promesa en vuelo
    // (desbloqueando `queueTail`, igual que hace `sendRequest`'s
    // `timeoutHandle`) y RECIEN despues borra la entrada de `pending`. Se
    // replica ese mismo orden a mano, en vez de esperar 10s de pared, para
    // dejar `pending` sin el id ANTES de que la linea tardia del worker
    // llegue -- ejercita el mismo branch (`if (!pending) return`) que un
    // timeout/restart real dispara en `handleWorkerLine`.
    const pending = (
      service as unknown as { pending: Map<string, PendingRequestInternal> }
    ).pending;
    const entry = pending.get(id);
    expect(entry).toBeDefined();
    clearTimeout(entry?.timeoutHandle); // evita que el timer real de 10s dispare un restart de mas, mas tarde
    entry?.resolve({ value: null, status: 'UNREADABLE', confidence: 0 }); // como hace el timeout: resuelve...
    pending.delete(id); // ...y RECIEN despues se borra de pending

    // La linea tardia llega igual -- no debe tirar ni afectar nada.
    writeLine(child.stdout, {
      id,
      value: '183.089',
      status: 'CONFIRMED',
      confidence: 0.9,
      florence: null,
      crnn: null,
      ms: 1,
    });
    await wait(30);

    // Lo que importa: el servicio sigue sano -- una request nueva, en el
    // mismo worker, resuelve normal (no se confunde con la respuesta
    // huerfana ni con el id ya usado).
    const resultPromise = service.readFuelValue(Buffer.from('fake-2'));
    const { id: id2 } = await waitForWrittenRequest(writeSpy, 2);
    expect(id2).not.toEqual(id);
    writeLine(child.stdout, {
      id: id2,
      value: '2.000',
      status: 'CONFIRMED',
      confidence: 0.9,
      florence: null,
      crnn: null,
      ms: 1,
    });
    const result = await resultPromise;

    expect(result).toEqual({
      value: '2.000',
      status: 'CONFIRMED',
      confidence: 0.9,
    });
    expect(child.kill).not.toHaveBeenCalled();
  });
});
