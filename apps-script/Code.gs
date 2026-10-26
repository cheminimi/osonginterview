/**
 * 면접 스튜디오 ⇄ 구글 시트 쌍방 동기화
 *
 * 설치 위치: '2026. 대입 면접 대비 프로그램 수요조사' 스프레드시트 → [확장 프로그램] → [Apps Script]
 * 설치 순서는 SETUP.md '3. 시트 쌍방 연동' 참고. 요약:
 *   1) 아래 CONFIG 에 Firebase apiKey / projectId 입력 → 저장
 *   2) 시트 새로고침 → 상단 메뉴 [면접 스튜디오] → ① 연동 탭 만들기
 *   3) [배포] → 새 배포 → 웹 앱 / 실행: 나 / 액세스: 모든 사용자 → URL 복사
 *   4) 메뉴 ② 앱 연결 설정 (앱에서 만든 동기화 계정 입력) → 표시된 토큰과 URL을 앱 관리 탭에 입력
 *   5) 메뉴 ③ 자동 동기화 켜기
 *   6) (선택) 메뉴 ④ 기존 탭 날짜를 연동 탭과 연결
 *
 * 동기화 규칙
 *   - 기준 데이터: '앱연동_학생'(트랙·배정·시트 링크), '앱연동_면접일'(대학별 면접일), 통합 플랫폼의 '모의 면접 기록'
 *   - 시트에서 고치면 수 초 안에 앱에 반영 (편집 트리거) + 30분마다 전체 대조(07~22시)
 *   - 앱에서 고치면 앱이 즉시 동기화를 요청 → 시트에 반영 (실패해도 정기 대조 때 반영)
 *   - 양쪽이 같은 행을 둘 다 고쳤으면 나중에 고친 쪽이 이김
 *   - 삭제: 면접일 행은 어느 쪽에서 지워도 양쪽에서 삭제 / 학생은 삭제하지 않음 / 모의 면접 기록은 앱에서만 삭제
 *   - 모의면접 일정(앱에서 신청·수락): 변경 로그 → '면접 기록' 탭(계속 쌓임), 현재 일정 → '면접 일정표' 탭,
 *     확정되면 '모의 면접 기록'에 예정 행 자동 추가 (앱 → 시트 한 방향)
 */

const SCRIPT_VERSION = 'v15 (2026-10-26)';   // 동기화 결과창에 표시됩니다

// ===================== 설정 (직접 입력) =====================
const CONFIG = {
  FIREBASE_API_KEY: 'YOUR_API_KEY',          // firebase-config.js 의 apiKey
  FIREBASE_PROJECT_ID: 'YOUR_PROJECT',       // firebase-config.js 의 projectId
  PLATFORM_SHEET_ID: '1ZxuH-z5Wk4H9chQhYb9g1KWzLI-enpiYqz_Cn5rdOmk',  // '2026. 대입 면접 대비 통합 플랫폼'
  LINKS_SHEET_ID: '1jHnfCQLg1ItltsGzmWaBzLmfvYptuwnjtqnb-Hu6QuY'      // '[관리용] 면접 준비 학생별 링크'
};

const TAB = {
  STUDENTS: '앱연동_학생',
  INTERVIEWS: '앱연동_면접일',
  STATE: '_동기화상태',
  LOG: '_동기화기록',
  ASSIGN: '1. 3회 지도 배정안',
  SURVEY: '설문지 응답 시트1',
  CALENDAR: '5. 면접 달력',
  MEETINGS: '모의 면접 기록',  // 통합 플랫폼 파일 안
  REVIEWS: '면접 후기',         // 학생이 쓴 실제 대학 면접 후기 (통합 플랫폼 파일 안 · 앱 → 시트 한 방향)
  BOOK_LOG: '면접 기록',        // 모의면접 일정 변경 로그 (이 파일)
  BOOK_TABLE: '면접 일정표'     // 현재 잡혀 있는 모의면접 일정 (이 파일)
};
const BOOK_LOG_HEAD = ['기록 시각', '행동', '한 사람', '상태', '차수', '학반', '학번', '이름', '담당교사', '날짜', '시간', '칸', '장소', '메시지', '예약ID'];
const BOOK_TABLE_HEAD = ['날짜', '요일', '시간', '칸', '차수', '학반', '학번', '이름', '담당교사', '장소', '상태', '수락 대기', '예약ID'];
const BOOK_STATUS = { requested: '요청 중', confirmed: '확정', cancelled: '취소', rejected: '거절' };
const BOOK_STAGE = { 1: '1차 담임', 2: '2차 교과', 3: '3차 모의면접' };

const STUDENT_COLS = [
  ['학번', 'studentNo'], ['이름', 'name'], ['반', 'cls'], ['우선도', 'priority'],
  ['기본 트랙', 'track'], ['특별 트랙', 'special'],
  ['1차 담임', 's1'], ['2차 교과', 's2'], ['3차 1위원', 's3a'], ['3차 2위원', 's3b'],
  ['준비 시트', 'sheetUrl'], ['최초 면접일', '_first'], ['다음 면접일', '_next'],
  ['수정 시각', '_stamp'], ['수정자', '_by']
];
const INTERVIEW_COLS = [
  ['학번', 'studentNo'], ['이름', 'name'], ['대학', 'univ'], ['학과', 'dept'], ['전형', 'admission'],
  ['면접 유형', 'format'], ['면접일', 'date'], ['1차 발표일', 'firstAnnounce'], ['수정 시각', '_stamp'], ['수정자', '_by'], ['행ID', 'id']
];
// (v14) '1차 발표일' 칸: 'YYYY-MM-DD' · '없음'(1단계 없이 면접) · 빈칸. 시트에 칸이 없으면 면접일 바로 오른쪽에 끼워 넣는다 (기존 행 보존)
//   학생이 앱에서 누르는 발표 결과(announceResult · announceAt)는 앱 전용 — 시트와 주고받지 않는다
// (v13) 면접 절차 및 진행 방식 · 받은 질문과 실제 답변(Q/A) · 기타 유의사항. 머리행이 다르면 다음 동기화 때 통째로 다시 쓴다
const REVIEW_HEAD = ['학년도', '면접일', '학번', '이름', '학반', '대학', '학과', '전형', '면접 유형',
  '면접 절차 및 진행 방식', '받은 질문과 실제 답변', '기타 유의사항', '도움된 것', '아쉬웠던 것', '분위기', '난이도', '작성 시각', '기록ID'];

const MEETING_COLS = [
  ['학반', 'cls'], ['학번', 'studentNo'], ['이름', 'name'], ['면접 유형', 'type'],
  ['담당교사', 'teachers'], ['실시일', 'date'], ['회차', 'round'], ['기록ID', 'id']
];
const STUDENT_SYNC = ['name', 'cls', 'priority', 'track', 'special', 's1', 's2', 's3a', 's3b', 'sheetUrl'];
const INTERVIEW_SYNC = ['studentNo', 'name', 'univ', 'dept', 'admission', 'format', 'date', 'firstAnnounce'];
// 시트 → 앱으로 쓸 때 고치는 칸만 (updateMask) — 학생 발표 결과 등 앱 전용 칸을 지우지 않게 (v13 까지는 문서를 통째로 덮어씀)
const INTERVIEW_MASK = INTERVIEW_SYNC.concat(['updatedAt', 'updatedBy']);
const MEETING_SYNC = ['studentNo', 'type', 'teachers', 'date'];

// ===================== 메뉴 =====================
function onOpen() {
  SpreadsheetApp.getUi().createMenu('면접 스튜디오')
    .addItem('① 연동 탭 만들기', 'menuBuildTabs')
    .addItem('② 앱 연결 설정', 'menuSetupConnection')
    .addItem('③ 자동 동기화 켜기', 'menuInstallTriggers')
    .addItem('④ 기존 탭 날짜를 연동 탭과 연결', 'menuLinkExistingTabs')
    .addSeparator()
    .addItem('지금 동기화', 'menuSyncNow')
    .addItem('면접 달력 다시 만들기', 'rebuildCalendar')
    .addItem('지금 백업하기 (구글 드라이브)', 'menuBackupNow')
    .addSeparator()
    .addItem('알림 보내기 설정', 'menuSetupPush')
    .addItem('지금 알림 보내기', 'menuPushNow')
    .addToUi();
}

function menuBuildTabs() {
  const ui = SpreadsheetApp.getUi();
  const r = buildLinkTabs_();
  ui.alert('연동 탭', `학생 ${r.students}명, 면접일 ${r.interviews}건으로 만들었습니다.` +
    (r.skipped ? `\n(이미 있던 탭은 건드리지 않았습니다: ${r.skipped})` : ''), ui.ButtonSet.OK);
}

function menuSetupConnection() {
  const ui = SpreadsheetApp.getUi();
  const props = PropertiesService.getScriptProperties();
  if (CONFIG.FIREBASE_API_KEY.indexOf('YOUR_') === 0) { ui.alert('Apps Script 코드 맨 위 CONFIG 에 Firebase apiKey 와 projectId 를 먼저 입력하세요.'); return; }
  const e = ui.prompt('동기화 계정', '앱 [관리 → 시트 동기화]에서 만든 동기화 계정의 이메일', ui.ButtonSet.OK_CANCEL);
  if (e.getSelectedButton() !== ui.Button.OK) return;
  const p = ui.prompt('동기화 계정', '비밀번호', ui.ButtonSet.OK_CANCEL);
  if (p.getSelectedButton() !== ui.Button.OK) return;
  props.setProperty('SYNC_EMAIL', e.getResponseText().trim());
  props.setProperty('SYNC_PASSWORD', p.getResponseText());
  CacheService.getScriptCache().remove('ID_TOKEN');
  try { fbToken_(); } catch (err) { ui.alert('Firebase 로그인 실패: ' + err.message); return; }
  let token = props.getProperty('TOKEN');
  if (!token) { token = Utilities.getUuid().replace(/-/g, ''); props.setProperty('TOKEN', token); }
  ui.alert('연결 성공', '앱 [관리 → 시트 동기화]에 아래 토큰을 입력하세요.\n\n' + token +
    '\n\n웹 앱 URL은 [배포 → 배포 관리]에서 복사합니다.', ui.ButtonSet.OK);
}

function menuInstallTriggers() {
  ScriptApp.getProjectTriggers().forEach(function (t) { ScriptApp.deleteTrigger(t); });
  ScriptApp.newTrigger('onSurveyEdit').forSpreadsheet(surveySS_()).onEdit().create();
  ScriptApp.newTrigger('onPlatformEdit').forSpreadsheet(CONFIG.PLATFORM_SHEET_ID).onEdit().create();
  ScriptApp.newTrigger('timedSync').timeBased().everyMinutes(30).create();
  ScriptApp.newTrigger('weeklyBackup').timeBased().onWeekDay(ScriptApp.WeekDay.SUNDAY).atHour(6).create();
  const r = syncAll_('트리거 설치');
  SpreadsheetApp.getUi().alert('자동 동기화를 켰습니다. (매주 일요일 새벽 자동 백업 포함)\n' + summary_(r));
}

function menuSyncNow() {
  const r = syncAll_('수동');
  SpreadsheetApp.getUi().alert(summary_(r));
}

function menuLinkExistingTabs() {
  const ui = SpreadsheetApp.getUi();
  const ok = ui.alert('기존 탭 연결',
    '배정안·운영 일정·운영 명단·편성표·담당교사 배정안·교사별 담당 학생 탭의 면접일(과 배정) 칸을\n' +
    "'앱연동' 탭을 참조하는 수식으로 바꿉니다. 먼저 이 파일 전체의 백업 사본을 드라이브에 만듭니다.\n계속할까요?",
    ui.ButtonSet.YES_NO);
  if (ok !== ui.Button.YES) return;
  const r = linkExistingTabs_();
  ui.alert('완료', r.join('\n'), ui.ButtonSet.OK);
}

// ===================== 트리거 =====================
function onSurveyEdit(e) {
  const name = e.range.getSheet().getName();
  if (name !== TAB.STUDENTS && name !== TAB.INTERVIEWS) return;
  stampRows_(e.range, e.user && e.user.getEmail ? e.user.getEmail() : '');
  const ok = runLocked_(function () {
    const kinds = name === TAB.STUDENTS ? ['students'] : ['interviews'];
    if (syncKinds_(kinds, '시트 편집').errors.length) markDirty_();
  });
  if (!ok) markDirty_();
}
function onPlatformEdit(e) {
  if (e.range.getSheet().getName() !== TAB.MEETINGS) return;
  const ok = runLocked_(function () { if (syncKinds_(['meetings'], '시트 편집').errors.length) markDirty_(); });
  if (!ok) markDirty_();
}
// 시트 편집이 바로 반영되지 못했으면 표시 → 다음 정기 대조 때 전체 대조
function markDirty_() { PropertiesService.getScriptProperties().setProperty('SHEET_DIRTY', '1'); }
// 정기 대조: 30분마다, 밤(22시~7시)에는 쉼.
// 무료 읽기 한도를 아끼려고, 앱에서 바뀐 목록이 없으면(meta/versions 1건만 읽고) 일정 로그만 옮긴다.
// 하루 첫 대조, 시트 편집 반영 실패가 있었을 때는 전체를 대조한다.
function timedSync() {
  const tz = Session.getScriptTimeZone();
  const h = Number(Utilities.formatDate(new Date(), tz, 'H'));
  if (h < 7 || h >= 22) return;
  runLocked_(function () {
    const props = PropertiesService.getScriptProperties();
    const today = Utilities.formatDate(new Date(), tz, 'yyyy-MM-dd');
    let meta = null;
    try { meta = fsGet_('meta/versions') || {}; } catch (err) { meta = null; }
    const seen = JSON.parse(props.getProperty('SEEN_META') || '{}');
    const full = !meta || props.getProperty('SHEET_DIRTY') === '1' || props.getProperty('LAST_FULL_DAY') !== today;
    let r;
    if (full) {
      r = syncAll_('정기 대조 (전체)');
      if (!r.errors.length) { props.setProperty('LAST_FULL_DAY', today); props.deleteProperty('SHEET_DIRTY'); }
    } else {
      const changed = ['students', 'interviews', 'meetings'].filter(function (k) { return (meta[k] || 0) !== (seen[k] || 0); });
      // 후기는 학생이 쓰므로 meta 표시가 남지 않는다 → 매번 '바뀐 것만' 가볍게 확인한다
      r = syncKinds_(changed.concat(['bookings', 'reviews']), '정기 대조');
    }
    if (meta && !r.errors.length) props.setProperty('SEEN_META', JSON.stringify({ students: meta.students || 0, interviews: meta.interviews || 0, meetings: meta.meetings || 0 }));
    try { notifyTick_(false); } catch (err) { /* 알림 실패가 동기화를 막지 않게 */ }
  });
}

// ===================== 웹 앱 (앱 → 시트) =====================
function doGet(e) {
  const p = (e && e.parameter) || {};
  if (!checkToken_(p.token)) return json_({ ok: false, error: '토큰이 맞지 않습니다.' });
  try {
    const ss = surveySS_();
    const s = ss.getSheetByName(TAB.STUDENTS), i = ss.getSheetByName(TAB.INTERVIEWS);
    const m = getMeetingSheet_();
    return json_({
      ok: true, sheet: ss.getName(),
      students: s ? Math.max(0, s.getLastRow() - 1) : null,
      interviews: i ? Math.max(0, i.getLastRow() - 1) : null,
      meetingsSheet: !!m,
      firebase: !!PropertiesService.getScriptProperties().getProperty('SYNC_EMAIL'),
      triggers: ScriptApp.getProjectTriggers().length
    });
  } catch (err) { return json_({ ok: false, error: String(err.message || err) }); }
}

