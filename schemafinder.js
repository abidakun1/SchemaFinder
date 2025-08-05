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
const https = require('https');
const dns = require('dns');

// Configuration
const DEFAULT_CONCURRENCY = 4;
const MAX_FILE_SIZE_SYNC = 1024 * 1024; // 1MB

// Enhanced GraphQL patterns for minified code
const GQL_PATTERN = /(?:query|mutation|subscription|fragment)\s+([a-zA-Z0-9_]+)\s*(?:\(([^)]*)\))?\s*\{[\s\S]*?\}/gs;
const GQL_TAGS = new Set(['gql', 'graphql', 'apollo']);
const HTTP_CLIENTS = new Set(['fetch', 'axios', 'request']);

// NEW: Enhanced patterns for minified/bundled code
const MINIFIED_GQL_PATTERNS = [
  // Pattern for queries in minified bundles (more flexible spacing)
  /(?:query|mutation|subscription|fragment)\s*([a-zA-Z0-9_]*)\s*(?:\([^)]*\))?\s*\{[^{}]*(?:\{[^{}]*(?:\{[^{}]*\}[^{}]*)*\}[^{}]*)*\}/gs,

  // Pattern for template literal content in strings
  /"(?:\\.|[^"\\])*(?:query|mutation|subscription|fragment)[^"]*"/gs,

  // Pattern for escaped GraphQL in JSON-like structures
  /['"`](?:\\.|[^'"`\\])*(?:query|mutation|subscription|fragment)(?:\\.|[^'"`\\])*['"`]/gs,

  // Pattern for GraphQL operations split across lines in minified code
  /(?:query|mutation|subscription|fragment)[\s\S]{0,50}?\{[\s\S]*?\}(?=\s*[,;)\]}])/gs
];

// Pattern to detect potential GraphQL strings
const POTENTIAL_GQL_STRING = /(?:query|mutation|subscription|fragment|__typename|\bedges\b|\bnode\b|\bpageInfo\b)/i;

program
  .version('1.3.0')
  .option('-i, --input <pattern>',     'Glob/file/URL for input files')
  .option('-o, --output <file>',       'Output JSON file')
  .option('--url-list <file>',         'Text file containing JS URLs (one per line)')
  .option('--postman',                 'Generate Postman collection')
  .option('--concurrency <n>',         'Max parallel files', parseInt, DEFAULT_CONCURRENCY)
  .option('--aggressive',              'Use aggressive detection for minified code')
  .option('--verbose',                 'Verbose logging')
  .parse(process.argv);

const options = program.opts();

function isRemotePath(p) {
  return /^https?:\/\//.test(p);
}

