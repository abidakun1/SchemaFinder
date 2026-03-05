#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { Worker, isMainThread, parentPort } = require('worker_threads');
const { program } = require('commander');
const parser = require('@babel/parser');
const traverse = require('@babel/traverse').default;
const fg = require('fast-glob');
const fetch = require('node-fetch');
const { parse: parseGQL, print: printGQL, buildClientSchema, getIntrospectionQuery } = require('graphql');
const cliProgress = require('cli-progress');
const pLimit = require('p-limit');
const https = require('https');
const dns = require('dns');

// ─── Configuration ────────────────────────────────────────────────────────────
const DEFAULT_CONCURRENCY = 4;
const MAX_FILE_SIZE_SYNC = 1024 * 1024;
const FETCH_TIMEOUT_MS = 30_000;
const FETCH_RETRIES = 3;
const FETCH_RETRY_BASE_MS = 800;

// ─── GQL Tag names ────────────────────────────────────────────────────────────
const GQL_TAGS = new Set([
  'gql', 'graphql', 'apollo', 'loader', 'parse',
  'gqlTag', 'GraphQL', 'GQL', 'graphqlTag',
]);

const HTTP_CLIENTS = new Set([
  'fetch', 'axios', 'request', 'got', 'superagent', 'ky', '$http', 'http',
]);

// ─── GQL validator ────────────────────────────────────────────────────────────
function validateAndNormalise(raw) {
  try {
    return printGQL(parseGQL(raw)).trim();
  } catch {
    return null;
  }
}

// ─── Balanced brace extractor ─────────────────────────────────────────────────
function extractBalancedGQL(text) {
  const ops = [];
  const KW_RE = /\b(query|mutation|subscription|fragment)\b/g;
  let m;
  while ((m = KW_RE.exec(text)) !== null) {
    const start = m.index;
    const braceStart = text.indexOf('{', start);
    if (braceStart === -1) continue;

    let depth = 0, end = -1;
    for (let i = braceStart; i < text.length; i++) {
      if (text[i] === '{') depth++;
      else if (text[i] === '}') {
        depth--;
        if (depth === 0) { end = i; break; }
      }
    }
    if (end === -1) continue;

    const raw = text.slice(start, end + 1).trim();
    if (raw.length < 10) continue;

    const nameMatch = raw.match(/^(?:query|mutation|subscription|fragment)\s+([A-Za-z_][A-Za-z0-9_]*)/);
    ops.push({ raw, name: nameMatch ? nameMatch[1] : 'Anonymous' });
    KW_RE.lastIndex = end + 1;
  }
  return ops;
}

// ─── Variable extraction ──────────────────────────────────────────────────────
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
    return str
      .replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
      .replace(/\\x([0-9a-fA-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
      .replace(/\\n/g, '\n').replace(/\\t/g, '\t')
      .replace(/\\r/g, '\r').replace(/\\"/g, '"')
      .replace(/\\'/g, "'").replace(/\\\\/g, '\\');
  } catch { return str; }
}

// ─── Base64 GQL detector ──────────────────────────────────────────────────────
function tryBase64GQL(str) {
  if (!/^[A-Za-z0-9+/]{20,}={0,2}$/.test(str)) return null;
  try {
    const decoded = Buffer.from(str, 'base64').toString('utf8');
    if (/\b(query|mutation|subscription|fragment)\b/.test(decoded)) return decoded;
  } catch {}
  return null;
}

// ─── Concatenation resolver ───────────────────────────────────────────────────
function resolveStringConcatenation(code) {
  return code
    .replace(/'\s*\+\s*'/g, '')
    .replace(/"\s*\+\s*"/g, '')
    .replace(/`\s*\+\s*`/g, '');
}

// ─── INTROSPECTION ────────────────────────────────────────────────────────────

// Sends a full introspection query to the endpoint and returns the raw result
async function fetchIntrospectionSchema(endpoint, headers) {
  console.log(`\n🔭 Running introspection on: ${endpoint}`);

  const res = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      ...headers,
    },
    body: JSON.stringify({ query: getIntrospectionQuery() }),
    agent: /^https/.test(endpoint)
      ? new https.Agent({ family: 4, timeout: FETCH_TIMEOUT_MS })
      : undefined,
  });

  if (!res.ok) throw new Error(`Introspection HTTP ${res.status}: ${res.statusText}`);

  const json = await res.json();
  if (json.errors) throw new Error(`Introspection errors: ${JSON.stringify(json.errors)}`);
  if (!json.data) throw new Error('Introspection returned no data');

  return json.data;
}