function doPost(e) {
  let body;
  try { body = JSON.parse(e.postData.contents); } catch (err) { return json_({ ok: false, error: '요청 형식 오류' }); }
  if (body.action === 'backup') {
    if (!checkToken_(body.token)) return json_({ ok: false, error: '토큰이 맞지 않습니다.' });
    try { return json_({ ok: true, result: weeklyBackup() }); } catch (err) { return json_({ ok: false, error: String(err.message || err) }); }
  }
  // 모의면접 일정 로그 옮기기는 학생 화면에서도 요청하므로 토큰 없이 허용 (앱 데이터를 읽어 시트에 적기만 함)
  const bookingsOnly = Array.isArray(body.kinds) && body.kinds.length === 1 && body.kinds[0] === 'bookings';
  if (!bookingsOnly && !checkToken_(body.token)) return json_({ ok: false, error: '토큰이 맞지 않습니다.' });
  const kinds = (body.kinds || ['students', 'interviews', 'meetings', 'bookings', 'reviews']).filter(function (k) { return ['students', 'interviews', 'bookings', 'meetings', 'reviews'].indexOf(k) >= 0; });
  let result;
  const locked = runLocked_(function () { result = syncKinds_(kinds, '앱 요청'); });
  if (!locked) return json_({ ok: false, error: '다른 동기화가 진행 중입니다. 잠시 후 자동 반영됩니다.' });
  return json_({ ok: !result.errors.length, result: result, error: result.errors.join(' / ') });
}

// ===================== 동기화 본체 =====================
function syncAll_(reason) { return syncKinds_(['students', 'interviews', 'bookings', 'meetings', 'reviews'], reason); }

let LIST_CACHE_ = {};
function fsListCached_(c) { if (!LIST_CACHE_[c]) LIST_CACHE_[c] = fsList_(c); return LIST_CACHE_[c]; }

function syncKinds_(kinds, reason) {
  LIST_CACHE_ = {};
  // 일정(bookings)이 모의 면접 기록을 바꾸면 그 뒤에 모의 면접 기록 동기화도 돈다
  kinds = ['students', 'interviews', 'bookings', 'meetings', 'reviews'].filter(function (k) { return kinds.indexOf(k) >= 0; });
  const out = { pushed: 0, pulled: 0, created: 0, deleted: 0, errors: [], kinds: kinds };
  for (let i = 0; i < kinds.length; i++) {  // forEach 는 도중에 추가된 'meetings' 를 돌지 않음
    const k = kinds[i];
    try {
      const r = k === 'students' ? mergeStudents_() : k === 'interviews' ? mergeInterviews_() : k === 'bookings' ? syncBookings_()
        : k === 'reviews' ? syncReviews_(reason === '정기 대조 (전체)' || reason === '전체 대조') : mergeMeetings_();
      if (k === 'bookings' && r.meetingsTouched && kinds.indexOf('meetings') < 0) kinds.push('meetings');
      out.pushed += r.pushed; out.pulled += r.pulled; out.created += r.created; out.deleted += r.deleted;
      if (k === 'interviews' && (r.pushed + r.pulled + r.created + r.deleted) > 0) {
        try { rebuildCalendar(); } catch (err) { out.errors.push('달력: ' + err.message); }
      }
    } catch (err) {
      out.errors.push(k + ': ' + (err.message || err));
    }
  }
  log_(reason, out);
  return out;
}

/**
 * 3방향 병합.
 *  rows : 시트 행 [{id, rowNum, data, stamp}]  (id 없으면 새 행)
 *  docs : 앱 문서 {id: {data, at}}
 *  state: 마지막 동기화 때의 {id: {hash, at}}
 *  handlers: push(row) / pull(doc,row|null) / deleteDoc(id) / deleteRow(row) / newId(row) / onDocOnlyInState / onRowOnlyInState
 */
function merge_(kind, rows, docs, fields, h) {
  const state = readState_(kind);
  const now = Date.now();
  const stateN = Object.keys(state).length;
  // 안전장치: 한쪽이 통째로 비어 보이면(연결 오류·탭 초기화 등) 대량 삭제를 막고 멈춘다
  if (stateN > 5 && Object.keys(docs).length === 0) throw new Error('앱 데이터가 비어 있어 ' + kind + ' 동기화를 멈췄습니다. Firebase 설정을 확인하세요.');
  if (stateN > 5 && rows.length === 0) throw new Error("시트 '" + kind + "' 표가 비어 있어 동기화를 멈췄습니다.");
  const res = { pushed: 0, pulled: 0, created: 0, deleted: 0 };
  const seen = {};
  const rowDeletes = [];
  const newState = {};

  rows.forEach(function (row) {
    if (!row.id) { row.id = h.newId(row); row.isNew = true; }
    if (seen[row.id]) { row.id = h.newId(row); row.isNew = true; }  // 행 복사로 ID가 겹친 경우
    seen[row.id] = true;
    const hash = hash_(pick_(row.data, fields));
    const st = state[row.id];
    const doc = docs[row.id];
    if (doc) {
      const docHash = hash_(pick_(doc.data, fields));
      const sheetChanged = !st || st.hash !== hash;
      const appChanged = !st || doc.at > st.at;
      if (hash === docHash) { newState[row.id] = { hash: hash, at: Math.max(doc.at, now) }; return; }
      if (sheetChanged && (!appChanged || (row.stamp || now) >= doc.at)) {
        h.push(row); res.pushed++; newState[row.id] = { hash: hash, at: now };
      } else {
        h.pull(doc, row); res.pulled++; newState[row.id] = { hash: docHash, at: now };
      }
    } else if (st && !row.isNew) {
      // 앱에서 지워진 행
      if (h.rowOnlyInState(row) === 'keep') { h.push(row); res.pushed++; newState[row.id] = { hash: hash, at: now }; }
      else { rowDeletes.push(row); res.deleted++; }
    } else {
      h.push(row); res.created++; newState[row.id] = { hash: hash, at: now };
    }
  });

  Object.keys(docs).forEach(function (id) {
    if (seen[id]) return;
    const doc = docs[id];
    const docHash = hash_(pick_(doc.data, fields));
    if (state[id]) {
      // 시트에서 지워진 행
      const act = h.docOnlyInState(doc);
      if (act === 'delete') { h.deleteDoc(id); res.deleted++; }
      else if (act === 'restore') { h.pull(doc, null); res.pulled++; newState[id] = { hash: docHash, at: now }; }
      else if (act === 'ignore') { newState[id] = { hash: docHash, at: now, ignored: true }; }
    } else {
      if (h.docOnlyNew(doc) === 'ignore') return;
      h.pull(doc, null); res.pulled++; newState[id] = { hash: docHash, at: now };
    }
  });

  h.flush(rowDeletes);
  writeState_(kind, newState);
  return res;
}

// ---------- 학생 ----------
function mergeStudents_() {
  const sh = getOrThrow_(surveySS_(), TAB.STUDENTS);
  const table = readTable_(sh, STUDENT_COLS);
  fixClsColumn_(sh, table);
  table.reload();
  // 앱 관리에서 '삭제'한 학생(removed 표시): 시트 행을 지우고 다시 올리지 않는다. 기록은 앱에 그대로 남는다.
  const removed = {};
  fsListCached_('students').forEach(function (d) { if (d.fields.removed) removed[d.id] = true; });
  const removedRows = [];
  const rows = table.rows.filter(function (r) { return r.data.studentNo; }).map(function (r) {
    r.id = String(r.data.studentNo); return r;
  }).filter(function (r) {
    if (removed[r.id]) { removedRows.push(r); return false; }
    return true;
  });
  const docs = {}, raw = {};
  fsListCached_('students').forEach(function (d) {
    if (removed[d.id]) return;   // 되살리면 removed 가 없어져 새 학생처럼 시트에 한 줄 추가된다
    const f = d.fields;
    raw[d.id] = f;
    docs[d.id] = {
      id: d.id, at: Number(f.syncFieldsAt || 0),
      data: {
        studentNo: d.id, name: f.name || '', cls: clsOf_(f.cls, d.id), priority: f.priority || '', track: f.track || '',
        special: f.special || '', s1: (f.assign || {}).s1 || '', s2: (f.assign || {}).s2 || '',
        s3a: (f.assign || {}).s3a || '', s3b: (f.assign || {}).s3b || '', sheetUrl: f.sheetUrl || ''
      }
    };
  });
  // 앱 학생 정보의 학반도 같은 이유로 날짜가 되어 있을 수 있다
  const clsFixes = [];
  Object.keys(raw).forEach(function (no) {
    const fixed = clsOf_(raw[no].cls, no);
    if (fixed && String(raw[no].cls || '') !== fixed) clsFixes.push(fsPatchReq_('students/' + no, { cls: fixed }, ['cls']));
  });
  if (clsFixes.length) { fsBatch_(clsFixes); Logger.log('앱 학생 ' + clsFixes.length + '명의 학반을 바로잡았습니다.'); }

  const firstByNo = firstDates_();
  const writes = [], appends = [];
  const res = merge_('students', rows, docs, STUDENT_SYNC, {
    newId: function (row) { return String(row.data.studentNo); },
    push: function (row) {
      const d = row.data;
      const no = String(d.studentNo);
      writes.push(fsPatchReq_('students/' + no, {
        studentNo: no, name: d.name, cls: clsOf_(d.cls, no), priority: d.priority, track: d.track, special: d.special,
        assign: { s1: d.s1, s2: d.s2, s3a: d.s3a, s3b: d.s3b }, sheetUrl: d.sheetUrl,
        firstInterview: firstByNo[no] || '', syncFieldsAt: row.stamp || Date.now(), syncedBy: row.by || '시트'
      }, ['studentNo', 'name', 'cls', 'priority', 'track', 'special', 'assign', 'sheetUrl', 'firstInterview', 'syncFieldsAt', 'syncedBy']));
    },
    pull: function (doc, row) {
      const vals = doc.data;
      if (row) table.setRow(row.rowNum, vals, '앱');
      else appends.push(vals);
    },
    rowOnlyInState: function () { return 'keep'; },        // 앱 문서가 사라진 행(콘솔에서 지움 등)은 다시 올림. 앱 '삭제'는 위 removed 로 처리
    docOnlyInState: function () { return 'ignore'; },      // 시트에서 행을 지워도 앱 학생은 유지
    docOnlyNew: function () { return 'append'; },
    deleteDoc: function () {},
    flush: function () {}
  });
  if (removedRows.length) { table.deleteRows(removedRows.map(function (r) { return r.rowNum; })); res.deleted += removedRows.length; }
  appends.forEach(function (v) { table.appendRow(v, '앱'); });
  table.ensureFormulas();
  fsBatch_(writes);
  // 수요조사 응답의 희망 교과·준비 정도·도움 필요·전달 메모 (시트 → 앱 한 방향, 바뀐 것만)
  const survey = readSurvey_(surveySS_());
  const extraWrites = [];
  Object.keys(survey).forEach(function (no) {
    const f = raw[no] || (writes.some(function (w) { return w.url.indexOf('/students/' + no + '?') >= 0; }) ? {} : null);
    if (!f) return;
    const x = survey[no].extras;
    const cur = { subject1: f.subject1 || '', subject2: f.subject2 || '', readiness: f.readiness || '', needs: f.needs || [], memos: f.memos || [] };
    if (JSON.stringify(cur) !== JSON.stringify(x)) extraWrites.push(fsPatchReq_('students/' + no, x, ['subject1', 'subject2', 'readiness', 'needs', 'memos']));
  });
  fsBatch_(extraWrites);
  return res;
}

// ---------- 면접일 ----------
function mergeInterviews_() {
  const sh = getOrThrow_(surveySS_(), TAB.INTERVIEWS);
  const table = readTable_(sh, INTERVIEW_COLS);
  const rows = table.rows.filter(function (r) { return r.data.studentNo || r.data.univ || r.data.date; });
  const docs = {};
  fsList_('interviews').forEach(function (d) {
    const f = d.fields;
    docs[d.id] = { id: d.id, at: Number(f.updatedAt || 0), by: f.updatedBy || '', data: {
      id: d.id, studentNo: String(f.studentNo || ''), name: f.name || '', univ: f.univ || '', dept: f.dept || '',
      admission: f.admission || '', format: f.format || '', date: f.date || '', firstAnnounce: f.firstAnnounce || ''
    } };
  });
  const writes = [];
  const touched = {};
  const res = merge_('interviews', rows, docs, INTERVIEW_SYNC, {
    newId: function (row) {
      const id = 'iv_' + Utilities.getUuid().replace(/-/g, '').slice(0, 16);
      table.setCell(row.rowNum, 'id', id);
      return id;
    },
    push: function (row) {
      const d = row.data;
      touched[String(d.studentNo)] = true;
      writes.push(fsPatchReq_('interviews/' + row.id, {
        studentNo: String(d.studentNo), name: d.name, univ: d.univ, dept: d.dept, admission: d.admission,
        format: d.format, date: d.date, firstAnnounce: d.firstAnnounce || '', updatedAt: Date.now(), updatedBy: row.by || '시트'
      }, INTERVIEW_MASK));
    },
    pull: function (doc, row) {
      touched[doc.data.studentNo] = true;
      const by = doc.by === '학생' ? '학생' : '앱';     // (v14) 학생이 앱에서 1차 발표일을 바꿨으면 수정자 '학생'
      if (row) table.setRow(row.rowNum, doc.data, by); else table.appendRow(doc.data, by);
    },
    rowOnlyInState: function (row) { touched[String(row.data.studentNo)] = true; return 'delete'; },
    docOnlyInState: function (doc) { touched[doc.data.studentNo] = true; return 'delete'; },
    docOnlyNew: function () { return 'append'; },
    deleteDoc: function (id) { writes.push(fsDeleteReq_('interviews/' + id)); },
    flush: function (rowDeletes) { table.deleteRows(rowDeletes.map(function (r) { return r.rowNum; })); }
  });
  fsBatch_(writes);
  // 학생별 최초 면접일 갱신
  const first = firstDates_();
  const upd = Object.keys(touched).filter(Boolean).map(function (no) {
    return fsPatchReq_('students/' + no, { firstInterview: first[no] || '' }, ['firstInterview']);
  });
  fsBatch_(upd);
  return res;
}

