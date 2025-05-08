#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const { Worker, isMainThread, parentPort } = require('worker_threads');
const { program } = require('commander');
const parser = require('@babel/parser');
const traverse = require('@babel/traverse').default;
const fg = require('fast-glob');
const fetch = require('node-fetch');
const cliProgress = require('cli-progress');
const pLimit = require('p-limit');
const crypto = require('crypto');

// Configuration
const DEFAULT_CONCURRENCY = 4;
const MAX_FILE_SIZE_SYNC = 1024 * 1024; // 1MB

// GraphQL patterns
const GQL_PATTERN = /(?:query|mutation|subscription|fragment)\s+([a-zA-Z0-9_]+)\s*(?:\(([^)]*)\))?\s*\{[\s\S]*?\}/gs;
const GQL_TAGS = new Set(['gql', 'graphql', 'apollo']);
const HTTP_CLIENTS = new Set(['fetch', 'axios', 'request']);

program
  .version('1.1.0')
  .option('-i, --input <pattern>',     'Glob/file/URL for input files')
  .option('-o, --output <file>',       'Output JSON file')
  .option('--postman',                 'Generate Postman collection')
  .option('--concurrency <n>',         'Max parallel files', parseInt, DEFAULT_CONCURRENCY)
  .option('--verbose',                 'Verbose logging')
  .parse(process.argv);

const options = program.opts();

function isRemotePath(p) {
  return /^https?:\/\//.test(p);
}

