import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import {
  clearCursorModelCache,
  parseCursorUsableModels,
  resolveCursorModels,
} from "../../open-sse/services/cursorModels.js";

// ponytail: upstream cursorModels.js never used global.fetch —
// agent.api5.cursor.sh is HTTP/2-only, so it speaks raw http2 via
// http2PostProto (see cursorModels.js). Mock the http2 session instead.
const { mockHttp2Connect } = vi.hoisted(() => ({ mockHttp2Connect: vi.fn() }));
vi.mock("http2", () => ({ default: { connect: mockHttp2Connect } }));

// Program the fake h2 session: client.request() returns a req stream that
// replays one response (status + body) when end() is called.
function mockHttp2Response({ status, body }) {
  mockHttp2Connect.mockImplementation(() => {
    const client = new EventEmitter();
    client.close = vi.fn();
    client.request = vi.fn(() => {
      const req = new EventEmitter();
      req.end = vi.fn(() => {
        queueMicrotask(() => {
          req.emit("response", { ":status": status });
          if (body?.length) req.emit("data", Buffer.from(body));
          req.emit("end");
        });
      });
      return req;
    });
    return client;
  });
}

function varint(value) {
  const bytes = [];
  while (value >= 0x80) {
    bytes.push((value & 0x7f) | 0x80);
    value >>>= 7;
  }
  bytes.push(value);
  return Uint8Array.from(bytes);
}

function field(fieldNumber, value) {
  return Uint8Array.from([(fieldNumber << 3) | 2, ...varint(value.length), ...value]);
}

function text(value) {
  return new TextEncoder().encode(value);
}

function concat(...parts) {
  const size = parts.reduce((sum, part) => sum + part.length, 0);
  const result = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}

function model(id, name) {
  return field(1, concat(field(1, text(id)), field(4, text(name))));
}

describe("Cursor live model catalog", () => {
  beforeEach(() => {
    clearCursorModelCache();
    mockHttp2Connect.mockReset();
  });

  afterEach(() => {
    clearCursorModelCache();
    mockHttp2Connect.mockReset();
  });

  it("decodes the GetUsableModels protobuf response", () => {
    const payload = concat(
      model("default", "Auto"),
      model("gpt-5.3-codex", "GPT 5.3 Codex"),
      model("gpt-5.3-codex", "Duplicate"),
    );

    expect(parseCursorUsableModels(payload)).toEqual([
      { id: "default", name: "Auto" },
      { id: "gpt-5.3-codex", name: "GPT 5.3 Codex" },
    ]);
  });

  it("fetches the account-specific catalog and caches it", async () => {
    const payload = concat(model("claude-4.6-opus", "Claude 4.6 Opus"));
    mockHttp2Response({ status: 200, body: payload });
    const credentials = {
      accessToken: "cursor-token",
      providerSpecificData: { machineId: "machine-id" },
    };

    await expect(resolveCursorModels(credentials)).resolves.toEqual({
      models: [{ id: "claude-4.6-opus", name: "Claude 4.6 Opus" }],
    });
    await expect(resolveCursorModels(credentials)).resolves.toEqual({
      models: [{ id: "claude-4.6-opus", name: "Claude 4.6 Opus" }],
    });

    expect(mockHttp2Connect).toHaveBeenCalledTimes(1);
    expect(mockHttp2Connect).toHaveBeenCalledWith("https://agent.api5.cursor.sh");
    const client = mockHttp2Connect.mock.results[0].value;
    expect(client.request).toHaveBeenCalledWith(
      expect.objectContaining({
        ":method": "POST",
        ":path": "/agent.v1.AgentService/GetUsableModels",
        accept: "application/proto",
        "content-type": "application/proto",
      }),
    );
  });

  it("fails open when the Cursor catalog request fails", async () => {
    mockHttp2Response({ status: 403, body: new TextEncoder().encode("no") });

    await expect(resolveCursorModels({
      accessToken: "cursor-token",
      providerSpecificData: { machineId: "machine-id" },
    })).resolves.toBeNull();
  });
});