// ---------- 모의면접 일정 (앱 → 시트: 면접 기록 · 면접 일정표 · 모의 면접 기록 예정 행) ----------
function syncBookings_() {
  const props = PropertiesService.getScriptProperties();
  const lastMs = Number(props.getProperty('BOOK_LOG_MS') || 0);
  const doneIds = JSON.parse(props.getProperty('BOOK_LOG_IDS') || '[]');
  const logs = fsQuery_('bookingLogs', 'atMs', 'GREATER_THAN_OR_EQUAL', lastMs, 500)
    .filter(function (d) { return doneIds.indexOf(d.id) < 0; })
    .map(function (d) { const f = d.fields; f.id = d.id; return f; })
    .sort(function (a, b) { return a.atMs - b.atMs; });
  const res = { pushed: 0, pulled: 0, created: 0, deleted: 0, meetingsTouched: false };
  if (!logs.length) return res;
  const ss = surveySS_();

  // 1) 면접 기록: 한 줄씩 계속 쌓기
  const logSh = ensureTab_(ss, TAB.BOOK_LOG, BOOK_LOG_HEAD);
  const lines = logs.map(function (l) {
    return [new Date(l.atMs), l.action || '', l.by || '', BOOK_STATUS[l.status] || l.status || '', BOOK_STAGE[l.stage] || l.stage || '',
      l.cls || '', toCell_('studentNo', l.studentNo || ''), l.studentName || '', (l.teachers || []).join(', '),
      parseDay_(l.date) || l.date || '', (l.start || '') + '–' + (l.end || ''), l.blockLabel || '', l.room || '', l.memo || '', l.bookingId || ''];
  });
  logSh.getRange(logSh.getLastRow() + 1, 1, lines.length, BOOK_LOG_HEAD.length).setValues(lines);
  logSh.getRange(2, 1, logSh.getLastRow() - 1, 1).setNumberFormat('yyyy. mm. dd HH:mm');
  res.pulled = lines.length;

  // 2) 면접 일정표: 예약별 마지막 상태로 갱신 (취소·거절은 뺌)
  const latest = {};
  logs.forEach(function (l) { latest[l.bookingId] = l; });
  const tSh = ensureTab_(ss, TAB.BOOK_TABLE, BOOK_TABLE_HEAD);
  const W = BOOK_TABLE_HEAD.length, idCol = W - 1;
  const oldN = Math.max(0, tSh.getLastRow() - 1);
  const keep = (oldN ? tSh.getRange(2, 1, oldN, W).getValues() : [])
    .filter(function (r) { return r[idCol] !== '' && !latest[String(r[idCol])]; });
  const WEEK = '일월화수목금토';
  Object.keys(latest).forEach(function (id) {
    const l = latest[id];
    if (l.status !== 'requested' && l.status !== 'confirmed') return;
    const d = parseDay_(l.date);
    keep.push([d || l.date, d ? WEEK.charAt(d.getDay()) : '', (l.start || '') + '–' + (l.end || ''), l.blockLabel || '', BOOK_STAGE[l.stage] || '',
      l.cls || '', toCell_('studentNo', l.studentNo || ''), l.studentName || '', (l.teachers || []).join(', '), l.room || '',
      BOOK_STATUS[l.status] || '', l.status === 'requested' ? (l.waiting || '') : '', id]);
  });
  keep.sort(function (a, b) {
    const da = a[0] instanceof Date ? a[0].getTime() : 0, db = b[0] instanceof Date ? b[0].getTime() : 0;
    return da - db || String(a[2]).localeCompare(String(b[2]));
  });
  if (oldN) tSh.getRange(2, 1, oldN, W).clearContent();
  if (keep.length) tSh.getRange(2, 1, keep.length, W).setValues(keep);
  if (keep.length) tSh.getRange(2, 1, keep.length, 1).setNumberFormat('yyyy. mm. dd');

  // 3) 확정 → '모의 면접 기록'에 예정 기록(meetings/bk_예약ID) / 확정이 풀리면 내용 없는 예정 기록 삭제
  const writes = [];
  Object.keys(latest).forEach(function (id) {
    const l = latest[id], path = 'meetings/bk_' + id;
    const cur = fsGet_(path);
    if (l.status === 'confirmed') {
      const base = { studentNo: String(l.studentNo), name: l.studentName || '', cls: l.cls || '', stage: Number(l.stage) || 4,
        teachers: l.teachers || [], date: l.date, bookingId: id, updatedAtMs: Date.now() };
      if (!cur) {
        base.studentUid = l.studentUid || ''; base.type = l.meetingType || '학생부 기반'; base.shared = false; base.planned = true;
        base.createdBy = '일정'; base.questions = ''; base.answerSummary = ''; base.good = ''; base.improve = ''; base.nextGoal = '';
        writes.push(fsPatchReq_(path, base, null)); res.created++;
      } else if (cur.planned === true && !hasRecord_(cur)
                 && (cur.date !== l.date || String(cur.teachers) !== String(l.teachers))) {
        // 아직 '기록 전'인 자리만 날짜·담당을 맞춘다. 선생님이 쓴 기록은 일정 변경으로 덮어쓰지 않는다
        writes.push(fsPatchReq_(path, base, Object.keys(base))); res.pushed++;
      }
    } else if (cur && cur.planned === true && !hasRecord_(cur)) {
      writes.push(fsDeleteReq_(path)); res.deleted++;   // 내용이 있으면 지우지 않는다
    }
  });
  fsBatch_(writes);
  res.meetingsTouched = writes.length > 0;

  const maxMs = logs[logs.length - 1].atMs;
  props.setProperty('BOOK_LOG_MS', String(maxMs));
  props.setProperty('BOOK_LOG_IDS', JSON.stringify(logs.filter(function (l) { return l.atMs === maxMs; }).map(function (l) { return l.id; })
    .concat(maxMs === lastMs ? doneIds : [])));
  return res;
}
// ---------- 대학 면접 후기 (앱 → 시트 한 방향) ----------
// 학생이 쓴 글이므로 시트에서 고친 것을 앱으로 되돌리지 않는다 (어느 쪽이 맞는지 다투지 않게).
// 평소에는 바뀐 것만(updatedAtMs) 받아 해당 줄만 고치고, 하루 첫 전체 대조 때는 통째로 다시 쓴다.
function syncReviews_(full) {
  const props = PropertiesService.getScriptProperties();
  const res = { pushed: 0, pulled: 0, created: 0, deleted: 0 };
  const ss = SpreadsheetApp.openById(CONFIG.PLATFORM_SHEET_ID);
  const sh = ensureTab_(ss, TAB.REVIEWS, REVIEW_HEAD);
  const W = REVIEW_HEAD.length, ID = W - 1;   // 마지막 칸이 기록ID
  // 머리행이 예전 판이면 새 머리행으로 바꾸고 통째로 다시 쓴다 (칸 위치가 달라져 줄 찾기를 할 수 없음)
  const head = sh.getRange(1, 1, 1, Math.max(W, sh.getLastColumn())).getValues()[0].map(String);
  if (head.slice(0, W).join('|') !== REVIEW_HEAD.join('|') || head.slice(W).some(function (v) { return v; })) {
    sh.getRange(1, 1, 1, head.length).clearContent();
    sh.getRange(1, 1, 1, W).setValues([REVIEW_HEAD]);
    styleHeader_(sh, W);
    if (sh.getLastRow() > 1 && head.length > W) sh.getRange(2, W + 1, sh.getLastRow() - 1, head.length - W).clearContent();
    full = true;
  }

  let docs;
  const lastMs = Number(props.getProperty('REVIEW_MS') || 0);
  if (full || !lastMs) {
    docs = fsList_('reviews');
  } else {
    docs = fsQuery_('reviews', 'updatedAtMs', 'GREATER_THAN', lastMs, 500);
  }
  if (!docs.length && !full) return res;

  const rows = docs.map(function (d) { return reviewRow_(d.id, d.fields); });
  let maxMs = lastMs;
  docs.forEach(function (d) { maxMs = Math.max(maxMs, Number(d.fields.updatedAtMs || 0)); });

  if (full || !lastMs) {
    // 통째로 다시 쓰기 (지워진 후기도 이때 시트에서 빠진다)
    rows.sort(function (a, b) { return String(b[1]).localeCompare(String(a[1])) || String(a[2]).localeCompare(String(b[2])); });
    const oldN = Math.max(0, sh.getLastRow() - 1);
    if (oldN) sh.getRange(2, 1, oldN, W).clearContent();
    if (rows.length) {
      sh.getRange(2, 1, rows.length, W).setValues(rows);
      sh.getRange(2, 2, rows.length, 1).setNumberFormat('yyyy. mm. dd');
    }
    res.pushed = rows.length;
  } else {
    // 바뀐 줄만 고치고, 없던 것은 아래에 붙인다
    const n = Math.max(0, sh.getLastRow() - 1);
    const ids = n ? sh.getRange(2, ID + 1, n, 1).getValues().map(function (r) { return String(r[0] || ''); }) : [];
    const add = [];
    rows.forEach(function (row) {
      const at = ids.indexOf(String(row[ID]));
      if (at >= 0) { sh.getRange(at + 2, 1, 1, W).setValues([row]); sh.getRange(at + 2, 2).setNumberFormat('yyyy. mm. dd'); res.pushed++; }
      else { add.push(row); }
    });
    if (add.length) {
      const start = sh.getLastRow() + 1;
      sh.getRange(start, 1, add.length, W).setValues(add);
      sh.getRange(start, 2, add.length, 1).setNumberFormat('yyyy. mm. dd');
      res.created = add.length;
    }
  }
  SpreadsheetApp.flush();
  if (maxMs > lastMs) props.setProperty('REVIEW_MS', String(maxMs));
  return res;
}
function reviewRow_(id, f) {
  const clean = function (v) { return String(v == null ? '' : v).slice(0, 5000); };
  return [
    Number(f.year) || '', parseDay_(f.date) || f.date || '', String(f.studentNo || ''), f.name || '', f.cls || '',
    f.univ || '', f.dept || '', f.admission || '', f.format || '',
    clean(f.procedure), clean(reviewQaText_(f)), clean(f.notes), clean(f.helped), clean(f.regret),
    Number(f.mood) || '', Number(f.difficulty) || '',
    f.updatedAtMs ? new Date(Number(f.updatedAtMs)) : '', id
  ];
}

// 받은 질문과 실제 답변을 한 칸 글로. 예전 양식(받은 질문 글)은 뒤에 그대로 붙인다
function reviewQaText_(f) {
  const lines = (Array.isArray(f.qa) ? f.qa : []).filter(function (x) { return x && (x.q || x.a); })
    .map(function (x, i) { return 'Q' + (i + 1) + '. ' + (x.q || '') + '\nA. ' + (x.a || '(적지 않음)'); });
  if (f.questions) lines.push(String(f.questions).trim());
  return lines.join('\n');
}

// ===================== 휴대폰 알림 (웹 푸시 · FCM) =====================
// 보내는 쪽은 여기입니다. 서비스 계정 키는 스크립트 속성(FCM_SA)에만 두고 코드에 적지 않습니다.
// 알림 내용에는 학생 이름을 그대로 넣지 않습니다 (잠금화면에 남이 볼 수 있음).
const PUSH_QUIET_FROM = 22, PUSH_QUIET_TO = 7;   // 밤에는 보내지 않고 아침에 모아서

function menuSetupPush() {
  const ui = SpreadsheetApp.getUi();
  const r = ui.prompt('알림 보내기 설정',
    'Firebase 콘솔 → 프로젝트 설정 → 서비스 계정 → 새 비공개 키 생성으로 받은\n' +
    'JSON 파일의 내용을 통째로 붙여넣으세요.\n\n(이 키는 이 스크립트 안에만 저장되고 시트에는 남지 않습니다)', ui.ButtonSet.OK_CANCEL);
  if (r.getSelectedButton() !== ui.Button.OK) return;
  const txt = String(r.getResponseText() || '').trim();
  if (!txt) { PropertiesService.getScriptProperties().deleteProperty('FCM_SA'); ui.alert('알림 보내기를 껐습니다.'); return; }
  let sa;
  try { sa = JSON.parse(txt); } catch (e) { ui.alert('JSON 형식이 아닙니다. 파일 내용을 그대로 붙여넣어 주세요.'); return; }
  if (!sa.client_email || !sa.private_key) { ui.alert('client_email 과 private_key 가 있는 서비스 계정 키가 아닙니다.'); return; }
  if (sa.project_id && sa.project_id !== CONFIG.FIREBASE_PROJECT_ID) {
    ui.alert('다른 프로젝트의 키입니다 (' + sa.project_id + '). 앱과 같은 프로젝트의 키를 넣어 주세요.'); return;
  }
  PropertiesService.getScriptProperties().setProperty('FCM_SA', JSON.stringify(sa));
  CacheService.getScriptCache().remove('FCM_TOKEN');
  try { fcmAccessToken_(); ui.alert('알림 보내기 설정을 마쳤습니다.'); }
  catch (e) { ui.alert('키는 저장했지만 확인에 실패했습니다:\n' + e.message); }
}
function menuPushNow() {
  const r = runLocked_(function () { const n = notifyTick_(true); SpreadsheetApp.getUi().alert('알림', '보낸 알림 ' + n.sent + '건 / 기기 ' + n.devices + '대' + (n.errors.length ? '\n오류: ' + n.errors.join('; ') : ''), SpreadsheetApp.getUi().ButtonSet.OK); });
  if (!r) SpreadsheetApp.getUi().alert('다른 작업이 돌고 있습니다. 잠시 뒤 다시 해 주세요.');
}
function pushReady_() { return !!PropertiesService.getScriptProperties().getProperty('FCM_SA'); }

// 서비스 계정으로 보내기 권한(액세스 토큰) 받기
function fcmAccessToken_() {
  const cache = CacheService.getScriptCache();
  const hit = cache.get('FCM_TOKEN');
  if (hit) return hit;
  const raw = PropertiesService.getScriptProperties().getProperty('FCM_SA');
  if (!raw) throw new Error('알림 보내기 설정이 안 되어 있습니다 (메뉴 → 알림 보내기 설정).');
  const sa = JSON.parse(raw);
  const now = Math.floor(Date.now() / 1000);
  const b64 = function (o) { return Utilities.base64EncodeWebSafe(JSON.stringify(o)).replace(/=+$/, ''); };
  const unsigned = b64({ alg: 'RS256', typ: 'JWT' }) + '.' + b64({
    iss: sa.client_email, scope: 'https://www.googleapis.com/auth/firebase.messaging',
    aud: 'https://oauth2.googleapis.com/token', exp: now + 3600, iat: now
  });
  const sig = Utilities.base64EncodeWebSafe(Utilities.computeRsaSha256Signature(unsigned, sa.private_key)).replace(/=+$/, '');
  const res = UrlFetchApp.fetch('https://oauth2.googleapis.com/token', {
    method: 'post', muteHttpExceptions: true,
    payload: { grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: unsigned + '.' + sig }
  });
  const d = JSON.parse(res.getContentText() || '{}');
  if (!d.access_token) throw new Error('알림 인증 실패: ' + (d.error_description || d.error || res.getResponseCode()));
  cache.put('FCM_TOKEN', d.access_token, 3000);
  return d.access_token;
}

// 기기 한 대에 보내기. 'gone' 이면 없어진 기기라 목록에서 지운다.
function fcmSendOne_(token, data) {
  const res = UrlFetchApp.fetch('https://fcm.googleapis.com/v1/projects/' + CONFIG.FIREBASE_PROJECT_ID + '/messages:send', {
    method: 'post', contentType: 'application/json', muteHttpExceptions: true,
    headers: { Authorization: 'Bearer ' + fcmAccessToken_() },
    payload: JSON.stringify({ message: {
      token: token,
      data: { title: String(data.title || ''), body: String(data.body || ''), url: String(data.url || 'student.html'), tag: String(data.tag || 'osong') },
      webpush: { headers: { Urgency: 'high', TTL: '86400' } }
    } })
  });
  const code = res.getResponseCode();
  if (code < 300) return 'ok';
  const t = res.getContentText() || '';
  if (code === 404 || /UNREGISTERED|NOT_FOUND|INVALID_ARGUMENT/.test(t)) return 'gone';
  return 'fail ' + code;
}

