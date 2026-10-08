# Política de seguridad

## Versiones soportadas

Solo se mantiene la última versión publicada en npm de `@jondotsoy/envs`. Las correcciones de seguridad se publican en una versión nueva.

## Reportar una vulnerabilidad

No abras un issue público para reportar una vulnerabilidad. Repórtala de forma privada por uno de estos medios:

- Con el reporte privado de vulnerabilidades de GitHub: pestaña **Security** del repositorio, **Report a vulnerability**.
- Por correo a [hi@jon.soy](mailto:hi@jon.soy).

Incluye, si puedes:

- la versión de `@jondotsoy/envs` y de Bun que usas;
- una descripción del problema y su impacto;
- los pasos para reproducirlo.

Te responderé lo antes posible y coordinaremos la corrección y la divulgación del problema.

## Archivos que modifica

`envs` solo lee y escribe los archivos de esta tabla. `<raíz>` es el repo principal (dentro de un worktree, el repo padre) y `<worktree>` es la carpeta de cada worktree que lista `git worktree list`, incluido el repo principal, aunque esté fuera de `<raíz>`.

| Comando | Lee | Escribe |
| --- | --- | --- |
| `envs init` | — | Crea `<raíz>/.envs/`, `<raíz>/.envs/.gitignore` y `<raíz>/.envs/values.yml`, solo si no existen. Nunca sobrescribe. |
| `envs pull` | `<worktree>/.env` de cada worktree | Reescribe `<raíz>/.envs/values.yml`. El archivo se serializa de nuevo, así que se pierden los comentarios del YAML. |
| `envs push` | `<raíz>/.envs/values.yml` | Crea o actualiza `<worktree>/.env` de cada worktree que tenga valores. Actualiza las variables existentes en su línea, agrega las nuevas al final y conserva el resto del archivo. Si hay `defaults`, esto incluye a todos los worktrees. |
| `envs edit` | Lo mismo que `pull` y `push` | Lo mismo que `pull` y `push`. Además ejecuta `code -w <raíz>/.envs/values.yml`. |

Además:

- Ejecuta `git rev-parse` y `git worktree list` para ubicar la raíz y los worktrees. Son comandos de solo lectura.
- `envs edit` ejecuta el programa `code` que encuentre en el `PATH`.
- No hace conexiones de red ni modifica otros archivos del proyecto, ni siquiera el `.gitignore` de tu proyecto.

## Manejo de secretos

`envs` trabaja con valores que suelen ser secretos:

- `.envs/values.yml` guarda los valores de todos los worktrees en texto plano.
- `envs init` crea `.envs/.gitignore` con `*`, para que la carpeta `.envs/` no se suba a git. No quites ese archivo.
- `envs push` escribe los valores en los archivos `.env` de cada worktree. Asegúrate de que `.env` esté en el `.gitignore` de tu proyecto.
- No compartas `values.yml` ni lo pegues en issues o logs.
