#!/usr/bin/env node
// End-to-end regression test for cross-project source-generator
// navigation. Reproduces the original bug:
//
//   Producer/  -- has a source generator producing IGreeter and
//                 GreetResponse in-memory
//   Consumer/  -- ProjectReferences Producer, declares a class
//                 implementing IGreeter
//
// The test deliberately does NOT call `project/open` from the client
// side. The shim's auto-discovery is what makes cross-project navigation
// work for clients that don't know about Roslyn's project-load protocol.
// If `textDocument/definition` on a cross-project generated type returns
// a MetadataAsSource decompilation URI or an empty result, this test
// fails — the autoload regressed.
//
// Security note: spawn() / spawnSync() with explicit argv arrays.
// shell: false. Inputs derived from __dirname; no external input flows
// into command lines.

'use strict';

const cp = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert');

const PROJECT_ROOT = path.resolve(__dirname, '..', 'examples', 'multi-project');
const SOURCE_FILE = path.join(PROJECT_ROOT, 'Consumer', 'Greeting.cs');
const CONSUMER_CSPROJ = path.join(PROJECT_ROOT, 'Consumer', 'Consumer.csproj');
const SHIM = path.resolve(__dirname, '..', 'src', 'shim.js');

function pathToFileUri(p) { return 'file://' + path.resolve(p); }

function frame(message) {
  const body = Buffer.from(JSON.stringify(message), 'utf8');
  return Buffer.concat([
    Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, 'ascii'),
    body,
  ]);
}

class Reader {
  constructor() { this.buf = Buffer.alloc(0); this.messages = []; this.listeners = []; }
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
  wait(predicate, timeoutMs, label) {
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

function findTokenPosition(source, anchor, token) {
  const lines = source.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const idx = lines[i].indexOf(anchor);
    if (idx < 0) continue;
    const tokenIdx = lines[i].indexOf(token, idx);
    if (tokenIdx >= 0) return { line: i, character: tokenIdx + Math.floor(token.length / 2) };
  }
  return null;
}

function locationsFromResult(result) {
  if (!result) return [];
  const arr = Array.isArray(result) ? result : [result];
  return arr.map((entry) => {
    if (!entry) return null;
    if (entry.uri) return entry;
    if (entry.targetUri) return { uri: entry.targetUri, range: entry.targetRange };
    return null;
  }).filter(Boolean);
}

async function run() {
  console.log('--- building multi-project graph ---');
  const buildResult = cp.spawnSync('dotnet', ['build', CONSUMER_CSPROJ, '--nologo', '-v', 'minimal'], {
    cwd: PROJECT_ROOT,
    stdio: 'inherit',
    shell: false,
  });
  if (buildResult.status !== 0) throw new Error(`dotnet build failed (${buildResult.status})`);

  console.log('--- spawning shim (autoload should kick in) ---');
  const shim = cp.spawn('node', [SHIM, '--stdio', '--logLevel', 'Warning'], {
    stdio: ['pipe', 'pipe', 'inherit'],
    shell: false,
    env: process.env,
  });
  const reader = new Reader();
  shim.stdout.on('data', (c) => reader.push(c));
  function send(msg) { shim.stdin.write(frame(msg)); }

  console.log('--- initialize (workspace = examples/multi-project) ---');
  const projectRootUri = pathToFileUri(PROJECT_ROOT);
  send({
    jsonrpc: '2.0', id: 1, method: 'initialize',
    params: {
      processId: process.pid,
      rootUri: projectRootUri,
      workspaceFolders: [{ uri: projectRootUri, name: 'multi-project' }],
      capabilities: {
        textDocument: {
          synchronization: { dynamicRegistration: false },
          definition: { linkSupport: true },
        },
      },
    },
  });
  const initResp = await reader.waitForId(1, 30_000);
  assert(initResp.result && initResp.result.capabilities, 'initialize must return capabilities');
  send({ jsonrpc: '2.0', method: 'initialized', params: {} });

  console.log('--- waiting for projectInitializationComplete (no client project/open sent) ---');
  const source = fs.readFileSync(SOURCE_FILE, 'utf8');
  const sourceUri = pathToFileUri(SOURCE_FILE);
  send({
    jsonrpc: '2.0', method: 'textDocument/didOpen',
    params: { textDocument: { uri: sourceUri, languageId: 'csharp', version: 1, text: source } },
  });
  await reader.waitForMethod('workspace/projectInitializationComplete', 180_000);

  const probes = [
    { label: 'IGreeter', anchor: ': IGreeter', token: 'IGreeter', expectInGenerated: 'public interface IGreeter' },
    { label: 'GreetResponse', anchor: 'GreetResponse Greet', token: 'GreetResponse', expectInGenerated: 'GreetResponse' },
  ];

  let nextId = 100;
  for (const probe of probes) {
    const pos = findTokenPosition(source, probe.anchor, probe.token);
    assert(pos, `could not find ${probe.label} probe in source`);

    const id = nextId++;
    send({
      jsonrpc: '2.0', id, method: 'textDocument/definition',
      params: { textDocument: { uri: sourceUri }, position: pos },
    });
    const resp = await reader.waitForId(id, 30_000);
    assert(!resp.error, `${probe.label}: definition errored: ${JSON.stringify(resp.error)}`);
    const locs = locationsFromResult(resp.result);
    assert(locs.length > 0, `${probe.label}: definition returned empty result`);

    for (const loc of locs) {
      assert(!loc.uri.startsWith('roslyn-source-generated://'),
        `${probe.label}: virtual URI leaked to client: ${loc.uri}`);
    }

    const generated = locs.find((l) => /\/roslyn-generated-[^/]+\//.test(l.uri));
    assert(generated, `${probe.label}: no shim-translated location among ${locs.map(l => l.uri).join(', ')} — looks like Producer wasn't loaded into the workspace; autoload regressed`);

    const tempPath = generated.uri.replace(/^file:\/\//, '');
    assert(fs.existsSync(tempPath), `${probe.label}: temp file does not exist at ${tempPath}`);
    const content = fs.readFileSync(tempPath, 'utf8');
    assert(!content.includes('\r'), `${probe.label}: CRLF not normalized in temp file`);
    assert(content.includes(probe.expectInGenerated),
      `${probe.label}: expected '${probe.expectInGenerated}' in temp file content; got: ${content.slice(0, 300)}`);

    console.log(`OK ${probe.label}: cross-project /definition resolved to ${path.basename(tempPath)}`);
  }

  send({ jsonrpc: '2.0', id: 9999, method: 'shutdown' });
  await reader.waitForId(9999, 10_000).catch(() => {});
  send({ jsonrpc: '2.0', method: 'exit' });
  await Promise.race([
    new Promise((r) => shim.on('exit', r)),
    new Promise((r) => setTimeout(() => { try { shim.kill('SIGKILL'); } catch (_) {} r(); }, 5000)),
  ]);

  console.log('OK shim auto-loaded multiple projects without an explicit project/open from the client');
}

run().then(() => process.exit(0), (err) => {
  console.error('FAIL', err.message);
  console.error(err.stack);
  process.exit(1);
});
