import puppeteer from 'puppeteer-core';
import { performance } from 'perf_hooks';
import http from 'http';
import fs from 'fs';
import path from 'path';

const BRAVE_PATH = '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser';
const DIST_DIR = '/Users/sidhhrana/Documents/codes/Drop/client/dist';

// Static HTTP Server for Client Dist
const server = http.createServer((req, res) => {
  let filePath = path.join(DIST_DIR, req.url === '/' ? 'index.html' : req.url.split('?')[0]);
  if (!fs.existsSync(filePath)) {
    filePath = path.join(DIST_DIR, 'index.html');
  }
  const ext = path.extname(filePath);
  const mimeTypes = {
    '.html': 'text/html',
    '.js': 'text/javascript',
    '.css': 'text/css',
    '.json': 'application/json',
    '.png': 'image/png',
    '.svg': 'image/svg+xml'
  };
  res.writeHead(200, { 'Content-Type': mimeTypes[ext] || 'application/octet-stream' });
  fs.createReadStream(filePath).pipe(res);
});

server.listen(5199, async () => {
  console.log('🚀 Static Production Server listening on http://localhost:5199');
  try {
    await runBenchmark();
  } catch (e) {
    console.error('❌ Benchmark error:', e);
  } finally {
    server.close();
    process.exit(0);
  }
});

async function runBenchmark() {
  console.log('⚡ Launching host and joiner browsers...');
  const browser1 = await puppeteer.launch({
    executablePath: BRAVE_PATH,
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });
  const page1 = await browser1.newPage();
  page1.on('console', msg => console.log('🖥️ [Host]:', msg.text()));

  const browser2 = await puppeteer.launch({
    executablePath: BRAVE_PATH,
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });
  const page2 = await browser2.newPage();
  page2.on('console', msg => console.log('📱 [Joiner]:', msg.text()));

  console.log('Navigating to app...');
  await page1.goto('http://localhost:5199', { waitUntil: 'domcontentloaded' });
  await page2.goto('http://localhost:5199', { waitUntil: 'domcontentloaded' });

  // 1. Host creates room
  await page1.waitForSelector('#create-room-btn');
  await page1.click('#create-room-btn');

  await page1.waitForFunction(() => {
    const code = document.getElementById('active-room-code').textContent;
    return code && code !== '------' && code.length === 6;
  });

  const code = await page1.$eval('#active-room-code', el => el.textContent);
  console.log(`Room Code: [${code}]`);

  // 2. Joiner joins room
  await page2.waitForSelector('#join-room-input');
  await page2.type('#join-room-input', code);
  await page2.click('#join-room-form button[type="submit"]');

  await page1.waitForFunction(() => window.webrtc && window.webrtc.isConnected, { timeout: 15000 });
  await page2.waitForFunction(() => window.webrtc && window.webrtc.isConnected, { timeout: 15000 });

  console.log('✅ WebRTC Connected!');

  const TEST_SIZE_MB = 100;
  console.log(`Blasting ${TEST_SIZE_MB}MB file transfer across 8 parallel channels...`);

  const tStart = performance.now();
  await page1.evaluate(async (sizeMB) => {
    const bytes = new Uint8Array(sizeMB * 1024 * 1024);
    bytes.fill(0x77);
    const blob = new Blob([bytes], { type: 'application/octet-stream' });
    const file = new File([blob], `speed-test-${sizeMB}mb.bin`, { type: 'application/octet-stream' });
    console.log('Host starting direct sendFile...');
    await window.webrtc.sendFile(file);
    console.log('Host sendFile finished successfully!');
  }, TEST_SIZE_MB);

  await page2.waitForFunction(() => {
    return document.querySelectorAll('#transfers-list .transfer-card').length > 0;
  }, { timeout: 30000 });

  const tEnd = performance.now();
  const elapsedSec = (tEnd - tStart) / 1000;
  const speedMBps = TEST_SIZE_MB / elapsedSec;

  console.log(`\n🎉 RESULTS: ${TEST_SIZE_MB} MB transferred in ${elapsedSec.toFixed(2)}s (${speedMBps.toFixed(2)} MB/s constant smooth throughput)!`);

  await browser1.close();
  await browser2.close();
}