async function fetchRemoteCode(url) {
  console.log(`🔍 Attempting to fetch: ${url}`);

  // Force IPv4 to avoid IPv6 connectivity issues
  dns.setDefaultResultOrder('ipv4first');

  const fetchOptions = {
    timeout: 30000,
    headers: {
      'User-Agent': 'Mozilla/5.0 (compatible; GraphQL-Extractor/1.3.0)',
      'Accept': 'application/javascript, text/javascript, */*',
      'Accept-Encoding': 'gzip, deflate',
      'Accept-Language': 'en-US,en;q=0.9'
    },
    // Force IPv4 agent
    agent: new https.Agent({
      family: 4, // IPv4 only
      timeout: 30000
    })
  };

  try {
    const res = await fetch(url, fetchOptions);
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`);

    const code = await res.text();
    console.log(`✅ Successfully fetched ${code.length} characters`);
    return code;
  } catch (error) {
    console.error(`❌ Fetch failed: ${error.message}`);
    if (error.code === 'ENETUNREACH' || error.code === 'ENOTFOUND') {
      console.log(`💡 Network issue detected. This is likely an IPv6 connectivity problem.`);
    }
    throw error;
  }
}

function validateRequiredVariables() {
  if (!options.input && !options.urlList) {
    console.error('❌ Error: You must provide either --input or --url-list');
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

//  Process URL list file
async function processUrlList(filePath) {
  const content = fs.readFileSync(filePath, 'utf8');
  const urls = content.split('\n')
    .map(line => line.trim())
    .filter(line => line && !line.startsWith('#') && isRemotePath(line));

  if (!urls.length) {
    console.log('ℹ️ No valid URLs found in the list');
    return [];
  }

  console.log(`🌐 Found ${urls.length} URLs to process`);

  // Create a temporary directory for downloaded files
  const tempDir = path.join(__dirname, 'url_analysis_temp');
  fs.mkdirSync(tempDir, { recursive: true });

  const limit = pLimit(options.concurrency);
  const results = [];

  for (const url of urls) {
    await limit(async () => {
      try {
        const code = await fetchRemoteCode(url);
        const safeFilename = url.replace(/[^a-z0-9]/gi, '_').slice(0, 100) + '.js';
        const filePath = path.join(tempDir, safeFilename);
        fs.writeFileSync(filePath, code);
        results.push({ filePath, origin: url });
      } catch (error) {
        console.error(`❌ Failed to process ${url}: ${error.message}`);
      }
    });
  }

  return results;
}

if (!isMainThread) {
  parentPort.on('message', ({ filePath, code, origin }) => {
    const operations = new Map();
    const detectedStrings = new Set();

    function detectGraphQLInString(str, context = 'unknown') {
      if (!str || typeof str !== 'string') return [];

      const found = [];

      if (POTENTIAL_GQL_STRING.test(str)) {
        let cleaned = str
          .replace(/\\n/g, '\n')
          .replace(/\\t/g, ' ')
          .replace(/\\"/g, '"')
          .replace(/\\'/g, "'")
          .replace(/\s+/g, ' ')
          .trim();

        const gqlMatches = [...cleaned.matchAll(GQL_PATTERN)];
        if (gqlMatches.length > 0) {
          gqlMatches.forEach(match => found.push({
            operation: match[0],
            name: match[1] || 'Anonymous',
            context: context
          }));
        } else if (options.aggressive) {
          MINIFIED_GQL_PATTERNS.forEach(pattern => {
            const matches = [...cleaned.matchAll(pattern)];
            matches.forEach(match => {
              const operation = match[0];
              if (operation.length > 20 && !detectedStrings.has(operation)) {
                detectedStrings.add(operation);
                found.push({
                  operation: operation,
                  name: extractOperationName(operation) || 'MinifiedOperation',
                  context: `${context}_minified`
                });
              }
            });
          });
        }
      }

      return found;
    }

    function extractOperationName(gqlString) {
      const nameMatch = gqlString.match(/(?:query|mutation|subscription|fragment)\s+([a-zA-Z0-9_]+)/);
      return nameMatch ? nameMatch[1] : null;
    }

    function analyzeStringLiterals(code) {
      const stringPatterns = [
        /"(?:\\.|[^"\\])*"/g,
        /'(?:\\.|[^'\\])*'/g,
        /`(?:\\.|[^`\\])*`/g
      ];

      stringPatterns.forEach(pattern => {
        const matches = [...code.matchAll(pattern)];
        matches.forEach(match => {
          const str = match[0].slice(1, -1);
          const found = detectGraphQLInString(str, 'string_literal');
          found.forEach(item => {
            const signature = item.operation.replace(/\s+/g, ' ').trim();
            if (!operations.has(signature)) {
              operations.set(signature, {
                operation: item.operation,
                name: item.name,
                variables: extractVariablesFromOperation(item.operation),
                source: filePath,
                origin: origin || filePath,
                context: item.context
              });
            }
          });
        });
      });
    }

    function extractVariablesFromOperation(operation) {
      const variables = {};

      const signatureMatch = operation.match(/\(([^)]*)\)/);
      if (signatureMatch) {
        const args = signatureMatch[1];
        args.split(',').forEach(arg => {
          const match = arg.match(/\$(\w+):\s*(\w+[!\[\]]*)/);
          if (match) {
            const [, varName, varType] = match;
            variables[varName] = getDefaultValue(varType);
          }
        });
      }

      return variables;
    }

    function extractOperation(text, variables = {}) {
      const matches = [...text.matchAll(GQL_PATTERN)];
      matches.forEach(match => {
        let [fullMatch, operationName, args] = match;

        if (!fullMatch.trim().endsWith('}')) {
          fullMatch = fullMatch + '}';
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
            source: filePath,
            origin: origin || filePath,
            context: 'standard'
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
      const isLikelyMinified = code.length > 10000 && code.split('\n').length < 50;
      if (options.verbose && isLikelyMinified) {
        parentPort.postMessage({
          error: `Detected likely minified file: ${filePath}, using enhanced detection`
        });
      }

      extractFromComments(code);

      if (options.aggressive || isLikelyMinified) {
        analyzeStringLiterals(code);
      }

      if (options.aggressive) {
        MINIFIED_GQL_PATTERNS.forEach((pattern, index) => {
          const matches = [...code.matchAll(pattern)];
          matches.forEach(match => {
            const operation = match[0];
            if (operation.length > 30 && !detectedStrings.has(operation)) {
              detectedStrings.add(operation);
              const signature = operation.replace(/\s+/g, ' ').trim();
              if (!operations.has(signature)) {
                operations.set(signature, {
                  operation: operation,
                  name: extractOperationName(operation) || `Pattern${index}_Operation`,
                  variables: extractVariablesFromOperation(operation),
                  source: filePath,
                  origin: origin || filePath,
                  context: `pattern_${index}`
                });
              }
            }
          });
        });
      }

      try {
        const ast = parser.parse(code, {
          sourceType: 'unambiguous',
          plugins: ['jsx', 'typescript', 'classProperties', 'dynamicImport'],
          tokens: true,
          allowImportExportEverywhere: true,
          allowAwaitOutsideFunction: true,
          allowReturnOutsideFunction: true,
          allowUndeclaredExports: true,
          strictMode: false
        });

        traverse(ast, {
          StringLiteral(path) {
            if (options.aggressive && path.node.value) {
              const found = detectGraphQLInString(path.node.value, 'ast_string');
              found.forEach(item => {
                const signature = item.operation.replace(/\s+/g, ' ').trim();
                if (!operations.has(signature)) {
                  operations.set(signature, {
                    operation: item.operation,
                    name: item.name,
                    variables: extractVariablesFromOperation(item.operation),
                    source: filePath,
                    origin: origin || filePath,
                    context: item.context
                  });
                }
              });
            }
          },

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
      } catch (astError) {
        if (options.verbose) {
          parentPort.postMessage({
            error: `AST parsing failed for ${filePath}, continuing with pattern matching: ${astError.message}`
          });
        }
      }
    } catch (error) {
      if (options.verbose) {
        parentPort.postMessage({ error: `Error processing ${filePath}: ${error.message}` });
      }
    }

    const operationsArray = Array.from(operations.values());
    if (options.verbose && operationsArray.length > 0) {
      parentPort.postMessage({
        error: `Found ${operationsArray.length} GraphQL operations in ${filePath}`
      });
    }

    parentPort.postMessage({
      operations: operationsArray,
      filePath,
      origin: origin || filePath
    });
  });
  return;
}

async function processFiles(fileEntries) {
  const bar = new cliProgress.SingleBar({
    format: '🚀 {bar} | {percentage}% | {value}/{total} files | ETA: {eta}s',
    hideCursor: true
  }, cliProgress.Presets.shades_classic);

  // Handle both string paths and {filePath, origin} objects
  const entries = fileEntries.map(entry => typeof entry === 'string' ?
    { filePath: entry, origin: entry } : entry);

  bar.start(entries.length, 0);

  const limit = pLimit(options.concurrency);
  const allOperations = new Map();
  const workers = Array.from({ length: Math.min(options.concurrency, entries.length) }, () => new Worker(__filename));

  const processEntry = async (entry) => {
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

      fs.stat(entry.filePath, (err, stats) => {
        if (err || stats.size > MAX_FILE_SIZE_SYNC) {
          const chunks = [];
          fs.createReadStream(entry.filePath)
            .on('data', chunk => chunks.push(chunk))
            .on('end', () => {
              worker.postMessage({
                filePath: entry.filePath,
                code: Buffer.concat(chunks).toString(),
                origin: entry.origin
              });
            })
            .on('error', () => {
              workers.push(worker);
              resolve();
            });
        } else {
          fs.readFile(entry.filePath, 'utf8', (err, code) => {
            if (err) {
              workers.push(worker);
              return resolve();
            }
            worker.postMessage({
              filePath: entry.filePath,
              code,
              origin: entry.origin
            });
          });
        }
      });
    });
  };

  await Promise.all(entries.map(entry => limit(() => processEntry(entry))));
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
      },
      event: [
        {
          listen: "prerequest",
          script: {
            type: "text/javascript",
            exec: [
              `// Detected from: ${op.source}`,
              `// Context: ${op.context || 'standard'}`,
              `// Operation: ${op.name}`
            ]
          }
        }
      ]
    }))
  };
}

