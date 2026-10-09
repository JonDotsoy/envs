import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { parseReceiveArgs, parseShareArgs } from "../src/share/args";
import { appendAudit, auditPath } from "../src/share/audit";
import {
  DIRECTION,
  SessionCipher,
  decodeSecret,
  deriveAuthKey,
  deriveFileKey,
  deriveSessionKeys,
  generateEphemeralKey,
  generateSecret,
  mac,
  macEquals,
  openFile,
  sealFile,
  sharedSecret,
} from "../src/share/crypto";
import { buildPayload, mergePayload, parsePayload } from "../src/share/payload";
import { buildShareUrl, generatePeerId, parseShareUrl } from "../src/share/url";

describe("share url", () => {
  test("round-trips peer id, secret and broker", () => {
    const link = { peerId: generatePeerId(), secret: generateSecret(), peerServer: "https://broker.example:9000/p" };
    const url = buildShareUrl(link);
    expect(url.startsWith(`envs://${link.peerId}/sharing-envs?key=`)).toBe(true);
    expect(parseShareUrl(url)).toEqual(link);
  });

  test("omits the broker when it is the default", () => {
    const link = { peerId: generatePeerId(), secret: generateSecret() };
    expect(parseShareUrl(buildShareUrl(link))).toEqual(link);
  });

  test("peer ids are 26 chars of lowercase base32", () => {
    expect(generatePeerId()).toMatch(/^[a-z2-7]{26}$/);
    expect(generatePeerId()).not.toBe(generatePeerId());
  });

  test.each([
    ["not a url"],
    ["https://abc/sharing-envs?key=x"],
    [`envs://${generatePeerId()}/other?key=${generateSecret()}`],
    [`envs://short/sharing-envs?key=${generateSecret()}`],
    [`envs://${generatePeerId()}/sharing-envs`],
    [`envs://${generatePeerId()}/sharing-envs?key=tooshort`],
  ])("rejects %s", (text) => {
    expect(() => parseShareUrl(text)).toThrow(/Invalid link/);
  });
});

describe("share crypto", () => {
  const secret = decodeSecret(generateSecret());
  const sessionId = randomBytes(16);

  test("secrets are 32 random bytes in base64url", () => {
    expect(generateSecret()).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(() => decodeSecret("short")).toThrow();
  });

  test("keys for different purposes differ", () => {
    expect(deriveFileKey(secret).equals(deriveAuthKey(secret).subarray(0, 32))).toBe(false);
    expect(deriveAuthKey(secret)).toHaveLength(64);
  });

  test("sharing file round-trips and carries the session id", () => {
    const sealed = sealFile(Buffer.from("A=1"), deriveFileKey(secret), sessionId);
    expect(sealed.includes(Buffer.from("A=1"))).toBe(false);
    const opened = openFile(sealed, deriveFileKey(secret));
    expect(opened.plain.toString()).toBe("A=1");
    expect(opened.sessionId.equals(sessionId)).toBe(true);
  });

  test("sharing file rejects a wrong key and any tampering", () => {
    const sealed = sealFile(Buffer.from("A=1"), deriveFileKey(secret), sessionId);
    expect(() => openFile(sealed, deriveFileKey(decodeSecret(generateSecret())))).toThrow(/decrypt/);
    for (const index of [0, 10, 30, sealed.length - 1]) {
      const copy = Buffer.from(sealed);
      copy[index]! ^= 1;
      expect(() => openFile(copy, deriveFileKey(secret))).toThrow();
    }
    expect(() => openFile(Buffer.from("junk"), deriveFileKey(secret))).toThrow();
  });

  test("sealing twice never repeats the nonce", () => {
    const key = deriveFileKey(secret);
    const a = sealFile(Buffer.from("x"), key, sessionId);
    const b = sealFile(Buffer.from("x"), key, sessionId);
    expect(a.equals(b)).toBe(false);
  });

  test("mac depends on every part and on the key", () => {
    const key = deriveAuthKey(secret);
    const base = mac(key, "l", Buffer.from("ab"), Buffer.from("c"));
    expect(macEquals(base, mac(key, "l", Buffer.from("ab"), Buffer.from("c")))).toBe(true);
    expect(macEquals(base, mac(key, "l", Buffer.from("a"), Buffer.from("bc")))).toBe(false);
    expect(macEquals(base, mac(key, "x", Buffer.from("ab"), Buffer.from("c")))).toBe(false);
    expect(macEquals(base, mac(deriveAuthKey(decodeSecret(generateSecret())), "l", Buffer.from("ab"), Buffer.from("c")))).toBe(false);
  });

  function pair() {
    const client = generateEphemeralKey();
    const server = generateEphemeralKey();
    const nonceC = randomBytes(16);
    const nonceS = randomBytes(16);
    const sharedC = sharedSecret(client, server.publicKey);
    const sharedS = sharedSecret(server, client.publicKey);
    expect(sharedC.equals(sharedS)).toBe(true);
    const keys = deriveSessionKeys(sharedC, secret, nonceC, nonceS, sessionId);
    return {
      host: new SessionCipher(keys.serverToClient, keys.clientToServer, sessionId, DIRECTION.serverToClient),
      guest: new SessionCipher(keys.clientToServer, keys.serverToClient, sessionId, DIRECTION.clientToServer),
    };
  }

  test("session cipher carries frames both ways, in order", () => {
    const { host, guest } = pair();
    expect(guest.open(host.seal(Buffer.from("one"))).toString()).toBe("one");
    expect(guest.open(host.seal(Buffer.from("two"))).toString()).toBe("two");
    expect(host.open(guest.seal(Buffer.from("back"))).toString()).toBe("back");
  });

  test("session cipher rejects replays, reordering, tampering and reflection", () => {
    const { host, guest } = pair();
    const first = host.seal(Buffer.from("one"));
    const second = host.seal(Buffer.from("two"));
    expect(() => guest.open(second)).toThrow(/sequence/);
    expect(guest.open(first).toString()).toBe("one");
    expect(() => guest.open(first)).toThrow(/sequence/);
    const tampered = Buffer.from(second);
    tampered[5]! ^= 1;
    expect(() => guest.open(tampered)).toThrow(/authentication/);
    expect(guest.open(second).toString()).toBe("two");
    // A frame the host sent cannot be fed back to the host.
    expect(() => host.open(host.seal(Buffer.from("x")))).toThrow();
  });

  test("a different secret yields different transport keys", () => {
    const a = generateEphemeralKey();
    const b = generateEphemeralKey();
    const shared = sharedSecret(a, b.publicKey);
    const n = randomBytes(16);
    const one = deriveSessionKeys(shared, secret, n, n, sessionId);
    const two = deriveSessionKeys(shared, decodeSecret(generateSecret()), n, n, sessionId);
    expect(one.clientToServer.equals(two.clientToServer)).toBe(false);
    expect(one.clientToServer.equals(one.serverToClient)).toBe(false);
  });
});

