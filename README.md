# SchemaFinder

A Node.js CLI tool for extracting GraphQL operations from JavaScript code, including support for minified/bundled code and remote file analysis — optimized for JS auditing and recon. Inspired by  [LinkFinder](https://github.com/GerbenJavado/LinkFinder)




## Features

- **Multi-source extraction** — tagged templates (`gql`, `graphql`, `apollo`), inline HTTP calls (`fetch`, `axios`), string literals, template literals, commented-out queries
- **Real GQL validation** — every candidate is parsed through `graphql`'s own parser, eliminating false positives from minified code
- **Minified/bundled code** — specialised passes for compressed JavaScript with `--aggressive` mode
- **Auth header support** — pass `Authorization`, `Cookie`, or any custom headers for protected assets via `--headers`
- **Retry with backoff** — remote fetches retry automatically with exponential backoff + jitter
- **Batch processing** — process a list of URLs in parallel via `--url-list`
- **Postman export** — outputs a ready-to-use Postman collection including any auth headers
- **Parallel processing** — configurable worker pool with lazy spawning
- **Per-origin output** — results split by source file for clean analysis


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

1. Extract GraphQL queries from a file or folder

```bash
schemafinder -i "src/**/*.js" -o extracted.json
```
2. Batch URL processing:


```bash
schemafinder --url-list urls.txt -o queries.json
```

3. Remote File Parsing (Direct URL Input)
If you want to extract GraphQL queries and mutations directly from a remote JavaScript file, you can provide the URL of the file as input. Here’s how:
```bash
schemafinder -i "https://example.com/path/to/file.js" -o queries.json
```


4. Authenticated remote scan
```bash
schemafinder -i "https://app.example.com/main.chunk.js" -o results.json \
  --headers '{"Authorization":"Bearer TOKEN"}'
```


5. Batch with auth + aggressive + Postman export
```bash
schemafinder --url-list js_urls.txt \
  -o results.json \
  --aggressive \
  --postman \
  --retries 5 \
  --headers '{"Cookie":"sessionid=abc; csrftoken=xyz"}'
``` 
6. Aggressive minified code detection:

```bash
schemafinder -i "dist/*.min.js" -o queries.json --aggressive
```

7. Extract and export as a Postman collection

To extract GraphQL schema from JavaScript files and export them as a Postman Collection:

```bash
schemafinder -i "src/**/*.js" -o queries.json --postman
```






# Options


| Flag | Description | Default |
|------|-------------|---------|
| `-i, --input <pattern>` | Glob pattern, local file path, or remote URL | — |
| `-o, --output <file>` | Output JSON file (required) | — |
| `--url-list <file>` | Text file of JS URLs, one per line | — |
| `--postman` | Export results as a Postman collection | false |
| `--concurrency <n>` | Max parallel worker threads | 4 |
| `--aggressive` | Enable all detection passes (slower, catches more) | false |
| `--headers <json>` | JSON object of custom request headers | — |
| `--retries <n>` | Retry attempts for failed remote fetches | 3 |
| `--verbose` | Verbose logging | false |


## Recommended Workflow (Bug Bounty)
```
Katana / GAU → JS URLs → SchemaFinder → Postman Collection → Burp Suite
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
