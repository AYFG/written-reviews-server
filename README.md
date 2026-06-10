# reviewAuto

네이버 쇼핑 작성한 리뷰를 자동으로 크롤링하고, 관리·수정할 수 있는 풀스택 자동화 도구입니다.

---

## 프로젝트 구조

```
reviewAuto/
├── written-reviews-server/   # Express.js 백엔드 (Node.js)
│   ├── src/
│   │   ├── app.js                  # Express 앱 설정 및 라우트 등록
│   │   ├── server.js               # 서버 진입점 (포트 5001)
│   │   ├── scraper.js              # Puppeteer 기반 리뷰 크롤러
│   │   ├── reviewApiDirect.js      # 순수 HTTP 리뷰 수정 모듈
│   │   ├── config/
│   │   │   └── db.js               # MySQL 연결 풀 설정
│   │   └── routes/
│   │       ├── auth.js             # 로그인 (쿠키 저장)
│   │       ├── crawl.js            # POST /api/crawl
│   │       ├── reviews.js          # GET /api/reviews
│   │       └── reviewEdit.js       # POST /api/reviews/:id/edit
│   ├── schema.sql                  # DB 테이블 정의
│   └── package.json
│
└── written-reviews-client/   # React + Vite + TailwindCSS 프론트엔드
    ├── src/
    │   ├── App.tsx
    │   ├── main.tsx
    │   ├── api/
    │   │   └── reviewApi.ts        # 서버 API 호출 함수
    │   ├── components/
    │   │   ├── ReviewCard.tsx      # 리뷰 카드 (스토어명, 옵션, 판매자 댓글 표시)
    │   │   └── ReviewEditModal.tsx # 리뷰 수정 모달
    │   └── types/
    │       └── review.ts           # Review 타입 정의
    └── package.json
```

---

## 기술 스택

| 구분            | 기술                                    |
| --------------- | --------------------------------------- |
| 백엔드          | Node.js, Express.js, Puppeteer          |
| 프론트엔드      | React 18, TypeScript, Vite, TailwindCSS |
| DB              | MySQL (written_review 데이터베이스)     |
| HTTP 클라이언트 | Axios                                   |

---

## DB 스키마

### `naver_cookies` 테이블

| 컬럼           | 타입               | 설명                   |
| -------------- | ------------------ | ---------------------- |
| id             | INT AUTO_INCREMENT | PK                     |
| naver_username | VARCHAR(100)       | 네이버 아이디 (UNIQUE) |
| cookies        | JSON               | 로그인 쿠키 배열       |
| expires_at     | TIMESTAMP          | 쿠키 만료 시각         |

### `written_reviews` 테이블

| 컬럼                   | 타입               | 설명                       |
| ---------------------- | ------------------ | -------------------------- |
| id                     | INT AUTO_INCREMENT | PK                         |
| naver_username         | VARCHAR(100)       | 네이버 아이디              |
| product_name           | VARCHAR(500)       | 상품명                     |
| product_option_content | VARCHAR(500)       | 상품 옵션                  |
| product_image          | TEXT               | 상품 이미지 URL            |
| store_name             | VARCHAR(200)       | 스토어명                   |
| review_content         | LONGTEXT           | 리뷰 본문                  |
| rating                 | TINYINT            | 별점 (1~5)                 |
| review_date            | VARCHAR(100)       | 리뷰 작성일                |
| order_no               | VARCHAR(100)       | 주문번호                   |
| product_order_no       | VARCHAR(100)       | 상품 주문번호 (UNIQUE KEY) |
| review_id              | VARCHAR(100)       | 네이버 리뷰 ID             |
| seller_comment         | JSON               | 판매자 댓글                |
| raw_data               | JSON               | 원본 크롤링 데이터         |

**UNIQUE KEY**: `(naver_username, product_order_no)`

---

## API 엔드포인트

| 메서드 | URL                     | 설명                                 |
| ------ | ----------------------- | ------------------------------------ |
| POST   | `/api/auth/login`       | 네이버 로그인 및 쿠키 저장           |
| POST   | `/api/crawl`            | 작성한 리뷰 크롤링 및 DB 저장        |
| GET    | `/api/reviews`          | 저장된 리뷰 목록 조회 (페이지네이션) |
| GET    | `/api/reviews/:id`      | 특정 리뷰 상세 조회                  |
| POST   | `/api/reviews/:id/edit` | 리뷰 수정                            |
| GET    | `/health`               | 서버 상태 확인                       |

