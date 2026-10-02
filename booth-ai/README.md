# 면접 부스 AI (booth-ai) — 설치·운영 안내

부스(`booth.html`)가 이 Apps Script 웹 앱을 거쳐 Claude API 를 부릅니다.
- **AI 꼬리질문**: 선생님이 등록한 꼬리질문이 없을 때, 학생 답변을 보고 6초 안에 꼬리질문 하나 (Claude Haiku 4.5). 늦거나 실패하면 부스가 자동 질문(규칙)으로 바꿔서 그대로 진행
- **AI 피드백**: 면접이 끝나면 피드백을 만들어 학생 기록(`sessions/{id}.aiReport`)에 직접 저장 (Claude Sonnet 5.5). 스튜디오에서 볼 수 있음
- 시트 동기화용 `apps-script/Code.gs` 와는 **다른 새 프로젝트**입니다. 섞지 마세요.

## 보내는 것 / 보내지 않는 것
- 보냄: 질문 문장, 받아쓴 답변(학생 이름·학번은 '○○○'로 가림), 생기부 근거, 많이 쓴 낱말, 말하기 지표, 질문별 시간, 지원 학과, 질문 유형, 시선 숫자(응시율·벗어남 횟수)
- 보내지 않음: 이름, 학번, 영상, 얼굴 사진, 학생·세션 id (세션 id 는 저장할 곳을 알려고 Apps Script 까지만 오고 Claude 에는 가지 않음)
- **API 키는 스크립트 속성에만** 있습니다. 코드·저장소·부스 화면 어디에도 없습니다.
- 로그에는 시각·종류·걸린 시간·토큰 수·성공 여부만 남습니다 (답변 원문 없음).

## 처음 설치 (관리자, 한 번)
**배포 순서: ① 규칙 → ② Apps Script → ③ 사이트(booth.html)**

### ① Firebase 규칙 (먼저)
1. Firebase 콘솔 → Firestore → 규칙 → 지금 규칙이 저장소 `firestore.rules`(main `302bd98`)와 같은지 확인
2. 부스 zip 의 `firestore.rules` 로 바꾸고 [게시]. 바뀐 곳은 `sessions` 의 update 에 한 덩어리 — **부스 기록(mode booth)의 `aiReport` 칸 하나만, 본인 토큰으로 (제출 뒤에도)**
3. 규칙 플레이그라운드로 확인 (문서 `sessions/<학생의 부스 기록 id>`, 인증: 그 학생 uid)
   | 시험 | 기대 |
   |---|---|
   | 학생 본인 · update · `aiReport` 만 바꿈 (status submitted 인 기록) | 허용 |
   | 학생 본인 · update · `aiReport` + `teacherFeedback` | 거부 |
   | 다른 학생 uid · update · `aiReport` 만 | 거부 |
   | 학생 본인 · 부스가 아닌 연습 기록(mode personal 등) · `aiReport` 만 | 거부 |
   | 학생 본인 · in_progress 기록 · `items` 바꿈 (예전처럼) | 허용 |

### ② Apps Script 웹 앱
1. https://script.google.com → [새 프로젝트] → 이름 "오송고 면접 부스 AI"
2. `Code.gs` 내용을 모두 지우고 이 폴더의 `Code.gs` 를 붙여넣기 → 저장
3. 왼쪽 ⚙ [프로젝트 설정] → 아래 [스크립트 속성] → [스크립트 속성 추가]
   | 속성 | 값 |
   |---|---|
   | `ANTHROPIC_API_KEY` | Anthropic 콘솔에서 만든 API 키 (sk-ant-… — 다른 곳에 적거나 붙여넣지 마세요) |
   | `FIREBASE_PROJECT_ID` | Firebase 프로젝트 ID (Firebase 콘솔 ⚙ 프로젝트 설정의 '프로젝트 ID') |
   | `DAILY_SESSION_LIMIT` | (선택) 하루 면접 수 한도, 기본 60 |
   | `DAILY_CALL_LIMIT` | (선택) 하루 AI 호출 수 한도, 기본 400 |
   | `SESSION_FOLLOW_LIMIT` | (선택) 면접 한 번 AI 꼬리질문 한도, 기본 8 |
4. **실제 확인 (한 번)**: 위쪽 함수 선택에서 `selfTest` → [실행] → 처음엔 권한 허용 창(외부 서비스 연결) → 허용
   - [실행 로그]에 '꼬리질문 1~5: ○○ms' 와 '피드백(Sonnet, 생각 끄기): … 생각 블록 0개 · usage=…' 가 나오면 성공. **이 로그를 캡처해서 부스 작업 대화에 보내 주세요** (응답 시간·생각 토큰 확인용. 학생 자료는 없음)
5. 오른쪽 위 [배포] → [새 배포] → 유형 ⚙ [웹 앱] → 설명 "부스 AI" · **실행: 나** · **액세스 권한: 모든 사용자** → [배포] → **웹 앱 URL** 복사 (`https://script.google.com/macros/s/…/exec`)
   - 주소가 알려져도 등록된 부스 PC 키 + 로그인한 학생 토큰이 함께 있어야만 쓸 수 있습니다
6. 복사한 주소를 부스 작업 대화에 알려 주세요 → `booth.html` 의 `AI_ENDPOINT` 에 넣은 zip 을 드립니다 (또는 직접 `booth.html` 맨 위 `const AI_ENDPOINT = "";` 따옴표 안에 붙여넣기)

### ③ 사이트
- GitHub 에 `booth.html`(주소가 들어간 것)·`SETUP.md` 올리기 → 부스 PC 에서 Ctrl+F5

### ④ Anthropic 콘솔 월 한도 (꼭)
- https://console.anthropic.com → Settings → **Limits** (또는 Billing) → **Spend limit / 월 사용 한도**를 정함 (예: $20). 넘으면 API 가 멈추고 부스는 자동 질문으로 계속 진행
- 사용량: 콘솔 → Usage 에서 날짜별 비용 확인

## 운영
- **AI 끄기**: 가장 빠른 방법은 Apps Script [배포] → [배포 관리] → 보관(Archive). 부스는 자동 질문·즉석 요약으로 그대로 진행. 또는 `booth.html` 의 `AI_ENABLED` 를 `false` 로
- **코드를 고친 뒤**: [배포] → [배포 관리] → ✏ → 버전 '새 버전' → [배포] (주소는 그대로)
- **한도 바꾸기**: 스크립트 속성 값만 바꾸면 바로 적용
- **비용 예상**: 면접 1번 약 $0.03 (꼬리질문 Haiku 약 $0.002 × 4 + 피드백 Sonnet 약 $0.018) → $30 이면 약 1,000회
- **모델 바꾸기**: `Code.gs` 맨 위 `MODEL_FOLLOW`·`MODEL_REPORT` (피드백을 `claude-haiku-4-5` 로 바꾸면 더 쌈)
- **실행 로그**: Apps Script 왼쪽 [실행] 메뉴에서 호출마다 `{"kind","ms","ok","in","out"}` 확인

## 시험 (Claude Code, 실제 API 는 부르지 않음)
- `handoff/testenv/gas/gastest.mjs` — Apps Script 기능을 흉내 내고 가짜 Firestore·가짜 Claude 로 28항목 (인증·한도·입력 자르기·JSON 아닌 응답·다시 시도·aiReport 쓰기·로그에 원문 없음)
- `handoff/testenv/aitest.py` — 부스 쪽 22항목 (성공·6초 초과·403·한도·네트워크 오류·꺼짐 → 자동 질문으로, 요청에 이름·학번 없음, 결과 화면 AI 피드백)
