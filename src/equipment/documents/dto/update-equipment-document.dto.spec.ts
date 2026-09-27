import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';

import { UpdateEquipmentDocumentDto } from './update-equipment-document.dto';

const VALID_TMP_KEY =
  'tmp/user1234567890123456/9c858901-8a57-4791-81fe-4c455b099bc9.pdf';

describe('UpdateEquipmentDocumentDto — fileKey', () => {
  it('acepta una key tmp/<userId>/<uuid>.<ext> válida', async () => {
    const dto = plainToInstance(UpdateEquipmentDocumentDto, {
      fileKey: VALID_TMP_KEY,
    });
    expect(await validate(dto)).toHaveLength(0);
  });

  it('rechaza una ruta legacy /uploads/... (ya NO es el contrato)', async () => {
    const dto = plainToInstance(UpdateEquipmentDocumentDto, {
      fileKey: '/uploads/x.pdf',
    });
    expect(await validate(dto)).not.toHaveLength(0);
  });

  it('permite omitir fileKey', async () => {
    const dto = plainToInstance(UpdateEquipmentDocumentDto, {});
    expect(await validate(dto)).toHaveLength(0);
  });

  it('permite fileKey null para limpiar el campo', async () => {
    const dto = plainToInstance(UpdateEquipmentDocumentDto, {
      fileKey: null,
    });
    expect(await validate(dto)).toHaveLength(0);
  });

  it('rechaza un dominio externo arbitrario', async () => {
    const dto = plainToInstance(UpdateEquipmentDocumentDto, {
      fileKey: 'https://evil.com/x.pdf',
    });
    expect(await validate(dto)).not.toHaveLength(0);
  });
});

describe('UpdateEquipmentDocumentDto — fileName', () => {
  it('acepta un nombre "humano" con acentos', async () => {
    const dto = plainToInstance(UpdateEquipmentDocumentDto, {
      fileName: 'Póliza Seguro.pdf',
    });
    expect(await validate(dto)).toHaveLength(0);
  });

  it('permite fileName null para limpiar el campo', async () => {
    const dto = plainToInstance(UpdateEquipmentDocumentDto, {
      fileName: null,
    });
    expect(await validate(dto)).toHaveLength(0);
  });

  it('permite omitir fileName', async () => {
    const dto = plainToInstance(UpdateEquipmentDocumentDto, {});
    expect(await validate(dto)).toHaveLength(0);
  });
});
