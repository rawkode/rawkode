import { Storage } from "@google-cloud/storage";
import { launchChromium } from "playwright-aws-lambda";

// context also available
export const handler = async (event) => {
  try {
    const browser = await launchChromium();
    const context = await browser.newContext();

    const page = await context.newPage();

    await page.goto(event.url || "https://rawkode.dev");
    await page.screenshot({ path: "screenshot.png" });

    const storage = new Storage();

    const bucket = storage.bucket("opengraph.rawkode.dev");
    const file = bucket.file("screenshot.png");

    const options = {
      expires: Date.now() + 300 * 60 * 1000, //  300 minutes,
      fields: { "x-goog-meta-test": "data" },
    };

    const [response] = await file.generateSignedPostPolicyV4(options);
    res.status(200).json(response);
  } catch (error) {
    throw error;
  } finally {
    if (browser) {
      await browser.close();
    }
  }
};
