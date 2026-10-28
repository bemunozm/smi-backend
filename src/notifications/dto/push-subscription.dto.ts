import { Type } from 'class-transformer';
import {
  IsDefined,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUrl,
  ValidateNested,
} from 'class-validator';

/** Claves de cifrado que entrega `PushSubscription.toJSON()` del navegador. */
export class PushKeysDto {
  @IsString()
  @IsNotEmpty()
  p256dh!: string;

  @IsString()
  @IsNotEmpty()
  auth!: string;
}

export class CreatePushSubscriptionDto {
  // `require_protocol`: el endpoint es la URL que entrega el push service del
  // navegador — cualquier otra forma es un cliente mal armado.
  @IsUrl({ require_protocol: true, require_tld: false })
  endpoint!: string;

  // `@IsDefined()` es imprescindible: class-validator SALTEA `@ValidateNested`
  // cuando el valor viene undefined, y un body sin `keys` pasaría derecho
  // hasta reventar en el controller (500 en vez de 400).
  @IsDefined()
  @ValidateNested()
  @Type(() => PushKeysDto)
  keys!: PushKeysDto;

  /** Para reconocer el dispositivo si algún día hay UI de gestión. */
  @IsOptional()
  @IsString()
  userAgent?: string;
}

export class DeletePushSubscriptionDto {
  @IsUrl({ require_protocol: true, require_tld: false })
  endpoint!: string;
}
