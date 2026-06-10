import puppeteer from "puppeteer";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const USER_DATA_DIR = path.resolve(__dirname, "../puppeteer_data");

const RETURN_URL = encodeURIComponent(
  "https://shopping.naver.com/popup/reviews/redirect?action=REVIEW_MODIFIED",
);

/**
 * [레거시 — Puppeteer 브라우저 팝업 방식]
 * 현재는 reviewApiHttp.js (axios 직접 HTTP) 로 교체됨.
 * 참고용으로만 보존합니다.
 */
// export const editReview = async ( /* ← 아래 전체 함수가 주석 처리됨 */
const editReviewLegacy = async (
  reviewId,
  orderNo,
  productOrderNo,
  newContent,
  newRating,
  cookies,
) => {
  console.log(
    `✏️  리뷰 수정 시작: reviewId=${reviewId}, productOrderNo=${productOrderNo}, 별점=${newRating}점`,
  );

  let browser = null;

  try {
    browser = await puppeteer.launch({
      headless: "new",
      channel: "chrome",
      userDataDir: USER_DATA_DIR,
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
    });

    const page = await browser.newPage();
    page.setDefaultNavigationTimeout(30000);
    page.setDefaultTimeout(30000);
    await page.setViewport({ width: 1280, height: 800 });

    // 쿠키 설정
    if (cookies && cookies.length > 0) {
      await page.setCookie(...cookies);
      console.log(`✅ ${cookies.length}개 쿠키 로드 완료`);
    }

    // ── 1단계: 실제 리뷰 ID 확보 ──
    // DB에 저장된 review_id가 productOrderNo와 같으면 잘못 저장된 것이므로
    // 작성한 리뷰 목록 페이지에서 window.open을 인터셉트해 실제 팝업 URL을 추출한다.
    let actualReviewId = reviewId;

    if (!actualReviewId || actualReviewId === String(productOrderNo)) {
      console.log("🔍 실제 리뷰 ID 탐색 중 (written-reviews 페이지 방문)...");

      // window.open 인터셉트를 위해 페이지 이동 전 설정
      let capturedPopupUrl = null;
      await page.exposeFunction("__capturePopupUrl__", (url) => {
        capturedPopupUrl = url;
        console.log(`🎯 팝업 URL 캡처: ${url}`);
      });

      await page.evaluateOnNewDocument(() => {
        const origOpen = window.open;
        window.open = function (url, ...args) {
          if (url) window.__capturePopupUrl__(url);
          // 실제 팝업은 열지 않음 (빈 객체 반환)
          return { focus: () => {}, close: () => {}, location: { href: url } };
        };
      });

      await page.goto("https://shopping.naver.com/my/written-reviews", {
        waitUntil: "networkidle2",
      });
      console.log("✅ 작성한 리뷰 목록 로드");

      // productOrderNo로 해당 리뷰의 수정 버튼 클릭
      const clicked = await page.evaluate((targetNo) => {
        const items = document.querySelectorAll('[data-cy="written_review"]');
        for (const item of items) {
          const link = item.querySelector('a[href*="no="]');
          if (link?.href?.includes(`no=${targetNo}`)) {
            const btn = item.querySelector('button[class*="btn_modify"]');
            if (btn) {
              btn.click();
              return true;
            }
          }
        }
        return false;
      }, String(productOrderNo));

      if (!clicked) {
        throw new Error(
          `productOrderNo=${productOrderNo}에 해당하는 수정 버튼을 찾을 수 없습니다.`,
        );
      }

      // 팝업 URL 캡처 대기 (최대 3초)
      for (let i = 0; i < 30; i++) {
        if (capturedPopupUrl) break;
        await new Promise((r) => setTimeout(r, 100));
      }

      if (!capturedPopupUrl) {
        throw new Error("팝업 URL을 캡처하지 못했습니다. window.open이 호출되지 않았습니다.");
      }

      const idMatch = capturedPopupUrl.match(/\/reviews\/(\d+)\//);
      if (!idMatch) {
        throw new Error(`팝업 URL에서 reviewId 추출 실패: ${capturedPopupUrl}`);
      }

      actualReviewId = idMatch[1];
      console.log(`✅ 실제 리뷰 ID 확인: ${actualReviewId}`);
    }

    // ── 2단계: 수정 팝업으로 이동 ──
    // 팝업이 window.opener 없이 자동 닫히는 것 방지
    await page.evaluateOnNewDocument(() => {
      window.close = () => {};
      try {
        Object.defineProperty(window, "opener", {
          get: () => ({ location: { href: "https://shopping.naver.com" } }),
          configurable: true,
        });
      } catch (_) {}
    });

    const editUrl = `https://shopping.naver.com/popup/reviews/${actualReviewId}/update?returnUrl=${RETURN_URL}`;
    console.log(`🔗 수정 페이지 이동: ${editUrl}`);

    await page.goto(editUrl, { waitUntil: "domcontentloaded" });
    console.log("✅ 수정 페이지 로드 완료");

    // textarea 대기 (id="reviewInput")
    await page.waitForSelector("#reviewInput", { timeout: 15000 });
    console.log("📝 textarea 발견: #reviewInput");

    // 별점 변경 (React 제어 컴포넌트 - click으로 처리)
    if (newRating >= 1 && newRating <= 5) {
      const ratingClicked = await page.evaluate((rating) => {
        const btn = document.querySelector(
          `button.rating_button_grade__mMR2p[data-value="${rating}"]`,
        );
        if (btn) {
          btn.click();
          return true;
        }
        return false;
      }, newRating);
      console.log(`⭐ 별점 ${newRating}점 ${ratingClicked ? "변경 성공" : "변경 실패"}`);
    }

    // React 제어 textarea에 새 내용 입력
    // 일반 type()은 React state를 업데이트하지 못하므로 native setter + input 이벤트 사용
    await page.evaluate((content) => {
      const textarea = document.querySelector("#reviewInput");
      if (!textarea) throw new Error("textarea#reviewInput not found");

      // React의 synthetic event system을 트리거하는 native value setter
      const nativeValueSetter = Object.getOwnPropertyDescriptor(
        window.HTMLTextAreaElement.prototype,
        "value",
      ).set;
      nativeValueSetter.call(textarea, content);

      // React가 감지하는 input 이벤트 발생
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
      textarea.dispatchEvent(new Event("change", { bubbles: true }));
    }, newContent);

    console.log(`✍️  내용 입력 완료 (${newContent.length}자)`);

    // 제출 버튼 활성화 대기 (내용 변경 시 disabled 해제됨)
    await page.waitForSelector("button.reviewSubmitButton_button_submit__8ScDh:not([disabled])", {
      timeout: 10000,
    });
    console.log("✅ 제출 버튼 활성화 확인");

    // ── 실제 API 요청 캡처 (직접 HTTP 전환 준비) ──
    let capturedApiCall = null;
    await page.setRequestInterception(true);
    page.on("request", (req) => {
      const url = req.url();
      const method = req.method();
      if (
        (method === "PUT" || method === "POST" || method === "PATCH") &&
        (url.includes("/reviews/") || url.includes("/review/"))
      ) {
        capturedApiCall = {
          method,
          url,
          headers: req.headers(),
          body: req.postData(),
        };
        console.log(`🔍 [API 캡처] ${method} ${url}`);
        console.log(`🔍 [API 바디] ${req.postData()}`);
      }
      req.continue();
    });

    // 제출 버튼 클릭
    await page.click("button.reviewSubmitButton_button_submit__8ScDh");
    console.log("📤 제출 버튼 클릭");

    // 리다이렉트 완료 대기 (returnUrl로 이동)
    await page.waitForNavigation({ waitUntil: "networkidle2", timeout: 15000 }).catch(() => {
      console.log("⚠️  네비게이션 대기 타임아웃 (정상일 수 있음)");
    });

    const finalUrl = page.url();
    console.log(`🏁 최종 URL: ${finalUrl}`);

    await browser.close();

    if (capturedApiCall) {
      console.log("💡 [직접 HTTP 전환 참고]");
      console.log(`   method : ${capturedApiCall.method}`);
      console.log(`   url    : ${capturedApiCall.url}`);
      console.log(`   body   : ${capturedApiCall.body}`);
    }

    return {
      success: true,
      message: "리뷰가 성공적으로 수정되었습니다.",
      reviewId: actualReviewId,
      newContent,
      newRating,
      updated: true,
      _capturedApi: capturedApiCall ?? undefined,
    };
  } catch (error) {
    console.error("❌ 리뷰 수정 오류:", error.message);
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

// export default editReview; // 레거시 — reviewApiHttp.js 사용
export { editReviewLegacy };
