import { chromium } from 'playwright';

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1200 } });

try {
  await page.goto('http://127.0.0.1:5176/app/app_17a7d7fdmvg/bill-recognition', {
    waitUntil: 'domcontentloaded',
  });
  await page.locator('input[type="file"]').setInputFiles(
    'C:/Users/26935/Downloads/SHAD64结算单-202605.pdf',
  );

  await page.waitForTimeout(8_000);
  await page.screenshot({ path: 'D:/710/shad64-upload-processing.png', fullPage: true });

  await page.waitForFunction(
    () => document.body.innerText.includes('待人工复核') || document.body.innerText.includes('视觉识别失败'),
    undefined,
    { timeout: 210_000 },
  );
  await page.screenshot({ path: 'D:/710/shad64-recognition-result.png', fullPage: true });

  const evidence = page.getByRole('button', { name: /第.*页定位/ }).first();
  if (await evidence.isVisible().catch(() => false)) {
    await evidence.click();
    await page.waitForTimeout(500);
    await page.screenshot({ path: 'D:/710/shad64-ocr-evidence.png', fullPage: true });
  }
} finally {
  await browser.close();
}
