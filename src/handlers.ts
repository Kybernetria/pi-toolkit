import { createHash, randomUUID } from "node:crypto";
import type { ProtocolHandler, ProtocolInvocationContext } from "@kybernetria/pi-protocol/core";
import { CommunityStackClient, DEFAULT_COMMUNITY_ID } from "./client.ts";

export const PROVIDE_NAMES = ["schema", "search", "add_tool", "propose_assertion", "list_tools"] as const;
export type ProvideName = (typeof PROVIDE_NAMES)[number];
const MAX_HANDLER_OUTPUT_BYTES = 1_048_576;
const KEY_PATTERN = /^[A-Za-z0-9._:/-]+$/;
const REVISION_PATTERN = /^[a-fA-F0-9]{64}$/;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const QUERY_OPERATORS = new Set(["eq", "ne", "in", "exists", "gt", "gte", "lt", "lte"]);

type JsonScalar = string | number | boolean;
type Requirement = {
  concept: string;
  concept_revision?: string | null;
  op: string;
  value?: JsonScalar | JsonScalar[];
  required?: boolean;
};

/** Production handlers read all connection configuration from the host environment. */
export function createHandlers(env: NodeJS.ProcessEnv = process.env): Record<ProvideName, ProtocolHandler> {
  let client: CommunityStackClient | undefined;
  const defaultCommunity = communityId(env.COMMUNITY_STACK_COMMUNITY_ID ?? DEFAULT_COMMUNITY_ID, "COMMUNITY_STACK_COMMUNITY_ID");
  const call = (method: string, params: Record<string, unknown>, context?: ProtocolInvocationContext) => {
    client ??= CommunityStackClient.fromEnvironment(env);
    return client.call(method, params, context?.abortSignal);
  };

  return {
    async schema(input: unknown, context?: ProtocolInvocationContext) {
      const object = record(input, "schema input");
      const operation = enumeration(object.operation, "operation", ["list", "show"] as const);
      const selectedCommunity = optionalCommunity(object.communityId, defaultCommunity);
      if (operation === "list") {
        exactKeys(object, ["operation", "communityId", "limit"], "schema list input");
        const limit = optionalInteger(object.limit, 100, 1, 100, "limit");
        const result = await call("toolkit.schema.list", {
          community_id: selectedCommunity,
          active_only: true,
          limit,
        }, context);
        if (!Array.isArray(result) || result.length > limit) throw invalidNative("schema list");
        return bounded({ operation, communityId: selectedCommunity, result });
      }

      exactKeys(object, ["operation", "communityId", "key", "revision"], "schema show input");
      const key = toolkitKey(object.key, "key");
      const revision = optionalRevision(object.revision, "revision");
      const result = await call("toolkit.schema.show", {
        community_id: selectedCommunity,
        key,
        revision: revision ?? null,
      }, context);
      if (!isRecord(result) || result.key !== key || (revision !== undefined && result.revision !== revision)) {
        throw invalidNative("schema show");
      }
      return bounded({ operation, communityId: selectedCommunity, result });
    },

    async search(input: unknown, context?: ProtocolInvocationContext) {
      const object = record(input, "search input");
      exactKeys(object, ["communityId", "tools", "requirements", "mandatory", "optional", "includePartial"], "search input");
      const selectedCommunity = optionalCommunity(object.communityId, defaultCommunity);
      const tools = object.tools === undefined ? [] : stringArray(object.tools, "tools", 0, 64, toolkitKey);
      const requirements = requirementArray(object.requirements, "requirements", true);
      const mandatory = requirementArray(object.mandatory, "mandatory", false);
      const optional = requirementArray(object.optional, "optional", false);
      const total = requirements.length + mandatory.length + optional.length;
      if (total < 1 || total > 64) throw new TypeError("search must contain 1..=64 total requirements");
      const includePartial = optionalBoolean(object.includePartial, true, "includePartial");
      const result = await call("toolkit.query", {
        community_id: selectedCommunity,
        tools,
        requirements,
        mandatory,
        optional,
        include_partial: includePartial,
      }, context);
      if (!isRecord(result) || !Number.isInteger(result.exact_count) || !Array.isArray(result.results) ||
          (tools.length > 0 && result.results.length > tools.length)) {
        throw invalidNative("toolkit query");
      }
      return bounded(result);
    },

    async add_tool(input: unknown, context?: ProtocolInvocationContext) {
      const object = record(input, "add_tool input");
      exactKeys(object, ["communityId", "idempotencyKey", "key", "name", "description", "homepage", "status"], "add_tool input");
      const selectedCommunity = optionalCommunity(object.communityId, defaultCommunity);
      const idempotencyKey = optionalRetryId(object.idempotencyKey, "idempotencyKey", "tool");
      const key = toolkitKey(object.key, "key");
      const name = printableString(object.name, "name", 256);
      const description = optionalPrintableString(object.description, "description", 4_096);
      const homepage = optionalHomepage(object.homepage);
      const status = object.status === undefined ? "active" : enumeration(object.status, "status", ["active", "deprecated"] as const);
      const result = await call("toolkit.tool.add", compact({
        community_id: selectedCommunity,
        idempotency_key: idempotencyKey,
        key,
        name,
        description,
        homepage,
        status,
      }), context);
      assertWriteResult(result, "toolkit.tool.add");
      return bounded({ communityId: selectedCommunity, idempotencyKey, result });
    },

    async propose_assertion(input: unknown, context?: ProtocolInvocationContext) {
      const object = record(input, "propose_assertion input");
      exactKeys(object, [
        "communityId", "idempotencyKey", "assertionId", "tool", "concept", "conceptRevision",
        "value", "source", "evidence", "asOf", "assessment",
      ], "propose_assertion input");
      const selectedCommunity = optionalCommunity(object.communityId, defaultCommunity);
      const idempotencyKey = optionalRetryId(object.idempotencyKey, "idempotencyKey", "assert");
      const assertionId = object.assertionId === undefined
        ? `assertion-${createHash("sha256").update(idempotencyKey).digest("hex").slice(0, 40)}`
        : toolkitKey(object.assertionId, "assertionId");
      const value = scalar(object.value, "value");
      const assessment = optionalAssessment(object.assessment);
      const params = compact({
        community_id: selectedCommunity,
        idempotency_key: idempotencyKey,
        assertion_id: assertionId,
        tool: toolkitKey(object.tool, "tool"),
        concept: toolkitKey(object.concept, "concept"),
        concept_revision: optionalRevision(object.conceptRevision, "conceptRevision") ?? null,
        value,
        origin: "ai",
        verification_state: "proposed",
        source: printableString(object.source, "source", 2_048),
        evidence: printableString(object.evidence, "evidence", 8_192),
        as_of: date(object.asOf, "asOf"),
        rubric: assessment?.rubric,
        rubric_version: assessment?.rubricVersion,
        rationale: assessment?.rationale,
        evaluator_type: assessment?.evaluatorType,
        evaluation_date: assessment?.evaluationDate,
      });
      const result = await call("toolkit.assert", params, context);
      assertWriteResult(result, "toolkit.assert");
      if ((result as Record<string, unknown>).verification_state !== "proposed" ||
          (result as Record<string, unknown>).assertion_id !== assertionId) {
        throw invalidNative("toolkit.assert enforcement");
      }
      return bounded({ communityId: selectedCommunity, idempotencyKey, assertionId, result });
    },

    async list_tools(input: unknown, context?: ProtocolInvocationContext) {
      const object = record(input, "list_tools input");
      exactKeys(object, ["communityId", "offset", "limit"], "list_tools input");
      const selectedCommunity = optionalCommunity(object.communityId, defaultCommunity);
      const offset = optionalInteger(object.offset, 0, 0, 100_000, "offset");
      const limit = optionalInteger(object.limit, 100, 1, 500, "limit");
      const result = await call("toolkit.export", {
        community_id: selectedCommunity,
        offset,
        limit,
      }, context);
      const tools = validateExportEnvelope(result, selectedCommunity, offset, limit);
      return bounded({
        communityId: selectedCommunity,
        offset,
        limit,
        tools,
        hasMoreHint: tools.length === limit,
      });
    },
  };
}

