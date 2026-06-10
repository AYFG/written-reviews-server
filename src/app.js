import express from "express";
import cors from "cors";
import pool from "./config/db.js";
import crawlRouter from "./routes/crawl.js";
import reviewsRouter from "./routes/reviews.js";
import reviewEditRouter from "./routes/reviewEdit.js";
import authRouter from "./routes/auth.js";

const app = express();

// 미들웨어
app.use(cors());
app.use(express.json());

// DB 연결 확인
(async () => {
  try {
    const connection = await pool.getConnection();
    console.log("✅ Database connected successfully");
    connection.release();
  } catch (error) {
    console.error("❌ Database connection failed:", error.message);
  }
})();

// 라우트
app.use("/api/auth/login", authRouter);
app.use("/api/crawl", crawlRouter);
app.use("/api/reviews", reviewsRouter);
app.use("/api/reviews", reviewEditRouter);

// 루트 엔드포인트
app.get("/", (req, res) => {
  res.json({
    message: "🚀 Written Reviews Server",
    version: "1.0.0",
    endpoints: {
      health: "/health",
      crawl: "POST /api/crawl",
      reviews: "GET /api/reviews",
      reviewDetail: "GET /api/reviews/:id",
      editReview: "POST /api/reviews/:id/edit",
    },
  });
});

// 헬스 체크
app.get("/health", (req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

export default app;
