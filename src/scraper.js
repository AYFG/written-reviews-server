import puppeteer from "puppeteer";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const USER_DATA_DIR = path.resolve(__dirname, "../puppeteer_data");

function clearSingletonLock() {
  const lockFile = path.join(USER_DATA_DIR, "SingletonLock");
  try {
    if (fs.existsSync(lockFile)) {
      fs.unlinkSync(lockFile);
      console.log("🔓 SingletonLock 파일 삭제 완료");
    }
  } catch (e) {
    // 무시
  }
}

/**
 * 브라우저 실행
 * @param {boolean} headless - 헤드리스 모드 여부
 * @returns {Promise<Object>} Puppeteer Browser 인스턴스
 */
async function launchBrowser(headless = "new") {
  clearSingletonLock();
  try {
    return await puppeteer.launch({
      headless,
      channel: "chrome",
      userDataDir: USER_DATA_DIR,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-extensions",
        "--disable-blink-features=AutomationControlled",
      ],
    });
  } catch (launchError) {
    console.error("❌ Chrome 브라우저를 실행할 수 없습니다:", launchError.message);
    throw new Error(
      "Chrome 브라우저 실행 실패. 이미 열려있는 Puppeteer 창이 있다면 닫고 다시 시도해 주세요.",
    );
  }
}

/**
 * 네이버 작성한 리뷰 페이지에서 리뷰 데이터 크롤링
 * @param {Array} cookies - DB에서 가져온 쿠키 배열
 * @param {string} knownUsername - 알려진 사용자명
 * @returns {Promise<Array>} 크롤링된 리뷰 배열
 */
