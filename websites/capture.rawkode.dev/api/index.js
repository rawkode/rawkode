import chrome from "chrome-aws-lambda";
import core from "puppeteer-core";

export default async function handler(req, res) {
  try {
    const browser = await core.launch({
      args: [...chrome.args, "--hide-scrollbars", "--disable-web-security"],
      headless: chrome.headless,
      executablePath: await chrome.executablePath,
      defaultViewport: {
        width: 1200,
        height: 600,
      },
    });

    const page = await browser.newPage();

    await page.goto(
      `https://opengraph.rawkode.dev/${req.query.template || ""}?id=${
        req.query.id
      }`
    );
    const screenshot = await page.screenshot();
    await browser.close();

    res.statusCode = 200;
    res.setHeader("Content-Type", `image/png`);
    res.setHeader(
      "Cache-Control",
      `public, no-transform, s-maxage=300, max-age=300`
    );
    res.end(screenshot);
  } catch (error) {
    res.statusCode = 500;
    res.setHeader("Content-Type", "text/html");
    res.end("<h1>Internal Error</h1><p>Sorry, there was a problem</p>");
    console.error(error);
  }
}