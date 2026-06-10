import puppeteer from "puppeteer";
import path from "path";
const USER_DATA_DIR = path.resolve("./puppeteer_data");
(async () => {
  const browser = await puppeteer.launch({
    headless: false,
    channel: "chrome",
    userDataDir: USER_DATA_DIR,
  });
  const pages = await browser.pages();
  console.log("Pages lengths:", pages.length);
  if (pages.length > 0) {
    await pages[0].goto("https://www.google.com");
  }
  setTimeout(() => {
    browser.close();
  }, 5000);
})();
