import { describe, expect, test } from "bun:test";
import { STUN_SERVERS, peerServerOptions, toBytes, withTimeout } from "../src/share/peer";

describe("peerServerOptions", () => {
  test("uses PeerJS Cloud when no server is given", () => {
    expect(peerServerOptions()).toEqual({});
    expect(peerServerOptions("")).toEqual({});
  });

  test("parses a full URL", () => {
    expect(peerServerOptions("http://127.0.0.1:9000/")).toEqual({ host: "127.0.0.1", port: 9000, path: "/", secure: false });
    expect(peerServerOptions("https://broker.example:8443/peerjs")).toEqual({
      host: "broker.example",
      port: 8443,
      path: "/peerjs",
      secure: true,
    });
  });

  test("assumes https and the default port when the scheme is omitted", () => {
    expect(peerServerOptions("broker.example/p")).toEqual({ host: "broker.example", port: 443, path: "/p", secure: true });
    expect(peerServerOptions("http://broker.example")).toMatchObject({ port: 80, secure: false });
  });
});

describe("toBytes", () => {
  test("normalizes what PeerJS may deliver", () => {
    expect(toBytes(new Uint8Array([1, 2]).buffer)).toEqual(new Uint8Array([1, 2]));
    const backing = new Uint8Array([9, 1, 2, 3, 9]);
    expect(toBytes(backing.subarray(1, 4))).toEqual(new Uint8Array([1, 2, 3]));
    expect(toBytes(Buffer.from([7, 8]))).toEqual(new Uint8Array([7, 8]));
    expect(toBytes("hi")).toEqual(new TextEncoder().encode("hi"));
  });
});

describe("withTimeout", () => {
  test("passes the result through", async () => {
    expect(await withTimeout(Promise.resolve(5), "late", 50)).toBe(5);
  });

  test("rejects with the message when it takes too long", async () => {
    await expect(withTimeout(new Promise(() => {}), "too slow", 10)).rejects.toThrow("too slow");
  });
});

test("uses the five Google STUN servers", () => {
  expect(STUN_SERVERS).toEqual([
    "stun:stun.l.google.com:19302",
    "stun:stun1.l.google.com:19302",
    "stun:stun2.l.google.com:19302",
    "stun:stun3.l.google.com:19302",
    "stun:stun4.l.google.com:19302",
  ]);
});