// Extracts every query, mutation, and subscription the server exposes
// Returns an array of SchemaFinder-compatible operation objects
function extractOperationsFromSchema(introspectionData, endpoint) {
  const schema = buildClientSchema(introspectionData);
  const ops = [];

  const typeMap = {
    query:        schema.getQueryType(),
    mutation:     schema.getMutationType(),
    subscription: schema.getSubscriptionType(),
  };

  for (const [opType, rootType] of Object.entries(typeMap)) {
    if (!rootType) continue;

    const fields = rootType.getFields();
    for (const [fieldName, field] of Object.entries(fields)) {
      // Build a minimal but valid operation for each root field
      const args = field.args || [];
      const argSignature = args.length
        ? `(${args.map(a => `$${a.name}: ${a.type}`).join(', ')})`
        : '';
      const argPass = args.length
        ? `(${args.map(a => `${a.name}: $${a.name}`).join(', ')})`
        : '';

      // Build field selection — go 2 levels deep for scalar fields
      const selection = buildSelection(field.type, 2);

      const raw = `${opType} ${capitalise(fieldName)}${argSignature} {\n  ${fieldName}${argPass}${selection}\n}`;
      const normalised = validateAndNormalise(raw);
      if (!normalised) continue;

      const variables = {};
      args.forEach(a => {
        variables[a.name] = inferDefaultValue(String(a.type));
      });

      ops.push({
        operation: normalised,
        name: capitalise(fieldName),
        variables,
        source: endpoint,
        origin: endpoint,
        context: 'introspection',
        detectedAt: new Date().toISOString(),
        toolVersion: '2.2.0',
      });
    }
  }

  return ops;
}

// Recursively unwrap GraphQL type wrappers (NonNull, List) to get the named type
function unwrapType(type) {
  if (type.ofType) return unwrapType(type.ofType);
  return type;
}

// Build a minimal field selection set, going `depth` levels deep
function buildSelection(type, depth) {
  if (depth === 0) return '';
  const named = unwrapType(type);
  if (!named.getFields) return ''; // scalar — no selection needed

  try {
    const fields = named.getFields();
    const scalarFields = Object.entries(fields)
      .filter(([, f]) => !unwrapType(f.type).getFields) // only scalars at this level
      .slice(0, 5) // cap at 5 fields to keep output readable
      .map(([name]) => name);

    if (!scalarFields.length) return '';
    return ` {\n    ${scalarFields.join('\n    ')}\n  }`;
  } catch {
    return '';
  }
}

function capitalise(str) {
  return str.charAt(0).toUpperCase() + str.slice(1);
}

// Compare JS-extracted ops vs introspection ops and tag each with its coverage status
function crossReference(jsOps, introspectionOps) {
  const jsNames = new Set(jsOps.map(op => op.name.toLowerCase()));
  const introNames = new Set(introspectionOps.map(op => op.name.toLowerCase()));

  // Tag JS ops
  const taggedJs = jsOps.map(op => ({
    ...op,
    coverage: introNames.has(op.name.toLowerCase()) ? 'confirmed' : 'js_only',
  }));

  // Only add introspection ops that are NOT already in JS output (the gap)
  const hiddenOps = introspectionOps
    .filter(op => !jsNames.has(op.name.toLowerCase()))
    .map(op => ({ ...op, coverage: 'server_only' }));

  return { taggedJs, hiddenOps };
}

