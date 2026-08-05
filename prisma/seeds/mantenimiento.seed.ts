/**
 * Seed del dominio Mantenimiento (OTs, tareas, bitácora, umbrales,
 * actividades) — datos de ejemplo basados en el mockup del cliente
 * (contexto minería chilena).
 *
 * Reutiliza el MISMO singleton `prismaClient` que el resto de los seeds (ver
 * `src/common/prisma/prisma.service.ts`) — nunca abre un segundo pool.
 *
 * Idempotente: si ya existe al menos una OT, se asume que el seed ya corrió
 * y se omite por completo (evita duplicar filas si `db:seed` se ejecuta más
 * de una vez sobre la misma base).
 */
import { Logger } from '@nestjs/common';

import { prismaClient } from '../../src/common/prisma/prisma.service';

const logger = new Logger('SeedMantenimiento');

const MANTENEDOR_EMAIL = 'mantenedor@smi.local';

export async function seedMantenimiento(): Promise<void> {
  const existingOrdenes = await prismaClient.ordenTrabajo.count();
  if (existingOrdenes > 0) {
    logger.warn('Ya existen órdenes de trabajo, se omite el seed de Mantenimiento');
    return;
  }

  const mantenedor = await prismaClient.user.findFirst({
    where: { email: MANTENEDOR_EMAIL },
    select: { id: true },
  });

  if (!mantenedor) {
    logger.warn(
      `No se encontró el usuario "${MANTENEDOR_EMAIL}" — las OTs/actividades que ` +
        'deberían quedar asignadas al mantenedor se crearán sin asignar. ' +
        'Corre el seed de usuarios primero.',
    );
  }

  const asignadoAId = mantenedor?.id;

  // OT1 — correctiva por hallazgo, crítica, sin tareas hechas aún.
  await prismaClient.ordenTrabajo.create({
    data: {
      equipoId: 'CM-003',
      titulo: 'Frenos con baja respuesta — equipo fuera de servicio',
      estado: 'PENDIENTE',
      prioridad: 'CRITICA',
      tipo: 'CORRECTIVA',
      origen: 'HALLAZGO',
      origenDetalle: 'P. Soto',
      tareas: {
        create: [
          { texto: 'Medir espesor de balatas', posicion: 0 },
          { texto: 'Purgar circuito de frenos', posicion: 1 },
          { texto: 'Prueba de frenado en rampa', posicion: 2 },
        ],
      },
    },
  });

  // OT2 — en proceso, con 2 de 3 tareas hechas y 1 intervención de bitácora
  // ya registrada (soloLectura: true, como la deja el flujo de hallazgo).
  const ot2 = await prismaClient.ordenTrabajo.create({
    data: {
      equipoId: 'PE-004',
      titulo: 'Fuga de aceite hidráulico en cilindro de levante',
      estado: 'EN_PROCESO',
      prioridad: 'ALTA',
      tipo: 'CORRECTIVA',
      origen: 'HALLAZGO',
      origenDetalle: 'J. Rojas',
      tareas: {
        create: [
          { texto: 'Aislar circuito hidráulico', hecha: true, posicion: 0 },
          { texto: 'Cambiar sello del cilindro', hecha: true, posicion: 1 },
          { texto: 'Reponer aceite y probar levante', hecha: false, posicion: 2 },
        ],
      },
    },
  });

  await prismaClient.intervencion.create({
    data: {
      ordenId: ot2.id,
      tipo: 'CORRECTIVA',
      detalle:
        'Aislado el circuito y confirmada fisura en el sello del cilindro de levante',
      horasHombre: 1.5,
      soloLectura: true,
      insumos: {
        create: [{ insumoId: 'ORG-008', cantidad: 2 }],
      },
    },
  });

  // OT3 — mantención preventiva por umbral de horas.
  await prismaClient.ordenTrabajo.create({
    data: {
      equipoId: 'EX-001',
      titulo: 'Mantención 1.250 h — filtros, aceite y refrigerante',
      estado: 'EN_PROCESO',
      prioridad: 'MEDIA',
      tipo: 'PREVENTIVA',
      origen: 'PREVENTIVO',
      tareas: {
        create: [
          { texto: 'Cambio de filtro de aceite', hecha: true, posicion: 0 },
          { texto: 'Cambio de aceite motor', hecha: false, posicion: 1 },
          { texto: 'Revisar refrigerante', hecha: false, posicion: 2 },
          { texto: 'Engrase general', hecha: false, posicion: 3 },
        ],
      },
    },
  });

  // OT4 — completada manualmente por un admin. El mockup no detalla el
  // texto de las tareas de esta OT, así que se infieren del título (todas
  // marcadas hechas, consistente con estado COMPLETADA).
  await prismaClient.ordenTrabajo.create({
    data: {
      equipoId: 'CG-002',
      titulo: 'Cambio de mangueras hidráulicas del tercer tramo',
      estado: 'COMPLETADA',
      prioridad: 'BAJA',
      tipo: 'CORRECTIVA',
      origen: 'MANUAL',
      origenDetalle: 'Admin',
      tareas: {
        create: [
          { texto: 'Retirar mangueras dañadas del tercer tramo', hecha: true, posicion: 0 },
          { texto: 'Instalar mangueras nuevas', hecha: true, posicion: 1 },
          { texto: 'Probar presión del circuito hidráulico', hecha: true, posicion: 2 },
        ],
      },
    },
  });

  await prismaClient.umbralMantenimiento.createMany({
    data: [
      { tipoEquipo: 'Excavadora', tipoMantencion: 'Mantención 250 h', umbralHoras: 250 },
      { tipoEquipo: 'Camión tolva', tipoMantencion: 'Mantención 500 h', umbralHoras: 500 },
      {
        tipoEquipo: 'Perforadora',
        tipoMantencion: 'Cambio de barra y filtros',
        umbralHoras: 200,
      },
    ],
  });

  await prismaClient.actividad.createMany({
    data: [
      {
        descripcion: 'Verificar torque de pernos de oruga en EX-001',
        origen: 'EQUIPO',
        referencia: 'EX-001',
        asignadoAId,
        estado: 'PENDIENTE',
      },
      {
        descripcion: 'Reponer O-rings bajo stock mínimo en bodega',
        origen: 'MANUAL',
        referencia: 'ORG-008',
        estado: 'COMPLETADA',
      },
      {
        descripcion: 'Inspeccionar frenos según hallazgo crítico',
        origen: 'HALLAZGO',
        referencia: 'CM-003',
        asignadoAId,
        estado: 'PENDIENTE',
      },
    ],
  });

  logger.log('Seed de Mantenimiento completado: 4 OTs, 1 intervención, 3 umbrales, 3 actividades');
}
