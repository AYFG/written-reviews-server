import pool from "./src/config/db.js";

const conn = await pool.getConnection();
try {
  // 1. 중복 확인
  const [dups] = await conn.query(`
    SELECT product_order_no, COUNT(*) as cnt,
           GROUP_CONCAT(id ORDER BY id) as ids,
           GROUP_CONCAT(review_id ORDER BY id) as rids
    FROM written_reviews
    GROUP BY naver_username, product_order_no
    HAVING cnt > 1
  `);
  console.log("중복 레코드:", dups.length, "건");
  dups.forEach((d) =>
    console.log(` product_order_no=${d.product_order_no} | ids=${d.ids} | review_ids=${d.rids}`),
  );

  // 2. 구버전(review_id = product_order_no) 레코드 삭제
  const [del] = await conn.query(`
    DELETE FROM written_reviews
    WHERE CAST(review_id AS CHAR) = CAST(product_order_no AS CHAR)
  `);
  console.log(`🗑️  구버전 레코드 삭제: ${del.affectedRows}개`);

  // 3. UNIQUE KEY 변경: (naver_username, review_id) → (naver_username, product_order_no)
  await conn.query("ALTER TABLE written_reviews DROP INDEX uk_review");
  await conn.query(
    "ALTER TABLE written_reviews ADD UNIQUE KEY uk_review (naver_username, product_order_no(50))",
  );
  console.log("✅ UNIQUE KEY 변경 완료 → (naver_username, product_order_no)");

  // 4. 현재 상태 확인
  const [remaining] = await conn.query(
    "SELECT id, review_id, product_order_no, product_name FROM written_reviews ORDER BY id",
  );
  console.log(`\n📋 현재 DB 레코드 (${remaining.length}개):`);
  remaining.forEach((r) =>
    console.log(
      `  id=${r.id} | review_id=${r.review_id} | product_order_no=${r.product_order_no} | ${r.product_name?.substring(0, 30)}`,
    ),
  );
} finally {
  conn.release();
  await pool.end();
}
