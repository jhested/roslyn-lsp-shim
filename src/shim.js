#!/usr/bin/env node
// roslyn-lsp-shim
//
// A stdio LSP proxy that wraps `roslyn-language-server` and translates
// the Roslyn-specific `roslyn-source-generated://` URI scheme into real
// `file://` paths under a temp directory. This lets LSP clients that do
// not implement the `sourceGeneratedDocument/_roslyn_getText` custom
// request (Claude Code, OpenCode, etc.) navigate into source-generated
// code via go-to-definition and find-references.
//
// Security note: this file uses Node's spawn() with an explicit argv
// array — there is no shell interpolation and no user input flows into
// the command line. spawn() is the safe alternative to exec().

'use strict';

const childProcess = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');

const SERVER_CMD = process.env.ROSLYN_LSP_CMD || 'roslyn-language-server';
const SERVER_ARGS = process.argv.slice(2);
const VIRTUAL_PREFIX = 'roslyn-source-generated://';
const SHIM_ID_PREFIX = 'roslyn-shim:';
const LOG_PATH = process.env.ROSLYN_SHIM_LOG || null;

// Use a per-instance temp directory so concurrent shim processes can't
// step on each other's files (cleanup deletes the whole directory on
// exit, and one instance deleting a shared path would corrupt the
// other's view).
const TEMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'roslyn-generated-'));

const virtualToEntry = new Map();
const fileUriToVirtual = new Map();

function log(...args) {
  if (!LOG_PATH) return;
  const line = `[${new Date().toISOString()}] ${args.map(a =>
    typeof a === 'string' ? a : JSON.stringify(a)).join(' ')}\n`;
  try { fs.appendFileSync(LOG_PATH, line); } catch (_) { /* ignore */ }
}

function getOrCreateEntry(virtualUri) {
  let entry = virtualToEntry.get(virtualUri);
  if (entry) return entry;
  const hash = crypto.createHash('sha1').update(virtualUri).digest('hex').slice(0, 16);
  const tempPath = path.join(TEMP_DIR, `${hash}.cs`);
  const fileUri = 'file://' + tempPath;
  entry = { tempPath, fileUri, resultId: null };
  virtualToEntry.set(virtualUri, entry);
  fileUriToVirtual.set(fileUri, virtualUri);
  fileUriToVirtual.set(tempPath, virtualUri);
  return entry;
}

class Framer {
  constructor() { this.buffer = Buffer.alloc(0); }
  *push(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (true) {
      const headerEnd = this.buffer.indexOf('\r\n\r\n');
      if (headerEnd < 0) return;
      const header = this.buffer.slice(0, headerEnd).toString('ascii');
      const m = /Content-Length:\s*(\d+)/i.exec(header);
      if (!m) {
        log('drop malformed header', header);
        this.buffer = this.buffer.slice(headerEnd + 4);
        continue;
      }
      const len = parseInt(m[1], 10);
      const totalLen = headerEnd + 4 + len;
      if (this.buffer.length < totalLen) return;
      const body = this.buffer.slice(headerEnd + 4, totalLen).toString('utf8');
      this.buffer = this.buffer.slice(totalLen);
      try {
        yield JSON.parse(body);
      } catch (e) {
        log('drop unparseable body', body.slice(0, 200));
      }
    }
  }
}

function frame(message) {
  const body = Buffer.from(JSON.stringify(message), 'utf8');
  const header = Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, 'ascii');
  return Buffer.concat([header, body]);
}

function isVirtualUri(s) {
  return typeof s === 'string' && s.startsWith(VIRTUAL_PREFIX);
}

function isFileUri(s) {
  return typeof s === 'string' && s.startsWith('file://');
}

function collectVirtualUris(node, set) {
  if (node === null || node === undefined) return;
  if (typeof node === 'string') {
    if (isVirtualUri(node)) set.add(node);
    return;
  }
  if (Array.isArray(node)) {
    for (const item of node) collectVirtualUris(item, set);
    return;
  }
  if (typeof node === 'object') {
    for (const k of Object.keys(node)) collectVirtualUris(node[k], set);
  }
}

