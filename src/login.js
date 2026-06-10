import puppeteer from "puppeteer";
import path from "path";
import fs from "fs";
import { execSync } from "child_process";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const USER_DATA_DIR = path.resolve(__dirname, "../puppeteer_data");

function clearSingletonLock() {
  const lockFile = path.join(USER_DATA_DIR, "SingletonLock");
  try {
    execSync(`rm -f "${lockFile}"`);
    console.log("🔓 SingletonLock 삭제 완료");
  } catch (e) {
    // 무시
  }
}

/**
 * 네이버 로그인 페이지를 Puppeteer로 열고 사용자의 수동 로그인을 대기
 * @param {number} maxSeconds - 최대 대기 시간 (초)
 * @returns {Promise<Array>} 로그인 후 저장된 쿠키 배열
 */
export const naverlLogin = async (maxSeconds = 300) => {
  console.log("🔐 네이버 로그인 시작...");

  let browser = null;

  try {
    // 브라우저 실행 (헤드리스 X, 사용자가 볼 수 있게)
    clearSingletonLock();
    browser = await puppeteer.launch({
      headless: false, // 브라우저 창을 띄움
      channel: "chrome",
      userDataDir: USER_DATA_DIR,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-extensions",
        "--disable-blink-features=AutomationControlled",
        "--window-size=1280,800",
      ],
    });

    // 기존 페이지(첫 번째 탭)를 재사용해서 현재 탭에서 로그인되게 함
    const pages = await browser.pages();
    const page = pages.length > 0 ? pages[0] : await browser.newPage();
    page.setDefaultNavigationTimeout(0);
    page.setDefaultTimeout(0);
    await page.setViewport({ width: 1280, height: 800 });

    // User-Agent 설정
    await page.setUserAgent(
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    );

    // 네이버 쇼핑으로 이동 후 로그인 여부 확인
    console.log("🔗 네이버 쇼핑으로 이동...");
    await page.goto("https://shopping.naver.com/my/written-reviews", {
      waitUntil: "domcontentloaded",
      timeout: 0,
    });

    await new Promise((r) => setTimeout(r, 2000));
    const currentUrl = page.url();
    let naverId = null;

    // 이미 로그인된 경우 (쇼핑 페이지에 머물러 있음)
    if (!currentUrl.includes("nid.naver.com")) {
      console.log("✅ 이미 로그인된 상태입니다. URL:", currentUrl);
    } else {
      // 로그인 페이지로 리디렉션된 경우 → 사용자 수동 로그인 대기
      console.log("⏳ 사용자 로그인 대기 중... (최대 " + maxSeconds + "초)");
      console.log("💡 열려있는 브라우저 창에서 네이버 로그인을 완료해주세요.");

      let loginSuccess = false;
      const interval = 2000;
      const maxAttempts = Math.floor(maxSeconds / (interval / 1000));

      for (let i = 0; i < maxAttempts; i++) {
        await new Promise((r) => setTimeout(r, interval));

        try {
          const url = page.url();
          if (url.includes("nid.naver.com")) {
            // 아직 로그인 페이지에 있으면 아이디 입력값 읽기 시도
            const inputId = await page
              .evaluate(() => {
                const el = document.querySelector("#id");
                return el?.value?.trim() || null;
              })
              .catch(() => null);
            if (inputId) naverId = inputId;
          } else {
            console.log("✅ 로그인 성공! URL:", url);
            loginSuccess = true;
            break;
          }
        } catch (e) {
          // 무시
        }
      }

      if (!loginSuccess) {
        throw new Error("로그인 대기 시간이 초과되었습니다.");
      }
    }

    // 쿠키 추출
    const cookies = await page.cookies();
    console.log(`💾 ${cookies.length}개의 쿠키가 저장되었습니다.`);

    // 네이버 아이디 추출: 로그인 폼 #id 입력값이 폴링 중 캡처됐으면 사용
    // 아니면 네이버 메인에서 이메일 추출
    if (!naverId) {
      console.log("🔍 네이버 아이디 추출 시도...");
      try {
        // 타임아웃을 명시적으로 설정 (기본값 0=무한을 덮어씀)
        page.setDefaultNavigationTimeout(15000);
        page.setDefaultTimeout(10000);

        await page.goto("https://www.naver.com/", {
          waitUntil: "domcontentloaded",
        });
        await new Promise((r) => setTimeout(r, 3000));

        const bodyText = await page.evaluate(() => document.body?.innerText || "");
        console.log("🔍 naver.com 텍스트 (200자):", bodyText.substring(0, 200));

        const emailMatch = bodyText.match(/([a-zA-Z0-9._-]+)@naver\.com/);
        if (emailMatch) {
          naverId = emailMatch[1];
          console.log("✅ 네이버 메인에서 아이디 추출:", naverId);
        }
      } catch (e) {
        console.warn("⚠️ 네이버 메인 접근 실패:", e.message);
      }
    }

    if (!naverId) {
      console.warn("⚠️ 네이버 아이디 추출 실패");
    }

    console.log(`👤 네이버 아이디: ${naverId}`);
    await browser.close();

    return { cookies, naverId };
  } catch (error) {
    console.error("❌ 로그인 오류:", error.message);
    if (browser) {
      try {
        await browser.close();
      } catch (_) {
        /* ignore */
      }
    }
    throw error;
  }
};

export default naverlLogin;
