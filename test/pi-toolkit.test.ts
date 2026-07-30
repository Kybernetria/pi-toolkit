async function invokeResult(fabric: { invokeTracked(request: any): Promise<any> }, request: any): Promise<any> {
  return (await fabric.invokeTracked(request)).result;
}

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { join } from "node:path";
import test from "node:test";
import { ensureProtocolFabric } from "@kybernetria/pi-protocol/core";
import { parseProtocolManifest } from "@kybernetria/pi-protocol/contract";
import piToolkitExtension from "../extension.ts";
import {
  CommunityStackApiError,
  CommunityStackClient,
  CommunityStackTransportError,
  MAX_REQUEST_BYTES,
  MAX_RESPONSE_BYTES,
} from "../src/client.ts";
import { createHandlers, PROVIDE_NAMES } from "../src/handlers.ts";

const TOKEN = "a".repeat(64);
const OPERATION_HASH = "b".repeat(64);

type ApiRequest = {
  v: number;
  id: string;
  token: string;
  method: string;
  params: Record<string, unknown>;
};
type RequestHandler = (request: ApiRequest, socket: Socket, declaredLength: number) => void | Promise<void>;

async function fakeSocket(handler: RequestHandler): Promise<{ path: string; close(): Promise<void> }> {
  const directory = await mkdtemp(join(process.cwd(), ".pi-toolkit-test-"));
  const path = join(directory, "community.sock");
  const sockets = new Set<Socket>();
  const server = createServer({ allowHalfOpen: true }, (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    let bytes = Buffer.alloc(0);
    let handled = false;
    socket.on("data", (chunk) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytes = bytes.length === 0 ? buffer : Buffer.concat([bytes, buffer]);
      if (handled || bytes.length < 4) return;
      const declaredLength = bytes.readUInt32BE(0);
      if (bytes.length < declaredLength + 4) return;
      handled = true;
      const request = JSON.parse(bytes.subarray(4, declaredLength + 4).toString("utf8")) as ApiRequest;
      void Promise.resolve(handler(request, socket, declaredLength)).catch((error) => socket.destroy(error as Error));
    });
  });
  await listen(server, path);
  return {
    path,
    async close() {
      for (const socket of sockets) socket.destroy();
      await closeServer(server);
      await rm(directory, { recursive: true, force: true });
    },
  };
}

function listen(server: Server, path: string): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(path, () => {
      server.off("error", reject);
      resolve();
    });
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

function responseFrame(request: ApiRequest, result: unknown): Buffer {
  const body = Buffer.from(JSON.stringify({ v: 1, id: request.id, ok: true, result }), "utf8");
  const frame = Buffer.alloc(4 + body.length);
  frame.writeUInt32BE(body.length, 0);
  body.copy(frame, 4);
  return frame;
}

function errorFrame(request: ApiRequest, code: string, message: string, retryable: boolean): Buffer {
  const body = Buffer.from(JSON.stringify({ v: 1, id: request.id, ok: false, error: { code, message, retryable } }), "utf8");
  const frame = Buffer.alloc(4 + body.length);
  frame.writeUInt32BE(body.length, 0);
  body.copy(frame, 4);
  return frame;
}

function writeResult(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { operation_hash: OPERATION_HASH, status: "APPLIED", durable: true, state: {}, ...extra };
}

function handlerEnv(path: string, community = "research"): NodeJS.ProcessEnv {
  return {
    COMMUNITY_STACK_SOCKET: path,
    COMMUNITY_STACK_APP_TOKEN: TOKEN,
    COMMUNITY_STACK_COMMUNITY_ID: community,
  };
}

