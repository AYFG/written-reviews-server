#!/usr/bin/env node
/**
 * add_columns.mjs — written_reviews 테이블에 store_name, product_option_content 컬럼 추가
 */
import mysql from "mysql2/promise";

const pool = mysql.createPool({
  host: process.env.DB_HOST || "localhost",
  user: process.env.DB_USER || "root",
  password: process.env.DB_PASSWORD || "test1234",
  database: process.env.DB_NAME || "naver_reviews_db",
  waitForConnections: true,
  connectionLimit: 10,
});

async function main() {
  const conn = await pool.getConnection();
  try {
    console.log("📋 기존 written_reviews 컬럼 확인 중...");
    const [cols] = await conn.query(
      `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS 
       WHERE TABLE_NAME='written_reviews' AND TABLE_SCHEMA=?`,
      [process.env.DB_NAME || "naver_reviews_db"],
    );

    const colNames = cols.map((c) => c.COLUMN_NAME);
    console.log(`✓ 현재 컬럼: ${colNames.join(", ")}`);

    // store_name 추가
    if (!colNames.includes("store_name")) {
      console.log("➕ store_name 컬럼 추가 중...");
      await conn.query(
        `ALTER TABLE written_reviews ADD COLUMN store_name VARCHAR(200) DEFAULT NULL AFTER product_image`,
      );
      console.log("✅ store_name 추가됨");
    } else {
      console.log("⏭️  store_name 이미 존재");
    }

    // product_option_content 추가
    if (!colNames.includes("product_option_content")) {
      console.log("➕ product_option_content 컬럼 추가 중...");
      await conn.query(
        `ALTER TABLE written_reviews ADD COLUMN product_option_content VARCHAR(500) DEFAULT NULL AFTER product_name`,
      );
      console.log("✅ product_option_content 추가됨");
    } else {
      console.log("⏭️  product_option_content 이미 존재");
    }

    console.log("\n✅ 마이그레이션 완료!");
  } catch (error) {
    console.error("❌ 오류:", error.message);
    process.exit(1);
  } finally {
    await conn.release();
    await pool.end();
  }
}

main();
