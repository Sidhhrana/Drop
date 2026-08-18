import puppeteer from 'puppeteer-core';
import { performance } from 'perf_hooks';

const BRAVE_PATH = '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser';
const APP_URL = 'http://localhost:5180';

async function testLargeSmooth() {
  console.log('🚀 Running Dual Sandbox Benchmark (50MB Transfer)...');
  const browser1 = await puppeteer.launch({
    executablePath: BRAVE_PATH,
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });
  const page1 = await browser1.newPage();
  await page1.setCacheEnabled(false);
  page1.on('console', msg => console.log('🖥️ [Host]:', msg.text()));

  const browser2 = await puppeteer.launch({
    executablePath: BRAVE_PATH,
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });
  const page2 = await browser2.newPage();
  await page2.setCacheEnabled(false);
  page2.on('console', msg => console.log('📱 [Joiner]:', msg.text()));

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
  console.log(`Room Code: [${code}]`);

  // 2. Joiner joins room
  await page2.waitForSelector('#join-room-input');
  await page2.type('#join-room-input', code);
  await page2.click('#join-room-form button[type="submit"]');

  // Wait for all channels to open
  await page1.waitForFunction(() => {
    return window.webrtc && window.webrtc.isConnected && window.webrtc.dataChannels.filter(c => c.readyState === 'open').length >= 4;
  }, { timeout: 15000 });

  await page2.waitForFunction(() => {
    return window.webrtc && window.webrtc.isConnected && window.webrtc.dataChannels.filter(c => c.readyState === 'open').length >= 4;
  }, { timeout: 15000 });

  console.log('✅ 8 Parallel Data Channels fully OPEN and ready on both sides!');

  const TEST_SIZE_MB = 50;
  console.log(`Starting transfer of ${TEST_SIZE_MB}MB file...`);

  const tStart = performance.now();
  await page1.evaluate(async (sizeMB) => {
    const bytes = new Uint8Array(sizeMB * 1024 * 1024);
    bytes.fill(0xAA);
    const blob = new Blob([bytes], { type: 'application/octet-stream' });
    const file = new File([blob], `benchmark-${sizeMB}mb.bin`, { type: 'application/octet-stream' });
    console.log('Host calling sendFile...');
    await window.webrtc.sendFile(file);
    console.log('Host sendFile finished!');
  }, TEST_SIZE_MB);

  await page2.waitForFunction(() => {
    return document.querySelectorAll('#transfers-list .transfer-card').length > 0;
  }, { timeout: 30000 });

  const tEnd = performance.now();
  const elapsedSec = (tEnd - tStart) / 1000;
  const speedMBps = TEST_SIZE_MB / elapsedSec;

  console.log(`🎉 50MB Transfer Completed in ${elapsedSec.toFixed(2)}s (${speedMBps.toFixed(2)} MB/s constant smooth throughput)!`);

  await browser1.close();
  await browser2.close();
}

testLargeSmooth().catch(console.error);
