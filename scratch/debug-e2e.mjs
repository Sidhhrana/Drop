import puppeteer from 'puppeteer-core';

const BRAVE_PATH = '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser';
const APP_URL = 'http://localhost:5180'; // Test directly against local dev server for rapid debugging

async function debugE2E() {
  console.log('🚀 Starting detailed E2E debug run...');
  const browser1 = await puppeteer.launch({
    executablePath: BRAVE_PATH,
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });
  const page1 = await browser1.newPage();

  page1.on('console', msg => console.log('🖥️ [Host]:', msg.type(), msg.text()));
  page1.on('pageerror', err => console.error('❌ [Host PageError]:', err));

  const browser2 = await puppeteer.launch({
    executablePath: BRAVE_PATH,
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });
  const page2 = await browser2.newPage();

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

  // Wait 4 seconds for channels
  await new Promise(r => setTimeout(r, 4000));

  // Inspect connection state inside both pages
  const hostState = await page1.evaluate(() => {
    return {
      statusText: document.getElementById('global-status-text').textContent,
      bannerDisplay: document.getElementById('connected-peer-banner').style.display,
      connectedPeerName: document.getElementById('connected-peer-name').textContent
    };
  });

  const joinerState = await page2.evaluate(() => {
    return {
      statusText: document.getElementById('global-status-text').textContent,
      bannerDisplay: document.getElementById('connected-peer-banner').style.display,
      connectedPeerName: document.getElementById('connected-peer-name').textContent
    };
  });

  console.log('Host DOM State:', JSON.stringify(hostState));
  console.log('Joiner DOM State:', JSON.stringify(joinerState));

  // Try sending a message from Host
  console.log('Sending message from Host...');
  await page1.click('#tab-text-btn');
  await page1.type('#text-share-input', 'Test message from Host');
  await page1.click('#send-text-btn');

  await new Promise(r => setTimeout(r, 2000));

  const joinerReceived = await page2.evaluate(() => {
    const stream = document.getElementById('received-text-stream');
    const items = document.querySelectorAll('#received-text-list > div');
    return {
      streamDisplay: stream.style.display,
      itemCount: items.length,
      firstText: items.length > 0 ? items[0].textContent : null
    };
  });

  console.log('Joiner Received State:', JSON.stringify(joinerReceived));

  await browser1.close();
  await browser2.close();
}

debugE2E().catch(console.error);