test("extension registers all five handler provides without a token and invocation fails closed", async () => {
  const definition = parseProtocolManifest(await readFile(new URL("../pi.protocol.json", import.meta.url), "utf8"));
  const manifest = definition.manifest;
  assert.equal(manifest.schemaVersion, 1);
  assert.equal(manifest.node.id, "pi_toolkit");
  assert.deepEqual(manifest.provides.map((provide) => provide.name), [...PROVIDE_NAMES]);
  assert.equal(JSON.stringify(manifest).includes("COMMUNITY_STACK_APP_TOKEN"), false);
  const search = manifest.provides.find((provide) => provide.name === "search");
  assert.ok(search);
  assert.equal(search.inputSchema.required, undefined);
  assert.match(search.inputSchema.description ?? "", /requiring at least one and at most 64 total requirements/);
  assert.match(search.inputSchema.properties?.tools?.description ?? "", /0-64 unique exact tool keys/);
  const listTools = manifest.provides.find((provide) => provide.name === "list_tools");
  assert.ok(listTools);
  assert.deepEqual(listTools.outputSchema.required, ["communityId", "offset", "limit", "tools", "hasMoreHint"]);
  assert.equal("assertions" in (listTools.outputSchema.properties ?? {}), false);
  assert.equal("concepts" in (listTools.outputSchema.properties ?? {}), false);
  assert.equal("reviews" in (listTools.outputSchema.properties ?? {}), false);

  const saved = { ...process.env };
  delete process.env.COMMUNITY_STACK_APP_TOKEN;
  process.env.COMMUNITY_STACK_SOCKET = "/unused/community.sock";
  process.env.COMMUNITY_STACK_COMMUNITY_ID = "research";
  const tools: string[] = [];
  let shutdown: (() => Promise<void>) | undefined;
  const fabric = ensureProtocolFabric();
  try {
    assert.doesNotThrow(() => piToolkitExtension({
      registerTool(tool: { name: string }) { tools.push(tool.name); },
      on(event: string, callback: () => Promise<void>) { if (event === "session_shutdown") shutdown = callback; },
    } as never));
    assert.deepEqual(tools, []);
    assert.deepEqual(fabric.describeNode("pi_toolkit")?.provides.map((provide) => provide.name), [...PROVIDE_NAMES]);
    assert.deepEqual(await invokeResult(fabric, { nodeId: "pi_toolkit", provide: "schema", input: { operation: "list" } }), {
      ok: false,
      error: {
        code: "EXECUTION_FAILED",
        message: "COMMUNITY_STACK_APP_TOKEN is required and must contain exactly 64 hexadecimal characters",
      },
    });
  } finally {
    await shutdown?.();
    process.env = saved;
  }
});

test("client uses complete big-endian framing and handler keeps the host token out of inputs and outputs", async () => {
  let captured: ApiRequest | undefined;
  const fake = await fakeSocket((request, socket, declaredLength) => {
    captured = request;
    assert.equal(declaredLength, Buffer.byteLength(JSON.stringify(request)));
    const frame = responseFrame(request, [{ key: "cap.sync", revision: "c".repeat(64) }]);
    socket.write(frame.subarray(0, 2));
    setTimeout(() => socket.write(frame.subarray(2, 11)), 2);
    setTimeout(() => socket.end(frame.subarray(11)), 4);
  });
  try {
    const result = await createHandlers(handlerEnv(fake.path)).schema({ operation: "list", limit: 2 });
    assert.deepEqual(captured, {
      v: 1,
      id: captured?.id,
      token: TOKEN,
      method: "toolkit.schema.list",
      params: { community_id: "research", active_only: true, limit: 2 },
    });
    assert.equal(JSON.stringify(result).includes(TOKEN), false);
    await assert.rejects(
      async () => createHandlers(handlerEnv(fake.path)).schema({ operation: "list", token: TOKEN }),
      (error: unknown) => error instanceof TypeError && !error.message.includes(TOKEN),
    );
  } finally {
    await fake.close();
  }
});

