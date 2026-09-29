import { Logger } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';

// A diferencia de `mail.service.spec.ts` (SMTP sin configurar, no-op), este
// archivo fija credenciales SMTP completas para poder probar el path real de
// `transporter.sendMail` — incluidos los adjuntos (RFC Supervisión en
// Terreno §Reporte) y el booleano de éxito/fracaso que consume
// `NotificationsService.notifyRolesWithAttachment`. Van en un archivo aparte
// porque el mock de `env` es a nivel de módulo (no se puede tener dos
// configuraciones distintas en el mismo archivo sin `jest.resetModules`).
jest.mock('../common/config/env', () => ({
  env: {
    smtpHost: 'smtp.smi.local',
    smtpPort: 587,
    smtpUser: 'no-reply@smi.local',
    smtpPass: 'secret',
    smtpFrom: 'SMI <no-reply@smi.local>',
    smtpSecure: false,
  },
}));

const sendMailMock = jest.fn();
jest.mock('nodemailer', () => ({
  __esModule: true,
  default: {
    createTransport: jest.fn(() => ({ sendMail: sendMailMock })),
  },
}));

import { MailService } from './mail.service';

describe('MailService — SMTP configurado (adjuntos + booleano de éxito)', () => {
  let service: MailService;

  beforeEach(async () => {
    sendMailMock.mockReset();
    const module: TestingModule = await Test.createTestingModule({
      providers: [MailService],
    }).compile();
    service = module.get<MailService>(MailService);
  });

  it('isConfigured() es true con SMTP completo', () => {
    expect(service.isConfigured()).toBe(true);
  });

  it('reenvía los adjuntos a transporter.sendMail y devuelve true', async () => {
    sendMailMock.mockResolvedValue({ messageId: 'x' });
    const attachments = [
      {
        filename: 'reporte.pdf',
        content: Buffer.from('%PDF-1.4'),
        contentType: 'application/pdf',
      },
    ];

    const sent = await service.sendMail({
      to: 'admin@smi.local',
      subject: 'Reporte',
      html: '<p>hola</p>',
      attachments,
    });

    expect(sent).toBe(true);
    expect(sendMailMock).toHaveBeenCalledWith(
      expect.objectContaining({ to: 'admin@smi.local', attachments }),
    );
  });

  it('sin adjuntos, backward compatible (no manda attachments extra)', async () => {
    sendMailMock.mockResolvedValue({ messageId: 'x' });

    const sent = await service.sendMail({
      to: 'a@smi.local',
      subject: 'x',
      html: '<p>x</p>',
    });

    expect(sent).toBe(true);
    expect(sendMailMock).toHaveBeenCalledWith(
      expect.objectContaining({ attachments: undefined }),
    );
  });

  it('si transporter.sendMail lanza, devuelve false y no propaga el error', async () => {
    const errorSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation();
    sendMailMock.mockRejectedValue(new Error('SMTP caído'));

    await expect(
      service.sendMail({ to: 'a@smi.local', subject: 'x', html: '<p>x</p>' }),
    ).resolves.toBe(false);
    errorSpy.mockRestore();
  });
});
