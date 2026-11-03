# math_practices — 전주영 학습 기록판

중·고등 수학 문제풀이 웹앱. 빌드 도구 없는 **정적 HTML(GitHub Pages)** + **Google Apps Script(GAS) 백엔드** + **문제지 JSON**.
학생은 `worksheets/player.html`에서 문제를 풀고, 풀이 기록은 GAS를 거쳐 Google Sheet에 쌓인다.

## 구조

| 경로 | 역할 |
|---|---|
| `index.html` | `index_mathc1.html`로 리다이렉트만 함 |
| `index_mathc1.html` | 메인 홈(문제지 목록·탭). `index_math.html`, `index_old.html`은 이전 버전 — 수정하지 말 것 |
| `worksheets/player.html` | 문제 풀기(채점·필기 캔버스·손글씨 OCR·오답 유형·AI 튜터). 가장 크고 중요한 파일 |
| `worksheets/compose.html` | 문제지 재구성 |
| `worksheets/upload.html` | 학생 오답 사진 → AI(`visionExtract`) → JSON → 검토 대기열 제출 |
| `worksheets/login.html` | 가입/로그인. 세션은 `localStorage.mathapp_session` |
| `today.html`, `worksheets/today.html` | 오늘의 과제(`data/study-plan.json`). **두 파일은 동일 — 고치면 둘 다** |
| `roadmap.html` | 진학 로드맵 |
| `tools/*.html` | 선생님/관리자 전용(review·admin-users·admin-examrange·json_viewer_edit). 공개 내비에 링크 걸지 않음 |
| `data/*.json`, `data/seanmath32/*.json` | 문제지 |
| `data/hakpyeong/*.json` | 고1 전국연합학력평가 11회분(2024.3~2026.9, `me`·`source: hakpyeong`). 그림은 PDF에서 잘라 `images`에 data URL로 들어 있음 |
| `data/worksheets-manifest.json` | 학생에게 보이는 문제지 목록. **루트 `manifest.json`은 PWA용이라 별개** |
| `data/study-plan.json`, `data/exam-ranges.json`, `data/publishers.json` | 학습 계획, 시험 범위, 출판사 |
| `data/tips.json` | Instagram 학습 팁(링크·요약·단원 태그·학년). `tools/admin-tips.html` → GAS `saveTips`로 저장 |
| `data/_pending/` | 승인 전 검토 대기(GAS가 GitHub에 직접 씀) |
| `Code.gs` | GAS 기본 백엔드: `doGet`/`doPost` 라우터(모든 `action` 목록이 `codeRoute_`에 있음), 풀이 기록(Results·Attempts 탭), GitHub 읽기/쓰기, AI(사진→문제·손글씨·LaTeX), 시험범위, 사용자 관리 |
| `gas-*.gs` | GAS 애드온(가입·로그인·검토 대기열 / AI 튜터·복습 세트 / 학습 팁). `Code.gs`와 같은 Apps Script 프로젝트에 함께 넣는다 |
| `normalize_and_register.py` | 새 문제지 diff 한글→영문, id=파일명, manifest 등록 |
| `scripts/validate_worksheets.py` | 문제지·manifest·study-plan 정합성 검사 |

## 문제지 JSON 스키마 (표준)

```json
{
  "id": "파일명과 동일",
  "title": "제목", "unit": "단원", "source": "출처",
  "problems": [
    { "num": 1, "diff": "low|mid|midhigh|high|top", "type": "mc|mc_multi|fillin|subjective|essay",
      "question": "\\(x^2\\)의 값은?",
      "choices": ["5개, 앞에 ①② 붙이지 않음"], "correct": 0,
      "answer": "단답형 정답(fillin)",
      "solution": ["줄 단위", "배열"],
      "family": "유형 코드(선택, player의 유사문제 생성기 키)",
      "images": ["선택"] }
  ]
}
```

- `correct`는 **0-based**. `mc_multi`면 배열.
- 수식은 **`\\( … \\)`(인라인) / `\\[ … \\]`(블록)만**. `$`는 렌더링 안 됨.
- `num`은 숫자 또는 교재 번호 문자열(`"0398"`, `"V-1"`) 둘 다 허용.
- 구 스키마(`number`/`difficulty`/`mcq`/`short`/1-based `answer`)는 `player.html`의 `normalizeProblem()`이 변환해 주지만, 새 데이터는 표준으로 쓴다.

## 파일명 규칙

