import { chromium } from 'playwright-core';
// Optional dedicated, disposable Chromium process for the Docker fallback.
const service = await chromium.launchServer({
  host:'0.0.0.0',port:36415,headless:true,timeout:15_000,
  args:['--disable-component-update','--disable-background-networking','--disable-sync']
});
console.log('QIZHOU_BROWSER_ENDPOINT=' + service.wsEndpoint());
for (const signal of ['SIGINT','SIGTERM']) process.once(signal,async () => {
  await service.close().catch(() => {}); process.exit(0);
});
