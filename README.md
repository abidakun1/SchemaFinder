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
How It Works — Step-by-Step

1. Input Sources
You can point SchemaFinder at various input sources:

✅ Single JavaScript file:

-i app.js

✅ Remote JavaScript file:

-i https://example.com/main.js

✅ Directory or glob pattern:

-i src/**/*.js

✅ Live GraphQL endpoint:

--introspect https://api.example.com/graphql

2. File Parsing
For JavaScript input files:

✅ Recursively scans .js files using fast-glob (supports directories and patterns).

✅ Efficient line-by-line streaming of files for large files, reducing memory usage.

✅ Babel parser (@babel/parser) converts JavaScript code into an Abstract Syntax Tree (AST).

✅ Babel traverse (@babel/traverse) walks through the AST to identify GraphQL-related nodes in the code.

3. GraphQL Detection Logic
The tool detects GraphQL operations from various sources:

✅ Tagged template literals:

Detects gql, graphql, and similar tagged templates.

✅ fetch() calls:

Detects GraphQL queries in fetch() calls with GraphQL body payloads.

✅ Raw string literals:

Identifies query/mutation strings written directly in JavaScript code.

✅ Template literals or string concatenations:

Detects dynamically built queries using string templates or concatenation.

✅ Inline and block comments:

Detects GraphQL queries embedded in comments (e.g., /* ... */ or // ...).

✅ Imported .graphql fragments:

Automatically processes .graphql fragments when included via loader.

✅ Scope resolution:

Uses scope.getBinding() to resolve variables that are assigned GraphQL queries (e.g., const myQuery = "...";).

4. Introspection Support
When --introspect is used:

✅ Sends an introspection query to the specified GraphQL endpoint using fetch.

✅ Parses and saves the returned schema in .json format.

5. Postman Collection Export
When --postman is used:

✅ Wraps each extracted query into a proper Postman request body format.

✅ Generates a complete Postman Collection in Postman v2.1 format (.postman.json) for easy API testing, replaying, or fuzzing.

6. Output
✅ All extracted queries and mutations are saved in the file specified with -o in JSON format.

✅ Depending on the flags used, a .postman.json and/or schema.json may also be created.


# Summary


SchemaFinder acts like a static code analysis tool for GraphQL, giving you full visibility into:

✅ What GraphQL operations exist in JS code

✅ The structure of GraphQL schemas

✅ How queries/mutations are being constructed



# Final remarks

✅ This is the first time I publicly built a tool. Contributions are much appreciated!

✅ SchemaFinder is published under the MIT License.

