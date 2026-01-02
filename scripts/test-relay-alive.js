import http from 'http';
import { SocksProxyAgent } from 'socks-proxy-agent';

const RELAY_ONION = 'http://rk3v46dbyw3ns3rtuy6mw4hlgpaf2ot6xtcaqbqmhd4xje7hluh7loqd.onion/';
const TOR_PROXY = 'socks5h://127.0.0.1:9050';

console.log(`🕵️ Checking if Relay is alive: ${RELAY_ONION}`);

const agent = new SocksProxyAgent(TOR_PROXY);

const req = http.get(RELAY_ONION, { agent, timeout: 30000 }, (res) => {
  console.log(`✅ Status: ${res.statusCode}`);
  process.exit(0);
});

req.on('error', (err) => {
  console.error(`❌ Relay Unreachable:`, err.message);
  process.exit(1);
});

req.on('timeout', () => {
  console.error(`⌛ Timeout: Relay did not respond within 30s.`);
  req.destroy();
  process.exit(1);
});