function validateExportEnvelope(
  value: unknown,
  community: string,
  offset: number,
  limit: number,
): Record<string, unknown>[] {
  const envelope = record(value, "toolkit export response");
  exactKeys(envelope, [
    "format", "version", "community_id", "offset", "limit", "concepts", "tools",
    "assertions", "reviews", "import_supported",
  ], "toolkit export response");
  if (envelope.format !== "community-stack-toolkit-export" || envelope.version !== 1 ||
      envelope.community_id !== community || envelope.offset !== offset || envelope.limit !== limit ||
      envelope.import_supported !== false) {
    throw invalidNative("toolkit export envelope");
  }
  for (const field of ["concepts", "tools", "assertions", "reviews"] as const) {
    if (!Array.isArray(envelope[field]) || envelope[field].length > limit) {
      throw invalidNative("toolkit export envelope");
    }
  }
  const tools = envelope.tools as unknown[];
  for (const [index, value] of tools.entries()) {
    const tool = record(value, `toolkit export tools[${index}]`);
    exactKeys(tool, ["key", "name", "description", "homepage", "status", "source_operation_hash"], `toolkit export tools[${index}]`);
    toolkitKey(tool.key, `toolkit export tools[${index}].key`);
    printableString(tool.name, `toolkit export tools[${index}].name`, 256);
    nullablePrintableString(tool.description, `toolkit export tools[${index}].description`, 4_096);
    nullablePrintableString(tool.homepage, `toolkit export tools[${index}].homepage`, 2_048);
    enumeration(tool.status, `toolkit export tools[${index}].status`, ["active", "deprecated"] as const);
    revision(tool.source_operation_hash, `toolkit export tools[${index}].source_operation_hash`);
  }
  return tools as Record<string, unknown>[];
}

