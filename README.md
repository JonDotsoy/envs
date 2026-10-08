# @jondotsoy/envs

CLI para mantener en un solo archivo (`.envs/values.yml`) los valores del `.env` de cada worktree de git. Edita todos los valores juntos y distribúyelos a cada worktree, o recógelos desde los `.env` existentes.

Requiere [Bun](https://bun.com) y git.

## Instalación

```bash
bun add -g @jondotsoy/envs
```

O sin instalar:

```bash
bunx @jondotsoy/envs help
```

## Uso

Ejecuta los comandos dentro del repo o de cualquiera de sus worktrees. Dentro de un worktree, `.envs/` siempre vive en el repo principal.

| Comando | Qué hace |
| --- | --- |
| `envs init` | Crea `.envs/`, `.envs/.gitignore` (con `*`) y un `.envs/values.yml` vacío. No sobrescribe archivos existentes. |
| `envs pull` | Lee el `.env` del repo principal y de cada worktree y lo escribe en `values.yml`. Las variables que ya no están en un `.env` se quitan de `values.yml` para ese worktree. |
| `envs push` | Escribe `values.yml` en el `.env` de cada worktree. Actualiza las variables existentes en su línea, agrega las nuevas al final y conserva comentarios y variables que no están en `values.yml`. |
| `envs edit` | Ejecuta `pull`, abre `values.yml` con `code -w` y, al cerrar el editor, ejecuta `push`. Si el editor falla, no hace `push`. |
| `envs help` | Muestra la ayuda. |

Los worktrees se identifican por el nombre de su rama (o el nombre de su carpeta si están en HEAD desacoplado). El repo principal usa el nombre de su rama, por ejemplo `main`.

## Formato de `values.yml`

```yaml
defaults:
  LOG_LEVEL: info

envs:
  DATABASE_URL:
    main: postgres://localhost/main
    feature-x: postgres://localhost/feature_x
  PORT:
    main: "3000"
    feature-x: "3001"
```

- `defaults`: valor por defecto de cada variable. `push` lo escribe en el `.env` de todos los worktrees.
- `envs.<VARIABLE>.<worktree>`: valor de la variable en ese worktree. Sobrescribe al valor de `defaults`.
- Los valores pueden ser strings, números o booleanos (`PORT: 3000`, `DEBUG: true`); `push` los escribe en el `.env` como texto (`PORT=3000`, `DEBUG=true`). `pull` siempre escribe strings.

El schema (JSON Schema) está en [`schema/values.schema.json`](schema/values.schema.json). Para que VS Code valide el archivo con la extensión YAML, agrega al inicio de `values.yml`:

```yaml
# yaml-language-server: $schema=../schema/values.schema.json
```

## Desarrollo

```bash
bun install
bun test              # ejecuta los tests
bun test --coverage   # con cobertura
bun run build         # genera dist/ (envs.js y package.json)
```

- `src/envs.ts`: lógica de los comandos. `src/bin/envs.ts`: punto de entrada del CLI.
- `test/fixtures/workspace.ts`: fixture `createWorkspace({ main, worktrees, files })`, que crea un repo git temporal con worktrees, cada uno en su propia carpeta temporal.

## Publicación

El workflow **Publish** (Actions → Publish → Run workflow) sube la versión, hace el build y publica `dist/` en npm por OIDC (trusted publishing). Inputs:

- `bump`: `major`, `minor`, `patch` o `prerelease`.
- `tag`: dist-tag de npm (`latest`, `default`, `alpha` o `demo`). Con un tag distinto de `latest` la versión es una prerelease (`0.0.2-alpha.0`).
- `provenance`: publica con provenance. npm solo lo acepta si el repositorio es público.

Luego del publish crea el commit y el tag de la versión, y un release en GitHub con el enlace a la versión en npm.

## Seguridad

Para reportar una vulnerabilidad, mira [SECURITY.md](SECURITY.md).

## Licencia

[MIT](LICENSE)