// ─── Worker logic ─────────────────────────────────────────────────────────────
if (!isMainThread) {
  parentPort.on('message', ({ filePath, code, origin, aggressive, verbose }) => {
    const operations = new Map();

    function addOp(raw, name, context, extraVars = {}) {
      const normalised = validateAndNormalise(raw);
      if (!normalised) return;
      if (operations.has(normalised)) return;
      const variables = { ...extractVariablesFromSignature(raw), ...extraVars };
      operations.set(normalised, {
        operation: normalised,
        name: name || 'Anonymous',
        variables,
        source: filePath,
        origin: origin || filePath,
        context,
      });
    }

    // ── PASS 1: Raw balanced brace extraction ─────────────────────────────
    extractBalancedGQL(code).forEach(({ raw, name }) => addOp(raw, name, 'raw_code'));

    // ── PASS 2: Concatenation resolver ────────────────────────────────────
    const concatResolved = resolveStringConcatenation(code);
    if (concatResolved !== code) {
      extractBalancedGQL(concatResolved).forEach(({ raw, name }) =>
        addOp(raw, name, 'concat_resolved'));
    }

    // ── PASS 3: String literal decode ─────────────────────────────────────
    const STRING_PATTERNS = [
      /"((?:[^"\\]|\\[\s\S])*)"/g,
      /'((?:[^'\\]|\\[\s\S])*)'/g,
      /`((?:[^`\\]|\\[\s\S])*)`/g,
    ];

    for (const pattern of STRING_PATTERNS) {
      let m;
      pattern.lastIndex = 0;
      while ((m = pattern.exec(code)) !== null) {
        const inner = m[1];
        if (!inner || inner.length < 15) continue;

        if (!/\b(query|mutation|subscription|fragment)\b/i.test(inner)) {
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
        extractBalancedGQL(decoded).forEach(({ raw, name }) =>
          addOp(raw, name, 'string_literal'));

        if (aggressive) {
          const collapsed = decoded.replace(/\s+/g, ' ');
          extractBalancedGQL(collapsed).forEach(({ raw, name }) =>
            addOp(raw, name, 'string_collapsed'));
        }
      }
    }

    // ── PASS 4: AST traversal ─────────────────────────────────────────────
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
        errorRecovery: true,
      });

      traverse(ast, {
        TaggedTemplateExpression(nodePath) {
          const tag = nodePath.node.tag;
          const tagName =
            tag.name ||
            (tag.property && tag.property.name) ||
            (tag.callee && tag.callee.name);
          if (!tagName || !GQL_TAGS.has(tagName)) return;
          const text = nodePath.node.quasi.quasis
            .map(q => q.value.cooked || q.value.raw || '')
            .join('__EXPR__');
          extractBalancedGQL(text).forEach(({ raw, name }) =>
            addOp(raw, name, 'tagged_template'));
        },

        StringLiteral(nodePath) {
          const val = nodePath.node.value;
          if (!val || val.length < 15) return;
          if (!/\b(query|mutation|subscription|fragment)\b/i.test(val)) return;
          extractBalancedGQL(val).forEach(({ raw, name }) =>
            addOp(raw, name, 'ast_string_literal'));
        },

        TemplateLiteral(nodePath) {
          const text = nodePath.node.quasis
            .map(q => q.value.cooked || q.value.raw || '')
            .join('');
          if (!text || text.length < 15) return;
          if (!/\b(query|mutation|subscription|fragment)\b/i.test(text)) return;
          extractBalancedGQL(text).forEach(({ raw, name }) =>
            addOp(raw, name, 'template_literal'));
        },

        CallExpression(nodePath) {
          const node = nodePath.node;
          const callee = node.callee;
          const calleeName =
            callee.name ||
            (callee.property && callee.property.name) || '';

          if (HTTP_CLIENTS.has(calleeName)) {
            const bodyArg = node.arguments[1];
            if (!bodyArg) return;
            const bodyText = extractStringFromNode(bodyArg);
            if (bodyText) {
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

          if (/^use(Query|Mutation|Subscription|LazyQuery)$/.test(calleeName)) {
            const queryArg = node.arguments[0];
            if (queryArg) {
              const text = extractStringFromNode(queryArg);
              if (text) extractBalancedGQL(text).forEach(({ raw, name }) =>
                addOp(raw, name, `hook_${calleeName}`));
            }
          }

          if (['query', 'mutate', 'subscribe', 'watchQuery', 'readQuery', 'writeQuery'].includes(calleeName)) {
            const optionsArg = node.arguments[0];
            if (optionsArg && optionsArg.type === 'ObjectExpression') {
              const qProp = optionsArg.properties.find(p =>
                ['query', 'mutation', 'subscription', 'document'].includes(
                  (p.key || {}).name || (p.key || {}).value));
              if (qProp) {
                const text = extractStringFromNode(qProp.value);
                if (text) extractBalancedGQL(text).forEach(({ raw, name }) =>
                  addOp(raw, name, `client_${calleeName}`));
              }
            }
          }

          if (GQL_TAGS.has(calleeName) && node.arguments.length > 0) {
            const text = extractStringFromNode(node.arguments[0]);
            if (text) extractBalancedGQL(text).forEach(({ raw, name }) =>
              addOp(raw, name, 'gql_function_call'));
          }
        },

        ObjectProperty(nodePath) {
          const keyName =
            (nodePath.node.key || {}).name ||
            (nodePath.node.key || {}).value;
          if (!['query', 'mutation', 'subscription', 'document', 'gql'].includes(keyName)) return;
          const text = extractStringFromNode(nodePath.node.value);
          if (!text || !/\b(query|mutation|subscription|fragment)\b/i.test(text)) return;
          extractBalancedGQL(text).forEach(({ raw, name }) =>
            addOp(raw, name, `object_prop_${keyName}`));
        },

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
      if (verbose) parentPort.postMessage({
        log: `[AST] parse error in ${filePath}: ${astErr.message}`,
      });
    }

    // ── PASS 5: Comment scanning ──────────────────────────────────────────
    const COMMENT_RE = /\/\*[\s\S]*?\*\/|\/\/[^\n]*/g;
    let cm;
    while ((cm = COMMENT_RE.exec(code)) !== null) {
      const cleaned = cm[0].replace(/^\/\*+|\*+\/$/g, '').replace(/^\/\/\s*/gm, '');
      extractBalancedGQL(cleaned).forEach(({ raw, name }) =>
        addOp(raw, name, 'comment'));
    }

    // ── PASS 6: Webpack / JSON-serialised queries (aggressive only) ───────
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

  return;
}

// ─── AST string extractor ─────────────────────────────────────────────────────
function extractStringFromNode(node) {
  if (!node) return null;
  if (node.type === 'StringLiteral') return node.value;
  if (node.type === 'Identifier') return null;
  if (node.type === 'TemplateLiteral') {
    return node.quasis.map(q => q.value.cooked || q.value.raw || '').join('');
  }
  if (node.type === 'BinaryExpression' && node.operator === '+') {
    const left = extractStringFromNode(node.left);
    const right = extractStringFromNode(node.right);
    if (left !== null && right !== null) return left + right;
    return left ?? right;
  }
  if (node.type === 'TaggedTemplateExpression') {
    const tagName = node.tag.name || (node.tag.property && node.tag.property.name);
    if (GQL_TAGS.has(tagName)) {
      return node.quasi.quasis.map(q => q.value.cooked || '').join('');
    }
  }
  return null;
}

// ─── CLI setup ────────────────────────────────────────────────────────────────
program
  .version('2.2.0')
  .option('-i, --input <pattern>',    'Glob/file/URL for input files')
  .option('-o, --output <file>',      'Output JSON file (required)')
  .option('--url-list <file>',        'Text file containing JS URLs (one per line)')
  .option('--endpoint <url>',         'GraphQL endpoint URL to run introspection against')
  .option('--postman',                'Generate Postman collection')
  .option('--concurrency <n>',        'Max parallel files', parseInt, DEFAULT_CONCURRENCY)
  .option('--aggressive',             'Enable all detection passes (slower, catches more)')
  .option('--verbose',                'Verbose logging')
  .option('--headers <json>',         'JSON headers e.g. \'{"Authorization":"Bearer TOKEN","Cookie":"s=abc"}\'')
  .option('--retries <n>',            'Fetch retry attempts for remote files', parseInt, FETCH_RETRIES)
  .parse(process.argv);

const options = program.opts();

// ─── Parse --headers ──────────────────────────────────────────────────────────
let customHeaders = {};
if (options.headers) {
  try {
    customHeaders = JSON.parse(options.headers);
    if (typeof customHeaders !== 'object' || Array.isArray(customHeaders)) {
      throw new Error('must be a JSON object');
    }
  } catch (e) {
    console.error(`❌ Invalid --headers value: ${e.message}`);
    process.exit(1);
  }
}

// ─── Validation ───────────────────────────────────────────────────────────────
function validateRequiredVariables() {
  // At least one of --input, --url-list, or --endpoint must be provided
  if (!options.input && !options.urlList && !options.endpoint) {
    console.error('❌  --input, --url-list, or --endpoint is required');
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

function isRemotePath(p) { return /^https?:\/\//.test(p); }

// ─── Fetch with retry ─────────────────────────────────────────────────────────
async function fetchWithRetry(url) {
  const retries = options.retries ?? FETCH_RETRIES;
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  dns.setDefaultResultOrder('ipv4first');

  for (let attempt = 1; attempt <= retries + 1; attempt++) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

      const res = await fetch(url, {
        signal: controller.signal,
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; SchemaFinder/2.2)',
          'Accept': 'application/javascript, text/javascript, */*',
          'Accept-Encoding': 'gzip, deflate',
          ...customHeaders,
        },
        agent: new https.Agent({ family: 4, timeout: FETCH_TIMEOUT_MS }),
      });
      clearTimeout(timer);

      if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`);
      const code = await res.text();
      if (options.verbose) console.log(`✅ Fetched ${code.length.toLocaleString()} chars — ${url}`);
      return code;
    } catch (err) {
      if (attempt > retries) throw err;
      const delay = FETCH_RETRY_BASE_MS * Math.pow(2, attempt - 1) + Math.random() * 200;
      if (options.verbose) console.warn(`⚠️  Attempt ${attempt} failed (${err.message}) — retrying in ${Math.round(delay)}ms`);
      await sleep(delay);
    }
  }
}

