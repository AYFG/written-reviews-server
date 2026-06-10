import express from "express";
import pool from "../config/db.js";
// import { editReview } from "../reviewApi.js";     // 레거시 v1 (Puppeteer 팝업 방식)
// import { editReview } from "../reviewApiHttp.js"; // 레거시 v2 (Puppeteer + axios 혼합)
import { editReview } from "../reviewApiDirect.js"; // 최신 (완전 HTTP, Puppeteer 없음)

const router = express.Router();

/**
 * POST /api/reviews/:id/edit
 * 리뷰 수정 요청 처리
 */
router.post("/:id/edit", async (req, res) => {
  try {
    const { id } = req.params;
    const { content, score } = req.body;

    // DB에서 리뷰 정보 조회
    const connection = await pool.getConnection();
    const [rows] = await connection.execute("SELECT * FROM written_reviews WHERE id = ? LIMIT 1", [
      id,
    ]);
    connection.release();

    if (rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: "리뷰를 찾을 수 없습니다.",
      });
    }

    const review = rows[0];

    // 가장 최근의 쿠키 조회
    const [cookieRows] = await connection.execute(
      "SELECT cookies FROM naver_cookies ORDER BY updated_at DESC LIMIT 1",
    );

    let cookies = [];
    if (cookieRows.length > 0) {
      const cookiesJson = cookieRows[0].cookies;
      cookies = typeof cookiesJson === "string" ? JSON.parse(cookiesJson) : cookiesJson;
    }

    // 유효성 검사
    if (!content || typeof content !== "string") {
      return res.status(400).json({
        success: false,
        error: "리뷰 내용이 필요합니다.",
      });
    }

    if (!score || score < 1 || score > 5) {
      return res.status(400).json({
        success: false,
        error: "별점은 1~5 사이여야 합니다.",
      });
    }

    // 네이버 API로 리뷰 수정 요청 (UI 자동화)
    const result = await editReview(
      review.review_id,
      review.order_no,
      review.product_order_no,
      content,
      score,
      cookies,
    );

    // 로컬 DB 업데이트
    const updateConnection = await pool.getConnection();
    await updateConnection.execute(
      `UPDATE written_reviews 
       SET review_content = ?, rating = ?, updated_at = NOW()
       WHERE id = ?`,
      [content, score, id],
    );
    updateConnection.release();

    res.json({
      success: true,
      message: "리뷰가 수정되었습니다.",
      data: {
        id,
        reviewId: review.review_id,
        newContent: content,
        newScore: score,
      },
      naverApiResult: result,
    });
  } catch (error) {
    console.error("❌ 리뷰 수정 오류:", error.message);
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

export default router;
