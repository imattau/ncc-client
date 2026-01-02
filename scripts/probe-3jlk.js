import { WebSocket } from 'ws';
import { SocksProxyAgent } from 'socks-proxy-agent';

const ONION_HOST = '3jlkvosxtic7q3ek3de276zwattupyoohn6u2fyr6asbc2djq6k7ehqd.onion';
const PORTS = [80, 443, 8080, 8081];
const TOR_PROXY = 'socks5h://127.0.0.1:9050';

console.log(`🔎 Probing ports on ${ONION_HOST}...`);

const agent = new SocksProxyAgent(TOR_PROXY);

async function checkPort(port) {
    return new Promise((resolve) => {
        const url = `ws://${ONION_HOST}:${port}`;
        console.log(`   Trying port ${port}...`);
        
        const ws = new WebSocket(url, { agent, handshakeTimeout: 15000 });
        
        const timer = setTimeout(() => {
            ws.terminate();
            resolve({ port, status: 'TIMEOUT' });
        }, 17000);

        ws.on('open', () => {
            clearTimeout(timer);
            ws.close();
            resolve({ port, status: 'OPEN' });
        });

        ws.on('error', (err) => {
            clearTimeout(timer);
            resolve({ port, status: 'ERROR', error: err.message });
        });
    });
}

async function run() {
    for (const port of PORTS) {
        const res = await checkPort(port);
        console.log(`   ${res.status === 'OPEN' ? '✅' : '❌'} Port ${res.port}: ${res.status} ${res.error ? '(' + res.error + ')' : ''}`);
    }
    process.exit(0);
}

run();
