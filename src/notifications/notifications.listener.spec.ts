import { Logger } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';

import { ROLES } from '../auth/roles';
import { PrismaService } from '../common/prisma/prisma.service';
import { MailService } from '../mail/mail.service';
import { StorageService } from '../storage/storage.service';
import { NotificationsListener } from './notifications.listener';
import { NotificationsService } from './notifications.service';

describe('NotificationsListener', () => {
  let listener: NotificationsListener;

  const createForRoles = jest.fn();
  const createForUser = jest.fn();
  const resolveEquipoId = jest.fn();
  const notifyRolesWithAttachment = jest.fn();
  const isConfigured = jest.fn();
  const getObjectBuffer = jest.fn();
  const shiftExitReportUpdate = jest.fn();

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
    getObjectBuffer.mockReset().mockResolvedValue(Buffer.from('%PDF-1.4'));
    shiftExitReportUpdate.mockReset().mockResolvedValue(undefined);

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
        { provide: StorageService, useValue: { getObjectBuffer } },
        {
          provide: PrismaService,
          useValue: { shiftExitReport: { update: shiftExitReportUpdate } },
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

    it('baja el PDF, notifica a ADMIN con adjunto y marca emailStatus SENT', async () => {
      await listener.onShiftExitReportSent(EVENT);

      expect(getObjectBuffer).toHaveBeenCalledWith(EVENT.fileKey);
      expect(notifyRolesWithAttachment).toHaveBeenCalledWith(
        [ROLES.ADMIN],
        expect.objectContaining({
          tipo: 'shift.exit-report',
          data: { reportId: 'report-1', shiftId: 'shift-1' },
        }),
        [
          expect.objectContaining({
            filename: EVENT.fileName,
            contentType: 'application/pdf',
          }),
        ],
        expect.anything(),
      );
      expect(shiftExitReportUpdate).toHaveBeenCalledWith({
        where: { id: 'report-1' },
        data: { emailStatus: 'SENT', notifiedAt: expect.any(Date) as Date },
      });
    });

    it('sin SMTP configurado, NO baja el PDF, igual crea la notificación in-app y marca SKIPPED', async () => {
      isConfigured.mockReturnValue(false);

      await listener.onShiftExitReportSent(EVENT);

      expect(getObjectBuffer).not.toHaveBeenCalled();
      expect(createForRoles).toHaveBeenCalledWith(
        [ROLES.ADMIN],
        expect.objectContaining({ tipo: 'shift.exit-report' }),
      );
      expect(shiftExitReportUpdate).toHaveBeenCalledWith({
        where: { id: 'report-1' },
        data: { emailStatus: 'SKIPPED', notifiedAt: expect.any(Date) as Date },
      });
    });

    it('sin destinatarios (recipientCount=0), marca SKIPPED', async () => {
      notifyRolesWithAttachment.mockResolvedValue({
        recipientCount: 0,
        allEmailsSent: false,
      });

      await listener.onShiftExitReportSent(EVENT);

      expect(shiftExitReportUpdate).toHaveBeenCalledWith({
        where: { id: 'report-1' },
        data: { emailStatus: 'SKIPPED', notifiedAt: expect.any(Date) as Date },
      });
    });

    it('si algún correo falla (allEmailsSent=false con destinatarios), marca FAILED', async () => {
      notifyRolesWithAttachment.mockResolvedValue({
        recipientCount: 2,
        allEmailsSent: false,
      });

      await listener.onShiftExitReportSent(EVENT);

      expect(shiftExitReportUpdate).toHaveBeenCalledWith({
        where: { id: 'report-1' },
        data: { emailStatus: 'FAILED', notifiedAt: expect.any(Date) as Date },
      });
    });

    it('si algo lanza (ej. storage caído), marca FAILED y NUNCA propaga la excepción', async () => {
      const errorSpy = jest
        .spyOn(Logger.prototype, 'error')
        .mockImplementation();
      getObjectBuffer.mockRejectedValue(new Error('bucket caído'));

      await expect(
        listener.onShiftExitReportSent(EVENT),
      ).resolves.toBeUndefined();

      expect(shiftExitReportUpdate).toHaveBeenCalledWith({
        where: { id: 'report-1' },
        data: { emailStatus: 'FAILED', notifiedAt: expect.any(Date) as Date },
      });
      errorSpy.mockRestore();
    });

    it('si falla el update de emailStatus, tampoco propaga la excepción', async () => {
      const errorSpy = jest
        .spyOn(Logger.prototype, 'error')
        .mockImplementation();
      shiftExitReportUpdate.mockRejectedValue(new Error('db caída'));

      await expect(
        listener.onShiftExitReportSent(EVENT),
      ).resolves.toBeUndefined();
      errorSpy.mockRestore();
    });
  });
});
