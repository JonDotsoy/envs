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

Esto detecta modificaciones accidentales o parciales. No impide que alguien con acceso de escritura regenere toda la cadena.

## Cuándo se agrega un punto

Un punto se escribe solo si `values.yml` cambió realmente.

| Acción | Punto |
| --- | --- |
| Primer `envs pull` (también el que ejecuta `envs edit`) | Inicializa el historial. Sus `changes` describen todo el snapshot inicial, como si se hubiera construido desde cero. |
| `envs pull` posterior | Lo que cambió, por ejemplo tras editar a mano el `.env` de un worktree. |
| `envs edit` | Lo que cambiaste en el editor. |
| **Save** en `envs edit --ui` | Lo que cambiaste en la interfaz web. |
| `envs use <perfil>` | El cambio de perfil del worktree. |
| `envs restore <hash>` | La diferencia entre el estado actual y el restablecido (ver más abajo). |
| `envs push`, `envs lint`, `envs use` sin argumentos | Ninguno. |

Editar `values.yml` a mano fuera de estos comandos no genera un punto: forma parte del snapshot, pero no queda en los cambios.

## Reconstruir el estado

Aplicando los puntos en orden, desde el primero, se obtiene el snapshot tal como quedó después de cada uno. Como el primer punto contiene todo el estado inicial, el resultado tras el último punto coincide con `values.yml` (salvo las ediciones manuales mencionadas arriba).

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
4. Ejecuta `push` para actualizar los `.env`.

Nunca se borra ni se reescribe un punto: si el historial tiene 4 puntos, después de restablecer tiene 5, y el último dice, con `from` y `to`, cómo se volvió atrás. Si el estado actual ya es el pedido, no se agrega nada.

Falla con código 1 si no se indica el hash, si ninguno coincide o si el prefijo coincide con varios puntos. Con el historial desactivado, restablece `values.yml` pero no agrega el punto.

Un perfil que no tiene valores en el estado restablecido queda vacío; no se copia de `default`.

## Activar o desactivar

El historial está activo por defecto. Lee la clave `history` de `.envs/config.yml`; solo un `false` explícito lo desactiva y `values.yml` se sigue actualizando con normalidad.

```sh
envs config set history false   # dejar de registrar
envs config set history true    # registrar de nuevo (o `envs config delete history`)
```

Los cambios hechos mientras está desactivado no tienen punto: al reactivarlo, el siguiente punto parte del `values.yml` de ese momento.

## Seguridad

- El archivo se crea con modo `600`, porque guarda valores de variables.
- Guarda tanto `from` como `to` con los valores reales, secretos incluidos. Al ser append-only, un valor que ya se registró no se puede quitar sin reescribir el archivo (lo que rompe la cadena).
- `.envs/.gitignore` contiene `*`, así que el historial no se versiona. No lo agregues al repositorio.
