import { randomUUID } from "node:crypto";
import { createConnection, type Socket } from "node:net";

export const MAX_REQUEST_BYTES = 1_048_576;
export const MAX_RESPONSE_BYTES = 4_194_304;
export const DEFAULT_SOCKET_PATH = "/home/kyvernitria/Applications/community-stack/data/community.sock";
export const DEFAULT_COMMUNITY_ID = "research";
const DEFAULT_TIMEOUT_MS = 5_000;

export interface CommunityStackClientOptions {
  socketPath: string;
  token: string;
  timeoutMs?: number;
}

export class CommunityStackApiError extends Error {
  readonly code: string;
  readonly retryable: boolean;

  constructor(code: string, message: string, retryable: boolean) {
    super(message);
    this.name = "CommunityStackApiError";
    this.code = code;
    this.retryable = retryable;
  }
}

export class CommunityStackTransportError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "CommunityStackTransportError";
    this.code = code;
  }
}

export class CommunityStackClient {
  readonly socketPath: string;
  readonly timeoutMs: number;
  readonly #token: string;

  constructor(options: CommunityStackClientOptions) {
    if (!options.socketPath || options.socketPath.includes("\0")) {
      throw new Error("COMMUNITY_STACK_SOCKET must be a non-empty Unix socket path");
    }
    if (!/^[a-fA-F0-9]{64}$/.test(options.token)) {
      throw new Error("COMMUNITY_STACK_APP_TOKEN is required and must contain exactly 64 hexadecimal characters");
    }
    if (!Number.isInteger(options.timeoutMs ?? DEFAULT_TIMEOUT_MS) || (options.timeoutMs ?? DEFAULT_TIMEOUT_MS) < 1) {
      throw new Error("client timeout must be a positive integer");
    }
    this.socketPath = options.socketPath;
    this.#token = options.token;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  static fromEnvironment(env: NodeJS.ProcessEnv = process.env): CommunityStackClient {
    return new CommunityStackClient({
      socketPath: env.COMMUNITY_STACK_SOCKET ?? DEFAULT_SOCKET_PATH,
      token: env.COMMUNITY_STACK_APP_TOKEN ?? "",
    });
  }

  async call(method: string, params: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
    if (signal?.aborted) throw abortError();
    const id = `pi-toolkit-${randomUUID()}`;
    const body = Buffer.from(JSON.stringify({ v: 1, id, token: this.#token, method, params }), "utf8");
    if (body.length === 0 || body.length > MAX_REQUEST_BYTES) {
      throw new CommunityStackTransportError("REQUEST_TOO_LARGE", `Local API request exceeds ${MAX_REQUEST_BYTES} bytes`);
    }
    const frame = Buffer.allocUnsafe(4 + body.length);
    frame.writeUInt32BE(body.length, 0);
    body.copy(frame, 4);

    const response = await exchangeFrame(this.socketPath, frame, this.timeoutMs, signal);
    let envelope: unknown;
    try {
      envelope = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(response));
    } catch {
      throw new CommunityStackTransportError("INVALID_RESPONSE", "Local API response is not valid UTF-8 JSON");
    }
    if (!isRecord(envelope) || envelope.v !== 1 || envelope.id !== id || typeof envelope.ok !== "boolean") {
      throw new CommunityStackTransportError("INVALID_RESPONSE", "Local API response envelope is invalid or mismatched");
    }
    if (envelope.ok) {
      if (!("result" in envelope)) {
        throw new CommunityStackTransportError("INVALID_RESPONSE", "Successful local API response omitted result");
      }
      if (containsSecret(envelope.result, this.#token)) {
        throw new CommunityStackTransportError("INVALID_RESPONSE", "Local API response attempted to expose the host credential");
      }
      return envelope.result;
    }
    if (!isRecord(envelope.error) || typeof envelope.error.code !== "string" ||
        !/^[A-Z][A-Z0-9_]{0,63}$/.test(envelope.error.code) ||
        typeof envelope.error.message !== "string" || typeof envelope.error.retryable !== "boolean") {
      throw new CommunityStackTransportError("INVALID_RESPONSE", "Local API error envelope is invalid");
    }
    throw new CommunityStackApiError(
      envelope.error.code,
      redact(envelope.error.message, this.#token),
      envelope.error.retryable,
    );
  }
}

function exchangeFrame(
  socketPath: string,
  frame: Buffer,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    let socket: Socket;
    let settled = false;
    const header = Buffer.allocUnsafe(4);
    let headerBytes = 0;
    let body: Buffer | undefined;
    let bodyBytes = 0;

    const finish = (error?: Error, value?: Buffer): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      socket.removeAllListeners();
      socket.destroy();
      if (error) reject(error);
      else resolve(value as Buffer);
    };
    const onAbort = (): void => finish(abortError());
    const timer = setTimeout(() => {
      finish(new CommunityStackTransportError("TIMEOUT", `Local API request timed out after ${timeoutMs} ms`));
    }, timeoutMs);

    socket = createConnection({ path: socketPath });
    signal?.addEventListener("abort", onAbort, { once: true });
    socket.once("connect", () => socket.end(frame));
    socket.on("data", (rawChunk) => {
      const chunk = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk);
      let offset = 0;
      if (body && bodyBytes === body.length) {
        finish(new CommunityStackTransportError("INVALID_RESPONSE", "Local API sent bytes after its single response frame"));
        return;
      }
      if (headerBytes < 4) {
        const take = Math.min(4 - headerBytes, chunk.length);
        chunk.copy(header, headerBytes, 0, take);
        headerBytes += take;
        offset += take;
        if (headerBytes === 4) {
          const expectedLength = header.readUInt32BE(0);
          if (expectedLength === 0) {
            finish(new CommunityStackTransportError("INVALID_RESPONSE", "Local API response frame is empty"));
            return;
          }
          if (expectedLength > MAX_RESPONSE_BYTES) {
            finish(new CommunityStackTransportError("RESPONSE_TOO_LARGE", `Local API response exceeds ${MAX_RESPONSE_BYTES} bytes`));
            return;
          }
          body = Buffer.allocUnsafe(expectedLength);
        }
      }
      if (body && offset < chunk.length) {
        const take = Math.min(body.length - bodyBytes, chunk.length - offset);
        chunk.copy(body, bodyBytes, offset, offset + take);
        bodyBytes += take;
        offset += take;
      }
      if (offset !== chunk.length) {
        finish(new CommunityStackTransportError("INVALID_RESPONSE", "Local API sent bytes after its single response frame"));
      }
    });
    socket.once("end", () => {
      if (settled) return;
      if (headerBytes !== 4 || !body || bodyBytes !== body.length) {
        finish(new CommunityStackTransportError("INCOMPLETE_RESPONSE", "Local API connection ended before a complete response frame"));
        return;
      }
      finish(undefined, body);
    });
    socket.once("error", (error) => {
      finish(new CommunityStackTransportError("SOCKET_ERROR", `Local API socket error: ${error.message}`));
    });
  });
}

function abortError(): Error {
  const error = new Error("Invocation aborted");
  error.name = "AbortError";
  return error;
}

function redact(message: string, secret: string): string {
  return secret ? message.split(secret).join("[REDACTED]") : message;
}

function containsSecret(value: unknown, secret: string): boolean {
  if (!secret) return false;
  if (typeof value === "string") return value.includes(secret);
  if (Array.isArray(value)) return value.some((item) => containsSecret(item, secret));
  if (isRecord(value)) return Object.entries(value).some(([key, item]) => key.includes(secret) || containsSecret(item, secret));
  return false;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
