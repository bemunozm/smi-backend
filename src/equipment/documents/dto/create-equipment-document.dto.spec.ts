import { EquipmentDocumentType } from '@prisma/client';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';

import { CreateEquipmentDocumentDto } from './create-equipment-document.dto';

const base = {
  type: EquipmentDocumentType.TECHNICAL_INSPECTION,
};

describe('CreateEquipmentDocumentDto — fileUrl', () => {
  it('acepta una ruta interna de uploads', async () => {
    const dto = plainToInstance(CreateEquipmentDocumentDto, {
      ...base,
      fileUrl: '/uploads/x.pdf',
    });
    expect(await validate(dto)).toHaveLength(0);
  });

  it('rechaza un dominio externo arbitrario', async () => {
    const dto = plainToInstance(CreateEquipmentDocumentDto, {
      ...base,
      fileUrl: 'https://evil.com/x.pdf',
    });
    expect(await validate(dto)).not.toHaveLength(0);
  });

  it('permite omitir fileUrl', async () => {
    const dto = plainToInstance(CreateEquipmentDocumentDto, { ...base });
    expect(await validate(dto)).toHaveLength(0);
  });
});