// 받는 사람의 기기 목록 (role: 'student' | 'staff', key: 학번 또는 교사ID)
function pushTokensOf_(role, key) {
  if (!key) return [];
  const list = fsQuery_('pushTokens', 'key', 'EQUAL', String(key), 100);
  return list.filter(function (d) { return d.fields.role === role; }).map(function (d) { return d.id; });
}
function dropToken_(token) { try { fsBatch_([fsDeleteReq_('pushTokens/' + token)]); } catch (e) {} }

function pushTo_(role, key, data, out) {
  const tokens = pushTokensOf_(role, key);
  tokens.forEach(function (t) {
    out.devices++;
    let r;
    try { r = fcmSendOne_(t, data); } catch (e) { out.errors.push(String(e.message || e).slice(0, 80)); return; }
    if (r === 'ok') out.sent++;
    else if (r === 'gone') { dropToken_(t); out.dropped++; }
    else out.errors.push(r);
  });
  if (tokens.length) pushLog_(role + ' ' + key, data.title, tokens.length);
}
function pushLog_(to, title, n) {
  try {
    const ss = surveySS_();
    let sh = ss.getSheetByName('_알림기록');
    if (!sh) { sh = ss.insertSheet('_알림기록'); sh.getRange(1, 1, 1, 4).setValues([['시각', '받는 사람', '내용', '기기 수']]); sh.hideSheet(); }
    sh.insertRowAfter(1);
    sh.getRange(2, 1, 1, 4).setValues([[new Date(), to, title, n]]);
    if (sh.getLastRow() > 300) sh.deleteRows(301, sh.getLastRow() - 300);
  } catch (e) {}
}

// 이름 가리기 (박아름 → 박○○). 잠금화면에 그대로 보이지 않게
function maskName_(n) {
  n = String(n || '');
  return n ? n.charAt(0) + Array(Math.max(1, n.length - 1) + 1).join('○') : '학생';
}
const STAGE_TXT_ = { 1: '1차 담임 면접', 2: '2차 교과 면접', 3: '3차 모의면접', 4: '추가 지도' };
function whenTxt_(l) {
  const d = parseDay_(l.date);
  const wd = d ? '일월화수목금토'.charAt(d.getDay()) : '';
  const day = d ? (d.getMonth() + 1) + '/' + d.getDate() + '(' + wd + ')' : String(l.date || '');
  return day + (l.blockLabel ? ' ' + l.blockLabel : '') + (l.start ? ' ' + l.start : '');
}
// 교사 이름 → 교사ID
let STAFF_BY_NAME_ = null;
function staffIdByName_(name) {
  if (!STAFF_BY_NAME_) {
    STAFF_BY_NAME_ = {};
    try { fsList_('staff').forEach(function (d) { if (d.fields.name) STAFF_BY_NAME_[d.fields.name] = d.id; }); } catch (e) {}
  }
  return STAFF_BY_NAME_[name] || '';
}

/**
 * 보낼 알림을 찾아 보낸다. 30분마다 도는 동기화에 얹혀 돈다.
 * force=true 면 밤이라도 보낸다 (메뉴에서 직접 누른 경우).
 */
function notifyTick_(force) {
  const out = { sent: 0, devices: 0, dropped: 0, errors: [] };
  if (!pushReady_()) return out;
  const tz = Session.getScriptTimeZone();
  const h = Number(Utilities.formatDate(new Date(), tz, 'H'));
  if (!force && (h >= PUSH_QUIET_FROM || h < PUSH_QUIET_TO)) return out;   // 밤에는 쌓아 두고 아침에
  STAFF_BY_NAME_ = null;
  const props = PropertiesService.getScriptProperties();

  // ① 일정 변화 (bookingLogs)
  try { notifyBookings_(props, out); } catch (e) { out.errors.push('일정: ' + (e.message || e)); }
  // ② 앱이 적어 둔 알림 (피드백 도착 등)
  try { notifyQueue_(out); } catch (e) { out.errors.push('대기열: ' + (e.message || e)); }
  // ③ 하루 한 번: 내일 면접 안내 (저녁) · 오늘 대학 면접 후기 (저녁) · 그때까지 안 쓴 어제 후기 다시 (아침)
  const today = Utilities.formatDate(new Date(), tz, 'yyyy-MM-dd');
  try {
    if (h >= 18 && props.getProperty('PUSH_EVE_DAY') !== today) { notifyTomorrow_(out); props.setProperty('PUSH_EVE_DAY', today); }
    if (h >= 18 && props.getProperty('PUSH_RV_DAY') !== today) { notifyReviewDue_(out, 0); props.setProperty('PUSH_RV_DAY', today); }
    if (h >= 8 && props.getProperty('PUSH_MORN_DAY') !== today) { notifyReviewDue_(out, 1); props.setProperty('PUSH_MORN_DAY', today); }
  } catch (e) { out.errors.push('예약 알림: ' + (e.message || e)); }
  // ④ (v14) 1차 발표일 아침 8시 · 대학 면접일 아침 7시 · 대학 면접 전날 저녁 6시 (학생, 하루 한 번)
  try {
    if (h >= 8 && props.getProperty('PUSH_ANN_DAY') !== today) { notifyAnnounceDay_(out, today); props.setProperty('PUSH_ANN_DAY', today); }
    if (h >= 7 && props.getProperty('PUSH_IVDAY_DAY') !== today) { notifyUnivDay_(out, today, false); props.setProperty('PUSH_IVDAY_DAY', today); }
    if (h >= 18 && props.getProperty('PUSH_IVEVE_DAY') !== today) { notifyUnivDay_(out, today, true); props.setProperty('PUSH_IVEVE_DAY', today); }
  } catch (e) { out.errors.push('발표·면접 알림: ' + (e.message || e)); }
  // ⑤ (v14) 학생이 1차 [합격]을 누르면 담당 선생님 전원에게 한 번 (정기 대조마다 확인)
  try { notifyPass_(out); } catch (e) { out.errors.push('합격 알림: ' + (e.message || e)); }
  return out;
}

// (v14) 오늘 1차 발표일인 학생에게 (잠금 화면에 대학 이름은 넣고 학생 이름은 넣지 않음)
function notifyAnnounceDay_(out, today) {
  fsQuery_('interviews', 'firstAnnounce', 'EQUAL', today, 300).forEach(function (x) {
    const iv = x.fields;
    pushTo_('student', iv.studentNo, {
      title: '오늘 ' + (iv.univ || '대학') + ' 1차 발표일이에요', body: '발표를 확인하고 앱에 결과를 알려 주세요',
      url: 'student.html', tag: 'ann_' + x.id
    }, out);
  });
}
// (v14) 대학 면접일 아침 (eve=false: 오늘 면접) · 전날 저녁 (eve=true: 내일 면접)
function notifyUnivDay_(out, today, eve) {
  let day = today;
  if (eve) { const d = new Date(); d.setDate(d.getDate() + 1); day = Utilities.formatDate(d, Session.getScriptTimeZone(), 'yyyy-MM-dd'); }
  fsQuery_('interviews', 'date', 'EQUAL', day, 300).forEach(function (x) {
    const iv = x.fields, u = iv.univ || '대학';
    if (iv.announceResult === 'fail') return;          // (v15) 1차 불합격한 대학 면접은 알리지 않음
    pushTo_('student', iv.studentNo, eve
      ? { title: '내일 ' + u + ' 면접이에요', body: '수험표·신분증·장소를 확인해 두세요', url: 'student.html', tag: 'ive_' + x.id }
      : { title: '오늘 ' + u + ' 면접이에요 💪', body: '준비한 답변 한 번만 훑어보고 가요', url: 'student.html', tag: 'ivd_' + x.id }, out);
  });
}
// (v14) 1차 합격 → 담당 선생님(1차 담임·2차 교과·3차 위원) 전원에게 한 번. 보낸 표시는 문서의 announceNotifiedAt (앱 전용 칸, 수정 시각은 그대로)
//   오래된 것을 몰아 보내지 않게 누른 지 3일 안의 것만. 불합격은 알림 없음
const PASS_ALERT_DAYS = 3;
function notifyPass_(out) {
  const since = Date.now() - PASS_ALERT_DAYS * 86400000;
  const list = fsQuery_('interviews', 'announceResult', 'EQUAL', 'pass', 300)
    .filter(function (x) { return !x.fields.announceNotifiedAt && Number(x.fields.announceAt || 0) >= since; });
  if (!list.length) return;
  const marks = [];
  list.forEach(function (x) {
    const iv = x.fields;
    let st = null;
    try { st = fsGet_('students/' + iv.studentNo); } catch (e) {}
    const a = (st && st.assign) || {};
    const keys = {};
    [a.s1, a.s2, a.s3a, a.s3b].forEach(function (nm) { const k = nm ? staffIdByName_(nm) : ''; if (k) keys[k] = true; });
    const who = maskName_((st && st.name) || iv.name || '');
    Object.keys(keys).forEach(function (k) {
      pushTo_('staff', k, { title: who + ' 학생 ' + (iv.univ || '') + ' 1차 합격 🎉', body: [iv.dept, iv.admission].filter(Boolean).join(' · '),
        url: 'teacher.html', tag: 'pass_' + x.id }, out);
    });
    marks.push(fsPatchReq_('interviews/' + x.id, { announceNotifiedAt: Date.now() }, ['announceNotifiedAt']));
  });
  fsBatch_(marks);
}

function notifyBookings_(props, out) {
  const lastMs = Number(props.getProperty('PUSH_LOG_MS') || 0);
  const doneIds = JSON.parse(props.getProperty('PUSH_LOG_IDS') || '[]');
  let logs = fsQuery_('bookingLogs', 'atMs', 'GREATER_THAN_OR_EQUAL', lastMs, 300)
    .filter(function (d) { return doneIds.indexOf(d.id) < 0; })
    .map(function (d) { const f = d.fields; f.id = d.id; return f; })
    .sort(function (a, b) { return a.atMs - b.atMs; });
  if (!lastMs) {   // 처음 켰을 때 예전 것을 몰아 보내지 않는다
    const maxMs0 = logs.length ? logs[logs.length - 1].atMs : Date.now();
    props.setProperty('PUSH_LOG_MS', String(maxMs0));
    props.setProperty('PUSH_LOG_IDS', JSON.stringify(logs.filter(function (l) { return l.atMs === maxMs0; }).map(function (l) { return l.id; })));
    return;
  }
  if (!logs.length) return;

  // 같은 일정은 마지막 것만 보낸다
  const lastPer = {};
  logs.forEach(function (l) { lastPer[l.bookingId] = l; });
  Object.keys(lastPer).forEach(function (bid) {
    const l = lastPer[bid];
    const stage = STAGE_TXT_[Number(l.stage)] || '면접';
    const when = whenTxt_(l);
    const tag = 'bk_' + bid;
    const teacherKeys = (l.teachers || []).map(staffIdByName_).filter(Boolean);
    const toStudent = function (title, body) { pushTo_('student', l.studentNo, { title: title, body: body, url: 'student.html', tag: tag }, out); };
    const toTeachers = function (title, body) { teacherKeys.forEach(function (k) { pushTo_('staff', k, { title: title, body: body, url: 'teacher.html', tag: tag }, out); }); };

    switch (String(l.action)) {
      case '신청':
        toTeachers(maskName_(l.studentName) + ' 학생이 ' + stage + '을 신청했어요', when + (l.room ? ' · ' + l.room : ''));
        break;
      case '일정 제안':
        toStudent('선생님이 ' + stage + ' 시간을 제안했어요', when + (l.room ? ' · ' + l.room : '') + ' — 앱에서 수락해 주세요');
        break;
      case '확정':
      case '관리자 확정':
        toStudent(stage + '이 확정됐어요', when + (l.room ? ' · ' + l.room : ''));
        break;
      case '거절':
        toStudent(stage + ' 요청이 거절됐어요', '앱에서 다른 시간을 신청해 주세요');
        break;
      case '취소':
        if (String(l.byRole) === 'student') toTeachers(maskName_(l.studentName) + ' 학생이 ' + stage + '을 취소했어요', when);
        else toStudent(stage + ' 일정이 취소됐어요', when + ' — 앱에서 다시 잡아 주세요');
        break;
      case '시간 변경 제안':
        if (String(l.byRole) === 'student') toTeachers(maskName_(l.studentName) + ' 학생이 시간 변경을 제안했어요', when);
        else toStudent('선생님이 ' + stage + ' 시간 변경을 제안했어요', when + ' — 앱에서 수락해 주세요');
        break;
      default: break;   // 수락(부분)·완료 등은 알리지 않는다
    }
  });

  const maxMs = logs[logs.length - 1].atMs;
  props.setProperty('PUSH_LOG_MS', String(maxMs));
  props.setProperty('PUSH_LOG_IDS', JSON.stringify(logs.filter(function (l) { return l.atMs === maxMs; }).map(function (l) { return l.id; })));
}

// 앱이 적어 둔 알림 (선생님이 피드백을 공개했을 때 등)
function notifyQueue_(out) {
  const list = fsQuery_('notify', 'sentAtMs', 'EQUAL', 0, 200);
  if (!list.length) return;
  const writes = [];
  list.forEach(function (d) {
    const f = d.fields;
    pushTo_(f.role === 'staff' ? 'staff' : 'student', f.key,
      { title: f.title, body: f.body, url: f.url || 'student.html', tag: f.tag || d.id }, out);
    writes.push(fsPatchReq_('notify/' + d.id, { sentAtMs: Date.now() }, ['sentAtMs']));
  });
  fsBatch_(writes);
}

// 내일 모의면접이 있는 학생에게 (저녁 한 번)
function notifyTomorrow_(out) {
  const tz = Session.getScriptTimeZone();
  const d = new Date(); d.setDate(d.getDate() + 1);
  const day = Utilities.formatDate(d, tz, 'yyyy-MM-dd');
  fsQuery_('bookings', 'date', 'EQUAL', day, 200).forEach(function (x) {
    const b = x.fields;
    if (b.status !== 'confirmed' || b.done === true) return;
    const stage = STAGE_TXT_[Number(b.stage)] || '면접';
    pushTo_('student', b.studentNo, {
      title: '내일 ' + stage + '이 있어요',
      body: (b.start || '') + (b.room ? ' · ' + b.room : '') + ' — 준비한 답변을 한 번 읽어 보세요',
      url: 'student.html', tag: 'eve_' + x.id
    }, out);
  });
}

// 대학 면접을 본 학생에게 후기 요청 — 당일 저녁 6시(ago=0) · 안 썼으면 다음 날 아침 한 번 더(ago=1)
function notifyReviewDue_(out, ago) {
  if (ago == null) ago = 1;
  const tz = Session.getScriptTimeZone();
  const d = new Date(); d.setDate(d.getDate() - ago);
  const day = Utilities.formatDate(d, tz, 'yyyy-MM-dd');
  fsQuery_('interviews', 'date', 'EQUAL', day, 200).forEach(function (x) {
    const iv = x.fields;
    if (iv.announceResult === 'fail') return;          // (v15) 1차 불합격한 대학은 후기 요청 안 함
    let has = null;
    try { has = fsGet_('reviews/' + x.id); } catch (e) {}
    if (has) return;
    pushTo_('student', iv.studentNo, {
      title: (ago ? '어제 ' : '오늘 ') + (iv.univ || '대학') + ' 면접, 어땠나요?',
      body: ago ? '받은 질문과 느낀 점을 적어 두면 선생님이 다음 준비를 도와줄 수 있어요'
        : '잊기 전에 받은 질문과 답을 적어 두세요 · 5분',
      url: 'student.html', tag: 'rv_' + x.id
    }, out);
  });
}

