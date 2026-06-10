# Migration Plan: Node.js → Spring Boot (DDD)

> **기존 시스템**: `written-reviews-server` (Node.js / Express / Puppeteer)  
> **목표 시스템**: Spring Boot 3.x / Java 17 / DDD / Playwright Java  
> **언어**: Java 17 (필수)  
> **빌드 도구**: Gradle (Kotlin DSL)

---

## 목차

1. [시스템 현황 분석](#1-시스템-현황-분석)
2. [제약 조건 및 위험 요소](#2-제약-조건-및-위험-요소)
3. [DDD 아키텍처 설계](#3-ddd-아키텍처-설계)
4. [패키지 구조](#4-패키지-구조)
5. [도메인 모델 상세](#5-도메인-모델-상세)
6. [인프라 계층 상세](#6-인프라-계층-상세)
7. [API 명세 (기존 호환)](#7-api-명세-기존-호환)
8. [마이그레이션 단계별 계획](#8-마이그레이션-단계별-계획)
9. [의존성 (build.gradle.kts)](#9-의존성-buildgradlekts)
10. [검증 계획](#10-검증-계획)

---

## 1. 시스템 현황 분석

### 기존 Node.js 서버 역할

| 모듈               | 파일                                       | 역할                                                             |
| ------------------ | ------------------------------------------ | ---------------------------------------------------------------- |
| 서버 진입점        | `src/server.js`, `src/app.js`              | Express 서버, 라우터 마운트                                      |
| 수동 로그인        | `src/login.js`                             | 헤드리스 OFF 브라우저 실행, 사용자 직접 로그인 대기 (최대 300초) |
| 리뷰 크롤러        | `src/scraper.js`                           | Puppeteer로 `written-reviews` 페이지 파싱                        |
| 리뷰 수정 (현재)   | `src/reviewApiDirect.js`                   | 순수 HTTP (Axios) 방식으로 네이버 리뷰 수정 API 호출             |
| 리뷰 수정 (레거시) | `src/reviewApi.js`, `src/reviewApiHttp.js` | Puppeteer 기반, 현재 미사용                                      |
| DB 설정            | `src/config/db.js`                         | MySQL2 커넥션 풀                                                 |

### 기존 DB 스키마

```sql
-- 쿠키 저장
CREATE TABLE naver_cookies (
    naver_username VARCHAR(100) UNIQUE,  -- nid_inf 쿠키 값 (숫자)
    naver_id       VARCHAR(100),         -- 실제 로그인 아이디
    cookies        JSON,                 -- 쿠키 배열 전체
    expires_at     TIMESTAMP
);

-- 리뷰 저장
CREATE TABLE written_reviews (
    id                    BIGINT AUTO_INCREMENT PRIMARY KEY,
    naver_id              VARCHAR(100),
    naver_username        VARCHAR(100),
    review_id             VARCHAR(100),
    product_name          VARCHAR(500),
    product_option_content VARCHAR(500),
    product_image         TEXT,
    store_name            VARCHAR(200),
    review_content        LONGTEXT,
    rating                TINYINT,
    review_date           VARCHAR(50),
    order_no              VARCHAR(100),
    product_order_no      VARCHAR(100),
    seller_comment        JSON,          -- { date, content }
    raw_data              JSON,
    UNIQUE KEY uq_naver_review (naver_id, review_id)
);
```

---

## 2. 제약 조건 및 위험 요소

### [필수 제약] 로그인이 수동 방식임

> 기존 `login.js`의 핵심 동작은 **헤드리스 OFF 브라우저**를 열고 사람이 직접 로그인할 때까지 폴링 대기하는 방식이다.  
> 네이버는 자동 로그인을 차단하므로 이 구조는 Spring Boot에서도 **동일하게 유지**해야 한다.

**서버 배포 시 필수 고려사항:**

- 서버에 GUI/Display 환경 필요 (Docker: `DISPLAY` 환경변수 또는 Xvfb)
- 클라우드 환경: headful 브라우저 실행 가능한 환경 구성 필요
- `/api/auth/login` 호출 시 서버 측 브라우저 창이 열려 관리자가 직접 로그인해야 함

### [고위험] 스크래퍼 이식 복잡도

기존 `scraper.js`는 단순한 크롤러가 아니다:

```
reviewId 추출 5단계 폴백:
  1. data-review-id 속성
  2. 수정 버튼 href
  3. /reviews/{id} 링크 파싱
  4. data-* 속성 전수 탐색
  5. productOrderNo (최후 수단)

window.open 인터셉트:
  page.exposeFunction("openWindow") 등록
  → 수정 버튼 클릭 시 팝업 URL 가로채기
  → 실제 reviewId 역추출 후 덮어쓰기

__NEXT_DATA__ Apollo State 파싱 (크롤링 대상 = 네이버 쇼핑 사이트):
  네이버가 사용하는 Next.js hydration JSON 직접 순회
  → __typename에 "review" / "written" 포함 항목 수집
```

Playwright Java에서는 `page.exposeFunction()` 대신 `addInitScript()` + `waitForFunction()` 조합으로 구현 필요.

### [중간] RSC Payload 파싱 (크롤링 대상 사이트)

> ⚠️ 아래의 Next.js / RSC 언급은 **크롤링 대상인 네이버 쇼핑 사이트의 기술 스택**을 말하는 것이지, 본 프로젝트의 프론트엔드(React)와는 무관합니다.

`reviewApiDirect.js`의 폴백 경로는 네이버 쇼핑이 사용하는 Next.js App Router의 `text/x-component` 스트리밍 응답을 정규식으로 직접 파싱한다.  
이 로직은 `Infrastructure` 계층의 `NaverReviewHttpClient`로 이전되어야 한다.

### [기존 버그] Connection 재사용 버그

`src/routes/reviewEdit.js`에서 `pool.getConnection()` → `release()` 후 동일 `connection` 변수로 쿠키를 재조회하는 버그가 존재한다. JPA로 전환 시 자연스럽게 해결된다.

### [보안] puppeteer_data/ 디렉토리

Chrome 프로파일(`Cookies`, `Login Data`, SQLite DB 등)이 프로젝트 루트에 포함되어 있다.  
Spring Boot 전환 시 Playwright `storageState.json` 방식으로 대체하고, `.gitignore`에 명시적으로 추가해야 한다.

### [설계] 에러 복구 및 재시도 전략

기존 Node.js에서 누락된 부분. Spring Boot 전환 시 반드시 추가:

- **크롤링 실패 재시도**: 계정별 크롤링 실패 시 최대 2회 재시도 (exponential backoff)
- **쿠키 만료 감지**: `naver_cookies.expires_at` 확인 후 만료된 쿠키 자동 스킵, 로그 기록
- **부분 실패 허용**: 5개 계정 중 1개 실패해도 나머지 4개 결과는 정상 저장
- **크롤링 타임아웃**: 단일 계정 크롤링 60초 제한 (`Playwright.setDefaultTimeout()`)

---

## 3. DDD 아키텍처 설계

### Bounded Context

```
┌─────────────────────────────────────────────────────────────────┐
│                    written-reviews-server                       │
│                                                                 │
│  ┌──────────────────────┐    ┌──────────────────────────────┐   │
│  │  Identity & Access   │    │     Review Management        │   │
│  │                      │    │                              │   │
│  │  NaverAccount        │───▶│  Review                      │   │
│  │  SessionToken        │    │  StoreInfo                   │   │
│  │  CookieRepository    │    │  SellerComment               │   │
│  └──────────────────────┘    │  ReviewRepository            │   │
│                              └──────────────┬───────────────┘   │
│                                             │                   │
│                              ┌──────────────▼───────────────┐   │
│                              │  Collector (Infrastructure)   │   │
│                              │                              │   │
│                              │  PlaywrightReviewCollector   │   │
│                              │  NaverReviewHttpClient       │   │
│                              └──────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────┘
```

### 레이어드 아키텍처 (각 BC 내부)

```
┌─────────────────────────────────────────────┐
│          User Interface Layer               │
│  ReviewController / AuthController            │
└────────────────────┬────────────────────────┘
                     │ DTO
┌────────────────────▼────────────────────────┐
│          Application Layer                  │
│  CrawlReviewsUseCase (with @Async)           │
│  EditReviewUseCase                          │
│  LoginUseCase                               │
└────────────────────┬────────────────────────┘
                     │ Domain Interface
┌────────────────────▼────────────────────────┐
│          Domain Layer                       │
│  Review (Entity/Aggregate Root)             │
│  NaverAccount (Entity)                      │
│  ReviewSyncDomainService                    │
│  ReviewRepository (interface)               │
│  NaverAccountRepository (interface)         │
└────────────────────┬────────────────────────┘
                     │ implements
┌────────────────────▼────────────────────────┐
│          Infrastructure Layer               │
│  JpaReviewRepository                        │
│  JpaNaverAccountRepository                  │
│  PlaywrightReviewCollector                  │
│  NaverReviewHttpClient                      │
└─────────────────────────────────────────────┘
```

---

## 4. 패키지 구조

```
com.naverreview
├── NaverReviewApplication.java
│
├── common/
│   ├── exception/
│   │   ├── DomainException.java
│   │   └── ReviewNotFoundException.java
│   └── web/
│       ├── ApiResponse.java          # 공통 응답 래퍼
│       └── GlobalExceptionHandler.java
│
├── identity/                         # Bounded Context: 인증 및 접근
│   ├── domain/
│   │   ├── model/
│   │   │   ├── NaverAccount.java     # @Entity, Aggregate Root
│   │   │   └── SessionToken.java     # @Embeddable, 쿠키 배열 + 만료시각
│   │   └── repository/
│   │       └── NaverAccountRepository.java  # interface
│   ├── application/
│   │   └── LoginUseCase.java
│   └── infrastructure/
│       ├── JpaNaverAccountRepository.java
│       └── PlaywrightBrowserLoginService.java  # 수동 로그인 오케스트레이터
│
└── review/                           # Bounded Context: 리뷰 관리
    ├── domain/
    │   ├── model/
    │   │   ├── Review.java           # @Entity, Aggregate Root (JPA 어노테이션 직접 부착)
    │   │   ├── StoreInfo.java        # @Embeddable
    │   │   └── SellerComment.java    # @Embeddable
    │   ├── service/
    │   │   └── ReviewSyncDomainService.java  # 신규/업데이트 분류 로직
    │   └── repository/
    │       └── ReviewRepository.java  # interface
    ├── application/
    │   ├── CrawlReviewsUseCase.java
    │   └── EditReviewUseCase.java
    ├── infrastructure/
    │   ├── collector/
    │   │   ├── ReviewCollector.java           # interface
    │   │   └── PlaywrightReviewCollector.java # scraper.js 대체
    │   ├── http/
    │   │   └── NaverReviewHttpClient.java     # reviewApiDirect.js 대체
    │   └── persistence/
    │       └── JpaReviewRepository.java
    └── interfaces/
        ├── ReviewController.java
        └── CrawlController.java      # 크롤링도 review BC 소속
```

---

## 5. 도메인 모델 상세

### Review (Aggregate Root)

> **설계 결정**: 현재 도메인 복잡도에서는 도메인 엔티티와 JPA 엔티티를 분리하면 과설계.  
> `Review`에 `@Entity` 어노테이션을 직접 부착하여 단일 클래스로 운용한다.

```java
// com.naverreview.review.domain.model.Review
@Entity
@Table(name = "written_reviews",
       uniqueConstraints = @UniqueConstraint(columnNames = {"naver_id", "review_id"}))
@Getter
public class Review {

    @Id @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;

    @Column(name = "naver_id")
    private String naverId;

    @Column(name = "review_id")
    private String reviewId;              // 네이버 리뷰 ID
    private String productName;
    private String productOptionContent;
    @Column(columnDefinition = "TEXT")
    private String productImage;
    @Embedded
    private StoreInfo storeInfo;
    @Column(columnDefinition = "LONGTEXT")
    private String reviewContent;         // 수정 가능
    private int rating;                   // 수정 가능 (1~5)
    private String reviewDate;
    private String orderNo;
    private String productOrderNo;
    @Embedded
    private SellerComment sellerComment;
    @Column(columnDefinition = "json")
    @Convert(converter = JsonMapConverter.class)
    private Map<String, Object> rawData;

    protected Review() {} // JPA용 기본 생성자

    // 생성자는 정적 팩토리 메서드만 허용
    public static Review create(...) { ... }

    // 리뷰 수정 - 도메인 로직 내부 캡슐화
    public void edit(String newContent, int newRating) {
        validateRating(newRating);
        validateContent(newContent);
        this.reviewContent = newContent;
        this.rating = newRating;
    }

    private void validateRating(int rating) {
        if (rating < 1 || rating > 5) {
            throw new DomainException("별점은 1~5 사이여야 합니다.");
        }
    }
}
```

### NaverAccount (Entity)

```java
// com.naverreview.identity.domain.model.NaverAccount
@Getter
public class NaverAccount {

    private final String naverUsername;   // nid_inf 쿠키 값 (UNIQUE KEY)
    private String naverId;               // 실제 로그인 아이디
    private SessionToken sessionToken;    // 쿠키 배열 + 만료시각

    public void updateSession(List<Cookie> cookies, Instant expiresAt) {
        this.sessionToken = new SessionToken(cookies, expiresAt);
    }

    public boolean isSessionExpired() {
        return sessionToken == null || sessionToken.isExpired();
    }
}
```

### ReviewSyncDomainService

```java
// com.naverreview.review.domain.service.ReviewSyncDomainService
@DomainService  // 커스텀 마커 애노테이션 (또는 @Component)
public class ReviewSyncDomainService {

    /**
     * 크롤링 결과를 기존 DB 데이터와 비교하여 신규/업데이트/변경없음으로 분류.
     * 순수 도메인 로직. DB 접근 없음.
     */
    public SyncResult classify(
        List<Review> crawledReviews,
        List<Review> existingReviews
    ) {
        Map<String, Review> existingMap = existingReviews.stream()
            .collect(toMap(Review::getReviewId, identity()));

        List<Review> toInsert = new ArrayList<>();
        List<Review> toUpdate = new ArrayList<>();

        for (Review crawled : crawledReviews) {
            Review existing = existingMap.get(crawled.getReviewId());
            if (existing == null) {
                toInsert.add(crawled);
            } else if (hasChanged(crawled, existing)) {
                toUpdate.add(crawled);
            }
        }
        return new SyncResult(toInsert, toUpdate);
    }

    private boolean hasChanged(Review crawled, Review existing) {
        // 판매자 댓글 신규 등록 여부도 변경으로 감지
        return !Objects.equals(crawled.getReviewContent(), existing.getReviewContent())
            || crawled.getRating() != existing.getRating()
            || !Objects.equals(crawled.getSellerComment(), existing.getSellerComment());
    }
}
```

---

## 6. 인프라 계층 상세

### PlaywrightReviewCollector (scraper.js 대체)

> **핵심 구현 주의사항**: 기존 `scraper.js`의 `window.open` 인터셉트는 Playwright Java에서  
> `page.addInitScript()` + `page.waitForFunction()` 조합으로 구현해야 한다.

```java
// com.naverreview.review.infrastructure.collector.PlaywrightReviewCollector
@Component
@RequiredArgsConstructor
public class PlaywrightReviewCollector implements ReviewCollector {

    private static final String WRITTEN_REVIEWS_URL =
        "https://shopping.naver.com/my/written-reviews";

    @Override
    public List<CollectedReviewData> collect(List<Cookie> cookies) {
        try (Playwright playwright = Playwright.create()) {
            BrowserType.LaunchOptions options = new BrowserType.LaunchOptions()
                .setHeadless(true);  // 크롤링은 headless 가능

            try (Browser browser = playwright.chromium().launch(options)) {
                BrowserContext context = browser.newContext();
                injectCookies(context, cookies);

                Page page = context.newPage();

                // window.open 인터셉트: 팝업 URL에서 reviewId 추출
                installWindowOpenInterceptor(page);

                page.navigate(WRITTEN_REVIEWS_URL);
                page.waitForLoadState(LoadState.NETWORKIDLE);

                // 1단계: __NEXT_DATA__ 파싱 시도
                List<CollectedReviewData> result = tryParseNextData(page);
                if (!result.isEmpty()) return result;

                // 2단계: DOM 직접 파싱 (폴백)
                return parseFromDom(page);
            }
        }
    }

    /**
     * window.open 인터셉트로 수정 버튼 클릭 시 팝업 URL에서 실제 reviewId 추출.
     * Playwright Java: addInitScript로 window.open 오버라이드 후
     * page.evaluate로 결과 수집.
     */
    private void installWindowOpenInterceptor(Page page) {
        page.addInitScript(
            "window.__interceptedUrls = [];" +
            "const _open = window.open.bind(window);" +
            "window.open = function(url, ...args) {" +
            "  window.__interceptedUrls.push(url);" +
            "  return null;" +  // 실제 팝업은 열지 않음
            "};"
        );
    }

    /**
     * reviewId 5단계 폴백 - 기존 scraper.js 로직 이식
     * 1. data-review-id 속성
     * 2. 수정 버튼 href
     * 3. /reviews/{id} 링크 파싱
     * 4. data-* 속성 전수 탐색
     * 5. productOrderNo (최후 수단)
     */
    private String extractReviewId(ElementHandle item) {
        // ... 5단계 폴백 구현
    }

    private void injectCookies(BrowserContext context, List<Cookie> cookies) {
        List<com.microsoft.playwright.options.Cookie> playwrightCookies =
            cookies.stream()
                .map(this::toPlaywrightCookie)
                .collect(toList());
        context.addCookies(playwrightCookies);
    }
}
```

### NaverReviewHttpClient (reviewApiDirect.js 대체)

```java
// com.naverreview.review.infrastructure.http.NaverReviewHttpClient
@Component
@RequiredArgsConstructor
public class NaverReviewHttpClient {

    private final RestClient restClient;  // Spring 6.1+

    private static final String REVIEW_API_BASE =
        "https://m.shopping.naver.com/popup/reviews/api/contents/reviews";

    /**
     * 리뷰 수정 - 3단계 전략
     * 1. reviewId 유효성 검사 (7자리 이상 숫자)
     * 2. 폼 데이터 취득 (REST API → RSC payload 폴백)
     * 3. PUT 요청으로 수정
     */
    public void editReview(
        String reviewId,
        String content,
        int score,
        List<Cookie> cookies
    ) {
        String validReviewId = resolveReviewId(reviewId, cookies);
        ReviewFormData formData = fetchFormData(validReviewId, cookies);
        putReview(validReviewId, content, score, formData, cookies);
    }

    /**
     * RSC Payload 파싱 (폴백 경로)
     * 네이버 쇼핑 사이트(Next.js 기반)의 text/x-component 스트리밍 응답을 파싱.
     * 정규식으로 orderNo, productOrderNo, evaluationValueIds 추출.
     */
    private ReviewFormData parseRscPayload(String reviewId, List<Cookie> cookies) {
        String rscBody = restClient.get()
            .uri("https://m.shopping.naver.com/reviews/written/{id}", reviewId)
            .header("Accept", "text/x-component")
            .headers(h -> addCookieHeader(h, cookies))
            .retrieve()
            .body(String.class);

        return RscPayloadParser.parse(rscBody);  // 정규식 파싱 유틸
    }
}
```

### PlaywrightBrowserLoginService (login.js 대체)

```java
// com.naverreview.identity.infrastructure.PlaywrightBrowserLoginService
@Component
public class PlaywrightBrowserLoginService {

    private static final int MAX_WAIT_SECONDS = 300;
    private static final String WRITTEN_REVIEWS_URL =
        "https://shopping.naver.com/my/written-reviews";

    /**
     * 헤드리스 OFF로 브라우저 실행.
     * 사용자가 직접 로그인할 때까지 폴링 대기.
     * storageState.json으로 세션 영속화 (puppeteer_data/ 대체).
     */
    public LoginResult login(Path storageStatePath) {
        try (Playwright playwright = Playwright.create()) {
            BrowserType.LaunchOptions options = new BrowserType.LaunchOptions()
                .setHeadless(false);  // 사람이 로그인해야 하므로 headful 필수

            try (Browser browser = playwright.chromium().launch(options)) {

                BrowserContext context = storageStatePath.toFile().exists()
                    ? browser.newContext(new Browser.NewContextOptions()
                        .setStorageStatePath(storageStatePath))
                    : browser.newContext();

                Page page = context.newPage();
                page.navigate(WRITTEN_REVIEWS_URL);

                // 이미 로그인된 상태 확인
                if (isLoggedIn(page)) {
                    return extractLoginResult(page, context, storageStatePath);
                }

                // 최대 300초 폴링 대기
                for (int i = 0; i < MAX_WAIT_SECONDS; i++) {
                    Thread.sleep(1000);
                    if (isLoggedIn(page)) {
                        return extractLoginResult(page, context, storageStatePath);
                    }
                }

                throw new LoginTimeoutException("로그인 대기 시간 초과: " + MAX_WAIT_SECONDS + "초");
            }
        }
    }

    private LoginResult extractLoginResult(
        Page page,
        BrowserContext context,
        Path storageStatePath
    ) {
        // storageState.json 저장 (puppeteer_data/ 대체)
        context.storageState(new BrowserContext.StorageStateOptions()
            .setPath(storageStatePath));

        List<com.microsoft.playwright.options.Cookie> cookies = context.cookies();
        String naverId = extractNaverId(page, cookies);
        String naverUsername = extractNaverUsername(cookies);

        return new LoginResult(naverId, naverUsername, cookies);
    }

    private boolean isLoggedIn(Page page) {
        try {
            return (Boolean) page.evaluate(
                "() => document.querySelector('[data-cy=\"written_review\"]') !== null" +
                " || window.location.pathname.includes('written-reviews')"
            );
        } catch (Exception e) {
            return false;
        }
    }
}
```

---

## 7. API 명세 (기존 호환)

기존 Node.js 서버와 응답 JSON 규격을 유지한다.

### Authentication

| Method | Path              | 설명                           |
| ------ | ----------------- | ------------------------------ |
| `POST` | `/api/auth/login` | 수동 로그인 실행, 쿠키 DB 저장 |

**Request Body**: 없음 (서버 측 브라우저가 실행됨)

**Response**:

```json
{
  "success": true,
  "naverId": "user123",
  "naverUsername": "1234567890",
  "expiresAt": "2026-06-01T00:00:00Z"
}
```

### Crawl

| Method | Path         | 설명                       |
| ------ | ------------ | -------------------------- |
| `POST` | `/api/crawl` | 전체 계정 리뷰 크롤링 실행 |

**Response**:

```json
{
  "success": true,
  "totalCrawled": 42,
  "inserted": 5,
  "updated": 3
}
```

### Reviews

| Method | Path                     | 설명                          |
| ------ | ------------------------ | ----------------------------- |
| `GET`  | `/api/reviews`           | 리뷰 목록 조회 (페이지네이션) |
| `GET`  | `/api/reviews/{id}`      | 리뷰 단건 조회                |
| `POST` | `/api/reviews/{id}/edit` | 리뷰 내용 수정                |

**GET /api/reviews 쿼리 파라미터**:

- `page`: 페이지 번호 (기본: 0)
- `size`: 페이지 크기 (기본: 20)
- `naverId`: 계정 필터 (선택)

**POST /api/reviews/{id}/edit Request Body**:

```json
{
  "content": "수정할 리뷰 내용",
  "score": 5
}
```

---

## 8. 마이그레이션 단계별 계획

### Phase 0: 사전 준비 (Node.js 서버 유지)

- [ ] 기존 `src/routes/reviewEdit.js`의 `connection.release()` 버그 수정
- [ ] `puppeteer_data/` 디렉토리 `.gitignore` 추가
- [ ] MySQL 스키마 확인 및 기존 데이터 백업
- [ ] Spring Boot 프로젝트 초기화 (별도 레포 또는 `/spring` 하위 디렉토리)

### Phase 1: 도메인 모델 및 영속성 계층

- [ ] `Review`, `NaverAccount` 도메인 엔티티 구현
- [ ] `ReviewRepository`, `NaverAccountRepository` 인터페이스 정의
- [ ] `JpaReviewRepository`, `JpaNaverAccountRepository` 구현
- [ ] `ReviewSyncDomainService` 구현 + 단위 테스트 작성
- [ ] 기존 MySQL 스키마와 JPA 매핑 검증

### Phase 2: HTTP 리뷰 수정 클라이언트

- [ ] `NaverReviewHttpClient` 구현 (`reviewApiDirect.js` 이식)
  - `reviewId` 유효성 검사 및 조회 로직
  - REST API 방식 폼 데이터 취득
  - RSC Payload 파싱 폴백 (`RscPayloadParser` 유틸 작성)
  - PUT 수정 요청
- [ ] 기존 Node.js와 동일한 쿠키 주입 방식 확인

### Phase 3: Playwright 크롤러

> 가장 복잡한 단계. 충분한 개발 시간 확보 필요.

- [ ] `PlaywrightReviewCollector` 기본 구조 구현
- [ ] 쿠키 주입 (`context.addCookies()`) 구현
- [ ] `__NEXT_DATA__` Apollo State 파싱 (1단계)
- [ ] DOM 직접 파싱 (2단계 폴백)
- [ ] `reviewId` 5단계 폴백 로직 이식
- [ ] `window.open` 인터셉트 → `addInitScript()` 방식으로 재구현
- [ ] 계정별 병렬 크롤링 구현 (`@Async` + `CompletableFuture`)
- [ ] 에러 복구 전략 적용 (재시도, 타임아웃, 쿠키 만료 스킵)
- [ ] 기존 Node.js 크롤러와 결과 비교 테스트

### Phase 4: 로그인 서비스

- [ ] `PlaywrightBrowserLoginService` 구현
- [ ] `puppeteer_data/` → `storageState.json` 세션 마이그레이션 방법 검토
  - 기존 Chrome 쿠키를 내보내 Playwright `storageState.json` 포맷으로 변환하는 일회성 스크립트 작성
- [ ] 서버 환경에서 headful 브라우저 실행 환경 구성 문서화

### Phase 5: Application / Interface 계층

- [ ] `CrawlReviewsUseCase` 구현 (`@Async` + `CompletableFuture`로 계정별 병렬 크롤링)
- [ ] `EditReviewUseCase`, `LoginUseCase` 구현
- [ ] `ReviewController`, `CrawlController` → `review.interfaces` 패키지에 통합 배치
- [ ] `AuthController` 구현
- [ ] 기존 `/api/reviews` 응답 JSON 형식과 비교 검증
- [ ] `GlobalExceptionHandler` 구현

### Phase 6: 병행 운영 및 전환

- [ ] 기존 Node.js 서버(포트 5001)와 Spring Boot 서버(포트 8080) 동시 실행
- [ ] 동일 MySQL DB를 양쪽에서 공유
- [ ] 동일 API 요청에 대한 응답 JSON 비교 (자동화 스크립트)
- [ ] 쿠키 기반 크롤링 결과 비교
- [ ] 검증 완료 후 트래픽 Spring Boot로 전환
- [ ] Node.js 서버 종료 및 레거시 파일 정리

---

## 9. 의존성 (build.gradle.kts)

```kotlin
plugins {
    id("org.springframework.boot") version "3.4.0"
    id("io.spring.dependency-management") version "1.1.6"
    java
}

java {
    sourceCompatibility = JavaVersion.VERSION_17
    targetCompatibility = JavaVersion.VERSION_17
}

dependencies {
    // Spring Boot Core
    implementation("org.springframework.boot:spring-boot-starter-web")
    implementation("org.springframework.boot:spring-boot-starter-data-jpa")
    implementation("org.springframework.boot:spring-boot-starter-validation")

    // DB
    runtimeOnly("com.mysql:mysql-connector-j")

    // Playwright (scraper.js 대체)
    implementation("com.microsoft.playwright:playwright:1.49.0")

    // HTTP Client (reviewApiDirect.js 대체)
    // RestClient는 Spring 6.1+ 내장, 별도 의존성 불필요

    // JSON 처리
    implementation("com.fasterxml.jackson.core:jackson-databind")
    implementation("com.fasterxml.jackson.datatype:jackson-datatype-jsr310")

    // 유틸
    compileOnly("org.projectlombok:lombok")
    annotationProcessor("org.projectlombok:lombok")

    // 테스트
    testImplementation("org.springframework.boot:spring-boot-starter-test")
    testImplementation("com.h2database:h2")  // 통합 테스트용
}
```

### application.yml

```yaml
spring:
  datasource:
    url: jdbc:mysql://${DB_HOST:localhost}:3306/${DB_NAME:review_auto}
    username: ${DB_USER}
    password: ${DB_PASSWORD}
    hikari:
      maximum-pool-size: 10
  jpa:
    hibernate:
      ddl-auto: validate # 기존 스키마 유지, 절대 auto-create 금지
    show-sql: false
    open-in-view: false

server:
  port: 8080

naver-review:
  storage-state-path: ${STORAGE_STATE_PATH:./playwright_data/storageState.json}
  login-timeout-seconds: 300
```

---

## 10. 검증 계획

### 단위 테스트

```
ReviewSyncDomainServiceTest
  - 신규 리뷰가 올바르게 toInsert로 분류되는지
  - 내용이 변경된 리뷰가 toUpdate로 분류되는지
  - 변경 없는 리뷰가 분류 결과에 포함되지 않는지
  - 판매자 댓글 신규 등록 시 변경으로 감지되는지

ReviewTest
  - 별점이 1~5 범위를 벗어나면 DomainException 발생
  - 빈 문자열 리뷰 내용에 DomainException 발생

RscPayloadParserTest
  - text/x-component 샘플 응답에서 orderNo, evaluationValueIds 파싱
```

### 통합 테스트 (H2)

```
JpaReviewRepositoryTest
  - (naver_id, review_id) UNIQUE 제약 조건 동작 확인
  - upsert (기존 -> 업데이트, 신규 -> 삽입) 동작 확인
  - naverId 기준 페이지네이션 조회

JpaNaverAccountRepositoryTest
  - naver_username UNIQUE 제약 조건
  - 최신 쿠키 1개 조회 (updated_at DESC)
```

### E2E 검증 (병행 운영 단계)

```bash
# 기존 Node.js 응답
curl http://localhost:5001/api/reviews?page=0&size=20

# 신규 Spring Boot 응답
curl http://localhost:8080/api/reviews?page=0&size=20

# diff로 JSON 구조 비교
```

---

## 부록: 위험도 요약

| 항목                             | 위험도   | 사유                                                             |
| -------------------------------- | -------- | ---------------------------------------------------------------- |
| `PlaywrightReviewCollector` 이식 | **높음** | 5단계 폴백, `window.open` 인터셉트, `__NEXT_DATA__` 파싱         |
| RSC Payload 파싱                 | **중간** | 네이버 사이트(Next.js 기반) 버전 변경 시 정규식 패턴 무효화 가능 |
| 수동 로그인 서버 환경 구성       | **중간** | headful 브라우저 실행 환경 필요                                  |
| 계정별 병렬 크롤링               | **중간** | 기존 순차 실행에서 `@Async` 전환 시 동시성 이슈 관리 필요        |
| 스키마 호환성                    | **낮음** | `ddl-auto: validate`로 보호, JPA 매핑 검증만 필요                |
| HTTP 리뷰 수정 이식              | **낮음** | 순수 HTTP 로직이라 이식 난이도 낮음                              |
