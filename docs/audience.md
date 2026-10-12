# Audiencia

Define para quién existe `@jondotsoy/envs`, qué hace cada rol con la herramienta, qué features necesita y en qué punto del flujo de trabajo las usa. Sirve para decidir qué construir y qué rechazar. Para el detalle de las funcionalidades, consulta [features.md](features.md); para el uso, el [README](../README.md).

## Resumen

**`envs` es para desarrolladores que trabajan solos en su máquina con varios `git worktree` del mismo repo y necesitan que los `.env` de todos ellos se mantengan coherentes.**

Rasgos comunes de toda la audiencia:

- Ya usan `git worktree` (tres o más ramas activas a la vez: feature, hotfix, review).
- Usan Bun y VS Code, o aceptan un editor web local.
- Sus `.env` no se versionan y contienen valores de desarrollo local.
- Una persona por máquina: cada quien mantiene su propio `.envs/values.yml`.

## Audiencia primaria

### 1. Desarrollador/a con varios worktrees por repo

| | |
| --- | --- |
| **Perfil** | Domina `git worktree`, `bunx`, VS Code y archivos `.env`. |
| **Contexto** | App web, backend o monorepo. Cada worktree es una carpeta con su propio `.env` no versionado. |
| **Dolores** | `.env` copiados a mano y desincronizados. Conflictos de puerto entre ramas (`PORT` distinto por rama). Un worktree nuevo nace sin `.env`. |
| **Actividades** | Recoger los `.env` existentes, editar todos los valores en un solo lugar, distribuirlos a cada worktree. |

**Features que necesita**

- `envs edit`: `init` + `pull` + editor + `push` en un solo paso, sin instalación (`bunx @jondotsoy/envs edit`).
- `envs pull` / `envs push`: sincronización explícita en cada dirección.
- Valores por worktree (`profiles.<perfil>.envs.<VARIABLE>.<worktree>`) para variables como `PORT`.
- Push que conserva comentarios y variables ajenas a `values.yml`.
- Salida que muestra solo lo que cambia.

**Dónde entra en el flujo**

| Momento | Acción |
| --- | --- |
| Primer uso en un repo con `.env` sueltos | `bunx @jondotsoy/envs edit` |
| Tras `git worktree add` | `envs push` para generar el `.env` del worktree nuevo |
| Cambiar un puerto, URL o clave | `envs edit` |
| Se editó un `.env` a mano | `envs pull` para traerlo a `values.yml` |

### 2. Desarrollador/a que alterna entornos por rama

| | |
| --- | --- |
| **Perfil** | Igual que el rol 1; además maneja `DATABASE_URL`, URLs de servicios y feature flags. |
| **Contexto** | Una rama apunta a la base de datos local y otra al entorno `dev` compartido. |
| **Dolores** | Editar a mano `DATABASE_URL` al cambiar de contexto, con riesgo de apuntar a la base equivocada. |
| **Actividades** | Definir perfiles (`local`, `dev`), asignarlos a worktrees, sobreescribir valores puntuales. |

**Features que necesita**

- Perfiles con `defaults` y `envs`, y su precedencia (`defaults` de `default` < `envs` de `default` < `defaults` del perfil < `envs` del perfil).
- `envs use [perfil]`: cambia el perfil del worktree actual y lo sincroniza; sin argumentos lista el perfil de cada worktree.
- Creación de perfiles escribiéndolos en `uses` durante `envs edit` (copia de `default`).
- Error explícito ante un perfil desconocido.

**Dónde entra en el flujo**

| Momento | Acción |
| --- | --- |
| Pasar un worktree de `local` a `dev` | `envs use dev` |
| Necesitar un perfil nuevo | `envs edit` (o `--ui`) |
| Ver qué perfil tiene cada worktree | `envs use` |

## Audiencia secundaria

### 3. Desarrollador/a que prefiere una interfaz visual

| | |
| --- | --- |
| **Perfil** | Cómodo en CLI y navegador; no quiere editar YAML largo a mano. |
| **Contexto** | Seis o más worktrees, o quien debe comparar valores entre ramas de un vistazo. |
| **Dolores** | YAML extenso y propenso a errores; difícil comparar un valor entre worktrees. |
| **Actividades** | Editar una tabla variable × worktree y aplicar un valor a todos. |

**Features que necesita**

- `envs edit --ui`: servidor local en `127.0.0.1` con puerto aleatorio.
- Columna `default` más una por worktree, modo compacto con muchas columnas, filtro por worktree y acción de aplicar a todos.
- Guardado con **Save** (o Ctrl/Cmd+S) que escribe `values.yml` y hace `push`.

**Dónde entra en el flujo:** en el desarrollo diario, como alternativa a VS Code cuando `code` no está disponible o hay muchos worktrees.

### 4. Responsable de seguridad o tech lead consciente de secretos

| | |
| --- | --- |
| **Perfil** | Conoce CI (GitHub Actions), permisos Unix, políticas de `.gitignore` y secret scanning. |
| **Contexto** | `values.yml` concentra credenciales de desarrollo en texto plano; quiere vigilar que no se filtren. |
| **Dolores** | `.env` o `values.yml` versionados, permisos abiertos, secretos débiles o con formato conocido, URLs con contraseña o sin TLS, secretos compartidos en `defaults`. |
| **Actividades** | Ejecutar `envs lint` en su máquina, corregir permisos, leer [SECURITY.md](../SECURITY.md). |

