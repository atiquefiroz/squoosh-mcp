# MCP conventions for an npx-run, local image-optimisation server (verified 2026-11-02)

Scope: open-source TypeScript MCP server, published to npm, run with `npx`, batch-optimises images on local disk.
Every claim below was checked against the source cited next to it on 2026-11-02 unless it sits under "Not verified" (section 8).
Code marked **sketch** is written by me from the docs and has not been compiled.

---

## 0. What this means for our server (decisions)

| # | Decision | Recommendation | Why (source) |
|---|---|---|---|
| D1 | SDK generation | **v2: `@modelcontextprotocol/server` 2.4.0 + `zod` ^4.2** (Node >= 20). Not `@modelcontextprotocol/sdk` 1.x. | v2 is "the stable release line", implements spec 2026-07-28, released 2026-07-27; v1 only gets fixes for >= 6 months after that (TS SDK README). Official filesystem server already moved to v2 (npm `@modelcontextprotocol/server-filesystem` 2.1.0). Claude Code's default client runtime is SDK v2 (Claude Code MCP docs). |
| D2 | Stdio entry | `serveStdio(factory)` from `@modelcontextprotocol/server/stdio`; keep default `legacy: 'serve'` so 2025-era clients (Claude Desktop, Cursor, VS Code, Codex…) still work. | serveStdio serves both eras from one factory (SDK docs `serving/stdio.md`, `serving/legacy-clients.md`). |
| D3 | Directory access | **Allowed directories as positional CLI args** (repeatable), like the official filesystem server. Do not rely on Roots. Optional: when no args, fall back to `CLAUDE_PROJECT_DIR` (Claude Code sets it), else refuse every call with a clear error. | Roots are **deprecated** in 2026-07-28 (SEP-2577), migration path is "tool parameters, resource URIs, or server configuration" (spec deprecated registry). |
| D4 | Tool count | 3-5 tools: `list_allowed_directories` (optional), `scan_images`, `optimize_images`, `get_job_status`, `cancel_job`. | Anthropic: few, consolidated, high-impact tools; prefer search/filter over list-all (Anthropic "Writing effective tools for agents"). |
| D5 | Overwrite originals | **MVP writes new files only** (output dir or suffix), so `optimize_images` can be `destructiveHint:false, idempotentHint:true`. Overwrite = later step (separate tool or explicit flag + `destructiveHint:true`). | Annotations are static per tool; spec default `destructiveHint` is `true` if unset (schema.ts). Claude Code repeats idempotent calls after a dropped connection and runs `readOnlyHint` tools in parallel (Claude Code docs). VS Code skips confirmation only for `readOnlyHint` tools (VS Code MCP dev guide). |
| D6 | Long batches | **Hybrid "work up to a time budget, then hand back a job handle"**: `optimize_images` processes for <= ~45 s with progress notifications; if not done it returns `status:"running"` + `jobId` and keeps working; `get_job_status(jobId, waitSeconds, offset, limit)` long-polls; `cancel_job(jobId)`. Jobs live in memory for the server process lifetime (say so in the description). Tasks extension = later step. | Codex default tool timeout 60 s; Claude Desktop timeout undocumented, user reports ~60 s-4 min; Claude Code tolerates long calls. Spec "Stateful Tools" section recommends server-minted handles passed as tool args. SDK v2 has no documented server-side Tasks helper. |
| D7 | Responses | Concise by default: totals + top-N files; `response_format: "concise" \| "detailed"`; paginate per-file results via `offset/limit`; `outputSchema` + small `structuredContent`; never return image bytes unless `preview:true`. | Anthropic tool post; Claude Code warns at 10k tokens, caps at 25k tokens, and image data counts against `MAX_MCP_OUTPUT_TOKENS` (Claude Code docs). |
| D8 | Errors | Return `isError: true` with a fix hint (e.g. "path is outside allowed dirs: <list>"). Throwing also becomes `isError` in v2. | Spec tools "Error Handling"; SDK `servers/errors.md`. |
| D9 | Distribution | Phase 1: npm (`bin` + shebang) + official MCP Registry (`mcpName`, `server.json`, `mcp-publisher`, GitHub OIDC in CI). Phase 2: `.mcpb` bundle for Claude Desktop, only if codecs are WASM (portable) or we build per-platform bundles. | Registry quickstart; MCPB README. |
| D10 | Package name | `squoosh-mcp` is unclaimed on npm today (`npm view` → 404). Registry name would be `io.github.<user>/squoosh-mcp`. | npm registry check 2026-11-02. ("Squoosh" is a Google project name; worth a quick naming/trademark check.) |

---

## 1. Spec: latest version and what changed

**Latest revision: `2026-07-28`** (spec home page links `schema/2026-07-28/schema.ts`; changelog "since the previous revision, 2025-11-25").
Source: https://modelcontextprotocol.io/specification/latest , https://modelcontextprotocol.io/specification/2026-07-28/changelog

### 1.1 Changes that matter to a stdio tool server

