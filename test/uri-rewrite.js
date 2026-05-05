#!/usr/bin/env node
// Drives the shim with a fake Roslyn-style server (test/fake-server.js)
// to verify the actual URI translation logic.
//
// Security note: this test uses spawn() with an explicit argv array.
// No shell interpolation. The only inputs are a hardcoded path to the
// shim and to the fake server, plus an env var setting the wrapped
// command to "node".

'use strict';

const cp = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert');

const SHIM = path.join(__dirname, '..', 'src', 'shim.js');
const FAKE = path.join(__dirname, 'fake-server.js');

function frame(message) {
  const body = Buffer.from(JSON.stringify(message), 'utf8');
  return Buffer.concat([
    Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, 'ascii'),
    body,
  ]);
}

class Reader {
  constructor() { this.buf = Buffer.alloc(0); this.queue = []; this.waiters = []; }
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
      try {
        const msg = JSON.parse(body);
        if (this.waiters.length > 0) this.waiters.shift().resolve(msg);
        else this.queue.push(msg);
      } catch (_) {}
    }
  }
  next(timeoutMs = 5000) {
    if (this.queue.length > 0) return Promise.resolve(this.queue.shift());
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const idx = this.waiters.findIndex(w => w.resolve === wrapped);
        if (idx >= 0) this.waiters.splice(idx, 1);
        reject(new Error('timeout waiting for message'));
      }, timeoutMs);
      const wrapped = (m) => { clearTimeout(timer); resolve(m); };
      this.waiters.push({ resolve: wrapped, reject });
    });
  }
  async waitForId(id, timeoutMs = 5000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const m = await this.next(deadline - Date.now()).catch(() => null);
      if (m && m.id === id) return m;
    }
    throw new Error(`timeout waiting for id=${id}`);
  }
}

async function run() {
  const PROBE_FILE = path.join(require('node:os').tmpdir(), `roslyn-shim-probe-${process.pid}`);
  try { fs.unlinkSync(PROBE_FILE); } catch (_) {}
  const env = Object.assign({}, process.env, {
    ROSLYN_LSP_CMD: 'node',
    FAKE_SERVER_PROBE_FILE: PROBE_FILE,
  });
  const shim = cp.spawn('node', [SHIM, FAKE], {
    stdio: ['pipe', 'pipe', 'inherit'],
    shell: false,
    env,
  });

  function readProbe() {
    try { return fs.readFileSync(PROBE_FILE, 'utf8'); } catch (_) { return null; }
  }

  const reader = new Reader();
  shim.stdout.on('data', (c) => reader.push(c));
  function send(msg) { shim.stdin.write(frame(msg)); }

  // 1. initialize
  send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { capabilities: {} } });
  const init = await reader.waitForId(1);
  assert(init.result && init.result.capabilities, 'initialize must return capabilities');
  send({ jsonrpc: '2.0', method: 'initialized', params: {} });

  // 2. textDocument/definition with virtual URI from server
  send({
    jsonrpc: '2.0', id: 10, method: 'textDocument/definition',
    params: { textDocument: { uri: 'file:///some/source.cs' }, position: { line: 0, character: 0 } },
  });
  const defResp = await reader.waitForId(10);
  assert(Array.isArray(defResp.result) && defResp.result.length === 1, 'definition must return one location');
  const loc = defResp.result[0];
  assert(loc.uri.startsWith('file://'), `expected file:// URI, got ${loc.uri}`);
  assert(!loc.uri.startsWith('roslyn-source-generated://'), 'virtual URI must not leak to the client');

  const tempPath = loc.uri.replace(/^file:\/\//, '');
  assert(fs.existsSync(tempPath), `temp file should exist at ${tempPath}`);
  const initialContent = fs.readFileSync(tempPath, 'utf8');
  assert(!initialContent.includes('\r'), 'temp file content must have CRLF normalized to LF');
  assert(initialContent.includes('Bar() => 1'), 'temp file must contain v1 generated text');

  // 3. Inverse rewrite: temp URI from client must reach server as virtual URI.
  //    We probe via a sidecar file written by the fake server, because any
  //    URI we tried to read back through LSP would itself be rewritten by
  //    the shim's outbound translation.
  send({
    jsonrpc: '2.0', id: 11, method: 'textDocument/hover',
    params: { textDocument: { uri: loc.uri }, position: { line: 0, character: 0 } },
  });
  send({ jsonrpc: '2.0', id: 12, method: '$/test/ack', params: {} });
  await reader.waitForId(12);
  const probe = readProbe();
  assert.strictEqual(
    probe,
    'roslyn-source-generated://Project/Generator/File.cs',
    `inverse rewrite failed; server saw ${probe}`,
  );

  // 4. Refresh: server pushes refresh, shim must re-fetch
  send({ jsonrpc: '2.0', id: 20, method: '$/test/triggerRefresh', params: {} });
  await reader.waitForId(20);
  await new Promise(r => setTimeout(r, 200));
  const refreshedContent = fs.readFileSync(tempPath, 'utf8');
  assert(refreshedContent.includes('Bar() => 2'),
    `temp file should reflect v2 after refresh; got: ${refreshedContent}`);

  // 5. Lifecycle for temp-file URI must be dropped (not forwarded). If
  //    forwarded, the fake server would update its probe with the (rewritten)
  //    virtual URI from didOpen — same value as before, so the assertion
  //    would still pass. To detect the leak, send a different "real" URI
  //    in a separate hover first to mark the probe, then send the didOpen
  //    for the temp URI, then verify the probe still shows the marker.
  send({
    jsonrpc: '2.0', id: 13, method: 'textDocument/hover',
    params: { textDocument: { uri: 'file:///marker.cs' }, position: { line: 0, character: 0 } },
  });
  send({ jsonrpc: '2.0', id: 14, method: '$/test/ack', params: {} });
  await reader.waitForId(14);
  assert.strictEqual(readProbe(), 'file:///marker.cs', 'marker URI must reach server unchanged');

  send({
    jsonrpc: '2.0', method: 'textDocument/didOpen',
    params: { textDocument: { uri: loc.uri, languageId: 'csharp', version: 1, text: '' } },
  });
  send({ jsonrpc: '2.0', id: 15, method: '$/test/ack', params: {} });
  await reader.waitForId(15);
  assert.strictEqual(
    readProbe(),
    'file:///marker.cs',
    `didOpen for temp URI leaked to server; probe is now ${readProbe()}`,
  );

  send({ jsonrpc: '2.0', id: 99, method: 'shutdown', params: null });
  await reader.waitForId(99);
  send({ jsonrpc: '2.0', method: 'exit' });
  // The shim should exit on its own once the child server exits, but
  // belt-and-suspenders kill it after a short grace period so the
  // test process doesn't leak children.
  await Promise.race([
    new Promise((r) => shim.on('exit', r)),
    new Promise((r) => setTimeout(() => { try { shim.kill('SIGKILL'); } catch (_) {} r(); }, 1000)),
  ]);

  console.log('OK definition response had virtual URI rewritten to file://');
  console.log('OK temp file written with CRLF -> LF normalization');
  console.log('OK inverse rewrite: temp URI restored to virtual URI on the way out');
  console.log('OK refresh notification triggered re-fetch and updated temp file');
  console.log('OK didOpen for temp URI was dropped (not forwarded to server)');
}

run().then(() => process.exit(0), (err) => {
  console.error('FAIL', err.message);
  console.error(err.stack);
  process.exit(1);
});