function ensureTab_(ss, name, head) {
  let sh = ss.getSheetByName(name);
  if (!sh) {
    sh = ss.insertSheet(name);
    sh.getRange(1, 1, 1, head.length).setValues([head]);
    styleHeader_(sh, head.length);
  }
  return sh;
}

// ---------- 모의 면접 기록 (통합 플랫폼 파일) ----------
function mergeMeetings_() {
  const sh = getMeetingSheet_();
  if (!sh) throw new Error("통합 플랫폼 파일에서 '모의 면접 기록' 탭을 찾지 못했습니다.");
  // soft: 시트에 걸린 데이터 확인 규칙과 부딪혀도 그 칸만 건너뛰고 나머지는 계속 반영한다
  const table = readTable_(sh, MEETING_COLS, { findHeader: true, soft: true });
  clearIdValidation_(sh, table);
  ensureTypeValidation_(sh, table);
  fixClsColumn_(sh, table);
  table.reload();
  const rows = table.rows.filter(function (r) { return r.data.studentNo; });
  const students = {};
  fsListCached_('students').forEach(function (d) { students[d.id] = d.fields; });
  const docs = {};
  fsList_('meetings').forEach(function (d) {
    const f = d.fields;
    docs[d.id] = { id: d.id, at: Number(f.updatedAtMs || 0), raw: f, data: {
      id: d.id, studentNo: String(f.studentNo || ''), name: f.name || '', cls: clsOf_(f.cls, String(f.studentNo || '')),
      type: f.type || '', teachers: (f.teachers || []).join(', '), date: f.date || '', stage: f.stage || 4
    } };
  });
  // 앱 기록에 학반이 날짜로 저장돼 있으면 바로잡는다.
  // (학반은 대조 항목이 아니라서 그냥 두면 계속 남는다)
  const clsFixes = [];
  Object.keys(docs).forEach(function (id) {
    const raw = docs[id].raw, no = String(raw.studentNo || '');
    const fixed = clsOf_(raw.cls, no);
    if (fixed && String(raw.cls || '') !== fixed) clsFixes.push(fsPatchReq_('meetings/' + id, { cls: fixed, updatedAtMs: Date.now() }, ['cls', 'updatedAtMs']));
  });
  if (clsFixes.length) { fsBatch_(clsFixes); Logger.log('앱 기록 ' + clsFixes.length + '건의 학반을 바로잡았습니다.'); }

  const writes = [];
  const res = merge_('meetings', rows, docs, MEETING_SYNC, {
    newId: function (row) {
      const id = 'mt_' + Utilities.getUuid().replace(/-/g, '').slice(0, 16);
      table.setCell(row.rowNum, 'id', id);
      return id;
    },
    push: function (row) {
      const d = row.data, no = String(d.studentNo), st = students[no] || {};
      const obj = {
        studentNo: no, name: d.name || st.name || '', cls: clsOf_(d.cls || st.cls, no), type: d.type,
        teachers: String(d.teachers || '').split(/\s*[,，·]\s*/).filter(String), date: d.date,
        updatedAtMs: Date.now()   // 앱 캐시가 바뀐 문서를 찾는 기준이므로 반영한 시각으로 기록
      };
      let mask = ['studentNo', 'name', 'cls', 'type', 'teachers', 'date', 'updatedAtMs'];
      if (!docs[row.id]) {  // 시트에서 새로 적은 기록
        obj.studentUid = st.uid || ''; obj.stage = Math.min(Number(d.round) || 4, 4); obj.shared = false;
        obj.createdBy = '시트'; obj.questions = ''; obj.good = ''; obj.improve = ''; obj.nextGoal = '';
        mask = null;
      }
      writes.push(fsPatchReq_('meetings/' + row.id, obj, mask));
    },
    pull: function (doc, row) {
      if (row) table.setRow(row.rowNum, doc.data); else table.appendRow(doc.data);
    },
    rowOnlyInState: function () { return 'delete'; },   // 앱에서 삭제한 기록 → 시트 행 삭제
    docOnlyInState: function () { return 'restore'; },  // 시트에서만 지운 기록 → 다시 채움 (앱이 기준)
    docOnlyNew: function () { return 'append'; },
    deleteDoc: function () {},
    flush: function (rowDeletes) { table.deleteRows(rowDeletes.map(function (r) { return r.rowNum; })); }
  });
  fsBatch_(writes);
  // 회차: 학생별 실시일 순
  table.reload();
  const by = {};
  table.rows.forEach(function (r) { if (r.data.studentNo) (by[r.data.studentNo] = by[r.data.studentNo] || []).push(r); });
  const roundWrites = [];
  Object.keys(by).forEach(function (no) {
    by[no].sort(function (a, b) { return String(a.data.date).localeCompare(String(b.data.date)); })
      .forEach(function (r, i) {
        if (Number(r.data.round) !== i + 1) writeRound_(sh, table, r.rowNum, i + 1);
        const d = docs[r.data.id];
        if (d && Number(d.raw.round) !== i + 1) roundWrites.push(fsPatchReq_('meetings/' + r.data.id, { round: i + 1, updatedAtMs: Date.now() }, ['round', 'updatedAtMs']));
      });
  });
  fsBatch_(roundWrites);
  if (table.skipped.length) Logger.log('시트 규칙 때문에 건너뛴 칸 ' + table.skipped.length + '개: ' + table.skipped.slice(0, 5).join(' / '));
  return res;
}

// ===================== 연동 탭 만들기 =====================
function buildLinkTabs_() {
  const ss = surveySS_();
  let skipped = [];
  const survey = readSurvey_(ss);
  const assign = readAssign_(ss);
  const links = readLinks_();

  let sCount = 0, iCount = 0;
  if (!ss.getSheetByName(TAB.STUDENTS)) {
    const sh = ss.insertSheet(TAB.STUDENTS);
    sh.getRange(1, 1, 1, STUDENT_COLS.length).setValues([STUDENT_COLS.map(function (c) { return c[0]; })]);
    const nos = uniq_(Object.keys(assign).concat(Object.keys(survey)));
    nos.sort();
    const values = nos.map(function (no) {
      const a = assign[no] || {}, s = survey[no] || {};
      return STUDENT_COLS.map(function (c) {
        const k = c[1];
        if (k === 'studentNo') return Number(no);
        if (k === 'name') return a.name || s.name || '';
        if (k === 'cls') return classOf_(no);
        if (k === 'sheetUrl') return links[no] || '';
        if (k === '_first' || k === '_next') return '';
        if (k === '_stamp') return new Date();
        if (k === '_by') return '초기 생성';
        return a[k] || '';
      });
    });
    if (values.length) sh.getRange(2, 1, values.length, STUDENT_COLS.length).setValues(values);
    styleHeader_(sh, STUDENT_COLS.length);
    readTable_(sh, STUDENT_COLS).ensureFormulas();
    sCount = values.length;
  } else skipped.push(TAB.STUDENTS);

  if (!ss.getSheetByName(TAB.INTERVIEWS)) {
    const sh = ss.insertSheet(TAB.INTERVIEWS);
    sh.getRange(1, 1, 1, INTERVIEW_COLS.length).setValues([INTERVIEW_COLS.map(function (c) { return c[0]; })]);
    const values = [];
    const nos = uniq_(Object.keys(assign).concat(Object.keys(survey))).sort();
    nos.forEach(function (no) {
      const s = survey[no], a = assign[no] || {};
      const list = s ? s.universities : [];
      if (!list.length && a.firstInterview) list.push({ univ: '(수요조사 없음)', dept: '', admission: '', format: a.track || '', date: a.firstInterview });
      list.forEach(function (u) {
        values.push([Number(no), (a.name || (s && s.name) || ''), u.univ, u.dept, u.admission, u.format,
          parseDay_(u.date) || u.date, new Date(), '초기 생성', 'iv_' + Utilities.getUuid().replace(/-/g, '').slice(0, 16)]);
      });
    });
    values.sort(function (x, y) { return (x[6] instanceof Date ? x[6].getTime() : 0) - (y[6] instanceof Date ? y[6].getTime() : 0); });
    if (values.length) sh.getRange(2, 1, values.length, INTERVIEW_COLS.length).setValues(values);
    styleHeader_(sh, INTERVIEW_COLS.length);
    sh.getRange(2, 7, Math.max(values.length, 1), 1).setNumberFormat('yyyy. mm. dd');
    iCount = values.length;
  } else skipped.push(TAB.INTERVIEWS);

  [TAB.STUDENTS, TAB.INTERVIEWS].forEach(function (n) {
    const sh = ss.getSheetByName(n);
    sh.getRange(2, colOf_(n === TAB.STUDENTS ? STUDENT_COLS : INTERVIEW_COLS, '_stamp'), Math.max(sh.getLastRow() - 1, 1), 1).setNumberFormat('yyyy. mm. dd hh:mm');
  });
  ensureStateSheet_();
  return { students: sCount, interviews: iCount, skipped: skipped.join(', ') };
}

// 설문지 응답 → {학번: {name, universities:[...]}}  (같은 대학·학과는 최신 응답)
function readSurvey_(ss) {
  const sh = ss.getSheetByName(TAB.SURVEY);
  const out = {};
  if (!sh) return out;
  const v = sh.getDataRange().getValues();
  const h = v[0].map(function (x) { return String(x).replace(/^\d+\.\s*/, '').trim(); });
  const col = function (name) { for (let i = 0; i < h.length; i++) if (h[i].indexOf(name) >= 0) return i; return -1; };
  const c = { ts: col('타임스탬프'), no: col('학번'), name: col('이름'), univ: col('지원 대학'), dept: col('모집단위'), adm: col('전형명'), fmt: col('면접 유형'), date: col('면접 예정일'),
    sub1: col('가장 도움받고 싶은 교과'), sub2: col('추가로 도움받고 싶은'), ready: col('준비 정도'), needs: col('도움이 필요한 부분'), memo: col('전달하고 싶은') };
  v.slice(1).forEach(function (r) {
    const no = String(r[c.no]).replace(/\.0$/, '').trim();
    if (!/^\d{4,5}$/.test(no)) return;
    const o = out[no] = out[no] || { name: r[c.name], universities: [], extras: { subject1: '', subject2: '', readiness: '', needs: [], memos: [] } };
    const x = o.extras, val = function (i) { return i >= 0 ? String(r[i] || '').trim() : ''; };
    if (val(c.sub1)) x.subject1 = val(c.sub1);
    if (val(c.sub2)) x.subject2 = val(c.sub2);
    if (val(c.ready)) x.readiness = val(c.ready);
    val(c.needs).replace(/전공,\s*교과 개념 점검/g, '전공·교과 개념 점검').split(/,\s*/).forEach(function (n) { if (n && x.needs.indexOf(n) < 0) x.needs.push(n); });
    const memo = val(c.memo);
    if (memo && !/^(없음|없습니다|x|\.)$/i.test(memo) && x.memos.indexOf(memo) < 0) x.memos.push(memo);
    const u = { univ: String(r[c.univ] || '').trim(), dept: String(r[c.dept] || '').trim(), admission: String(r[c.adm] || '').trim(), format: normalizeFormat_(r[c.fmt]), date: fmtDay_(r[c.date]) };
    const i = o.universities.findIndex(function (x) { return x.univ === u.univ && x.dept === u.dept; });
    if (i >= 0) o.universities[i] = u; else o.universities.push(u);
  });
  return out;
}
// 3회 지도 배정안 학생 표 → {학번: {...}}
function readAssign_(ss) {
  const sh = ss.getSheetByName(TAB.ASSIGN);
  const out = {};
  if (!sh) return out;
  const v = sh.getDataRange().getValues();
  let hr = -1;
  for (let i = 0; i < v.length; i++) if (v[i].indexOf('학번') >= 0 && v[i].indexOf('1차 담임') >= 0) { hr = i; break; }
  if (hr < 0) return out;
  const h = v[hr].map(String);
  const g = function (r, name) { const i = h.indexOf(name); return i >= 0 ? clean_(r[i]) : ''; };
  v.slice(hr + 1).forEach(function (r) {
    const no = String(r[h.indexOf('학번')]).replace(/\.0$/, '').trim();
    if (!/^\d{4,5}$/.test(no)) return;
    out[no] = { name: g(r, '이름'), priority: g(r, '우선도'), track: g(r, '기본 트랙'), special: g(r, '특별 트랙') || '없음',
      s1: g(r, '1차 담임'), s2: g(r, '2차 교과 담당'), s3a: g(r, '3차 1위원'), s3b: g(r, '3차 2위원'), firstInterview: fmtDay_(r[h.indexOf('최초 면접일')]) };
  });
  return out;
}
// 학생별 링크 파일 → {학번: url}
function readLinks_() {
  const out = {};
  try {
    const ss = SpreadsheetApp.openById(CONFIG.LINKS_SHEET_ID);
    ss.getSheets().forEach(function (sh) {
      const v = sh.getDataRange().getValues();
      let noCol = -1, urlCol = -1;
      v.forEach(function (r) {
        const s = r.map(String);
        if (s.indexOf('학번') >= 0 && s.indexOf('학생용 링크') >= 0) { noCol = s.indexOf('학번'); urlCol = s.indexOf('학생용 링크'); return; }
        if (noCol < 0) return;
        const no = String(r[noCol]).replace(/\.0$/, '').trim();
        const url = String(r[urlCol] || '');
        if (/^\d{4,5}$/.test(no) && /^https?:/.test(url)) out[no] = url;
      });
    });
  } catch (err) { Logger.log('링크 파일 읽기 실패: ' + err.message); }
  return out;
}

