import {
  registerDecorator,
  ValidationArguments,
  ValidationOptions,
} from 'class-validator';

import { isValidRut } from '../rut';

/**
 * Valida que el campo sea un RUT chileno con dígito verificador correcto
 * (algoritmo módulo 11, ver `../rut.ts`). Tolera puntos/guion/espacios y
 * "k"/"K" — el DTO solo valida FORMA; `OperatorsService` normaliza al
 * formato canónico `12345678-K` antes de persistir.
 */
export function IsChileanRut(validationOptions?: ValidationOptions) {
  return function (object: object, propertyName: string): void {
    registerDecorator({
      name: 'isChileanRut',
      target: object.constructor,
      propertyName,
      options: validationOptions,
      validator: {
        validate(value: unknown): boolean {
          return typeof value === 'string' && isValidRut(value);
        },
        defaultMessage(args: ValidationArguments): string {
          return `${args.property} no es un RUT chileno válido`;
        },
      },
    });
  };
}
