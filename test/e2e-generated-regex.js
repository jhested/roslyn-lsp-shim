#!/usr/bin/env node
// End-to-end test: drive the shim against the real `roslyn-language-server`
// and the example C# project in `examples/sample-project`. The project
// uses [GeneratedRegex] (a built-in source generator) so the implementation
// of EmailRegex() lives in an in-memory generated document. We ask for
// `textDocument/implementation` on the call site and verify the shim
// rewrote the resulting `roslyn-source-generated://` URI into a real
// file:// path containing the generated code.
//
// Security note: this test uses spawn() and spawnSync() with explicit
// argv arrays. shell: false. No shell interpolation. Inputs are derived
// from __dirname only — no user/external input flows into command lines.
//
// Requires: roslyn-language-server on PATH, DOTNET_ROOT set.

'use strict';

const cp = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert');

const PROJECT_ROOT = path.resolve(__dirname, '..', 'examples', 'sample-project');
const SOURCE_FILE = path.join(PROJECT_ROOT, 'Sample.cs');
const SHIM = path.resolve(__dirname, '..', 'src', 'shim.js');

function pathToFileUri(p) {
  return 'file://' + path.resolve(p);
}

function frame(message) {
  const body = Buffer.from(JSON.stringify(message), 'utf8');
  return Buffer.concat([
    Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, 'ascii'),
    body,
  ]);
}

class Reader {
  constructor() {
    this.buf = Buffer.alloc(0);
    this.messages = [];
    this.listeners = [];
  }
  push(chunk) {
    this.buf = Buffer.concat([this.buf, chunk]);
    while (true) {
      const headerEnd = this.buf.indexOf('\r\n\r\n');
      if (headerEnd < 0) return;
      const header = this.buf.slice(0, headerEnd).toString('ascii');
      const m = /Content-Length:\s*(\d+)/i.exec(header);
      if (!m) { this.buf = this.buf.slice(headerEnd + 4); continue; }
      const len = parseInt(m[1], 10);
      if (this.buf.length < headerEnd + 4 + len) return;
      const body = this.buf.slice(headerEnd + 4, headerEnd + 4 + len).toString('utf8');
      this.buf = this.buf.slice(headerEnd + 4 + len);
      let msg;
      try { msg = JSON.parse(body); } catch (_) { continue; }
      this.messages.push(msg);
      for (let i = this.listeners.length - 1; i >= 0; i--) {
        const L = this.listeners[i];
        if (L.predicate(msg)) {
          clearTimeout(L.timer);
          this.listeners.splice(i, 1);
          L.resolve(msg);
        }
      }
    }
  }
  wait(predicate, timeoutMs = 30_000, label = 'predicate') {
    const existing = this.messages.find(predicate);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const L = { predicate, resolve };
      L.timer = setTimeout(() => {
        const idx = this.listeners.indexOf(L);
        if (idx >= 0) this.listeners.splice(idx, 1);
        reject(new Error(`timeout waiting for ${label}`));
      }, timeoutMs);
      this.listeners.push(L);
    });
  }
  waitForId(id, timeoutMs) { return this.wait((m) => m.id === id, timeoutMs, `id=${id}`); }
  waitForMethod(method, timeoutMs) { return this.wait((m) => m.method === method, timeoutMs, `method=${method}`); }
}

function locationsFromResult(result) {
  if (!result) return [];
  const arr = Array.isArray(result) ? result : [result];
  return arr.map((entry) => {
    if (entry.uri) return entry;
    if (entry.targetUri) return { uri: entry.targetUri, range: entry.targetRange };
    return null;
  }).filter(Boolean);
}