| Revision | Change | Impact on us |
|---|---|---|
| **2026-07-28** | **Stateless protocol**: no `initialize` handshake; every request carries protocol version + client capabilities in `_meta`; new required `server/discover` RPC (SEP-2575). | SDK v2 handles this. Never keep per-connection state that a tool depends on; use explicit handles. |
| 2026-07-28 | Protocol-level sessions removed; "Servers that need cross-call state use explicit, server-minted handles passed as ordinary tool arguments" (SEP-2567). Spec adds a non-normative "Stateful Tools" section (handles: opaque, UUIDv4-level entropy, bounded lifetime stated in the tool description, expiry returns a tool error). | This is exactly the `jobId` pattern (D6). |
| 2026-07-28 | **Multi Round-Trip Requests (MRTR)** replace server-to-client requests (`elicitation/create`, `sampling/createMessage`, `roots/list`): handler returns `resultType:"input_required"` with `inputRequests`; client retries with `inputResponses` (SEP-2322). All results carry `resultType`. | If we ever ask the user to confirm (e.g. overwrite), v2 needs `inputRequired(...)` on modern connections and `ctx.mcpReq.elicitInput` on legacy ones. Avoid in MVP. |
| 2026-07-28 | **Tasks moved out of core** into the official extension `io.modelcontextprotocol/tasks`: `tasks/get` polling, `tasks/update`, `tasks/cancel`; no `tasks/result`/`tasks/list`; server may return a task handle unsolicited if the client declared the extension (SEP-2663). | Optional later step (section 6). |
| 2026-07-28 | **Deprecated**: Roots, Sampling, Logging (SEP-2577); earliest removal "first revision released on or after 2027-07-28". Migration: paths via tool params/config; log to `stderr`. | Allowed dirs via CLI args (D3). Log to stderr only. |
| 2026-07-28 | `ping`, `logging/setLevel`, `notifications/roots/list_changed` removed. Log level per request; "servers MUST NOT emit `notifications/message` for requests that did not include this field". | Don't use MCP logging. |
| 2026-07-28 | `inputSchema`/`outputSchema` may use any JSON Schema 2020-12 keywords; `structuredContent` may be any JSON value (SEP-2106). | Zod 4 → JSON Schema is fine. |
| 2026-07-28 | Servers SHOULD return `tools/list` in deterministic order (prompt-cache friendly). | Register tools in a fixed order. |
| 2026-07-28 | Cancellation on stdio: client MUST send `notifications/cancelled`; on Streamable HTTP closing the stream is the cancel. Servers MUST NOT send `notifications/cancelled` except to end a `subscriptions/listen`. | SDK surfaces both as `ctx.mcpReq.signal`. |
| 2025-11-25 | Tool-name guidance (SEP-986): 1-128 chars, case-sensitive, only `A-Z a-z 0-9 _ - .`, no spaces. Icons on tools/servers (SEP-973). JSON Schema 2020-12 default dialect. **Input validation errors are tool execution errors (`isError`), not protocol errors** (SEP-1303). Experimental tasks (since moved). URL-mode elicitation. | Use snake_case names; validation errors go back to the model. |
| 2025-06-18 | **Structured tool output** (`outputSchema` + `structuredContent`), **`resource_link` content**, **elicitation**, `title` fields, JSON-RPC batching removed. | Basis for D7. |

Sources: changelogs for 2026-07-28, 2025-11-25, 2025-06-18 at `https://modelcontextprotocol.io/specification/<rev>/changelog`; deprecated registry https://modelcontextprotocol.io/specification/2026-07-28/deprecated ; tools page https://modelcontextprotocol.io/specification/2026-07-28/server/tools ; cancellation https://modelcontextprotocol.io/specification/2026-07-28/basic/utilities/cancellation

### 1.2 Feature details

**Tool annotations** (`ToolAnnotations` in `schema/2026-07-28/schema.ts`, unchanged in shape):

| Field | Meaning | Default |
|---|---|---|
| `title` | display name | - |
| `readOnlyHint` | does not modify its environment | `false` |
| `destructiveHint` | may perform destructive updates (only meaningful if `readOnlyHint == false`) | `true` |
| `idempotentHint` | repeat call with same args has no extra effect (only if `readOnlyHint == false`) | `false` |
| `openWorldHint` | interacts with external entities | `true` |

"Clients MUST consider tool annotations to be untrusted unless they come from trusted servers." Set `openWorldHint:false` for a local-disk tool (the official filesystem server does this for every tool).

**Structured output**: `outputSchema` optional; if present "Servers MUST provide structured results that conform to this schema"; "For backwards compatibility, a tool that returns structured content SHOULD also return the serialized JSON in a TextContent block." → keep `structuredContent` small so the duplicate text block is cheap.

**Content blocks**: `text`, `image` (`data` base64 + `mimeType`, optional `annotations.audience/priority`), `audio`, `resource_link` (`uri`, `name`, `description`, `mimeType`; "not guaranteed to appear in the results of a `resources/list`"), embedded `resource` (servers using it SHOULD implement the `resources` capability).

**Progress** (`/basic/utilities/progress`): client puts `progressToken` in request `_meta`; server MAY send `notifications/progress {progressToken, progress, total?, message?}`; `progress` MUST increase every time; floats allowed; "Both parties SHOULD implement rate limiting to prevent flooding"; notifications MUST stop after completion.

**Timeouts** (cancellation page): senders SHOULD set timeouts; MAY reset the clock on progress; SHOULD always enforce a maximum timeout.

**Errors**: protocol errors (unknown tool, malformed request) vs tool execution errors (`isError: true`, "actionable feedback that language models can use to self-correct"). Clients SHOULD pass tool errors to the model.

**Server MUSTs** (tools "Security Considerations"): validate all tool inputs, implement access controls, rate-limit invocations, sanitise outputs.

---

## 2. TypeScript SDK

### 2.1 Versions (from `npm view`, 2026-11-02)

| Package | Latest | Released | Notes |
|---|---|---|---|
| `@modelcontextprotocol/server` (v2) | **2.4.0** | 2026-10-23 | deps `zod ^4.2.0`, `@modelcontextprotocol/core 2.4.0`; `engines.node >=20`; exports `.`, `./stdio`, `./validators/ajv`, `./validators/cf-worker`, `./ext/skills`. ESM + CJS builds. |
| `@modelcontextprotocol/client` (v2) | 2.4.0 | 2026-10-23 | for tests (in-memory client) |
| `@modelcontextprotocol/sdk` (v1) | 1.32.2 | 2026-10-23 | `zod ^3.25 \|\| ^4.0` (peer, required); `engines.node >=18`; has `./experimental/tasks` (old 2025-11-25 tasks). Legacy line. |
| `@modelcontextprotocol/ext-tasks` | 0.2.2 | 2026-09-30 | requester (client) side + 2025-11-25 receiver; no server-side "return a task" helper documented. |

