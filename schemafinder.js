#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { Worker, isMainThread, parentPort, workerData } = require('worker_threads');
const { program } = require('commander');
const parser = require('@babel/parser');
const traverse = require('@babel/traverse').default;
const fg = require('fast-glob');
const fetch = require('node-fetch');
const cliProgress = require('cli-progress');
const pLimit = require('p-limit');
const https = require('https');
const dns = require('dns');

// ─── Configuration ────────────────────────────────────────────────────────────
const DEFAULT_CONCURRENCY = 4;
const MAX_FILE_SIZE_SYNC = 1024 * 1024; // 1MB

// ─── GQL Tag names (extended) ─────────────────────────────────────────────────
const GQL_TAGS = new Set([
  'gql', 'graphql', 'apollo', 'loader', 'parse',
  // Common aliases used after imports like: import gql from 'graphql-tag'
  'gqlTag', 'GraphQL', 'GQL', 'graphqlTag',
]);

const HTTP_CLIENTS = new Set(['fetch', 'axios', 'request', 'got', 'superagent', 'ky', '$http', 'http']);

// ─── Core GQL detection: a balanced brace extractor ─────────────────────────
// This replaces unreliable regex for the full body — we find the opening keyword
// then walk forward to collect the matching closing brace.
function extractBalancedGQL(text) {
  const ops = [];
  // Keywords that start a GQL operation
  const KW_RE = /\b(query|mutation|subscription|fragment)\b/g;
  let m;
  while ((m = KW_RE.exec(text)) !== null) {
    const start = m.index;
    // Find the opening brace
    const braceStart = text.indexOf('{', start);
    if (braceStart === -1) continue;

    let depth = 0;
    let end = -1;
    for (let i = braceStart; i < text.length; i++) {
      if (text[i] === '{') depth++;
      else if (text[i] === '}') {
        depth--;
        if (depth === 0) { end = i; break; }
      }
    }
    if (end === -1) continue;

    const raw = text.slice(start, end + 1).trim();
    if (raw.length < 10) continue; // too short to be real

    // Extract operation name (may be absent for anonymous)
    const nameMatch = raw.match(/^(?:query|mutation|subscription|fragment)\s+([A-Za-z_][A-Za-z0-9_]*)/);
    const name = nameMatch ? nameMatch[1] : 'Anonymous';

    ops.push({ raw, name });

    // Advance past this operation to avoid duplicate sub-matches
    KW_RE.lastIndex = end + 1;
  }
  return ops;
}

// ─── Variable extraction from GQL signature ──────────────────────────────────
function extractVariablesFromSignature(operation) {
  const variables = {};
  const sigMatch = operation.match(/\(([^)]+)\)/);
  if (!sigMatch) return variables;
  for (const arg of sigMatch[1].split(',')) {
    const m = arg.match(/\$(\w+)\s*:\s*([\w![\]]+)/);
    if (m) variables[m[1]] = inferDefaultValue(m[2]);
  }
  return variables;
}

