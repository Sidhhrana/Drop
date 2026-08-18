import puppeteer from 'puppeteer-core';

const BRAVE_PATH = '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser';
const APP_URL = 'https://drop-p2p.pages.dev';

async function runE2ETest() {
  console.log('🚀 Launching Sandbox 1 (Host)...');
  const browser1 = await puppeteer.launch({
    executablePath: BRAVE_PATH,
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });
  const page1 = await browser1.newPage();

  page1.on('console', msg => console.log('🖥️ [Sandbox 1 Log]:', msg.type(), msg.text()));
  page1.on('pageerror', err => console.error('❌ [Sandbox 1 Error]:', err));

  console.log('🚀 Launching Sandbox 2 (Joiner)...');
  const browser2 = await puppeteer.launch({
    executablePath: BRAVE_PATH,
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });
  const page2 = await browser2.newPage();

  page2.on('console', msg => console.log('📱 [Sandbox 2 Log]:', msg.type(), msg.text()));
  page2.on('pageerror', err => console.error('❌ [Sandbox 2 Error]:', err));

  console.log(`Navigating both sandboxes to ${APP_URL}...`);
  await page1.goto(APP_URL, { waitUntil: 'networkidle0' });
  await page2.goto(APP_URL, { waitUntil: 'networkidle0' });

  // Sandbox 1: Click "Create Room Code"
  console.log('Sandbox 1: Clicking Create Room Code...');
  await page1.waitForSelector('#create-room-btn');
  await page1.click('#create-room-btn');

  // Wait for room code to generate
  await page1.waitForFunction(() => {
    const code = document.getElementById('active-room-code').textContent;
    return code && code !== '------' && code.length === 6;
  }, { timeout: 10000 });

  const roomCode = await page1.$eval('#active-room-code', el => el.textContent);
  console.log(`✅ Sandbox 1 created room with code: [${roomCode}]`);

  // Sandbox 2: Join room
  console.log(`Sandbox 2: Entering code [${roomCode}] and joining...`);
  await page2.waitForSelector('#join-room-input');
  await page2.type('#join-room-input', roomCode);
  await page2.click('#join-room-form button[type="submit"]');

  // Wait 6 seconds and check connection status on both
  console.log('Waiting for WebRTC handshake to settle...');
  await new Promise(r => setTimeout(r, 6000));

  const status1 = await page1.$eval('#global-status-text', el => el.textContent);
  const status2 = await page2.$eval('#global-status-text', el => el.textContent);
  const banner1 = await page1.$eval('#connected-peer-banner', el => el.style.display);
  const banner2 = await page2.$eval('#connected-peer-banner', el => el.style.display);

  console.log(`Sandbox 1 Status: "${status1}", Banner Display: "${banner1}"`);
  console.log(`Sandbox 2 Status: "${status2}", Banner Display: "${banner2}"`);

  // Test sending text message from Sandbox 1 to Sandbox 2
  console.log('Testing text transmission Sandbox 1 -> Sandbox 2...');
  await page1.click('#tab-text-btn');
  await page1.type('#text-share-input', 'Hello from Sandbox 1!');
  await page1.click('#send-text-btn');

  await new Promise(r => setTimeout(r, 2000));

  const receivedTextCount = await page2.$$eval('#received-text-list > div', divs => divs.length);
  console.log(`Sandbox 2 Received Messages Count: ${receivedTextCount}`);

  await browser1.close();
  await browser2.close();

  if (banner1 !== 'none' && banner2 !== 'none' && receivedTextCount > 0) {
    console.log('🎉 E2E TEST PASSED 100% SUCCESSFULLY!');
  } else {
    console.log('⚠️ E2E TEST FAILED: Connection not fully established.');
  }
}

runE2ETest().catch(err => {
  console.error('Fatal error during E2E test:', err);
  process.exit(1);
});
