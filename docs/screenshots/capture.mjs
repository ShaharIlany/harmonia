// README screenshots: run the demo server (TEAM_CHAT_STUB=1 PORT=4749 TEAM_CHAT_DATA=<demo-data.py output> bun server.ts), then node capture.mjs docs/screenshots
import { createRequire } from "node:module";
const require = createRequire(process.env.PLAYWRIGHT_FROM ?? import.meta.url); // a folder whose node_modules has playwright
const { chromium } = require("playwright");

const OUT = process.argv[2];
const URL = "http://localhost:4749/";
const browser = await chromium.launch();

async function page(scheme) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2, colorScheme: scheme });
  const p = await ctx.newPage();
  await p.goto(URL);
  await p.waitForSelector(".msg");
  // The demo runs the stub server: hide its badge.
  await p.addStyleTag({ content: "#stub-badge{display:none!important} .m-side{transition:none!important}" });
  return p;
}
const open = async (p, name) => {
  await p.click(`#channels [data-ch^="${name}-"]`);
  await p.waitForTimeout(300);
};
const shot = async (p, file) => {
  await p.mouse.move(1, 1);
  await p.waitForTimeout(200);
  await p.screenshot({ path: `${OUT}/${file}` });
};

const light = await page("light");
await light.setViewportSize({ width: 1440, height: 1240 });
await open(light, "dark-mode");
await shot(light, "channel.png");
await light.setViewportSize({ width: 1440, height: 900 });

await open(light, "csv-export");
await light.hover("#messages .msg:last-child .bubble");
await light.click("#messages .msg:last-child [data-reply]");
await light.keyboard.type("Yes, 500 on production too");
await shot(light, "reply-and-router.png");
await light.keyboard.press("Escape");

await open(light, "csv-export");
await light.locator("#messages .msg.in .bubble").last().click({ button: "right", position: { x: 220, y: 40 } });
await light.waitForTimeout(250);
await light.screenshot({ path: `${OUT}/menus.png` });
await light.keyboard.press("Escape");

await open(light, "dark-mode");
await light.click('#people [data-person="leo"]');
await light.waitForTimeout(400);
await shot(light, "teammate-settings.png");

const dark = await page("dark");
await dark.setViewportSize({ width: 1440, height: 1240 });
await open(dark, "dark-mode");
await shot(dark, "channel-dark.png");

await browser.close();