test("list_tools validates and filters native toolkit.export pages", async () => {
  const requests: ApiRequest[] = [];
  const tools = [
    {
      key: "iroh",
      name: "Iroh",
      description: null,
      homepage: "https://iroh.com/",
      status: "active",
      source_operation_hash: OPERATION_HASH,
    },
    {
      key: "p2panda",
      name: "p2panda",
      description: "Peer-to-peer protocol toolkit.",
      homepage: null,
      status: "deprecated",
      source_operation_hash: "c".repeat(64),
    },
  ];
  const fake = await fakeSocket((request, socket) => {
    requests.push(request);
    socket.end(responseFrame(request, {
      format: request.params.offset === 9 ? "unexpected-format" : "community-stack-toolkit-export",
      version: 1,
      community_id: request.params.community_id,
      offset: request.params.offset,
      limit: request.params.limit,
      concepts: [{ key: "must-not-escape" }],
      tools,
      assertions: [{ evidence: "must-not-escape" }],
      reviews: [{ rationale: "must-not-escape" }],
      import_supported: false,
    }));
  });
  try {
    const handlers = createHandlers(handlerEnv(fake.path, "host-default"));
    const page = await handlers.list_tools({ communityId: "override", offset: 7, limit: 2 });
    assert.deepEqual(requests[0], {
      v: 1,
      id: requests[0]?.id,
      token: TOKEN,
      method: "toolkit.export",
      params: { community_id: "override", offset: 7, limit: 2 },
    });
    assert.deepEqual(page, {
      communityId: "override",
      offset: 7,
      limit: 2,
      tools,
      hasMoreHint: true,
    });
    assert.equal(JSON.stringify(page).includes("must-not-escape"), false);

    assert.deepEqual(await handlers.list_tools({}), {
      communityId: "host-default",
      offset: 0,
      limit: 100,
      tools,
      hasMoreHint: false,
    });
    assert.deepEqual(requests[1]?.params, { community_id: "host-default", offset: 0, limit: 100 });

    await assert.rejects(async () => handlers.list_tools({ offset: 9 }), /Native toolkit export envelope response/);
    await assert.rejects(async () => handlers.list_tools({ unknown: true }), /unknown field unknown/);
    await assert.rejects(async () => handlers.list_tools({ offset: -1 }), /offset must be an integer from 0 to 100000/);
    await assert.rejects(async () => handlers.list_tools({ offset: 100_001 }), /offset must be an integer from 0 to 100000/);
    await assert.rejects(async () => handlers.list_tools({ limit: 0 }), /limit must be an integer from 1 to 500/);
    await assert.rejects(async () => handlers.list_tools({ limit: 501 }), /limit must be an integer from 1 to 500/);
    assert.equal(requests.length, 3);
  } finally {
    await fake.close();
  }
});

test("search translates restricted and whole-catalog plans to bounded native toolkit.query parameters", async () => {
  const requests: ApiRequest[] = [];
  const fake = await fakeSocket((request, socket) => {
    requests.push(request);
    socket.end(responseFrame(request, { exact_count: 1, results: [{
      tool: "p2panda", name: "p2panda", match: "exact", satisfied_requirements: 3, requirements: [],
    }] }));
  });
  try {
    const handlers = createHandlers(handlerEnv(fake.path, "host-default"));
    const result = await handlers.search({
      communityId: "override",
      tools: ["p2panda"],
      requirements: [{ concept: "cap.sync.peer-to-peer", conceptRevision: "d".repeat(64), op: "eq", value: true, required: true }],
      mandatory: [{ concept: "standard.sync", op: "exists" }],
      optional: [{ concept: "dimension.sync.score", op: "gte", value: 8 }],
      includePartial: false,
    });
    assert.equal(requests[0]?.method, "toolkit.query");
    assert.deepEqual(requests[0]?.params, {
      community_id: "override",
      tools: ["p2panda"],
      requirements: [{ concept: "cap.sync.peer-to-peer", concept_revision: "d".repeat(64), op: "eq", value: true, required: true }],
      mandatory: [{ concept: "standard.sync", op: "exists" }],
      optional: [{ concept: "dimension.sync.score", op: "gte", value: 8 }],
      include_partial: false,
    });
    assert.deepEqual(result, { exact_count: 1, results: [{
      tool: "p2panda", name: "p2panda", match: "exact", satisfied_requirements: 3, requirements: [],
    }] });

    await handlers.search({ requirements: [{ concept: "x", op: "exists" }] });
    await handlers.search({ tools: [], requirements: [{ concept: "x", op: "exists" }] });
    assert.deepEqual(requests[1]?.params.tools, []);
    assert.deepEqual(requests[2]?.params.tools, []);

    await assert.rejects(async () => handlers.search({}), /search must contain 1\.\.=64 total requirements/);
    await assert.rejects(async () => handlers.search({ requirements: [], mandatory: [], optional: [] }), /search must contain 1\.\.=64 total requirements/);
    await assert.rejects(
      async () => handlers.search({ tools: ["duplicate", "duplicate"], requirements: [{ concept: "x", op: "exists" }] }),
      /tools must not contain duplicates/,
    );
    await assert.rejects(
      async () => handlers.search({ tools: Array.from({ length: 65 }, (_, index) => `tool-${index}`), requirements: [{ concept: "x", op: "exists" }] }),
      /tools must contain 0\.\.=64 entries/,
    );
  } finally {
    await fake.close();
  }
});

