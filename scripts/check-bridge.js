import { WebSocket } from 'ws';

const BRIDGE_URL = 'ws://localhost:3001?target=ws://rk3v46dbyw3ns3rtuy6mw4hlgpaf2ot6xtcaqbqmhd4xje7hluh7loqd.onion:80';

console.log('🔍 Checking Tor Bridge on localhost:3001...');

const ws = new WebSocket(BRIDGE_URL);

let timeout = setTimeout(() => {
    console.error('❌ Timeout: Bridge did not respond. Is it running? (npm run dev or npm run bridge)');
    process.exit(1);
}, 5000);

ws.on('open', () => {
    console.log('✅ Bridge Connection Open!');
    console.log('   Note: This only confirms the bridge is reachable.');
    console.log('   If the onion relay is down or Tor is off, you will see a Remote Error soon.');
});

ws.on('message', (data) => {
    console.log('📥 Received data from bridge:', data.toString());
});

ws.on('error', (err) => {
    console.error('❌ Bridge Error:', err.message);
    if (err.message.includes('ECONNREFUSED')) {
        console.error('   Hint: The bridge server is not running.');
    }
});

ws.on('close', () => {
    console.log('🚪 Bridge Connection Closed.');
    clearTimeout(timeout);
    process.exit(0);
});
