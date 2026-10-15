# Configuración

Opciones disponibles para ajustar `envs`: las claves de `.envs/config.yml` y las variables de entorno que el programa lee. Para el resumen de comandos, consulta el [README](../README.md); para el historial, [history.md](history.md); para el editor web, [ui.md](ui.md).

## Archivo `.envs/config.yml`

Guarda ajustes del proyecto como pares plano `clave: valor`. Se crea con el primer `envs config set`, vive junto a `values.yml` en la raíz del proyecto (compartido por todos los worktrees), queda fuera de git (`.envs/.gitignore` ignora todo) y tiene permisos `600`.

```sh
envs config set <clave> <valor>   # crea o cambia una clave
envs config get [clave]           # sin clave, lista todas
envs config delete <clave>        # vuelve al valor por defecto
```

Los valores `true` y `false` se guardan como booleanos, los números como números y el resto como texto. Las claves de la tabla se leen con una comparación estricta (`=== true` o `!== false`), así que un valor de otro tipo (por ejemplo, el texto `"yes"`) se trata como el valor por defecto.

### Dónde se guarda

Siempre en `<raíz>/.envs/config.yml`, donde `<raíz>` es el repositorio principal: dentro de un worktree `envs` sube al repo padre (`git rev-parse --git-common-dir`), así que todos los worktrees comparten la misma configuración. Fuera de git, usa el directorio actual. No se guarda en el home ni es global: cada proyecto tiene la suya.

Dentro del archivo, cada clave es una entrada plana de primer nivel; el punto forma parte del nombre y **no** crea anidación. Se escriben ordenadas alfabéticamente:

```yaml
history.secrets: true
ui.autosave: true
```

### Claves disponibles

| Clave | Tipo | Por defecto | Efecto |
| --- | --- | --- | --- |
| `history` | booleano | `true` | Con `false` se deja de registrar el historial (`.envs/history.ndjson`); `envs restore` se niega a ejecutarse mientras esté apagado. Se considera activo salvo que valga exactamente `false`. Ver [history.md](history.md). |
| `history.secrets` | booleano | `false` | Con `true` el historial guarda los secretos en claro, lo que permite restablecerlos exactamente. Por defecto solo guarda su huella (fingerprint). Ver [history.md](history.md). |
| `ui.autosave` | booleano | `false` | Con `true`, el editor web (`envs edit --ui`) guarda un momento después de cada cambio. También se cambia desde la página **Settings** del editor, que escribe esta misma clave. Ver [ui.md](ui.md). |

Cualquier otra clave se almacena sin error, pero `envs` no la usa.

## Variables de entorno

| Variable | Efecto |
| --- | --- |
| `NO_COLOR` | Si tiene cualquier valor no vacío, la salida de `envs` no usa colores. |
| `TERM_PROGRAM` | Con el valor `vscode` (terminal integrada de VS Code y editores basados en él), `envs edit --ui` abre la dirección `http://` directamente en lugar de usar la página temporal privada. Ver [ui.md](ui.md#iniciar). |
| `BROWSER` | Solo se lee cuando `TERM_PROGRAM=vscode`: es el comando que recibe la dirección del editor web. Si no está definido se usa `open` (macOS), `explorer` (Windows) o `xdg-open` (Linux). VS Code lo define en las ventanas remotas (SSH, contenedores, WSL). |

## Archivos de `.envs/`

| Archivo | Contenido |
| --- | --- |
| `values.yml` | Valores por perfil y worktree. |
| `history.ndjson`, `history.key` | Historial encadenado por hash y su clave. |
| `config.yml` | Los ajustes de esta página. |

Todos se escriben con permisos `600` dentro de un directorio `700`.
