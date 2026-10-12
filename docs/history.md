# Historial

`envs` registra cómo evoluciona `values.yml`. Para el resumen de comandos, consulta el [README](../README.md); para el resto de funcionalidades, [features.md](features.md).

## Dos conceptos: snapshot y cambios

| Concepto | Dónde | Qué es |
| --- | --- | --- |
| **Snapshot** | `.envs/values.yml` | El estado completo y actual: todos los perfiles, valores por defecto y valores por worktree. Es el archivo que editas y el único que lee `push`. |
| **Cambios** | `.envs/history.ndjson` | Un registro append-only. Cada línea es un *punto* que guarda solo lo que cambió entre dos estados, nunca una copia completa del archivo. |

El snapshot responde "¿cuáles son los valores ahora?". Los cambios responden "¿qué cambió, cuándo y desde qué valor?".

El historial no reemplaza a `values.yml`: si borras `history.ndjson`, `envs` sigue funcionando y el siguiente `pull` empieza un historial nuevo.

## Formato de un punto

Cada línea de `.envs/history.ndjson` es un objeto JSON:

```json
{"hash":"3f9a1c0b7d2e","prev":"e7c8ebe462f1","timestamp":"2026-01-01T00:02:00.000Z","changes":[{"path":["profiles","default","envs","PORT","feature-x"],"from":3001,"to":3002}]}
```

| Campo | Descripción |
| --- | --- |
| `hash` | Primeros 12 caracteres hexadecimales del sha256 de `{prev, timestamp, changes}` serializado como JSON. |
| `prev` | `hash` del punto anterior; `null` en el primero. |
| `timestamp` | Momento del punto, en ISO 8601 (UTC). |
| `changes` | Lista de diferencias respecto al estado anterior. |
| `resync` | Solo aparece (con valor `true`) en los puntos de resincronización; ver más abajo. |

### Cambios (`changes`)

Cada elemento tiene:

- `path`: ubicación del valor dentro del snapshot. Puede ser:
  - `["uses", "<worktree>"]`: perfil del worktree.
  - `["profiles", "<perfil>", "defaults", "<VARIABLE>"]`: valor por defecto del perfil.
  - `["profiles", "<perfil>", "envs", "<VARIABLE>", "<worktree>"]`: valor de la variable en un worktree.
- `from`: valor anterior. No aparece si la entrada se agregó.
- `to`: valor nuevo. No aparece si la entrada se eliminó.

Los valores conservan su tipo (`3001` es un número, `"info"` una cadena, `true` un booleano).

## Cadena de hashes

`envs` verifica la cadena cada vez que lee el historial. Un punto está roto si su contenido ya no coincide con su `hash` (alguien lo editó) o si su `prev` no es el hash del punto anterior (se eliminó, insertó o reordenó otro).

- **`envs restore`** se niega, con código 1 y sin cambiar nada, indicando los puntos rotos. `envs restore <hash> --force` lo restablece de todos modos, avisando de ello, para cuando ya revisaste el archivo.
- **`pull`, `edit`, `use` y Save** avisan (`the hash chain is broken at …`) y siguen funcionando.
- **El editor web** muestra un aviso con los puntos rotos y rechaza restablecer.

Cada punto guarda el hash del anterior y su propio `hash` cubre `prev`, `timestamp` y `changes`. Por eso el archivo es una cadena: alterar, reordenar o eliminar un punto cambia el hash de todos los siguientes y deja de coincidir con sus `prev`.

Verificación con Bun:

```ts
import { createHash } from "node:crypto";

const lines = (await Bun.file(".envs/history.ndjson").text()).trim().split("\n");
let prev: string | null = null;
for (const line of lines) {
  const { hash, ...point } = JSON.parse(line);
  const expected = createHash("sha256").update(JSON.stringify(point)).digest("hex").slice(0, 12);
  if (point.prev !== prev || hash !== expected) throw new Error(`Cadena rota en ${hash}`);
  prev = hash;
}
console.log(`${lines.length} puntos válidos`);
```

Este script hace a mano lo que `envs` ya hace. Detecta modificaciones accidentales o parciales; no impide que alguien con acceso de escritura regenere toda la cadena (los hashes no están firmados).

## Cuándo se agrega un punto

Un punto se escribe solo si `values.yml` cambió realmente.

| Acción | Punto |
| --- | --- |
| El primer punto de un historial (lo escriba el comando que lo escriba: `pull`, `edit`, Save de la interfaz web o `use`) | Inicializa el historial. Sus `changes` describen todo el snapshot, como si se hubiera construido desde cero. Así un proyecto anterior a la feature, o uno al que se le borró `history.ndjson`, queda con una base completa. |
| `envs pull` posterior | Lo que cambió, por ejemplo tras editar a mano el `.env` de un worktree. |
| `envs edit` | Lo que cambiaste en el editor. |
| **Save** en `envs edit --ui` | Lo que cambiaste en la interfaz web. |
| `envs use <perfil>` | El cambio de perfil del worktree. |
| `envs restore <hash>` | La diferencia entre el estado actual y el restablecido (ver más abajo). |
| `envs push`, `envs lint`, `envs use` sin argumentos | Ninguno. |

### Puntos de resincronización

Aplicar todos los puntos debe dar siempre `values.yml`. Si algo cambió `values.yml` **fuera del historial**, el siguiente comando que registra un punto lo detecta (compara `values.yml` con el estado reconstruido) y agrega primero un **punto de resincronización**, con `"resync": true`, que contiene esa diferencia. Después viene el punto propio del comando, encadenado al de resincronización.

