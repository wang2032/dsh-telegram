// Minimal TCP forwarder: 0.0.0.0:3081 -> 127.0.0.1:3080 (in-container).
//
// WHY: the pinned legacy `dsh web` (0.1.0-rc.6) crashes when asked to bind a
// non-loopback host (`--host 0.0.0.0`). It happily serves on 127.0.0.1 INSIDE
// the container — but docker's published port forwards to the container's
// eth0 IP, which nothing listens on (ERR_EMPTY_RESPONSE). This forwarder
// occupies the eth0-facing port and pipes every connection to the loopback
// server. Pure node:net, no dependencies, no HTTP parsing.
//
// Security stays intact: docker-compose publishes host port on 127.0.0.1 only,
// so the UI remains reachable exclusively via SSH tunnel.
'use strict';
const net = require('node:net');

const LISTEN = Number(process.env.FORWARDER_PORT || 3081);
const TARGET_PORT = Number(process.env.FORWARDER_TARGET_PORT || 3080);

const server = net.createServer((client) => {
  const upstream = net.connect(TARGET_PORT, '127.0.0.1');
  client.setTimeout(120000);
  upstream.setTimeout(120000);
  client.on('error', () => upstream.destroy());
  upstream.on('error', () => client.destroy());
  client.on('timeout', () => { client.destroy(); upstream.destroy(); });
  upstream.on('timeout', () => { client.destroy(); upstream.destroy(); });
  client.pipe(upstream);
  upstream.pipe(client);
});

server.listen(LISTEN, '0.0.0.0', () => {
  console.log(`[web-forwarder] 0.0.0.0:${LISTEN} -> 127.0.0.1:${TARGET_PORT}`);
});
server.on('error', (e) => {
  console.error(`[web-forwarder] failed: ${e.message}`);
  process.exit(1);
});