export const crawlWrittenReviews = async (cookies = [], knownUsername = null) => {
  console.log("🚀 Starting Written Reviews Crawler...");

  let browser = await launchBrowser("new");
  const page = await browser.newPage();

  page.setDefaultNavigationTimeout(0);
  page.setDefaultTimeout(0);
  await page.setViewport({ width: 1280, height: 800 });

  await page.setUserAgent(
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  );

  // 쿠키 주입: DB에서 가져온 쿠키를 브라우저에 설정
  if (cookies.length > 0) {
    // 쿠키 설정 전 쇼핑 도메인으로 먼저 이동 (도메인 설정을 위해)
    await page.goto("https://shopping.naver.com", { waitUntil: "domcontentloaded", timeout: 0 });

    // 기존 naver.com 세션 쿠키 전부 삭제 후 새 쿠키 주입
    // (puppeteer_data 공유 세션이 남아있으면 다른 계정 쿠키가 무시되므로)
    const existingCookies = await page.cookies();
    for (const cookie of existingCookies) {
      await page.deleteCookie({ name: cookie.name, domain: cookie.domain });
    }

    await page.setCookie(...cookies);
    console.log(`🍪 ${cookies.length}개의 쿠키를 브라우저에 주입했습니다.`);
  }

  // API 응답 인터셉트 - 실제 리뷰 API 캡처
  const capturedReviews = [];
  page.on("response", async (response) => {
    const url = response.url();
    // 네이버 쇼핑 리뷰 관련 API 패턴
    if (
      (url.includes("shopping.naver.com") || url.includes("api.naver.com")) &&
      (url.includes("review") || url.includes("Review"))
    ) {
      try {
        const json = await response.json().catch(() => null);
        if (json) {
          console.log("📡 리뷰 API 캡처:", url);
          capturedReviews.push({ url, data: json });
        }
      } catch (e) {
        // 무시
      }
    }
  });

  try {
    console.log("🔗 Navigating to Naver Written Reviews...");
    await page.goto("https://shopping.naver.com/my/written-reviews", {
      waitUntil: "networkidle2",
      timeout: 60000,
    });

    // 로그인 페이지로 리디렉션됐는지 확인
    const currentUrl = page.url();
    if (currentUrl.includes("nid.naver.com")) {
      throw new Error("로그인이 필요합니다. 먼저 /api/auth/login 을 호출하세요.");
    }

    await new Promise((r) => setTimeout(r, 3000));

    // 1단계: initialApolloState(GraphQL 캐시)에서 리뷰 추출 시도
    const {
      reviews: apolloReviews,
      nextDataKeys,
      apolloKeys,
    } = await page.evaluate(() => {
      const results = [];
      let pagePropsKeys = [];
      let foundApolloKeys = [];

      const nextDataEl = document.getElementById("__NEXT_DATA__");
      if (nextDataEl) {
        try {
          const nextData = JSON.parse(nextDataEl.textContent);
          const pageProps = nextData?.props?.pageProps || {};
          pagePropsKeys = Object.keys(pageProps);

          const apolloState = pageProps.initialApolloState || {};
          foundApolloKeys = Object.keys(apolloState).slice(0, 20); // 샘플 키 20개

          for (const [key, value] of Object.entries(apolloState)) {
            if (!value || typeof value !== "object") continue;
            const typeName = value.__typename || "";
            // 리뷰 관련 타입 탐색
            if (
              typeName.toLowerCase().includes("review") ||
              typeName.toLowerCase().includes("written")
            ) {
              results.push({
                reviewId: String(value.id || value.reviewId || key.split(":")[1] || ""),
                productName:
                  value.productName || value.product?.name || value.productTitle || "상품명 없음",
                productImage:
                  value.productImage || value.product?.imageUrl || value.thumbnailUrl || null,
                reviewContent:
                  value.content || value.reviewContent || value.body || value.text || "",
                rating: value.score || value.rating || value.starScore || 5,
                reviewDate:
                  value.createdAt || value.reviewDate || value.writeDate || value.date || "",
                orderNo: value.orderNo || "",
                productOrderNo: value.productOrderNo || "",
                rawData: value,
              });
            }
          }
        } catch (e) {
          // 무시
        }
      }

      return { reviews: results, nextDataKeys: pagePropsKeys, apolloKeys: foundApolloKeys };
    });

    console.log(`📦 __NEXT_DATA__ pageProps 키: ${nextDataKeys.join(", ")}`);
    console.log(`🔑 Apollo 캐시 키 샘플: ${apolloKeys.slice(0, 10).join(", ")}`);

    // 2단계: Apollo에서 못찾으면 DOM 직접 파싱
    let reviews = apolloReviews;
    if (reviews.length === 0) {
      console.log("🔍 Apollo 캐시에서 리뷰 없음 → DOM 직접 파싱 시도...");

      // window.open 인터셉트로 실제 Naver reviewId 수집
      // 수정 버튼 클릭 시 window.open("/popup/reviews/{reviewId}/update") 가 호출됨
      const popupUrls = []; // index → reviewId 매핑용
      await page.exposeFunction("__captureModifyUrl__", (url, idx) => {
        popupUrls[idx] = url;
      });
      await page.evaluate(() => {
        window.open = function (url) {
          const items = document.querySelectorAll('[data-cy="written_review"]');
          items.forEach((item, i) => {
            const btn = item.querySelector('button[class*="btn_modify"]');
            if (btn && btn === document.activeElement) {
              window.__captureModifyUrl__(url, i);
            }
          });
          // fallback: 마지막 index 기록
          window.__lastOpenUrl__ = url;
          return { focus: () => {}, close: () => {} };
        };
      });

      // 각 리뷰 수정 버튼을 순서대로 클릭해 popup URL 캡처
      const itemCount = await page.evaluate(
        () => document.querySelectorAll('[data-cy="written_review"]').length,
      );
      console.log(`🔘 수정 버튼 클릭으로 reviewId 수집 (${itemCount}개)...`);
      for (let i = 0; i < itemCount; i++) {
        await page.evaluate((idx) => {
          const items = document.querySelectorAll('[data-cy="written_review"]');
          const btn = items[idx]?.querySelector('button[class*="btn_modify"]');
          if (btn) {
            btn.focus();
            btn.click();
          }
        }, i);
        // popup URL이 캡처될 때까지 최대 500ms 대기
        for (let w = 0; w < 10; w++) {
          if (popupUrls[i] !== undefined) break;
          await new Promise((r) => setTimeout(r, 50));
        }
        // fallback: activeElement 기반 캡처가 안 된 경우 lastOpenUrl 사용
        if (popupUrls[i] === undefined) {
          const last = await page.evaluate(() => window.__lastOpenUrl__);
          if (last) popupUrls[i] = last;
          await page.evaluate(() => {
            window.__lastOpenUrl__ = null;
          });
        }
      }
      console.log(`🎯 팝업 URL 수집: ${popupUrls.filter(Boolean).length}개`);
      popupUrls.forEach((url, i) => {
        const m = url?.match(/\/reviews\/(\d+)\//);
        console.log(`  [${i}] reviewId=${m ? m[1] : "❌ 미수집"} | url=${url ?? "없음"}`);
      });

      reviews = await page.evaluate(() => {
        const results = [];
        const items = document.querySelectorAll('[data-cy="written_review"]');

        items.forEach((item, index) => {
          // 상품명
          const productNameEl = item.querySelector('[class*="HeaderProductInfo_product__"]');
          // 상품 이미지
          const productImgEl = item.querySelector('[class*="HeaderProductInfo_thumb__"] img');
          // 스토어명 — written-reviews 페이지 구조: WrittenReviewListItemHeaderProductInfo_store
          const storeNameEl = item.querySelector(
            '[class*="WrittenReviewListItemHeaderProductInfo_store"]',
          );
          // 제품 옵션 — written-reviews 페이지 구조: WrittenReviewListItemHeaderProductInfo_option
          const optionEl = item.querySelector(
            '[class*="WrittenReviewListItemHeaderProductInfo_option"]',
          );
          // 리뷰 내용 (em 레이블 제외)
          const contentEl = item.querySelector(
            '[data-cy="written_review_content"] [class*="ContentText_text__"]',
          );
          // 평점 숫자 (blind 다음 텍스트)
          const ratingArea = item.querySelector('[class*="StarRating_star_rating__"]');

          const productName = productNameEl?.textContent?.trim() || "상품명 없음";
          const storeName = storeNameEl?.textContent?.trim() || "";
          const productOptionContent = optionEl?.textContent?.trim() || "";
          const productImage = productImgEl?.src || null;

          let reviewContent = "";
          if (contentEl) {
            // em 태그(재구매, 한달사용기 등 레이블) 제거하고 텍스트만 추출
            const clone = contentEl.cloneNode(true);
            clone.querySelectorAll("em").forEach((em) => em.remove());
            reviewContent = clone.textContent?.trim() || "";
          }

          // 평점: "평점5" 형태에서 숫자 추출
          const ratingText = ratingArea?.textContent || "";
          const ratingMatch = ratingText.match(/평점(\d)/);
          const rating = ratingMatch ? parseInt(ratingMatch[1]) : 5;

          // 상품 URL에서 products/{id} 추출 (no= 파라미터는 스토어 번호라 같은 스토어 상품끼리 충돌함)
          const productLinkEl = item.querySelector('[class*="HeaderProductInfo_thumb__"]');
          const productUrl = productLinkEl?.href || "";
          const productIdMatch = productUrl.match(/\/products\/(\d+)/);
          const productOrderNo = productIdMatch ? productIdMatch[1] : "";

          // 실제 네이버 리뷰 ID 추출 (수정 URL: /popup/reviews/{reviewId}/update)
          // 1) 수정 버튼의 data-review-id 속성
          // 2) 수정 링크의 href에서 추출
          // 3) review item의 data-id 속성
          // 4) 이미지/링크의 href에서 /reviews/{id} 패턴
          let reviewId = "";
          const modifyBtn = item.querySelector(
            'button[class*="btn_modify"], a[class*="btn_modify"]',
          );
          if (modifyBtn) {
            reviewId = modifyBtn.dataset.reviewId || modifyBtn.dataset.id || "";
            if (!reviewId) {
              const hrefMatch = (modifyBtn.href || modifyBtn.getAttribute("onclick") || "").match(
                /\/reviews\/(\d+)/,
              );
              if (hrefMatch) reviewId = hrefMatch[1];
            }
          }
          if (!reviewId) {
            // item 전체에서 /popup/reviews/{id} 또는 /reviews/{id} 패턴의 링크 탐색
            const allLinks = item.querySelectorAll("a[href]");
            for (const link of allLinks) {
              const m = link.href.match(/\/reviews\/(\d+)/);
              if (m) {
                reviewId = m[1];
                break;
              }
            }
          }
          if (!reviewId) {
            // item의 data-* 속성에서 숫자 ID 탐색
            reviewId = item.dataset.reviewId || item.dataset.id || "";
          }
          if (!reviewId) {
            // 최후 fallback: productOrderNo (이 경우 수정 불가)
            reviewId = productOrderNo || String(Date.now() + index);
          }

          // 판매자 댓글 추출
          const sellerCommentContainer = item.querySelector(
            '[class*="WrittenReviewListItemComment_seller_comment"]',
          );
          let sellerComment = null;
          if (sellerCommentContainer) {
            const commentDateEl = sellerCommentContainer.querySelector(
              '[class*="WrittenReviewListItemComment_date"]',
            );
            const commentTextEl = sellerCommentContainer.querySelector(
              '[class*="WrittenReviewListItemComment_comment"]',
            );
            const commentDate = commentDateEl?.textContent?.trim() || "";
            const commentText = commentTextEl?.textContent?.trim() || "";
            if (commentText) {
              sellerComment = {
                date: commentDate,
                content: commentText,
              };
            }
          }

          results.push({
            reviewId,
            productName,
            storeName,
            productOptionContent,
            productImage,
            reviewContent,
            rating,
            reviewDate: "",
            orderNo: "",
            productOrderNo,
            sellerComment,
            rawData: {
              productName,
              storeName,
              productOptionContent,
              reviewContent,
              rating,
              productOrderNo,
              sellerComment,
            },
          });
        });

        return results;
      });

      // popupUrls로 reviewId 보정 (실제 Naver reviewId 덮어쓰기)
      reviews = reviews.map((r, i) => {
        const url = popupUrls[i];
        if (url) {
          const m = url.match(/\/reviews\/(\d+)\//);
          if (m) return { ...r, reviewId: m[1] };
        }
        return r;
      });

      console.log(`🖥️  DOM 파싱 결과: ${reviews.length}개`);
      // 첫 번째 리뷰 아이템의 reviewId 디버그 출력
      if (reviews.length > 0) {
        const first = reviews[0];
        console.log(
          `🔑 첫 리뷰 reviewId="${first.reviewId}", productOrderNo="${first.productOrderNo}"`,
        );
      }
    }

    // API로 캡처된 리뷰 데이터 병합 시도
    let finalReviews = reviews;
    if (finalReviews.length === 0 && capturedReviews.length > 0) {
      console.log(`📡 네트워크에서 ${capturedReviews.length}개 API 응답 캡처됨`);
      for (const captured of capturedReviews) {
        console.log("  -", captured.url);
      }
    }

    console.log(`🎉 크롤링 완료: ${finalReviews.length}개의 리뷰를 찾았습니다.`);
    await browser.close();
    return finalReviews;
  } catch (error) {
    console.error("❌ Crawler Error:", error.message);
    try {
      await browser.close();
    } catch (_) {
      /* ignore */
    }
    throw error;
  }
};

export default crawlWrittenReviews;
