import { Logger } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';

import { ROLES } from '../auth/roles';
import { MailService } from '../mail/mail.service';
import { ShiftReportsService } from '../shifts/shift-reports.service';
import { NotificationsListener } from './notifications.listener';
import { NotificationsService } from './notifications.service';

describe('NotificationsListener', () => {
  let listener: NotificationsListener;

  const createForRoles = jest.fn();
  const createForUser = jest.fn();
  const resolveEquipoId = jest.fn();
  const notifyRolesWithAttachment = jest.fn();
  const isConfigured = jest.fn();
  const getAttachment = jest.fn();
  const markEmailStatus = jest.fn();

  const PDF_ATTACHMENT = {
    filename: 'reporte-salida-2026-09-28-diurno.pdf',
    content: Buffer.from('%PDF-1.4'),
    contentType: 'application/pdf',
  };

  beforeEach(async () => {
    createForRoles.mockReset().mockResolvedValue([]);
    createForUser.mockReset().mockResolvedValue(undefined);
    // Por defecto el resolver "pasa" el mismo ref que recibe, como si ya
    // fuera un id válido — los tests que necesitan simular código→id o
    // ref-no-encontrado sobreescriben esto puntualmente.
    resolveEquipoId
      .mockReset()
      .mockImplementation((ref: string | null) => Promise.resolve(ref ?? null));
    notifyRolesWithAttachment
      .mockReset()
      .mockResolvedValue({ recipientCount: 1, allEmailsSent: true });
    isConfigured.mockReset().mockReturnValue(true);
    getAttachment.mockReset().mockResolvedValue(PDF_ATTACHMENT);
    markEmailStatus.mockReset().mockResolvedValue(undefined);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        NotificationsListener,
        {
          provide: NotificationsService,
          useValue: {
            createForRoles,
            createForUser,
            resolveEquipoId,
            notifyRolesWithAttachment,
          },
        },
        { provide: MailService, useValue: { isConfigured } },
        {
          provide: ShiftReportsService,
          useValue: { getAttachment, markEmailStatus },
        },
      ],
    }).compile();

    listener = module.get<NotificationsListener>(NotificationsListener);
  });

  it('hallazgo.created notifica a SUPERVISOR + ADMIN', async () => {
    await listener.onHallazgoCreated({
      hallazgoId: 'h1',
      equipoId: 'e1',
      prioridad: 'ALTA',
      descripcion: 'Fuga de aceite',
    });

    expect(createForRoles).toHaveBeenCalledTimes(1);
    expect(createForRoles).toHaveBeenCalledWith(
      [ROLES.SUPERVISOR, ROLES.ADMIN],
      expect.objectContaining({
        tipo: 'hallazgo.created',
        data: { hallazgoId: 'h1', equipoId: 'e1' },
      }),
    );
  });

  it('orden.assigned notifica al asignado (createForUser) y a SUPERVISOR (createForRoles)', async () => {
    await listener.onOrdenAssigned({
      ordenId: 'o1',
      equipoId: 'e1',
      asignadoId: 'u1',
      titulo: 'Cambio de aceite',
    });

    expect(createForUser).toHaveBeenCalledWith(
      'u1',
      expect.objectContaining({ tipo: 'orden.assigned' }),
    );
    expect(createForRoles).toHaveBeenCalledWith(
      [ROLES.SUPERVISOR],
      expect.objectContaining({ tipo: 'orden.assigned' }),
    );
  });

  it('orden.assigned sin asignadoId solo notifica a SUPERVISOR', async () => {
    await listener.onOrdenAssigned({
      ordenId: 'o1',
      equipoId: null,
      asignadoId: null,
      titulo: 'Cambio de aceite',
    });

    expect(createForUser).not.toHaveBeenCalled();
    expect(createForRoles).toHaveBeenCalledWith(
      [ROLES.SUPERVISOR],
      expect.anything(),
    );
  });

  it('orden.assigned con equipoId como código lo resuelve al id real en data', async () => {
    // OrdenTrabajo.equipoId es soft-ref: la UI de creación de OT puede haber
    // guardado el código ("EX-001") en vez del id (cuid) — el listener debe
    // resolverlo antes de propagarlo, para que el front navegue bien.
    resolveEquipoId.mockResolvedValue('cuid_real_e1');

    await listener.onOrdenAssigned({
      ordenId: 'o1',
      equipoId: 'EX-001',
      asignadoId: 'u1',
      titulo: 'Cambio de aceite',
    });

    expect(resolveEquipoId).toHaveBeenCalledWith('EX-001');
    expect(createForUser).toHaveBeenCalledWith(
      'u1',
      expect.objectContaining({
        data: { ordenId: 'o1', equipoId: 'cuid_real_e1' },
      }),
    );
    expect(createForRoles).toHaveBeenCalledWith(
      [ROLES.SUPERVISOR],
      expect.objectContaining({
        data: { ordenId: 'o1', equipoId: 'cuid_real_e1' },
      }),
    );
  });

  it('orden.assigned con equipoId que no resuelve a ningún equipo deja equipoId null en data', async () => {
    resolveEquipoId.mockResolvedValue(null);

    await listener.onOrdenAssigned({
      ordenId: 'o1',
      equipoId: 'REF-INEXISTENTE',
      asignadoId: 'u1',
      titulo: 'Cambio de aceite',
    });

    expect(createForUser).toHaveBeenCalledWith(
      'u1',
      expect.objectContaining({
        data: { ordenId: 'o1', equipoId: null },
      }),
    );
  });

  it('orden.completed notifica a SUPERVISOR + ADMIN', async () => {
    await listener.onOrdenCompleted({
      ordenId: 'o1',
      equipoId: 'e1',
      titulo: 'Cambio de aceite',
    });

    expect(createForRoles).toHaveBeenCalledWith(
      [ROLES.SUPERVISOR, ROLES.ADMIN],
      expect.objectContaining({ tipo: 'orden.completed' }),
    );
  });

  it('item.low-stock notifica a ADMIN + SUPERVISOR', async () => {
    await listener.onItemLowStock({
      itemId: 'i1',
      itemName: 'Filtro de aceite',
      branchId: 'b1',
      branchName: 'Faena Norte',
      quantity: 2,
      minimumQuantity: 5,
    });

    expect(createForRoles).toHaveBeenCalledWith(
      [ROLES.ADMIN, ROLES.SUPERVISOR],
      expect.objectContaining({ tipo: 'item.low-stock' }),
    );
  });

  it('nombra la bodega en el cuerpo del aviso', async () => {
    await listener.onItemLowStock({
      itemId: 'i1',
      itemName: 'Filtro de aceite',
      branchId: 'b1',
      branchName: 'Faena Norte',
      quantity: 2,
      minimumQuantity: 5,
    });

    // Con existencias por sucursal, "quedan 2" sin decir dónde no le dice a
    // nadie si le toca reponer a él.
    expect(createForRoles).toHaveBeenCalledWith(
      [ROLES.ADMIN, ROLES.SUPERVISOR],
      expect.objectContaining({
        cuerpo: 'Quedan 2 en Faena Norte (mínimo 5)',
      }),
    );
  });

  describe('shift.exit-report', () => {
    const EVENT = {
      reportId: 'report-1',
      shiftId: 'shift-1',
      fileKey: 'reports/shift-exit/2026/09/report-1.pdf',
      fileName: 'reporte-salida-2026-09-28-diurno.pdf',
      cardCount: 3,
      supervisorName: 'Juan Pérez',
      shiftDate: '2026-09-28',
      shiftType: 'DIURNO',
    };

    it('pide el adjunto, notifica a ADMIN con adjunto y marca emailStatus SENT', async () => {
      await listener.onShiftExitReportSent(EVENT);

      expect(getAttachment).toHaveBeenCalledWith('report-1');
      expect(notifyRolesWithAttachment).toHaveBeenCalledWith(
        [ROLES.ADMIN],
        expect.objectContaining({
          tipo: 'shift.exit-report',
          data: { reportId: 'report-1', shiftId: 'shift-1' },
        }),
        [PDF_ATTACHMENT],
        expect.anything(),
      );
      expect(markEmailStatus).toHaveBeenCalledWith('report-1', 'SENT');
    });

    it('sin SMTP configurado, NO pide el adjunto, igual crea la notificación in-app y marca SKIPPED', async () => {
      isConfigured.mockReturnValue(false);

      await listener.onShiftExitReportSent(EVENT);

      expect(getAttachment).not.toHaveBeenCalled();
      expect(createForRoles).toHaveBeenCalledWith(
        [ROLES.ADMIN],
        expect.objectContaining({ tipo: 'shift.exit-report' }),
      );
      expect(markEmailStatus).toHaveBeenCalledWith('report-1', 'SKIPPED');
    });

    it('sin destinatarios (recipientCount=0), marca SKIPPED', async () => {
      notifyRolesWithAttachment.mockResolvedValue({
        recipientCount: 0,
        allEmailsSent: false,
      });

      await listener.onShiftExitReportSent(EVENT);

      expect(markEmailStatus).toHaveBeenCalledWith('report-1', 'SKIPPED');
    });

    it('si algún correo falla (allEmailsSent=false con destinatarios), marca FAILED', async () => {
      notifyRolesWithAttachment.mockResolvedValue({
        recipientCount: 2,
        allEmailsSent: false,
      });

      await listener.onShiftExitReportSent(EVENT);

      expect(markEmailStatus).toHaveBeenCalledWith('report-1', 'FAILED');
    });

    it('si algo lanza (ej. storage caído), marca FAILED y NUNCA propaga la excepción', async () => {
      const errorSpy = jest
        .spyOn(Logger.prototype, 'error')
        .mockImplementation();
      getAttachment.mockRejectedValue(new Error('bucket caído'));

      await expect(
        listener.onShiftExitReportSent(EVENT),
      ).resolves.toBeUndefined();

      expect(markEmailStatus).toHaveBeenCalledWith('report-1', 'FAILED');
      errorSpy.mockRestore();
    });

    it('si falla markEmailStatus, tampoco propaga la excepción', async () => {
      const errorSpy = jest
        .spyOn(Logger.prototype, 'error')
        .mockImplementation();
      markEmailStatus.mockRejectedValue(new Error('db caída'));

      await expect(
        listener.onShiftExitReportSent(EVENT),
      ).resolves.toBeUndefined();
      errorSpy.mockRestore();
    });
  });
});
