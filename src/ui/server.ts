import {
  findRoot,
  historyEnabled,
  loadUiHistory,
  loadUiState,
  readHistoryPoints,
  restore,
  saveUiState,
  type Context,
  type NormalizedValues,
} from "../envs";
import { join } from "node:path";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { readdir } from "node:fs/promises";

const ANSI = /\x1b\[[0-9;]*m/g;

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const isScalar = (v: unknown) => ["string", "number", "boolean"].includes(typeof v);

/** Validates the JSON body of a save request. */
function parseBody(body: unknown): { values: NormalizedValues; base?: string } | undefined {
  if (!isRecord(body) || !isRecord(body.uses) || !isRecord(body.profiles)) return;
  if (!Object.values(body.uses).every((v) => typeof v === "string")) return;
  for (const profile of Object.values(body.profiles)) {
    if (!isRecord(profile) || !isRecord(profile.defaults) || !isRecord(profile.envs)) return;
    if (!Object.values(profile.defaults).every(isScalar)) return;
    for (const byWorktree of Object.values(profile.envs)) {
      if (!isRecord(byWorktree) || !Object.values(byWorktree).every(isScalar)) return;
    }
  }
  if (body.version !== undefined && typeof body.version !== "string") return;
  return { values: body as unknown as NormalizedValues, ...(body.version !== undefined && { base: body.version }) };
}

/** Validates the JSON body of a restore request: `{hash}` with a whole point hash (12 hex characters). */
function parseRestoreBody(body: unknown): string | undefined {
  if (!isRecord(body) || typeof body.hash !== "string" || !/^[0-9a-f]{12}$/.test(body.hash)) return;
  return body.hash;
}

/** A copy of `ctx` whose log and error lines are collected (without colors) for the response. */
function capture(ctx: Context) {
  const logs: string[] = [];
  const errors: string[] = [];
  const captured: Context = {
    ...ctx,
    log: (m) => logs.push(m.replace(ANSI, "")),
    error: (m) => errors.push(m.replace(ANSI, "")),
  };
  return { ctx: captured, logs, errors };
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

const TOKEN_COOKIE = "envs_token";

/**
 * Largest request body the server reads (Bun answers 413 beyond it). A values.yml with hundreds of
 * variables for dozens of worktrees is a few hundred KB; the default limit of 128 MB would let one
 * request dump that much into values.yml, the history and the .env files.
 */
export const MAX_BODY_BYTES = 5 * 1024 * 1024;

/** Constant-time comparison of a presented token with the real one. */
function sameToken(presented: string | null | undefined, token: string): boolean {
  if (!presented) return false;
  const a = Buffer.from(presented);
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** The token a request carries: the `x-envs-token` header, or the cookie the browser got from the URL. */
function presentedToken(req: Request): string | undefined {
  const header = req.headers.get("x-envs-token");
  if (header) return header;
  return req.headers.get("cookie")?.split(";").map((c) => c.trim().split("=")).find(([name]) => name === TOKEN_COOKIE)?.[1];
}

/**
 * Serves the web editor on localhost until `ctx.waitForExit` resolves.
 *
 * It is the only thing between the values (secrets included) and any other program, so every
 * request is checked:
 * - `Host` must be this server (127.0.0.1 or localhost on its port): a page reaching it through DNS
 *   rebinding sends its own host name and is refused (421).
 * - `Origin`, when present, must be this server too (403): another site cannot write to it.
 * - A random token, unique to each run and printed only in the URL that is opened, is required
 *   (401). It is single-use: the first visit trades it for a session secret, set as an HttpOnly,
 *   SameSite=Strict cookie, and the token in the URL stops working. So a program that merely finds
 *   the port, or reads the URL later from the browser history or the terminal, gets nothing.
 * - Requests with a body must be `application/json` (415), which a cross-site form or a
 *   "simple" fetch cannot send without a preflight this server never allows.
 */
export async function serveUi(ctx: Context): Promise<number> {
  const assets = await loadAssets();
  // The token in the URL, valid for one visit and then replaced by a new one; `session` is what that visit trades it for.
  let opened: Promise<void | (() => void)> | undefined;
  let token = randomBytes(24).toString("base64url");
  const session = randomBytes(24).toString("base64url");
  const guard = (handler: (req: Request) => Response | Promise<Response>) => async (req: Request) => {
    const port = server.port;
    const hosts = [`127.0.0.1:${port}`, `localhost:${port}`];
    if (!hosts.includes(req.headers.get("host") ?? "")) {
      return new Response("Misdirected request", { status: 421 });
    }
    const origin = req.headers.get("origin");
    if (origin !== null && !hosts.some((host) => origin === `http://${host}`)) {
      return new Response("Forbidden origin", { status: 403 });
    }
    const url = new URL(req.url);
    // First visit: trade the token in the URL (once) for the cookie and drop it from the address bar.
    if (url.pathname === "/" && sameToken(url.searchParams.get("token"), token)) {
      // The token is spent: print a fresh single-use URL right away (for another browser or after closing this one).
      token = randomBytes(24).toString("base64url");
      ctx.log(`New single-use URL: ${urlWith(token)}`);
      // The page that redirected to the spent token is no longer needed.
      void opened?.then((cleanup) => cleanup?.(), () => {});
      return new Response(null, {
        status: 302,
        headers: {
          location: "/",
          "set-cookie": `${TOKEN_COOKIE}=${session}; HttpOnly; SameSite=Strict; Path=/`,
        },
      });
    }
    if (!sameToken(presentedToken(req), session)) {
      return new Response("Unauthorized: open the address printed by `envs edit --ui`.", { status: 401 });
    }
    if (req.method !== "GET" && req.method !== "HEAD" && !req.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
      return new Response("Unsupported media type", { status: 415 });
    }
    return handler(req);
  };
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    maxRequestBodySize: MAX_BODY_BYTES,
    routes: {
      "/api/values": {
        GET: guard(async () => Response.json(await loadUiState(ctx))),
        PUT: guard(async (req) => {
          const parsed = parseBody(await req.json().catch(() => undefined));
          if (!parsed) return Response.json({ error: "Invalid values" }, { status: 400 });
          const { ctx: captured, logs, errors } = capture(ctx);
          const { created, code, conflict } = await saveUiState(captured, parsed.values, { base: parsed.base });
          // 409: values.yml changed after this editor loaded it; nothing was saved.
          return Response.json({ ok: code === 0, created, logs, errors }, { status: code === 0 ? 200 : conflict ? 409 : 500 });
        }),
      },
      "/api/history": {
        GET: guard(async () => Response.json(await loadUiHistory(ctx))),
      },
      // Restores values.yml to the state after a point: a new point is appended, none is removed.
      "/api/restore": {
        POST: guard(async (req) => {
          const hash = parseRestoreBody(await req.json().catch(() => undefined));
          if (!hash) return Response.json({ error: "Invalid hash" }, { status: 400 });
          const root = await findRoot(ctx.cwd);
          // With the history off a restore would not be recorded, so the editor does not offer it.
          if (!(await historyEnabled(root))) return Response.json({ error: "The history is off" }, { status: 409 });
          if (!(await readHistoryPoints(root)).some((point) => point.hash === hash)) {
            return Response.json({ error: "Unknown history point" }, { status: 404 });
          }
          const { ctx: captured, logs, errors } = capture(ctx);
          const code = await restore(captured, hash);
          return Response.json({ ok: code === 0, created: [], logs, errors }, { status: code === 0 ? 200 : 500 });
        }),
      },
    },
    fetch: guard((req) => {
      const path = new URL(req.url).pathname.slice(1) || "index.html";
      const asset = assets.get(path);
      return asset ? new Response(asset) : new Response("Not found", { status: 404 });
    }),
  });
  // The token travels only in this URL (printed and opened), never stored or logged elsewhere.
  const urlWith = (t: string) => `http://127.0.0.1:${server.port}/?token=${t}`;
  const url = urlWith(token);
  ctx.log(`Web editor running at ${url} (Ctrl+C to stop)`);
  try {
    opened = ctx.openUrl?.(url);
    await opened;
  } catch {
    // The opener is missing or failed: the user opens the address by hand.
    ctx.log(`Could not open the browser. Open this address manually: ${url}`);
  }
  await (ctx.waitForExit ?? (() => new Promise<void>(() => {})))();
  await server.stop(true);
  return 0;
}
