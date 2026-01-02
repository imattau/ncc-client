import { WebSocket } from 'ws';
import http from 'http';

const LOCAL_RELAY_WS = 'ws://localhost:8081';
const LOCAL_RELAY_HTTP = 'http://localhost:8081';

console.log(`🔍 Checking Local Relay...`);
console.log(`🌐 WebSocket: ${LOCAL_RELAY_WS}`);
console.log(`📄 HTTP Info:  ${LOCAL_RELAY_HTTP}`);

// 1. Check HTTP / NIP-11
const checkHttp = () => {
    return new Promise((resolve) => {
        const options = {
            headers: { 'Accept': 'application/nostr+json' },
            timeout: 2000
        };
        
        const req = http.get(LOCAL_RELAY_HTTP, options, (res) => {
            console.log(`✅ HTTP Status: ${res.statusCode}`);
            let body = '';
            res.on('data', chunk => body += chunk);
            res.on('end', () => {
                if (res.headers['content-type']?.includes('application/nostr+json')) {
                    console.log(`✅ NIP-11 Supported!`);
                    try {
                        const info = JSON.parse(body);
                        console.log(`   Name: ${info.name || 'Unknown'}`);
                        console.log(`   Software: ${info.software || 'Unknown'}`);
                    } catch(e) {}
                }
                resolve(true);
            });
        });

        req.on('error', (err) => {
            console.error(`❌ HTTP Error: ${err.message}`);
            resolve(false);
        });
        
        req.on('timeout', () => {
            console.error(`❌ HTTP Timeout`);
            req.destroy();
            resolve(false);
        });
    });
};

// 2. Check WebSocket
const checkWs = () => {
    return new Promise((resolve) => {
        const ws = new WebSocket(LOCAL_RELAY_WS);
        
        const timeout = setTimeout(() => {
            console.error('❌ WebSocket Timeout');
            ws.terminate();
            resolve(false);
        }, 3000);

        ws.on('open', () => {
            console.log('✅ WebSocket Connected!');
            clearTimeout(timeout);
            ws.close();
            resolve(true);
        });

        ws.on('error', (err) => {
            console.error(`❌ WebSocket Error: ${err.message}`);
            clearTimeout(timeout);
            resolve(false);
        });
    });
};

async function run() {
    const httpOk = await checkHttp();
    const wsOk = await checkWs();
    
    if (httpOk && wsOk) {
        console.log('\n🌟 Local Relay is HEALTHY');
    } else {
        console.log('\n⚠️ Local Relay has ISSUES');
    }
    process.exit(httpOk && wsOk ? 0 : 1);
}

run();
