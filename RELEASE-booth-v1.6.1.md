# 면접 부스 v1.6.1 — AI 피드백에 말하기 지표가 빠지던 버그 고침 (2026-10-14)

기준: GitHub main `8b44fd0` (10/17)의 booth.html — `5ee68ef` 이후 booth.html 은 안 바뀜 (유형 4묶음 `3eb1eb4`·카드 표시 `62fcbb3` 포함). 바뀐 것은 **booth.html 한 줄**뿐.

## 무엇이 문제였나
- AI 로 보내는 문항 정보(`aiItem()`)에서 말하기 지표 `m`(말 속도·3초 넘는 멈춤·첫 마디)이 앞줄 **주석 뒤에 붙어 있어** 실제로는 보내지지 않았음
- 그래서 AI 피드백 Apps Script(`booth-ai/Code.gs` 의 `metricText_`)는 지표가 없는 것으로 보고 "3초 넘게 멈춤 0번" 처럼 적었고, AI 피드백이 **사실과 다르게 칭찬할 수 있었음** (AI 꼬리질문 요청도 같음)
- 고친 뒤: `m: { cpm, pauses, firstSec }` 가 꼬리질문 요청과 피드백 요청 모두에 실림 (저장된 기록의 값과 같음)

## 수정한 기존 파일
- `booth.html` — `aiItem()` 의 `m:` 을 주석 뒤에서 다음 줄로 옮김 (1줄 → 2줄)

## 새로 만든 파일
- 없음 (이 설명서만)

## 배포 순서
1. GitHub 에 `booth.html` 하나 올리기 (Add files via upload)
- 규칙(`firestore.rules`)·Apps Script(`booth-ai/Code.gs`)·SETUP.md 는 **바꿀 것 없음**
- `firebase-config.js` 는 ZIP 에 없음 (건드리지 않음)

## 직접 확인할 것 (부스 PC)
1. Ctrl+Shift+R 로 새로 불러오기 (사이트 데이터 지우기는 하지 않기 — 부스 PC 등록(boothKey)이 풀림). sw.js 고침(`8b44fd0`)이 올라가 있으므로 '인터넷에 연결되어 있지 않아요'도 이것으로 풀림
2. 시험 학생으로 한 번 면접 → 결과 화면 AI 피드백에서 말 속도·멈춤 이야기가 실제 답변과 맞는지
3. (선택) Firebase 콘솔 `sessions/{id}.aiReport` 가 `status: "done"`

## 되돌리는 방법
- 예전 booth.html(main `8b44fd0` 의 것 = `5ee68ef` 와 같음)을 다시 올리면 됨. 데이터 모양은 바뀌지 않았으므로 다른 파일과 상관없음

## 시험 (handoff/testenv, main 8b44fd0 + 이 고침)
- aitest 25 (새 확인 3개: 꼬리질문 요청 item.m · 피드백 요청 items[].m · 저장된 값과 같음 — **고치기 전 main 에서는 3개 모두 실패**)
- 부스 시험을 새 유형 기준(제시문·MMI 는 하나만, 기본 인성은 인성만)으로 고침: boothtest 69 · voicetest 136 · studtest 9 — 나머지 시험 결과는 handoff/cloud-session-log.md 39·40번

## 웹앱 작업에 넘길 요청
- 없음 (sessions 저장 칸·모양은 그대로 → booth-view.js 할 일 없음)
