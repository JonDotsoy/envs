import { loadUiState, saveUiState, type Context, type NormalizedValues } from "../envs";
import { join } from "node:path";
import { readdir } from "node:fs/promises";

const ANSI = /\x1b\[[0-9;]*m/g;

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const isScalar = (v: unknown) => ["string", "number", "boolean"].includes(typeof v);

/** Validates the JSON body of a save request. */
function parseBody(body: unknown): NormalizedValues | undefined {
  if (!isRecord(body) || !isRecord(body.uses) || !isRecord(body.profiles)) return;
  if (!Object.values(body.uses).every((v) => typeof v === "string")) return;
  for (const profile of Object.values(body.profiles)) {
    if (!isRecord(profile) || !isRecord(profile.defaults) || !isRecord(profile.envs)) return;
    if (!Object.values(profile.defaults).every(isScalar)) return;
    for (const byWorktree of Object.values(profile.envs)) {
      if (!isRecord(byWorktree) || !Object.values(byWorktree).every(isScalar)) return;
    }
  }
  return body as unknown as NormalizedValues;
}

/**
 * The built front end by URL path. Running from source it is bundled in memory; the published
 * package ships it prebuilt in `ui/` next to the compiled script (see scripts/build.ts).
 */
async function loadAssets(): Promise<Map<string, Blob>> {
  const assets = new Map<string, Blob>();
  if (await Bun.file(join(import.meta.dir, "app.tsx")).exists()) {
    const result = await Bun.build({ entrypoints: [join(import.meta.dir, "index.html")], target: "browser" });
    if (!result.success) throw new AggregateError(result.logs, "Web editor build failed");
    for (const out of result.outputs) assets.set(out.path.replace(/^\.\//, ""), out);
  } else {
    const dir = join(import.meta.dir, "ui");
    for (const name of await readdir(dir)) assets.set(name, Bun.file(join(dir, name)));
  }
  return assets;
}

/** Serves the web editor on localhost until `ctx.waitForExit` resolves. */
export async function serveUi(ctx: Context): Promise<number> {
  const assets = await loadAssets();
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    routes: {
      "/api/values": {
        GET: async () => Response.json(await loadUiState(ctx)),
        PUT: async (req) => {
          const values = parseBody(await req.json().catch(() => undefined));
          if (!values) return Response.json({ error: "Invalid values" }, { status: 400 });
          const logs: string[] = [];
          const errors: string[] = [];
          const capture: Context = {
            ...ctx,
            log: (m) => logs.push(m.replace(ANSI, "")),
            error: (m) => errors.push(m.replace(ANSI, "")),
          };
          const { created, code } = await saveUiState(capture, values);
          return Response.json({ ok: code === 0, created, logs, errors }, { status: code === 0 ? 200 : 500 });
        },
      },
    },
    fetch: (req) => {
      const path = new URL(req.url).pathname.slice(1) || "index.html";
      const asset = assets.get(path);
      return asset ? new Response(asset) : new Response("Not found", { status: 404 });
    },
  });
  const url = `http://127.0.0.1:${server.port}`;
  ctx.log(`Web editor running at ${url} (Ctrl+C to stop)`);
  await ctx.openUrl?.(url);
  await (ctx.waitForExit ?? (() => new Promise<void>(() => {})))();
  await server.stop(true);
  return 0;
}
