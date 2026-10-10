import { join } from "node:path";
import { $ } from "bun";

const root = join(import.meta.dir, "..");

/** Compiles src/bin/envs.ts into `outdir` (bun target) and writes a package.json that points to it. */
export async function build(outdir = join(root, "dist")): Promise<void> {
  await $`rm -rf ${outdir}`;

  const result = await Bun.build({
    entrypoints: [join(root, "src/bin/envs.ts")],
    outdir,
    target: "bun",
  });
  if (!result.success) {
    throw new AggregateError(result.logs, "Build failed");
  }

  // The web editor (`envs edit --ui`) is served from dist/ui.
  const ui = await Bun.build({
    entrypoints: [join(root, "src/ui/index.html")],
    outdir: join(outdir, "ui"),
    target: "browser",
    minify: true,
    naming: "[name].[ext]",
  });
  if (!ui.success) {
    throw new AggregateError(ui.logs, "Web editor build failed");
  }

  for (const file of ["LICENSE", "README.md", "SECURITY.md"]) {
    await Bun.write(join(outdir, file), Bun.file(join(root, file)));
  }

  // Copy the original package.json, pointing to the built files in this folder.
  const {
    scripts: _scripts,
    devDependencies: _devDependencies,
    peerDependencies: _peerDependencies,
    files: _files,
    ...pkg
  } = await Bun.file(join(root, "package.json")).json();
  await Bun.write(
    join(outdir, "package.json"),
    JSON.stringify(
      { ...pkg, module: "envs.js", bin: { envs: "envs.js" } },
      null,
      2,
    ) + "\n",
  );
}

if (import.meta.main) {
  await build();
  console.log("Built dist/");
}