function inferDefaultValue(type) {
  const t = type.replace(/[!\[\]]/g, '');
  if (/String|ID|UUID/.test(t)) return 'sample-string';
  if (/Int|Float|Number/.test(t)) return 0;
  if (/Boolean/.test(t)) return false;
  if (/\[/.test(type)) return [];
  return null;
}

// ─── String decode helpers ────────────────────────────────────────────────────
function decodeEscapes(str) {
  try {
    // Handle common escape sequences found in bundled code
    return str
      .replace(/\\u([0-9a-fA-F]{4})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
      .replace(/\\x([0-9a-fA-F]{2})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
      .replace(/\\n/g, '\n')
      .replace(/\\t/g, '\t')
      .replace(/\\r/g, '\r')
      .replace(/\\"/g, '"')
      .replace(/\\'/g, "'")
      .replace(/\\\\/g, '\\');
  } catch {
    return str;
  }
}

// ─── Attempt to decode Base64 strings that look like GQL ─────────────────────
function tryBase64GQL(str) {
  if (!/^[A-Za-z0-9+/]{20,}={0,2}$/.test(str)) return null;
  try {
    const decoded = Buffer.from(str, 'base64').toString('utf8');
    if (/\b(query|mutation|subscription|fragment)\b/.test(decoded)) return decoded;
  } catch {}
  return null;
}

// ─── Concatenation resolver: `"query " + varName + "{ ... }"` ────────────────
// Joins adjacent string literals separated by + in the source text
function resolveStringConcatenation(code) {
  // Join "..." + "..." → "......" (simple adjacent string merge for pattern detection)
  return code.replace(/["'`]\s*\+\s*["'`]/g, '');
}

// ─── The core worker logic ────────────────────────────────────────────────────
if (!isMainThread) {
  parentPort.on('message', ({ filePath, code, origin, aggressive, verbose }) => {
    const operations = new Map();

    function addOp(raw, name, context, extraVars = {}) {
      const key = raw.replace(/\s+/g, ' ').trim();
      if (key.length < 15) return; // not a real operation
      if (operations.has(key)) return;
      const variables = { ...extractVariablesFromSignature(raw), ...extraVars };
      operations.set(key, {
        operation: raw.trim(),
        name: name || 'Anonymous',
        variables,
        source: filePath,
        origin: origin || filePath,
        context,
      });
    }

    // ── PASS 1: Balanced brace extraction on raw code ─────────────────────
    const rawOps = extractBalancedGQL(code);
    rawOps.forEach(({ raw, name }) => addOp(raw, name, 'raw_code'));

    // ── PASS 2: Resolve string concatenations, then re-extract ───────────
    const concatResolved = resolveStringConcatenation(code);
    if (concatResolved !== code) {
      const concatOps = extractBalancedGQL(concatResolved);
      concatOps.forEach(({ raw, name }) => addOp(raw, name, 'concat_resolved'));
    }

    // ── PASS 3: Extract and decode all string literals ────────────────────
    // Handles single-quoted, double-quoted, template literals
    const STRING_PATTERNS = [
      // Double quoted
      /"((?:[^"\\]|\\[\s\S])*)"/g,
      // Single quoted
      /'((?:[^'\\]|\\[\s\S])*)'/g,
      // Template literals (backtick) — including multi-line
      /`((?:[^`\\]|\\[\s\S])*)`/g,
    ];

    for (const pattern of STRING_PATTERNS) {
      let m;
      pattern.lastIndex = 0;
      while ((m = pattern.exec(code)) !== null) {
        const inner = m[1];
        if (!inner || inner.length < 15) continue;

        // Quick pre-filter
        if (!/\b(query|mutation|subscription|fragment)\b/i.test(inner)) {
          // Maybe base64?
          if (aggressive) {
            const decoded = tryBase64GQL(inner);
            if (decoded) {
              extractBalancedGQL(decoded).forEach(({ raw, name }) =>
                addOp(raw, name, 'base64_decoded'));
            }
          }
          continue;
        }

        const decoded = decodeEscapes(inner);

        // Direct balanced extraction
        extractBalancedGQL(decoded).forEach(({ raw, name }) =>
          addOp(raw, name, 'string_literal'));

        // Aggressive: also try on collapsed whitespace version
        if (aggressive) {
          const collapsed = decoded.replace(/\s+/g, ' ');
          extractBalancedGQL(collapsed).forEach(({ raw, name }) =>
            addOp(raw, name, 'string_collapsed'));
        }
      }
    }

    // ── PASS 4: AST traversal (most reliable for well-formed code) ────────
    try {
      const ast = parser.parse(code, {
        sourceType: 'unambiguous',
        plugins: [
          'jsx', 'typescript', 'classProperties', 'dynamicImport',
          'optionalChaining', 'nullishCoalescingOperator',
          'decorators-legacy', 'classPrivateProperties',
        ],
        tokens: false,
        allowImportExportEverywhere: true,
        allowAwaitOutsideFunction: true,
        allowReturnOutsideFunction: true,
        allowUndeclaredExports: true,
        strictMode: false,
        errorRecovery: true, // ← keeps going despite parse errors
      });

      traverse(ast, {
        // ── Tagged template: gql`...`, graphql`...`
        TaggedTemplateExpression(nodePath) {
          const tag = nodePath.node.tag;
          const tagName =
            tag.name ||
            (tag.property && tag.property.name) ||
            (tag.callee && tag.callee.name);

          if (!tagName || !GQL_TAGS.has(tagName)) return;

          const text = nodePath.node.quasi.quasis
            .map(q => q.value.cooked || q.value.raw || '')
            .join('__EXPR__'); // placeholder for interpolated expressions

          extractBalancedGQL(text).forEach(({ raw, name }) =>
            addOp(raw, name, 'tagged_template'));
        },

        // ── String literals in AST (catches things string regex might miss)
        StringLiteral(nodePath) {
          const val = nodePath.node.value;
          if (!val || val.length < 15) return;
          if (!/\b(query|mutation|subscription|fragment)\b/i.test(val)) return;

          extractBalancedGQL(val).forEach(({ raw, name }) =>
            addOp(raw, name, 'ast_string_literal'));
        },

        // ── Template literals not tagged
        TemplateLiteral(nodePath) {
          const text = nodePath.node.quasis
            .map(q => q.value.cooked || q.value.raw || '')
            .join('');
          if (!text || text.length < 15) return;
          if (!/\b(query|mutation|subscription|fragment)\b/i.test(text)) return;

          extractBalancedGQL(text).forEach(({ raw, name }) =>
            addOp(raw, name, 'template_literal'));
        },

        // ── Call expressions: fetch/axios/request + useQuery/useMutation etc.
        CallExpression(nodePath) {
          const node = nodePath.node;
          const callee = node.callee;
          const calleeName =
            callee.name ||
            (callee.property && callee.property.name) ||
            '';

          // ── HTTP clients
          if (HTTP_CLIENTS.has(calleeName)) {
            const bodyArg = node.arguments[1];
            if (!bodyArg) return;

            const bodyText = extractStringFromNode(bodyArg);
            if (bodyText) {
              // Could be JSON body
              try {
                const parsed = JSON.parse(bodyText);
                const q = parsed.query || parsed.mutation;
                if (q) {
                  extractBalancedGQL(q).forEach(({ raw, name }) =>
                    addOp(raw, name, 'http_client_json', parsed.variables || {}));
                }
              } catch {
                extractBalancedGQL(bodyText).forEach(({ raw, name }) =>
                  addOp(raw, name, 'http_client_body'));
              }
            }
          }

          // ── Apollo / React Query hooks: useQuery, useMutation, useSubscription, useLazyQuery
          if (/^use(Query|Mutation|Subscription|LazyQuery)$/.test(calleeName)) {
            const queryArg = node.arguments[0];
            if (queryArg) {
              const text = extractStringFromNode(queryArg);
              if (text) {
                extractBalancedGQL(text).forEach(({ raw, name }) =>
                  addOp(raw, name, `hook_${calleeName}`));
              }
            }
          }

          // ── client.query({ query: ... }), client.mutate({ mutation: ... })
          if (['query', 'mutate', 'subscribe', 'watchQuery', 'readQuery', 'writeQuery'].includes(calleeName)) {
            const optionsArg = node.arguments[0];
            if (optionsArg && optionsArg.type === 'ObjectExpression') {
              const qProp = optionsArg.properties.find(p =>
                ['query', 'mutation', 'subscription', 'document'].includes(
                  (p.key || {}).name || (p.key || {}).value
                )
              );
              if (qProp) {
                const text = extractStringFromNode(qProp.value);
                if (text) {
                  extractBalancedGQL(text).forEach(({ raw, name }) =>
                    addOp(raw, name, `client_${calleeName}`));
                }
              }
            }
          }

          // ── gql() called as function (not tagged template)
          if (GQL_TAGS.has(calleeName) && node.arguments.length > 0) {
            const text = extractStringFromNode(node.arguments[0]);
            if (text) {
              extractBalancedGQL(text).forEach(({ raw, name }) =>
                addOp(raw, name, 'gql_function_call'));
            }
          }
        },

        // ── Object properties: {query: "..."}, {mutation: "..."}
        ObjectProperty(nodePath) {
          const keyName =
            (nodePath.node.key || {}).name ||
            (nodePath.node.key || {}).value;

          if (!['query', 'mutation', 'subscription', 'document', 'gql'].includes(keyName)) return;

          const text = extractStringFromNode(nodePath.node.value);
          if (!text) return;
          if (!/\b(query|mutation|subscription|fragment)\b/i.test(text)) return;

          extractBalancedGQL(text).forEach(({ raw, name }) =>
            addOp(raw, name, `object_prop_${keyName}`));
        },

        // ── Assignment: module.exports = "query ..."; window.QUERY = `...`
        AssignmentExpression(nodePath) {
          const right = nodePath.node.right;
          const text = extractStringFromNode(right);
          if (!text || text.length < 15) return;
          if (!/\b(query|mutation|subscription|fragment)\b/i.test(text)) return;

          extractBalancedGQL(text).forEach(({ raw, name }) =>
            addOp(raw, name, 'assignment'));
        },
      });
    } catch (astErr) {
      if (verbose) {
        parentPort.postMessage({ log: `AST parse error in ${filePath}: ${astErr.message}` });
      }
      // AST failed — that's fine, passes 1–3 already ran
    }

    // ── PASS 5: Comment scanning (queries sometimes live in JSDoc / comments)
    const COMMENT_RE = /\/\*[\s\S]*?\*\/|\/\/[^\n]*/g;
    let cm;
    while ((cm = COMMENT_RE.exec(code)) !== null) {
      const cleaned = cm[0].replace(/^\/\*+|\*+\/$/g, '').replace(/^\/\/\s*/gm, '');
      extractBalancedGQL(cleaned).forEach(({ raw, name }) =>
        addOp(raw, name, 'comment'));
    }

    // ── PASS 6: Webpack chunk / JSON-serialised queries ──────────────────
    // Some bundlers inline: JSON.stringify({query:"query Foo{...}"})
    // or window.__APOLLO_STATE__ = {...}
    if (aggressive) {
      const JSON_QUERY_RE = /["']query["']\s*:\s*["'`]((?:[^"'`\\]|\\.)*)["'`]/g;
      let jm;
      while ((jm = JSON_QUERY_RE.exec(code)) !== null) {
        const val = decodeEscapes(jm[1]);
        if (/\b(query|mutation|subscription|fragment)\b/i.test(val)) {
          extractBalancedGQL(val).forEach(({ raw, name }) =>
            addOp(raw, name, 'inline_json_query'));
        }
      }
    }

    const result = Array.from(operations.values());
    if (verbose && result.length > 0) {
      parentPort.postMessage({ log: `[${filePath}] Found ${result.length} operations` });
    }
    parentPort.postMessage({ operations: result, filePath, origin: origin || filePath });
  });

  return; // worker thread ends here
}

