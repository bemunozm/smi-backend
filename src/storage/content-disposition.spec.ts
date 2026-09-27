import { buildContentDisposition } from './content-disposition';

describe('buildContentDisposition', () => {
  it('arma filename y filename* para un nombre ascii simple', () => {
    const header = buildContentDisposition(
      'revision-tecnica.pdf',
      'equipment-documents/abc123.pdf',
    );
    expect(header).toBe(
      `inline; filename="revision-tecnica.pdf"; filename*=UTF-8''revision-tecnica.pdf`,
    );
  });

  it('fuerza la extensión de la key aunque el fileName traiga otra distinta', () => {
    const header = buildContentDisposition(
      'informe-falso.exe',
      'equipment-documents/abc123.pdf',
    );
    expect(header).toContain('filename="informe-falso.pdf"');
    expect(header).toContain("filename*=UTF-8''informe-falso.pdf");
  });

  it('agrega la extensión de la key si el fileName no traía ninguna', () => {
    const header = buildContentDisposition(
      'sin-extension',
      'equipment-documents/abc123.pdf',
    );
    expect(header).toContain('filename="sin-extension.pdf"');
  });

  it('sanitiza comillas, backslash, CR/LF y punto y coma', () => {
    const header = buildContentDisposition(
      'informe"raro\\con\r\nsaltos;y.pdf',
      'equipment-documents/abc123.pdf',
    );
    // El header en sí lleva `"` y `;` como sintaxis (filename="..."; filename*=...)
    // — lo que se verifica es que el VALOR saneado no cuele ninguno de esos
    // caracteres dentro de las comillas ni rompa el header con un CR/LF real.
    expect(header).not.toMatch(/[\r\n]/);
    const asciiMatch = /filename="([^"]*)"/.exec(header);
    expect(asciiMatch).not.toBeNull();
    const asciiValue = asciiMatch?.[1] ?? '';
    expect(asciiValue).not.toMatch(/["\\;]/);
    // El nombre sobrevive sin los caracteres peligrosos, con la extensión forzada.
    expect(header).toContain('filename="informerarocon');
  });

  it('codifica UTF-8 en filename* y reemplaza no-ascii por _ en filename', () => {
    const header = buildContentDisposition(
      'informe_ólé.pdf',
      'equipment-documents/abc123.pdf',
    );
    expect(header).toContain('filename="informe__l_.pdf"');
    expect(header).toContain(
      `filename*=UTF-8''${encodeURIComponent('informe_ólé.pdf')}`,
    );
  });

  it('usa un nombre de fallback si, tras sanitizar, queda vacío', () => {
    const header = buildContentDisposition('";";', 'fuel-photos/abc123.jpg');
    expect(header).toContain('filename="archivo.jpg"');
  });

  it('siempre antepone inline (nunca attachment)', () => {
    const header = buildContentDisposition('x.jpg', 'fuel-photos/abc123.jpg');
    expect(header.startsWith('inline; ')).toBe(true);
  });
});