### GET /api/reviews 파라미터

| 파라미터 | 기본값 | 설명             |
| -------- | ------ | ---------------- |
| page     | 1      | 페이지 번호      |
| limit    | 20     | 페이지당 항목 수 |

---

## 크롤러 동작 방식 (`scraper.js`)

1. **쿠키 주입**: DB에서 저장된 네이버 로그인 쿠키를 Puppeteer 브라우저에 주입
2. **페이지 이동**: `https://shopping.naver.com/my/written-reviews` 접속
3. **데이터 추출**: DOM 파싱으로 리뷰 정보 수집
   - 스토어명: `[class*="WrittenReviewListItemHeaderProductInfo_store"]`
   - 상품 옵션: `[class*="WrittenReviewListItemHeaderProductInfo_option"]`
4. **무한 스크롤**: 더보기 버튼 클릭 반복으로 전체 리뷰 수집
5. **DB UPSERT**: `ON DUPLICATE KEY UPDATE`로 중복 없이 저장

---

## 리뷰 수정 방식 (`reviewApiDirect.js`)

Puppeteer(브라우저) 없이 **순수 HTTP 요청**으로 리뷰를 수정합니다.

### 흐름

```
1. reviewId 확인
   └─ DB 값이 잘못된 경우 → 리뷰 목록 API로 실제 reviewId 조회

2. GET /popup/reviews/api/contents/reviews/{reviewId}
   └─ orderNo, productOrderNo, evaluationValueIds 획득
      (Next.js App Router → SSR HTML에 데이터 없음, REST API 직접 조회)

3. PUT /popup/reviews/api/contents/reviews/{reviewId}
   └─ 수정된 리뷰 내용과 별점 전송 → HTTP 200 확인
```

### 핵심 API

- `GET /popup/reviews/api/contents/reviews/{reviewId}` — 기존 리뷰 데이터 조회
- `PUT /popup/reviews/api/contents/reviews/{reviewId}` — 리뷰 수정 요청

> **배경**: 네이버 쇼핑 리뷰 수정 페이지는 Next.js App Router 기반으로, SSR HTML에 `orderNo` 등의 데이터가 포함되지 않음. REST API GET으로 데이터를 직접 조회하는 방식으로 해결.

---

## 프론트엔드 주요 기능

- **리뷰 목록 조회**: 스토어명, 상품명, 옵션, 별점, 리뷰 본문, 판매자 댓글 표시
- **리뷰 수정 모달**: 리뷰 내용 및 별점 수정
- **페이지네이션**: 페이지 단위 리뷰 탐색
- **리뷰 카드**: 조건부 렌더링으로 없는 필드는 표시 안 함

---

## 시작하기

### 사전 요구사항

- Node.js 18+
- MySQL 8+
- Google Chrome (Puppeteer용)

### 백엔드 실행

```bash
cd written-reviews-server
cp .env.example .env    # DB 접속 정보 설정
npm install
npm run dev             # 포트 5001
```

### 프론트엔드 실행

```bash
cd written-reviews-client
npm install
npm run dev             # 포트 5173
```

### DB 초기화

```bash
# MySQL에서 실행
mysql -u root -p < written-reviews-server/schema.sql
```

---

## 환경 변수 (백엔드 `.env`)

```env
DB_HOST=localhost
DB_PORT=3306
DB_USER=root
DB_PASSWORD=your_password
DB_NAME=written_review
```

---

## 주요 이슈 해결 기록

### 1. Next.js App Router에서 orderNo 없는 문제

- **현상**: SSR HTML(~19KB)에 `orderNo`가 없어 파싱 실패
- **원인**: Next.js App Router는 클라이언트 사이드 렌더링
- **해결**: `GET /popup/reviews/api/contents/reviews/{reviewId}` REST API 직접 호출

### 2. 스토어명·옵션 크롤링 실패

- **현상**: `store_name`, `product_option_content`가 NULL로 저장
- **원인**: "Writable(작성 가능)" 페이지의 CSS 클래스명을 "Written(작성한)" 페이지에 잘못 적용
- **해결**: `WrittenReviewListItemHeaderProductInfo_store/option` 셀렉터로 수정

### 3. 프론트에 스토어명·옵션 미표시

- **현상**: DB에 데이터 있어도 프론트에 안 보임
- **원인**: `reviews.js` SELECT 쿼리에 `store_name`, `product_option_content` 컬럼 누락
- **해결**: SELECT 쿼리에 두 컬럼 추가
