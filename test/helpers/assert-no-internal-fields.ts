/**
 * Rutas (`$.data.homeBranch.createdById`) de todas las apariciones de `key`
 * en una respuesta, a cualquier profundidad (objetos y arreglos anidados).
 */
export function findKeyPaths(
  value: unknown,
  key: string,
  path = '$',
): string[] {
  if (Array.isArray(value)) {
    return value.flatMap((item, index) =>
      findKeyPaths(item, key, `${path}[${index}]`),
    );
  }
  if (value === null || typeof value !== 'object') return [];

  return Object.entries(value).flatMap(([name, child]) => {
    const childPath = `${path}.${name}`;
    return [
      ...(name === key ? [childPath] : []),
      ...findKeyPaths(child, key, childPath),
    ];
  });
}

/**
 * Falla si `createdById` aparece en CUALQUIER nivel de la respuesta. El `omit`
 * de una consulta no se propaga a las relaciones incluidas, así que mirar solo
 * la raíz no alcanza.
 */
export function expectNoCreatedById(body: unknown): void {
  expect(findKeyPaths(body, 'createdById')).toEqual([]);
}