Esto ocurre en dos casos:

- Editaste `values.yml` a mano, fuera de `envs edit`.
- Hubo cambios mientras el historial estaba desactivado (`history: false`).

Un punto de resincronización es un punto normal: se puede ver en el panel y es un destino válido de `envs restore`. Solo aparece si hay diferencia, y el momento que registra es el del comando que lo detectó, no el de la edición manual, que no se puede conocer.

## Reconstruir el estado

Aplicando los puntos en orden, desde el primero, se obtiene el snapshot tal como quedó después de cada uno. Como el primer punto contiene todo el estado inicial, el resultado tras el último punto coincide con `values.yml` (los cambios hechos fuera del historial quedan registrados por el siguiente punto de resincronización).

Para recuperar un valor anterior, busca en `changes` el `path` y toma su `from`:

```sh
grep '"PORT","feature-x"' .envs/history.ndjson
```

## Restablecer un estado

```sh
envs restore <hash>
```

Restablece `values.yml` al estado que tenía justo después del punto `<hash>` (basta con un prefijo único del hash).

1. Reconstruye ese estado aplicando los puntos en orden hasta el indicado.
2. Escribe el resultado en `values.yml`.
3. Registra la diferencia entre el estado actual y el restablecido como un **punto nuevo** al final del historial.
4. Ejecuta `push` para actualizar los `.env`. `push` también elimina de los `.env` las variables que el estado restablecido ya no tiene (y que `envs` administraba), para que el siguiente `pull` no las vuelva a incorporar.

Nunca se borra ni se reescribe un punto: si el historial tiene 4 puntos, después de restablecer tiene 5, y el último dice, con `from` y `to`, cómo se volvió atrás. Si el estado actual ya es el pedido, no se agrega nada.

Falla con código 1 si no se indica el hash, si ninguno coincide o si el prefijo coincide con varios puntos. Con el historial desactivado, restablece `values.yml` pero no agrega el punto.

Un perfil que no tiene valores en el estado restablecido queda vacío; no se copia de `default`.

## Panel History del editor web

`envs edit --ui` incluye un panel **History** con los puntos de `history.ndjson`, del más reciente al más antiguo: hash corto, fecha y cantidad de cambios.

- Al pasar el mouse sobre un punto, o al hacer clic para dejarlo seleccionado (el clic nunca restablece), se compara el estado tras ese punto con los valores del editor, agrupados por perfiles de los worktrees (`uses`) y por perfil (`defaults`, `envs`):
  - **rojo**: la propiedad existe ahora y se eliminaría;
  - **verde**: la propiedad cambiaría (valor actual → valor en ese punto) o se agregaría (marcada como *added*).
- Si el estado es el mismo, indica "No differences".
- **Restore** pide confirmación (y avisa que se perderán los cambios sin guardar del editor) y hace lo mismo que `envs restore <hash>`: agrega un punto nuevo, no borra ninguno, ejecuta `push` y recarga el editor y el panel.
- Con el historial desactivado o vacío, el panel muestra un mensaje en lugar de la lista y no permite restablecer.

El servidor (solo en `127.0.0.1`) expone `GET /api/history` (`{enabled, points}`, en orden del archivo) y `POST /api/restore` con `{"hash": "<12 caracteres>"}`.

## Historial dañado

Un historial dañado no detiene ningún comando.

- **Última línea incompleta** (un proceso murió a mitad de una escritura): se ignora, se avisa, y el siguiente punto la descarta antes de agregarse, para no pegarse a media línea. Una última línea válida a la que solo le falta el salto de línea lo recibe.
- **Una línea ilegible en medio:** `pull`, `edit`, `use` y Save la omiten y avisan con los números de línea (`damaged lines (3)`). No se reescribe nada. Lo que contenían los puntos omitidos queda cubierto por el siguiente [punto de resincronización](#puntos-de-resincronización), porque `values.yml` es la referencia.
- **`envs restore`** se niega con código 1, indicando las líneas, y no cambia nada: sin todos los puntos no se puede reconstruir un estado exacto. Repara o elimina esas líneas y vuelve a intentarlo.
- **Editor web:** el panel muestra los puntos legibles y un aviso con las líneas dañadas; Restore se rechaza hasta que el archivo se repare.

Un punto se considera ilegible si no es JSON o si le faltan `hash`, `prev`, `timestamp` o `changes`.

## Activar o desactivar

El historial está activo por defecto. Lee la clave `history` de `.envs/config.yml`; solo un `false` explícito lo desactiva y `values.yml` se sigue actualizando con normalidad.

```sh
envs config set history false   # dejar de registrar
envs config set history true    # registrar de nuevo (o `envs config delete history`)
```

Los cambios hechos mientras está desactivado no tienen punto en ese momento, pero no se pierden: al reactivarlo, el siguiente comando que registra un punto agrega primero un [punto de resincronización](#puntos-de-resincronización) con lo que cambió.

## Seguridad

- El archivo se crea con modo `600`, porque guarda valores de variables.
- Guarda tanto `from` como `to` con los valores reales, secretos incluidos. Al ser append-only, un valor que ya se registró no se puede quitar sin reescribir el archivo (lo que rompe la cadena).
- `.envs/.gitignore` contiene `*`, así que el historial no se versiona. No lo agregues al repositorio.