`npm view @modelcontextprotocol/sdk version time --json` → `"version": "1.32.2"`; v2 first stable `2.0.0` on 2026-07-27.

README (main branch): "**This is the `main` branch: v2 of the SDK** (`@modelcontextprotocol/server`, `@modelcontextprotocol/client`), the stable release line, implementing the 2026-07-28 MCP spec … **v1.x** (`@modelcontextprotocol/sdk`) … continues to receive bug fixes and security updates for at least six months after the v2 release (2026-07-27)."

**Zod**: v2 "Tool and prompt schemas use Standard Schema — bring Zod v4, Valibot, ArkType, or any compatible library." Examples import `import * as z from 'zod/v4'`. Pass a schema object (`z.object({...})`); "Raw shapes (`inputSchema: { name: z.string() }`) are deprecated". v2 depends on `zod ^4.2.0`, so zod 3 projects get a nested copy (upgrade guide). → **Use zod 4.**

### 2.2 Official minimal example (verbatim, TS SDK README "Getting Started")

```typescript
import { McpServer } from '@modelcontextprotocol/server';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import * as z from 'zod/v4';

const server = new McpServer({ name: 'greeting-server', version: '1.0.0' });

server.registerTool(
    'greet',
    {
        description: 'Greet someone by name',
        inputSchema: z.object({ name: z.string() })
    },
    async ({ name }) => ({
        content: [{ type: 'text', text: `Hello, ${name}!` }]
    })
);

async function main() {
    const transport = new StdioServerTransport();
    await server.connect(transport);
}

main();
```

The SDK's own guides now prefer the factory entry (verbatim, `docs/serving/stdio.md`):

```ts
import { McpServer } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';

const handle = serveStdio(() => {
    const server = new McpServer({ name: 'notes', version: '1.0.0' });
    // server.registerTool(...) — one factory builds the instance that serves the connection
    return server;
});
```

`serveStdio` options (from `dist/stdio.d.mts`): `legacy?: 'serve' | 'reject'` (default `'serve'`), `transport?`, `onerror?`, `maxSubscriptions?`. The factory receives `{ era }` (`'legacy' | 'modern'`). Returns a handle with `close()`. stdin EOF tears down the connection; in-flight handlers are aborted (`ctx.mcpReq.signal` fires).

**stdout is the protocol channel — log with `console.error` only** (stdio guide).

### 2.3 Registering tools (v2 API, verified in docs + `.d.mts`)

`registerTool(name, config, handler)`; config fields: `title`, `description`, `inputSchema`, `outputSchema`, `annotations`, `icons`, `_meta`. Handler `(args, ctx)`.

- Argument validation happens before the handler; failures come back as `isError: true` "Input validation error: …".
- `outputSchema` → SDK validates `structuredContent` before sending; skipped on `isError` results.
- Thrown errors in tool handlers become `isError: true` with the message as text.
- v2 behaviour change: unknown tool now rejects with `-32602` (protocol error), not an `isError` result.
- `new McpServer(info, { maxToolInputElements: 10_000 })` caps array/object element counts in arguments (off by default) — useful against huge `files` arrays.
- `_meta` on the tool lets us set Claude Code hints: `"anthropic/maxResultSizeChars"` (raise the 50k-char persist-to-file threshold, ceiling 500k) and `"anthropic/requiresUserInteraction": true` (always prompt).

### 2.4 Progress and cancellation (verbatim pattern, `docs/servers/logging-progress-cancellation.md`)

```ts
server.registerTool(
    'process-files',
    {
        description: 'Process files with progress updates',
        inputSchema: z.object({ files: z.array(z.string()) })
    },
    async ({ files }, ctx) => {
        const progressToken = ctx.mcpReq._meta?.progressToken;

        for (let i = 0; i < files.length; i++) {
            // ... process files[i] ...

            if (progressToken !== undefined) {
                await ctx.mcpReq.notify({
                    method: 'notifications/progress',
                    params: { progressToken, progress: i + 1, total: files.length, message: `Processed ${files[i]}` }
                });
            }
        }

        return { content: [{ type: 'text', text: `Processed ${files.length} files` }] };
    }
);
```

Cancellation: "`ctx.mcpReq.signal` is an `AbortSignal`. The SDK aborts it when the client sends `notifications/cancelled` for the request, and when the connection closes — check it before each unit of work." "Hand the same signal to `fetch` — or any API that accepts an `AbortSignal`". "The SDK never sends a response for a cancelled request and discards whatever the handler still returns."

v1 equivalent (for reference only): handler `(args, extra)` with `extra.signal`, `extra.sendNotification(...)`, `extra._meta?.progressToken` (verified in `@modelcontextprotocol/sdk@1.32.2` `RequestHandlerExtra`); transport `new StdioServerTransport()` from `@modelcontextprotocol/sdk/server/stdio.js`; `inputSchema` as a raw zod shape.

### 2.5 Sketch: our server skeleton (not compiled)

