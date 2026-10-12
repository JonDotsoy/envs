# Features

Resumen de las funcionalidades de `@jondotsoy/envs`. Para el detalle de uso, consulta el [README](../README.md).

## Valores de todos los worktrees en un solo archivo

- Guarda los `.env` del repo principal y de cada worktree de git en `.envs/values.yml`.
- `.envs/` siempre vive en el repo principal, incluso al ejecutar comandos desde un worktree.
- `envs init` crea `.envs/.gitignore` (con `*`) para que git ignore la carpeta.
- Los worktrees se identifican por su rama (o por el nombre de su carpeta en detached HEAD).

## Sincronización

| Comando | Función |
| --- | --- |
| `envs pull` | Recoge los `.env` existentes y los escribe en `values.yml`. |
| `envs push` | Distribuye `values.yml` a los `.env` de cada worktree. |
| `envs edit` | Ejecuta `init` (si hace falta) y `pull`, abre el editor y al cerrarlo ejecuta `push`. |
| `envs use [profile]` | Cambia el perfil del worktree actual y lo sincroniza; sin argumentos lista el perfil de cada worktree. |
| `envs restore <hash> [--force]` | Restablece `values.yml` al estado de un punto del historial, agrega un punto nuevo y sincroniza. No borra puntos. Se niega si la cadena de hashes está rota, salvo con `--force`. |
| `envs config set <clave> <valor>` / `get [clave]` / `delete <clave>` | Gestiona la configuración guardada en `.envs/config.yml`. |

- `push` actualiza las variables existentes en su lugar, agrega las nuevas al final y conserva los comentarios.
- `push` se niega, sin escribir nada, si un nombre de variable no es válido o un valor tiene un salto de línea (empezaría otra línea del `.env` e inyectaría otra variable). Escríbelo en una línea, con secuencias `\n` si la aplicación las espera. `envs lint` lo avisa (`unsafe-dotenv-value`) y Save en el editor web lo rechaza antes de guardar.
- `push` también **elimina las variables huérfanas**: las que `envs` administra (están o estuvieron en `values.yml` o en su historial) pero que el worktree ya no resuelve, por ejemplo tras `envs restore`. Las variables que `envs` nunca administró no se tocan. Cada eliminación se informa en la salida (`✕ VARIABLE removed from …`), sin mostrar valores.
- Con `envs push` solo se muestran las variables cuyo valor cambia.

## Editores

- **VS Code** (`envs edit`): abre `values.yml` con `code -w`; si el editor falla, no se hace `push`.
- **Editor web** (`envs edit --ui`): servidor local (`127.0.0.1`, puerto aleatorio) con una interfaz React para perfiles, valores por defecto y valores por worktree. El botón **Save** guarda y hace `push`.
- **Panel History** del editor web: lista los puntos del historial (el más reciente primero). Al pasar el mouse o hacer clic en un punto (el clic solo lo selecciona) muestra qué cambiaría respecto al editor: en rojo lo que se eliminaría y en verde lo que cambiaría o se agregaría. El botón **Restore** pide confirmación y restablece ese punto agregando uno nuevo.

![Editor web iniciado con envs edit --ui](assets/images/edit-ui.png)

- Recorrido con capturas de cada acción (editar, perfiles, guardar, historial y restablecer) en [ui.md](ui.md).
- Validación en el editor mediante JSON Schema ([`schema/values.schema.json`](../schema/values.schema.json)), publicado en <https://jondotsoy.github.io/envs/schema.json>.

## Historial

- Registra cada cambio de `values.yml` en `.envs/history.ndjson`, un archivo append-only con un punto por línea.
- Distingue dos conceptos: el **snapshot** (`values.yml`, el estado actual) y los **cambios** (el historial, solo las diferencias con el valor anterior `from` y el nuevo `to`).
- Los puntos forman una cadena de hashes (`prev`/`hash`) y se crean con `pull`, `edit`, **Save** del editor web y `use`.
- Activo por defecto; se desactiva con `envs config set history false`.
- Detalle en [history.md](history.md).

## Secretos, concurrencia y permisos

- El historial guarda los secretos (nombres sensibles, URLs con contraseña) solo como huellas con clave; `envs restore` conserva el valor actual de un secreto y lo avisa. `envs history redact` limpia un historial antiguo y `envs config set history.secrets true` guarda los secretos en claro. Detalle en [history.md](history.md#secretos).
- La consola enmascara también la contraseña de una URL (`postgres://user:********@host/db`).
- Los comandos que escriben toman `.envs/lock`: varios procesos a la vez no bifurcan la cadena ni pierden cambios.
- `.envs/` se crea `700` y sus archivos `600`; los comandos que escriben aprietan los de un proyecto anterior.

## Perfiles

- Cada worktree usa un perfil (`uses.<worktree>`); si no se indica, usa `default`.
- Cada perfil tiene `defaults` (valores para todos los worktrees del perfil) y `envs` (valores por variable y worktree).
- Precedencia, de menor a mayor: `defaults` de `default`, `envs` de `default`, `defaults` del perfil, `envs` del perfil.
- Al escribir un perfil nuevo en `uses` durante `envs edit`, se crea como copia de `default`.
- Soporta el formato anterior (`defaults` y `envs` en la raíz) y lo migra automáticamente.

## Tipos de valores

- Cadenas, números y booleanos (`PORT: 3000`, `DEBUG: true`).
- `pull` convierte `true`/`false` y números canónicos; cualquier otro valor (`007`, `1e3`) queda como cadena.

## Seguridad (`envs lint`)

Revisa problemas de seguridad sin imprimir nunca los valores, termina con código 1 si hay alguno (útil en CI).

- **Git:** `values.yml`, el historial (`history.ndjson`) o `.env` versionados o no ignorados.
- **Permisos:** archivos (incluido el historial) legibles, ejecutables o escribibles por otros usuarios.
- **Secretos:** variables sensibles vacías o con valores típicos (`changeme`, `admin`…), secretos compartidos en `defaults` y valores con formato de secreto conocido (AWS, GitHub, Slack, `sk-…`, claves privadas).
- **URLs:** credenciales embebidas o protocolos inseguros (`http://`, `ws://`, `ftp://`).
- **Configuración:** perfiles desconocidos en `uses`, y valores de worktrees que git ya no lista (`unknown-worktree`).

## Salida de la consola

- Valores sensibles (`PASSWORD`, `TOKEN`, `SECRET`, `API_KEY`, palabras `KEY`…) se muestran como `********`.
- Colores desactivables con la variable `NO_COLOR`.

## Instalación

- Sin instalación: `bunx @jondotsoy/envs <comando>`.
- Global: `bun add -g @jondotsoy/envs`.
- Requiere [Bun](https://bun.com) y git.
