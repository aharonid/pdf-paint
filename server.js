#!/usr/bin/env node
// Zero-dependency static server for PDF Paint.
// A server is required (not file://) because pdf.js ships as an ES module + web worker.

const http = require('http');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const ROOT = __dirname;
const START_PORT = Number(process.env.PORT) || 4321;
const MAX_PORT = START_PORT + 20;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

const server = http.createServer((req, res) => {
  const urlPath = decodeURIComponent(req.url.split('?')[0]);
  const rel = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
  const filePath = path.join(ROOT, rel);

  // Keep the server pinned inside its own folder.
  if (!filePath.startsWith(ROOT)) {
    res.writeHead(403).end('Forbidden');
    return;
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found');
      return;
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-store',
    });
    res.end(data);
  });
});

function listen(port) {
  server.once('error', (err) => {
    if (err.code === 'EADDRINUSE' && port < MAX_PORT) {
      listen(port + 1);
      return;
    }
    console.error(err.message);
    process.exit(1);
  });
  server.listen(port, '127.0.0.1', () => {
    const url = `http://127.0.0.1:${port}/`;
    console.log(`\n  PDF Paint running at ${url}`);
    console.log('  Press Ctrl+C to stop.\n');
    if (!process.env.NO_OPEN && process.platform === 'darwin') execFile('open', [url]);
  });
}

listen(START_PORT);