```ts
#!/usr/bin/env node
// src/index.ts  (sketch)
import { McpServer } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import * as z from 'zod/v4';
import { resolveAllowedDirs, assertInsideAllowed } from './paths.js';   // see section 5.3
import { jobs } from './jobs.js';                                        // in-memory job store

const allowed = await resolveAllowedDirs(process.argv.slice(2), process.env.CLAUDE_PROJECT_DIR);

const ResultItem = z.object({
  input: z.string(), output: z.string(), format: z.string(),
  bytesBefore: z.number(), bytesAfter: z.number(), error: z.string().optional(),
});
const JobView = z.object({
  jobId: z.string(), status: z.enum(['running', 'completed', 'cancelled', 'failed']),
  done: z.number(), total: z.number(), bytesSaved: z.number(),
  items: z.array(ResultItem), nextOffset: z.number().optional(),
});

function createServer() {
  const server = new McpServer({ name: 'squoosh-mcp', version: '0.1.0' }, { maxToolInputElements: 10_000 });

  server.registerTool('optimize_images', {
    title: 'Optimise images',
    description:
      'Compress/convert images under the allowed directories. Writes NEW files (never overwrites originals). ' +
      'Works for up to ~45 s; if the batch is not finished it returns status "running" and a jobId — ' +
      'call get_job_status with that jobId to wait for the rest. Jobs are kept in memory until the server exits.',
    inputSchema: z.object({
      paths: z.array(z.string()).min(1).describe('Files, directories or globs inside the allowed directories'),
      format: z.enum(['webp', 'avif', 'jpeg', 'png', 'keep']).default('webp'),
      quality: z.number().int().min(1).max(100).optional().describe('Encoder quality; omit for a sensible default'),
      maxWidth: z.number().int().positive().optional(),
      outputDir: z.string().optional().describe('Defaults to writing next to the source with a suffix'),
      dryRun: z.boolean().default(false),
      response_format: z.enum(['concise', 'detailed']).default('concise'),
    }),
    outputSchema: JobView,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async (args, ctx) => {
    const job = jobs.start(args, allowed);                 // validates every path first; throws => isError
    const token = ctx.mcpReq._meta?.progressToken;
    ctx.mcpReq.signal.addEventListener('abort', () => job.cancel('client cancelled'));
    let last = 0;
    job.onProgress(async (done, total, file) => {
      if (token === undefined || Date.now() - last < 250) return;   // rate-limit progress
      last = Date.now();
      await ctx.mcpReq.notify({ method: 'notifications/progress',
        params: { progressToken: token, progress: done, total, message: `Optimised ${file}` } });
    });
    const view = await job.waitFor(45_000, { offset: 0, limit: args.response_format === 'concise' ? 20 : 200 });
    return { content: [{ type: 'text', text: JSON.stringify(view) }], structuredContent: view };
  });

  // get_job_status: readOnlyHint true; args { jobId, waitSeconds (0-45), offset, limit }
  // cancel_job:     readOnlyHint false, destructiveHint false, idempotentHint true
  // scan_images:    readOnlyHint true; counts/sizes/formats + estimated savings on a sample
  return server;
}

serveStdio(createServer);
console.error(`squoosh-mcp: serving on stdio; allowed dirs: ${allowed.join(', ')}`);
```

Note on the abort listener: once `optimize_images` returns with a running job, the request's signal no longer governs the job; `cancel_job` must abort the job's own `AbortController`.

### 2.6 Testing

`npx @modelcontextprotocol/inspector node ./build/server.js` (SDK stdio guide). In-memory `Client` from `@modelcontextprotocol/client` for unit tests (`docs/testing.md`).

---

## 3. Publishing

### 3.1 npm package conventions

Verified facts:
- npm: "make sure that your file(s) referenced in `bin` starts with `#!/usr/bin/env node`" (npm package.json docs).
- npx picks the command automatically if the package has **one** `bin` entry (or one matching the unscoped name) (npm `npx` docs).
- `npx` prompts before installing; "Suppress this prompt with the `-y` or `--yes` option" — that is why every MCP snippet uses `npx -y`.
- SDK v2 needs Node >= 20; the official filesystem server sets `"engines": {"node": ">=24"}`, `"type": "module"`, `"files": ["dist"]`, build `tsc && shx chmod +x dist/*.js`, and `mcpName`.
- MCP local-security guide tells users to **pin versions** (`npx` pins only the top-level package). Show pinned versions in README snippets (e.g. `squoosh-mcp@1.2.3`) or at least mention it.

Sketch `package.json`:

```json
{
  "name": "squoosh-mcp",
  "version": "0.1.0",
  "description": "MCP server that batch-optimises local images (WebP/AVIF/JPEG/PNG)",
  "mcpName": "io.github.<github-user>/squoosh-mcp",
  "type": "module",
  "bin": { "squoosh-mcp": "dist/index.js" },
  "files": ["dist"],
  "engines": { "node": ">=20" },
  "scripts": {
    "build": "tsc && shx chmod +x dist/*.js",
    "prepublishOnly": "npm run build"
  },
  "dependencies": { "@modelcontextprotocol/server": "^2.4.0", "zod": "^4.2.0" },
  "devDependencies": { "@modelcontextprotocol/client": "^2.4.0", "typescript": "^5", "shx": "^0.4.0" },
  "repository": { "type": "git", "url": "https://github.com/<github-user>/squoosh-mcp.git" },
  "license": "MIT"
}
```

Run: `npx -y squoosh-mcp /abs/path/to/images [/another/dir ...]`

### 3.2 Official MCP Registry (registry.modelcontextprotocol.io)

Status: "The MCP Registry is currently in preview. Breaking changes or data resets may occur before general availability." It hosts **metadata only**; the package must already be on npm. Latest `mcp-publisher` release: v1.8.7 (2026-10-30).

