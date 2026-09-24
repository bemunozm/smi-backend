import { EquipmentDocumentType } from '@prisma/client';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';

import { CreateEquipmentDocumentDto } from './create-equipment-document.dto';

const base = {
  type: EquipmentDocumentType.TECHNICAL_INSPECTION,
};

const VALID_TMP_KEY =
  'tmp/user1234567890123456/9c858901-8a57-4791-81fe-4c455b099bc9.pdf';

describe('CreateEquipmentDocumentDto — fileKey', () => {
  it('acepta una key tmp/<userId>/<uuid>.<ext> válida', async () => {
    const dto = plainToInstance(CreateEquipmentDocumentDto, {
      ...base,
      fileKey: VALID_TMP_KEY,
    });
    expect(await validate(dto)).toHaveLength(0);
  });

  it('permite omitir fileKey', async () => {
    const dto = plainToInstance(CreateEquipmentDocumentDto, { ...base });
    expect(await validate(dto)).toHaveLength(0);
  });

  it('rechaza una ruta legacy /uploads/... (ya NO es el contrato)', async () => {
    const dto = plainToInstance(CreateEquipmentDocumentDto, {
      ...base,
      fileKey: '/uploads/x.pdf',
    });
    expect(await validate(dto)).not.toHaveLength(0);
  });

  it('rechaza una key final (no tmp/) — el contrato solo acepta tmp/', async () => {
    const dto = plainToInstance(CreateEquipmentDocumentDto, {
      ...base,
      fileKey: 'equipment-documents/9c858901-8a57-4791-81fe-4c455b099bc9.pdf',
    });
    expect(await validate(dto)).not.toHaveLength(0);
  });

  it('rechaza un dominio externo arbitrario', async () => {
    const dto = plainToInstance(CreateEquipmentDocumentDto, {
      ...base,
      fileKey: 'https://evil.com/x.pdf',
    });
    expect(await validate(dto)).not.toHaveLength(0);
  });

  it('rechaza traversal disfrazado de key', async () => {
    const dto = plainToInstance(CreateEquipmentDocumentDto, {
      ...base,
      fileKey: 'tmp/../../etc/passwd',
    });
    expect(await validate(dto)).not.toHaveLength(0);
  });
});

describe('CreateEquipmentDocumentDto — fileName', () => {
  it('acepta un nombre "humano" con acentos', async () => {
    const dto = plainToInstance(CreateEquipmentDocumentDto, {
      ...base,
      fileName: 'Póliza Seguro.pdf',
    });
    expect(await validate(dto)).toHaveLength(0);
  });

  it('permite omitir fileName', async () => {
    const dto = plainToInstance(CreateEquipmentDocumentDto, { ...base });
    expect(await validate(dto)).toHaveLength(0);
  });

  it('rechaza un fileName por encima de 200 caracteres', async () => {
    const dto = plainToInstance(CreateEquipmentDocumentDto, {
      ...base,
      fileName: 'a'.repeat(201),
    });
    expect(await validate(dto)).not.toHaveLength(0);
  });
});
