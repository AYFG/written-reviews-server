import express from "express";
import pool from "../config/db.js";
import naverlLogin from "../login.js";

const router = express.Router();

/**
 * POST /api/auth/login
 * 네이버 로그인 및 쿠키 저장
 */
router.post("/", async (req, res) => {
  try {
    console.log("📍 로그인 요청 수신...");

    // Puppeteer로 네이버 로그인 진행
    const { cookies, naverId } = await naverlLogin(300); // 5분 대기

    if (cookies.length === 0) {
      return res.status(401).json({
        success: false,
        error: "쿠키를 획득하지 못했습니다.",
      });
    }

    // naver_username: nid_inf 쿠키 값 (숫자 ID), naver_id: 실제 로그인 아이디
    const nidInf = cookies.find((c) => c.name === "nid_inf");
    const username = nidInf ? decodeURIComponent(nidInf.value) : "unknown_user";

    // DB에 쿠키 저장
    const connection = await pool.getConnection();
    const cookiesJson = JSON.stringify(cookies);

    const maxExpires = cookies
      .filter((c) => c.expires && c.expires > 0)
      .reduce((max, c) => Math.max(max, c.expires), 0);
    const expiresAt =
      maxExpires > 0
        ? new Date(maxExpires * 1000).toISOString().slice(0, 19).replace("T", " ")
        : null;

    if (naverId) {
      // naver_id 기준으로 찾아서 있으면 UPDATE (naver_username이 바뀌어도 덮어씀, 새 행 생성 안 함)
      const [[existing]] = await connection.execute(
        "SELECT id FROM naver_cookies WHERE naver_id = ?",
        [naverId],
      );
      if (existing) {
        await connection.execute(
          "UPDATE naver_cookies SET naver_username=?, cookies=?, expires_at=?, updated_at=NOW() WHERE naver_id=?",
          [username, cookiesJson, expiresAt, naverId],
        );
        console.log(`🔄 기존 쿠키 업데이트: naver_id=${naverId}, naver_username=${username}`);
      } else {
        await connection.execute(
          `INSERT INTO naver_cookies (naver_username, naver_id, cookies, expires_at) VALUES (?, ?, ?, ?)`,
          [username, naverId, cookiesJson, expiresAt],
        );
        console.log(`➕ 신규 쿠키 등록: naver_id=${naverId}, naver_username=${username}`);
      }
    } else {
      // naver_id 미확인 시 naver_username 기준으로 upsert
      await connection.execute(
        `INSERT INTO naver_cookies (naver_username, naver_id, cookies, expires_at)
         VALUES (?, NULL, ?, ?)
         ON DUPLICATE KEY UPDATE
           cookies = VALUES(cookies),
           expires_at = VALUES(expires_at),
           updated_at = NOW()`,
        [username, cookiesJson, expiresAt],
      );
    }

    connection.release();

    console.log(`✅ 로그인 완료: ${username} (naver_id: ${naverId || "미확인"})`);

    res.json({
      success: true,
      message: "로그인이 완료되었습니다.",
      username,
      naverId: naverId || null,
      cookieCount: cookies.length,
      expiresAt,
    });
  } catch (error) {
    console.error("❌ 로그인 오류:", error.message);
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

export default router;