// ===================== 기존 탭 수식 연결 =====================
const LINK_TARGETS = [
  { sheet: '1. 3회 지도 배정안', need: ['학번', '1차 담임'], cols: { '최초 면접일': 'first', '기본 트랙': 'track', '특별 트랙': 'special', '1차 담임': 's1', '2차 교과 담당': 's2', '3차 1위원': 's3a', '3차 2위원': 's3b' } },
  { sheet: '2. 교사별 담당 학생', need: ['학번', '희망 전공·대학'], cols: { '희망 전공·대학': 'firstText', '면접 트랙': 'track' } },
  { sheet: '3. 운영 일정', need: ['학번', '최초 면접일'], cols: { '최초 면접일': 'first', '기본 트랙': 'track', '특별 트랙': 'special' } },
  { sheet: '4. 운영 명단(학생별)', need: ['학번', '최초 면접일'], cols: { '지원 대학·학과·면접일': 'firstText', '최초 면접일': 'first', '기본 트랙': 'track' } },
  { sheet: '6. 운영 편성표', need: ['학번', '최초 면접일'], cols: { '최초 면접일': 'first', '기본 트랙': 'track' } },
  { sheet: '7. 담당교사 배정안', need: ['학번', '최초 면접일'], cols: { '최초 면접일': 'first', '기본 트랙': 'track' } }
];
function linkExistingTabs_() {
  const ss = surveySS_();
  const out = [];
  const backup = DriveApp.getFileById(ss.getId()).makeCopy(ss.getName() + ' (연동 전 백업 ' + Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'MM-dd HH:mm') + ')');
  out.push('백업: ' + backup.getName());
  const S = "'" + TAB.STUDENTS + "'", I = "'" + TAB.INTERVIEWS + "'";
  const sCol = function (k) { return colLetter_(colOf_(STUDENT_COLS, k)); };
  const iCol = function (k) { return colLetter_(colOf_(INTERVIEW_COLS, k)); };
  const lastS = colLetter_(STUDENT_COLS.length);
  LINK_TARGETS.forEach(function (t) {
    const sh = ss.getSheetByName(t.sheet);
    if (!sh) { out.push(t.sheet + ': 탭 없음'); return; }
    const v = sh.getDataRange().getValues();
    let hr = -1;
    for (let i = 0; i < v.length; i++) { const s = v[i].map(String); if (t.need.every(function (n) { return s.indexOf(n) >= 0; })) { hr = i; break; } }
    if (hr < 0) { out.push(t.sheet + ': 머리행을 못 찾음'); return; }
    const h = v[hr].map(String);
    const noL = colLetter_(h.indexOf('학번') + 1);
    let count = 0;
    Object.keys(t.cols).forEach(function (head) {
      const ci = h.indexOf(head);
      if (ci < 0) return;
      const key = t.cols[head];
      const formulas = [];
      let r = hr + 1;
      for (; r < v.length; r++) {
        const noVal = v[r][h.indexOf('학번')];
        if (noVal === '' || noVal === null) break;
        const ref = noL + (r + 1);
        let f;
        if (key === 'firstText') {
          f = '=IFERROR(INDEX(SORT(FILTER({TEXT(' + I + '!' + iCol('date') + ':' + iCol('date') + ',"yyyy.mm.dd")&" | "&' + I + '!' + iCol('univ') + ':' + iCol('univ') + '&" | "&' + I + '!' + iCol('dept') + ':' + iCol('dept') + '&" ("&' + I + '!' + iCol('admission') + ':' + iCol('admission') + '&")",' + I + '!' + iCol('date') + ':' + iCol('date') + '},' + I + '!' + iCol('studentNo') + ':' + iCol('studentNo') + '=' + ref + '),2,TRUE),1,1),"")';
        } else {
          const idx = colOf_(STUDENT_COLS, key === 'first' ? '_first' : key);
          f = '=IFERROR(IF(VLOOKUP(' + ref + ',' + S + '!$A:$' + lastS + ',' + idx + ',FALSE)="","",VLOOKUP(' + ref + ',' + S + '!$A:$' + lastS + ',' + idx + ',FALSE)),"")';
        }
        formulas.push([f]);
      }
      if (formulas.length) {
        sh.getRange(hr + 2, ci + 1, formulas.length, 1).setFormulas(formulas);
        if (key === 'first') sh.getRange(hr + 2, ci + 1, formulas.length, 1).setNumberFormat('yyyy. mm. dd');
        count += formulas.length;
      }
    });
    out.push(t.sheet + ': ' + count + '칸 연결');
  });
  out.push("※ '준비 시작일·권장 시작일' 같은 준비 일정 칸은 그대로입니다. 면접일이 크게 바뀐 학생은 직접 확인하세요.");
  return out;
}

// ===================== 면접 달력 =====================
function rebuildCalendar() {
  const ss = surveySS_();
  const cal = ss.getSheetByName(TAB.CALENDAR);
  const iv = ss.getSheetByName(TAB.INTERVIEWS);
  const st = ss.getSheetByName(TAB.STUDENTS);
  if (!cal || !iv) return;
  const students = {};
  if (st) readTable_(st, STUDENT_COLS).rows.forEach(function (r) { students[String(r.data.studentNo)] = r.data; });
  const items = readTable_(iv, INTERVIEW_COLS).rows
    .filter(function (r) { return r.data.date && /^\d{4}-\d{2}-\d{2}$/.test(r.data.date); })
    .map(function (r) {
      const s = students[String(r.data.studentNo)] || {};
      return { date: r.data.date, no: String(r.data.studentNo), name: r.data.name || s.name || '', univ: r.data.univ, dept: r.data.dept, track: s.track || '', special: s.special || '없음', format: r.data.format || '' };
    })
    .sort(function (a, b) { return a.date.localeCompare(b.date) || a.no.localeCompare(b.no); });

  // 오른쪽 상세 명단 (I열~O열, 3행부터)
  const last = Math.max(cal.getLastRow(), 3);
  cal.getRange(3, 9, last, 7).clearContent();
  cal.getRange(1, 9).setValue('날짜별 상세 명단 (' + items.length + '건)');
  const W = '일월화수목금토';
  if (items.length) {
    cal.getRange(3, 9, items.length, 7).setValues(items.map(function (x) {
      const d = parseDay_(x.date);
      return [d, W[d.getDay()], classOf_(x.no).replace(/^\d-/, '') + '반 ' + x.no + ' ' + x.name, x.univ, x.dept, x.track, x.special];
    }));
    cal.getRange(3, 9, items.length, 1).setNumberFormat('yyyy. mm. dd');
  }

  // 월 블록: A열에 'YYYY년 M월' 제목이 있는 행마다 다시 채움
  const byDay = {};
  items.forEach(function (x) {
    const o = byDay[x.date] = byDay[x.date] || { n: 0, people: {}, passage: 0, mmi: 0 };
    o.n++; o.people[x.no] = true;
    if (/제시문/.test(x.special) || /제시문/.test(x.format)) o.passage++;
    if (/MMI/i.test(x.special) || /MMI/i.test(x.format)) o.mmi++;
  });
  const colA = cal.getRange(1, 1, cal.getLastRow(), 1).getValues();
  colA.forEach(function (row, i) {
    const m = String(row[0]).match(/^(\d{4})년\s*(\d{1,2})월$/);
    if (!m) return;
    const y = Number(m[1]), mon = Number(m[2]) - 1;
    const grid = [], colors = [];
    const first = new Date(y, mon, 1).getDay(), days = new Date(y, mon + 1, 0).getDate();
    for (let w = 0; w < 6; w++) {
      const line = [], cl = [];
      for (let dow = 0; dow < 7; dow++) {
        const day = w * 7 + dow - first + 1;
        if (day < 1 || day > days) { line.push(''); cl.push('#ffffff'); continue; }
        const key = y + '-' + ('0' + (mon + 1)).slice(-2) + '-' + ('0' + day).slice(-2);
        const o = byDay[key];
        if (!o) { line.push(String(day)); cl.push('#ffffff'); continue; }
        let txt = day + '\n' + o.n + '건 · ' + Object.keys(o.people).length + '명';
        const extra = [];
        if (o.passage) extra.push('제시문 ' + o.passage);
        if (o.mmi) extra.push('MMI ' + o.mmi);
        if (extra.length) txt += '\n' + extra.join(' · ');
        line.push(txt);
        cl.push(o.mmi ? '#fde2e2' : o.passage ? '#e2ecfd' : '#e5f7e5');
      }
      grid.push(line); colors.push(cl);
    }
    const r0 = i + 3; // 제목행 + 요일행 다음
    cal.getRange(r0, 1, 6, 7).setValues(grid).setBackgrounds(colors).setWrap(true).setVerticalAlignment('top');
  });
}

// 이 스크립트가 붙어 있는 '수요조사' 파일.
// 통합 플랫폼 편집 트리거로 실행되면 getActive() 가 통합 플랫폼을 가리킨다.
// 그대로 두면 _동기화상태·_동기화기록이 엉뚱한 파일에 생기고,
// 상태를 못 읽어 모든 줄을 '처음 보는 줄' 로 취급해 기록이 중복된다.
function surveySS_() {
  const props = PropertiesService.getScriptProperties();
  let id = props.getProperty('SURVEY_ID');
  const act = SpreadsheetApp.getActiveSpreadsheet();
  if (!id && act && act.getId() !== CONFIG.PLATFORM_SHEET_ID) {
    id = act.getId(); props.setProperty('SURVEY_ID', id);      // 메뉴·수요조사 편집에서 한 번 기록
  }
  if (id && (!act || act.getId() !== id)) {
    try { return SpreadsheetApp.openById(id); } catch (e) { /* 못 열면 아래로 */ }
  }
  return act;
}

// 학반 칸에 '3-2' 를 넣으면 시트가 날짜(3월 2일)로 바꿔 버린다.
// 그 열을 '일반 텍스트' 로 고정하고, 이미 날짜가 된 칸은 되돌린다.
function fixClsColumn_(sh, table) {
  try {
    if (!table.map || table.map.cls == null) return;
    const col = table.map.cls + 1;
    const last = Math.max(sh.getLastRow(), table.headerRow + 1);
    sh.getRange(table.headerRow + 1, col, Math.max(last - table.headerRow, 500), 1).setNumberFormat('@');
    const noCol = table.map.studentNo != null ? table.map.studentNo + 1 : 0;
    const rng = sh.getRange(table.headerRow + 1, col, last - table.headerRow, 1);
    const nos = noCol ? sh.getRange(table.headerRow + 1, noCol, last - table.headerRow, 1).getValues() : null;
    const vals = rng.getValues();
    let changed = 0;
    for (let i = 0; i < vals.length; i++) {
      const v = vals[i][0];
      const no = nos ? String(nos[i][0] || '').replace(/\.0$/, '').trim() : '';
      if (v === '' || v == null) continue;
      const fixed = clsOf_(v, no);
      if (fixed !== v) { vals[i][0] = fixed; changed++; }
    }
    if (changed) { rng.setValues(vals); SpreadsheetApp.flush(); Logger.log('학반 칸 ' + changed + '개를 날짜에서 되돌렸습니다.'); }
  } catch (e) { Logger.log('학반 칸 정리 실패(무시): ' + e); }
}

// ===================== 시트 표 도우미 =====================
function readTable_(sh, cols, opt) {
  opt = opt || {};
  const api = {};
  function load() {
    if (cols === INTERVIEW_COLS) ensureAnnounceCol_(sh);
    const lastRow = sh.getLastRow(), lastCol = Math.max(sh.getLastColumn(), cols.length);
    const all = lastRow ? sh.getRange(1, 1, lastRow, lastCol).getValues() : [[]];
    let hr = 0;
    if (opt.findHeader) {
      hr = -1;
      for (let i = 0; i < Math.min(all.length, 15); i++) if (all[i].map(String).indexOf('학번') >= 0) { hr = i; break; }
      if (hr < 0) throw new Error(sh.getName() + ": '학번' 머리행이 없습니다.");
    }
    const head = all[hr].map(String);
    const map = {};
    cols.forEach(function (c) {
      let i = head.indexOf(c[0]);
      if (i < 0) {  // 없는 열(예: 기록ID)은 마지막 머리칸 오른쪽에 만든다
        let lastNon = head.length - 1;
        while (lastNon >= 0 && head[lastNon] === '') lastNon--;
        i = lastNon + 1;
        sh.getRange(hr + 1, i + 1).setValue(c[0]);
        head[i] = c[0];
      }
      map[c[1]] = i;
    });
    api.headerRow = hr + 1; api.map = map;
    api.rows = [];
    for (let r = hr + 1; r < all.length; r++) {
      const line = all[r];
      const data = {};
      Object.keys(map).forEach(function (k) { data[k] = normCell_(k, line[map[k]]); });
      const empty = Object.keys(data).every(function (k) { return k.charAt(0) === '_' || k === 'id' || k === 'round' || data[k] === ''; });
      if (empty) continue;
      const stamp = map._stamp != null && line[map._stamp] instanceof Date ? line[map._stamp].getTime() : 0;
      api.rows.push({ rowNum: r + 1, data: data, id: data.id || null, stamp: stamp, by: map._by != null ? String(line[map._by] || '') : '' });
    }
  }
  load();
  api.reload = load;
  api.skipped = [];
  // opt.soft 인 표는 데이터 확인 규칙과 부딪혀도 그 칸만 건너뛴다 (동기화 전체가 멈추지 않게)
  // Apps Script 는 시트 쓰기를 모아 두었다가 나중에 반영한다.
  // 그래서 setValue 바로 옆의 try/catch 로는 '데이터 확인 규칙 위반' 을 못 잡는다
  // (한참 뒤에 터져서 동기화 전체가 멈춘다). 쓰고 바로 flush 해서 여기서 잡는다.
  function put(rowNum, colIdx, value, what) {
    try {
      sh.getRange(rowNum, colIdx).setValue(value);
      if (opt.soft) SpreadsheetApp.flush();
      return true;
    }
    catch (e) {
      if (!opt.soft) throw e;
      api.skipped.push(sh.getName() + ' ' + rowNum + '행 ' + what + ': ' + (e && e.message ? e.message : e));
      return false;
    }
  }
  api.setCell = function (rowNum, key, value) { return put(rowNum, api.map[key] + 1, value, key); };
  api.setRow = function (rowNum, data, by) {
    cols.forEach(function (c) {
      const k = c[1];
      if (k.charAt(0) === '_' || !(k in data)) return;
      put(rowNum, api.map[k] + 1, toCell_(k, data[k]), k);
    });
    if (api.map._stamp != null) put(rowNum, api.map._stamp + 1, new Date(), '수정 시각');
    if (api.map._by != null && by) put(rowNum, api.map._by + 1, by, '수정자');
  };
  api.appendRow = function (data, by) {
    const width = Math.max.apply(null, Object.keys(api.map).map(function (k) { return api.map[k]; })) + 1;
    const line = new Array(width).fill('');
    cols.forEach(function (c) { if (c[1] in data && c[1].charAt(0) !== '_') line[api.map[c[1]]] = toCell_(c[1], data[c[1]]); });
    if (api.map._stamp != null) line[api.map._stamp] = new Date();
    if (api.map._by != null) line[api.map._by] = by || '';
    const target = nextEmptyRow_(sh, api.headerRow, api.map.studentNo);
    try { sh.getRange(target, 1, 1, width).setValues([line]); if (opt.soft) SpreadsheetApp.flush(); }
    catch (e) {
      if (!opt.soft) throw e;
      // 줄 전체가 막히면 칸 하나씩 넣어 본다 (막힌 칸만 건너뜀)
      for (let i = 0; i < width; i++) if (line[i] !== '') put(target, i + 1, line[i], '새 줄 ' + (i + 1) + '번째 칸');
    }
  };
  api.deleteRows = function (nums) { nums.sort(function (a, b) { return b - a; }).forEach(function (n) { sh.deleteRow(n); }); };
  api.ensureFormulas = function () {
    if (api.map._first == null) return;
    const last = sh.getLastRow();
    if (last < 2) return;
    const I = "'" + TAB.INTERVIEWS + "'";
    const noL = colLetter_(api.map.studentNo + 1);
    const dL = colLetter_(colOf_(INTERVIEW_COLS, 'date')), nL = colLetter_(colOf_(INTERVIEW_COLS, 'studentNo'));
    const f1 = [], f2 = [];
    for (let r = 2; r <= last; r++) {
      const ref = noL + r;
      f1.push(['=IF(' + ref + '="","",IFERROR(1/(1/MINIFS(' + I + '!' + dL + ':' + dL + ',' + I + '!' + nL + ':' + nL + ',' + ref + ')),""))']);
      f2.push(['=IF(' + ref + '="","",IFERROR(1/(1/MINIFS(' + I + '!' + dL + ':' + dL + ',' + I + '!' + nL + ':' + nL + ',' + ref + ',' + I + '!' + dL + ':' + dL + ',">="&TODAY())),""))']);
    }
    sh.getRange(2, api.map._first + 1, f1.length, 1).setFormulas(f1).setNumberFormat('yyyy. mm. dd');
    sh.getRange(2, api.map._next + 1, f2.length, 1).setFormulas(f2).setNumberFormat('yyyy. mm. dd');
  };
  api.sortByDate = function () {
    const last = sh.getLastRow();
    if (last > 2 && api.map.date != null) sh.getRange(2, 1, last - 1, sh.getLastColumn()).sort([{ column: api.map.date + 1, ascending: true }, { column: api.map.studentNo + 1, ascending: true }]);
  };
  return api;
}

