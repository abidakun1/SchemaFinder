# SchemaFinder


A Node.js CLI tool to extract GraphQL queries, mutations, and schemas from JavaScript code files and live endpoints - optimized for JS auditing and recon. Inspired by [LinkFinder](https://github.com/GerbenJavado/LinkFinder)





# Features

- ✅ Extracts queries/mutations from:
  - `gql` or `graphql` tagged templates
  - Inline `fetch()` calls with GraphQL bodies
  - JavaScript string/Template literals
  - Commented-out GraphQL queries
    
- ✅ Streams large files to avoid memory exhaustion
- ✅ Crawls entire directories with `glob` patterns
- ✅ Detects queries built from string concatenation
- ✅ Supports introspection of live GraphQL endpoints
- ✅ Exports results to JSON and Postman Collection format
- ✅ CLI progress bar + parallel processing for speed
- ✅ Plugin system for custom AST visitors
- ✅ Parses imported `.graphql` fragments
- ✅ Built with Babel scope analysis for dynamic detection




# Installation

```bash
git clone https://github.com/yourname/schemafinder.git
cd schemafinder
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


6. Introspect a Remote GraphQL Endpoint
To introspect a remote GraphQL endpoint and extract its schema:

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





