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
 */

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
  MEETINGS: '모의 면접 기록'   // 통합 플랫폼 파일 안
};

const STUDENT_COLS = [
  ['학번', 'studentNo'], ['이름', 'name'], ['반', 'cls'], ['우선도', 'priority'],
  ['기본 트랙', 'track'], ['특별 트랙', 'special'],
  ['1차 담임', 's1'], ['2차 교과', 's2'], ['3차 1위원', 's3a'], ['3차 2위원', 's3b'],
  ['준비 시트', 'sheetUrl'], ['최초 면접일', '_first'], ['다음 면접일', '_next'],
  ['수정 시각', '_stamp'], ['수정자', '_by']
];
const INTERVIEW_COLS = [
  ['학번', 'studentNo'], ['이름', 'name'], ['대학', 'univ'], ['학과', 'dept'], ['전형', 'admission'],
  ['면접 유형', 'format'], ['면접일', 'date'], ['수정 시각', '_stamp'], ['수정자', '_by'], ['행ID', 'id']
];
const MEETING_COLS = [
  ['학반', 'cls'], ['학번', 'studentNo'], ['이름', 'name'], ['면접 유형', 'type'],
  ['담당교사', 'teachers'], ['실시일', 'date'], ['회차', 'round'], ['기록ID', 'id']
];
const STUDENT_SYNC = ['name', 'cls', 'priority', 'track', 'special', 's1', 's2', 's3a', 's3b', 'sheetUrl'];
const INTERVIEW_SYNC = ['studentNo', 'name', 'univ', 'dept', 'admission', 'format', 'date'];
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
  ScriptApp.newTrigger('onSurveyEdit').forSpreadsheet(SpreadsheetApp.getActive()).onEdit().create();
  ScriptApp.newTrigger('onPlatformEdit').forSpreadsheet(CONFIG.PLATFORM_SHEET_ID).onEdit().create();
  ScriptApp.newTrigger('timedSync').timeBased().everyMinutes(30).create();
  const r = syncAll_('트리거 설치');
  SpreadsheetApp.getUi().alert('자동 동기화를 켰습니다.\n' + summary_(r));
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
  runLocked_(function () {
    const kinds = name === TAB.STUDENTS ? ['students'] : ['interviews'];
    syncKinds_(kinds, '시트 편집');
  });
}
function onPlatformEdit(e) {
  if (e.range.getSheet().getName() !== TAB.MEETINGS) return;
  runLocked_(function () { syncKinds_(['meetings'], '시트 편집'); });
}
// 정기 대조: 30분마다, 밤(22시~7시)에는 쉼 — Firestore 무료 읽기 한도(하루 5만 건) 안에서 돌도록
function timedSync() {
  const h = Number(Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'H'));
  if (h < 7 || h >= 22) return;
  runLocked_(function () { syncAll_('정기 대조'); });
}