describe("share payload", () => {
  const values = {
    defaults: { A: "1", B: 2 },
    envs: { A: { main: "override", other: "x" }, SECRET_TOKEN: { main: "s3cr3t" }, ONLY_OTHER: { other: "y" } },
  };

  test("resolves the profile like push does", () => {
    const payload = buildPayload(values, "main", new Date("2026-01-01T00:00:00Z"));
    expect(payload).toEqual({
      version: 1,
      profile: "main",
      generatedAt: "2026-01-01T00:00:00.000Z",
      values: { A: "override", B: 2, SECRET_TOKEN: "s3cr3t" },
    });
  });

  test("parsePayload validates names and value types", () => {
    const good = JSON.stringify({ version: 1, profile: "main", generatedAt: "", values: { A: "1", B: true } });
    expect(parsePayload(good).values).toEqual({ A: "1", B: true });
    const bad = (values: unknown) => JSON.stringify({ version: 1, profile: "main", values });
    expect(() => parsePayload(bad({ "A B": "1" }))).toThrow(/Invalid variable name/);
    expect(() => parsePayload(bad({ A: { nested: 1 } }))).toThrow(/Invalid value/);
    expect(() => parsePayload(JSON.stringify({ version: 2 }))).toThrow(/Unsupported/);
  });

  test("merge adds new keys and keeps existing ones unless forced", () => {
    const payload = { version: 1 as const, profile: "main", generatedAt: "", values: { A: "new", B: "2", C: "3" } };
    const target: { defaults: Record<string, string | number> } = { defaults: { A: "old", B: 2 } };
    const result = mergePayload(structuredClone(target), payload, false);
    expect(result).toEqual({ added: ["C"], overwritten: [], unchanged: ["B"], conflicts: ["A"] });
    const forced = structuredClone(target);
    expect(mergePayload(forced, payload, true).overwritten).toEqual(["A"]);
    expect(forced.defaults).toEqual({ A: "new", B: 2, C: "3" });
  });
});

describe("share args", () => {
  test("share defaults and flags", () => {
    expect(parseShareArgs([])).toEqual({ maxPeers: 1, ttlMs: 600_000 });
    expect(parseShareArgs(["--max-peers", "3", "--ttl", "2", "--peer-server", "http://localhost:9000"])).toEqual({
      maxPeers: 3,
      ttlMs: 120_000,
      peerServer: "http://localhost:9000",
    });
  });

  test("share rejects unknown or invalid options", () => {
    expect(() => parseShareArgs(["--nope"])).toThrow(/Unknown option/);
    expect(() => parseShareArgs(["--ttl", "0"])).toThrow(/positive/);
    expect(() => parseShareArgs(["--max-peers"])).toThrow(/positive/);
    expect(() => parseShareArgs(["--peer-server"])).toThrow(/needs a URL/);
  });

  test("receive takes one link and --force", () => {
    expect(parseReceiveArgs(["envs://x", "--force"])).toEqual({ url: "envs://x", force: true });
    expect(() => parseReceiveArgs([])).toThrow(/Usage/);
    expect(() => parseReceiveArgs(["a", "b"])).toThrow(/single link/);
    expect(() => parseReceiveArgs(["a", "--nope"])).toThrow(/Unknown option/);
  });
});

describe("share audit log", () => {
  test("appends one JSON object per line, owner-only", async () => {
    const root = await mkdtemp(join(tmpdir(), "envs-audit-"));
    try {
      await Bun.write(join(root, ".envs/.keep"), "");
      await appendAudit(root, "abcd1234", "auth_ok", { peer: "p_1", remote: "203.0.113.7" }, new Date("2026-01-01T00:00:00Z"));
      await appendAudit(root, "abcd1234", "closed", { peer: "p_1", reason: "completed", durationMs: 5 });
      const lines = (await Bun.file(auditPath(root)).text()).trim().split("\n").map((line) => JSON.parse(line));
      expect(lines).toHaveLength(2);
      expect(lines[0]).toEqual({
        v: 1,
        ts: "2026-01-01T00:00:00.000Z",
        session: "abcd1234",
        event: "auth_ok",
        peer: "p_1",
        remote: "203.0.113.7",
        reason: null,
        keys: null,
        bytes: null,
        durationMs: null,
      });
      expect(lines[1].reason).toBe("completed");
      if (process.platform !== "win32") {
        expect((await stat(auditPath(root))).mode & 0o777).toBe(0o600);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
