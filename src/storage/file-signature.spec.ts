import { detectFileSignature } from './file-signature';

describe('detectFileSignature', () => {
  it('reconoce JPEG por sus magic bytes (FF D8 FF)', () => {
    const buffer = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
    expect(detectFileSignature(buffer)).toEqual({
      ext: 'jpg',
      contentType: 'image/jpeg',
    });
  });

  it('reconoce PNG por sus magic bytes', () => {
    const buffer = Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00,
    ]);
    expect(detectFileSignature(buffer)).toEqual({
      ext: 'png',
      contentType: 'image/png',
    });
  });

  it('reconoce WebP (RIFF....WEBP)', () => {
    const buffer = Buffer.concat([
      Buffer.from('RIFF', 'ascii'),
      Buffer.from([0x00, 0x00, 0x00, 0x00]),
      Buffer.from('WEBP', 'ascii'),
      Buffer.from([0x01, 0x02]),
    ]);
    expect(detectFileSignature(buffer)).toEqual({
      ext: 'webp',
      contentType: 'image/webp',
    });
  });

  it('reconoce PDF (%PDF-)', () => {
    const buffer = Buffer.from('%PDF-1.4\n%âãÏÓ\n', 'binary');
    expect(detectFileSignature(buffer)).toEqual({
      ext: 'pdf',
      contentType: 'application/pdf',
    });
  });

  it('devuelve null para SVG (texto XML, sin magic bytes binarios)', () => {
    const buffer = Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg"></svg>',
      'utf8',
    );
    expect(detectFileSignature(buffer)).toBeNull();
  });

  it('devuelve null para HTML renombrado con extensión de imagen', () => {
    const buffer = Buffer.from(
      '<!DOCTYPE html><html><body>hola</body></html>',
      'utf8',
    );
    expect(detectFileSignature(buffer)).toBeNull();
  });

  it('devuelve null para GIF (formato no soportado)', () => {
    const buffer = Buffer.from('GIF89a', 'ascii');
    expect(detectFileSignature(buffer)).toBeNull();
  });

  it('devuelve null para buffer vacío', () => {
    expect(detectFileSignature(Buffer.alloc(0))).toBeNull();
  });

  it('devuelve null para buffer más corto que cualquier firma', () => {
    expect(detectFileSignature(Buffer.from([0xff, 0xd8]))).toBeNull();
  });
});