// ─── Helper: extract string value from an AST node (best effort) ─────────────
function extractStringFromNode(node) {
  if (!node) return null;
  if (node.type === 'StringLiteral') return node.value;
  if (node.type === 'Identifier') return null; // variable reference — can't resolve statically
  if (node.type === 'TemplateLiteral') {
    return node.quasis.map(q => q.value.cooked || q.value.raw || '').join('');
  }
  if (node.type === 'BinaryExpression' && node.operator === '+') {
    // "query" + " Foo" + "{ id }"
    const left = extractStringFromNode(node.left);
    const right = extractStringFromNode(node.right);
    if (left !== null && right !== null) return left + right;
    if (left !== null) return left;
    if (right !== null) return right;
  }
  if (node.type === 'TaggedTemplateExpression') {
    const tag = node.tag;
    const tagName = tag.name || (tag.property && tag.property.name);
    if (GQL_TAGS.has(tagName)) {
      return node.quasi.quasis.map(q => q.value.cooked || '').join('');
    }
  }
  return null;
}

// ─── CLI setup ────────────────────────────────────────────────────────────────
program
  .version('2.0.0')
  .option('-i, --input <pattern>',   'Glob/file/URL for input files')
  .option('-o, --output <file>',     'Output JSON file')
  .option('--url-list <file>',       'Text file containing JS URLs (one per line)')
  .option('--postman',               'Generate Postman collection')
  .option('--concurrency <n>',       'Max parallel files', parseInt, DEFAULT_CONCURRENCY)
  .option('--aggressive',            'Enable all detection passes (slower but catches more)')
  .option('--verbose',               'Verbose logging')
  .parse(process.argv);

