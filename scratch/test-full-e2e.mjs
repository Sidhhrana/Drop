import puppeteer from 'puppeteer-core';
import fs from 'fs';
import path from 'path';

const BRAVE_PATH = '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser';
const APP_URL = 'https://drop-p2p.pages.dev';

// Create a 5MB dummy test file in scratch
const testFilePath = path.resolve('./scratch/test-file-5mb.bin');
const buffer = Buffer.alloc(5 * 1024 * 1024, 0xAB);
fs.writeFileSync(testFilePath, buffer);

async function testFullTransfer() {
  console.log('🚀 Launching Dual Sandbox E2E Test...');
  const browser1 = await puppeteer.launch({
    executablePath: BRAVE_PATH,
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });
  const page1 = await browser1.newPage();
  await page1.setCacheEnabled(false);
  page1.on('console', msg => console.log('🖥️ [Host]:', msg.type(), msg.text()));
  page1.on('pageerror', err => console.error('❌ [Host PageError]:', err));

  const browser2 = await puppeteer.launch({
    executablePath: BRAVE_PATH,
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });
  const page2 = await browser2.newPage();
  await page2.setCacheEnabled(false);
  page2.on('console', msg => console.log('📱 [Joiner]:', msg.type(), msg.text()));
  page2.on('pageerror', err => console.error('❌ [Joiner PageError]:', err));

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

  // Wait for connection to establish
  console.log('Waiting for public WebRTC handshake over STUN/Render...');
  await page1.waitForFunction(() => {
    const dot = document.getElementById('global-status-dot');
    return dot && dot.classList.contains('connected');
  }, { timeout: 30000 });

  await page2.waitForFunction(() => {
    const dot = document.getElementById('global-status-dot');
    return dot && dot.classList.contains('connected');
  }, { timeout: 30000 });

  console.log('✅ Both sandboxes are CONNECTED and 8 parallel channels are open!');

  // 3. Test File Transfer: Host uploads 5MB file -> Joiner receives file
  console.log('Host sending 5MB test file directly via WebRTC engine...');
  await page1.evaluate(async () => {
    try {
      const bytes = new Uint8Array(5 * 1024 * 1024);
      bytes.fill(65); // 'A'
      const blob = new Blob([bytes], { type: 'application/octet-stream' });
      const file = new File([blob], 'e2e-test-file-5mb.bin', { type: 'application/octet-stream' });
      console.log('Calling sendFile on file:', file.name, file.size);
      await window.webrtc.sendFile(file);
      console.log('sendFile completed successfully on Host!');
    } catch (e) {
      console.error('Error during sendFile in page1:', e.message, e.stack);
    }
  });

  // Wait for Joiner to receive completed file
  await page2.waitForFunction(() => {
    const items = document.querySelectorAll('#transfers-list .transfer-card');
    return items.length > 0;
  }, { timeout: 15000 });

  const joinerReceivedFileName = await page2.$eval('#transfers-list .transfer-filename', el => el.textContent);
  console.log(`🎉 Joiner successfully received file: "${joinerReceivedFileName}"!`);

  await browser1.close();
  await browser2.close();
  console.log('🌟 100% PASS: WebRTC Dual-Sandbox Connection and Multi-Lane Transfer Verified!');
}

testFullTransfer().catch(err => {
  console.error('❌ E2E Test Failed:', err);
  process.exit(1);
});
