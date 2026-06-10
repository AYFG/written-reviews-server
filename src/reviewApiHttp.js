/**
 * [레거시 — reviewApiHttp.js]
 * Puppeteer로 reviewId 획득 + 폼 데이터 추출 후 axios PUT 방식.
 * 현재는 reviewApiDirect.js (완전 HTTP, Puppeteer 없음) 로 교체됨.
 * 참고용으로만 보존합니다.
 */

import puppeteer from "puppeteer";
import axios from "axios";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const USER_DATA_DIR = path.resolve(__dirname, "../puppeteer_data");

const RETURN_URL = encodeURIComponent(
  "https://shopping.naver.com/popup/reviews/redirect?action=REVIEW_MODIFIED",
);

/** 쿠키 배열 → Cookie 헤더 문자열 */
function cookiesToString(cookies) {
  return cookies.map((c) => `${c.name}=${c.value}`).join("; ");
}

/**
 * 네이버 리뷰 수정 (axios 직접 HTTP 방식)
 * @param {string} reviewId        - DB에 저장된 review_id (productOrderNo와 같으면 자동 재탐색)
 * @param {string} orderNo         - 주문 번호 (미사용, 폼에서 추출)
 * @param {string} productOrderNo  - 상품 주문 번호 (리뷰 목록에서 수정 버튼 찾는 데 사용)
 * @param {string} newContent      - 수정할 리뷰 내용
 * @param {number} newRating       - 수정할 별점 (1~5)
 * @param {Array}  cookies         - 저장된 쿠키 배열
 */
// export const editReview = async ( /* ← 아래 전체 함수가 주석 처리됨 */
const editReviewHttpLegacy = async (
  reviewId,
  orderNo,
  productOrderNo,
  newContent,
  newRating,
  cookies,
) => {
  console.log(
    `✏️  [HTTP] 리뷰 수정 시작: reviewId=${reviewId}, productOrderNo=${productOrderNo}, 별점=${newRating}점`,
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

    if (cookies && cookies.length > 0) {
      await page.setCookie(...cookies);
      console.log(`✅ ${cookies.length}개 쿠키 로드 완료`);
    }

    // ── 1단계: 실제 네이버 리뷰 ID 획득 ──────────────────────────────────
    // DB의 review_id가 productOrderNo와 동일하면 잘못 저장된 것이므로
    // 리뷰 목록 페이지에서 window.open을 가로채 팝업 URL의 reviewId를 추출한다.
    let actualReviewId = reviewId;

    if (!actualReviewId || actualReviewId === String(productOrderNo)) {
      console.log("🔍 실제 리뷰 ID 탐색 (리뷰 목록 페이지 방문)...");

      let capturedPopupUrl = null;
      await page.exposeFunction("__capturePopupUrl__", (url) => {
        capturedPopupUrl = url;
        console.log(`🎯 팝업 URL 캡처: ${url}`);
      });

      await page.evaluateOnNewDocument(() => {
        window.open = function (url) {
          if (url) window.__capturePopupUrl__(url);
          return { focus: () => {}, close: () => {}, location: { href: url } };
        };
      });

      await page.goto("https://shopping.naver.com/my/written-reviews", {
        waitUntil: "networkidle2",
      });
      console.log("✅ 작성한 리뷰 목록 로드");

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

      if (!capturedPopupUrl) throw new Error("팝업 URL 캡처 실패 (window.open 미호출)");

      const idMatch = capturedPopupUrl.match(/\/reviews\/(\d+)\//);
      if (!idMatch) throw new Error(`reviewId 추출 실패: ${capturedPopupUrl}`);

      actualReviewId = idMatch[1];
      console.log(`✅ 실제 리뷰 ID: ${actualReviewId}`);
    }

    // ── 2단계: 수정 팝업에서 현재 폼 데이터 추출 ─────────────────────────
    // (현재 선택된 evaluationValueIds, 실제 orderNo / productOrderNo)
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
    await page.goto(editUrl, { waitUntil: "domcontentloaded" });
    await page.waitForSelector("#reviewInput", { timeout: 15000 });
    console.log("✅ 수정 팝업 로드 완료 — 폼 데이터 추출 중...");

    const formData = await page.evaluate(() => {
      // 현재 선택된 상세 평가 값 (aria-checked="true" 인 버튼의 data-value)
      const evalBtns = document.querySelectorAll(
        '.evaluation_button_grade__gdTt0[aria-checked="true"]',
      );
      const evaluationValueIds = Array.from(evalBtns)
        .map((btn) => Number(btn.dataset.value))
        .filter(Boolean);

      // __NEXT_DATA__ 에서 orderNo, productOrderNo 추출
      let orderNo = "";
      let productOrderNo = "";
      try {
        const raw = document.getElementById("__NEXT_DATA__")?.textContent || "{}";
        const propsStr = JSON.stringify(JSON.parse(raw));
        const m1 = propsStr.match(/"orderNo"\s*:\s*"(\d+)"/);
        const m2 = propsStr.match(/"productOrderNo"\s*:\s*"(\d+)"/);
        if (m1) orderNo = m1[1];
        if (m2) productOrderNo = m2[1];
      } catch (_) {}

      return { evaluationValueIds, orderNo, productOrderNo };
    });

    console.log(
      `📋 폼 데이터: orderNo=${formData.orderNo}, productOrderNo=${formData.productOrderNo}, evaluationIds=${JSON.stringify(formData.evaluationValueIds)}`,
    );

    await browser.close();
    browser = null;

    // ── 3단계: axios 직접 PUT 요청 ───────────────────────────────────────
    const cookieString = cookiesToString(cookies || []);
    const apiUrl = `https://shopping.naver.com/popup/reviews/api/contents/reviews/${actualReviewId}`;

    const requestBody = {
      id: Number(actualReviewId),
      orderNo: formData.orderNo,
      productOrderNo: formData.productOrderNo,
      reviewScore: Number(newRating),
      reviewEvaluationValueIds: formData.evaluationValueIds,
      subReviewEvaluationValueIds: [],
      reviewContent: newContent,
      reviewAttaches: [],
      writeLocationType: "PC",
      reviewUserInfoValues: [],
    };

    console.log(`🚀 HTTP PUT ${apiUrl}`);

    const response = await axios.put(apiUrl, requestBody, {
      headers: {
        "Content-Type": "application/json",
        Origin: "https://shopping.naver.com",
        Referer: editUrl,
        Cookie: cookieString,
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        Accept: "application/json, text/plain, */*",
        "Accept-Language": "ko-KR,ko;q=0.9",
      },
    });

    console.log(`✅ HTTP 응답: ${response.status}`, JSON.stringify(response.data));

    return {
      success: true,
      message: "리뷰가 성공적으로 수정되었습니다.",
      reviewId: actualReviewId,
      newContent,
      newRating,
      updated: true,
      httpStatus: response.status,
    };
  } catch (error) {
    const status = error.response?.status;
    const data = error.response?.data;
    console.error(
      `❌ 리뷰 수정 오류: ${error.message}`,
      status ? `HTTP ${status}` : "",
      data ? JSON.stringify(data) : "",
    );
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

// export default editReview; // 레거시 — reviewApiDirect.js 사용
export { editReviewHttpLegacy };