Steps (registry quickstart):
1. Add `"mcpName": "io.github.<user>/<server>"` to `package.json`. With GitHub auth, the name **must** start with `io.github.<user>/`. `server.json` `name` **must equal** `mcpName` (this is the ownership check for npm).
2. `npm publish --access public`.
3. Install `mcp-publisher` (`brew install mcp-publisher` or release binary).
4. `mcp-publisher init` → edit `server.json`.
5. `mcp-publisher login github` (device flow) — or `login dns --domain example.com` for a custom namespace like `com.example/...`.
6. `mcp-publisher publish`; verify with `curl "https://registry.modelcontextprotocol.io/v0.1/servers?search=io.github.<user>/squoosh-mcp"`.

Constraints (draft schema + official-registry requirements): `name` pattern `^[a-zA-Z0-9.-]+/[a-zA-Z0-9._-]+$` (one slash, max 200); `description` max **100** chars; `version` must be exact (ranges rejected); npm packages only from `https://registry.npmjs.org`; `_meta` only keeps `io.modelcontextprotocol.registry/publisher-provided` (<= 4 KB); MCPB packages only from GitHub/GitLab releases. Current schema URL: `https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json`.

Sketch `server.json` (repeatable positional dir arg modelled on the registry's own filesystem example):

```json
{
  "$schema": "https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json",
  "name": "io.github.<github-user>/squoosh-mcp",
  "title": "Squoosh image optimiser",
  "description": "Batch-optimise local images (WebP, AVIF, JPEG, PNG) inside directories you allow.",
  "repository": { "url": "https://github.com/<github-user>/squoosh-mcp", "source": "github" },
  "version": "0.1.0",
  "packages": [
    {
      "registryType": "npm",
      "registryBaseUrl": "https://registry.npmjs.org",
      "identifier": "squoosh-mcp",
      "version": "0.1.0",
      "runtimeHint": "npx",
      "transport": { "type": "stdio" },
      "packageArguments": [
        {
          "type": "positional",
          "valueHint": "target_dir",
          "description": "Directory the server may read and write images in",
          "isRequired": true,
          "isRepeated": true
        }
      ]
    }
  ]
}
```

CI: GitHub Actions with OIDC is the recommended auth — `permissions: id-token: write`, then `./mcp-publisher login github-oidc` and `./mcp-publisher publish` (registry GitHub Actions guide). Bump `package.json`, `server.json.version` and `packages[0].version` together.

### 3.3 MCPB bundles (formerly DXT) — worth it?

Facts (github.com/modelcontextprotocol/mcpb README + MANIFEST.md):
- `.mcpb` = zip of the server + `manifest.json` (current manifest spec `0.3`; `0.4` adds a `uv` Python type). CLI: `npm install -g @anthropic-ai/mcpb` (latest 2.1.2), `mcpb init`, `mcpb pack`.
- "Node.js ships with Claude for macOS and Windows" → users need no Node install. Must bundle the whole `node_modules`.
- `user_config` supports `"type": "directory", "multiple": true` → a native folder picker, passed to the server via `${user_config.allowed_directories}` in `mcp_config.args`/`env`. Fits our allowed-dirs model exactly.
- Install: Claude Desktop → Settings → Extensions → Advanced settings → Install Extension…; directory listing via an interest form; directory extensions auto-update, privately shared ones do not (Claude Help Center).
- The MCP Registry accepts MCPB packages hosted on GitHub/GitLab releases.

Verdict: **worth doing as phase 2** — Claude Desktop is the client where `npx` + JSON editing hurts most, and the directory picker removes the "absolute path in JSON" problem. Cost depends on the codec stack: WASM codecs (Squoosh/jSquash style) give one portable bundle; `sharp` (native libvips) needs per-platform builds (`compatibility.platforms`). Not needed for the npm/registry launch.

---

## 4. Install snippets users expect

Replace `/abs/path/to/images` with real absolute paths. Pinning a version (`squoosh-mcp@0.1.0`) is safer than unpinned.

### Claude Code (code.claude.com/docs/en/mcp)
```bash
# local scope (default), current project only
claude mcp add squoosh -- npx -y squoosh-mcp /abs/path/to/images
# all projects
claude mcp add --scope user squoosh -- npx -y squoosh-mcp /abs/path/to/images
# from JSON
claude mcp add-json squoosh '{"command":"npx","args":["-y","squoosh-mcp","/abs/path/to/images"]}'
```
- Everything after `--` is the server command. `--env KEY=value` goes after the name and before `--`.
- Team-shared: `.mcp.json` at repo root (`--scope project`), shape `{"mcpServers": {"squoosh": {"command": "npx", "args": [...], "timeout": 600000}}}`. Per-server `timeout` (ms) is a hard wall-clock limit.
- Claude Code sets `CLAUDE_PROJECT_DIR` in the server's environment (project root) and answers `roots/list` (legacy era) with launch dir + `--add-dir` dirs.

### Claude Desktop (modelcontextprotocol.io "Connect to local MCP servers")
File: macOS `~/Library/Application Support/Claude/claude_desktop_config.json`; Windows `%APPDATA%\Claude\claude_desktop_config.json`; Linux `~/.config/Claude/claude_desktop_config.json` (Settings → Developer → Edit Config). Paths must be absolute.
```json
{
  "mcpServers": {
    "squoosh": {
      "command": "npx",
      "args": ["-y", "squoosh-mcp", "/Users/username/Pictures/site-images"]
    }
  }
}
```
Logs: macOS `~/Library/Logs/Claude/mcp*.log`, Windows `%APPDATA%\Claude\logs`.

### Cursor (cursor.com/docs/mcp)
Project `.cursor/mcp.json` or global `~/.cursor/mcp.json`; interpolation `${workspaceFolder}`, `${userHome}`, `${env:NAME}` supported.
```json
{
  "mcpServers": {
    "squoosh": {
      "command": "npx",
      "args": ["-y", "squoosh-mcp", "${workspaceFolder}"]
    }
  }
}
```
Cursor lists Tools, Prompts, Resources, Roots, Elicitation, Apps as supported; returned images are attached to chat.

### VS Code (code.visualstudio.com/docs/agents/reference/mcp-configuration, updated 2026-10-28)
`.vscode/mcp.json` — top-level key is **`servers`**, not `mcpServers`; `cwd` defaults to the workspace folder.
```json
{
  "servers": {
    "squoosh": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "squoosh-mcp", "."]
    }
  }
}
```
CLI (adds to user profile): `code --add-mcp '{"name":"squoosh","type":"stdio","command":"npx","args":["-y","squoosh-mcp","/abs/path/to/images"]}'`
README install button: `vscode:mcp/install?${encodeURIComponent(JSON.stringify(obj))}` (Insiders: `vscode-insiders:`), where `obj` is the `--add-mcp` object (VS Code MCP developer guide). VS Code: "doesn't ask for confirmation to run read-only tools" (`readOnlyHint`). Optional sandboxing for stdio servers on macOS/Linux.

### Codex CLI (learn.chatgpt.com/docs/extend/mcp?surface=cli)
```bash
codex mcp add squoosh -- npx -y squoosh-mcp /abs/path/to/images
```
`~/.codex/config.toml` (or project `.codex/config.toml`, trusted projects only):
```toml
[mcp_servers.squoosh]
command = "npx"
args = ["-y", "squoosh-mcp", "/abs/path/to/images"]
startup_timeout_sec = 20   # default 10; npx first download can be slow
tool_timeout_sec = 600     # default 60
```

### Windsurf / Devin Desktop
`docs.windsurf.com/windsurf/cascade/mcp` now redirects to Devin Desktop docs. Legacy Windsurf reads `~/.codeium/windsurf/mcp_config.json` (stable channel, per Devin's config-import page); Devin Desktop/CLI uses `~/.config/devin/mcp_config.json` (user), `.devin/mcp_config.json` (project), or `devin mcp add squoosh -- npx -y squoosh-mcp /abs/path`. Same `mcpServers` / `command` / `args` shape as Claude Desktop.

---

## 5. Tool design guidance for agents

### 5.1 Anthropic, "Writing effective tools for agents — with agents" (Ken Aizawa, 2025-09-11)
https://www.anthropic.com/engineering/writing-tools-for-agents
- Fewer, well-designed tools for high-impact workflows; consolidate multi-step operations; don't just wrap endpoints; each tool needs a distinct purpose; prefer search/filter over list-everything.
- Namespacing: shared prefixes by service/resource; test prefix vs suffix with the target model.
- Return high-signal context; natural-language identifiers over opaque IDs; add a `response_format` enum (`concise`/`detailed`).
- Token efficiency: pagination, range selection, filtering, truncation with sensible defaults; when truncating, tell the agent how to narrow the query. Notes Claude Code's 25,000-token default cap.
- Errors: say what went wrong and how to fix it (example of correct input), no raw tracebacks.
- Descriptions: write like onboarding a new hire; unambiguous parameter names (`user_id` not `user`); strict input/output models; use annotations for destructive/open-world.
- Evaluate with realistic multi-call tasks; read transcripts; let agents propose tool fixes.

### 5.2 MCP + client specifics that change our design
- Names: spec allows `A-Z a-z 0-9 _ - .`; Claude Code drops tools whose full name `mcp__<server>__<tool>` exceeds 128 chars. Use short snake_case (`optimize_images`), no dots (see section 8).
- Claude Code output limits: warning at 10k tokens, default cap 25k (`MAX_MCP_OUTPUT_TOKENS`); text results > 50k chars are saved to a file unless the tool sets `_meta["anthropic/maxResultSizeChars"]`; image data always counts against the token cap. Returned PNG/JPEG/GIF/WebP images are shown inline (possibly downscaled) and saved to the session's `tool-results` dir.
- Claude Code runs `readOnlyHint` tools in parallel and may retry `idempotentHint`/`readOnlyHint` calls after a dropped HTTP connection.
- Deterministic `tools/list` order (2026-07-28 SHOULD).
- Keep JSON in `structuredContent` and its text copy small; long per-file lists go behind `offset/limit`.
- Image content blocks: only for an explicit `preview` (a small thumbnail/before-after), never by default.
- `resource_link` with `file://` URIs is allowed, but clients may try `resources/read` on it; without a `resources` capability that fails. Plain absolute paths in the result are simpler for the MVP.

### 5.3 Filesystem security
- **Roots**: deprecated (2026-07-28). Still answered by Claude Code and Cursor on 2025-era connections; on 2026-07-28 only through MRTR `input_required`. The official filesystem server: CLI dirs are the allow-list; legacy Roots, when supported, replace them; with none it refuses calls with an error that says how to fix it.
- MCP "Local Server Security" guide: "Grant the narrowest root that works … passed explicitly through the server's configuration or tool parameters — never your home directory." Allowlists are "cooperative boundaries"; real isolation is a sandbox/container.
- Path checks to copy from `modelcontextprotocol/servers/src/filesystem/path-validation.ts`: reject null bytes; `path.resolve(path.normalize(p))`; must be absolute; containment check uses `dir + path.sep` prefix (not bare `startsWith(dir)`), special-case root and Windows drive roots; resolve symlinks (`realpath`) on both the allowed dirs and the target so a symlink inside an allowed dir that points outside is refused; validate the **output** path too (and its parent for new files).
- Hard links: path-based checks can't see other names of the same inode; for us, never write in place in the MVP (D5).
- Resource limits (spec says servers MUST rate-limit; our own guards): max files per call, max input bytes, max pixel count (decompression bombs), glob depth limit, worker pool size ≈ CPU cores − 1, per-image timeout, honour `AbortSignal` between images.
- Never print secrets/env to results; log to stderr.

---

## 6. Long-running batches (hundreds of images)

### 6.1 Client timeouts

| Client | Tool-call timeout | Progress resets it? | Source |
|---|---|---|---|
| Claude Code (CLI) | Wall clock: per-server `timeout` (ms) or `MCP_TOOL_TIMEOUT`; unset ≈ **28 h**. Idle timeout: **30 min for stdio** (5 min HTTP), `CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT`. Calls > 2 min auto-move to a background task (`/tasks` shows latest progress). | Wall clock: **no**. Idle: **yes** (no response and no progress for the window aborts). | code.claude.com/docs/en/mcp "Time limits on MCP tool calls" |
| Claude Desktop | **Undocumented.** User reports: ~60 s (Claude Code desktop app, issue #63379, closed 2026-07-13); ~4 min on Windows (issue #65643, open); feature request to make it configurable (#22542, closed). | Unknown | github.com/anthropics/claude-code issues |
| Codex CLI | `tool_timeout_sec` default **60**; `startup_timeout_sec` default 10. | Not stated | learn.chatgpt.com/docs/extend/mcp |
| VS Code, Cursor, Windsurf/Devin | Not stated in the docs I read | - | - |
| Spec | SHOULD set timeouts; MAY reset on progress; SHOULD enforce a maximum regardless. | MAY | spec cancellation page |

Implication: assume **~60 s** is the lowest common denominator. A single blocking call over hundreds of images will fail on Codex defaults and probably Claude Desktop.

### 6.2 Options

| Pattern | Works on | Pros | Cons |
|---|---|---|---|
| A. One blocking call + progress | Claude Code; anything with long timeouts | Simplest; one call | Breaks at 60 s clients; progress doesn't extend most timeouts |
| B. Agent chunks the work (tool caps N files/call, returns `nextCursor`) | All | No server state | Many calls; agent bookkeeping; slow per-call setup |
| C. Job handle: `start_job` → `get_job_status` → `cancel_job` | All | Spec-endorsed ("Stateful Tools", explicit handles); survives timeouts | Extra calls; state dies with the stdio process; model must poll |
| **D. Hybrid (recommended)**: `optimize_images` works up to a ~45 s budget with progress, returns final result if done, else `status:"running"` + `jobId`; `get_job_status(jobId, waitSeconds<=45)` long-polls | All | Small batches = 1 call; big batches degrade to C automatically; poll count ≈ total_time/45 s | Same state caveat as C |
| E. MCP Tasks extension (`resultType:"task"`, `tasks/get`, `tasks/cancel`) | Clients that declare `io.modelcontextprotocol/tasks` on 2026-07-28 connections: Claude Code CLI (v2.1.304+, main conversation only), claude.ai, MCPJam (community matrix). Not Claude Desktop, Cursor, VS Code. | Host polls for us; survives client restart (if server process survives) | No server helper in SDK v2 (would hand-roll `tasks/get`/`cancel`/`update` handlers); must fall back to D for every other client; stdio process exit kills the job anyway |

Tasks extension facts (modelcontextprotocol.io/extensions/tasks/overview, ext-tasks repo `2026-07-28` schema "Stable", Claude Code docs "MCP tasks for server authors"):
- Return a task only if the request's `_meta["io.modelcontextprotocol/clientCapabilities"].extensions` contains `io.modelcontextprotocol/tasks`; otherwise Claude Code reports `Unsupported result type 'task' for tools/call`.
- Task object: `resultType:"task"`, `taskId` (<= 128 printable ASCII, no spaces), `status` (`working|input_required|completed|failed|cancelled`), `createdAt`, `lastUpdatedAt`, `ttlMs` (may be null), optional `statusMessage`, `pollIntervalMs` (Claude Code clamps 250-30000, default 2000).
- `tasks/get` response: `resultType:"complete"` + task fields + `result` (the normal `CallToolResult`) when completed, or `error {code,message}` when failed. Claude Code doesn't use `tasks/result`, `tasks/list`, `notifications/tasks`.

Recommendation: **D now; E as a later, additive step** once SDK v2 ships a server-side Tasks helper or more hosts support it. D and E share the same internal job store, so E is a thin adapter later.

Practical details for D:
- State the job lifetime in the tool description ("jobs are kept in memory until the server process exits; completed jobs expire after 1 h").
- Unknown/expired `jobId` → `isError` with "start a new optimize_images call".
- Throttle progress to ~4/s; include `total` when known; message names the current file.
- `get_job_status` is `readOnlyHint:true`; `cancel_job` is idempotent and non-destructive (already-written outputs stay; say so).

---

## 7. Notes on the 2025-era vs 2026-era split (why D2 matters)

- SDK v2 calls 2024-10-07…2025-11-25 the **legacy** era (initialize handshake) and 2026-07-28 the **modern** era.
- Claude Code (v2 runtime) asks stdio servers for 2026-07-28 and uses it if supported; everything else connects as legacy. `serveStdio` answers both from one factory.
- Things that differ by era and touch us: elicitation (`ctx.mcpReq.elicitInput` vs `return inputRequired(...)`), roots (server request vs MRTR), logging level, change notifications. Avoiding elicitation, roots and MCP logging in the MVP keeps one code path.

---

## 8. Not verified / open questions

1. **Claude Desktop's real tool timeout** and whether progress extends it — no official doc; only user bug reports (60 s to ~4 min). Test empirically before release.
2. **VS Code, Cursor, Windsurf/Devin tool timeouts and progress UI** — not in the docs pages read.
3. **Which of `content` vs `structuredContent` each host shows the model.** Spec only says to include both; host behaviour not documented in the pages read.
4. **Dots in tool names** on the Claude API side: spec allows them; I did not confirm the Claude API tool-name regex. Avoid dots.
5. **Cursor one-click deeplink for MCP** (`cursor://anysphere.cursor-deeplink/mcp/install?...`): not in current Cursor docs (deeplinks page covers prompt/command/rule only). Don't publish a Cursor button until confirmed.
6. **VS Code `${workspaceFolder}` substitution inside `mcp.json` args**: not shown on the reference page; `cwd` defaulting to the workspace folder is documented, hence the `"."` example.
7. **Whether a v2 `registerTool` handler can return a `CreateTaskResult`** directly (for the Tasks extension) — not documented; the SDK v2 docs have no server Tasks page and the server exports have no tasks subpath.
8. **MCPB with SDK v2**: the MCPB README's prompt template still names `@modelcontextprotocol/sdk`; nothing suggests v2 breaks bundles, but not tested.
9. **Windsurf's current config path** after the Devin rebrand: legacy `~/.codeium/windsurf/mcp_config.json` vs Devin `~/.config/devin/mcp_config.json` — taken from Devin's docs, not Windsurf's.
10. Extension support matrix (Tasks in Claude Code/claude.ai/MCPJam) is "maintained by the community".

---

## 9. Sources

Spec and docs (modelcontextprotocol.io)
- Spec home (latest = 2026-07-28): https://modelcontextprotocol.io/specification/latest
- Changelogs: https://modelcontextprotocol.io/specification/2026-07-28/changelog , https://modelcontextprotocol.io/specification/2025-11-25/changelog , https://modelcontextprotocol.io/specification/2025-06-18/changelog
- Tools: https://modelcontextprotocol.io/specification/2026-07-28/server/tools
- Progress: https://modelcontextprotocol.io/specification/2026-07-28/basic/utilities/progress
- Cancellation/timeouts: https://modelcontextprotocol.io/specification/2026-07-28/basic/utilities/cancellation
- Deprecated features: https://modelcontextprotocol.io/specification/2026-07-28/deprecated
- MRTR: https://modelcontextprotocol.io/specification/2026-07-28/basic/patterns/mrtr
- Schema (ToolAnnotations): https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/schema/2026-07-28/schema.ts
- Tasks extension: https://modelcontextprotocol.io/extensions/tasks/overview , https://github.com/modelcontextprotocol/ext-tasks
- Extension client matrix: https://modelcontextprotocol.io/extensions/client-matrix
- Local server security: https://modelcontextprotocol.io/docs/2026-07-28/tutorials/security/local-server-security
- Connect local servers (Claude Desktop): https://modelcontextprotocol.io/docs/2026-07-28/develop/connect-local-servers

TypeScript SDK
- README (v2): https://github.com/modelcontextprotocol/typescript-sdk
- Docs used: `docs/serving/stdio.md`, `docs/serving/legacy-clients.md`, `docs/protocol-versions.md`, `docs/servers/tools.md`, `docs/servers/logging-progress-cancellation.md`, `docs/servers/errors.md`, `docs/servers/input-required.md`, `docs/advanced/schema-libraries.md`, `docs/clients/roots.md`, `docs/get-started/first-server.md`, `docs/get-started/real-host.md` (all under https://github.com/modelcontextprotocol/typescript-sdk/tree/main/docs ; rendered at https://ts.sdk.modelcontextprotocol.io/v2/)
- Upgrade guide: https://ts.sdk.modelcontextprotocol.io/v2/migration/upgrade-to-v2
- v1 docs: https://github.com/modelcontextprotocol/typescript-sdk/tree/v1.x
- npm: `npm view @modelcontextprotocol/sdk`, `@modelcontextprotocol/server`, `@modelcontextprotocol/ext-tasks`, `@anthropic-ai/mcpb` (run 2026-11-02)
- Reference server: https://github.com/modelcontextprotocol/servers/tree/main/src/filesystem (README, package.json, index.ts, server.ts, path-validation.ts)

Registry and bundles
- Registry quickstart: https://modelcontextprotocol.io/registry/quickstart
- Package types: https://modelcontextprotocol.io/registry/package-types
- GitHub Actions: https://modelcontextprotocol.io/registry/github-actions
- server.json reference + official requirements + schema changelog: https://github.com/modelcontextprotocol/registry/tree/main/docs/reference/server-json
- MCPB: https://github.com/modelcontextprotocol/mcpb (README.md, MANIFEST.md)
- Claude Help Center (Desktop extensions): https://support.claude.com/en/articles/10949351-getting-started-with-local-mcp-servers-on-claude-desktop

Clients
- Claude Code MCP: https://code.claude.com/docs/en/mcp
- VS Code config reference: https://code.visualstudio.com/docs/agents/reference/mcp-configuration
- VS Code MCP developer guide: https://code.visualstudio.com/docs/copilot/guides/mcp-developer-guide
- Cursor MCP: https://cursor.com/docs/mcp ; deeplinks: https://cursor.com/docs/reference/deeplinks
- Codex MCP: https://learn.chatgpt.com/docs/extend/mcp?surface=cli (redirect target of developers.openai.com/codex/mcp)
- Devin/Windsurf: https://docs.devin.ai/cli/extensibility/mcp/configuration , https://docs.devin.ai/cli/reference/configuration/read-config-from
- Claude Desktop timeout reports: https://github.com/anthropics/claude-code/issues/63379 , /65643 , /22542 , /22451

Tool design
- Anthropic, "Writing effective tools for agents — with agents": https://www.anthropic.com/engineering/writing-tools-for-agents

npm
- npx: https://docs.npmjs.com/cli/commands/npx ; package.json `bin`: https://docs.npmjs.com/cli/configuring-npm/package-json#bin
