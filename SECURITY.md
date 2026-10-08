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

## Manejo de secretos

`envs` trabaja con valores que suelen ser secretos:

- `.envs/values.yml` guarda los valores de todos los worktrees en texto plano.
- `envs init` crea `.envs/.gitignore` con `*`, para que la carpeta `.envs/` no se suba a git. No quites ese archivo.
- `envs push` escribe los valores en los archivos `.env` de cada worktree. Asegúrate de que `.env` esté en el `.gitignore` de tu proyecto.
- No compartas `values.yml` ni lo pegues en issues o logs.
