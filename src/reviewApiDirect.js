/**
 * reviewApiDirect.js
 * 완전 순수 HTTP — Puppeteer(브라우저) 전혀 없음.
 *
 * 흐름:
 *  1. reviewId 유효성 확인
 *     - DB값이 잘못된 경우(= productOrderNo) → 리뷰 목록 API로 실제 ID 조회
 *  2. GET /popup/reviews/{reviewId}/update (SSR HTML)
 *     → RSC payload·HTML 속성에서 orderNo, productOrderNo, evaluationValueIds 추출
 *  3. PUT /popup/reviews/api/contents/reviews/{reviewId}
 */

import axios from "axios";

const BASE = "https://shopping.naver.com";
const RETURN_URL = encodeURIComponent(`${BASE}/popup/reviews/redirect?action=REVIEW_MODIFIED`);

/** 쿠키 배열 → Cookie 헤더 문자열 */
function cookiesToString(cookies) {
  return cookies.map((c) => `${c.name}=${c.value}`).join("; ");
}

/** 공통 헤더 */
function buildHeaders(cookieStr, referer, accept = "application/json, text/plain, */*") {
  return {
    "User-Agent":
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "Accept-Language": "ko-KR,ko;q=0.9",
    Accept: accept,
    Cookie: cookieStr,
    Referer: referer,
    Origin: BASE,
  };
}

/**
 * 1-a. 리뷰 목록 API로 실제 reviewId 조회 (reviewId가 DB에 잘못 저장된 경우)
 * Naver 내부 API 후보 엔드포인트를 순서대로 시도.
 */
async function findReviewIdFromList(productOrderNo, cookieStr) {
  const endpoints = [
    `${BASE}/popup/reviews/api/contents/written-reviews?pageNumber=1&pageSize=20`,
    `${BASE}/popup/reviews/api/contents/reviews/written?pageNumber=1&pageSize=20`,
    `${BASE}/popup/reviews/api/v1/written-reviews?pageNumber=1&pageSize=20`,
  ];

  for (const url of endpoints) {
    try {
      const { data } = await axios.get(url, {
        headers: buildHeaders(cookieStr, `${BASE}/my/written-reviews`),
        timeout: 10000,
      });

      // 응답이 배열이거나 { reviews: [...] } 형태일 것으로 가정
      const list = Array.isArray(data) ? data : (data.reviews ?? data.contents ?? data.data ?? []);

      if (!Array.isArray(list) || list.length === 0) continue;

      console.log(`📋 리뷰 목록 API 성공: ${url} (${list.length}건)`);

      // id / reviewId 필드 확인
      const found = list.find(
        (r) =>
          String(r.productOrderNo) === String(productOrderNo) ||
          String(r.orderProductNo) === String(productOrderNo),
      );

      if (found) {
        const rid = String(found.id ?? found.reviewId ?? "");
        console.log(`✅ 목록 API에서 reviewId 확인: ${rid}`);
        return rid;
      }

      // 매칭 불가 → 목록에 있는 ID 전부 반환해 호출자가 판단
      console.log(`⚠️  productOrderNo 매칭 실패. 첫 번째 ID 반환`);
      const rid = String(list[0].id ?? list[0].reviewId ?? "");
      return rid || null;
    } catch (_) {
      // 엔드포인트 시도 실패, 다음으로
    }
  }

  return null;
}

/**
 * 2-a. REST API GET으로 리뷰 데이터 직접 조회
 *   PUT과 동일한 엔드포인트에 GET 요청 → { orderNo, productOrderNo, reviewEvaluationValueIds, ... }
 */
async function fetchReviewDataFromApi(reviewId, cookieStr) {
  const referer = `${BASE}/popup/reviews/${reviewId}/update?returnUrl=${RETURN_URL}`;
  const url = `${BASE}/popup/reviews/api/contents/reviews/${reviewId}`;

  console.log(`🌐 [방법1] REST API GET: ${url}`);
  const { data } = await axios.get(url, {
    headers: buildHeaders(cookieStr, referer),
    timeout: 15000,
  });

  console.log(
    `📦 REST API 응답 타입=${typeof data}, 키=${Object.keys(data || {})
      .slice(0, 8)
      .join(",")}`,
  );

  const orderNo = String(data.orderNo ?? data.order_no ?? "");
  const productOrderNo = String(data.productOrderNo ?? data.product_order_no ?? "");
  const evaluationValueIds = Array.isArray(data.reviewEvaluationValueIds)
    ? data.reviewEvaluationValueIds
    : [];

  return { orderNo, productOrderNo, evaluationValueIds };
}

