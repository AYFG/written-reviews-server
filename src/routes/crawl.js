import express from "express";
import pool from "../config/db.js";
import crawlWrittenReviews from "../scraper.js";

const router = express.Router();

/**
 * POST /api/crawl
 * 네이버 작성한 리뷰 크롤링 실행
 */
router.post("/", async (req, res) => {
  try {
    console.log("📍 크롤링 요청 시작...");

    // DB에서 계정별 최신 쿠키 조회 (naver_id 기준 중복 제거, 최신 1개만 사용)
    const connection = await pool.getConnection();
    const [allCookieRows] = await connection.execute(
      "SELECT naver_username, naver_id, cookies FROM naver_cookies WHERE naver_username != 'unknown_user' ORDER BY updated_at DESC",
    );
    connection.release();

    // naver_id 기준으로 중복 제거 (updated_at 내림차순이므로 첫 번째가 최신)
    const seenNaverIds = new Set();
    const cookieRows = allCookieRows.filter((row) => {
      const key = row.naver_id || row.naver_username;
      if (seenNaverIds.has(key)) return false;
      seenNaverIds.add(key);
      return true;
    });

    if (cookieRows.length === 0) {
      return res.status(401).json({
        success: false,
        error: "저장된 로그인 정보가 없습니다. 먼저 로그인해주세요.",
      });
    }

    console.log(`👥 크롤링 대상 계정: ${cookieRows.map((r) => r.naver_username).join(", ")}`);

    let totalInserted = 0;
    let totalUpdated = 0;
    let totalReviews = 0;
    const accountResults = [];

    for (const cookieRow of cookieRows) {
      const {
        naver_username: username,
        naver_id: accountNaverId,
        cookies: cookiesJson,
      } = cookieRow;
      const cookies = typeof cookiesJson === "string" ? JSON.parse(cookiesJson) : cookiesJson;
      console.log(`\n🍪 [${username}] 계정 크롤링 시작 (쿠키 ${cookies.length}개)`);

      // 크롤링 실행 (쿠키 주입) — 계정별 실패는 스킵
      let reviews = [];
      try {
        reviews = await crawlWrittenReviews(cookies, username);
      } catch (crawlErr) {
        console.error(`❌ [${username}] 크롤링 실패: ${crawlErr.message}`);
        accountResults.push({
          username,
          count: 0,
          inserted: 0,
          updated: 0,
          error: crawlErr.message,
        });
        continue;
      }

      if (reviews.length === 0) {
        console.log(`⚠️  [${username}] 크롤링된 리뷰 없음`);
        accountResults.push({ username, count: 0, inserted: 0, updated: 0 });
        continue;
      }

      // DB에 UPSERT
      const conn = await pool.getConnection();
      let insertedCount = 0;
      let updatedCount = 0;

      for (const review of reviews) {
        const [result] = await conn.execute(
          `INSERT INTO written_reviews 
           (naver_username, naver_id, product_name, product_option_content, product_image, store_name, review_content, rating, review_date, order_no, product_order_no, review_id, seller_comment, raw_data)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON DUPLICATE KEY UPDATE
             naver_username = VALUES(naver_username),
             product_name = VALUES(product_name),
             product_option_content = VALUES(product_option_content),
             product_image = VALUES(product_image),
             store_name = VALUES(store_name),
             review_content = VALUES(review_content),
             rating = VALUES(rating),
             review_date = VALUES(review_date),
             seller_comment = VALUES(seller_comment),
             updated_at = NOW()`,
          [
            username,
            accountNaverId || null,
            review.productName,
            review.productOptionContent || review.options || "",
            review.productImage,
            review.storeName || "",
            review.reviewContent || review.review_content,
            review.rating || 5,
            review.reviewDate || review.review_date || "",
            review.orderNo || review.order_no || "",
            review.productOrderNo ||
              review.product_order_no ||
              review.reviewId ||
              review.review_id ||
              "",
            review.reviewId || review.review_id || "",
            review.sellerComment ? JSON.stringify(review.sellerComment) : null,
            JSON.stringify(review.rawData || review),
          ],
        );

        if (result.insertId) {
          insertedCount++;
        } else if (result.affectedRows > 1) {
          updatedCount++;
        }
      }

      conn.release();

      console.log(
        `💾 [${username}] DB 저장 완료: ${insertedCount}개 삽입, ${updatedCount}개 업데이트`,
      );
      accountResults.push({
        username,
        count: reviews.length,
        inserted: insertedCount,
        updated: updatedCount,
      });
      totalReviews += reviews.length;
      totalInserted += insertedCount;
      totalUpdated += updatedCount;
    }

    res.json({
      success: true,
      message: `${cookieRows.length}개 계정 크롤링 완료`,
      totalCount: totalReviews,
      insertedCount: totalInserted,
      updatedCount: totalUpdated,
      accounts: accountResults,
    });
  } catch (error) {
    console.error("❌ 크롤링 오류:", error.message);
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

export default router;