function mapStringsDeep(node, mapper) {
  if (node === null || node === undefined) return node;
  if (typeof node === 'string') return mapper(node);
  if (Array.isArray(node)) return node.map(v => mapStringsDeep(v, mapper));
  if (typeof node === 'object') {
    const out = {};
    for (const k of Object.keys(node)) out[k] = mapStringsDeep(node[k], mapper);
    return out;
  }
  return node;
}

const virtualToFileMapper = (s) => {
  if (!isVirtualUri(s)) return s;
  const entry = virtualToEntry.get(s);
  return entry ? entry.fileUri : s;
};

const fileToVirtualMapper = (s) => {
  if (!isFileUri(s)) return s;
  const v = fileUriToVirtual.get(s);
  return v ?? s;
};

// Spawn the underlying Roslyn LSP. SERVER_CMD comes from env, SERVER_ARGS
// from this process's argv; both are passed as an explicit argv array
// (no shell, no interpolation).
const child = childProcess.spawn(SERVER_CMD, SERVER_ARGS, {
  stdio: ['pipe', 'pipe', 'inherit'],
  shell: false,
});

child.on('error', (err) => {
  log('failed to spawn server', err.message);
  process.stderr.write(`roslyn-lsp-shim: failed to spawn ${SERVER_CMD}: ${err.message}\n`);
  process.exit(1);
});

child.on('exit', (code, signal) => {
  log('server exited', { code, signal });
  process.exit(code ?? 0);
});

function sendToClient(message) {
  process.stdout.write(frame(message));
}

function sendToServer(message) {
  child.stdin.write(frame(message));
}

let nextShimId = 1;
const pendingShimRequests = new Map();

// Fetch content for a virtual URI using the LSP 3.18 standard
// `workspace/textDocumentContent` request. Roslyn migrated to this
// method (away from the older custom `sourceGeneratedDocument/_roslyn_getText`)
// in `roslyn-language-server` 5.x.
function fetchGeneratedContent(virtualUri) {
  return new Promise((resolve) => {
    const entry = getOrCreateEntry(virtualUri);
    const id = SHIM_ID_PREFIX + (nextShimId++);
    pendingShimRequests.set(id, (response) => {
      const result = response && response.result;
      if (!result) {
        log('textDocumentContent returned no result for', virtualUri, 'response:', response);
        try {
          if (!fs.existsSync(entry.tempPath)) fs.writeFileSync(entry.tempPath, '');
        } catch (_) {}
        return resolve();
      }
      let text = (result.text === null || result.text === undefined) ? '' : String(result.text);
      text = text.replace(/\r\n/g, '\n');
      try {
        fs.writeFileSync(entry.tempPath, text);
      } catch (e) {
        log('failed to write temp file', entry.tempPath, e.message);
      }
      resolve();
    });
    sendToServer({
      jsonrpc: '2.0',
      id,
      method: 'workspace/textDocumentContent',
      params: { uri: virtualUri },
    });
  });
}

async function refreshAllGenerated() {
  const uris = Array.from(virtualToEntry.keys());
  log('refresh requested for all, re-fetching', uris.length);
  await Promise.all(uris.map(fetchGeneratedContent));
}

async function refreshSingle(virtualUri) {
  if (!virtualToEntry.has(virtualUri)) return;
  log('refresh requested for', virtualUri);
  await fetchGeneratedContent(virtualUri);
}

// Inject the workspace.textDocumentContent client capability into an
// `initialize` request before forwarding it. Without this, the Roslyn
// server may not advertise/use its virtual URI scheme on the assumption
// that the client cannot fetch the content.
function injectTextDocumentContentCapability(initMsg) {
  // Deep clone so we don't mutate the parent client's structure.
  const cloned = JSON.parse(JSON.stringify(initMsg));
  cloned.params = cloned.params || {};
  cloned.params.capabilities = cloned.params.capabilities || {};
  cloned.params.capabilities.workspace = cloned.params.capabilities.workspace || {};
  if (!cloned.params.capabilities.workspace.textDocumentContent) {
    cloned.params.capabilities.workspace.textDocumentContent = { dynamicRegistration: false };
  }
  return cloned;
}

