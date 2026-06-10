-- naver_cookies 테이블 생성
CREATE TABLE IF NOT EXISTS naver_cookies (
  id             INT AUTO_INCREMENT PRIMARY KEY,
  naver_username VARCHAR(100) NOT NULL,
  naver_id       VARCHAR(100) NULL,
  cookies        JSON NOT NULL,
  expires_at     TIMESTAMP NOT NULL,
  created_at     TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at     TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uk_username (naver_username)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- written_reviews 테이블 생성
CREATE TABLE IF NOT EXISTS written_reviews (
  id                      INT AUTO_INCREMENT PRIMARY KEY,
  naver_username          VARCHAR(100) NOT NULL,
  naver_id                VARCHAR(100) NULL,
  product_name            VARCHAR(500) NOT NULL,
  product_option_content  VARCHAR(500),
  product_image           TEXT,
  store_name              VARCHAR(200),
  review_content          LONGTEXT,
  rating                  TINYINT DEFAULT 5,
  review_date             VARCHAR(100),
  order_no                VARCHAR(100),
  product_order_no        VARCHAR(100),
  review_id               VARCHAR(100),
  seller_comment          JSON,
  raw_data                JSON,
  created_at              TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at              TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uk_review (naver_id, review_id),
  INDEX idx_username (naver_username),
  INDEX idx_naver_id (naver_id),
  INDEX idx_review_id (review_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