async function fetchRemoteCode(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to fetch ${url}: ${res.statusText}`);
  return await res.text();
}

function validateRequiredVariables() {
  if (!options.input) {
    console.error('❌ Error: You must provide --input <pattern>');
    program.help({ error: true });
  }

  if (!options.output || typeof options.output !== 'string') {
    console.error('❌ Error: --output <file> is required');
    program.help({ error: true });
  }

  if (isNaN(options.concurrency)) {
    console.error('❌ Concurrency must be a number');
    process.exit(1);
  }

  if (options.concurrency < 1) {
    console.error('❌ Concurrency must be at least 1');
    process.exit(1);
  }
}

if (!isMainThread) {
  parentPort.on('message', ({ filePath, code }) => {
    const operations = new Map();

function extractOperation(text, variables = {}) {
  const matches = [...text.matchAll(GQL_PATTERN)];
  matches.forEach(match => {
    let [fullMatch, operationName, args] = match;

    // Ensure the operation has proper closing brace
    if (!fullMatch.trim().endsWith('}')) {
      fullMatch = fullMatch + '}'; // Add missing closing brace
    }

    const signature = fullMatch.replace(/\s+/g, ' ').trim();

    if (args) {
      args.split(',').forEach(arg => {
        const [varName, varType] = arg.split(':').map(s => s.trim());
        if (varName && varType && !variables[varName]) {
          variables[varName] = getDefaultValue(varType);
        }
      });
    }

    if (!operations.has(signature)) {
      operations.set(signature, {
        operation: fullMatch.trim(),
        name: operationName,
        variables,
        source: filePath
      });
    }
  });
}

    function getDefaultValue(type) {
      if (type.includes('String')) return "sample-string";
      if (type.includes('Int') || type.includes('Float')) return 0;
      if (type.includes('Boolean')) return false;
      if (type.includes('ID')) return "123";
      if (type.includes('[')) return [];
      return null;
    }

    function extractFromComments(code) {
      const patterns = [
        /\/\*[\s\S]*?\*\//g,
        /\/\/.*$/gm
      ];

      patterns.forEach(pattern => {
        const comments = code.match(pattern) || [];
        comments.forEach(comment => {
          const cleaned = comment
            .replace(/^\/\*+|\*+\/$/g, '')
            .replace(/^\/\/\s*/gm, '')
            .trim();
          extractOperation(cleaned);
        });
      });
    }

    function extractVariablesFromCode(node) {
      const variables = {};
      if (node.type === 'ObjectExpression') {
        node.properties.forEach(prop => {
          if (prop.key.name === 'variables' || prop.key.value === 'variables') {
            if (prop.value.type === 'ObjectExpression') {
              prop.value.properties.forEach(varProp => {
                if (varProp.value.type === 'Literal') {
                  variables[varProp.key.name || varProp.key.value] = varProp.value.value;
                }
              });
            }
          }
        });
      }
      return variables;
    }

    try {
      extractFromComments(code);

      const ast = parser.parse(code, {
        sourceType: 'unambiguous',
        plugins: ['jsx', 'typescript', 'classProperties', 'dynamicImport'],
        tokens: true
      });

      traverse(ast, {
        TaggedTemplateExpression(path) {
          if (GQL_TAGS.has(path.node.tag.name)) {
            const text = path.node.quasi.quasis.map(q => q.value.cooked).join('');
            extractOperation(text);
          }
        },
        CallExpression(path) {
          const callee = path.node.callee;
          const calleeName = callee.name || (callee.property && callee.property.name) || '';
          if (HTTP_CLIENTS.has(calleeName)) {
            const args = path.node.arguments;
            if (args.length < 2) return;

            const configArg = args[1];
            if (!configArg || configArg.type !== 'ObjectExpression') return;

            const bodyProp = configArg.properties.find(p =>
              ['body', 'data'].includes(p.key.name || p.key.value)
            );

            if (bodyProp) {
              let bodyText = '';
              let variables = extractVariablesFromCode(configArg);

              if (bodyProp.value.type === 'StringLiteral') {
                bodyText = bodyProp.value.value;
              } else if (bodyProp.value.type === 'TemplateLiteral') {
                bodyText = bodyProp.value.quasis.map(q => q.value.cooked).join('');
              } else if (bodyProp.value.type === 'ObjectExpression') {
                const queryProp = bodyProp.value.properties.find(p =>
                  ['query', 'mutation'].includes(p.key.name || p.key.value)
                );
                if (queryProp) {
                  if (queryProp.value.type === 'StringLiteral') {
                    bodyText = queryProp.value.value;
                  } else if (queryProp.value.type === 'TemplateLiteral') {
                    bodyText = queryProp.value.quasis.map(q => q.value.cooked).join('');
                  }
                }
              }

              try {
                const json = JSON.parse(bodyText);
                if (json.query) {
                  extractOperation(json.query, json.variables || variables);
                }
              } catch {
                extractOperation(bodyText, variables);
              }
            }
          }
        },
        VariableDeclarator(path) {
          if (path.node.init && path.node.init.type === 'TaggedTemplateExpression') {
            const tag = path.node.init.tag.name;
            if (GQL_TAGS.has(tag)) {
              const text = path.node.init.quasi.quasis.map(q => q.value.cooked).join('');
              extractOperation(text);
            }
          }
        }
      });
    } catch (error) {
      if (options.verbose) {
        parentPort.postMessage({ error: `Error parsing ${filePath}: ${error.message}` });
      }
    }

    parentPort.postMessage({
      operations: Array.from(operations.values()),
      filePath
    });
  });
  return;
}

async function processFiles(filePaths) {
  const bar = new cliProgress.SingleBar({
    format: '🚀 {bar} | {percentage}% | {value}/{total} files | ETA: {eta}s',
    hideCursor: true
  }, cliProgress.Presets.shades_classic);

  bar.start(filePaths.length, 0);

  const limit = pLimit(options.concurrency);
  const allOperations = new Map();
  const workers = Array.from({ length: Math.min(options.concurrency, filePaths.length) }, () => new Worker(__filename));

  const processFile = async (filePath) => {
    const worker = workers.pop();
    if (!worker) return;

    return new Promise((resolve) => {
      worker.on('message', ({ operations, error }) => {
        if (error && options.verbose) console.error(error);
        if (operations) {
          operations.forEach(op => {
            const signature = op.operation.replace(/\s+/g, ' ').trim();
            if (!allOperations.has(signature)) {
              allOperations.set(signature, op);
            }
          });
        }
        bar.increment();
        workers.push(worker);
        resolve();
      });

      fs.stat(filePath, (err, stats) => {
        if (err || stats.size > MAX_FILE_SIZE_SYNC) {
          const chunks = [];
          fs.createReadStream(filePath)
            .on('data', chunk => chunks.push(chunk))
            .on('end', () => {
              worker.postMessage({ filePath, code: Buffer.concat(chunks).toString() });
            })
            .on('error', () => {
              workers.push(worker);
              resolve();
            });
        } else {
          fs.readFile(filePath, 'utf8', (err, code) => {
            if (err) {
              workers.push(worker);
              return resolve();
            }
            worker.postMessage({ filePath, code });
          });
        }
      });
    });
  };

  await Promise.all(filePaths.map(file => limit(() => processFile(file))));
  workers.forEach(w => w.terminate());
  bar.stop();

  return Array.from(allOperations.values());
}

function generatePostmanCollection(operations) {
  return {
    info: {
      name: "GraphQL Queries",
      schema: "https://schema.getpostman.com/json/collection/v2.1.0/collection.json"
    },
    variable: [
      { key: "GRAPHQL_ENDPOINT", value: "", type: "string" }
    ],
    item: operations.map(op => ({
      name: op.name || 'AnonymousOperation',
      request: {
        method: "POST",
        header: [
          { key: "Content-Type", value: "application/json" },
          { key: "Accept", value: "application/json" }
        ],
        body: {
          mode: "graphql",
          graphql: {
            query: op.operation,
            variables: JSON.stringify(op.variables, null, 2)
          }
        },
        url: {
          raw: "{{GRAPHQL_ENDPOINT}}",
          host: ["{{GRAPHQL_ENDPOINT}}"]
        }
      }
    }))
  };
}

async function main() {
  validateRequiredVariables();

  let filePaths = [];

  if (isRemotePath(options.input)) {
    console.log(`🌐 Fetching remote JS from ${options.input}`);
    const code = await fetchRemoteCode(options.input);
    const tmpFile = path.join(__dirname, '__tmp_remote.js');
    fs.writeFileSync(tmpFile, code);
    filePaths = [tmpFile];
  } else {
    filePaths = await fg([options.input], {
      absolute: true,
      ignore: ['**/node_modules/**', '**/dist/**', '**/build/**']
    });
  }

  if (!filePaths.length) {
    console.log('ℹ️ No files found matching pattern:', options.input);
    return;
  }

  console.log(`📂 Found ${filePaths.length} files to process`);
  const queries = await processFiles(filePaths);

  if (!queries.length) {
    console.log('ℹ️ No GraphQL operations found');
    return;
  }

  fs.writeFileSync(options.output, JSON.stringify(queries, null, 2));
  console.log(`✅ Extracted ${queries.length} operations to ${options.output}`);

  if (options.postman) {
    const postmanFile = options.output.replace('.json', '.postman.json');
    fs.writeFileSync(postmanFile, JSON.stringify(generatePostmanCollection(queries), null, 2));
    console.log(`📦 Postman collection saved to ${postmanFile}`);
  }

  if (isRemotePath(options.input)) {
    fs.unlinkSync(path.join(__dirname, '__tmp_remote.js'));
  }
}

main().catch(err => {
  console.error('❌ Fatal error:', err);
  process.exit(1);
});
