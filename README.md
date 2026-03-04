# SchemaFinder

A Node.js CLI tool for extracting GraphQL operations from JavaScript code, including support for minified/bundled code and remote file analysis — optimized for JS auditing and recon. Inspired by  [LinkFinder](https://github.com/GerbenJavado/LinkFinder)





# Features

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

4. Aggressive minified code detection:

```bash
schemafinder -i "dist/*.min.js" -o queries.json --aggressive
```

5. Extract and export as a Postman collection

To extract GraphQL schema from JavaScript files and export them as a Postman Collection:

```bash
schemafinder -i "src/**/*.js" -o queries.json --postman
```






# Options

```

Options:
  -V, --version                   Output tool version
  -i, --input <pattern>           Glob/file/URL for input files
  -o, --output <file>             Output JSON file (required)
  --url-list <file>               Text file containing JS URLs (one per line)
  --postman                       Generate Postman collection
  --concurrency <n>               Max parallel files (default: 4)
  --aggressive                    Use aggressive detection for minified code
  --verbose                       Verbose logging
  -h, --help                      Display help

```



# Summary


SchemaFinder acts like a static‑code analysis tool for GraphQL, giving you full visibility into:

✅ What GraphQL operations exist in your JS code — every query, mutation, subscription, and fragment embedded in templates, strings, comments, HTTP calls, hooks, or client methods

✅ How queries are constructed — string concatenation, escape-encoded strings, Base64, inline JSON blobs, and AST-level binary expressions are all resolved before extraction

✅ Where each operation came from — every result includes source, origin, and context fields showing exactly which file, URL, and detection pass found it

# Final Note
✅ This is my first publicly released  tool — feedback, issues, and contributions are very welcome!

✅ SchemaFinder is open-source and licensed under the MIT License.
