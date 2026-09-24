/**
 * Convenciones de "key" (ruta del objeto dentro del bucket) para el
 * almacenamiento de archivos de Flota — ver Diseño del RFC R2-storage.
 *
 * Las keys NUNCA llevan el id del padre (equipo/registro): la base de datos
 * es el índice (guarda la key en la columna `*_key`). Esto evita fugar
 * relaciones por el nombre del archivo y simplifica el rename/move.
 *
 *   tmp/<userId>/<uuid>.<ext>              — subida cruda, sin reclamar
 *   equipment-photos/<uuid>.<ext>          — foto de equipo (claimed)
 *   equipment-documents/<uuid>.<ext>       — documento de equipo (claimed)
 *   fuel-photos/<uuid>.<ext>               — foto de carga de combustible (claimed)
 */
import { randomUUID } from 'node:crypto';
import { BadRequestException } from '@nestjs/common';

interface FileKindConfig {
  readonly prefix: string;
  readonly allowedExtensions: readonly string[];
}

const IMAGE_EXTENSIONS = ['jpg', 'png', 'webp'] as const;
const DOCUMENT_EXTENSIONS = [...IMAGE_EXTENSIONS, 'pdf'] as const;

/**
 * Los 3 usos de Flota (ver Diseño del RFC). Cada uno define su prefijo de
 * key final y qué extensiones acepta — la extensión sale de los bytes reales
 * del archivo (ver `file-signature.ts`), nunca del nombre que mandó el
 * cliente.
 */
export const FILE_KINDS = {
  'equipment-photo': {
    prefix: 'equipment-photos/',
    allowedExtensions: IMAGE_EXTENSIONS,
  },
  'equipment-document': {
    prefix: 'equipment-documents/',
    allowedExtensions: DOCUMENT_EXTENSIONS,
  },
  'fuel-photo': {
    prefix: 'fuel-photos/',
    allowedExtensions: IMAGE_EXTENSIONS,
  },
} satisfies Record<string, FileKindConfig>;

export type FileKind = keyof typeof FILE_KINDS;

// Los ids de Better Auth son alfanuméricos (confirmado contra la tabla
// "user" en Postgres: 32 chars, sin guiones ni símbolos — ver nanoid/generador
// de Better Auth). El rango 16-64 da margen a un cambio de longitud del
// generador sin permitir separadores de path (`/`, `..`) disfrazados de id.
const USER_ID_SEGMENT = '[A-Za-z0-9]{16,64}';
const UUID_SEGMENT =
  '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';

const ALL_EXTENSIONS = Array.from(
  new Set(Object.values(FILE_KINDS).flatMap((kind) => kind.allowedExtensions)),
);

/**
 * Estricta a propósito: solo matchea el shape exacto `tmp/<userId>/<uuid>.<ext>`
 * con una de las extensiones que el sistema puede llegar a producir (nunca
 * cualquier string arbitrario) — cualquier otra cosa (traversal, segmentos
 * de más, extensión desconocida) no matchea y se rechaza en
 * `assertOwnedTmpKey`.
 */
export const TMP_KEY_REGEX = new RegExp(
  `^tmp/(${USER_ID_SEGMENT})/${UUID_SEGMENT}\\.(${ALL_EXTENSIONS.join('|')})$`,
);

export function buildTmpKey(userId: string, ext: string): string {
  return `tmp/${userId}/${randomUUID()}.${ext}`;
}

export function buildFinalKey(kind: FileKind, ext: string): string {
  return `${FILE_KINDS[kind].prefix}${randomUUID()}.${ext}`;
}

export interface OwnedTmpKey {
  readonly ext: string;
}

/**
 * Valida en capas (ver Diseño del RFC, "Claim en los servicios de dominio"):
 * 1) la key tiene el shape `tmp/<userId>/<uuid>.<ext>`;
 * 2) el segmento userId es el dueño de la sesión (nunca una key ajena);
 * 3) la extensión es válida para el `kind` que se está reclamando (ej. un
 *    PDF no sirve como foto).
 *
 * Nunca acepta keys finales (`equipment-photos/…`, etc.) — solo `tmp/`.
 */
export function assertOwnedTmpKey(
  key: string,
  userId: string,
  kind: FileKind,
): OwnedTmpKey {
  const match = TMP_KEY_REGEX.exec(key);
  if (!match) {
    throw new BadRequestException('La key del archivo temporal no es válida');
  }

  const [, ownerId, ext] = match;
  if (ownerId !== userId) {
    throw new BadRequestException(
      'No puedes usar un archivo temporal de otro usuario',
    );
  }

  const { allowedExtensions } = FILE_KINDS[kind];
  if (!(allowedExtensions as readonly string[]).includes(ext)) {
    throw new BadRequestException(
      `El tipo de archivo no es válido para "${kind}"`,
    );
  }

  return { ext };
}