// (v14) '앱연동_면접일' 에 '1차 발표일' 칸이 없으면 '면접일' 바로 오른쪽에 새 칸을 끼워 넣는다 (행은 그대로, 오른쪽 칸만 한 칸씩 밀림)
function ensureAnnounceCol_(sh) {
  const lastCol = sh.getLastColumn();
  if (!lastCol) return;
  const head = sh.getRange(1, 1, 1, lastCol).getValues()[0].map(String);
  if (head.indexOf('1차 발표일') >= 0) return;
  const d = head.indexOf('면접일');
  if (d < 0) return;                       // 면접일 칸도 없으면 readTable_ 이 맨 오른쪽에 만든다
  sh.insertColumnAfter(d + 1);
  sh.getRange(1, d + 2).setValue('1차 발표일');
  if (sh.getLastRow() > 1) sh.getRange(2, d + 2, sh.getLastRow() - 1, 1).setNumberFormat('yyyy. mm. dd');
}
function normCell_(key, v) {
  if (v === null || v === undefined) return '';
  if (key === 'date') return fmtDay_(v);
  if (key === 'firstAnnounce') { if (/없음/.test(String(v))) return '없음'; return v === '' ? '' : fmtDay_(v); }
  // 회차 칸은 '1차', '4차 이상' 처럼 글자로 적혀 있을 수 있다. 앞의 숫자만 뽑아 쓴다.
  // (숫자로 못 읽으면 매번 '값이 달라졌다'고 보고 다시 쓰려 해서 데이터 확인 규칙과 부딪힌다)
  if (key === 'round') { const m = String(v).match(/\d+/); return m ? Number(m[0]) : String(v).trim(); }
  // 학반에 '3-2' 를 치면 시트가 날짜(3월 2일)로 바꿔 버린다. 다시 '3-2' 로 읽는다.
  if (key === 'cls' && v instanceof Date) return (v.getMonth() + 1) + '-' + v.getDate();
  if (key === 'studentNo') return String(v).replace(/\.0$/, '').trim();
  if (v instanceof Date) return fmtDay_(v);
  return String(v).trim();
}
// 회차 열에 '1차 / 2차 / 3차 / 4차 이상' 같은 드롭다운이 걸려 있으면 그 표기로 써야 한다.
// 숫자 1 을 그대로 넣으면 '데이터 확인 규칙을 위반합니다' 오류가 나고 동기화가 멈춘다.
function roundList_(sh, table) {
  if (table._roundList !== undefined) return table._roundList;
  let list = [];
  try {
    if (table.map && table.map.round != null) {
      const col = table.map.round + 1;
      // 머리행 바로 아래부터 몇 칸을 훑는다 (규칙이 첫 칸에만 안 걸려 있을 수도 있다)
      for (let k = 0; k < 200 && !list.length; k++) {
        const rule = sh.getRange(table.headerRow + 1 + k, col).getDataValidation();
        if (!rule) continue;
        const C = SpreadsheetApp.DataValidationCriteria;
        const type = rule.getCriteriaType(), vals = rule.getCriteriaValues() || [];
        if (type === C.VALUE_IN_LIST) list = (vals[0] || []).map(String).filter(String);
        else if (type === C.VALUE_IN_RANGE && vals[0] && vals[0].getValues) {
          // '목록 범위'로 만든 드롭다운
          list = [].concat.apply([], vals[0].getValues()).map(String).filter(String);
        }
      }
    }
  } catch (e) { list = []; }   // 못 읽어도 아래 모양 판단으로 넘어간다
  table._roundList = list;
  return list;
}

// '기록ID' 열은 스크립트가 만들고 스크립트만 쓰는 칸이다.
// 여기에 드롭다운(데이터 확인)이 잘못 걸려 있으면 기록ID 를 못 적어서
//  - '데이터 확인 규칙을 위반합니다' 오류가 나고
//  - 기록ID 가 비어 있으니 같은 기록이 동기화할 때마다 새로 생긴다.
// 그래서 이 열의 규칙만 지운다. (회차 열의 드롭다운은 그대로 둔다)
function clearIdValidation_(sh, table) {
  try {
    if (!table.map || table.map.id == null) return;
    const col = table.map.id + 1;
    const last = Math.max(sh.getLastRow(), table.headerRow + 1);
    const rng = sh.getRange(table.headerRow, col, last - table.headerRow + 1, 1);
    const rules = rng.getDataValidations ? rng.getDataValidations() : null;
    if (!rules) return;
    let found = false;
    for (let i = 0; i < rules.length; i++) if (rules[i] && rules[i][0]) { found = true; break; }
    if (!found) return;
    rng.clearDataValidations();
    SpreadsheetApp.flush();   // 바로 반영해야 뒤따르는 쓰기가 막히지 않는다
    Logger.log("'기록ID' 열에 잘못 걸려 있던 데이터 확인 규칙을 지웠습니다. (" + sh.getName() + ')');
  } catch (e) { Logger.log('기록ID 열 규칙 정리 실패(무시): ' + e); }
}

// 앱이 쓰는 면접 유형 (common.js 의 MEETING_TYPES 와 같아야 한다)
const APP_MEETING_TYPES = ['학생부 기반', '기본 인성', '제시문', 'MMI', '복합형', '담임 기본지도'];
// '면접 유형' 열 드롭다운에 앱이 쓰는 유형이 빠져 있으면 목록에 더해 준다.
// (시트 목록이 4개뿐이면 '복합형'·'담임 기본지도' 기록이 시트에 못 들어간다)
function ensureTypeValidation_(sh, table) {
  try {
    if (!table.map || table.map.type == null) return;
    const col = table.map.type + 1;
    const C = SpreadsheetApp.DataValidationCriteria;
    const last = Math.max(sh.getLastRow(), table.headerRow + 1);
    // 규칙이 첫 줄에만 안 걸려 있을 수 있으니 데이터 줄 전체에서 목록형 규칙을 찾는다
    let cur = null;
    // 규칙이 아직 줄이 없는 아래쪽에만 걸려 있을 수도 있으니 넉넉히(200줄) 훑는다
    const scan = Math.max(last - table.headerRow, 200);
    const rules = sh.getRange(table.headerRow + 1, col, scan, 1).getDataValidations();
    for (let i = 0; i < rules.length && !cur; i++) {
      const r = rules[i] && rules[i][0];
      if (r && r.getCriteriaType() === C.VALUE_IN_LIST) cur = (r.getCriteriaValues()[0] || []).map(String);
    }
    if (!cur) return;                                    // 드롭다운이 없거나 '목록 범위'형이면 손대지 않는다
    const add = APP_MEETING_TYPES.filter(function (t) { return cur.indexOf(t) < 0; });
    if (!add.length) return;
    const next = SpreadsheetApp.newDataValidation().requireValueInList(cur.concat(add), true).setAllowInvalid(true).build();
    // 앞으로 추가될 줄까지 덮도록 넉넉히 (머리행 아래 500줄)
    sh.getRange(table.headerRow + 1, col, Math.max(scan, 500), 1).setDataValidation(next);
    SpreadsheetApp.flush();   // 바로 반영해야 이어지는 쓰기가 새 목록으로 검사된다
    Logger.log("'면접 유형' 드롭다운에 " + add.join(', ') + ' 을(를) 더했습니다.');
  } catch (e) { Logger.log('면접 유형 목록 보완 실패(무시): ' + e); }
}

// 규칙을 못 읽었을 때: 이미 '1차' 처럼 글자로 적혀 있으면 같은 꼴로 쓴다
function roundIsText_(sh, table) {
  if (table._roundText !== undefined) return table._roundText;
  let text = false;
  try {
    const col = table.map.round + 1, last = sh.getLastRow();
    if (last > table.headerRow) {
      const vals = sh.getRange(table.headerRow + 1, col, last - table.headerRow, 1).getValues();
      for (let i = 0; i < vals.length; i++) {
        if (typeof vals[i][0] === 'string' && /\d+\s*차/.test(vals[i][0])) { text = true; break; }
      }
    }
  } catch (e) {}
  table._roundText = text;
  return text;
}
function roundCellValue_(sh, table, n) {
  const vals = roundList_(sh, table);
  if (vals.length) {
    for (let i = 0; i < vals.length; i++) {
      const m = String(vals[i]).match(/\d+/);
      if (m && Number(m[0]) === n) return vals[i];
    }
    return vals[vals.length - 1];   // 목록에 없는 회차(5차 등) → '4차 이상' 같은 마지막 항목
  }
  return roundIsText_(sh, table) ? n + '차' : n;
}
// 회차 쓰기. 규칙을 못 읽는 경우까지 대비해 표기를 바꿔 가며 시도한다.
// (한 가지만 시도하면 드롭다운이 거부했을 때 칸이 빈 채로 남는다)
function writeRound_(sh, table, rowNum, n) {
  const tries = [];
  const first = roundCellValue_(sh, table, n);
  tries.push(first);
  if (tries.indexOf(n + '차') < 0) tries.push(n + '차');       // '1차'
  if (tries.indexOf(n) < 0) tries.push(n);                     // 숫자 1
  const alt = n >= 4 ? (n + '차 이상') : null;                 // '4차 이상' 같은 목록 마지막 항목
  if (alt && tries.indexOf(alt) < 0) tries.push(alt);
  for (let i = 0; i < tries.length; i++) if (table.setCell(rowNum, 'round', tries[i])) return true;
  return false;
}
function toCell_(key, v) {
  if (key === 'date') return parseDay_(v) || v || '';
  if (key === 'firstAnnounce') return v === '없음' ? '없음' : (parseDay_(v) || v || '');
  if (key === 'studentNo' && /^\d+$/.test(String(v))) return Number(v);
  if (key === 'round' && /^\d+$/.test(String(v))) return Number(v);
  return v == null ? '' : v;
}
function nextEmptyRow_(sh, headerRow, noIdx) {
  const last = sh.getLastRow();
  if (last <= headerRow) return headerRow + 1;
  const vals = sh.getRange(headerRow + 1, (noIdx || 0) + 1, last - headerRow, 1).getValues();
  for (let i = 0; i < vals.length; i++) if (vals[i][0] === '' || vals[i][0] === null) return headerRow + 1 + i;
  return last + 1;
}
function stampRows_(range, email) {
  const sh = range.getSheet();
  const cols = sh.getName() === TAB.STUDENTS ? STUDENT_COLS : INTERVIEW_COLS;
  const head = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0].map(String);
  const sc = head.indexOf('수정 시각') + 1, bc = head.indexOf('수정자') + 1;
  if (!sc) return;
  const r0 = Math.max(range.getRow(), 2), r1 = range.getLastRow();
  if (r1 < r0) return;
  // 수정 시각/수정자 칸 자체를 고친 경우는 무시
  if (range.getColumn() === sc && range.getLastColumn() === sc) return;
  const now = new Date();
  sh.getRange(r0, sc, r1 - r0 + 1, 1).setValues(Array(r1 - r0 + 1).fill([now]));
  if (bc) sh.getRange(r0, bc, r1 - r0 + 1, 1).setValues(Array(r1 - r0 + 1).fill([email || '시트']));
}
function getMeetingSheet_() {
  try { return SpreadsheetApp.openById(CONFIG.PLATFORM_SHEET_ID).getSheetByName(TAB.MEETINGS); } catch (err) { return null; }
}
function getOrThrow_(ss, name) {
  const sh = ss.getSheetByName(name);
  if (!sh) throw new Error("'" + name + "' 탭이 없습니다. 메뉴 ① 연동 탭 만들기를 먼저 실행하세요.");
  return sh;
}
function styleHeader_(sh, n) {
  sh.getRange(1, 1, 1, n).setFontWeight('bold').setBackground('#e8eefc');
  sh.setFrozenRows(1);
}
function firstDates_() {
  const sh = surveySS_().getSheetByName(TAB.INTERVIEWS);
  const out = {};
  if (!sh) return out;
  readTable_(sh, INTERVIEW_COLS).rows.forEach(function (r) {
    const no = String(r.data.studentNo), d = r.data.date;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return;
    if (!out[no] || d < out[no]) out[no] = d;
  });
  return out;
}

// ===================== 동기화 상태 =====================
function ensureStateSheet_() {
  const ss = surveySS_();
  let sh = ss.getSheetByName(TAB.STATE);
  if (!sh) { sh = ss.insertSheet(TAB.STATE); sh.getRange(1, 1, 1, 4).setValues([['종류', 'ID', '해시', '동기화 시각(ms)']]); sh.hideSheet(); }
  return sh;
}
function readState_(kind) {
  const sh = ensureStateSheet_();
  const out = {};
  const last = sh.getLastRow();
  if (last < 2) return out;
  sh.getRange(2, 1, last - 1, 4).getValues().forEach(function (r) { if (r[0] === kind) out[String(r[1])] = { hash: String(r[2]), at: Number(r[3]) }; });
  return out;
}
function writeState_(kind, map) {
  const sh = ensureStateSheet_();
  const last = sh.getLastRow();
  const keep = last >= 2 ? sh.getRange(2, 1, last - 1, 4).getValues().filter(function (r) { return r[0] !== kind && r[0] !== ''; }) : [];
  const rows = keep.concat(Object.keys(map).map(function (id) { return [kind, id, map[id].hash, map[id].at]; }));
  if (last >= 2) sh.getRange(2, 1, last - 1, 4).clearContent();
  if (rows.length) sh.getRange(2, 1, rows.length, 4).setValues(rows);
}
function log_(reason, r) {
  const ss = surveySS_();
  let sh = ss.getSheetByName(TAB.LOG);
  if (!sh) { sh = ss.insertSheet(TAB.LOG); sh.getRange(1, 1, 1, 7).setValues([['시각', '계기', '종류', '시트→앱', '앱→시트', '새로 추가', '삭제/오류']]); sh.hideSheet(); }
  const changed = r.pushed + r.pulled + r.created + r.deleted;
  if (!changed && !r.errors.length && (String(reason).indexOf('정기 대조') === 0 || String(r.kinds) === 'bookings')) return;
  sh.insertRowAfter(1);
  sh.getRange(2, 1, 1, 7).setValues([[new Date(), reason, r.kinds.join(','), r.pushed, r.pulled, r.created, (r.deleted || 0) + (r.errors.length ? ' / ' + r.errors.join('; ') : '')]]);
  if (sh.getLastRow() > 500) sh.deleteRows(501, sh.getLastRow() - 500);
}
function summary_(r) {
  return '[스크립트 ' + SCRIPT_VERSION + ']\n' +
    '시트→앱 ' + r.pushed + '건, 앱→시트 ' + r.pulled + '건, 새로 추가 ' + r.created + '건, 삭제 ' + r.deleted + '건' +
    (r.errors.length ? '\n오류: ' + r.errors.join('\n') : '');
}

