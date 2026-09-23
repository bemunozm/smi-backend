import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';

import { UpdateEquipmentDocumentDto } from './update-equipment-document.dto';

describe('UpdateEquipmentDocumentDto — fileUrl', () => {
  it('acepta una ruta interna de uploads', async () => {
    const dto = plainToInstance(UpdateEquipmentDocumentDto, {
      fileUrl: '/uploads/x.pdf',
    });
    expect(await validate(dto)).toHaveLength(0);
  });

  it('rechaza un dominio externo arbitrario', async () => {
    const dto = plainToInstance(UpdateEquipmentDocumentDto, {
      fileUrl: 'https://evil.com/x.pdf',
    });
    expect(await validate(dto)).not.toHaveLength(0);
  });

  it('permite omitir fileUrl', async () => {
    const dto = plainToInstance(UpdateEquipmentDocumentDto, {});
    expect(await validate(dto)).toHaveLength(0);
  });

  it('permite fileUrl null para limpiar el campo', async () => {
    const dto = plainToInstance(UpdateEquipmentDocumentDto, {
      fileUrl: null,
    });
    expect(await validate(dto)).toHaveLength(0);
  });
});
