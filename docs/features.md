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

- `push` actualiza las variables existentes en su lugar, agrega las nuevas al final y conserva comentarios y variables que no están en `values.yml`.
- Con `envs push` solo se muestran las variables cuyo valor cambia.

## Editores

- **VS Code** (`envs edit`): abre `values.yml` con `code -w`; si el editor falla, no se hace `push`.
- **Editor web** (`envs edit --ui`): servidor local (`127.0.0.1`, puerto aleatorio) con una interfaz React para perfiles, valores por defecto y valores por worktree. El botón **Save** guarda y hace `push`.
- Validación en el editor mediante JSON Schema ([`schema/values.schema.json`](../schema/values.schema.json)), publicado en <https://jondotsoy.github.io/envs/schema.json>.

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

- **Git:** `values.yml` o `.env` versionados o no ignorados.
- **Permisos:** archivos legibles, ejecutables o escribibles por otros usuarios.
- **Secretos:** variables sensibles vacías o con valores típicos (`changeme`, `admin`…), secretos compartidos en `defaults` y valores con formato de secreto conocido (AWS, GitHub, Slack, `sk-…`, claves privadas).
- **URLs:** credenciales embebidas o protocolos inseguros (`http://`, `ws://`, `ftp://`).
- **Configuración:** perfiles desconocidos en `uses`.

## Salida de la consola

- Valores sensibles (`PASSWORD`, `TOKEN`, `SECRET`, `API_KEY`, palabras `KEY`…) se muestran como `********`.
- Colores desactivables con la variable `NO_COLOR`.

## Instalación

- Sin instalación: `bunx @jondotsoy/envs <comando>`.
- Global: `bun add -g @jondotsoy/envs`.
- Requiere [Bun](https://bun.com) y git.
