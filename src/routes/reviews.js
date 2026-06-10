import express from "express";
import pool from "../config/db.js";

const router = express.Router();

/**
 * GET /api/reviews
 * DB에서 저장된 리뷰 목록 조회 (페이지네이션 지원)
 */
router.get("/", async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;
    const offset = (page - 1) * limit;

    const connection = await pool.getConnection();

    // 총 개수 조회
    const [[{ totalCount }]] = await connection.execute(
      "SELECT COUNT(*) as totalCount FROM written_reviews",
    );

    // 리뷰 목록 조회
    const [reviews] = await connection.execute(
      `SELECT 
        id, naver_username, naver_id, product_name, product_option_content, product_image, store_name,
        review_content, rating, review_date, order_no, product_order_no, review_id,
        seller_comment, created_at, updated_at
       FROM written_reviews
       ORDER BY created_at DESC
       LIMIT ? OFFSET ?`,
      [limit, offset],
    );

    connection.release();

    const totalPages = Math.ceil(totalCount / limit);

    res.json({
      success: true,
      data: reviews,
      pagination: {
        page,
        limit,
        totalCount,
        totalPages,
      },
    });
  } catch (error) {
    console.error("❌ 리뷰 조회 오류:", error.message);
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

/**
 * GET /api/reviews/:id
 * 특정 리뷰 상세 조회
 */
router.get("/:id", async (req, res) => {
  try {
    const { id } = req.params;

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

    res.json({
      success: true,
      data: rows[0],
    });
  } catch (error) {
    console.error("❌ 리뷰 상세 조회 오류:", error.message);
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

export default router;
