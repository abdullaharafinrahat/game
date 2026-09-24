/**
 * Diagnoses boot at a given quality tier: dumps console output, the loading
 * label, any error overlay text, and whether __game/__dev appeared.
 */
import { chromium } from 'playwright';

const tier = process.argv[2] ?? 'medium';
const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox', '--disable-dev-shm-usage'],
});
const page = await browser.newPage({ viewport: { width: 900, height: 600 } });
const messages = [];
page.on('console', (m) => messages.push(`${m.type()}: ${m.text()}`));
page.on('pageerror', (e) => messages.push(`PAGEERROR: ${e.message}\n${(e.stack ?? '').split('\n').slice(0, 6).join('\n')}`));

await page.goto(`http://localhost:5173/?q=${tier}`, { waitUntil: 'load', timeout: 60000 });

for (let i = 0; i < 12; i++) {
  await page.waitForTimeout(10000);
  const state = await page.evaluate(() => ({
    hasGame: Boolean(window.__game),
    hasDev: Boolean(window.__dev),
    startHidden: document.getElementById('start')?.classList.contains('hidden'),
    errorHidden: document.getElementById('error')?.classList.contains('hidden'),
    loadingHidden: document.getElementById('loading')?.classList.contains('hidden'),
    label: document.getElementById('loadingLabel')?.textContent,
    detail: document.getElementById('loadingDetail')?.textContent,
    errorText: document.getElementById('errorText')?.textContent,
    frames: window.__game?.scene?.getFrameId?.() ?? null,
    tier: window.__game?.tier ?? null,
  }));
  console.log(`t+${(i + 1) * 10}s`, JSON.stringify(state));
  if (state.errorHidden === false || (state.hasGame && state.startHidden === false)) break;
  if (state.frames !== null) break;
}

console.log('\n--- console ---');
for (const m of messages.slice(0, 30)) console.log(m);
await browser.close();