// ─── URL list processor ───────────────────────────────────────────────────────
async function processUrlList(filePath) {
  const urls = fs.readFileSync(filePath, 'utf8')
    .split('\n')
    .map(l => l.trim())
    .filter(l => l && !l.startsWith('#') && isRemotePath(l));

  if (!urls.length) { console.log('ℹ️  No valid URLs in list'); return []; }
  console.log(`🌐 ${urls.length} URLs to process`);

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'schemafinder-'));
  const limit = pLimit(options.concurrency);
  const entries = [];

  await Promise.all(urls.map(url => limit(async () => {
    try {
      const code = await fetchWithRetry(url);
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

// ─── Worker pool ──────────────────────────────────────────────────────────────
async function processFiles(fileEntries) {
  if (!fileEntries.length) return [];

  const entries = fileEntries.map(e =>
    typeof e === 'string' ? { filePath: e, origin: e } : e);

  const bar = new cliProgress.SingleBar({
    format: '🚀 {bar} | {percentage}% | {value}/{total} files | ETA: {eta}s',
    hideCursor: true,
  }, cliProgress.Presets.shades_classic);
  bar.start(entries.length, 0);

  const allOps = new Map();
  const poolSize = Math.min(options.concurrency, entries.length);

  const workerQueue = [];
  const waitQueue = [];
  let activeWorkers = 0;
  let completedJobs = 0;
  let resolveAll;
  const allDone = new Promise(r => { resolveAll = r; });

  function releaseWorker(w) {
    if (waitQueue.length > 0) waitQueue.shift()(w);
    else workerQueue.push(w);
  }

  function acquireWorker() {
    if (workerQueue.length > 0) return Promise.resolve(workerQueue.pop());
    if (activeWorkers < poolSize) { activeWorkers++; return Promise.resolve(spawnWorker()); }
    return new Promise(resolve => waitQueue.push(resolve));
  }

  function spawnWorker() {
    const w = new Worker(__filename);
    w.on('message', ({ operations, log }) => {
      if (log && options.verbose) process.stdout.write('\n' + log + '\n');
      if (operations) {
        operations.forEach(op => {
          if (!allOps.has(op.operation)) allOps.set(op.operation, op);
        });
        bar.increment();
        completedJobs++;
        releaseWorker(w);
        if (completedJobs === entries.length) resolveAll();
      }
    });
    w.on('error', err => {
      if (options.verbose) process.stderr.write(`\nWorker error: ${err.message}\n`);
      bar.increment();
      completedJobs++;
      releaseWorker(w);
      if (completedJobs === entries.length) resolveAll();
    });
    return w;
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

  const readLimit = pLimit(poolSize * 2);

  await Promise.all(entries.map(entry => readLimit(async () => {
    let code;
    try { code = await readFile(entry.filePath); }
    catch {
      bar.increment();
      completedJobs++;
      if (completedJobs === entries.length) resolveAll();
      return;
    }
    const w = await acquireWorker();
    w.postMessage({
      filePath: entry.filePath,
      code,
      origin: entry.origin,
      aggressive: !!options.aggressive,
      verbose: !!options.verbose,
    });
  })));

  await allDone;
  workerQueue.forEach(w => w.terminate());
  bar.stop();

  return Array.from(allOps.values());
}

// ─── Postman collection generator ────────────────────────────────────────────
function generatePostmanCollection(operations) {
  return {
    info: {
      name: 'GraphQL Queries — SchemaFinder',
      schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json',
    },
    variable: [{ key: 'GRAPHQL_ENDPOINT', value: options.endpoint || '', type: 'string' }],
    item: operations.map(op => ({
      name: `[${op.coverage || op.context}] ${op.name || 'AnonymousOperation'}`,
      request: {
        method: 'POST',
        header: [
          { key: 'Content-Type', value: 'application/json' },
          { key: 'Accept',       value: 'application/json' },
          ...Object.entries(customHeaders).map(([k, v]) => ({ key: k, value: v })),
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
            `// Source:   ${op.source}`,
            `// Context:  ${op.context}`,
            `// Coverage: ${op.coverage || 'n/a'}`,
          ],
        },
      }],
    })),
  };
}

// ─── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  validateRequiredVariables();

  let jsQueries = [];
  let tempDir = null;

  // ── Step 1: JS extraction (if --input or --url-list provided) ────────────
  if (options.input || options.urlList) {
    let fileEntries = [];

    if (options.urlList) {
      console.log(`📄 Processing URL list: ${options.urlList}`);
      fileEntries = await processUrlList(options.urlList);
      if (fileEntries.length > 0) tempDir = path.dirname(fileEntries[0].filePath);
    } else if (isRemotePath(options.input)) {
      console.log(`🌐 Fetching: ${options.input}`);
      const code = await fetchWithRetry(options.input);
      tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'schemafinder-'));
      const tmp = path.join(tempDir, '__remote__.js');
      fs.writeFileSync(tmp, code);
      fileEntries = [{ filePath: tmp, origin: options.input }];
    } else {
      const paths = await fg([options.input], {
        absolute: true,
        ignore: ['**/node_modules/**', '**/dist/**', '**/build/**'],
      });
      fileEntries = paths.map(p => ({ filePath: p, origin: p }));
    }

    if (fileEntries.length) {
      console.log(`📂 Processing ${fileEntries.length} file(s)${options.aggressive ? ' [aggressive mode]' : ''}`);
      jsQueries = await processFiles(fileEntries);
      console.log(`   Found ${jsQueries.length} operations in JS code`);
    } else {
      console.log('ℹ️  No files found.');
    }
  }

  // ── Step 2: Introspection (if --endpoint provided) ────────────────────────
  let finalQueries = jsQueries;

  if (options.endpoint) {
    try {
      const introspectionData = await fetchIntrospectionSchema(options.endpoint, customHeaders);
      const introspectionOps = extractOperationsFromSchema(introspectionData, options.endpoint);
      console.log(`   Found ${introspectionOps.length} operations via introspection`);

      if (jsQueries.length > 0) {
        // Cross-reference JS ops against server schema
        const { taggedJs, hiddenOps } = crossReference(jsQueries, introspectionOps);

        const confirmed = taggedJs.filter(o => o.coverage === 'confirmed').length;
        const jsOnly    = taggedJs.filter(o => o.coverage === 'js_only').length;

        console.log('\n🗺️  Coverage report:');
        console.log(`   ✅ Confirmed (in JS + server):  ${confirmed}`);
        console.log(`   🟡 JS only (not on server):     ${jsOnly}`);
        console.log(`   🔴 Server only (hidden ops):    ${hiddenOps.length}`);

        if (hiddenOps.length > 0) {
          console.log('\n🚨 Hidden operations (server exposes, frontend never calls):');
          hiddenOps.forEach(op => console.log(`   → ${op.name}`));
        }

        finalQueries = [...taggedJs, ...hiddenOps];
      } else {
        // Pure introspection mode — no JS files
        finalQueries = introspectionOps;
        console.log(`   Pure introspection mode — ${introspectionOps.length} operations`);
      }
    } catch (err) {
      console.error(`\n⚠️  Introspection failed: ${err.message}`);
      console.error('   Continuing with JS extraction results only.');
      if (options.verbose) console.error(err.stack);
    }
  }

  if (!finalQueries.length) {
    console.log('\nℹ️  No GraphQL operations found.');
    console.log('💡 Tips:');
    console.log('   • Try --aggressive for minified/bundled code');
    console.log('   • Add --endpoint to probe the server directly');
    return;
  }

  // ── Step 3: Output ────────────────────────────────────────────────────────
  const outDir  = path.dirname(options.output);
  const outBase = path.basename(options.output, '.json');
  const srcDir  = path.join(outDir, `${outBase}_sources`);
  fs.mkdirSync(srcDir, { recursive: true });

  // Per-origin split files
  const byOrigin = {};
  finalQueries.forEach(op => {
    const k = op.origin || 'unknown';
    (byOrigin[k] = byOrigin[k] || []).push(op);
  });
  Object.entries(byOrigin).forEach(([origin, ops]) => {
    const name = origin.replace(/[^a-z0-9]/gi, '_').slice(0, 100) + '.json';
    fs.writeFileSync(path.join(srcDir, name), JSON.stringify(ops, null, 2));
  });

  // Combined output
  const enriched = finalQueries.map(q => ({
    ...q,
    detectedAt: q.detectedAt || new Date().toISOString(),
    toolVersion: '2.2.0',
  }));
  fs.writeFileSync(options.output, JSON.stringify(enriched, null, 2));
  console.log(`\n✅ ${finalQueries.length} total operations → ${options.output}`);

  // Detection breakdown
  const ctxSummary = {};
  finalQueries.forEach(q => { ctxSummary[q.context] = (ctxSummary[q.context] || 0) + 1; });
  console.log('\n📊 Detection breakdown:');
  Object.entries(ctxSummary).sort((a, b) => b[1] - a[1]).forEach(([ctx, n]) =>
    console.log(`   ${ctx.padEnd(32)} ${n}`));

  if (options.postman) {
    const pmFile = options.output.replace('.json', '.postman.json');
    fs.writeFileSync(pmFile, JSON.stringify(generatePostmanCollection(finalQueries), null, 2));
    console.log(`\n📦 Postman collection → ${pmFile}`);
  }

  // Cleanup temp dirs
  if (tempDir && tempDir.startsWith(os.tmpdir())) {
    try { fs.rmSync(tempDir, { recursive: true }); } catch {}
  }
}

main().catch(err => {
  console.error('❌ Fatal:', err.message);
  if (options.verbose) console.error(err.stack);
  process.exit(1);
});
