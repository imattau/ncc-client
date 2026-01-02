import { WebSocket } from 'ws';
import { SocksProxyAgent } from 'socks-proxy-agent';

const ONION_HOST = 'rk3v46dbyw3ns3rtuy6mw4hlgpaf2ot6xtcaqbqmhd4xje7hluh7loqd.onion';
const PORTS = [80, 8080, 8081, 443];
const TOR_PROXY = 'socks5h://127.0.0.1:9050';

console.log(`🔎 Scanning common ports on ${ONION_HOST}...`);

const agent = new SocksProxyAgent(TOR_PROXY);

async function checkPort(port) {
    return new Promise((resolve) => {
        const url = `ws://${ONION_HOST}:${port}`;
        console.log(`   Trying port ${port}...`);
        
        const ws = new WebSocket(url, { agent, handshakeTimeout: 10000 });
        
        const timer = setTimeout(() => {
            ws.terminate();
            resolve({ port, status: 'TIMEOUT' });
        }, 12000);

        ws.on('open', () => {
            clearTimeout(timer);
            ws.close();
            resolve({ port, status: 'OPEN' });
        });

        ws.on('error', (err) => {
            clearTimeout(timer);
            resolve({ port, status: 'CLOSED', error: err.message });
        });
    });
}

async function run() {
    const results = [];
    for (const port of PORTS) {
        results.push(await checkPort(port));
    }
    
    console.log('\n📊 Scan Results:');
    results.forEach(r => {
        const icon = r.status === 'OPEN' ? '✅' : '❌';
        console.log(`${icon} Port ${r.port}: ${r.status} ${r.error ? '(' + r.error + ')' : ''}`);
    });
    process.exit(0);
}

run();