function requirementArray(value: unknown, field: string, allowRequired: boolean): Requirement[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 64) throw new TypeError(`${field} must be an array with at most 64 entries`);
  return value.map((entry, index) => {
    const item = record(entry, `${field}[${index}]`);
    exactKeys(item, allowRequired
      ? ["concept", "conceptRevision", "op", "value", "required"]
      : ["concept", "conceptRevision", "op", "value"], `${field}[${index}]`);
    const op = enumeration(item.op, `${field}[${index}].op`, [...QUERY_OPERATORS] as string[]);
    const requirement: Requirement = {
      concept: toolkitKey(item.concept, `${field}[${index}].concept`),
      op,
    };
    const revision = optionalRevision(item.conceptRevision, `${field}[${index}].conceptRevision`);
    if (revision !== undefined) requirement.concept_revision = revision;
    if (op === "exists") {
      if (item.value !== undefined) throw new TypeError(`${field}[${index}].value is not allowed for exists`);
    } else if (op === "in") {
      if (!Array.isArray(item.value) || item.value.length < 1 || item.value.length > 16) {
        throw new TypeError(`${field}[${index}].value must contain 1..=16 scalar values for in`);
      }
      requirement.value = item.value.map((next, valueIndex) => scalar(next, `${field}[${index}].value[${valueIndex}]`, 1_024));
    } else {
      requirement.value = scalar(item.value, `${field}[${index}].value`, 1_024);
      if (["gt", "gte", "lt", "lte"].includes(op) && typeof requirement.value !== "number") {
        throw new TypeError(`${field}[${index}].value must be numeric for ${op}`);
      }
    }
    if (allowRequired && item.required !== undefined) requirement.required = boolean(item.required, `${field}[${index}].required`);
    return requirement;
  });
}

function optionalAssessment(value: unknown): {
  rubric: string; rubricVersion: string; rationale: string; evaluatorType: string; evaluationDate: string;
} | undefined {
  if (value === undefined) return undefined;
  const item = record(value, "assessment");
  exactKeys(item, ["rubric", "rubricVersion", "rationale", "evaluatorType", "evaluationDate"], "assessment");
  return {
    rubric: toolkitKey(item.rubric, "assessment.rubric"),
    rubricVersion: printableString(item.rubricVersion, "assessment.rubricVersion", 64),
    rationale: printableString(item.rationale, "assessment.rationale", 8_192),
    evaluatorType: printableString(item.evaluatorType, "assessment.evaluatorType", 64),
    evaluationDate: date(item.evaluationDate, "assessment.evaluationDate"),
  };
}

function assertWriteResult(value: unknown, method: string): asserts value is Record<string, unknown> {
  if (!isRecord(value) || !REVISION_PATTERN.test(String(value.operation_hash ?? "")) ||
      value.status !== "APPLIED" || value.durable !== true || !isRecord(value.state)) {
    throw invalidNative(method);
  }
}

function bounded<T>(value: T): T {
  const encoded = Buffer.from(JSON.stringify(value), "utf8");
  if (encoded.length > MAX_HANDLER_OUTPUT_BYTES) {
    throw new Error(`Native toolkit result exceeds the ${MAX_HANDLER_OUTPUT_BYTES}-byte protocol output bound`);
  }
  return value;
}

function invalidNative(subject: string): Error {
  return new Error(`Native ${subject} response did not match the expected bounded contract`);
}

