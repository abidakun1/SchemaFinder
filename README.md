# SchemaFinder

A Node.js CLI tool for extracting GraphQL operations from JavaScript code, including support for minified/bundled code and remote file analysis.  - optimized for JS auditing and recon. Inspired by [LinkFinder](https://github.com/GerbenJavado/LinkFinder)





# Features

✅ **Multi-Source Extraction**:
- Tagged templates (`gql`, `graphql`, `apollo`)
- Inline HTTP client calls (`fetch`, `axios`, `request`)
- JavaScript string literals and template literals
- Commented-out GraphQL queries
- Minified/bundled code patterns
- Escaped GraphQL in JSON-like structures

✅ **Advanced Minified Code Handling**:
- Specialized regex patterns for compressed JavaScript
- Flexible spacing detection in minified operations
- Template literal content analysis
- Split operation detection across lines



✅ **Comprehensive Input Support**:
- Local files and directories (via glob patterns)
- Remote JavaScript files (URLs)
- URL lists (batch processing)
- Large files (streaming support)

✅ Detects Concatenated Queries:

- Automatically detects and extracts queries built from string concatenation or variables.


✅ Exports Results in Multiple Formats:

- Outputs extracted queries/mutations as JSON
- Optionally exports as Postman Collection for API testing
- Context-aware detection statistics
- Origin-based operation grouping
- Detection method classification


✅ Enhanced Performance with Parallel Processing:

- CLI progress bar for real-time feedback.

- Supports parallel file processing with configurable concurrency for faster operations.

✅ Plugin System for Custom AST Visitors:

- Extensible with plugins for custom Abstract Syntax Tree (AST) visitors, allowing users to add custom logic or handle specific GraphQL patterns.



✅ Babel Scope Analysis for Dynamic Detection:

- Utilizes Babel's scope analysis for precise and dynamic detection of GraphQL queries and operations within JavaScript files.



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

✅ What GraphQL operations exist in your JS code
Discover every query, mutation, subscription, and fragment embedded in templates, strings, comments or HTTP calls.


✅ How queries and mutations are being constructed
Trace variable usage, string concatenation, imported fragments, and dynamic template logic via Babel’s AST scope analysis.


# Final Note
✅ This is my first publicly released  tool — feedback, issues, and contributions are very welcome!

✅ SchemaFinder is open-source and licensed under the MIT License.
