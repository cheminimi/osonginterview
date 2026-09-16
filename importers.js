// 구글 시트에서 복사해 붙여넣은 표를 읽는 도구 모음 (브라우저·Node 모두에서 동작하는 순수 함수)

// ---- 탭 구분 텍스트 파서: 셀 안 줄바꿈("…") 처리
export function parseTSV(text) {
  const rows = []; let row = [], cell = "", q = false;
  const s = String(text).replace(/\r\n?/g, "\n");
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) {
      if (c === '"') { if (s[i + 1] === '"') { cell += '"'; i++; } else q = false; }
      else cell += c;
    } else if (c === '"' && cell === "") q = true;
    else if (c === "\t") { row.push(cell); cell = ""; }
    else if (c === "\n") { row.push(cell); rows.push(row); row = []; cell = ""; }
    else cell += c;
  }
  if (cell !== "" || row.length) { row.push(cell); rows.push(row); }
  // 탭이 하나도 없으면 쉼표 구분으로 재시도
  if (rows.every((r) => r.length <= 1) && s.includes(",")) return s.split("\n").map((l) => l.split(",").map((x) => x.trim()));
  return rows.map((r) => r.map((x) => x.trim()));
}

const HEADER_WORDS = new Set(["우선도", "학번", "교사명", "타임스탬프", "번호", "학반"]);
const norm = (h) => String(h || "").replace(/^\d+\\?\.\s*/, "").replace(/\s+/g, "").toLowerCase();
const isEmpty = (v) => v == null || v === "" || v === "-" || v === "미정" || v === "없음";
const clean = (v) => (isEmpty(v) ? "" : String(v).trim());

export function parseDate(v) {
  const m = String(v || "").match(/(\d{4})\D+(\d{1,2})\D+(\d{1,2})/);
  if (!m) return "";
  return `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}`;
}
// '2026. 9. 7 오후 4:51:34' 같은 구글 폼 타임스탬프
export function parseTimestamp(v) {
  const m = String(v || "").match(/(\d{4})\D+(\d{1,2})\D+(\d{1,2})\D*?(오전|오후)?\s*(\d{1,2}):(\d{2})(?::(\d{2}))?/);
  if (!m) return 0;
  let h = +m[5];
  if (m[4] === "오후" && h < 12) h += 12;
  if (m[4] === "오전" && h === 12) h = 0;
  return new Date(+m[1], +m[2] - 1, +m[3], h, +m[6], +(m[7] || 0)).getTime();
}
export function normStudentNo(v) {
  const m = String(v || "").match(/\d{4,5}/);
  return m ? m[0] : "";
}
export function classOf(no) {
  if (!no) return "";
  return `${no[0]}-${Number(no.slice(1, no.length - 2))}`;
}

/**
 * 헤더 행을 찾아 표를 객체 배열로. 같은 붙여넣기 안에 표가 여러 개(헤더 반복)여도 처리.
 * spec: { field: [헤더 후보들...] }, required: 필수 field 목록
 * onSection(title): 헤더가 아닌 한 칸짜리 제목행을 만나면 호출 (예: '기본 인성 면접 준비 학생별 링크')
 */
export function readTable(text, spec, required = []) {
  const rows = parseTSV(text);
  let map = null, section = "";
  const out = [];
  for (const r of rows) {
    const cells = r.map(norm);
    // 헤더 판정: 필수 필드가 모두 이 행에서 발견되면 헤더
    const tryMap = {};
    for (const [field, cands] of Object.entries(spec)) {
      const cn = cands.map(norm);
      let idx = cells.findIndex((c) => cn.includes(c));
      if (idx < 0) idx = cells.findIndex((c) => c && cn.some((x) => x.length >= 3 && c.includes(x)));
      if (idx >= 0) tryMap[field] = idx;
    }
    if (required.every((f) => f in tryMap) && Object.keys(tryMap).length >= Math.max(2, required.length)) {
      map = tryMap; continue;
    }
    // 다른 표의 헤더를 만나면 현재 표 읽기를 멈춘다
    if (map && r.some((x) => HEADER_WORDS.has(norm(x)))) { map = null; continue; }
    const nonEmpty = r.filter((x) => x);
    if (nonEmpty.length === 1 && !/^\d{4,5}$/.test(nonEmpty[0])) { section = nonEmpty[0]; continue; }
    if (!map) continue;
    const o = { _section: section };
    for (const [f, i] of Object.entries(map)) o[f] = r[i] ?? "";
    if (required.some((f) => !String(o[f] || "").trim())) continue;
    out.push(o);
  }
  return { rows: out, headerFound: !!map };
}

