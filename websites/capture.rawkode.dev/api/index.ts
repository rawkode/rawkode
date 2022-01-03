import chrome from "chrome-aws-lambda";
import { IncomingMessage, ServerResponse } from "http";
import core from "puppeteer-core";

export default async function handler(
  _req: IncomingMessage,
  res: ServerResponse
) {
  try {
    const browser = await core.launch({
      args: [...chrome.args, "--hide-scrollbars", "--disable-web-security"],
      headless: chrome.headless,
      executablePath: await chrome.executablePath,
      defaultViewport: {
        width: 1920,
        height: 1080,
      },
    });

    const page = await browser.newPage();

    await page.goto("https://opengraph.rawkode.dev");
    const screenshot = await page.screenshot();
    await browser.close();

    res.statusCode = 200;
    res.setHeader("Content-Type", `image/png`);
    res.setHeader(
      "Cache-Control",
      `public, immutable, no-transform, s-maxage=31536000, max-age=31536000`
    );
    res.end(screenshot);
  } catch (error) {
    res.statusCode = 500;
    res.setHeader("Content-Type", "text/html");
    res.end("<h1>Internal Error</h1><p>Sorry, there was a problem</p>");
    console.error(error);
  }
}
