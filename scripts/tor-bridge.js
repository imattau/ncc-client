import { WebSocketServer, WebSocket } from 'ws';
import { SocksProxyAgent } from 'socks-proxy-agent';
import http from 'http';

// Configuration
const BRIDGE_PORT = 3001;
const BRIDGE_HOST = '127.0.0.1';
const TOR_SOCKS_PORT = 9050; // Standard Tor port
const TOR_HOST = '127.0.0.1';

console.log(`\n Onion NCC Tor Bridge starting...`);
console.log(`   Listening at:  ws://${BRIDGE_HOST}:${BRIDGE_PORT}`);
console.log(`   Tor SOCKS:     socks5h://${TOR_HOST}:${TOR_SOCKS_PORT}`);

// Create HTTP server to upgrade requests
const server = http.createServer();
const wss = new WebSocketServer({ noServer: true });

// SOCKS Agent - Use socks5h to ensure remote DNS resolution for .onion
const agent = new SocksProxyAgent(`socks5h://${TOR_HOST}:${TOR_SOCKS_PORT}`);

server.on('upgrade', (request, socket, head) => {
  const reqUrl = new URL(request.url || '', `http://${request.headers.host}`);
  const target = reqUrl.searchParams.get('target');

  if (!target) {
    console.error(`[Bridge] Upgrade failed: Missing 'target' query parameter.`);
    socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
    socket.destroy();
    return;
  }

  wss.handleUpgrade(request, socket, head, (ws) => {
    wss.emit('connection', ws, request);
  });
});

wss.on('connection', (clientWs, req) => {
  const reqUrl = new URL(req.url || '', `http://${req.headers.host || 'localhost'}`);
  const targetUrl = reqUrl.searchParams.get('target');

  if (targetUrl === 'internal-ping') {
      clientWs.send('pong');
      clientWs.close();
      return;
  }

  if (!targetUrl) {
      console.error("[Bridge] Connection failed: No target URL provided.");
      clientWs.close();
      return;
  }

  let isClosed = false;
  let remoteOpen = false;
  const messageBuffer = [];

  let parsedTarget;
  try {
      parsedTarget = new URL(targetUrl);
  } catch (e) {
      console.error(`[Bridge] Invalid target URL: ${targetUrl}`);
      clientWs.close();
      return;
  }

  console.log(`[Bridge] [${new Date().toLocaleTimeString()}] Tunneling: Client -> ${targetUrl}`);

  // Connect to the Onion Relay via SOCKS Agent
  const remoteWs = new WebSocket(targetUrl, { 
      agent,
      handshakeTimeout: 60000, 
      headers: {
          'Host': parsedTarget.host,
          'User-Agent': 'NCC-Tor-Bridge/1.0',
          'Origin': 'http://' + parsedTarget.host // Match the host to satisfy origin checks
      }
  });

  console.log(`[Bridge] Handshake initiated...`);

  // Handle data from Onion Relay -> Browser
  remoteWs.on('message', (data, isBinary) => {
    if (clientWs.readyState === WebSocket.OPEN) {
      clientWs.send(data, { binary: isBinary });
    }
  });

  remoteWs.on('open', () => {
    remoteOpen = true;
    console.log(`[Bridge] ✅ Tunnel Established to ${targetUrl}`);
    
    // Flush buffered messages
    console.log(`[Bridge] 📤 Flushed ${messageBuffer.length} buffered messages to remote.`);
    while (messageBuffer.length > 0) {
        const msg = messageBuffer.shift();
        remoteWs.send(msg.data, { binary: msg.isBinary });
    }
  });

  remoteWs.on('close', (code, reason) => {
    if (!isClosed) {
      console.log(`[Bridge] 🔌 Remote Closed (Code: ${code}, Reason: ${reason || 'none'})`);
      clientWs.close();
    }
  });

  remoteWs.on('error', (err) => {
    console.error(`[Bridge] ❌ Remote Error:`, err.message);
    if (clientWs.readyState === WebSocket.OPEN) {
       clientWs.close();
    }
  });

  // Handle data from Browser -> Onion Relay
  clientWs.on('message', (data, isBinary) => {
    const msgStr = data.toString();
    console.log(`[Bridge] << Client Message: ${msgStr.slice(0, 100)}${msgStr.length > 100 ? '...' : ''}`);

    if (remoteOpen && remoteWs.readyState === WebSocket.OPEN) {
      remoteWs.send(data, { binary: isBinary });
    } else {
      // Buffer the message until the remote is ready
      console.log(`[Bridge] 📥 Buffering client message...`);
      messageBuffer.push({ data, isBinary });
    }
  });

  clientWs.on('close', () => {
    isClosed = true;
    console.log(`[Bridge] 👤 Client Disconnected.`);
    remoteWs.close();
  });

  clientWs.on('error', (err) => {
    console.error(`[Bridge] ❌ Client Error:`, err.message);
    remoteWs.close();
  });
});

server.listen(BRIDGE_PORT, BRIDGE_HOST, () => {
  console.log(`✅ Bridge Ready! Use 'ws://${BRIDGE_HOST}:${BRIDGE_PORT}?target=ws://...onion'\n`);
});

