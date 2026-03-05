# SchemaFinder

A Node.js CLI tool for extracting GraphQL operations from JavaScript code, including support for minified/bundled code and remote file analysis — optimized for JS auditing and recon. Inspired by  [LinkFinder](https://github.com/GerbenJavado/LinkFinder)




## Features


- **Multi-source extraction** — tagged templates (`gql`, `graphql`, `apollo`), inline HTTP calls (`fetch`, `axios`), string literals, template literals, commented-out queries
- **Live introspection** — probe a GraphQL endpoint directly to discover every operation the server exposes
- **Introspection bypass engine** — automatically tries 9 strategies when standard introspection is blocked: whitespace tricks, GET requests, alternative content-types, and `__type` partial recovery
- **Cross-referencing** — compare JS extraction vs live server schema to produce a coverage report: confirmed, JS-only, and hidden server-only operations
- **Real GQL validation** — every candidate parsed through `graphql`'s own parser, eliminating false positives
- **Minified/bundled code** — specialised passes for compressed JavaScript with `--aggressive` mode
- **Auth header support** — pass `Authorization`, `Cookie`, or any custom headers via `--headers`
- **Retry with backoff** — remote fetches retry with exponential backoff + jitter
- **Batch processing** — process a list of URLs in parallel via `--url-list`
- **Postman export** — ready-to-use collection with auth headers and pre-filled endpoint URL
- **Parallel processing** — configurable worker pool with lazy spawning
- **Per-origin output** — results split by source file


✅ **Multi-Source Extraction**:
- Tagged templates (gql, graphql, apollo, gqlTag, GraphQL and common aliases)
- Inline HTTP client calls (fetch, axios, request, got, superagent, ky, $http)
- JavaScript string literals (single, double, template) with full escape decoding (\n, \uXXXX, \x41)
- Object property detection ({query: "..."}, {mutation: "..."}, {document: ...})
- React/Apollo hooks (useQuery, useMutation, useSubscription, useLazyQuery)
- Apollo client methods (client.query(), client.mutate(), watchQuery(), readQuery())
- Commented-out GraphQL queries (/* */ and // blocks)
- Minified/bundled code patterns
- Base64-encoded queries (aggressive mode)
- Inline JSON-serialised queries ({"query":"..."} patterns in bundled code)

✅ **Advanced Minified Code Handling**:
- Specialized regex patterns for compressed JavaScript
- Flexible spacing detection in minified operations
- Template literal content analysis
- Split operation detection across lines

✅ **Robust Nested Query Detection**:

- Replaced regex-based body matching with a balanced brace extractor that walks {...} depth — catches deeply nested queries and complex  fragments that regex reliably misses

✅ **Comprehensive Input Support**:
- Local files and directories (via glob patterns)
- Remote JavaScript files (URLs)
- URL lists (batch processing)
- Large files (streaming support)

✅ Detects Concatenated Queries:

- Automatically detects and extracts queries built from string concatenation or variables.


✅ Exports Results in Multiple Formats:

- Extracted operations as JSON with detection context metadata
- Optional Postman Collection export for direct API testing
- Per-origin JSON files grouped in a _sources/ directory
- Detection method breakdown in summary output

✅ Advanced Minified Code Handling:

- String concatenation resolution at both source and AST levels ("query " + "Foo" + "{ id }")
- Binary + node resolution in the AST for multi-part string assembly
- Collapsed whitespace re-analysis for single-line minified bundles
- Escape sequence decoding before pattern matching
  
✅ Enhanced Performance with Parallel Processing:

- Fixed worker pool with proper idle-queue (no silent dropped files)
- Read-ahead buffering decoupled from worker availability
- CLI progress bar with real-time ETA
- Configurable concurrency
  
✅ Plugin System for Custom AST Visitors:

- Extensible with plugins for custom Abstract Syntax Tree (AST) visitors, allowing users to add custom logic or handle specific GraphQL patterns.



# Installation


```bash
git clone https://github.com/abidakun1/SchemaFinder.git
cd SchemaFinder
npm install
npm link   # or use directly via `node schemafinder.js`
```




# Usage


### Extract from a local file or folder
```bash
schemafinder -i "src/**/*.js" -o extracted.json
```

### Extract from a remote JS file
```bash
schemafinder -i "https://example.com/static/js/main.chunk.js" -o queries.json
```

### Authenticated remote scan
```bash
schemafinder -i "https://app.example.com/main.chunk.js" -o results.json \
  --headers '{"Authorization":"Bearer TOKEN"}'
```

### Batch URL processing
```bash
schemafinder --url-list urls.txt -o queries.json
```

### Introspection only — probe the server directly
```bash
schemafinder --endpoint https://api.example.com/graphql \
  -o results.json \
  --headers '{"Authorization":"Bearer TOKEN"}'
```

### Introspection + Postman export
```bash
schemafinder --endpoint https://api.example.com/graphql \
  -o results.json \
  --postman \
  --headers '{"Authorization":"Bearer TOKEN"}'
```
The exported Postman collection will have `{{GRAPHQL_ENDPOINT}}` pre-filled with your target URL and your auth headers baked into every request.

### Full combined recon — JS extraction + introspection + cross-reference
```bash
schemafinder --url-list js_urls.txt \
  --endpoint https://api.example.com/graphql \
  -o results.json \
  --postman \
  --headers '{"Authorization":"Bearer TOKEN","Cookie":"session=abc"}'
```

### Aggressive mode for minified/bundled code
```bash
schemafinder -i "dist/*.min.js" -o queries.json --aggressive
```

---






# Options


| Flag | Description | Default |
|------|-------------|---------|
| `-i, --input <pattern>` | Glob pattern, local file path, or remote URL | — |
| `-o, --output <file>` | Output JSON file (required) | — |
| `--url-list <file>` | Text file of JS URLs, one per line | — |
| `--endpoint <url>` | GraphQL endpoint to run introspection against | — |
| `--postman` | Export results as a Postman collection | false |
| `--concurrency <n>` | Max parallel worker threads | 4 |
| `--aggressive` | Enable all detection passes (slower, catches more) | false |
| `--headers <json>` | JSON object of custom request headers | — |
| `--retries <n>` | Retry attempts for failed remote fetches | 3 |
| `--verbose` | Verbose logging | false |





## Introspection & Bypass

When `--endpoint` is provided, SchemaFinder sends a full introspection query. If blocked, it automatically tries 9 bypass strategies:

| # | Strategy | What it exploits |
|---|----------|-----------------|
| 1 | Standard POST | Baseline |
| 2 | Newline after `__schema` | Regex matches `__schema{` not `__schema\n{` |
| 3 | Tab after `__schema` | Same with `\t` |
| 4 | Comma after `__schema` | GraphQL ignores commas, regex doesn't |
| 5 | GET request | Introspection may only be blocked on POST |
| 6 | GET minimal probe | Smaller fingerprint |
| 7 | `application/graphql` content-type | Raw body, no JSON wrapper |
| 8 | `x-www-form-urlencoded` | Alternative encoding |
| 9 | `__type` partial recovery | When `__schema` is fully blocked |

Use `--verbose` to see each attempt in real time.

When used alongside `--input` or `--url-list`, results are cross-referenced:
```
🗺️  Coverage report:
   ✅ Confirmed (in JS + server):  28
   🟡 JS only (not on server):      6
   🔴 Server only (hidden ops):     13

🚨 Hidden operations (server exposes, frontend never calls):
   → AdminDeleteUser
   → ExportAllData
   → ResetUserPassword
```

**Server-only operations are the most valuable finding** — these are endpoints the backend exposes but the frontend never references, making them invisible to JS-only scanning tools.

Each operation in the output is tagged with a `coverage` field:

| Value | Meaning |
|-------|---------|
| `confirmed` | Found in both JS code and server schema |
| `js_only` | Found in JS but server didn't confirm it |
| `server_only` | Server exposes it but frontend never calls it |

When using `--postman` with `--endpoint`, the collection variable `{{GRAPHQL_ENDPOINT}}` is pre-filled with your endpoint URL automatically.

---

## Output

Results are written to your `--output` file as a JSON array. A `_sources/` subdirectory is also created with results split by origin file.
```json
[
  {
    "operation": "query GetUser($id: ID!) {\n  user(id: $id) {\n    id\n    name\n    email\n  }\n}",
    "name": "GetUser",
    "variables": { "id": "sample-string" },
    "source": "/path/to/file.js",
    "origin": "https://example.com/main.chunk.js",
    "context": "tagged_template",
    "coverage": "confirmed",
    "detectedAt": "2025-08-05T12:00:00.000Z",
    "toolVersion": "2.2.0"
  },
  {
    "operation": "mutation AdminDeleteUser($id: ID!) {\n  adminDeleteUser(id: $id) {\n    success\n  }\n}",
    "name": "AdminDeleteUser",
    "variables": { "id": "sample-string" },
    "source": "https://api.example.com/graphql",
    "origin": "https://api.example.com/graphql",
    "context": "introspection",
    "coverage": "server_only",
    "detectedAt": "2025-08-05T12:00:00.000Z",
    "toolVersion": "2.2.0"
  }
]
```

---


## Recommended Workflow (Bug Bounty)
```
Katana / GAU → JS URLs → SchemaFinder → Postman Collection → Burp Suite (PostmanCollectionImporter Extension by Abdulrahman)
```

1. Use **Katana** or **GAU** to collect all JS endpoint URLs from a target
2. Feed them into SchemaFinder via `--url-list`
3. Export with `--postman` and import into Burp or Postman
4. Fuzz each operation for IDOR, auth bypass, or info leakage


# Summary


SchemaFinder acts like a static‑code analysis tool for GraphQL, giving you full visibility into:

✅ What GraphQL operations exist in your JS code — every query, mutation, subscription, and fragment embedded in templates, strings, comments, HTTP calls, hooks, or client methods

✅ How queries are constructed — string concatenation, escape-encoded strings, Base64, inline JSON blobs, and AST-level binary expressions are all resolved before extraction

✅ Where each operation came from — every result includes source, origin, and context fields showing exactly which file, URL, and detection pass found it

# Final Note
✅ This is my first publicly released  tool — feedback, issues, and contributions are very welcome!

✅ SchemaFinder is open-source and licensed under the MIT License.