async function run() {
  console.log('--- building sample project ---');
  const buildResult = cp.spawnSync('dotnet', ['build', '--nologo', '-v', 'minimal'], {
    cwd: PROJECT_ROOT,
    stdio: 'inherit',
    shell: false,
  });
  if (buildResult.status !== 0) {
    throw new Error(`dotnet build failed with status ${buildResult.status}`);
  }

  console.log('--- spawning shim ---');
  const shim = cp.spawn('node', [SHIM, '--stdio', '--logLevel', 'Warning'], {
    stdio: ['pipe', 'pipe', 'inherit'],
    shell: false,
    env: process.env,
  });

  const reader = new Reader();
  shim.stdout.on('data', (c) => reader.push(c));
  function send(msg) { shim.stdin.write(frame(msg)); }

  console.log('--- initialize ---');
  const projectRootUri = pathToFileUri(PROJECT_ROOT);
  send({
    jsonrpc: '2.0', id: 1, method: 'initialize',
    params: {
      processId: process.pid,
      rootUri: projectRootUri,
      workspaceFolders: [{ uri: projectRootUri, name: 'sample-project' }],
      capabilities: {
        textDocument: {
          synchronization: { dynamicRegistration: false },
          definition: { linkSupport: true },
          implementation: { linkSupport: true },
        },
      },
    },
  });
  const initResp = await reader.waitForId(1, 30_000);
  assert(initResp.result && initResp.result.capabilities, 'initialize must succeed');
  send({ jsonrpc: '2.0', method: 'initialized', params: {} });

  // Roslyn LSP does not auto-discover projects from workspaceFolders;
  // it needs an explicit `project/open` (or `solution/open`) notification
  // listing the .csproj/.sln files to analyze. Without this, the server
  // never reaches projectInitializationComplete.
  console.log('--- opening project ---');
  send({
    jsonrpc: '2.0', method: 'project/open',
    params: {
      projects: [pathToFileUri(path.join(PROJECT_ROOT, 'sample.csproj'))],
    },
  });

  console.log('--- waiting for project initialization ---');
  const source = fs.readFileSync(SOURCE_FILE, 'utf8');
  const sourceUri = pathToFileUri(SOURCE_FILE);
  send({
    jsonrpc: '2.0', method: 'textDocument/didOpen',
    params: {
      textDocument: {
        uri: sourceUri,
        languageId: 'csharp',
        version: 1,
        text: source,
      },
    },
  });
  await reader.waitForMethod('workspace/projectInitializationComplete', 120_000);

  console.log('--- locating EmailRegex call site ---');
  const lines = source.split('\n');
  let line = -1, character = -1;
  for (let i = 0; i < lines.length; i++) {
    const idx = lines[i].indexOf('EmailRegex().IsMatch');
    if (idx >= 0) { line = i; character = idx; break; }
  }
  assert(line >= 0, 'could not find EmailRegex().IsMatch in Sample.cs');
  console.log(`    found at line=${line} character=${character}`);

  console.log('--- requesting implementation ---');
  send({
    jsonrpc: '2.0', id: 10, method: 'textDocument/implementation',
    params: {
      textDocument: { uri: sourceUri },
      position: { line, character },
    },
  });
  const implResp = await reader.waitForId(10, 30_000);

  if (implResp.error) throw new Error('implementation request errored: ' + JSON.stringify(implResp.error));
  const locations = locationsFromResult(implResp.result);
  assert(locations.length > 0, `expected >=1 implementation location, got: ${JSON.stringify(implResp.result)}`);

  console.log(`    received ${locations.length} location(s):`);
  for (const loc of locations) console.log(`      ${loc.uri}`);

  for (const loc of locations) {
    assert(!loc.uri.startsWith('roslyn-source-generated://'),
      `virtual URI leaked to client: ${loc.uri}`);
    assert(loc.uri.startsWith('file://'),
      `unexpected URI scheme in result: ${loc.uri}`);
  }

  const generated = locations.find((loc) => /\/roslyn-generated-[^/]+\//.test(loc.uri));
  assert(generated, `no rewritten generated location among: ${locations.map(l => l.uri).join(', ')}`);

  const tempPath = generated.uri.replace(/^file:\/\//, '');
  assert(fs.existsSync(tempPath), `temp file ${tempPath} does not exist`);
  const tempContent = fs.readFileSync(tempPath, 'utf8');
  assert(!tempContent.includes('\r'), 'temp file content must have CRLF normalized to LF');
  assert(/EmailRegex|EmailValidator|Regex/.test(tempContent),
    `temp file content does not look like generated regex code: ${tempContent.slice(0, 400)}`);

  console.log('--- shutting down ---');
  // shutdown has no params per LSP spec; the current Roslyn server
  // crashes if `params: null` is included.
  send({ jsonrpc: '2.0', id: 99, method: 'shutdown' });
  await reader.waitForId(99, 10_000);
  send({ jsonrpc: '2.0', method: 'exit' });
  await Promise.race([
    new Promise((r) => shim.on('exit', r)),
    new Promise((r) => setTimeout(() => { try { shim.kill('SIGKILL'); } catch (_) {} r(); }, 5000)),
  ]);

  console.log('OK end-to-end: textDocument/implementation on a generated symbol');
  console.log('OK   the shim rewrote the virtual URI to file://');
  console.log('OK   the temp file exists and contains generator output');
  console.log('OK   no virtual URI leaked to the client');
}

run().then(() => process.exit(0), (err) => {
  console.error('FAIL', err.message);
  console.error(err.stack);
  process.exit(1);
});