async function main() {
  validateRequiredVariables();

  let fileEntries = [];

  if (options.urlList) {
    console.log(`📄 Processing URL list from: ${options.urlList}`);
    fileEntries = await processUrlList(options.urlList);
  } else if (isRemotePath(options.input)) {
    console.log(`🌐 Fetching remote JS from ${options.input}`);
    const code = await fetchRemoteCode(options.input);
    const tmpFile = path.join(__dirname, '__tmp_remote.js');
    fs.writeFileSync(tmpFile, code);
    fileEntries = [{ filePath: tmpFile, origin: options.input }];
  } else {
    const paths = await fg([options.input], {
      absolute: true,
      ignore: ['**/node_modules/**', '**/dist/**', '**/build/**']
    });
    fileEntries = paths.map(p => ({ filePath: p, origin: p }));
  }

  if (!fileEntries.length) {
    console.log('ℹ️ No files found matching pattern:', options.input || options.urlList);
    return;
  }

  console.log(`📂 Found ${fileEntries.length} files/URLs to process`);
  if (options.aggressive) {
    console.log('🔍 Aggressive mode enabled for minified code detection');
  }

  const queries = await processFiles(fileEntries);

  if (!queries.length) {
    console.log('ℹ️ No GraphQL operations found');
    if (!options.aggressive) {
      console.log('💡 Try using --aggressive flag for minified/bundled code');
    }
    return;
  }

  // Create output directory structure
  const outputDir = path.dirname(options.output);
  const baseName = path.basename(options.output, '.json');
  const urlOutputDir = path.join(outputDir, `${baseName}_sources`);
  fs.mkdirSync(urlOutputDir, { recursive: true });

  // Group operations by origin
  const operationsByOrigin = queries.reduce((acc, op) => {
    const origin = op.origin || 'unknown';
    if (!acc[origin]) acc[origin] = [];
    acc[origin].push(op);
    return acc;
  }, {});

  // Save individual origin files
  Object.entries(operationsByOrigin).forEach(([origin, ops]) => {
    const safeName = origin.replace(/[^a-z0-9]/gi, '_').slice(0, 100);
    const individualFile = path.join(urlOutputDir, `${safeName}.json`);
    fs.writeFileSync(individualFile, JSON.stringify(ops, null, 2));
  });

  // Save combined output
  const enhancedQueries = queries.map(q => ({
    ...q,
    detectedAt: new Date().toISOString(),
    toolVersion: '1.3.0'
  }));
  fs.writeFileSync(options.output, JSON.stringify(enhancedQueries, null, 2));
  console.log(`✅ Extracted ${queries.length} operations to ${options.output}`);

  // Show detection summary
  const contextSummary = queries.reduce((acc, q) => {
    acc[q.context || 'standard'] = (acc[q.context || 'standard'] || 0) + 1;
    return acc;
  }, {});

  console.log('📊 Detection Summary:');
  Object.entries(contextSummary).forEach(([context, count]) => {
    console.log(`   ${context}: ${count} operations`);
  });

  // Show origin summary
  const originSummary = queries.reduce((acc, q) => {
    const origin = q.origin || 'unknown';
    acc[origin] = (acc[origin] || 0) + 1;
    return acc;
  }, {});

  console.log('🌐 Origin Summary:');
  Object.entries(originSummary).forEach(([origin, count]) => {
    console.log(`   ${origin}: ${count} operations`);
  });

  if (options.postman) {
    const postmanFile = options.output.replace('.json', '.postman.json');
    fs.writeFileSync(postmanFile, JSON.stringify(generatePostmanCollection(queries), null, 2));
    console.log(`📦 Postman collection saved to ${postmanFile}`);
  }

  // Cleanup temporary files
  if (isRemotePath(options.input) || options.urlList) {
    const tempDir = path.join(__dirname, 'url_analysis_temp');
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true });
    }
  }
}

main().catch(err => {
  console.error('❌ Fatal error:', err);
  process.exit(1);
});