// ---- ① 운영 원본: 3회 지도 배정안 / 운영 편성표
const ASSIGN_SPEC = {
  priority: ["우선도"],
  firstInterview: ["최초 면접일"],
  cls: ["반", "학반"],
  studentNo: ["학번"],
  name: ["이름", "학생"],
  track: ["기본 트랙", "면접 트랙"],
  special: ["특별 트랙", "추가 트랙", "특별반"],
  s1: ["1차 담임", "1단계 담당", "1단계(담임)", "담당 담임"],
  s2: ["2차 교과 담당", "2단계 담당(가안)", "2단계(교과지원)"],
  focus2: ["2차 중점"],
  s3a: ["3차 1위원"],
  s3b: ["3차 2위원"],
  focus3: ["3차 중점"],
  note: ["비고"]
};
export function importAssignments(text) {
  const { rows, headerFound } = readTable(text, ASSIGN_SPEC, ["studentNo", "name"]);
  const list = [];
  for (const r of rows) {
    const no = normStudentNo(r.studentNo); if (!no) continue;
    const st = { studentNo: no, name: clean(r.name), cls: classOf(no) };
    if ("priority" in r) st.priority = clean(r.priority);
    if ("firstInterview" in r) st.firstInterview = parseDate(r.firstInterview);
    if ("track" in r && clean(r.track)) st.track = clean(r.track);
    if ("special" in r) st.special = clean(r.special) || "없음";
    const assign = {};
    for (const k of ["s1", "s2", "s3a", "s3b"]) if (k in r) assign[k] = clean(r[k]);
    if (Object.keys(assign).length) st.assign = assign;
    for (const k of ["focus2", "focus3", "note"]) if (k in r && clean(r[k])) st[k] = clean(r[k]);
    list.push(st);
  }
  return { list, headerFound };
}

// ---- ② 학생별 링크 (관리용 시트)
export function importLinks(text) {
  const { rows, headerFound } = readTable(text, {
    cls: ["학반", "반"], studentNo: ["학번"], name: ["이름"], url: ["학생용 링크", "링크"]
  }, ["studentNo", "url"]);
  const list = [];
  for (const r of rows) {
    const no = normStudentNo(r.studentNo);
    const url = (String(r.url).match(/https?:\/\/\S+/) || [])[0];
    if (!no || !url) continue;
    const sheetType = /인성/.test(r._section) ? "기본 인성" : /학생부|생기부/.test(r._section) ? "학생부 기반" : "";
    list.push({ studentNo: no, name: clean(r.name), sheetUrl: url.replace(/\\_/g, "_"), sheetType });
  }
  return { list, headerFound };
}