function record(value: unknown, field: string): Record<string, unknown> {
  if (!isRecord(value)) throw new TypeError(`${field} must be an object`);
  return value;
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[], field: string): void {
  const allowedSet = new Set(allowed);
  const unknown = Object.keys(value).find((key) => !allowedSet.has(key));
  if (unknown) throw new TypeError(`${field} contains unknown field ${unknown}`);
}

function optionalCommunity(value: unknown, fallback: string): string {
  return value === undefined ? fallback : communityId(value, "communityId");
}

function communityId(value: unknown, field: string): string {
  return printableString(value, field, 256);
}

function toolkitKey(value: unknown, field: string): string {
  const key = printableString(value, field, 128);
  if (!KEY_PATTERN.test(key)) throw new TypeError(`${field} contains unsupported characters`);
  return key;
}

function optionalRetryId(value: unknown, field: string, prefix: string): string {
  return value === undefined ? `${prefix}-${randomUUID()}` : toolkitKey(value, field);
}

function revision(value: unknown, field: string): string {
  if (typeof value !== "string" || !REVISION_PATTERN.test(value)) throw new TypeError(`${field} must be a 64-character hexadecimal revision`);
  return value;
}

function optionalRevision(value: unknown, field: string): string | undefined {
  return value === undefined ? undefined : revision(value, field);
}

function stringArray(
  value: unknown,
  field: string,
  min: number,
  max: number,
  validate: (value: unknown, field: string) => string,
): string[] {
  if (!Array.isArray(value) || value.length < min || value.length > max) {
    throw new TypeError(`${field} must contain ${min}..=${max} entries`);
  }
  const result = value.map((entry, index) => validate(entry, `${field}[${index}]`));
  if (new Set(result).size !== result.length) throw new TypeError(`${field} must not contain duplicates`);
  return result;
}

function scalar(value: unknown, field: string, maxStringBytes = 8_192): JsonScalar {
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError(`${field} must be finite`);
    return value;
  }
  if (typeof value === "boolean") return value;
  if (typeof value === "string") return printableString(value, field, maxStringBytes);
  throw new TypeError(`${field} must be a non-null JSON string, number, or boolean`);
}

function printableString(value: unknown, field: string, maxBytes: number): string {
  if (typeof value !== "string" || Buffer.byteLength(value, "utf8") < 1 || Buffer.byteLength(value, "utf8") > maxBytes || /\p{Cc}/u.test(value)) {
    throw new TypeError(`${field} must contain 1..=${maxBytes} non-control UTF-8 bytes`);
  }
  return value;
}

function optionalPrintableString(value: unknown, field: string, maxBytes: number): string | undefined {
  return value === undefined ? undefined : printableString(value, field, maxBytes);
}

function nullablePrintableString(value: unknown, field: string, maxBytes: number): string | null {
  return value === null ? null : printableString(value, field, maxBytes);
}

function optionalHomepage(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  const homepage = printableString(value, "homepage", 2_048);
  let parsed: URL;
  try { parsed = new URL(homepage); } catch { throw new TypeError("homepage must be an absolute HTTP(S) URL"); }
  if (!/^(https?):$/.test(parsed.protocol)) throw new TypeError("homepage must be an absolute HTTP(S) URL");
  return homepage;
}

function date(value: unknown, field: string): string {
  const result = printableString(value, field, 10);
  if (!DATE_PATTERN.test(result)) throw new TypeError(`${field} must use YYYY-MM-DD`);
  const [year, month, day] = result.split("-").map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  if (parsed.getUTCFullYear() !== year || parsed.getUTCMonth() !== month - 1 || parsed.getUTCDate() !== day) {
    throw new TypeError(`${field} must be a valid calendar date`);
  }
  return result;
}

function enumeration<T extends string>(value: unknown, field: string, values: readonly T[]): T {
  if (typeof value !== "string" || !values.includes(value as T)) throw new TypeError(`${field} must be one of ${values.join(", ")}`);
  return value as T;
}

function optionalInteger(value: unknown, fallback: number, min: number, max: number, field: string): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || (value as number) < min || (value as number) > max) {
    throw new TypeError(`${field} must be an integer from ${min} to ${max}`);
  }
  return value as number;
}

function boolean(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") throw new TypeError(`${field} must be boolean`);
  return value;
}

function optionalBoolean(value: unknown, fallback: boolean, field: string): boolean {
  return value === undefined ? fallback : boolean(value, field);
}

function compact<T extends Record<string, unknown>>(value: T): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, next]) => next !== undefined));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