const options = program.opts();

// ─── Utilities ────────────────────────────────────────────────────────────────
function isRemotePath(p) { return /^https?:\/\//.test(p); }

function validateRequiredVariables() {
  if (!options.input && !options.urlList) {
    console.error('❌  --input or --url-list is required');
    program.help({ error: true });
  }
  if (!options.output || typeof options.output !== 'string') {
    console.error('❌  --output <file> is required');
    program.help({ error: true });
  }
  if (isNaN(options.concurrency) || options.concurrency < 1) {
    console.error('❌  --concurrency must be a positive integer');
    process.exit(1);
  }
}

async function fetchRemoteCode(url) {
  console.log(`🔍 Fetching: ${url}`);
  dns.setDefaultResultOrder('ipv4first');

  const res = await fetch(url, {
    timeout: 30000,
    headers: {
      'User-Agent': 'Mozilla/5.0 (compatible; GQL-Extractor/2.0)',
      'Accept': 'application/javascript, text/javascript, */*',
      'Accept-Encoding': 'gzip, deflate',
    },
    agent: new https.Agent({ family: 4, timeout: 30000 }),
  });

  if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`);
  const code = await res.text();
  console.log(`✅ Fetched ${code.length} chars from ${url}`);
  return code;
}

async function processUrlList(filePath) {
  const urls = fs.readFileSync(filePath, 'utf8')
    .split('\n')
    .map(l => l.trim())
    .filter(l => l && !l.startsWith('#') && isRemotePath(l));

  if (!urls.length) { console.log('ℹ️  No valid URLs in list'); return []; }
  console.log(`🌐 ${urls.length} URLs to process`);

  const tempDir = path.join(__dirname, '__gql_temp__');
  fs.mkdirSync(tempDir, { recursive: true });

  const limit = pLimit(options.concurrency);
  const entries = [];

  await Promise.all(urls.map(url => limit(async () => {
    try {
      const code = await fetchRemoteCode(url);
      const name = url.replace(/[^a-z0-9]/gi, '_').slice(0, 100) + '.js';
      const fp = path.join(tempDir, name);
      fs.writeFileSync(fp, code);
      entries.push({ filePath: fp, origin: url });
    } catch (e) {
      console.error(`❌ ${url}: ${e.message}`);
    }
  })));

  return entries;
}

// ─── Worker pool manager ──────────────────────────────────────────────────────
async function processFiles(fileEntries) {
  if (!fileEntries.length) return [];

  const entries = fileEntries.map(e =>
    typeof e === 'string' ? { filePath: e, origin: e } : e);

  const bar = new cliProgress.SingleBar({
    format: '🚀 {bar} | {percentage}% | {value}/{total} files | ETA: {eta}s',
    hideCursor: true,
  }, cliProgress.Presets.shades_classic);
  bar.start(entries.length, 0);

  const poolSize = Math.min(options.concurrency, entries.length);
  const allOps = new Map();

  // Create a proper worker pool with a job queue
  const idle = []; // idle workers
  const pending = []; // pending resolve callbacks waiting for a worker

  function spawnWorker() {
    const w = new Worker(__filename);
    w.on('message', ({ operations, log, filePath }) => {
      if (log && options.verbose) console.log('\n' + log);
      if (operations) {
        operations.forEach(op => {
          const key = op.operation.replace(/\s+/g, ' ').trim();
          if (!allOps.has(key)) allOps.set(key, op);
        });
      }
      bar.increment();
      // Give the worker back
      if (pending.length > 0) {
        const next = pending.shift();
        next(w);
      } else {
        idle.push(w);
      }
    });
    w.on('error', err => {
      if (options.verbose) console.error('\nWorker error:', err.message);
    });
    return w;
  }

  for (let i = 0; i < poolSize; i++) idle.push(spawnWorker());

  function getWorker() {
    if (idle.length > 0) return Promise.resolve(idle.pop());
    return new Promise(resolve => pending.push(resolve));
  }

  async function readFile(fp) {
    return new Promise((resolve, reject) => {
      fs.stat(fp, (err, stats) => {
        if (err) { reject(err); return; }
        if (stats.size > MAX_FILE_SIZE_SYNC) {
          const chunks = [];
          fs.createReadStream(fp)
            .on('data', c => chunks.push(c))
            .on('end', () => resolve(Buffer.concat(chunks).toString()))
            .on('error', reject);
        } else {
          fs.readFile(fp, 'utf8', (e, d) => e ? reject(e) : resolve(d));
        }
      });
    });
  }

  const limit = pLimit(options.concurrency * 2); // read-ahead

  await Promise.all(entries.map(entry => limit(async () => {
    let code;
    try { code = await readFile(entry.filePath); }
    catch { bar.increment(); return; }

    const w = await getWorker();
    w.postMessage({
      filePath: entry.filePath,
      code,
      origin: entry.origin,
      aggressive: !!options.aggressive,
      verbose: !!options.verbose,
    });
    // worker's 'message' handler above handles completion + recycling
  })));

  // Wait for all workers to finish
  await new Promise(resolve => {
    const check = () => {
      if (idle.length === poolSize) resolve();
      else setTimeout(check, 50);
    };
    check();
  });

  idle.forEach(w => w.terminate());
  bar.stop();

  return Array.from(allOps.values());
}

// ─── Postman collection generator ────────────────────────────────────────────
function generatePostmanCollection(operations) {
  return {
    info: {
      name: 'GraphQL Queries (extracted)',
      schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json',
    },
    variable: [{ key: 'GRAPHQL_ENDPOINT', value: '', type: 'string' }],
    item: operations.map(op => ({
      name: op.name || 'AnonymousOperation',
      request: {
        method: 'POST',
        header: [
          { key: 'Content-Type', value: 'application/json' },
          { key: 'Accept',       value: 'application/json' },
        ],
        body: {
          mode: 'graphql',
          graphql: {
            query: op.operation,
            variables: JSON.stringify(op.variables, null, 2),
          },
        },
        url: { raw: '{{GRAPHQL_ENDPOINT}}', host: ['{{GRAPHQL_ENDPOINT}}'] },
      },
      event: [{
        listen: 'prerequest',
        script: {
          type: 'text/javascript',
          exec: [
            `// Source:  ${op.source}`,
            `// Context: ${op.context}`,
            `// Origin:  ${op.origin}`,
          ],
        },
      }],
    })),
  };
}