// ===================== Firebase (REST) =====================
function fbToken_() {
  const cache = CacheService.getScriptCache();
  const cached = cache.get('ID_TOKEN');
  if (cached) return cached;
  const props = PropertiesService.getScriptProperties();
  const email = props.getProperty('SYNC_EMAIL'), pw = props.getProperty('SYNC_PASSWORD');
  if (!email || !pw) throw new Error('동기화 계정이 설정되지 않았습니다 (메뉴 ② 앱 연결 설정).');
  const res = UrlFetchApp.fetch('https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=' + CONFIG.FIREBASE_API_KEY, {
    method: 'post', contentType: 'application/json', muteHttpExceptions: true,
    payload: JSON.stringify({ email: email, password: pw, returnSecureToken: true })
  });
  const data = JSON.parse(res.getContentText());
  if (!data.idToken) throw new Error('Firebase 로그인 실패: ' + ((data.error && data.error.message) || res.getResponseCode()));
  cache.put('ID_TOKEN', data.idToken, 3000);
  return data.idToken;
}
function fsBase_() { return 'https://firestore.googleapis.com/v1/projects/' + CONFIG.FIREBASE_PROJECT_ID + '/databases/(default)/documents/'; }
function fsList_(collection) {
  const out = [];
  let pageToken = '';
  do {
    const res = UrlFetchApp.fetch(fsBase_() + collection + '?pageSize=300' + (pageToken ? '&pageToken=' + encodeURIComponent(pageToken) : ''), {
      headers: { Authorization: 'Bearer ' + fbToken_() }, muteHttpExceptions: true
    });
    const data = JSON.parse(res.getContentText() || '{}');
    if (res.getResponseCode() >= 300) throw new Error('Firestore 읽기 실패(' + collection + '): ' + ((data.error && data.error.message) || res.getResponseCode()));
    (data.documents || []).forEach(function (d) { out.push({ id: d.name.split('/').pop(), fields: fromFsFields_(d.fields || {}) }); });
    pageToken = data.nextPageToken || '';
  } while (pageToken);
  return out;
}
// 면접 기록에 실제로 쓴 내용이 있는가 (있으면 자동 정리·덮어쓰기 대상에서 제외)
function hasRecord_(m) {
  if (!m) return false;
  const keys = ['questions', 'answerSummary', 'good', 'improve', 'nextGoal'];
  for (let i = 0; i < keys.length; i++) if (String(m[keys[i]] || '').trim()) return true;
  return m.planned === false;
}
function fsGet_(path) {
  const res = UrlFetchApp.fetch(fsBase_() + path, { headers: { Authorization: 'Bearer ' + fbToken_() }, muteHttpExceptions: true });
  if (res.getResponseCode() === 404) return null;
  const data = JSON.parse(res.getContentText() || '{}');
  if (res.getResponseCode() >= 300) throw new Error('Firestore 읽기 실패(' + path + '): ' + ((data.error && data.error.message) || res.getResponseCode()));
  return fromFsFields_(data.fields || {});
}
// 한 필드 조건 + 같은 필드 오름차순 (색인 추가 필요 없음)
function fsQuery_(collection, field, op, value, limit) {
  const res = UrlFetchApp.fetch(fsBase_().replace(/\/$/, '') + ':runQuery', {
    method: 'post', contentType: 'application/json', muteHttpExceptions: true,
    headers: { Authorization: 'Bearer ' + fbToken_() },
    payload: JSON.stringify({ structuredQuery: {
      from: [{ collectionId: collection }],
      where: { fieldFilter: { field: { fieldPath: field }, op: op, value: toFsValue_(value) } },
      orderBy: [{ field: { fieldPath: field }, direction: 'ASCENDING' }],
      limit: limit || 500
    } })
  });
  const data = JSON.parse(res.getContentText() || '[]');
  if (res.getResponseCode() >= 300) throw new Error('Firestore 조회 실패(' + collection + '): ' + ((data.error && data.error.message) || (data[0] && data[0].error && data[0].error.message) || res.getResponseCode()));
  return (data || []).filter(function (x) { return x.document; }).map(function (x) {
    return { id: x.document.name.split('/').pop(), fields: fromFsFields_(x.document.fields || {}) };
  });
}
function fsPatchReq_(path, obj, mask) {
  let url = fsBase_() + path;
  if (mask) url += '?' + mask.map(function (f) { return 'updateMask.fieldPaths=' + encodeURIComponent(f); }).join('&');
  return { url: url, method: 'patch', contentType: 'application/json', payload: JSON.stringify({ fields: toFsFields_(obj) }), muteHttpExceptions: true };
}
function fsDeleteReq_(path) { return { url: fsBase_() + path, method: 'delete', muteHttpExceptions: true }; }
// 앱의 브라우저 캐시가 바뀐 목록을 다시 받도록 meta/versions 에 표시 (시트 쪽 변경은 s_목록 필드)
const CACHED_ = ['students', 'staff', 'interviews', 'meetings', 'questions', 'availability'];
function bumpMeta_(reqs) {
  const cols = {}, deleted = {};
  reqs.forEach(function (r) {
    const path = String(r.url).split('/documents/')[1].split('?')[0];
    const parts = path.split('/'), c = parts[0];
    if (CACHED_.indexOf(c) < 0) return;
    cols[c] = true;
    if (r.method === 'delete' && parts.length === 2 && (c === 'meetings' || c === 'interviews')) {
      (deleted[c] = deleted[c] || {})[parts[1]] = Date.now();
    }
  });
  const names = Object.keys(cols);
  if (!names.length) return;
  const obj = {}, mask = [];
  names.forEach(function (c) { obj['s_' + c] = Date.now(); mask.push('s_' + c); });
  Object.keys(deleted).forEach(function (c) {
    obj.deleted = obj.deleted || {};
    obj.deleted[c] = deleted[c];
    Object.keys(deleted[c]).forEach(function (id) { mask.push('deleted.' + c + '.`' + id + '`'); });
  });
  const req = fsPatchReq_('meta/versions', obj, mask);
  req.headers = { Authorization: 'Bearer ' + fbToken_() };
  try { UrlFetchApp.fetch(req.url, req); } catch (err) { /* 표시 실패는 캐시가 12시간 뒤 새로 받으므로 무시 */ }
}
function fsBatch_(reqs) {
  if (!reqs.length) return;
  const token = fbToken_();
  const all = reqs.slice();
  for (let i = 0; i < reqs.length; i += 20) {
    const chunk = reqs.slice(i, i + 20).map(function (r) { r.headers = { Authorization: 'Bearer ' + token }; return r; });
    const res = UrlFetchApp.fetchAll(chunk);
    res.forEach(function (x, j) {
      if (x.getResponseCode() >= 300) {
        let msg = x.getResponseCode();
        try { msg = JSON.parse(x.getContentText()).error.message; } catch (e) {}
        throw new Error('Firestore 쓰기 실패: ' + msg + ' (' + chunk[j].url.split('/documents/')[1] + ')');
      }
    });
  }
  bumpMeta_(all);
}
function toFsValue_(v) {
  if (v === null || v === undefined) return { nullValue: null };
  if (typeof v === 'boolean') return { booleanValue: v };
  if (typeof v === 'number') return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
  if (Array.isArray(v)) return { arrayValue: { values: v.map(toFsValue_) } };
  if (v instanceof Date) return { timestampValue: v.toISOString() };
  if (typeof v === 'object') return { mapValue: { fields: toFsFields_(v) } };
  return { stringValue: String(v) };
}
function toFsFields_(o) { const f = {}; Object.keys(o).forEach(function (k) { f[k] = toFsValue_(o[k]); }); return f; }
function fromFsValue_(v) {
  if ('stringValue' in v) return v.stringValue;
  if ('integerValue' in v) return Number(v.integerValue);
  if ('doubleValue' in v) return v.doubleValue;
  if ('booleanValue' in v) return v.booleanValue;
  if ('nullValue' in v) return null;
  if ('timestampValue' in v) return new Date(v.timestampValue).getTime();
  if ('arrayValue' in v) return (v.arrayValue.values || []).map(fromFsValue_);
  if ('mapValue' in v) return fromFsFields_(v.mapValue.fields || {});
  return null;
}
function fromFsFields_(f) { const o = {}; Object.keys(f).forEach(function (k) { o[k] = fromFsValue_(f[k]); }); return o; }

// ===================== 백업 (구글 드라이브) =====================
// 매주 일요일 6시(메뉴 ③ 설치 시) + 메뉴/앱에서 즉시. 이 스크립트 소유자의 드라이브 '면접 스튜디오 백업' 폴더에 JSON 저장, 최근 8개 보관.
const BACKUP_COLLECTIONS = ['students', 'staff', 'accounts', 'logins', 'interviews', 'studentNotes', 'questions',
  'sessions', 'meetings', 'bookings', 'bookingLogs', 'days', 'availability', 'meta'];
const BACKUP_KEEP = 8;
function menuBackupNow() {
  const r = weeklyBackup();
  SpreadsheetApp.getUi().alert('백업 완료', r.file + '\n' + r.total + '건 저장 (드라이브 > 면접 스튜디오 백업)', SpreadsheetApp.getUi().ButtonSet.OK);
}
function weeklyBackup() {
  const data = { app: '면접 스튜디오', exportedAt: new Date().toISOString(), project: CONFIG.FIREBASE_PROJECT_ID, collections: {} };
  const counts = {};
  BACKUP_COLLECTIONS.forEach(function (c) {
    data.collections[c] = fsList_(c).map(function (d) { return stripSecret_(Object.assign({ _id: d.id }, d.fields)); });
    counts[c] = data.collections[c].length;
  });
  data.collections.personalQuestions = fsGroup_('personalQuestions').map(function (d) { return stripSecret_(Object.assign({ _id: d.id, _parent: d.parent }, d.fields)); });
  counts.personalQuestions = data.collections.personalQuestions.length;
  const sched = fsGet_('config/schedule');
  data.collections.config = sched ? [Object.assign({ _id: 'schedule' }, sched)] : [];
  const total = Object.keys(counts).reduce(function (a, k) { return a + counts[k]; }, 0);
  const folder = backupFolder_();
  const name = '면접스튜디오_백업_' + Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd_HHmm') + '.json';
  const file = folder.createFile(name, JSON.stringify(data), 'application/json');
  // 오래된 백업 정리
  const files = [];
  const it = folder.getFiles();
  while (it.hasNext()) { const f = it.next(); if (String(f.getName()).indexOf('면접스튜디오_백업_') === 0) files.push(f); }
  files.sort(function (a, b) { return String(b.getName()).localeCompare(String(a.getName())); });
  files.slice(BACKUP_KEEP).forEach(function (f) { f.setTrashed(true); });
  const info = { at: Date.now(), file: name, total: total, counts: counts, by: '드라이브 자동 백업' };
  fsBatch_([fsPatchReq_('meta/backup', info, null)]);
  log_('백업', { pushed: 0, pulled: total, created: 1, deleted: 0, errors: [], kinds: ['backup'] });
  return info;
}
function backupFolder_() {
  const it = DriveApp.getFoldersByName('면접 스튜디오 백업');
  return it.hasNext() ? it.next() : DriveApp.createFolder('면접 스튜디오 백업');
}
function stripSecret_(o) { delete o.initialPw; delete o.token; return o; }
// 하위 컬렉션 전체(예: 모든 학생의 personalQuestions) 한 번에 읽기
function fsGroup_(collectionId) {
  const res = UrlFetchApp.fetch(fsBase_().replace(/\/$/, '') + ':runQuery', {
    method: 'post', contentType: 'application/json', muteHttpExceptions: true,
    headers: { Authorization: 'Bearer ' + fbToken_() },
    payload: JSON.stringify({ structuredQuery: { from: [{ collectionId: collectionId, allDescendants: true }] } })
  });
  const data = JSON.parse(res.getContentText() || '[]');
  if (res.getResponseCode() >= 300) throw new Error('Firestore 조회 실패(' + collectionId + '): ' + ((data.error && data.error.message) || (data[0] && data[0].error && data[0].error.message) || res.getResponseCode()));
  return (data || []).filter(function (x) { return x.document; }).map(function (x) {
    const parts = x.document.name.split('/documents/')[1].split('/');
    return { id: parts[parts.length - 1], parent: parts.slice(0, -2).join('/'), fields: fromFsFields_(x.document.fields || {}) };
  });
}

// ===================== 기타 =====================
function runLocked_(fn) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(25000)) return false;
  try { fn(); } finally { lock.releaseLock(); }
  return true;
}
function checkToken_(t) {
  const token = PropertiesService.getScriptProperties().getProperty('TOKEN');
  return !!token && t === token;
}
function json_(o) { return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON); }
function hash_(o) {
  const bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.MD5, JSON.stringify(o), Utilities.Charset.UTF_8);
  return Utilities.base64Encode(bytes).slice(0, 12);
}
function pick_(o, fields) { const r = {}; fields.forEach(function (f) { r[f] = o[f] == null ? '' : String(o[f]); }); return r; }
function uniq_(a) { return a.filter(function (x, i) { return a.indexOf(x) === i; }); }
function clean_(v) { const s = String(v == null ? '' : v).trim(); return (s === '미정' || s === '-') ? '' : s; }
// 학반 값 바로잡기.
// 시트에 '3-2' 를 치면 날짜(2026-03-02)가 되고, 그게 그대로 앱까지 올라가 있다.
// 날짜든 '2026-03-02' 같은 글자든 '3-2' 로 되돌리고, 그래도 이상하면 학번에서 만든다.
function clsOf_(v, no) {
  if (v instanceof Date) return (v.getMonth() + 1) + '-' + v.getDate();
  const t = String(v == null ? '' : v).trim();
  if (/^\d-\d{1,2}$/.test(t)) return t;                       // 이미 '3-2'
  const m = t.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);         // 시트가 날짜로 바꾼 것
  if (m) return Number(m[2]) + '-' + Number(m[3]);
  return no ? classOf_(no) : t;
}
function classOf_(no) { no = String(no); return no ? no.charAt(0) + '-' + Number(no.slice(1, no.length - 2)) : ''; }
function colOf_(cols, key) { for (let i = 0; i < cols.length; i++) if (cols[i][1] === key) return i + 1; return -1; }
function colLetter_(n) { let s = ''; while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); } return s; }
function fmtDay_(v) {
  if (v instanceof Date) return Utilities.formatDate(v, Session.getScriptTimeZone(), 'yyyy-MM-dd');
  const m = String(v || '').match(/(\d{4})\D+(\d{1,2})\D+(\d{1,2})/);
  return m ? m[1] + '-' + ('0' + m[2]).slice(-2) + '-' + ('0' + m[3]).slice(-2) : String(v || '').trim();
}
function parseDay_(v) {
  if (v instanceof Date) return v;
  const m = String(v || '').match(/(\d{4})\D+(\d{1,2})\D+(\d{1,2})/);
  return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : null;
}
function normalizeFormat_(v) {
  const s = String(v || '');
  if (/복합/.test(s)) return '복합형';
  const out = [];
  if (/학생부|생기부|서류/.test(s)) out.push('학생부 기반');
  if (/제시문|교과\s*면접/.test(s)) out.push('제시문');
  if (/인성|인적성|교직/.test(s)) out.push('기본 인성');
  if (/MMI|상황/i.test(s)) out.push('MMI');
  return out.length ? out.join('+') : (s.trim() ? '기타' : '');
}