**Features que necesita**

- `envs lint` con sus reglas de git, permisos, secretos y URLs; termina con código 1 si hay avisos y nunca imprime valores.
- Enmascarado de variables sensibles como `********` en la consola.
- Colores desactivables con `NO_COLOR` para logs.
- `.envs/.gitignore` con `*` creado por `init`.

**Dónde entra en el flujo:** antes de abrir un PR y tras crear o editar `values.yml`. Hoy ningún workflow del repo ejecuta `envs lint` y `values.yml` está ignorado por git, por lo que en CI no existe; ver [Brechas](#brechas-conocidas).

## Audiencia terciaria

### 5. Mantenedor/a y contribuidor/a

| | |
| --- | --- |
| **Perfil** | Bun, TypeScript, tests con fixtures de git, publicación en npm. |
| **Actividades** | `bun test`, `bun run build`, workflow **Publish** (bump, dist-tag, OIDC) y publicación del schema en GitHub Pages. |
| **Features que necesita** | Fixture `createWorkspace` para repos temporales con worktrees, workflows `test`, `publish` y `pages`. |

**Dónde entra en el flujo:** al desarrollar el CLI, liberar una versión o cambiar el schema (`schema/values.schema.json`).

## Quién no es la audiencia

| No es para… | Por qué |
| --- | --- |
| Equipos que necesitan compartir secretos | `values.yml` es un archivo local en texto plano, sin cifrado, sincronización ni control de acceso. `envs` no hace conexiones de red y SECURITY.md indica no compartirlo. |
| Producción, deploy o CI como destino | Solo escribe `.env` en disco para desarrollo local. No inyecta secretos. |
| Quien no usa git o no usa worktrees | Todo se basa en `git worktree list`. Con un único árbol funciona, pero aporta poco. |
| Ecosistemas sin Bun | Requiere Bun y git; el binario es TypeScript que se ejecuta con Bun. |
| Quien necesita fidelidad total del `.env` | El parser es mínimo y `pull` reserializa `values.yml`, perdiendo los comentarios YAML. |

## Prerrequisitos

- **Herramientas:** Bun, git y un repo con varios worktrees. `code` en el `PATH` para `edit`; un navegador para `edit --ui`.
- **Conocimientos:** `git worktree`, YAML (`uses`, `profiles`, `defaults`, `envs`) y `chmod` (el lint recomienda `chmod 600`, `chmod -x`, `chmod go-w`).
- **Equipo:** una persona por máquina, cada una con su propio `values.yml`. Esto se deduce del diseño; el README no lo declara.
- **Convención previa:** `.env` debe estar ya en el `.gitignore` del proyecto; `envs` no lo modifica.

## Límites de seguridad que la audiencia debe conocer

**Lo que hace:** crea `.envs/.gitignore` con `*`; `envs lint` detecta archivos versionados o sin ignorar, permisos abiertos y secretos débiles o con formato conocido; enmascara variables sensibles al imprimir en `push`; escribe `.envs/config.yml` con modo 600.

**Lo que no hace:**

- No cifra los valores.
- No aplica permisos a `values.yml` ni a los `.env` al escribirlos; `lint` avisa pero no corrige.
- Enmascara por nombre de variable: una `DATABASE_URL` con contraseña se imprime tal cual.
- `lint` no se ejecuta automáticamente antes de `push` y no bloquea.
- En Windows las reglas de permisos no se aplican.
- `secret-pattern` cubre cinco formatos (AWS, GitHub, Slack, `sk-…`, clave privada).

## Brechas conocidas

Features que la audiencia necesita en su flujo y que hoy faltan o son débiles, verificadas en el código:

| # | Brecha | Rol afectado | Etapa |
| --- | --- | --- | --- |
| 1 | `envs lint` no corre en CI de este repo, y depende de un `values.yml` local ignorado por git. | 4 | Revisión antes de PR / CI |
| 2 | `push` nunca borra claves: al cambiar de perfil quedan en el `.env` variables del perfil anterior. | 2 | Cambio de entorno |
| 3 | `edit` fija `code -w`; sin VS Code, la única alternativa es `--ui`. | 1, 3 | Primer uso, desarrollo diario |
| 4 | No existe `get`/`set` de una variable ni `status`/`diff`. | 1, 2 | Desarrollo diario |
| 5 | No hay `profile list/rename/delete`; `use` no crea perfiles. | 2 | Cambio de entorno |
| 6 | `.envs/config.yml` solo lo lee y escribe `envs config`; ningún otro comando lo consume. | todos | — |
| 7 | Un worktree nuevo no se sincroniza solo: falta un hook post-checkout y `push` reescribe todos los worktrees. | 1 | Crear worktree |
| 8 | `lint` no se puede configurar ni silenciar, ni tiene salida JSON o `--fix`. | 4 | Revisión de seguridad |

## Cómo usar este documento

- Una propuesta de feature debe nombrar el rol al que sirve y la etapa del flujo donde se usa. Si no encaja en ningún rol de la audiencia primaria o secundaria, es candidata a rechazo.
- Las funciones que empujan hacia equipos grandes o secretos de producción (sincronización remota, cifrado compartido, inyección en CI) quedan fuera del alcance mientras no cambie esta definición.
