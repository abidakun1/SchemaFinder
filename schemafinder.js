#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { promisify } = require('util');
const stream = require('stream');
const readline = require('readline');
const { program } = require('commander');
const parser = require('@babel/parser');
const traverse = require('@babel/traverse').default;
const fg = require('fast-glob');
const fetch = require('node-fetch');
const cliProgress = require('cli-progress');

const graphqlSnippets = new Set();
const plugins = [];

program
  .option('-i, --input <glob>', 'Input .js file(s) or glob pattern (e.g. src/**/*.js)')
  .option('-o, --output <file>', 'Output JSON file for extracted queries')
  .option('--postman', 'Export as Postman collection')
  .option('--introspect <url>', 'GraphQL endpoint for introspection')
  .parse(process.argv);

const options = program.opts();

function extractComments(code) {
  const regex = /\/\*.*?\*\/|\/\/.*(?=\n|$)/gs;
  const matches = code.match(regex);
  if (!matches) return;
  matches.forEach(comment => {
    if (/query\s+\w+|mutation\s+\w+/.test(comment)) {
      graphqlSnippets.add(comment.replace(/\*\/|\/\*|\/\//g, '').trim());
    }
  });
}

function applyPlugins(ast, code) {
  for (const plugin of plugins) {
    plugin(ast, code, graphqlSnippets);
  }
}

function registerDefaultPlugins() {
  plugins.push((ast, code, snippets) => {
    traverse(ast, {
      TaggedTemplateExpression(path) {
        const tag = path.node.tag.name;
        if (tag === 'gql' || tag === 'graphql') {
          const gqlStr = path.node.quasi.quasis.map(q => q.value.cooked).join('');
          snippets.add(gqlStr);
        }
      },
      CallExpression(path) {
        const callee = path.node.callee;
        if (callee.name === 'fetch') {
          const configArg = path.node.arguments[1];
          if (configArg && configArg.type === 'ObjectExpression') {
            const bodyProp = configArg.properties.find(prop => prop.key.name === 'body');
            if (bodyProp && bodyProp.value.type.includes('String')) {
              try {
                const match = /query\s*[:=]\s*[`'"](.+?)[`'"]/gs.exec(bodyProp.value.value);
                if (match) snippets.add(match[1]);
              } catch {}
            }
          }
        }
      },
      StringLiteral(path) {
        const value = path.node.value;
        if (/query\s+\w+|mutation\s+\w+/.test(value)) {
          snippets.add(value);
        }
      },
      TemplateLiteral(path) {
        const fullString = path.node.quasis.map(q => q.value.cooked).join('');
        if (/query\s+\w+|mutation\s+\w+/.test(fullString)) {
          snippets.add(fullString);
        }
      }
    });
  });
}

async function processFile(filePath) {
  const stat = fs.statSync(filePath);

  if (stat.size > 1_000_000) {
    // Large file: stream line by line
    const rl = readline.createInterface({
      input: fs.createReadStream(filePath),
      crlfDelay: Infinity
    });
    let buffer = '';
    for await (const line of rl) {
      buffer += line + '\n';
    }
    extractFromCode(buffer);
  } else {
    const code = fs.readFileSync(filePath, 'utf8');
    extractFromCode(code);
  }
}

function extractFromCode(code) {
  extractComments(code);
  const ast = parser.parse(code, {
    sourceType: 'unambiguous',
    plugins: ['jsx', 'typescript', 'classProperties', 'optionalChaining']
  });
  applyPlugins(ast, code);
}

async function introspectSchema(endpoint) {
  const introspectionQuery = {
    query: `
      query IntrospectionQuery {
        __schema {
          queryType { name }
          mutationType { name }
          subscriptionType { name }
          types {
            ...FullType
          }
          directives {
            name
            locations
            args {
              ...InputValue
            }
          }
        }
      }

      fragment FullType on __Type {
        kind
        name
        description
        fields(includeDeprecated: true) {
          name
          description
          args {
            ...InputValue
          }
          type {
            ...TypeRef
          }
          isDeprecated
          deprecationReason
        }
        inputFields {
          ...InputValue
        }
        interfaces {
          ...TypeRef
        }
        enumValues(includeDeprecated: true) {
          name
          description
          isDeprecated
          deprecationReason
        }
        possibleTypes {
          ...TypeRef
        }
      }

      fragment InputValue on __InputValue {
        name
        description
        type { ...TypeRef }
        defaultValue
      }

      fragment TypeRef on __Type {
        kind
        name
        ofType {
          kind
          name
          ofType {
            kind
            name
            ofType {
              kind
              name
            }
          }
        }
      }
    `
  };

  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(introspectionQuery)
    });
    const json = await res.json();
    const outputPath = options.output || 'schema.schema.json';
    fs.writeFileSync(outputPath, JSON.stringify(json, null, 2));
    console.log(`✅ Introspection schema written to ${outputPath}`);
  } catch (err) {
    console.error(`❌ Failed introspection: ${err.message}`);
  }
}

function generatePostmanCollection(snippets) {
  return {
    info: {
      name: 'GraphQL Extracted Queries',
      schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json'
    },
    item: snippets.map((query, i) => ({
      name: `Query ${i + 1}`,
      request: {
        method: 'POST',
        header: [{ key: 'Content-Type', value: 'application/json' }],
        url: { raw: '{{GRAPHQL_ENDPOINT}}', host: ['{{GRAPHQL_ENDPOINT}}'] },
        body: {
          mode: 'raw',
          raw: JSON.stringify({ query }, null, 2)
        }
      }
    }))
  };
}

(async () => {
  registerDefaultPlugins();

  if (options.introspect && !options.input) {
    await introspectSchema(options.introspect);
    return;
  }

  if (!options.input || !options.output) {
    console.error('❌ Please specify both -i <input> and -o <output>');
    process.exit(1);
  }

  const filePaths = await fg([options.input], { dot: true });
  console.log(`📂 Found ${filePaths.length} file(s)`);
  const bar = new cliProgress.SingleBar({}, cliProgress.Presets.shades_classic);
  bar.start(filePaths.length, 0);

  await Promise.all(
    filePaths.map(async (file) => {
      await processFile(file);
      bar.increment();
    })
  );

  bar.stop();

  const snippets = Array.from(graphqlSnippets);
  fs.writeFileSync(options.output, JSON.stringify({ graphql: snippets }, null, 2));
  console.log(`✅ Extracted ${snippets.length} GraphQL snippet(s) to ${options.output}`);

  if (options.postman) {
    const postmanPath = options.output.replace(/\.json$/, '.postman.json');
    const collection = generatePostmanCollection(snippets);
    fs.writeFileSync(postmanPath, JSON.stringify(collection, null, 2));
    console.log(`📦 Postman collection saved to ${postmanPath}`);
  }
})();
