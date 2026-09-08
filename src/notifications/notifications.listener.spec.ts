import { Test, TestingModule } from '@nestjs/testing';

import { ROLES } from '../auth/roles';
import { NotificationsListener } from './notifications.listener';
import { NotificationsService } from './notifications.service';

describe('NotificationsListener', () => {
  let listener: NotificationsListener;

  const createForRoles = jest.fn();
  const createForUser = jest.fn();
  const resolveEquipoId = jest.fn();

  beforeEach(async () => {
    createForRoles.mockReset().mockResolvedValue([]);
    createForUser.mockReset().mockResolvedValue(undefined);
    // Por defecto el resolver "pasa" el mismo ref que recibe, como si ya
    // fuera un id válido — los tests que necesitan simular código→id o
    // ref-no-encontrado sobreescriben esto puntualmente.
    resolveEquipoId
      .mockReset()
      .mockImplementation((ref: string | null) => Promise.resolve(ref ?? null));

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        NotificationsListener,
        {
          provide: NotificationsService,
          useValue: { createForRoles, createForUser, resolveEquipoId },
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

  it('insumo.low-stock notifica a ADMIN + SUPERVISOR', async () => {
    await listener.onInsumoLowStock({
      insumoId: 'i1',
      nombre: 'Filtro de aceite',
      stock: 2,
      stockMinimo: 5,
    });

    expect(createForRoles).toHaveBeenCalledWith(
      [ROLES.ADMIN, ROLES.SUPERVISOR],
      expect.objectContaining({ tipo: 'insumo.low-stock' }),
    );
  });
});