`{학년}_{yymm 또는 yy}_{학기}_{분류}_{세부}.json` — 예: `m1_2604_s1_tb_chap01-r1`, `m1_2507_s1_peq_final_banpo`
- 학년: `m0` 중학교, `m1` 고1 / 분류(`category`): `tb` 교재, `peq` 기출(중간·기말), `me` 모의고사
- 재시도·복습판은 `-r01`, `-r1` 접미사

## 작업 규칙

- **HTML 수정 시 파일 맨 위에 버전 주석을 추가**한다: `<!-- vX.Y (YYYY-MM-DD): 무엇을 왜 바꿨는지 -->`. 기존 주석은 지우지 않는다.
- 빌드·번들러·npm 의존성을 들이지 않는다. 외부 라이브러리는 기존처럼 cdnjs(KaTeX 0.16.9)만. 예외: 홈 "학습 팁" 탭의 Instagram 공식 `embed.js`(탭을 열 때만 로드).
- 학습 팁은 **링크만** 저장한다. Instagram 게시물 이미지·본문을 내려받아 저장소에 넣지 않는다(저작권). 링크 형식은 `https://www.instagram.com/(p|reel)/코드/` — `gas-tips-addon.gs`, `index_mathc1.html`, `player.html`, 검증 스크립트가 같은 규칙을 쓴다.
- 문제 텍스트를 `innerHTML`에 넣을 땐 `escapeHtml()`, 속성에는 `attrSafe()`/`escapeAttr()` — LaTeX의 `<`, `>`, `\`가 깨지는 버그가 반복됐다.
- `TEST_MODE_UNLOCK_SOLUTIONS`(player.html)는 테스트 기간 임시 `true`. 함부로 바꾸지 말고 사용자에게 확인.
- GAS 코드 변경은 `Code.gs`·`gas-*.gs` 파일로 전달한다(사용자가 Apps Script 편집기에 붙여넣고 "배포 관리 → 새 버전"으로 재배포 — 새 배포를 만들면 URL이 바뀜). 새 `action`은 `Code.gs`의 `codeRoute_`에 한 줄 추가한다. 여러 .gs 파일이 전역을 공유하므로 상수·함수 이름은 파일별 접두사(`CODE_`/`code`, `ai`, `tips`)로 겹치지 않게 한다.
- `SHEET_WEBHOOK_URL`(GAS 배포 URL)과 `OCR_SPACE_KEY`는 이미 공개 저장소에 있는 값이다. 새 비밀값(GitHub 토큰, Anthropic 키)은 절대 HTML/JSON에 넣지 말고 GAS 스크립트 속성에만.
- 학생 이름·전화번호 등 개인정보를 데이터 파일이나 커밋 메시지에 넣지 않는다.
- 정답을 바꾸는 수정은 반드시 근거(직접 풀이)와 함께 사용자에게 보고하고 확인받는다.

## 검증

```bash
python scripts/validate_worksheets.py           # 전체 (오류 있으면 exit 1)
python scripts/validate_worksheets.py data/x.json
node --check <추출한 스크립트>                   # HTML 인라인 JS 문법 — .claude/hooks가 자동으로 함
```

`data/**/*.json` 또는 HTML을 Edit/Write하면 `.claude/hooks/check_on_edit.py`가 자동으로 검사하고, 오류가 있으면 알려준다.
화면 확인은 프로젝트 루트에서 정적 서버(`python -m http.server 8000`)를 띄우고 `/worksheets/player.html?set=<id>`. 단, 로그인 게이트 때문에 `localStorage.mathapp_session`에 `{"studentId":"test","name":"테스트"}`를 넣어야 열린다.

## 반복 작업은 스킬로

- `/add-worksheet` — PDF·사진·텍스트 → 표준 JSON → 정규화·등록 → 검증 → 정답 교차검증
- `/verify-answers` — 기존 문제지의 정답·풀이를 `math-checker` 서브에이전트로 독립 풀이해 대조
- `/study-plan` — 시험일·범위로 `data/study-plan.json` 생성/갱신

## 앱 안의 AI 에이전트 (`gas-ai-agent-addon.gs`)

- `aiTutor`: 문제별 힌트/오답 설명/질문 답변. 도구 `find_similar_problems`로 기존 문제 추천.
- `aiMakeReviewSet`: 오답 → 변형 문제 생성 → `validate_problems`로 자체 검사 → `submit_review_set`으로 `data/_pending` 제출. **선생님이 `tools/review.html`에서 승인해야 공개**.
- 문제 검사 규칙을 바꾸면 `aiValidateProblems_()`와 `scripts/validate_worksheets.py`를 함께 고친다.
- 모델은 스크립트 속성 `ANTHROPIC_MODEL`(기본 `claude-opus-5-5`).