function handleClientMessage(msg) {
  if (msg.method === 'textDocument/didOpen'
      || msg.method === 'textDocument/didChange'
      || msg.method === 'textDocument/didClose'
      || msg.method === 'textDocument/didSave') {
    const uri = msg.params && msg.params.textDocument && msg.params.textDocument.uri;
    if (isFileUri(uri) && fileUriToVirtual.has(uri)) {
      log('drop client lifecycle for temp file', msg.method, uri);
      return;
    }
  }
  let outbound = msg;
  if (msg.method === 'initialize') {
    outbound = injectTextDocumentContentCapability(msg);
  }
  const rewritten = mapStringsDeep(outbound, fileToVirtualMapper);
  sendToServer(rewritten);
}

let serverQueue = Promise.resolve();

async function handleServerMessage(msg) {
  if (msg.id !== undefined && typeof msg.id === 'string' && msg.id.startsWith(SHIM_ID_PREFIX)) {
    const handler = pendingShimRequests.get(msg.id);
    if (handler) {
      pendingShimRequests.delete(msg.id);
      try { handler(msg); } catch (e) { log('shim response handler threw', e.message); }
    }
    return;
  }

  // LSP 3.18 standard: server-pushed request to refresh content for a
  // single URI. The shim re-fetches and answers the request itself.
  if (msg.method === 'workspace/textDocumentContent/refresh') {
    const uri = msg.params && msg.params.uri;
    if (typeof uri === 'string' && isVirtualUri(uri)) {
      await refreshSingle(uri);
    }
    if (msg.id !== undefined) {
      // The server is awaiting a response — the result type is `null`.
      sendToServer({ jsonrpc: '2.0', id: msg.id, result: null });
    }
    return;
  }
  // Older Roslyn protocol — kept for backward compatibility with any
  // server build that still uses the previous method name.
  if (msg.method === 'workspace/refreshSourceGeneratedDocument'
      || msg.method === 'workspace/_roslyn_refreshSourceGenerators') {
    await refreshAllGenerated();
    return;
  }

  const virtualUris = new Set();
  collectVirtualUris(msg, virtualUris);
  if (virtualUris.size > 0) {
    log('fetching', virtualUris.size, 'virtual uri(s) for', msg.method || `id=${msg.id}`);
    await Promise.all(Array.from(virtualUris, fetchGeneratedContent));
  }
  const rewritten = mapStringsDeep(msg, virtualToFileMapper);
  sendToClient(rewritten);
}

const fromClient = new Framer();
const fromServer = new Framer();

process.stdin.on('data', (chunk) => {
  for (const msg of fromClient.push(chunk)) {
    try { handleClientMessage(msg); }
    catch (e) { log('client handler threw', e.message); }
  }
});

process.stdin.on('end', () => {
  log('client closed stdin');
  try { child.kill(); } catch (_) {}
});

child.stdout.on('data', (chunk) => {
  for (const msg of fromServer.push(chunk)) {
    // Responses to the shim's own outbound requests must bypass the
    // serial queue: handleServerMessage awaits fetchGeneratedContent,
    // and that fetch's response would otherwise be blocked behind the
    // very message that's awaiting it -> deadlock.
    if (msg.id !== undefined && typeof msg.id === 'string' && msg.id.startsWith(SHIM_ID_PREFIX)) {
      const handler = pendingShimRequests.get(msg.id);
      if (handler) {
        pendingShimRequests.delete(msg.id);
        try { handler(msg); } catch (e) { log('shim response handler threw', e.message); }
      }
      continue;
    }
    serverQueue = serverQueue.then(() => handleServerMessage(msg).catch(e => {
      log('server handler threw', e.message);
    }));
  }
});

function cleanup() {
  try { fs.rmSync(TEMP_DIR, { recursive: true, force: true }); } catch (_) {}
}

process.on('exit', () => {
  cleanup();
  try { child.kill(); } catch (_) {}
});

['SIGINT', 'SIGTERM', 'SIGHUP'].forEach((sig) => {
  process.on(sig, () => process.exit(0));
});

log('shim started; server cmd:', SERVER_CMD, 'args:', SERVER_ARGS.join(' '));