// ===================== 웹 앱 (앱 → 시트) =====================
function doGet(e) {
  const p = (e && e.parameter) || {};
  if (!checkToken_(p.token)) return json_({ ok: false, error: '토큰이 맞지 않습니다.' });
  try {
    const ss = SpreadsheetApp.getActive();
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
  if (!checkToken_(body.token)) return json_({ ok: false, error: '토큰이 맞지 않습니다.' });
  const kinds = (body.kinds || ['students', 'interviews', 'meetings']).filter(function (k) { return ['students', 'interviews', 'meetings'].indexOf(k) >= 0; });
  let result;
  const locked = runLocked_(function () { result = syncKinds_(kinds, '앱 요청'); });
  if (!locked) return json_({ ok: false, error: '다른 동기화가 진행 중입니다. 잠시 후 자동 반영됩니다.' });
  return json_({ ok: !result.errors.length, result: result, error: result.errors.join(' / ') });
}

// ===================== 동기화 본체 =====================
function syncAll_(reason) { return syncKinds_(['students', 'interviews', 'meetings'], reason); }

let LIST_CACHE_ = {};
function fsListCached_(c) { if (!LIST_CACHE_[c]) LIST_CACHE_[c] = fsList_(c); return LIST_CACHE_[c]; }

function syncKinds_(kinds, reason) {
  LIST_CACHE_ = {};
  const out = { pushed: 0, pulled: 0, created: 0, deleted: 0, errors: [], kinds: kinds };
  kinds.forEach(function (k) {
    try {
      const r = k === 'students' ? mergeStudents_() : k === 'interviews' ? mergeInterviews_() : mergeMeetings_();
      out.pushed += r.pushed; out.pulled += r.pulled; out.created += r.created; out.deleted += r.deleted;
      if (k === 'interviews' && (r.pushed + r.pulled + r.created + r.deleted) > 0) {
        try { rebuildCalendar(); } catch (err) { out.errors.push('달력: ' + err.message); }
      }
    } catch (err) {
      out.errors.push(k + ': ' + (err.message || err));
    }
  });
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
  const sh = getOrThrow_(SpreadsheetApp.getActive(), TAB.STUDENTS);
  const table = readTable_(sh, STUDENT_COLS);
  const rows = table.rows.filter(function (r) { return r.data.studentNo; }).map(function (r) {
    r.id = String(r.data.studentNo); return r;
  });
  const docs = {}, raw = {};
  fsListCached_('students').forEach(function (d) {
    const f = d.fields;
    raw[d.id] = f;
    docs[d.id] = {
      id: d.id, at: Number(f.syncFieldsAt || 0),
      data: {
        studentNo: d.id, name: f.name || '', cls: f.cls || '', priority: f.priority || '', track: f.track || '',
        special: f.special || '', s1: (f.assign || {}).s1 || '', s2: (f.assign || {}).s2 || '',
        s3a: (f.assign || {}).s3a || '', s3b: (f.assign || {}).s3b || '', sheetUrl: f.sheetUrl || ''
      }
    };
  });
  const firstByNo = firstDates_();
  const writes = [], appends = [];
  const res = merge_('students', rows, docs, STUDENT_SYNC, {
    newId: function (row) { return String(row.data.studentNo); },
    push: function (row) {
      const d = row.data;
      const no = String(d.studentNo);
      writes.push(fsPatchReq_('students/' + no, {
        studentNo: no, name: d.name, cls: d.cls || classOf_(no), priority: d.priority, track: d.track, special: d.special,
        assign: { s1: d.s1, s2: d.s2, s3a: d.s3a, s3b: d.s3b }, sheetUrl: d.sheetUrl,
        firstInterview: firstByNo[no] || '', syncFieldsAt: row.stamp || Date.now(), syncedBy: row.by || '시트'
      }, ['studentNo', 'name', 'cls', 'priority', 'track', 'special', 'assign', 'sheetUrl', 'firstInterview', 'syncFieldsAt', 'syncedBy']));
    },
    pull: function (doc, row) {
      const vals = doc.data;
      if (row) table.setRow(row.rowNum, vals, '앱');
      else appends.push(vals);
    },
    rowOnlyInState: function () { return 'keep'; },        // 학생은 앱에서 지우지 않으므로 다시 올림
    docOnlyInState: function () { return 'ignore'; },      // 시트에서 행을 지워도 앱 학생은 유지
    docOnlyNew: function () { return 'append'; },
    deleteDoc: function () {},
    flush: function () {}
  });
  appends.forEach(function (v) { table.appendRow(v, '앱'); });
  table.ensureFormulas();
  fsBatch_(writes);
  // 수요조사 응답의 희망 교과·준비 정도·도움 필요·전달 메모 (시트 → 앱 한 방향, 바뀐 것만)
  const survey = readSurvey_(SpreadsheetApp.getActive());
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
  const sh = getOrThrow_(SpreadsheetApp.getActive(), TAB.INTERVIEWS);
  const table = readTable_(sh, INTERVIEW_COLS);
  const rows = table.rows.filter(function (r) { return r.data.studentNo || r.data.univ || r.data.date; });
  const docs = {};
  fsList_('interviews').forEach(function (d) {
    const f = d.fields;
    docs[d.id] = { id: d.id, at: Number(f.updatedAt || 0), data: {
      id: d.id, studentNo: String(f.studentNo || ''), name: f.name || '', univ: f.univ || '', dept: f.dept || '',
      admission: f.admission || '', format: f.format || '', date: f.date || ''
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
        format: d.format, date: d.date, updatedAt: row.stamp || Date.now(), updatedBy: row.by || '시트'
      }, null));
    },
    pull: function (doc, row) {
      touched[doc.data.studentNo] = true;
      if (row) table.setRow(row.rowNum, doc.data, '앱'); else table.appendRow(doc.data, '앱');
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

// ---------- 모의 면접 기록 (통합 플랫폼 파일) ----------
function mergeMeetings_() {
  const sh = getMeetingSheet_();
  if (!sh) throw new Error("통합 플랫폼 파일에서 '모의 면접 기록' 탭을 찾지 못했습니다.");
  const table = readTable_(sh, MEETING_COLS, { findHeader: true });
  const rows = table.rows.filter(function (r) { return r.data.studentNo; });
  const students = {};
  fsListCached_('students').forEach(function (d) { students[d.id] = d.fields; });
  const docs = {};
  fsList_('meetings').forEach(function (d) {
    const f = d.fields;
    docs[d.id] = { id: d.id, at: Number(f.updatedAtMs || 0), raw: f, data: {
      id: d.id, studentNo: String(f.studentNo || ''), name: f.name || '', cls: f.cls || '',
      type: f.type || '', teachers: (f.teachers || []).join(', '), date: f.date || '', stage: f.stage || 4
    } };
  });
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
        studentNo: no, name: d.name || st.name || '', cls: d.cls || st.cls || classOf_(no), type: d.type,
        teachers: String(d.teachers || '').split(/\s*[,，·]\s*/).filter(String), date: d.date,
        updatedAtMs: row.stamp || Date.now()
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
        if (Number(r.data.round) !== i + 1) table.setCell(r.rowNum, 'round', i + 1);
        const d = docs[r.data.id];
        if (d && Number(d.raw.round) !== i + 1) roundWrites.push(fsPatchReq_('meetings/' + r.data.id, { round: i + 1 }, ['round']));
      });
  });
  fsBatch_(roundWrites);
  return res;
}

