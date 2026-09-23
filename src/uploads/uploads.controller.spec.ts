import { BadRequestException } from '@nestjs/common';

import { imageOrPdfFileFilter } from './uploads.controller';

/** Construye un `Express.Multer.File` mínimo — solo `mimetype` importa para el filtro. */
function mockFile(mimetype: string): Express.Multer.File {
  return { mimetype } as Express.Multer.File;
}

describe('imageOrPdfFileFilter', () => {
  it('acepta un archivo de imagen', () => {
    const callback = jest.fn();

    imageOrPdfFileFilter({} as never, mockFile('image/png'), callback);

    expect(callback).toHaveBeenCalledWith(null, true);
  });

  it('acepta un PDF', () => {
    const callback = jest.fn();

    imageOrPdfFileFilter({} as never, mockFile('application/pdf'), callback);

    expect(callback).toHaveBeenCalledWith(null, true);
  });

  it('rechaza cualquier otro tipo de archivo con BadRequestException', () => {
    const callback = jest.fn();

    imageOrPdfFileFilter({} as never, mockFile('text/plain'), callback);

    expect(callback).toHaveBeenCalledTimes(1);
    const [error, acceptFile] = callback.mock.calls[0] as [Error, boolean];
    expect(error).toBeInstanceOf(BadRequestException);
    expect(error.message).toBe('Solo se permiten imágenes o PDF');
    expect(acceptFile).toBe(false);
  });
});
