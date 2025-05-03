# SchemaFinder


A Node.js CLI tool to extract GraphQL queries, mutations schemas from JavaScript code files  - optimized for JS auditing and recon. Inspired by [LinkFinder](https://github.com/GerbenJavado/LinkFinder)





# Features

✅ Extracts GraphQL Operations from various sources:

- Tagged templates (gql, graphql, apollo, etc.)

- Inline fetch() or HTTP client calls with GraphQL request bodies

- JavaScript string literals and Template literals

- Commented-out GraphQL queries

- Queries built from string concatenation

✅ Efficiently Handles Large Files:

- Streams files to avoid memory exhaustion, even for large files.

✅ Crawl Directories with Glob Patterns:

- Supports directory crawling with customizable glob patterns (e.g., src/**/*.js).

✅ Detects Concatenated Queries:

- Automatically detects and extracts queries built from string concatenation or variables.

✅ Supports Live GraphQL Endpoint Introspection:

- Fetches and saves GraphQL schema from live endpoints with optional authentication headers (Bearer token, Cookie).

✅ Exports Results in Multiple Formats:

- Outputs extracted queries/mutations as JSON.

- Optionally exports as Postman Collection for API testing.

✅ Enhanced Performance with Parallel Processing:

- CLI progress bar for real-time feedback.

- Supports parallel file processing with configurable concurrency for faster operations.

✅ Plugin System for Custom AST Visitors:

- Extensible with plugins for custom Abstract Syntax Tree (AST) visitors, allowing users to add custom logic or handle specific GraphQL patterns.

✅ Parses Imported .graphql Fragments:

- Supports parsing and extracting queries or fragments imported from .graphql files.

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



2. Extract GraphQL queries from a js file

```bash
schemafinder -i file.js -o extracted.json
```
3. Remote File Parsing (Direct URL Input)
If you want to extract GraphQL queries and mutations directly from a remote JavaScript file, you can provide the URL of the file as input. Here’s how:
```bash
schemafinder -i "https://example.com/path/to/file.js" -o queries.json
```
5. Extract and export as a Postman collection

To extract GraphQL schema from JavaScript files and export them as a Postman Collection:

```bash
schemafinder -i "src/**/*.js" -o queries.json --postman
```


6. Introspect a Remote GraphQL Endpoint and extract its schema:

```bash
schemafinder -o schema.json --introspect "https://example.com/graphql"
```



# Options

```
-i, --input <glob|url|file>        Input glob pattern, remote JavaScript URL, or local .js file
-o, --output <path>               Output .json file path
--postman                         Also export queries to Postman collection format
--introspect <url>                URL of GraphQL endpoint to introspect schema
```





# How It Works — Step-by-Step

1. Input Sources

 ✅ You point SchemaFinder at:

- ✅ A single .js file (-i app.js)
- ✅ A remote js file (-i https://example.com/main.js)
- ✅ A directory or glob pattern (-i src/**/*.js)
- ✅ A live GraphQL endpoint (--introspect https://api.example.com/graphql)

2. File Parsing
   
For JavaScript input:

- ✅ Uses fast-glob to recursively scan all .js files

- ✅ Each file is streamed line-by-line (efficient for large files)

- ✅ Babel parser (@babel/parser) converts JS code to an AST (Abstract Syntax Tree)

- ✅ Babel traverse (@babel/traverse) walks the AST to identify GraphQL-related nodes

3. GraphQL Detection Logic
Detects GraphQL snippets from:

- ✅ gql or graphql tagged template literals

- ✅  fetch() calls with GraphQL body payloads

- ✅  Raw string literals containing query/mutation

- ✅  Template literals or string concatenations

- ✅  Inline comments or block comments with GraphQL queries

- ✅  Imported .graphql fragments (when included via loader)

- ✅  Also uses scope.getBinding() to resolve simple variable assignments (e.g., const myQuery = "...";).



4. Introspection Support
If --introspect is used:

- ✅ Sends an introspection query to the specified GraphQL endpoint using fetch

- ✅  Parses and saves the returned schema in .json format

5. Postman Collection Export
With --postman:

- ✅ Wraps each extracted query in a proper Postman request body

- ✅ Generates a full Postman v2.1 Collection (.postman.json) for quick replaying or fuzzing

6. Output
All queries and mutations are written to the file specified with -o

Optionally, a .postman.json and/or schema.json is created depending on flags



# Summary


SchemaFinder acts like a static code analysis tool for GraphQL, giving you full visibility into:

✅ What GraphQL operations exist in JS code

✅ The structure of GraphQL schemas

✅ How queries/mutations are being constructed



# Final remarks

✅ This is the first time I publicly built a tool. Contributions are much appreciated!

✅ SchemaFinder is published under the MIT License.

