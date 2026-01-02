import { WebSocketServer, WebSocket } from 'ws';
import { SocksProxyAgent } from 'socks-proxy-agent';
import http from 'http';
import url from 'url';

// Configuration
const BRIDGE_PORT = 3001;
const TOR_SOCKS_PORT = 9050; // Standard Tor port
const TOR_HOST = '127.0.0.1';

console.log(`🧅 NCC Tor Bridge starting on port ${BRIDGE_PORT}...`);
console.log(`   Targeting Tor SOCKS at ${TOR_HOST}:${TOR_SOCKS_PORT}`);

// Create HTTP server to upgrade requests
const server = http.createServer();
const wss = new WebSocketServer({ noServer: true });

// SOCKS Agent
const agent = new SocksProxyAgent(`socks5://${TOR_HOST}:${TOR_SOCKS_PORT}`);

server.on('upgrade', (request, socket, head) => {
  const parsed = url.parse(request.url || '', true);
  const target = parsed.query.target; // ?target=wss://xyz.onion

  if (!target || typeof target !== 'string') {
    socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
    socket.destroy();
    return;
  }

  console.log(`[Bridge] New connection request -> ${target}`);

  wss.handleUpgrade(request, socket, head, (ws) => {
    wss.emit('connection', ws, request, target);
  });
});

wss.on('connection', (clientWs, req, targetUrl) => {
  let isClosed = false;
  console.log(`[Bridge] Client connected. Opening tunnel to ${targetUrl}...`);

  // Connect to the Onion Relay via SOCKS Agent
  const remoteWs = new WebSocket(targetUrl, { agent });

  remoteWs.on('open', () => {
    console.log(`[Bridge] Tunnel established to ${targetUrl}`);
  });

  remoteWs.on('message', (data, isBinary) => {
    if (clientWs.readyState === WebSocket.OPEN) {
      clientWs.send(data, { binary: isBinary });
    }
  });

  remoteWs.on('close', () => {
    if (!isClosed) {
      console.log(`[Bridge] Remote closed.`);
      clientWs.close();
    }
  });

  remoteWs.on('error', (err) => {
    console.error(`[Bridge] Remote error:`, err.message);
    if (clientWs.readyState === WebSocket.OPEN) {
       // Optional: Send error frame or just close
       clientWs.close();
    }
  });

  // Client -> Remote
  clientWs.on('message', (data, isBinary) => {
    if (remoteWs.readyState === WebSocket.OPEN) {
      remoteWs.send(data, { binary: isBinary });
    }
  });

  clientWs.on('close', () => {
    isClosed = true;
    console.log(`[Bridge] Client disconnected.`);
    remoteWs.close();
  });

  clientWs.on('error', (err) => {
    console.error(`[Bridge] Client error:`, err.message);
    remoteWs.close();
  });
});

server.listen(BRIDGE_PORT, '0.0.0.0', () => {
  console.log(`✅ Bridge ready: ws://<your-ip>:${BRIDGE_PORT}?target=<ONION_URL>`);
});