test("trusted assertion handler forces AI proposed state, translates assessment metadata, and preserves retry IDs", async () => {
  const requests: ApiRequest[] = [];
  const fake = await fakeSocket((request, socket) => {
    requests.push(request);
    const params = request.params;
    socket.end(responseFrame(request, writeResult({
      assertion_id: params.assertion_id,
      verification_state: params.verification_state,
    })));
  });
  const handlers = createHandlers(handlerEnv(fake.path));
  const base = {
    tool: "p2panda",
    concept: "dimension.sync.transport-agnosticism",
    value: 8,
    source: "https://example.test/evidence",
    evidence: "Architecture evidence.",
    asOf: "2026-07-26",
    assessment: {
      rubric: "transport-agnosticism",
      rubricVersion: "1",
      rationale: "Maps to anchor eight.",
      evaluatorType: "ai",
      evaluationDate: "2026-07-26",
    },
  };
  try {
    await assert.rejects(async () => handlers.propose_assertion({ ...base, verificationState: "verified" }), /unknown field verificationState/);
    await assert.rejects(async () => handlers.propose_assertion({ ...base, origin: "human" }), /unknown field origin/);

    const supplied = await handlers.propose_assertion({ ...base, assertionId: "retry-assertion", idempotencyKey: "retry-command" }) as Record<string, unknown>;
    const generatedA = await handlers.propose_assertion(base) as Record<string, unknown>;
    const generatedB = await handlers.propose_assertion(base) as Record<string, unknown>;
    const stableA = await handlers.propose_assertion({ ...base, idempotencyKey: "stable-command" }) as Record<string, unknown>;
    const stableB = await handlers.propose_assertion({ ...base, idempotencyKey: "stable-command" }) as Record<string, unknown>;
    assert.equal(supplied.assertionId, "retry-assertion");
    assert.equal(supplied.idempotencyKey, "retry-command");
    assert.notEqual(generatedA.assertionId, generatedB.assertionId);
    assert.notEqual(generatedA.idempotencyKey, generatedB.idempotencyKey);
    assert.equal(stableA.assertionId, stableB.assertionId);
    assert.deepEqual(requests[0]?.params, {
      community_id: "research",
      idempotency_key: "retry-command",
      assertion_id: "retry-assertion",
      tool: "p2panda",
      concept: "dimension.sync.transport-agnosticism",
      concept_revision: null,
      value: 8,
      origin: "ai",
      verification_state: "proposed",
      source: "https://example.test/evidence",
      evidence: "Architecture evidence.",
      as_of: "2026-07-26",
      rubric: "transport-agnosticism",
      rubric_version: "1",
      rationale: "Maps to anchor eight.",
      evaluator_type: "ai",
      evaluation_date: "2026-07-26",
    });
    assert.ok(requests.every((request) => request.params.origin === "ai" && request.params.verification_state === "proposed"));
    await assert.rejects(async () => handlers.propose_assertion({ ...base, asOf: "2026-99-99" }), /valid calendar date/);
  } finally {
    await fake.close();
  }
});

test("add_tool submits one identity and returns generated or caller-supplied idempotency keys", async () => {
  const requests: ApiRequest[] = [];
  const fake = await fakeSocket((request, socket) => {
    requests.push(request);
    socket.end(responseFrame(request, writeResult()));
  });
  try {
    const handlers = createHandlers(handlerEnv(fake.path));
    const retry = await handlers.add_tool({ key: "p2panda", name: "p2panda", idempotencyKey: "safe-retry" }) as Record<string, unknown>;
    const generated = await handlers.add_tool({ key: "iroh", name: "Iroh", homepage: "https://iroh.com/" }) as Record<string, unknown>;
    assert.equal(retry.idempotencyKey, "safe-retry");
    assert.match(String(generated.idempotencyKey), /^tool-[0-9a-f-]{36}$/);
    assert.equal(requests[0]?.method, "toolkit.tool.add");
    assert.equal(requests[0]?.params.idempotency_key, "safe-retry");
  } finally {
    await fake.close();
  }
});

