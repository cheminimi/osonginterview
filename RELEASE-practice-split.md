# 연습 유형 나누기 — 기본 인성 / 제시문 · MMI (2026-10-06)

기준: GitHub main `62ee08d` (부스 예약 반영본)

## 올리는 방법
1. 백업: 저장소의 아래 7개 파일 내려받아 두기
2. 저장소 맨 첫 화면에 7개 파일 업로드 → 스튜디오 Ctrl+F5, 부스 PC 도 Ctrl+F5
3. 규칙(firestore.rules)·Apps Script·질문은행은 할 일 없음

## 수정한 기존 파일 (새 파일 없음)
- `common.js` — 추천 유형: 특별 트랙 제시문·MMI → 'pm'(제시문 · MMI), `pmKindOf()`(먼저 고를 쪽) 추가
- `student.html` — 연습 카드 '제시문 · MMI'(제시문 n · MMI n 표시) + '기본 인성'(인성만). 추천 이름 정리
- `interview.html` — mode=pm: 설정 화면 맨 위에서 제시문 면접 / MMI 중 하나 고르기, 문항 수·시간·시작 버튼이 고른 쪽에 맞게. 기록 이름 '제시문 면접'/'MMI 면접'. mode=personality 는 인성만. 예전 주소(mode=passage/mmi) 호환
- `booth.html` — 유형 카드 4묶음: 내 생기부 · 학생부 공통 · 제시문 · MMI(안에서 하나만) · 기본 인성. 말로 둘 다 말하면 먼저 말한 쪽. MMI 질문은 '기본 인성'에서 빠지고 MMI 쪽으로
- `booth-view.js` — 부스 기록 보기의 유형 이름에 'MMI 면접' 추가, '기본 인성'
- `style.css` — 끝에 연습 카드의 '제시문 n · MMI n' 표시 스타일만
- `SETUP.md` — 9-1 부스 면접 유형 문장 수정, '9-3. 연습 유형 나누기' 추가

## 확인한 것 (작업 세션)
- 문법 검사: common.js · booth-view.js · student.html · interview.html · booth.html 스크립트
- 연습 설정 화면(가짜 데이터) 10가지 통과: 기본은 제시문, MMI 로 바꾸면 문항 수·시간·버튼 바뀜, 특별 트랙 MMI 면 MMI + '내 트랙', MMI 질문이 없으면 제시문 고정·MMI 못 누름, 예전 주소 mode=passage/mmi, 기본 인성은 인성 질문만·고르기 칸 없음, 390px 가로 넘침 없음
- 부스 말 알아듣기 10가지: 제시문 / MMI / 엠엠아이 / 제시문이랑 MMI → 제시문 / MMI랑 제시문 → MMI / 인성 / 생기부랑 인성 / 전부 / 추천
- 못 한 것: 실제 Firebase·부스 PC 에서 유형 카드 화면 확인, 로컬 시험(boothtest·studtest 등) — 부스 유형 고르기 시험은 낡았을 수 있음(기본 인성·MMI → 나뉨)
