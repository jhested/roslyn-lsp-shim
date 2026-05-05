#!/usr/bin/env node
// A minimal fake Roslyn-style LSP server. Used to drive the shim's URI
// translation path without needing a real C# project.
//
// Security note: this file does not spawn any subprocesses. It only
// reads from stdin and writes to stdout — pure JSON-RPC framing.

'use strict';

const fs = require('node:fs');
const PROBE_FILE = process.env.FAKE_SERVER_PROBE_FILE || '/tmp/roslyn-shim-fake-probe';
const VIRTUAL_URI = 'roslyn-source-generated://Project/Generator/File.cs';
const GENERATED_TEXT_V1 = 'namespace Generated;\r\npublic partial class Foo\r\n{\r\n    public int Bar() => 1;\r\n}\r\n';
const GENERATED_TEXT_V2 = 'namespace Generated;\r\npublic partial class Foo\r\n{\r\n    public int Bar() => 2;\r\n}\r\n';

let buf = Buffer.alloc(0);
let textVersion = 1;
let didSendRefresh = false;
let lastInboundUri = null;

function send(msg) {
  const body = Buffer.from(JSON.stringify(msg), 'utf8');
  process.stdout.write(Buffer.concat([
    Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, 'ascii'),
    body,
  ]));
}

function handle(msg) {
  if (msg.params && msg.params.textDocument && msg.params.textDocument.uri) {
    lastInboundUri = msg.params.textDocument.uri;
    // Write OOB so the test can read what URI we received without
    // routing it back through the shim (which would re-translate it).
    try { fs.writeFileSync(PROBE_FILE, lastInboundUri); } catch (_) {}
  }

  if (msg.method === 'initialize') {
    send({ jsonrpc: '2.0', id: msg.id, result: { capabilities: { textDocumentSync: 1 } } });
    return;
  }
  if (msg.method === 'initialized' || msg.method === 'exit') return;
  if (msg.method === 'shutdown') {
    send({ jsonrpc: '2.0', id: msg.id, result: null });
    return;
  }
  if (msg.method === 'textDocument/definition') {
    send({
      jsonrpc: '2.0', id: msg.id,
      result: [{
        uri: VIRTUAL_URI,
        range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
      }],
    });
    return;
  }
  if (msg.method === 'workspace/textDocumentContent') {
    const text = textVersion === 1 ? GENERATED_TEXT_V1 : GENERATED_TEXT_V2;
    send({ jsonrpc: '2.0', id: msg.id, result: { text } });
    return;
  }
  if (msg.method === '$/test/triggerRefresh') {
    textVersion = 2;
    if (!didSendRefresh) {
      didSendRefresh = true;
      // Server-pushed request — expects an empty response from the client (the shim).
      send({
        jsonrpc: '2.0',
        id: 'fake-refresh-1',
        method: 'workspace/textDocumentContent/refresh',
        params: { uri: VIRTUAL_URI },
      });
    }
    send({ jsonrpc: '2.0', id: msg.id, result: 'sent' });
    return;
  }
  if (msg.method === '$/test/ack') {
    send({ jsonrpc: '2.0', id: msg.id, result: 'ok' });
    return;
  }
}

process.stdin.on('data', (chunk) => {
  buf = Buffer.concat([buf, chunk]);
  while (true) {
    const headerEnd = buf.indexOf('\r\n\r\n');
    if (headerEnd < 0) break;
    const header = buf.slice(0, headerEnd).toString('ascii');
    const m = /Content-Length:\s*(\d+)/i.exec(header);
    if (!m) { buf = buf.slice(headerEnd + 4); continue; }
    const len = parseInt(m[1], 10);
    if (buf.length < headerEnd + 4 + len) break;
    const body = buf.slice(headerEnd + 4, headerEnd + 4 + len).toString('utf8');
    buf = buf.slice(headerEnd + 4 + len);
    try { handle(JSON.parse(body)); } catch (_) {}
  }
});

process.stdin.on('end', () => process.exit(0));