// ---- ③ 수요조사 응답 (구글 폼 응답 시트)
const SURVEY_SPEC = {
  ts: ["타임스탬프"],
  studentNo: ["학번"],
  name: ["이름"],
  univ: ["지원 대학"],
  dept: ["지원 모집단위(학과)", "모집단위"],
  admission: ["전형명"],
  format: ["해당 전형의 면접 유형을 선택해주세요", "면접 유형"],
  date: ["면접 예정일"],
  subject1: ["면접 준비를 위해 가장 도움받고 싶은 교과를 선택해주세요.", "가장 도움받고 싶은 교과"],
  subject2: ["추가로 도움받고 싶은 교과가 있다면 선택해주세요. (중복 가능)", "추가로 도움받고 싶은"],
  readiness: ["현재 면접 준비 정도는 어느 정도인가요?", "준비 정도"],
  needs: ["현재 가장 도움이 필요한 부분은 무엇인가요?", "도움이 필요한 부분"],
  memo: ["면접 지도와 관련하여 담당 선생님께 미리 전달하고 싶은 내용이 있다면 작성해주세요.", "전달하고 싶은"]
};
export function normalizeFormat(v) {
  const s = String(v || "");
  const out = [];
  if (/학생부|생기부|서류/.test(s)) out.push("학생부 기반");
  if (/제시문|교과\s*면접|교과면접/.test(s)) out.push("제시문");
  if (/인성|인적성|교직/.test(s)) out.push("기본 인성");
  if (/MMI|상황/i.test(s)) out.push("MMI");
  if (/복합/.test(s)) return "복합형";
  return out.length ? out.join("+") : (s.trim() ? "기타" : "");
}
export function importSurvey(text) {
  const { rows, headerFound } = readTable(text, SURVEY_SPEC, ["studentNo", "univ"]);
  const by = new Map();
  const sorted = rows.map((r, i) => ({ ...r, _t: parseTimestamp(r.ts) || i }))
    .sort((a, b) => a._t - b._t);
  for (const r of sorted) {
    const no = normStudentNo(r.studentNo); if (!no) continue;
    const cur = by.get(no) || { studentNo: no, name: clean(r.name), cls: classOf(no), universities: [], needs: new Set(), memos: [] };
    const u = {
      univ: clean(r.univ), dept: clean(r.dept), admission: clean(r.admission),
      format: normalizeFormat(r.format), formatRaw: clean(r.format), date: parseDate(r.date)
    };
    const i = cur.universities.findIndex((x) => x.univ === u.univ && x.dept === u.dept);
    if (i >= 0) cur.universities[i] = u; else cur.universities.push(u);
    if (clean(r.subject1)) cur.subject1 = clean(r.subject1);
    if (clean(r.subject2)) cur.subject2 = clean(r.subject2);
    if (clean(r.readiness)) cur.readiness = clean(r.readiness);
    String(r.needs || "").replace(/전공,\s*교과 개념 점검/g, "전공·교과 개념 점검").split(/,\s*/).map((x) => x.trim()).filter(Boolean).forEach((x) => cur.needs.add(x));
    const memo = clean(r.memo);
    if (memo && !/^(없음|없습니다|x|X|\.)$/.test(memo) && !cur.memos.includes(memo)) cur.memos.push(memo);
    if (clean(r.name)) cur.name = clean(r.name);
    by.set(no, cur);
  }
  const list = [...by.values()].map((s) => ({
    ...s, needs: [...s.needs],
    universities: s.universities.sort((a, b) => (a.date || "9999").localeCompare(b.date || "9999"))
  }));
  return { list, headerFound, responses: rows.length };
}

// ---- ④ 지도교사 명단
export function importStaff(text) {
  const { rows, headerFound } = readTable(text, {
    name: ["교사명", "이름", "교사"], subject: ["교과·역할", "교과", "담당 교과"], loginId: ["로그인ID", "로그인 ID", "ID"]
  }, ["name"]);
  const list = rows
    .map((r) => ({ name: clean(r.name), subject: clean(r.subject), loginId: clean(r.loginId).toLowerCase() }))
    .filter((r) => /^[가-힣]{2,5}$/.test(r.name) && !/교사명|합계|순위|긴급/.test(r.name) && !/^\d{4}\D/.test(r.subject));
  return { list, headerFound };
}

// ---- ⑤ 학생 시트의 '교과 선생님 질문' 표 → 예상질문
export function importSheetQuestions(text) {
  const { rows, headerFound } = readTable(text, {
    no: ["번호"], basis: ["관련 활동·생기부 내용", "관련 활동"], text: ["교사 예상 질문", "예상 질문", "질문"],
    f1: ["꼬리질문 1"], f2: ["꼬리질문 2"], keywords: ["답변 핵심어"]
  }, ["text"]);
  let list;
  if (headerFound) {
    list = rows.map((r) => ({ text: clean(r.text), basis: clean(r.basis).replace(/^\[예시\]\s*/, ""), followUps: [clean(r.f1), clean(r.f2)].filter(Boolean), keywords: clean(r.keywords) }));
  } else {
    // 헤더 없이 질문 열만 붙여넣은 경우: 한 줄 = 질문, 탭 뒤는 꼬리질문
    list = parseTSV(text).map((r) => r.filter(Boolean)).filter((r) => r.length)
      .map((r) => ({ text: r[0], followUps: r.slice(1, 3), basis: "" }));
  }
  list = list.filter((q) => q.text && !/^\[?예시\]?/.test(q.basis || "") && !q.text.includes("격막 전극법"));
  return { list, headerFound };
}
