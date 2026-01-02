import http from 'http';
import { SocksProxyAgent } from 'socks-proxy-agent';

const ONION_URL = 'http://7gwqlr2fu4uu77qnymfxkjtmfc6ddbz7riy2s7n3naavv5ouymx5ivqd.onion/';
const TOR_PROXY = 'socks5h://127.0.0.1:9050';

console.log(`🌐 Testing Tor Connectivity...`);
console.log(`🔗 Target: ${ONION_URL}`);
console.log(`🕵️ Proxy:  ${TOR_PROXY}`);

const agent = new SocksProxyAgent(TOR_PROXY);

http.get(ONION_URL, { agent }, (res) => {
  console.log(`✅ Success! Response Code: ${res.statusCode}`);
  console.log(`📝 Headers:`, res.headers['server'] || 'No server header');
  
  let data = '';
  res.on('data', (chunk) => data += chunk);
  res.on('end', () => {
    console.log(`📄 Content length received: ${data.length} bytes`);
    process.exit(0);
  });
}).on('error', (err) => {
  console.error(`❌ Connection Failed:`, err.message);
  if (err.message.includes('ECONNREFUSED')) {
    console.error(`   Hint: Is your system Tor service running on port 9050?`);
  }
  process.exit(1);
});
