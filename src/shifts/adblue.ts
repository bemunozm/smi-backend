import { formatNumber } from '../common/format/number';
import {
  registerDecorator,
  type ValidationArguments,
  type ValidationOptions,
} from 'class-validator';

/** Tope de litros de AdBlue por turno: el estanque de un camión minero no pasa de unos cientos. */
export const ADBLUE_MAX_LITERS = 1000;

/**
 * Regla única de consistencia del AdBlue, compartida por el cierre (DTO) y la
 * edición (servicio, sobre el estado ya mezclado): con AdBlue van litros
 * (> 0 y ≤ tope); sin AdBlue no puede venir ningún litro. Devuelve el mensaje
 * del error o `null` si es consistente.
 */
export function adBlueError(adBlue: unknown, liters: unknown): string | null {
  if (adBlue === true) {
    if (
      typeof liters !== 'number' ||
      !Number.isFinite(liters) ||
      liters <= 0 ||
      liters > ADBLUE_MAX_LITERS
    ) {
      return `Si cargaste AdBlue, indica los litros (mayor que 0 y hasta ${formatNumber(ADBLUE_MAX_LITERS)} L)`;
    }
    return null;
  }
  if (liters !== undefined && liters !== null) {
    return 'Sin AdBlue no se pueden informar litros de AdBlue';
  }
  return null;
}

/** Valida `adBlueLiters` contra el `adBlue` del mismo body. */
export function IsAdBlueLitersConsistent(options?: ValidationOptions) {
  return (target: object, propertyName: string): void => {
    registerDecorator({
      name: 'isAdBlueLitersConsistent',
      target: target.constructor,
      propertyName,
      options,
      validator: {
        validate(value: unknown, args: ValidationArguments): boolean {
          const { adBlue } = args.object as { adBlue?: unknown };
          return adBlueError(adBlue, value) === null;
        },
        defaultMessage(args: ValidationArguments): string {
          const { adBlue } = args.object as { adBlue?: unknown };
          return adBlueError(adBlue, args.value) ?? '';
        },
      },
    });
  };
}
