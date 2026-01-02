import { WebSocket } from 'ws';
import { SocksProxyAgent } from 'socks-proxy-agent';

const PUBLIC_RELAY = 'wss://relay.damus.io';
const TOR_PROXY = 'socks5h://127.0.0.1:9050';

console.log(`🕵️ Testing Bridge-to-Proxy plumbing...`);
console.log(`🔗 Target: ${PUBLIC_RELAY} (via Tor)`);

const agent = new SocksProxyAgent(TOR_PROXY);

const ws = new WebSocket(PUBLIC_RELAY, { agent, handshakeTimeout: 20000 });

const timer = setTimeout(() => {
    console.error('❌ Timeout: No response from relay via Tor.');
    ws.terminate();
    process.exit(1);
}, 25000);

ws.on('open', () => {
    console.log('✅ Success! Bridge can reach public relays via Tor proxy.');
    console.log('   This confirms the connection to port 9050 is working.');
    clearTimeout(timer);
    ws.close();
    process.exit(0);
});

ws.on('error', (err) => {
    console.error(`❌ Connection Failed:`, err.message);
    clearTimeout(timer);
    process.exit(1);
});
