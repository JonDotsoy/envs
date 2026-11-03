# envs for VS Code

Base scaffold for the VS Code extension of [`@jondotsoy/envs`](../../README.md).

## Development

From the repository root:

```sh
bun install
bun install --cwd extensions/vscode
npm run ext:dev
```

This builds the extension and opens a VS Code window (Extension Development Host) with it loaded. Run **envs: Hello World** from the Command Palette to try it.

Inside VS Code you can also press `F5` with `extensions/vscode` as the workspace folder.

Other scripts (run in `extensions/vscode`): `bun run build`, `bun run watch`, `bun run typecheck`.