/**
 * 2-b. RSC(React Server Component) payload GET으로 리뷰 데이터 조회
 *   Next.js App Router는 Accept: text/x-component 헤더로 RSC 스트림을 반환.
 *   페이로드 내 JSON 청크에서 orderNo 등을 추출.
 */
async function fetchReviewDataFromRsc(reviewId, cookieStr) {
  const editUrl = `${BASE}/popup/reviews/${reviewId}/update?returnUrl=${RETURN_URL}`;

  console.log(`🌐 [방법2] RSC payload GET: ${editUrl}`);
  const { data: rscText } = await axios.get(editUrl, {
    headers: {
      ...buildHeaders(cookieStr, `${BASE}/my/written-reviews`, "text/x-component"),
      RSC: "1",
      "Next-Router-State-Tree": encodeURIComponent(
        JSON.stringify([
          "",
          {
            children: [
              "popup",
              { children: ["reviews", { children: [reviewId, { children: ["update", {}] }] }] },
            ],
          },
          null,
          null,
          true,
        ]),
      ),
      "Next-Router-Prefetch": "1",
    },
    timeout: 20000,
    maxRedirects: 5,
  });

  const text = typeof rscText === "string" ? rscText : JSON.stringify(rscText);
  console.log(`📦 RSC 응답 길이=${text.length}, 처음200자:\n${text.slice(0, 200)}`);

  // RSC 청크는 "숫자:JSON" 또는 "숫자:\"문자열\"" 형태
  // orderNo가 포함된 JSON 객체 청크를 찾음
  const jsonChunks = [];
  const chunkRe = /^\d+:([\[{].*)/gm;
  let chunkMatch;
  while ((chunkMatch = chunkRe.exec(text)) !== null) {
    try {
      jsonChunks.push(JSON.parse(chunkMatch[1]));
    } catch (_) {}
  }

  // 청크들을 재귀적으로 탐색해 orderNo를 가진 객체 찾기
  function findOrderNo(obj) {
    if (!obj || typeof obj !== "object") return null;
    if (Array.isArray(obj)) {
      for (const item of obj) {
        const found = findOrderNo(item);
        if (found) return found;
      }
    } else {
      if (obj.orderNo && obj.productOrderNo) return obj;
      for (const val of Object.values(obj)) {
        const found = findOrderNo(val);
        if (found) return found;
      }
    }
    return null;
  }

  for (const chunk of jsonChunks) {
    const found = findOrderNo(chunk);
    if (found) {
      console.log(
        `✅ RSC에서 orderNo 발견: orderNo=${found.orderNo}, productOrderNo=${found.productOrderNo}`,
      );
      return {
        orderNo: String(found.orderNo),
        productOrderNo: String(found.productOrderNo),
        evaluationValueIds: Array.isArray(found.reviewEvaluationValueIds)
          ? found.reviewEvaluationValueIds
          : [],
      };
    }
  }

  // RSC 텍스트 전체에서 정규식으로 재시도 (이스케이프된 문자열 처리)
  const decoded = text.replace(/\\u0022/gi, '"').replace(/\\"/g, '"');
  const m1 = decoded.match(/"orderNo"\s*:\s*"(\d+)"/);
  const m2 = decoded.match(/"productOrderNo"\s*:\s*"(\d+)"/);
  if (m1 && m2) {
    const evalSet = new Set();
    const evalRe = /"reviewEvaluationValueIds"\s*:\s*\[([^\]]*)\]/;
    const evalMatch = decoded.match(evalRe);
    if (evalMatch) {
      for (const n of evalMatch[1].matchAll(/\d+/g)) evalSet.add(Number(n[0]));
    }
    return {
      orderNo: m1[1],
      productOrderNo: m2[1],
      evaluationValueIds: [...evalSet],
    };
  }

  throw new Error("RSC payload에서 orderNo를 찾지 못했습니다.");
}

/**
 * 2. 폼 데이터 취득 — REST API → RSC payload 순으로 시도
 */
async function fetchFormData(reviewId, cookieStr) {
  const editUrl = `${BASE}/popup/reviews/${reviewId}/update?returnUrl=${RETURN_URL}`;

  // 방법1: REST API GET
  try {
    const result = await fetchReviewDataFromApi(reviewId, cookieStr);
    if (result.orderNo && result.productOrderNo) {
      console.log(
        `✅ [방법1 성공] orderNo=${result.orderNo}, productOrderNo=${result.productOrderNo}`,
      );
      return { editUrl, ...result };
    }
    console.log(`⚠️  [방법1] 응답에 orderNo 없음 → 방법2 시도`);
  } catch (e) {
    console.log(`⚠️  [방법1 실패] ${e.message} → 방법2 시도`);
  }

  // 방법2: RSC payload
  try {
    const result = await fetchReviewDataFromRsc(reviewId, cookieStr);
    if (result.orderNo && result.productOrderNo) {
      console.log(
        `✅ [방법2 성공] orderNo=${result.orderNo}, productOrderNo=${result.productOrderNo}`,
      );
      return { editUrl, ...result };
    }
    console.log(`⚠️  [방법2] orderNo 없음`);
  } catch (e) {
    console.log(`⚠️  [방법2 실패] ${e.message}`);
  }

  // 두 방법 모두 실패
  return { editUrl, orderNo: "", productOrderNo: "", evaluationValueIds: [] };
}

/**
 * 네이버 리뷰 수정 — 완전 HTTP (Puppeteer 없음)
 */
export const editReview = async (
  reviewId,
  orderNo,
  productOrderNo,
  newContent,
  newRating,
  cookies,
) => {
  console.log(
    `✏️  [Direct] reviewId=${reviewId}, productOrderNo=${productOrderNo}, 별점=${newRating}점`,
  );

  const cookieStr = cookiesToString(cookies || []);

  // ── 1단계: 실제 reviewId 확보 ──────────────────────────────────────────
  let actualReviewId = String(reviewId || "");

  // reviewId가 없거나, productOrderNo와 같으면서 숫자 형식이 아닐 때만 목록 API 조회
  // (crawl.js에서 reviewId를 product_order_no 폴백으로 저장하므로 두 값이 같아도 유효할 수 있음)
  const isValidReviewId = actualReviewId && /^\d{7,}$/.test(actualReviewId);
  if (!isValidReviewId) {
    console.log("🔍 DB의 reviewId가 유효하지 않음 → 목록 API 조회 시도...");
    const found = await findReviewIdFromList(productOrderNo, cookieStr);

    if (!found) {
      throw new Error(
        `실제 네이버 리뷰 ID를 가져오지 못했습니다. ` +
          `리뷰를 다시 크롤링하면 올바른 reviewId가 DB에 저장됩니다.`,
      );
    }
    actualReviewId = found;
    console.log(`✅ 목록 API에서 확인된 reviewId: ${actualReviewId}`);
  }

  // ── 2단계: 수정 팝업 SSR에서 폼 데이터 추출 ────────────────────────────
  console.log(`📋 수정 폼 데이터 로드 중... (reviewId=${actualReviewId})`);
  const formData = await fetchFormData(actualReviewId, cookieStr);

  if (!formData.orderNo || !formData.productOrderNo) {
    throw new Error(
      `폼 데이터 추출 실패 — orderNo="${formData.orderNo}", productOrderNo="${formData.productOrderNo}". ` +
        `쿠키가 만료됐거나 reviewId가 올바르지 않을 수 있습니다.`,
    );
  }

  console.log(
    `   orderNo=${formData.orderNo}, productOrderNo=${formData.productOrderNo}, ` +
      `evalIds=${JSON.stringify(formData.evaluationValueIds)}`,
  );

  // ── 3단계: axios PUT ────────────────────────────────────────────────────
  const apiUrl = `${BASE}/popup/reviews/api/contents/reviews/${actualReviewId}`;

  const body = {
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

  console.log(`🚀 PUT ${apiUrl}`);

  const { data, status } = await axios.put(apiUrl, body, {
    headers: {
      ...buildHeaders(cookieStr, formData.editUrl),
      "Content-Type": "application/json",
    },
    timeout: 20000,
  });

  console.log(`✅ HTTP ${status}`, JSON.stringify(data));

  return {
    success: true,
    message: "리뷰가 성공적으로 수정되었습니다.",
    reviewId: actualReviewId,
    newContent,
    newRating,
    httpStatus: status,
  };
};

export default editReview;
