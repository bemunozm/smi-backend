import { Module } from '@nestjs/common';

import { SucursalesModule } from '../sucursales/sucursales.module';
import {
  CompatibilidadController,
  EquiposDeInsumoController,
  RepuestosEquipoController,
} from './compatibilidad.controller';
import { CompatibilidadService } from './compatibilidad.service';

/**
 * Compatibilidad repuesto ↔ equipo (Joaquín, RFC-12).
 *
 * Módulo propio y no una carpeta dentro de `equipos/` o `inventario/`: la
 * relación no pertenece a ninguno de los dos dominios, los cruza. Sus tres
 * controllers montan rutas bajo `equipos/` e `inventario/` sin editar un solo
 * archivo de esos módulos.
 *
 * Importa `SucursalesModule` para resolver la bodega contra la que se cruza el
 * stock de los repuestos compatibles.
 */
@Module({
  imports: [SucursalesModule],
  controllers: [
    CompatibilidadController,
    RepuestosEquipoController,
    EquiposDeInsumoController,
  ],
  providers: [CompatibilidadService],
  exports: [CompatibilidadService],
})
export class CompatibilidadModule {}
