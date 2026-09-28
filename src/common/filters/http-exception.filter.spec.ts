import {
  ArgumentsHost,
  BadRequestException,
  ConflictException,
  HttpStatus,
  NotFoundException,
} from '@nestjs/common';
import type { Response } from 'express';

import { HttpExceptionFilter } from './http-exception.filter';

function buildHost(response: Partial<Response>): ArgumentsHost {
  return {
    switchToHttp: () => ({
      getResponse: () => response,
      getRequest: () => ({}),
      getNext: () => undefined,
    }),
    getArgs: () => [],
    getArgByIndex: () => undefined,
    switchToRpc: () => {
      throw new Error('not implemented');
    },
    switchToWs: () => {
      throw new Error('not implemented');
    },
    getType: () => 'http',
  } as unknown as ArgumentsHost;
}

describe('HttpExceptionFilter', () => {
  let filter: HttpExceptionFilter;
  let status: jest.Mock;
  let json: jest.Mock<void, [Record<string, unknown>]>;
  let response: Partial<Response>;

  beforeEach(() => {
    filter = new HttpExceptionFilter();
    json = jest.fn<void, [Record<string, unknown>]>();
    status = jest.fn().mockReturnValue({ json });
    response = { status: status };
  });

  it('responde { data: null, message } para una excepción con mensaje string', () => {
    filter.catch(
      new NotFoundException('Equipo no encontrado'),
      buildHost(response),
    );

    expect(status).toHaveBeenCalledWith(HttpStatus.NOT_FOUND);
    expect(json).toHaveBeenCalledWith({
      data: null,
      message: 'Equipo no encontrado',
    });
  });

  it('no agrega "code" cuando la excepción no lo trae', () => {
    filter.catch(new ConflictException('Ya existe'), buildHost(response));

    const body = json.mock.calls[0][0];
    expect(body).not.toHaveProperty('code');
  });

  it('pasa "code" cuando el body de la excepción lo trae explícito', () => {
    filter.catch(
      new ConflictException({
        message: 'El equipo está ocupado',
        code: 'EQUIPMENT_BUSY',
      }),
      buildHost(response),
    );

    expect(json).toHaveBeenCalledWith({
      data: null,
      message: 'El equipo está ocupado',
      code: 'EQUIPMENT_BUSY',
    });
  });

  it('ignora un "code" que no sea string (no lo pasa, no revienta)', () => {
    filter.catch(
      new ConflictException({ message: 'x', code: 42 }),
      buildHost(response),
    );

    const body = json.mock.calls[0][0];
    expect(body).toEqual({ data: null, message: 'x' });
  });

  it('une los mensajes de un ValidationPipe (array) con coma', () => {
    filter.catch(
      new BadRequestException({
        message: ['name debe ser un string', 'rut no es válido'],
        error: 'Bad Request',
        statusCode: 400,
      }),
      buildHost(response),
    );

    expect(json).toHaveBeenCalledWith({
      data: null,
      message: 'name debe ser un string, rut no es válido',
    });
  });

  it('devuelve "Internal server error" para una excepción no-HTTP (500)', () => {
    filter.catch(new Error('boom'), buildHost(response));

    expect(status).toHaveBeenCalledWith(HttpStatus.INTERNAL_SERVER_ERROR);
    expect(json).toHaveBeenCalledWith({
      data: null,
      message: 'Internal server error',
    });
  });
});
