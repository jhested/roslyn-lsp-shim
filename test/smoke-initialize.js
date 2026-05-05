#!/usr/bin/env node
// Smoke test: spawn the shim with the real Roslyn LSP behind it and
// verify that an `initialize` request round-trips. Validates stdio
// framing, child spawn, and transparent passthrough.
//
// Security note: this test uses spawn() with an explicit argv array.
// No shell interpolation. No external/user input flows into the
// command line — paths are derived from __dirname only.
//
// Requires: roslyn-language-server on PATH, DOTNET_ROOT set.

'use strict';

const cp = require('node:child_process');
const path = require('node:path');

const SHIM = path.join(__dirname, '..', 'src', 'shim.js');
const TIMEOUT_MS = 30_000;

function frame(message) {
  const body = Buffer.from(JSON.stringify(message), 'utf8');
  return Buffer.concat([
    Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, 'ascii'),
    body,
  ]);
}

async function run() {
  const shim = cp.spawn('node', [SHIM, '--stdio', '--logLevel', 'Warning'], {
    stdio: ['pipe', 'pipe', 'inherit'],
    shell: false,
    env: process.env,
  });

  let stdoutBuf = Buffer.alloc(0);
  const responses = [];

  shim.stdout.on('data', (chunk) => {
    stdoutBuf = Buffer.concat([stdoutBuf, chunk]);
    while (true) {
      const headerEnd = stdoutBuf.indexOf('\r\n\r\n');
      if (headerEnd < 0) break;
      const header = stdoutBuf.slice(0, headerEnd).toString('ascii');
      const m = /Content-Length:\s*(\d+)/i.exec(header);
      if (!m) { stdoutBuf = stdoutBuf.slice(headerEnd + 4); continue; }
      const len = parseInt(m[1], 10);
      if (stdoutBuf.length < headerEnd + 4 + len) break;
      const body = stdoutBuf.slice(headerEnd + 4, headerEnd + 4 + len).toString('utf8');
      stdoutBuf = stdoutBuf.slice(headerEnd + 4 + len);
      try { responses.push(JSON.parse(body)); } catch (_) {}
    }
  });

  shim.stdin.write(frame({
    jsonrpc: '2.0', id: 1, method: 'initialize',
    params: {
      processId: process.pid,
      rootUri: null,
      capabilities: {},
      clientInfo: { name: 'roslyn-lsp-shim-smoke', version: '0.0.0' },
    },
  }));

  const initializeResult = await waitForResponse(responses, 1, TIMEOUT_MS);
  shim.stdin.write(frame({ jsonrpc: '2.0', method: 'initialized', params: {} }));
  shim.stdin.write(frame({ jsonrpc: '2.0', id: 2, method: 'shutdown' }));

  const shutdownResult = await waitForResponse(responses, 2, TIMEOUT_MS);
  shim.stdin.write(frame({ jsonrpc: '2.0', method: 'exit' }));
  await waitForExit(shim, TIMEOUT_MS);

  if (!initializeResult.result || !initializeResult.result.capabilities) {
    throw new Error('initialize response missing capabilities: ' + JSON.stringify(initializeResult));
  }
  if (shutdownResult.error) {
    throw new Error('shutdown errored: ' + JSON.stringify(shutdownResult.error));
  }
  console.log('OK initialize round-tripped through shim');
  console.log('OK server reported capabilities, shutdown clean');
}

function waitForResponse(responses, id, timeoutMs) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = () => {
      const found = responses.find(r => r.id === id);
      if (found) return resolve(found);
      if (Date.now() - start > timeoutMs) return reject(new Error(`timeout waiting for response id=${id}`));
      setTimeout(tick, 50);
    };
    tick();
  });
}

function waitForExit(child, timeoutMs) {
  return new Promise((resolve) => {
    let done = false;
    child.on('exit', () => { done = true; resolve(); });
    setTimeout(() => { if (!done) { try { child.kill(); } catch (_) {} resolve(); } }, timeoutMs);
  });
}

run().then(() => process.exit(0), (err) => {
  console.error('FAIL', err.message);
  process.exit(1);
});