// ─── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  validateRequiredVariables();

  let fileEntries = [];

  if (options.urlList) {
    console.log(`📄 Processing URL list: ${options.urlList}`);
    fileEntries = await processUrlList(options.urlList);
  } else if (isRemotePath(options.input)) {
    console.log(`🌐 Fetching remote file: ${options.input}`);
    const code = await fetchRemoteCode(options.input);
    const tmp = path.join(__dirname, '__tmp_remote__.js');
    fs.writeFileSync(tmp, code);
    fileEntries = [{ filePath: tmp, origin: options.input }];
  } else {
    const paths = await fg([options.input], {
      absolute: true,
      ignore: ['**/node_modules/**', '**/dist/**', '**/build/**'],
    });
    fileEntries = paths.map(p => ({ filePath: p, origin: p }));
  }

  if (!fileEntries.length) {
    console.log('ℹ️  No files found for:', options.input || options.urlList);
    return;
  }

  console.log(`📂 Processing ${fileEntries.length} file(s)`);
  if (options.aggressive) console.log('🔍 Aggressive mode active');

  const queries = await processFiles(fileEntries);

  if (!queries.length) {
    console.log('ℹ️  No GraphQL operations found.');
    console.log('💡 Try --aggressive for minified/bundled code.');
    return;
  }

  // ── Output structure ─────────────────────────────────────────────────────
  const outDir  = path.dirname(options.output);
  const outBase = path.basename(options.output, '.json');
  const srcDir  = path.join(outDir, `${outBase}_sources`);
  fs.mkdirSync(srcDir, { recursive: true });

  // Group by origin
  const byOrigin = {};
  queries.forEach(op => {
    const k = op.origin || 'unknown';
    (byOrigin[k] = byOrigin[k] || []).push(op);
  });
  Object.entries(byOrigin).forEach(([origin, ops]) => {
    const name = origin.replace(/[^a-z0-9]/gi, '_').slice(0, 100) + '.json';
    fs.writeFileSync(path.join(srcDir, name), JSON.stringify(ops, null, 2));
  });

  // Combined output
  const enriched = queries.map(q => ({
    ...q,
    detectedAt: new Date().toISOString(),
    toolVersion: '2.0.0',
  }));
  fs.writeFileSync(options.output, JSON.stringify(enriched, null, 2));
  console.log(`\n✅ ${queries.length} operations → ${options.output}`);

  // Summary
  const ctxSummary = {};
  queries.forEach(q => { ctxSummary[q.context] = (ctxSummary[q.context] || 0) + 1; });
  console.log('\n📊 Detection breakdown:');
  Object.entries(ctxSummary).sort((a, b) => b[1] - a[1]).forEach(([ctx, n]) =>
    console.log(`   ${ctx.padEnd(30)} ${n}`));

  if (options.postman) {
    const pmFile = options.output.replace('.json', '.postman.json');
    fs.writeFileSync(pmFile, JSON.stringify(generatePostmanCollection(queries), null, 2));
    console.log(`\n📦 Postman collection → ${pmFile}`);
  }

  // Cleanup temp files
  const tempDir = path.join(__dirname, '__gql_temp__');
  if (fs.existsSync(tempDir)) fs.rmSync(tempDir, { recursive: true });
  const tmpRemote = path.join(__dirname, '__tmp_remote__.js');
  if (fs.existsSync(tmpRemote)) fs.unlinkSync(tmpRemote);
}

main().catch(err => {
  console.error('❌ Fatal:', err.message);
  if (options.verbose) console.error(err.stack);
  process.exit(1);
});
