import { chromium } from 'playwright';
const browser = await chromium.launch({ args: ['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--no-sandbox','--disable-dev-shm-usage'] });
const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
page.on('pageerror', (e) => console.log('PAGEERROR', e.message));
await page.goto('http://localhost:5173/?q=low', { waitUntil: 'load' });
await page.waitForFunction(() => window.__game && window.__dev && !document.getElementById('start').classList.contains('hidden'), null, { timeout: 300000 });
await page.evaluate(() => window.__game.start());
await page.waitForTimeout(2000);

const sample = async (label) => {
  await page.evaluate(() => window.__dev.logAlignment(20));
  await page.waitForFunction(() => window.__alignmentLog.length >= 20, null, { timeout: 120000 });
  const log = await page.evaluate(() => window.__alignmentLog);
  const dots = log.map((l) => l.dot);
  const last = log[log.length - 1];
  console.log(`${label.padEnd(7)} dot range ${Math.min(...dots).toFixed(3)}..${Math.max(...dots).toFixed(3)} | barrel ${JSON.stringify(last.barrel)} fwd ${JSON.stringify(last.forward)} | parent ${last.parent} yaw ${last.facingYaw}`);
  console.log(`        pivotQuat ${JSON.stringify(last.pivotQuat)} handPos ${JSON.stringify(last.handPos)}`);
  return log;
};
await sample('idle');
await page.evaluate(() => window.__game.input.setTouchMove(0, 1));
await page.waitForTimeout(2500);
await sample('walk');
await page.evaluate(() => window.__game.input.setTouchSprint(true));
await page.waitForTimeout(2500);
await sample('sprint');
await browser.close();
