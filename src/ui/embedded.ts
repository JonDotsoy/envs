import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Bundles the web editor and returns its files by URL path, as text. It runs as a Bun macro (see
 * server.ts), so the result is inlined into whatever bundles or runs the server: the compiled
 * `envs.js` carries the editor and needs no `ui/` folder next to it.
 *
 * `Bun.build` cannot be called from inside a macro while bundling (it deadlocks), so this shells
 * out to the CLI.
 */
export function buildEmbeddedUi(): Record<string, string> {
  const outdir = mkdtempSync(join(tmpdir(), "envs-ui-"));
  try {
    const entry = new URL("./index.html", import.meta.url).pathname;
    const result = Bun.spawnSync([process.execPath, "build", entry, "--outdir", outdir, "--minify", "--entry-naming", "[name].[ext]", "--asset-naming", "[name].[ext]"], { stderr: "pipe" });
    if (!result.success) throw new Error(`Web editor build failed: ${result.stderr.toString()}`);
    const files: Record<string, string> = {};
    for (const name of readdirSync(outdir)) files[name] = readFileSync(join(outdir, name), "utf8");
    return files;
  } finally {
    rmSync(outdir, { recursive: true, force: true });
  }
}