// ===================== 연동 탭 만들기 =====================
function buildLinkTabs_() {
  const ss = SpreadsheetApp.getActive();
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
  const ss = SpreadsheetApp.getActive();
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
  const ss = SpreadsheetApp.getActive();
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

// ===================== 시트 표 도우미 =====================
function readTable_(sh, cols, opt) {
  opt = opt || {};
  const api = {};
  function load() {
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
  api.setCell = function (rowNum, key, value) { sh.getRange(rowNum, api.map[key] + 1).setValue(value); };
  api.setRow = function (rowNum, data, by) {
    cols.forEach(function (c) {
      const k = c[1];
      if (k.charAt(0) === '_' || !(k in data)) return;
      sh.getRange(rowNum, api.map[k] + 1).setValue(toCell_(k, data[k]));
    });
    if (api.map._stamp != null) sh.getRange(rowNum, api.map._stamp + 1).setValue(new Date());
    if (api.map._by != null && by) sh.getRange(rowNum, api.map._by + 1).setValue(by);
  };
  api.appendRow = function (data, by) {
    const width = Math.max.apply(null, Object.keys(api.map).map(function (k) { return api.map[k]; })) + 1;
    const line = new Array(width).fill('');
    cols.forEach(function (c) { if (c[1] in data && c[1].charAt(0) !== '_') line[api.map[c[1]]] = toCell_(c[1], data[c[1]]); });
    if (api.map._stamp != null) line[api.map._stamp] = new Date();
    if (api.map._by != null) line[api.map._by] = by || '';
    const target = nextEmptyRow_(sh, api.headerRow, api.map.studentNo);
    sh.getRange(target, 1, 1, width).setValues([line]);
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

function normCell_(key, v) {
  if (v === null || v === undefined) return '';
  if (key === 'date') return fmtDay_(v);
  if (key === 'studentNo') return String(v).replace(/\.0$/, '').trim();
  if (v instanceof Date) return fmtDay_(v);
  return String(v).trim();
}
function toCell_(key, v) {
  if (key === 'date') return parseDay_(v) || v || '';
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
  const sh = SpreadsheetApp.getActive().getSheetByName(TAB.INTERVIEWS);
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
  const ss = SpreadsheetApp.getActive();
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
  const ss = SpreadsheetApp.getActive();
  let sh = ss.getSheetByName(TAB.LOG);
  if (!sh) { sh = ss.insertSheet(TAB.LOG); sh.getRange(1, 1, 1, 7).setValues([['시각', '계기', '종류', '시트→앱', '앱→시트', '새로 추가', '삭제/오류']]); sh.hideSheet(); }
  const changed = r.pushed + r.pulled + r.created + r.deleted;
  if (!changed && !r.errors.length && reason === '정기 대조') return;
  sh.insertRowAfter(1);
  sh.getRange(2, 1, 1, 7).setValues([[new Date(), reason, r.kinds.join(','), r.pushed, r.pulled, r.created, (r.deleted || 0) + (r.errors.length ? ' / ' + r.errors.join('; ') : '')]]);
  if (sh.getLastRow() > 500) sh.deleteRows(501, sh.getLastRow() - 500);
}
function summary_(r) {
  return '시트→앱 ' + r.pushed + '건, 앱→시트 ' + r.pulled + '건, 새로 추가 ' + r.created + '건, 삭제 ' + r.deleted + '건' +
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
function fsPatchReq_(path, obj, mask) {
  let url = fsBase_() + path;
  if (mask) url += '?' + mask.map(function (f) { return 'updateMask.fieldPaths=' + encodeURIComponent(f); }).join('&');
  return { url: url, method: 'patch', contentType: 'application/json', payload: JSON.stringify({ fields: toFsFields_(obj) }), muteHttpExceptions: true };
}
function fsDeleteReq_(path) { return { url: fsBase_() + path, method: 'delete', muteHttpExceptions: true }; }
function fsBatch_(reqs) {
  if (!reqs.length) return;
  const token = fbToken_();
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
