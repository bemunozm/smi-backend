import { BadRequestException } from '@nestjs/common';

import { fuelReadingImageFilter } from './ocr.controller';

/** Construye un `Express.Multer.File` mínimo — solo `mimetype` importa para el filtro. */
function mockFile(mimetype: string): Express.Multer.File {
  return { mimetype } as Express.Multer.File;
}

describe('fuelReadingImageFilter', () => {
  it('acepta un archivo de imagen', () => {
    const callback = jest.fn();

    fuelReadingImageFilter({} as never, mockFile('image/png'), callback);

    expect(callback).toHaveBeenCalledWith(null, true);
  });

  it('acepta cualquier subtipo de imagen', () => {
    const callback = jest.fn();

    fuelReadingImageFilter({} as never, mockFile('image/heic'), callback);

    expect(callback).toHaveBeenCalledWith(null, true);
  });

  it('rechaza un archivo que no es imagen (ej. PDF) con BadRequestException', () => {
    const callback = jest.fn();

    fuelReadingImageFilter({} as never, mockFile('application/pdf'), callback);

    expect(callback).toHaveBeenCalledTimes(1);
    const [error, acceptFile] = callback.mock.calls[0] as [Error, boolean];
    expect(error).toBeInstanceOf(BadRequestException);
    expect(error.message).toBe('Solo se permiten imágenes');
    expect(acceptFile).toBe(false);
  });
});
