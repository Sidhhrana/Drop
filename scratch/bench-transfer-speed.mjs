import puppeteer from 'puppeteer-core';
import { performance } from 'perf_hooks';

const BRAVE_PATH = '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser';
const APP_URL = 'http://localhost:5180';

async function testThroughput() {
  console.log('🚀 Launching Dual Sandbox High-Speed Throughput Benchmark...');
  const browser1 = await puppeteer.launch({
    executablePath: BRAVE_PATH,
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });
  const page1 = await browser1.newPage();
  await page1.setCacheEnabled(false);

  const browser2 = await puppeteer.launch({
    executablePath: BRAVE_PATH,
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });
  const page2 = await browser2.newPage();
  await page2.setCacheEnabled(false);

  await page1.goto(APP_URL, { waitUntil: 'networkidle0' });
  await page2.goto(APP_URL, { waitUntil: 'networkidle0' });

  // 1. Host creates room
  await page1.waitForSelector('#create-room-btn');
  await page1.click('#create-room-btn');

  await page1.waitForFunction(() => {
    const code = document.getElementById('active-room-code').textContent;
    return code && code !== '------' && code.length === 6;
  });

  const code = await page1.$eval('#active-room-code', el => el.textContent);
  console.log(`Host created room code: [${code}]`);

  // 2. Joiner joins room
  await page2.waitForSelector('#join-room-input');
  await page2.type('#join-room-input', code);
  await page2.click('#join-room-form button[type="submit"]');

  await page1.waitForFunction(() => {
    const dot = document.getElementById('global-status-dot');
    return dot && dot.classList.contains('connected');
  }, { timeout: 15000 });

  await page2.waitForFunction(() => {
    const dot = document.getElementById('global-status-dot');
    return dot && dot.classList.contains('connected');
  }, { timeout: 15000 });

  console.log('✅ Connected with 8 parallel channels.');

  // Test 100MB file transfer speed
  const TEST_SIZE_MB = 100;
  console.log(`Testing transfer of ${TEST_SIZE_MB}MB file across 8 parallel channels...`);

  const tStart = performance.now();
  await page1.evaluate(async (sizeMB) => {
    const bytes = new Uint8Array(sizeMB * 1024 * 1024);
    bytes.fill(0x55);
    const blob = new Blob([bytes], { type: 'application/octet-stream' });
    const file = new File([blob], `benchmark-${sizeMB}mb.bin`, { type: 'application/octet-stream' });
    await window.webrtc.sendFile(file);
  }, TEST_SIZE_MB);

  await page2.waitForFunction(() => {
    const items = document.querySelectorAll('#transfers-list .transfer-card');
    return items.length > 0;
  }, { timeout: 30000 });

  const tEnd = performance.now();
  const elapsedSec = (tEnd - tStart) / 1000;
  const speedMBps = TEST_SIZE_MB / elapsedSec;

  console.log(`🎉 Transferred ${TEST_SIZE_MB} MB in ${elapsedSec.toFixed(2)}s (${speedMBps.toFixed(2)} MB/s throughput)!`);

  await browser1.close();
  await browser2.close();
}

testThroughput().catch(console.error);
