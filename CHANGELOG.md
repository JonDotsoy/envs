# Changelog

Todos los cambios notables de este proyecto se documentan en este archivo.

El formato sigue [Keep a Changelog](https://keepachangelog.com/es-ES/1.1.0/) y el proyecto usa [Versionado Semántico](https://semver.org/lang/es/).

## [Sin publicar]

### Añadido

- Comando `envs lint`: advierte sobre valores inseguros y archivos sin proteger (#4).
- `values.yml` acepta números y booleanos de YAML como valores.

### Cambiado

- `envs pull` interpreta los valores booleanos y numéricos al leer los `.env`.

### Pruebas

- Se verifica que `envs push` conserve comentarios, espaciado y orden del `.env`.

## [0.0.4] - 2026-10-08

### Cambiado

- El build incluye `README.md` y `SECURITY.md` en `dist` (#3).

## [0.0.3] - 2026-10-08

### Añadido

- Documentación y metadatos: README, licencia MIT, `SECURITY.md` y `package.json` (#2).

## [0.0.2] - 2026-10-08

### Añadido

- CLI `envs` con los comandos `init`, `pull`, `push` y `edit`, además de build, tests y workflows (#1).

[Sin publicar]: https://github.com/JonDotsoy/envs/compare/v0.0.4...HEAD
[0.0.4]: https://github.com/JonDotsoy/envs/compare/v0.0.3...v0.0.4
[0.0.3]: https://github.com/JonDotsoy/envs/compare/v0.0.2...v0.0.3
[0.0.2]: https://github.com/JonDotsoy/envs/releases/tag/v0.0.2
