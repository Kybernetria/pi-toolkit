# pi-toolkit

Minimal handler-backed Pi package exposing the native community-stack toolkit through pi-protocol node `pi_toolkit`. It registers only protocol provides—no individual Pi tools—and uses only the authenticated local Unix socket API. It never opens SQLite, starts community-stack, invokes a shell, synchronizes files, or makes network connections.

## Requirements and setup

1. Build, initialize, register an **APP** capability, and run community-stack separately as documented by community-stack. Registration prints the bearer token once; keep it in the host's secret store and inject it into Pi's process environment rather than committing it to files.
2. Configure the Pi host process:

```text
COMMUNITY_STACK_APP_TOKEN=<required 64-hex APP token>
COMMUNITY_STACK_SOCKET=/home/kyvernitria/Applications/community-stack/data/community.sock
COMMUNITY_STACK_COMMUNITY_ID=research
```

`COMMUNITY_STACK_SOCKET` and `COMMUNITY_STACK_COMMUNITY_ID` show their defaults. The token has no default and is never declared in `pi.protocol.json`, accepted as capability input, returned, or logged. An optional `communityId` on each invocation overrides only the community ID.

3. Install dependencies and use Pi's one shared protocol runtime:

```bash
cd ~/.pi/agent/extensions/pi-toolkit
npm install
~/.pi/agent/npm/node_modules/.bin/pi-protocol-link-runtime
```

Because this directory is under `~/.pi/agent/extensions`, Pi auto-discovers it. Run `/reload` in an existing Pi session (or restart Pi). Ensure the separately managed community-stack service and socket are available before invoking a provide.

## Provides

- `pi_toolkit.schema` — `operation: "list"` lists at most 100 active concepts; `operation: "show"` resolves one exact key and optional immutable revision.
- `pi_toolkit.search` — submits `toolkit.query` across the whole bounded active catalog when `tools` is omitted or `[]`, or restricts the query to 1–64 unique tool keys. It requires 1–64 total `requirements`, `mandatory`, and `optional` entries; an empty query is invalid. `includePartial` maps to native `include_partial`.
- `pi_toolkit.add_tool` — submits one `toolkit.tool.add`. Supply `idempotencyKey` for retries or retain the generated key returned by the handler.
- `pi_toolkit.propose_assertion` — submits `toolkit.assert`; trusted code always injects `origin: "ai"` and `verification_state: "proposed"`. Callers cannot provide either field. Optional complete `assessment` metadata supports native dimension assertions.
- `pi_toolkit.list_tools` — calls native `toolkit.export` for an explicit catalog page. `offset` defaults to `0` (maximum `100000`) and `limit` defaults to `100` (maximum `500`). It returns only `{communityId, offset, limit, tools, hasMoreHint}`; concepts, assertions, and reviews from the native export envelope are validated but never exposed. `hasMoreHint` is true exactly when `tools.length === limit`.

Use `list_tools` for catalog discovery instead of submitting an empty `search`. All handlers reject unknown fields and enforce practical bounds before IPC. The socket client uses one request per connection, 4-byte big-endian JSON framing, a 1 MiB request bound, a 4 MiB response-frame bound, a 5-second timeout, invocation cancellation, and a 1 MiB protocol output bound. Native API errors retain `code`, `message`, and `retryable` on `CommunityStackApiError`.

### Tool listing example

```json
{
  "target": "pi_toolkit.list_tools",
  "input": {
    "communityId": "research",
    "offset": 0,
    "limit": 100
  }
}
```

### Search example

```json
{
  "target": "pi_toolkit.search",
  "input": {
    "communityId": "research",
    "tools": ["p2panda", "reticulum"],
    "includePartial": true,
    "mandatory": [
      { "concept": "cap.sync.peer-to-peer", "op": "eq", "value": true }
    ],
    "optional": [
      { "concept": "dimension.sync.transport-agnosticism", "op": "gte", "value": 8 }
    ]
  }
}
```

### Assertion proposal example

```json
{
  "target": "pi_toolkit.propose_assertion",
  "input": {
    "assertionId": "assessment-p2panda-2026-07-26",
    "idempotencyKey": "assessment-p2panda-2026-07-26-command",
    "tool": "p2panda",
    "concept": "dimension.sync.transport-agnosticism",
    "value": 8,
    "source": "https://example.test/source",
    "evidence": "Bounded evidence for review.",
    "asOf": "2026-07-26",
    "assessment": {
      "rubric": "transport-agnosticism",
      "rubricVersion": "1",
      "rationale": "Evidence maps to rubric anchor eight.",
      "evaluatorType": "ai",
      "evaluationDate": "2026-07-26"
    }
  }
}
```

Caller-supplied IDs make a timeout/disconnection retry exact. If IDs are omitted, generated IDs are returned, but an interrupted caller that never receives them cannot safely reconstruct that write and should inspect before attempting a new intent.

## Development

```bash
npm run typecheck
npm test
# or both
npm run check
```

Tests use a fake local Unix socket and cover framing, translation, explicit tool listing and export-envelope filtering, non-empty search enforcement, host-only authentication, proposed-state enforcement, retry IDs, native errors, bounds, timeout/cancellation, and secret redaction.