test("native structured API errors propagate without leaking the host token", async () => {
  const fake = await fakeSocket((request, socket) => {
    socket.end(errorFrame(request, "CONFLICT", `catalog locked; credential ${TOKEN}`, true));
  });
  try {
    const client = new CommunityStackClient({ socketPath: fake.path, token: TOKEN });
    await assert.rejects(
      client.call("toolkit.schema.list", { community_id: "research", active_only: true, limit: 1 }),
      (error: unknown) => {
        assert.ok(error instanceof CommunityStackApiError);
        assert.equal(error.code, "CONFLICT");
        assert.equal(error.retryable, true);
        assert.equal(error.message.includes(TOKEN), false);
        assert.match(error.message, /\[REDACTED\]/);
        return true;
      },
    );
  } finally {
    await fake.close();
  }
});

test("client rejects token echoes and bytes trailing the single response frame", async () => {
  const echo = await fakeSocket((request, socket) => {
    socket.end(responseFrame(request, { echoed: TOKEN }));
  });
  try {
    const client = new CommunityStackClient({ socketPath: echo.path, token: TOKEN });
    await assert.rejects(client.call("toolkit.schema.list", {}),
      (error: unknown) => error instanceof CommunityStackTransportError && error.code === "INVALID_RESPONSE" && !error.message.includes(TOKEN));
  } finally {
    await echo.close();
  }

  const trailing = await fakeSocket((request, socket) => {
    socket.end(Buffer.concat([responseFrame(request, []), Buffer.from("unexpected")]));
  });
  try {
    const client = new CommunityStackClient({ socketPath: trailing.path, token: TOKEN });
    await assert.rejects(client.call("toolkit.schema.list", {}),
      (error: unknown) => error instanceof CommunityStackTransportError && error.code === "INVALID_RESPONSE");
  } finally {
    await trailing.close();
  }
});

test("client rejects oversized responses and requests before unbounded allocation or I/O", async () => {
  let connections = 0;
  const fake = await fakeSocket((_request, socket) => {
    connections += 1;
    const prefix = Buffer.alloc(4);
    prefix.writeUInt32BE(MAX_RESPONSE_BYTES + 1);
    socket.end(prefix);
  });
  try {
    const client = new CommunityStackClient({ socketPath: fake.path, token: TOKEN });
    await assert.rejects(client.call("toolkit.query", { community_id: "research" }),
      (error: unknown) => error instanceof CommunityStackTransportError && error.code === "RESPONSE_TOO_LARGE");
    await assert.rejects(client.call("toolkit.query", { payload: "x".repeat(MAX_REQUEST_BYTES) }),
      (error: unknown) => error instanceof CommunityStackTransportError && error.code === "REQUEST_TOO_LARGE");
    assert.equal(connections, 1);
  } finally {
    await fake.close();
  }
});

test("timeout and AbortSignal cancellation close stalled local socket requests", async () => {
  const fake = await fakeSocket(() => { /* deliberately leave the connection unanswered */ });
  try {
    const timed = new CommunityStackClient({ socketPath: fake.path, token: TOKEN, timeoutMs: 30 });
    await assert.rejects(timed.call("toolkit.schema.list", {}),
      (error: unknown) => error instanceof CommunityStackTransportError && error.code === "TIMEOUT");

    const controller = new AbortController();
    const cancellable = new CommunityStackClient({ socketPath: fake.path, token: TOKEN, timeoutMs: 5_000 });
    const pending = cancellable.call("toolkit.schema.list", {}, controller.signal);
    setTimeout(() => controller.abort(), 20);
    await assert.rejects(pending, (error: unknown) => error instanceof Error && error.name === "AbortError");
  } finally {
    await fake.close();
  }
});

test("host configuration is required lazily and contains no caller-visible secret field", async () => {
  assert.throws(() => CommunityStackClient.fromEnvironment({}), /COMMUNITY_STACK_APP_TOKEN is required/);
  const missingTokenHandlers = createHandlers({});
  await assert.rejects(
    async () => missingTokenHandlers.schema({ operation: "list" }),
    /COMMUNITY_STACK_APP_TOKEN is required/,
  );
  const handlers = createHandlers({
    COMMUNITY_STACK_APP_TOKEN: TOKEN,
    COMMUNITY_STACK_SOCKET: `/unused/${randomUUID()}.sock`,
  });
  assert.deepEqual(Object.keys(handlers), [...PROVIDE_NAMES]);
  for (const name of Object.keys(handlers)) assert.equal(name.toLowerCase().includes("token"), false);
  await assert.rejects(async () => handlers.schema({ operation: "show", key: "cap.sync", revision: null }), /64-character hexadecimal revision/);
});
