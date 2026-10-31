// 학생부 열람 · PDF 넣기 · 드래그 질문 (2026-10-30 3단계, spec-stage3)
// - records/{학번}: 가림본 학생부 (배정 선생님 1·2·3차 + 관리자만 읽기, 넣기는 1차 담임·관리자)
// - records/{학번}/marks: 하이라이트·질문 표시 · records/{학번}/pending: '면접 뒤 공개' 질문
// - recordLogs: 열람·넣기·공개 기록 (관리자만 읽기)
// 학생부 글은 브라우저 저장소·캐시 목록·백업에 넣지 않는다. 화면을 닫으면 변수에서도 버린다.
// PDF 는 이 브라우저 안에서만 읽고 어디에도 올리지 않는다 (저장되는 것은 가림본 글뿐).
import {
  db, collection, doc, getDoc, getDocs, setDoc, addDoc, updateDoc, deleteDoc, writeBatch, serverTimestamp,
  $, $$, esc, toast, showError, confirmBox, pqStats, fmtDay, STAGES
} from "./common.js";
import { S, myName, myRoles, studentByNo, closeModal } from "./t-core.js";
import { openMeetingForm, loadMeetingNotes, againList, renderPast } from "./t-meetings.js";

const PDFJS = "lib/pdfjs-3.11.174/";
const IDLE_MS = 5 * 60 * 1000;
const SEC_TITLE = { attend: "출결 상황", creative: "창의적 체험활동", subject: "교과학습발달상황 · 세부능력 및 특기사항", behavior: "행동특성 및 종합의견", grades: "성적" };
const SEC_SHORT = { attend: "출결", creative: "창의적 체험활동", subject: "교과 세특", behavior: "행동특성 및 종합의견", grades: "성적" };
const stageLabel = (k) => STAGES.find((s) => s.key === Number(k))?.label || `${k}차`;

// ================= 누가 볼 수 있나 (화면용 — 규칙에서도 같은 기준으로 막음) =================
const isTeacher = () => S.ctx?.account?.role === "teacher";
export const canSeeRec = (st) => !!st && (!!S.ctx?.isAdmin || (isTeacher() && myRoles(st).length > 0));
export const canUploadRec = (st) => !!st && (!!S.ctx?.isAdmin || (isTeacher() && !!myName() && (st.assign || {}).s1 === myName()));
// 학생부가 있는지: 단추를 그릴 때 한 번만 읽는다 (실패·거부 = 없음). 글은 버리고 있음/없음만 기억
const exists = new Map();
export async function recordExists(no, force = false) {
  if (!force && exists.has(no)) return exists.get(no);
  let ok = false;
  try { ok = (await getDoc(doc(db, "records", no))).exists(); } catch (_) { ok = false; }
  exists.set(no, ok);
  return ok;
}
async function log(no, action) {
  try { await addDoc(collection(db, "recordLogs"), { studentNo: no, by: myName() || S.ctx.user.email, byUid: S.ctx.user.uid, action, at: serverTimestamp() }); }
  catch (e) { console.warn("학생부 기록 남기기", e); }
}

// 학생 상세·일정 상세·오늘 칸의 단추 (볼 수 없는 선생님에게는 그리지 않음)
// viewOnly: [학생부 보기]만 (오늘 칸·일정 상세) · compact: 이름을 '학생부'로 짧게 · before(): 열기 전에 할 일(창 닫기 등)
export async function mountRecButtons(el, st, { stage = 0, preset = null, compact = false, viewOnly = compact, before = null } = {}) {
  if (!el || !st) return;
  const see = canSeeRec(st) && (!stage || S.ctx.isAdmin || myRoles(st).includes(`${stage}차`));
  const up = !viewOnly && canUploadRec(st);
  if (!see && !up) { el.innerHTML = ""; return; }
  const has = await recordExists(st.studentNo);
  if (!el.isConnected) return;
  el.innerHTML = (see && has ? `<button type="button" class="btn-sm rec-open" data-recopen>${compact ? "학생부" : "학생부 보기"}</button>` : "")
    + (up ? `<button type="button" class="btn-sm" data-recup>${has ? "학생부 다시 넣기" : "학생부 넣기"}</button>` : "")
    + (!viewOnly && S.ctx.isAdmin && has ? `<button type="button" class="btn-sm btn-danger" data-recdel>학생부 지우기</button>` : "");
  $("[data-recopen]", el)?.addEventListener("click", (e) => { e.stopPropagation(); before?.(); openRecordViewer(st.studentNo, { stage, preset }); });
  $("[data-recup]", el)?.addEventListener("click", () => openRecordUpload(st.studentNo));
  $("[data-recdel]", el)?.addEventListener("click", () => deleteRecords([st.studentNo]));
}

// ================= 금지 글자 · 자동 가림 =================
const COMMON_GO = ["최고", "참고", "재고", "제고", "보고", "광고", "경고", "사고", "신고", "원고", "고등", "중간", "최초", "당초", "연초", "기초"];
const SCHOOL_AFTER = "(?:에서|에|와|과|의|학생|친구|선배|후배|축제|대회|교사|선생님)";
const isHangul = (c) => !!c && /[가-힣]/.test(c);
const PARTICLE = /^(와|과|이|가|은|는|을|를|의|에게|도|랑|이랑|하고|께|님)/;
function namesList(no) {
  const me = studentByNo(no)?.name || "";
  return [...new Set([...(S.students || []).map((s) => s.name), ...(S.staff || []).map((t) => t.name)])]
    .filter((n) => n && n.length >= 2 && n !== me).sort((a, b) => b.length - a.length);
}
// 글에서 자동으로 가릴 자리 [{start,end,kind,repl}] (겹치면 앞의 것)
export function autoMasks(text, names) {
  const out = [];
  const add = (start, end, kind, repl) => { if (!out.some((m) => start < m.end && end > m.start)) out.push({ start, end, kind, repl, auto: true }); };
  let m;
  const re1 = /[가-힣]*?(?:여자)?(고등학교|중학교|초등학교)/g;
  while ((m = re1.exec(text))) { if (m[0].length > m[1].length) add(m.index, m.index + m[0].length, "school", m[1] === "중학교" ? "○○중" : m[1] === "초등학교" ? "○○초" : "○○고"); }
  const re2 = /오송고(?:등학교)?/g;
  while ((m = re2.exec(text))) add(m.index, m.index + m[0].length, "school", "○○고");
  const re3 = new RegExp(`(?<![가-힣])([가-힣]{2,})(고|중|초)(?=${SCHOOL_AFTER})`, "g");
  while ((m = re3.exec(text))) {
    const word = m[1] + m[2];
    if (COMMON_GO.some((w) => word.endsWith(w))) continue;
    add(m.index, m.index + word.length, "school", "○○" + m[2]);
  }
  for (const n of names) {
    let i = text.indexOf(n);
    while (i >= 0) {
      const prev = text[i - 1], next = text[i + n.length], rest = text.slice(i + n.length);
      const ok = n.length >= 3 ? true : !isHangul(prev) && (!isHangul(next) || PARTICLE.test(rest));
      if (ok) add(i, i + n.length, "name", "○○○");
      i = text.indexOf(n, i + n.length);
    }
  }
  const re4 = /01[016-9][-\s.]?\d{3,4}[-\s.]?\d{4}|0\d{1,2}-\d{3,4}-\d{4}/g;
  while ((m = re4.exec(text))) add(m.index, m.index + m[0].length, "phone", "○○○");
  const re5 = /[\w.+-]+@[\w-]+\.[\w.]+/g;
  while ((m = re5.exec(text))) add(m.index, m.index + m[0].length, "email", "○○○");
  return out.sort((a, b) => a.start - b.start);
}
const applyMasks = (text, masks) => {
  let s = "", at = 0;
  masks.slice().sort((a, b) => a.start - b.start).forEach((m) => { s += text.slice(at, m.start) + m.repl; at = m.end; });
  return s + text.slice(at);
};
// 질문 글에 넣으면 안 되는 것 (이름·학교·가림 표시)
export function badQuestionText(t, no) {
  const s = String(t || "");
  if (/○○|오송|\d{4}\s*[가-힣]{2,3}/.test(s)) return "가림 표시(○○)·학교 이름·학번과 이름은 질문에 넣을 수 없어요.";
  const me = studentByNo(no)?.name;
  if (me && s.includes(me)) return "학생 이름은 질문에 넣을 수 없어요.";
  if (namesList(no).filter((n) => n.length >= 3).some((n) => s.includes(n))) return "다른 사람 이름은 질문에 넣을 수 없어요.";
  if (autoMasks(s, []).some((m) => m.kind === "school")) return "학교 이름은 질문에 넣을 수 없어요.";
  return "";
}

// ================= PDF 읽기 (pdf.js 지연 로드) =================
let pdfLoading = null;
function loadPdfJs() {
  if (window.pdfjsLib) return Promise.resolve(window.pdfjsLib);
  if (pdfLoading) return pdfLoading;
  pdfLoading = new Promise((ok, no) => {
    const s = document.createElement("script");
    s.src = PDFJS + "pdf.min.js";
    s.onload = () => { if (!window.pdfjsLib) return no(new Error("pdf.js 를 불러오지 못했어요")); window.pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS + "pdf.worker.min.js"; ok(window.pdfjsLib); };
    s.onerror = () => { pdfLoading = null; no(new Error("pdf.js 를 불러오지 못했어요")); };
    document.head.append(s);
  });
  return pdfLoading;
}
// 쪽마다 줄 [{text, right, x}] 로
export async function readPdf(buf) {
  const lib = await loadPdfJs();
  const pdf = await lib.getDocument({ data: buf, isEvalSupported: false }).promise;
  const pages = [];
  for (let n = 1; n <= pdf.numPages; n++) {
    const pg = await pdf.getPage(n);
    const tc = await pg.getTextContent();
    // 글자 다듬기: 제어 문자(일부 PDF 는 띄어쓰기를 U+0001 등으로 넣음)는 띄어쓰기로, 한글은 NFC 로
    const clean = (t) => String(t).replace(/[\u0000-\u001f\u007f\u00a0\u2000-\u200b\u3000]/g, " ").normalize("NFC");
    const items = tc.items.filter((it) => it.str && clean(it.str).trim()).map((it) => ({ s: clean(it.str), x: it.transform[4], y: it.transform[5], w: it.width, h: it.height || Math.abs(it.transform[3]) || 10 }));
    items.sort((a, b) => b.y - a.y || a.x - b.x);
    const lines = [];
    for (const it of items) {
      const L = lines.find((l) => Math.abs(l.y - it.y) < Math.max(2, it.h * 0.4));
      if (L) L.items.push(it); else lines.push({ y: it.y, items: [it] });
    }
    lines.sort((a, b) => b.y - a.y);
    pages.push({ n, lines: lines.map((l) => {
      l.items.sort((a, b) => a.x - b.x);
      let t = "", end = null;
      for (const it of l.items) { if (end != null && it.x - end > it.h * 0.25) t += " "; t += it.s; end = it.x + it.w; }
      // 조각(segs): 붙어 있는 글자들은 한 낱말로 (PDF 마다 글자 단위·낱말 단위가 다름)
      const segs = [];
      for (const it of l.items) {
        const last = segs.at(-1);
        if (last && it.x - (last.x + last.w) <= Math.max(1, it.h * 0.25) && !/\s$/.test(last.s) && !/^\s/.test(it.s)) { last.s += it.s; last.w = it.x + it.w - last.x; }
        else segs.push({ x: it.x, w: it.w, s: it.s });
      }
      return { text: t.replace(/\s+/g, " ").trim(), x: l.items[0].x, right: end, y: l.y, h: l.items[0].h, segs };
    }).filter((l) => l.text) });
    pg.cleanup?.();
  }
  await pdf.destroy?.();
  return pages;
}

// 제목 글자 사이 띄어쓰기를 허용 ("봉 사 활 동 실 적")
const sp = (w) => w.replace(/\s+/g, "").split("").map((c) => c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("\\s*");
// 구역 제목 줄: '5. 학교폭력 조치상황', '학년 행동특성 및 종합의견', 뒤에 짧은 말이 붙은 줄도 (전체 30자 이하일 때만 봄)
const head = (w) => new RegExp(`^(\\d+\\s*[.．]\\s*)?(학\\s*년\\s*)?${sp(w)}(\\s+\\S{1,6})?\\s*$`);
const SECTION_RE = [
  [head("인적·학적사항"), "drop", "인적·학적사항"], [head("인적사항"), "drop", "인적사항"], [head("학적사항"), "drop", "학적사항"],
  [head("출결상황"), "attend"],
  [head("수상경력"), "drop", "수상경력"],
  [head("자격증및인증취득상황"), "drop", "자격증"], [head("자격증취득상황"), "drop", "자격증"],
  [head("학교폭력조치상황"), "drop", "학교폭력 조치상황"],
  [head("창의적체험활동상황"), "creative"],
  [head("봉사활동실적"), "drop", "봉사활동실적"],
  [head("교과학습발달상황"), "subject"],
  [head("독서활동상황"), "drop", "독서활동상황"],
  [head("행동특성및종합의견"), "behavior"]
];
// 인적사항 쪽 (2026-10-30 고침 — 본문 낱말로 쪽이 통째로 버려져 글이 잘리던 문제):
//   ① 한 줄 안에 주민등록번호 꼴(띄어쓰기만 허용, 줄을 넘어 붙이지 않음) 또는
//   ② 조각 글 전체가 정확히 칸 이름(성명·성별·주소·보호자·주민등록번호·관계, 띄어쓰기만 허용)인 조각이 2개 이상
//   본문 문장 속 낱말('보호', '위주 소규모' 등)로는 버리지 않음
const PII_NUM = /\d{6}-[1-4*][\d*]{6}/;
const PII_LABELS = new Set(["성명", "성별", "주소", "보호자", "주민등록번호", "관계"]);
function piiWhy(p) {
  if (p.lines.some((l) => PII_NUM.test(l.text.replace(/ +/g, "")))) return "주민등록번호";
  const labels = new Set();
  p.lines.forEach((l) => (l.segs || []).forEach((sg) => { const t = sg.s.replace(/\s+/g, ""); if (PII_LABELS.has(t)) labels.add(t); }));
  return labels.size >= 2 ? [...labels].join("·") + " 칸" : "";
}
const TABLE_HEAD = /^(학년|영역|시간|특기\s*사항|학년\s*영역|영역\s*시간|구분|과\s*목|수업\s*일수|결석\s*일수|지각|조퇴|결과|비고|학기|단위수|원점수|석차등급|성취도)(\s|$)/;
const NOISE = /^[-–]?\s*\d+\s*[-–]?$|^\d+\s*\/\s*\d+$|출력|발급|페이지|쪽\s*\d/;
const AREA_RE = /^(자율\s*[·ㆍ]?\s*자치\s*활동|자율\s*활동|동아리\s*활동|봉사\s*활동|진로\s*활동)$/;
const areaIdx = (n) => /^자율/.test(n) ? 0 : /^동아리/.test(n) ? 1 : /^봉사/.test(n) ? 2 : 3;
const segText = (segs) => { let t = "", end = null; for (const s of segs) { if (end != null && s.x - end > 2) t += " "; t += s.s; end = s.x + (s.w || 0); } return t.replace(/\s+/g, " ").trim(); };
const isHg = (c) => !!c && /[가-힣]/.test(c);
// 줄 이어 붙이기: 앞 줄이 오른쪽 끝까지 찼고 한글끼리 이어지면 낱말 중간에서 끊긴 것
function joinLines(lines, maxR) {
  let t = "", prev = null;
  for (const l of lines) {
    const s = l.t.trim(); if (!s) continue;
    const glue = prev && prev.r >= maxR - 15 && isHg(t.slice(-1)) && isHg(s[0]) ? "" : " ";
    t = t ? t + glue + s : s; prev = l;
  }
  return t;
}
// 칸 나누기 (나이스 표는 칸 이름(영역·학년)이 칸 높이의 가운데에 찍힘):
// 줄들(위→아래)과 이름 위치(anchor)들로 칸을 나눈다. 쪽 맨 위에는 앞 쪽 칸이 이어진 줄(prefix)이 있을 수 있어
// prefix 길이를 바꿔 가며 '마지막 칸이 마지막 줄에서 끝나는' 나누기를 고른다
function partitionSeq(T, A, tol) {
  const run = (k) => {
    let i = k; const blocks = [];
    for (const a of A) {
      if (i >= T.length || T[i].y < a.y - tol) { blocks.push({ a, lines: [] }); continue; }
      const bottom = 2 * a.y - T[i].y, b = { a, lines: [] };
      while (i < T.length && T[i].y >= bottom - tol) b.lines.push(T[i++]);
      blocks.push(b);
    }
    return { k, blocks, left: T.length - i, rest: T.slice(i) };
  };
  let best = null;
  for (let k = 0; k <= T.length; k++) { const r = run(k); if (!best || r.left < best.left) best = r; if (r.left === 0) break; }
  const r = best || { k: 0, blocks: [], left: T.length, rest: T };
  if (r.rest.length && r.blocks.length) r.blocks.at(-1).lines.push(...r.rest);   // 남은 줄은 마지막 칸에
  return { prefix: T.slice(0, r.k), blocks: r.blocks, orphan: r.blocks.length ? [] : r.rest };
}
function partitionDP(T, A, tol) {
  // 줄(위→아래)을 [쪽 맨 위 이어진 줄(prefix)] + 이름마다 한 칸으로 나눔. 각 칸의 가운데(첫 줄과 끝 줄의 가운데)가
  // 그 이름 위치와 가장 가깝게 되는 나누기를 고름 (DP). 칸 위에 글 없는 줄(빈 '희망분야' 칸 등)이 있어도 덜 흔들림
  const n = T.length, m = A.length;
  if (!m) return { prefix: [], blocks: [], orphan: T.slice() };
  const INF = 1e12, PRE = tol * 0.3;
  // 칸 경계는 줄 간격이 조금 더 벌어진 곳을 좋아함 (칸 테두리 여백). 간격이 고른 PDF 에서는 어느 나누기나 같은 값이라 영향 없음
  const gaps = T.map((x, i) => (i ? T[i - 1].y - x.y : 0)), gm = median(gaps.slice(1).filter((g) => g > 0));
  const edge = (i) => (i <= 0 || i >= n ? 0 : Math.max(0, gm * 1.15 - gaps[i]));
  const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(INF)), bk = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(-1));
  for (let p = 0; p <= n; p++) dp[0][p] = p * PRE;
  for (let k = 1; k <= m; k++) {
    const a = A[k - 1];
    for (let i = 0; i <= n; i++) {
      if (dp[k - 1][i] >= INF) continue;
      // 빈 칸 (이름만 있고 글이 없음 — 예: 아직 안 쓴 3학년 행특): 남은 줄보다 아래에 있으면 거의 공짜
      const ce = (i >= n || T[i].y < a.y - tol) ? tol * 0.5 : tol * 6;
      if (dp[k - 1][i] + ce < dp[k][i]) { dp[k][i] = dp[k - 1][i] + ce; bk[k][i] = i; }
      for (let j = i + 1; j <= n; j++) {
        const c = dp[k - 1][i] + Math.abs((T[i].y + T[j - 1].y) / 2 - a.y) + edge(i);
        if (c < dp[k][j]) { dp[k][j] = c; bk[k][j] = i; }
      }
    }
  }
  const blocks = []; let j = n;
  for (let k = m; k >= 1; k--) { const i = bk[k][j]; blocks.unshift({ a: A[k - 1], lines: T.slice(i, j) }); j = i; }
  return { prefix: T.slice(0, j), blocks, orphan: [] };
}
// 칸 나누기: 먼저 위에서부터 차례로(이름이 칸 가운데) 나눔 — 실제 나이스 파일에서 정확함.
// 그 결과가 이상하면(남는 줄이 있거나, 위아래 칸에는 글이 있는데 중간 칸이 비어 버림 — 예: 쪽을 넘긴 칸 위의 빈 '희망분야' 줄)
// 쪽 맨 위 첫 칸이 비는 것은 정상(앞 쪽에서 이어진 칸 — 줄은 prefix 로 앞 칸에 붙음)
// 이름이 칸 가운데에 가장 가깝게 되는 나누기(DP)를 씀
function partition(T, A, tol) {
  const a = partitionSeq(T, A, tol);
  const hole = a.blocks.some((b, i) => i > 0 && !b.lines.length && a.blocks.slice(0, i).some((x) => x.lines.length) && a.blocks.slice(i + 1).some((x) => x.lines.length));
  return a.orphan.length || hole ? partitionDP(T, A, tol) : a;
}
const median = (a) => { const s = a.slice().sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : 14; };

// ================= 성적 표 읽기 (2026-10-30, 실제 나이스 PDF 배치 기준) =================
// 표 셋: 일반 과목(학기·교과·과목·학점수·원점수/과목평균(표준편차)·성취도(수강자수)·석차등급·비고)
//        <진로 선택 과목>(… 원점수/과목평균 · 성취도(수강자수) · 성취도별 분포비율 · 비고) · <체육ㆍ예술>(… 학점수 · 성취도)
// 학기 숫자는 그 학기 줄들의 가운데에 한 번 찍힘. 긴 교과·과목 이름은 위아래 줄로 넘어감
const G_RAW = /^(\d{1,3}(?:\.\d+)?)\s*\/\s*(\d{1,3}(?:\.\d+)?)(?:\s*\(\s*(\d{1,3}(?:\.\d+)?)\s*\))?$/;
const G_ACH = /^([A-EP])\s*\(\s*(\d{1,4})\s*\)$/;
const G_DIST = /([A-E])\s*\(\s*(\d{1,3}(?:\.\d+)?)\s*\)/g;
const G_HEAD = /^(학\s*기|교\s*과|과\s*목|학\s*점\s*수?|단위\s*수|원점수|과목평균|\(?표준편차\)?|성취도(별)?|\(?수강자수\)?|분포비율|석차등급|비\s*고|원점수\/과목평균|수)$/;
export function parseGradeTables(tables, tol) {
  const out = [];
  const lastSem = {};
  tables.forEach((tb) => {
    [...new Set(tb.lines.map((l) => l.page))].forEach((pg) => {
      const lines = tb.lines.filter((l) => l.page === pg && !/이수\s*학점\s*합계/.test(l.text));
      const segsOf = (l) => (l.segs || []).map((s) => ({ x: s.x, t: s.s.trim() })).filter((s) => s.t);
      const isHead = (l) => segsOf(l).every((s) => G_HEAD.test(s.t.replace(/\s+/g, "")) || /^[\/()]$/.test(s.t));
      const rows = [], anchors = [], frags = [];
      lines.forEach((l) => {
        if (isHead(l)) return;
        const S = segsOf(l);
        const iCred = S.findIndex((s, i) => /^\d{1,2}$/.test(s.t) && i > 0 && S.slice(i + 1).some((x) => G_RAW.test(x.t) || G_ACH.test(x.t) || /^[A-EP]$/.test(x.t)));
        let sem = null, i0 = 0;
        if (S[0] && /^[1-2]$/.test(S[0].t) && (S.length === 1 || !/^\d/.test(S[1].t))) { sem = Number(S[0].t); i0 = 1; }
        if (sem != null) anchors.push({ y: l.y, sem });
        if (iCred < 0) { if (S.length > i0) frags.push({ y: l.y, segs: S.slice(i0) }); return; }
        const words = S.slice(i0, iCred), after = S.slice(iCred + 1);
        const r = { y: l.y, words, credit: Number(S[iCred].t) };
        after.forEach((s) => {
          let m;
          if (!r.rawSet && (m = s.t.match(G_RAW))) { r.raw = Number(m[1]); r.avg = Number(m[2]); r.sd = m[3] != null ? Number(m[3]) : null; r.rawSet = 1; }
          else if (!r.ach && (m = s.t.match(G_ACH))) { r.ach = m[1]; r.n = Number(m[2]); }
          else if (!r.ach && /^[A-EP]$/.test(s.t)) r.ach = s.t;
          else if (/^[A-E]\s*\(\s*\d+\.\d/.test(s.t) || /[A-E]\s*\(\s*\d+(\.\d+)?\s*\)\s+[A-E]\s*\(/.test(s.t)) { r.dist = r.dist || {}; const re = new RegExp(G_DIST.source, "g"); let d; while ((d = re.exec(s.t))) r.dist[d[1]] = Number(d[2]); }
          else if (r.rank == null && /^[1-9]$/.test(s.t) && tb.kind === "general") r.rank = Number(s.t);
          else if (r.rank == null && /^[-·.]$/.test(s.t)) r.rank = null;
          else r.note = (r.note ? r.note + " " : "") + s.t;
          G_DIST.lastIndex = 0;
        });
        rows.push(r);
      });
      if (!rows.length) return;
      // 교과·과목 칸 위치 (두 낱말이 다 있는 줄에서)
      const two = rows.filter((r) => r.words.length >= 2);
      const med = (a) => { const s = a.slice().sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : null; };
      const xA = med(two.map((r) => r.words[0].x)) ?? Math.min(...rows.map((r) => r.words[0]?.x ?? 9999));
      const xS = med(two.map((r) => r.words.at(-1).x)) ?? xA + 80;
      const col = (x) => Math.abs(x - xA) <= Math.abs(x - xS) ? "area" : "sub";
      rows.forEach((r) => {
        r.area = ""; r.sub = "";
        r.words.forEach((w) => { r[col(w.x)] += (r[col(w.x)] ? " " : "") + w.t; });
        r.parts = { area: r.area ? [{ y: r.y, t: r.area }] : [], sub: r.sub ? [{ y: r.y, t: r.sub }] : [] };
      });
      // 넘어간 이름 조각: 그 칸이 빈 가장 가까운 줄에 (없으면 가장 가까운 줄에 이어 붙임)
      frags.forEach((f) => f.segs.forEach((s) => {
        const c = col(s.x);
        // 가장 가까운 줄 (거리가 같으면 그 칸이 빈 줄) — 넘어간 이름은 그 줄 위아래로 고르게 찍힘
        const score = (x) => Math.abs(x.y - f.y) - (x[c] ? 0 : 0.5);
        const r = rows.slice().sort((a, b) => score(a) - score(b))[0];
        r.parts[c].push({ y: f.y, t: s.t });
      }));
      rows.forEach((r) => ["area", "sub"].forEach((c) => {
        r[c] = r.parts[c].sort((a, b) => b.y - a.y).map((p) => p.t).join("").replace(/\s*\/\s*/g, "/");
      }));
      // 학기: 숫자가 그 학기 줄들의 가운데 (partition 과 같은 방식)
      const P = partition(rows.map((r) => ({ y: r.y, r })), anchors.map((a) => ({ y: a.y, sem: a.sem })), tol);
      const key = `${tb.year}|${tb.kind}`;
      P.prefix.concat(P.orphan).forEach((x) => { x.r.sem = lastSem[key] || 1; });
      P.blocks.forEach((b) => b.lines.forEach((x) => { x.r.sem = b.a.sem; }));
      if (P.blocks.length) lastSem[key] = P.blocks.at(-1).a.sem;
      rows.forEach((r) => out.push({ y: tb.year, s: r.sem || 1, kind: tb.kind, area: r.area, sub: r.sub, credit: r.credit,
        raw: r.raw ?? null, avg: r.avg ?? null, sd: r.sd ?? null, ach: r.ach || "", n: r.n ?? null, rank: r.rank ?? null, dist: r.dist || null, note: r.note || "" }));
    });
  });
  return out;
}

// 쪽 → 구역·칸 (나이스 '학교생활기록부' PDF 기준. 섞인 칸은 미리 보기에서 선생님이 고침)
// keep: 선생님이 [이 쪽 살리기]를 누른 쪽 번호 (인적사항 판단을 하지 않음)
export function splitRecord(pages, { withGrades = false, keep = new Set() } = {}) {
  const info = { read: pages.length, kept: 0, dropped: [], headerLines: 0, lost: [] };
  // 빠진 글 검사: 특기사항 칸 줄(창체·세특·행특)마다 번호를 붙이고, 칸에 들어간 줄과 견줌
  const rawLines = [];
  const track = (o, page) => { o.id = rawLines.length; o.page = page; rawLines.push(o); return o; };
  const norm = (t) => t.replace(/\d+/g, "#");
  const freq = new Map();
  pages.forEach((p) => { const edge = [...p.lines.slice(0, 3), ...p.lines.slice(-3)]; new Set(edge.map((l) => norm(l.text))).forEach((k) => freq.set(k, (freq.get(k) || 0) + 1)); });
  const rep = pages.length >= 2 ? Math.max(2, Math.ceil(pages.length / 2)) : 99;
  // 1) 줄마다 구역 정하기 (창체·행특은 좌표째 모았다가 2)에서 칸으로 나눔)
  const reg = { creative: [], behavior: [], attend: [] };
  const subj = { rows: [] };
  const gt = [];   // 성적 표 (학년·종류별 줄 모음) — 성적 넣기를 골랐을 때만 읽음
  let curT = null;
  let cur = null, sub = null, grade = "", lastSubY = null, lastSubPage = 0;
  const gaps = [];
  for (const p of pages) {
    const pw = keep.has(p.n) ? "" : piiWhy(p);
    if (pw) { info.dropped.push({ page: p.n, why: `인적사항(${pw})이 있는 쪽`, pii: true }); continue; }
    info.kept++;
    p.lines.forEach((l, i) => { if (i && p.lines[i - 1].y - l.y < 30) gaps.push(p.lines[i - 1].y - l.y); });
    const maxR = Math.max(...p.lines.map((l) => l.right || 0));
    p.lines.forEach((l, i) => {
      const edge = i < 3 || i >= p.lines.length - 3;
      if (edge && ((freq.get(norm(l.text)) || 0) >= rep || NOISE.test(l.text))) { info.headerLines++; return; }
      const t0 = l.text;
      const hit = t0.length <= 30 && SECTION_RE.find(([re]) => re.test(t0));
      if (hit) {
        if (hit[1] === "drop") { cur = "drop"; if (!info.dropped.some((d) => d.why === hit[2] + " (구역)")) info.dropped.push({ page: p.n, why: hit[2] + " (구역)" }); }
        else if (cur !== hit[1]) { cur = hit[1]; sub = cur === "subject" ? "grades" : null; if (cur === "subject") grade = ""; }
        return;
      }
      if (!cur || cur === "drop") return;
      const L = { ...l, page: p.n, maxR };
      if (cur === "creative" || cur === "behavior" || cur === "attend") { if (!(TABLE_HEAD.test(t0) && t0.length < 40)) reg[cur].push(L); return; }
      // 교과: [n학년] · 성적 표 · <진로 선택 과목> 같은 묶음 제목 · '과목 / 세부능력 및 특기사항' 표
      let t = t0;
      const g = t.match(/^\[\s*([1-3])\s*학년\s*\]/);
      if (g) { grade = g[1]; sub = "grades"; curT = { year: Number(grade), kind: "general", lines: [] }; gt.push(curT); return; }
      if (/^[<〈]/.test(t)) { sub = "grades"; curT = { year: Number(grade) || 0, kind: /진로/.test(t) ? "career" : /체육|예술/.test(t) ? "arts" : "other", lines: [] }; gt.push(curT); return; }
      if (/^학\s*기(\s|$)/.test(t)) { sub = "grades"; curT?.lines.push(L); return; }
      if (/세부\s*능력\s*및\s*특기\s*사항/.test(t) && t.length < 40) { sub = "seteuk"; lastSubY = null; return; }
      if (sub === "grades") { curT?.lines.push(L); return; }
      if (sub !== "seteuk") return;
      const m = t.match(/^((?:\(\d학기\))?\s*[가-힣A-Za-z0-9ⅠⅡⅢⅣ·ㆍ\s()]{1,24}?)\s*[:：]\s*(.*)$/);
      const lg = median(gaps);
      if (m) { subj.rows.push({ label: `${grade ? grade + "학년 " : ""}${m[1].trim()}`, lines: [track({ t: m[2], r: l.right }, p.n)], maxR }); lastSubY = l.y; lastSubPage = p.n; return; }
      // 표 밖 글(묶음 제목·빈 줄 다음 글)은 버림: 같은 쪽에서 줄 간격이 크게 벌어지면 표가 끝난 것
      if (lastSubY != null && lastSubPage === p.n && lastSubY - l.y > lg * 1.8) { sub = "skip"; track({ t }, p.n); return; }
      const r = subj.rows.at(-1); if (!r) { track({ t }, p.n); return; }
      r.lines.push(track({ t, r: l.right }, p.n)); lastSubY = l.y; lastSubPage = p.n;
    });
  }
  const lg = median(gaps), tol = lg * 0.55;
  const secs = {};
  // 2) 창체: 영역 이름(자율·동아리·진로)이 칸 가운데. 학년 숫자도 학년 칸 가운데(쪽마다 다 있지는 않음)
  if (reg.creative.length) {
    // 특기사항 칸이 시작하는 x: 영역 이름·숫자가 아닌 긴 조각 중 가장 왼쪽 (영역 이름보다는 오른쪽)
    const areaX = Math.max(0, ...reg.creative.flatMap((l) => (l.segs || []).filter((s) => AREA_RE.test(s.s.trim())).map((s) => s.x)));
    const textX = Math.min(...reg.creative.map((l) => (l.segs || []).find((s) => s.x > areaX + 4 && !AREA_RE.test(s.s.trim()) && !/^\d{1,3}$/.test(s.s.trim()))?.x ?? 9999)) - 4;
    const frag = [];   // 쪽별 칸 조각
    const gAnch = [];
    [...new Set(reg.creative.map((l) => l.page))].forEach((pg) => {
      const Ls = reg.creative.filter((l) => l.page === pg);
      const T = [], A = [];
      Ls.forEach((l) => {
        const segs = l.segs || [{ x: l.x, w: (l.right || 0) - l.x, s: l.text }];
        const left = segs.filter((s) => s.x < textX), right = segs.filter((s) => s.x >= textX);
        const lt = left.map((s) => s.s.trim()).filter(Boolean);
        const area = lt.find((s) => AREA_RE.test(s.replace(/\s+/g, " ")));
        const gd = left.find((s) => /^[1-3]$/.test(s.s.trim()) && (!area || s.x < Math.min(...left.filter((x) => AREA_RE.test(x.s.trim())).map((x) => x.x))));
        if (gd) gAnch.push({ page: pg, y: l.y, g: Number(gd.s.trim()) });
        if (area) A.push({ y: l.y, name: area.replace(/\s+/g, "") });
        if (right.length) {
          const t = segText(right), hm = right[0].s.replace(/\s+/g, "") === "희망분야" ? [null, segText(right.slice(1))] : null;
          // 진로활동의 '희망분야 | ○○' 줄: 글이 아니라 칸 머리 (쪽을 넘겨 다시 찍힌 빈 줄은 값이 없음)
          T.push(hm ? { y: l.y, t: "", hope: hm[1].trim(), r: l.right, maxR: l.maxR } : track({ y: l.y, t, r: l.right, maxR: l.maxR }, pg));
        }
      });
      const P = partition(T, A, tol);
      frag.push({ page: pg, prefix: P.prefix.concat(P.orphan), blocks: P.blocks.map((b) => ({ name: b.a.name, y: b.a.y, lines: b.lines, page: pg })) });
    });
    // 쪽을 넘는 칸 잇기 · 학년 매기기 (영역 순서가 처음으로 돌아가면 다음 학년)
    const rows = [];
    let g = 1;
    frag.forEach((f) => {
      if (f.prefix.length && rows.length) rows.at(-1).lines.push(...f.prefix);
      f.blocks.forEach((b, bi) => {
        const prev = rows.at(-1);
        // 쪽 맨 위 칸이 앞 쪽 마지막 칸과 같은 영역이면 이어진 칸 (나이스는 쪽을 넘긴 칸에 영역 이름을 다시 찍음)
        if (prev && bi === 0 && prev.name === b.name && prev.lastPage === f.page - 1) { prev.lines.push(...b.lines); prev.frags.push(b); prev.lastPage = f.page; return; }
        if (prev && areaIdx(b.name) <= areaIdx(prev.name)) g++;
        rows.push({ name: b.name, g, lines: [...b.lines], frags: [b], lastPage: f.page });
      });
    });
    // 학년 숫자가 찍힌 곳으로 맞춤 (첫 번째로 찾은 숫자 기준)
    const a0 = gAnch.find((a) => rows.some((r) => r.frags.some((b) => b.page === a.page)));
    if (a0) {
      const hitRow = rows.find((r) => r.frags.some((b) => b.page === a0.page && b.lines.length && a0.y <= b.lines[0].y + tol && a0.y >= b.lines.at(-1).y - tol))
        || rows.find((r) => r.frags.some((b) => b.page === a0.page));
      const off = a0.g - hitRow.g;
      if (off) rows.forEach((r) => { r.g += off; });
    }
    rows.filter((r) => /^봉사/.test(r.name)).forEach((r) => r.lines.forEach((x) => { x.skip = true; }));   // 창체 안 봉사 칸은 일부러 버림
    secs.creative = rows.filter((r) => !/^봉사/.test(r.name)).map((r) => {
      const hope = r.lines.map((x) => x.hope).filter(Boolean)[0];
      const body = r.lines.filter((x) => x.hope == null);
      body.forEach((x) => { x.used = true; });
      return { label: `${r.g}학년 ${r.name}`, text: (hope ? `희망분야: ${hope}\n` : "") + joinLines(body, Math.max(0, ...r.lines.map((x) => x.maxR || 0))) };
    });
  }
  // 3) 행특: 학년 숫자가 칸 가운데 (쪽을 넘긴 칸에는 숫자가 없을 수 있음)
  if (reg.behavior.length) {
    const rows = [];
    [...new Set(reg.behavior.map((l) => l.page))].forEach((pg) => {
      const Ls = reg.behavior.filter((l) => l.page === pg);
      const T = [], A = [];
      Ls.forEach((l) => {
        const segs = l.segs || [{ x: l.x, w: (l.right || 0) - l.x, s: l.text }];
        const d = segs.length && /^[1-3]$/.test(segs[0].s.trim()) ? segs[0] : null;
        if (d && segs.length === 1) { A.push({ y: l.y, g: Number(d.s.trim()) }); return; }
        if (d) { A.push({ y: l.y, g: Number(d.s.trim()) }); T.push(track({ y: l.y, t: segText(segs.slice(1)), r: l.right, maxR: l.maxR }, pg)); return; }
        T.push(track({ y: l.y, t: segText(segs), r: l.right, maxR: l.maxR }, pg));
      });
      const P = partition(T, A, tol);
      const pre = P.prefix.concat(P.orphan);
      if (pre.length) { if (rows.length) rows.at(-1).lines.push(...pre); else rows.push({ g: 0, lines: pre }); }
      P.blocks.forEach((b) => rows.push({ g: b.a.g, lines: b.lines }));
    });
    secs.behavior = rows.map((r) => { r.lines.forEach((x) => { x.used = true; }); return { label: r.g ? `${r.g}학년` : "", text: joinLines(r.lines, Math.max(0, ...r.lines.map((x) => x.maxR || 0))) }; });
  }
  // 4) 출결: 줄 앞 학년 숫자로
  if (reg.attend.length) {
    const rows = [];
    reg.attend.forEach((l) => { const m = l.text.match(/^([1-3])\s+(.*)$/); if (m) rows.push({ label: `${m[1]}학년`, text: m[2] }); else if (rows.length) rows.at(-1).text += " " + l.text; else rows.push({ label: "", text: l.text }); });
    secs.attend = rows;
  }
  if (subj.rows.length) secs.subject = subj.rows.map((r) => { r.lines.forEach((x) => { x.used = true; }); return { label: r.label, text: joinLines(r.lines, r.maxR) }; });
  // 빠진 글: 남긴 쪽 특기사항 칸 글자 수 합과 칸에 들어간 글자 수의 차이 (일부러 버린 창체 봉사 칸은 뺌)
  const cnt = (t) => String(t || "").replace(/\s+/g, "").length;
  const raw = rawLines.filter((x) => !x.skip), lostL = raw.filter((x) => !x.used);
  info.rawChars = raw.reduce((t, x) => t + cnt(x.t), 0);
  info.lostChars = lostL.reduce((t, x) => t + cnt(x.t), 0);
  info.lost = [...new Set(lostL.filter((x) => cnt(x.t)).map((x) => x.page))].sort((a, b) => a - b);
  const order = ["attend", "creative", "subject", "behavior", "grades"];
  const sections = order.filter((k) => secs[k]).map((k) => ({ key: k, title: SEC_TITLE[k], rows: secs[k].filter((r) => (r.text || "").trim()).map((r) => ({ label: r.label, text: r.text.trim() })) }))
    .filter((s) => s.rows.length);
  const grades = withGrades ? parseGradeTables(gt, tol) : [];
  return { sections, info, grades };
}

// ================= B. 학생부 넣기 =================
let upState = null;   // 넣는 동안만 (원래 글 포함). 닫으면 버림
export function openRecordUpload(no) {
  const st = studentByNo(no);
  if (!canUploadRec(st)) return toast("학생부는 1차 담임 선생님·관리자만 넣을 수 있어요.", "error");
  closeUpload();
  upState = { no, pages: null, sections: null, info: null, withGrades: false };
  const ov = document.createElement("div");
  ov.id = "recUp"; ov.className = "rec-ov";
  ov.innerHTML = `<div class="rec-up" role="dialog" aria-label="학생부 넣기">
    <div class="rv-hd"><b>${esc(no)} ${esc(st.name)} · 학생부 넣기</b><span class="sp"></span><span class="muted sm">1차 담임·관리자만</span><button type="button" class="btn-sm" id="ruClose">닫기</button></div>
    <div class="ru-steps" id="ruSteps"></div>
    <div class="ru-body" id="ruBody"></div></div>`;
  document.body.append(ov);
  ov.addEventListener("copy", (e) => e.preventDefault());
  $("#ruClose", ov).onclick = async () => { if (upState?.sections && !(await confirmBox({ title: "학생부 넣기를 그만둘까요?", what: "", note: "읽은 내용은 저장되지 않고 버려져요.", yes: "그만두기" }))) return; closeUpload(); };
  stepConsent();
}
function closeUpload() { document.getElementById("recUp")?.remove(); upState = null; }
function steps(n) {
  const el = document.getElementById("ruSteps"); if (!el) return;
  el.innerHTML = ["동의", "PDF 고르기", "쪽 확인", "가림 확인", "저장"].map((t, i) => `<span class="${i + 1 < n ? "done" : i + 1 === n ? "on" : ""}">${i + 1}. ${t}</span>`).join("");
}
const body = () => document.getElementById("ruBody");
function stepConsent() {
  steps(1);
  body().innerHTML = `<div class="ru-card"><h3>학생·보호자 동의</h3>
    <p class="muted">학생부는 이 학생의 배정 선생님(1·2·3차)과 관리자만 볼 수 있어요. 학생 본인도 이 화면은 볼 수 없어요. 입시가 끝나면 한꺼번에 지워요.</p>
    <label class="inline-check"><input type="checkbox" id="ruConsent"> 학생·보호자의 동의를 받았어요</label>
    <div class="row" style="margin-top:12px"><button type="button" class="btn-primary" id="ruNext1" disabled>다음</button></div></div>`;
  $("#ruConsent").onchange = (e) => { $("#ruNext1").disabled = !e.target.checked; };
  $("#ruNext1").onclick = () => { upState.consent = true; stepPick(); };
}
function stepPick(msg = "") {
  steps(2);
  body().innerHTML = `<div class="ru-card"><h3>나이스 학생부 PDF 고르기</h3>
    <p class="muted">나이스에서 <b>'PDF로 저장'</b>한 파일을 골라 주세요. <b>1쪽(인적사항)은 빼고</b> 저장하면 좋아요 — 들어 있어도 자동으로 버려요.<br>
    파일은 이 브라우저 안에서만 읽고 어디에도 올리지 않아요. 저장되는 것은 마지막에 확인하는 가림본 글뿐이에요.</p>
    ${msg ? `<div class="notice">${msg}</div>` : ""}
    <input type="file" id="ruFile" accept="application/pdf,.pdf">
    <div class="muted sm" id="ruSt"></div></div>`;
  $("#ruFile").onchange = async (e) => {
    const f = e.target.files?.[0]; if (!f) return;
    $("#ruSt").textContent = "읽는 중…";
    try {
      const buf = await f.arrayBuffer();
      e.target.value = "";
      const pages = await readPdf(buf);
      if (!upState) return;
      if (!pages.some((p) => p.lines.length > 3)) return stepPick("이 PDF 에는 글자가 없어요(스캔한 그림). 나이스에서 'PDF로 저장'한 파일을 올려 주세요.");
      upState.pages = pages;
      stepPages();
    } catch (err) { console.warn(err); stepPick("PDF 를 읽지 못했어요. 나이스에서 'PDF로 저장'한 파일인지 확인해 주세요."); }
  };
}
function stepPages() {
  steps(3);
  upState.keep ||= new Set();
  const { sections, info, grades } = splitRecord(upState.pages, { withGrades: upState.withGrades, keep: upState.keep });
  upState.info = info; upState.grades = grades;
  upState.lostWarn = lostWarn(info);
  const midPii = info.dropped.filter((d) => d.pii && d.page > 1);
  const dropPages = new Set(info.dropped.filter((d) => /쪽/.test(d.why)).map((d) => d.page));
  body().innerHTML = `<div class="ru-card"><h3>쪽 확인</h3>
    <div class="ru-pages">${upState.pages.map((p) => { const d = info.dropped.find((x) => x.page === p.n && /쪽/.test(x.why)); return `<span class="ru-pg ${d ? "drop" : "keep"}" title="${esc(d?.why || "남김")}">${p.n}쪽 ${d ? "버림" : "남김"}${d ? `<small>${esc(d.why)}</small>` : ""}</span>`; }).join("")}</div>
    ${midPii.length ? `<div class="notice ru-warn">${midPii.map((d) => `<div class="row"><span><b>${d.page}쪽</b>이 인적사항으로 버려졌어요 (${esc(d.why.replace(/^인적사항\(|\)이 있는 쪽$/g, ""))}). 인적사항이 아니라면 살려 주세요 — 그 쪽 글이 학생부에서 빠져요.</span><div class="spacer"></div><button type="button" class="btn-sm" data-keep="${d.page}">이 쪽 살리기</button></div>`).join("")}</div>` : ""}
    ${upState.keep.size ? `<div class="muted sm">살린 쪽: ${[...upState.keep].sort((a, b) => a - b).map((n) => n + "쪽").join(", ")}</div>` : ""}
    ${upState.lostWarn}
    <ul class="ru-info">
      <li>남긴 구역: ${sections.filter((s) => s.key !== "grades").map((s) => esc(SEC_SHORT[s.key])).join(" · ") || '<b style="color:var(--danger)">없음</b>'}</li>
      <li>버린 구역: ${[...new Set(info.dropped.filter((d) => /구역/.test(d.why)).map((d) => d.why.replace(" (구역)", "")))].map(esc).join(" · ") || "없음"}${dropPages.size ? ` · 인적사항 쪽 ${dropPages.size}개` : ""}</li>
      <li>지운 머리말·꼬리말 줄: ${info.headerLines}줄</li>
    </ul>
    <label class="inline-check"><input type="checkbox" id="ruGrades" ${upState.withGrades ? "checked" : ""}> 성적(원점수·등급) 표도 넣기 <span class="muted sm">(기본은 빼요)</span></label>
    ${upState.withGrades ? `<div class="muted sm">성적 ${grades.length}과목 읽음 ${grades.length ? "· " + [...new Set(grades.map((g) => `${g.y}-${g.s}`))].sort().map((k) => `${k} ${grades.filter((g) => `${g.y}-${g.s}` === k).length}`).join(" · ") : "— 성적 표를 찾지 못했어요"}</div>` : ""}
    <div class="row" style="margin-top:12px"><button type="button" class="btn-sm" id="ruBack">다른 파일</button><div class="spacer"></div>
      <button type="button" class="btn-primary" id="ruNext3" ${sections.length ? "" : "disabled"}>가림 확인으로</button></div></div>`;
  $("#ruGrades").onchange = (e) => { upState.withGrades = e.target.checked; stepPages(); };
  $$("[data-keep]").forEach((b) => b.onclick = () => { upState.keep.add(Number(b.dataset.keep)); stepPages(); });
  $("#ruBack").onclick = () => { upState.pages = null; upState.keep = new Set(); stepPick(); };
  $("#ruNext3").onclick = () => {
    const names = namesList(upState.no);
    upState.sections = sections.map((s) => ({ ...s, rows: s.rows.map((r) => ({ label: r.label, text: r.text, masks: autoMasks(r.text, names) })) }));
    upState.pages = null;   // 쪽 글은 여기서 버림
    stepMask();
  };
}
// 빠진 글 경고: 특기사항 칸 글자 수 합보다 저장할 글자 수가 2% 넘게 적으면
export function lostWarn(info) {
  if (!info.rawChars || info.lostChars / info.rawChars <= 0.02) return "";
  return `<div class="notice ru-warn">일부 글이 빠졌을 수 있어요 — ${info.lost.map((n) => n + "쪽").join(", ")} 확인 <span class="muted sm">(특기사항 ${info.rawChars}자 중 ${info.lostChars}자가 칸에 들어가지 않았어요)</span></div>`;
}
function rowHtml(s, si, r, ri) {
  if (r.editing) return `<textarea class="ru-edit" data-si="${si}" data-ri="${ri}">${esc(applyMasks(r.text, r.masks))}</textarea>
    <div class="row"><button type="button" class="btn-sm btn-primary" data-editok="${si}:${ri}">고치기 끝</button></div>`;
  let h = "", at = 0;
  r.masks.forEach((m, mi) => { h += esc(r.text.slice(at, m.start)) + `<span class="ru-mask ${m.auto ? "auto" : "man"}" data-m="${si}:${ri}:${mi}" title="${m.auto ? "자동으로 가림" : "가림"} · 누르면 풀기">${esc(m.repl)}</span>`; at = m.end; });
  return `<div class="ru-text" data-si="${si}" data-ri="${ri}">${h + esc(r.text.slice(at))}</div>`;
}
function stepMask() {
  steps(4);
  const S3 = upState.sections;
  const autos = [];
  S3.forEach((s, si) => s.rows.forEach((r, ri) => r.masks.forEach((m, mi) => { if (m.auto) autos.push({ si, ri, mi, m }); })));
  body().innerHTML = `<div class="ru-card"><h3>가림 확인</h3>
    ${upState.lostWarn || ""}
    <p class="muted">다른 사람 이름·학교 이름·전화·메일은 자동으로 가렸어요(학생 본인 이름은 그대로). 글을 <b>드래그</b>해 [가리기], 가린 곳을 누르면 [풀기]. 표가 쪽을 넘어가 섞인 칸은 [고치기]로 글을 직접 고쳐요.</p>
    <details class="ru-autos" open><summary>자동으로 가린 곳 <b>${autos.length}</b>곳</summary>
      <div>${autos.map((a, k) => `<button type="button" class="chip" data-goto="${a.si}:${a.ri}:${a.mi}">${k + 1}. ${esc(a.m.kind === "name" ? "이름" : a.m.kind === "school" ? "학교" : a.m.kind === "phone" ? "전화" : "메일")} · ${esc(S3[a.si].rows[a.ri].text.slice(a.m.start, a.m.end))}</button>`).join(" ") || '<span class="muted sm">없음</span>'}</div></details>
    <div class="ru-doc" id="ruDoc">${S3.map((s, si) => `<h4>${esc(s.title)}</h4><table>${s.rows.map((r, ri) => `<tr><th>${esc(r.label || "")}</th><td>${rowHtml(s, si, r, ri)}
      ${r.editing ? "" : `<button type="button" class="ru-fix" data-fix="${si}:${ri}">고치기</button>`}</td></tr>`).join("")}</table>`).join("")}</div>
    ${upState.withGrades && upState.grades?.length ? `<details class="ru-autos"><summary>성적 ${upState.grades.length}과목 — 펼쳐서 학기별로 확인</summary><div id="ruGr" class="rv-grades-in"></div></details>` : ""}
    <div class="ru-pop" id="ruPop" hidden><button type="button" id="ruMask">가리기</button></div>
    <div class="row" style="margin-top:12px"><button type="button" class="btn-sm" id="ruBack4">쪽 확인으로</button><div class="spacer"></div>
      <button type="button" class="btn-primary" id="ruSave">이대로 저장</button></div></div>`;
  const doc0 = $("#ruDoc");
  if ($("#ruGr")) renderGrades($("#ruGr"), upState.grades, { on: new Set(["주요과목"]), radar: "all", view: "detail", yr: 0 });
  $$("[data-goto]").forEach((b) => b.onclick = () => { const el = $(`[data-m="${b.dataset.goto}"]`, doc0); el?.scrollIntoView({ block: "center" }); el?.classList.add("flash"); setTimeout(() => el?.classList.remove("flash"), 1200); });
  $$(".ru-mask", doc0).forEach((el) => el.onclick = () => { const [si, ri, mi] = el.dataset.m.split(":").map(Number); S3[si].rows[ri].masks.splice(mi, 1); stepMask(); });
  $$("[data-fix]", doc0).forEach((b) => b.onclick = () => { const [si, ri] = b.dataset.fix.split(":").map(Number); S3[si].rows[ri].editing = true; stepMask(); });
  $$("[data-editok]", doc0).forEach((b) => b.onclick = () => {
    const [si, ri] = b.dataset.editok.split(":").map(Number);
    const r = S3[si].rows[ri];
    r.text = $(`textarea[data-si="${si}"][data-ri="${ri}"]`, doc0).value.trim();
    r.masks = autoMasks(r.text, namesList(upState.no)); r.editing = false;   // 고친 글에 새로 들어간 이름도 다시 가림
    stepMask();
  });
  const pop = $("#ruPop");
  doc0.onmouseup = () => setTimeout(() => {
    const sel = getSelection();
    const pos = selPos(sel, ".ru-text");
    if (!pos) { pop.hidden = true; return; }
    const r = S3[pos.si]?.rows[pos.ri];
    // 가린 칸(○○) 안을 고르면 원래 글자 자리로 바꿀 수 없으니 막는다
    const raw = rawRange(r, pos.start, pos.end);
    if (!raw) { pop.hidden = true; return; }
    const rect = sel.getRangeAt(0).getBoundingClientRect();
    pop.style.left = `${rect.left + rect.width / 2}px`; pop.style.top = `${rect.top - 8}px`; pop.hidden = false;
    $("#ruMask").onclick = () => { r.masks = r.masks.filter((m) => !(raw.start < m.end && raw.end > m.start)); r.masks.push({ start: raw.start, end: raw.end, kind: "manual", repl: "○○", auto: false }); r.masks.sort((a, b) => a.start - b.start); pop.hidden = true; getSelection().removeAllRanges(); stepMask(); };
  }, 0);
  $("#ruBack4").onclick = () => { upState.sections = null; stepPick("가림 확인을 다시 하려면 파일을 다시 골라 주세요."); };
  $("#ruSave").onclick = saveUpload;
}
// 화면 글자 자리 → 원래 글 자리 (가림 칸은 화면에 ○○ 로 보이므로 길이가 다름)
function rawRange(r, s, e) {
  let disp = 0, raw = 0, rs = null, re = null;
  const marks = r.masks.slice().sort((a, b) => a.start - b.start);
  const walk = (len, plain, m) => {
    for (let k = 0; k < len; k++) {
      if (disp === s) rs = plain ? raw + k : (m ? m.start : raw);
      if (disp === e) re = plain ? raw + k : (m ? m.end : raw);
      disp++;
    }
  };
  for (const m of marks) { walk(m.start - raw, true); raw = m.start; walk(m.repl.length, false, m); raw = m.end; }
  walk(r.text.length - raw, true); raw = r.text.length;
  if (disp === s) rs = raw; if (disp === e) re = raw;
  return rs != null && re != null && re > rs ? { start: rs, end: re } : null;
}
// 고른 글자의 칸 안 자리 (한 칸 안에서만)
function selPos(sel, cellSel) {
  if (!sel || sel.isCollapsed || !sel.rangeCount) return null;
  const rg = sel.getRangeAt(0);
  const a = (rg.startContainer.nodeType === 1 ? rg.startContainer : rg.startContainer.parentElement)?.closest(cellSel);
  const b = (rg.endContainer.nodeType === 1 ? rg.endContainer : rg.endContainer.parentElement)?.closest(cellSel);
  if (!a || a !== b) return null;
  const pre = document.createRange(); pre.selectNodeContents(a); pre.setEnd(rg.startContainer, rg.startOffset);
  const start = pre.toString().length, end = start + rg.toString().length;
  if (end <= start) return null;
  return { el: a, si: Number(a.dataset.si), ri: Number(a.dataset.ri), start, end, text: rg.toString() };
}
async function saveUpload() {
  const no = upState.no, st = studentByNo(no);
  if (upState.sections.some((s) => s.rows.some((r) => r.editing))) return toast("[고치기 끝]을 먼저 눌러 주세요.", "error");
  const sections = upState.sections.map((s) => ({ key: s.key, title: s.title, rows: s.rows.map((r) => ({ label: r.label || "", text: applyMasks(r.text, r.masks) })).filter((r) => r.text.trim()) })).filter((s) => s.rows.length);
  if (!sections.length) return toast("저장할 내용이 없어요.", "error");
  const btn = $("#ruSave"); btn.disabled = true;
  try {
    let ver = 1, old = null;
    try { const o = await getDoc(doc(db, "records", no)); if (o.exists()) { old = o.data(); ver = (Number(old.ver) || 0) + 1; } } catch (_) {}
    const me = myName() || S.ctx.user.email;
    const rec = { studentNo: no, sections, ...(upState.withGrades && upState.grades?.length ? { grades: upState.grades } : {}), pages: { read: upState.info.read, kept: upState.info.kept, dropped: upState.info.dropped }, ver,
      savedAt: serverTimestamp(), savedBy: me, savedByUid: S.ctx.user.uid, consentAt: serverTimestamp(), consentBy: me };
    await setDoc(doc(db, "records", no), rec);
    exists.set(no, true);
    let lost = 0;
    if (old) lost = await reanchor(no, sections);
    await log(no, "upload");
    upState.sections = null;
    steps(5);
    body().innerHTML = `<div class="ru-card"><h3>저장했어요 ✓</h3>
      <p>${esc(st?.name || no)} 학생 학생부 ${ver > 1 ? `${ver}번째 판` : ""}을 저장했어요. <b>가림본 글만 저장됐고 PDF 는 남지 않아요.</b></p>
      ${old ? `<p class="muted">하이라이트·질문은 새 판에서 근거 문장을 다시 찾아 붙였어요.${lost ? ` 찾지 못한 하이라이트 ${lost}개는 뺐어요(질문은 그대로).` : ""}</p>` : ""}
      <div class="row"><button type="button" class="btn-primary" id="ruDone">닫기</button></div></div>`;
    $("#ruDone").onclick = () => { closeUpload(); window.dispatchEvent(new CustomEvent("records-changed", { detail: { no } })); };
  } catch (e) { btn.disabled = false; showError(e, "학생부 저장"); }
}
// 다시 넣었을 때: 하이라이트를 새 판에서 고른 글(quote)로 다시 찾아 자리만 고침, 못 찾으면 그 하이라이트만 지움
async function reanchor(no, sections) {
  const snap = await getDocs(collection(db, "records", no, "marks"));
  const b = writeBatch(db);
  let lost = 0, n = 0;
  snap.docs.forEach((d) => {
    const m = d.data(), hit = findQuote(sections, m);
    if (!hit) { b.delete(d.ref); lost++; n++; }
    else if (hit.sec !== m.sec || hit.row !== m.row || hit.start !== m.start || hit.end !== m.end) { b.update(d.ref, { sec: hit.sec, row: hit.row, start: hit.start, end: hit.end }); n++; }
  });
  if (n) await b.commit();
  return lost;
}
function findQuote(sections, m) {
  const q = m.quote || ""; if (!q) return null;
  const tryRow = (s, r) => { const t = sections.find((x) => x.key === s)?.rows[r]?.text; const i = t ? t.indexOf(q) : -1; return i >= 0 ? { sec: s, row: r, start: i, end: i + q.length } : null; };
  const same = tryRow(m.sec, m.row); if (same) return same;
  for (const s of sections) for (let r = 0; r < s.rows.length; r++) { const h = tryRow(s.key, r); if (h) return h; }
  return null;
}

// ================= E. 지우기 (관리자) =================
export async function deleteRecords(nos, { all = false } = {}) {
  if (!S.ctx.isAdmin) return;
  const list = nos.filter(Boolean);
  if (!list.length) return toast("지울 학생부가 없어요.");
  if (!(await confirmBox({ title: all ? `학생부 ${list.length}명을 모두 지울까요?` : "이 학생의 학생부를 지울까요?", what: all ? `학생부 ${list.length}명 · 하이라이트 · 공개 전 질문` : `${esc(list[0])} ${esc(studentByNo(list[0])?.name || "")}`,
    note: "열람 기록은 남아요 (학생부 내용은 없음).", yes: "다음" }))) return false;
  if (!(await confirmBox({ title: "되돌릴 수 없어요", what: "지운 학생부·하이라이트는 다시 살릴 수 없어요. 학생 '내 생기부 면접'에 이미 공개된 질문은 그대로 남아요.", note: "열람 기록은 남아요 (학생부 내용은 없음).", yes: "지우기" }))) return false;
  try {
    const pend = [];
    for (const no of list) (await getDocs(collection(db, "records", no, "pending"))).docs.forEach((d) => pend.push({ no, id: d.id, ...d.data() }));
    let publish = false;
    if (pend.length) publish = await confirmBox({ title: `공개 전 질문 ${pend.length}개가 있어요`, what: "학생에게 공개한 뒤 지울까요, 그냥 지울까요?", note: "'공개하고 지우기'를 누르면 학생 '내 생기부 면접'에 더해진 뒤 지워져요.", yes: "공개하고 지우기", no: "그냥 지우기" });
    if (publish) { const byNo = {}; pend.forEach((p) => (byNo[p.no] ||= []).push(p)); for (const no of Object.keys(byNo)) await publishPending(no, byNo[no]); }
    for (const no of list) {
      const b = writeBatch(db);
      (await getDocs(collection(db, "records", no, "marks"))).docs.forEach((d) => b.delete(d.ref));
      (await getDocs(collection(db, "records", no, "pending"))).docs.forEach((d) => b.delete(d.ref));
      b.delete(doc(db, "records", no));
      await b.commit();
      exists.set(no, false);
      await log(no, "delete");
    }
    toast(`학생부 ${list.length}명을 지웠어요.`);
    window.dispatchEvent(new CustomEvent("records-changed", { detail: {} }));
    return true;
  } catch (e) { showError(e, "학생부 지우기"); return false; }
}

// ================= 공개 전 질문(pending) → '내 생기부 면접' =================
export async function loadPending(no) {
  return (await getDocs(collection(db, "records", no, "pending"))).docs.map((d) => ({ id: d.id, ...d.data() }));
}
// 옮기기: personalQuestions 에 더하고 pending 지우고, 그 질문의 하이라이트(qid)를 새 문서로 바꿈. 더한 개수를 돌려줌
export async function publishPending(no, list) {
  if (!list?.length) return 0;
  const col = collection(db, "students", no, "personalQuestions");
  const cur = (await getDocs(col)).docs.map((d) => ({ id: d.id, ...d.data() }));
  const marks = (await getDocs(collection(db, "records", no, "marks"))).docs;
  const b = writeBatch(db);
  const rows = [];
  list.forEach((p) => {
    const ref = doc(col);
    const row = { text: p.text, basis: p.basis || "", followUps: p.followUps || [], category: `${p.stage}차 선생님 질문`, type: "document", by: "teacher", addedBy: p.by || "", source: "record", stage: Number(p.stage) || 0 };
    rows.push(row);
    b.set(ref, { ...row, createdAt: serverTimestamp() });
    b.delete(doc(db, "records", no, "pending", p.id));
    marks.filter((m) => m.data().qid === p.id).forEach((m) => b.update(m.ref, { qid: ref.id }));
  });
  const stats = pqStats([...cur, ...rows]);
  b.update(doc(db, "students", no), stats);
  await b.commit();
  const st = studentByNo(no); if (st) Object.assign(st, stats);
  await log(no, "publish");
  return rows.length;
}

// ================= 성적 탭 (학생부 화면) — 2026-10-30 사용자 결정 =================
// 주요과목 = 국·영·수·사·과 (한국사는 사회) · 묶음 국영·수과·영수(+국영수) · 원점수·과목평균·표준편차 모두 보임
// 평균 등급 = Σ(석차등급 × 학점) ÷ Σ학점 (석차등급이 있는 과목만). 진로 선택·체육·예술은 따로
const G_SEMS = ["1-1", "1-2", "2-1", "2-2", "3-1", "3-2"];
const gArea = (a) => /^국어/.test(a) ? "국어" : /^수학/.test(a) ? "수학" : /^영어/.test(a) ? "영어" : /^(한국사|사회)/.test(a) ? "사회" : /^과학/.test(a) ? "과학" : "기타";
const MAIN = ["국어", "수학", "영어", "사회", "과학"];
const G_GROUPS = [["주요과목", MAIN, "#e8577e"], ["전과목", null, "#6b7280"], ["국영", ["국어", "영어"], "#b45309"], ["수과", ["수학", "과학"], "#0e9aa7"], ["영수", ["영어", "수학"], "#7c3aed"], ["국영수", ["국어", "영어", "수학"], "#a16207"],
  ["국어", ["국어"], "#2f6fd6"], ["영어", ["영어"], "#d98a1a"], ["수학", ["수학"], "#1f9d6b"], ["사회", ["사회"], "#7b52c9"], ["과학", ["과학"], "#0891b2"], ["기타", ["기타"], "#64748b"]];
const gAvg = (list) => { const L = list.filter((r) => r.rank != null && r.kind === "general"); const c = L.reduce((t, r) => t + (r.credit || 0), 0); return c ? L.reduce((t, r) => t + r.rank * (r.credit || 0), 0) / c : null; };
const gPick = (G, grp, sem) => G.filter((r) => (!grp || grp.includes(gArea(r.area))) && (!sem || `${r.y}-${r.s}` === sem));
const f2 = (x) => x == null ? "-" : x.toFixed(2);
export function renderGrades(el, G, st = { on: new Set(["주요과목", "전과목"]), radar: "all", view: "sum", yr: 0 }) {
  if (!G?.length) { el.innerHTML = '<div class="gr-empty">성적을 넣지 않았어요. 1차 담임이 [학생부 다시 넣기]에서 <b>성적(원점수·등급) 표도 넣기</b>를 체크하면 볼 수 있어요.</div>'; return; }
  const years = [...new Set(G.map((r) => r.y))].sort();
  if (!st.yr) st.yr = years[0];
  el.innerHTML = `<div class="gr-top"><span class="rv-gr gr-view"><button type="button" data-gv="sum" class="${st.view === "sum" ? "on" : ""}">한눈에</button><button type="button" data-gv="detail" class="${st.view === "detail" ? "on" : ""}">학기별 세부 성적</button></span>
      <span class="muted sm">평균 등급 = Σ(석차등급×학점)÷Σ학점 · 석차등급이 있는 과목만</span></div>
    <div class="gr-sum" ${st.view === "sum" ? "" : "hidden"}>
      <div class="gr-row2">
        <div class="gr-card"><h4>학기별 교과 성적 등급 추이</h4><div class="gr-chips">${G_GROUPS.filter(([n, grp]) => gPick(G, grp).some((r) => r.rank != null)).map(([n, , c]) => `<button type="button" class="gr-chip ${st.on.has(n) ? "on" : ""}" data-gg="${n}" style="${st.on.has(n) ? `color:${c}` : ""}"><i></i>${n}</button>`).join("")}</div>
          <div class="gr-line"></div><div class="muted sm">점을 누르면 그 학기 세부 성적으로 · 1등급이 위</div></div>
        <div class="gr-card"><h4>주요 교과 비교 <span class="rv-gr"><button type="button" data-gr2="all" class="${st.radar === "all" ? "on" : ""}">전 학기</button><button type="button" data-gr2="last" class="${st.radar === "last" ? "on" : ""}">최근 학기</button></span></h4><div class="gr-radar"></div><div class="muted sm">바깥으로 갈수록 좋은 등급</div></div>
      </div>
      <div class="gr-card"><h4>교과 성적 산출표</h4><div class="table-wrap"><table class="gr-t">${sumTable(G)}</table></div>
        <div class="muted sm">등급이수 = 석차등급이 있는 과목 학점 합 · 전체이수 = 모든 과목 학점 합 · <b style="color:#1e7a5a">초록</b> 가장 좋은 학기 · <b style="color:#c2453c">빨강</b> 가장 낮은 학기</div></div>
      ${G.some((r) => r.kind === "career") ? `<div class="gr-card"><h4>진로 선택 과목 · 성취도</h4><div class="table-wrap"><table class="gr-t">${careerTable(G)}</table></div></div>` : ""}
    </div>
    <div class="gr-detail" ${st.view === "detail" ? "" : "hidden"}>
      <span class="rv-gr">${years.map((y) => `<button type="button" data-gy="${y}" class="${st.yr === y ? "on" : ""}">${y}학년</button>`).join("")}</span>
      ${[1, 2].map((s) => semCard(G, st.yr, s)).join("")}
    </div>`;
  drawLine(el.querySelector(".gr-line"), G, st);
  drawRadar(el.querySelector(".gr-radar"), G, st);
  const again = () => renderGrades(el, G, st);
  el.querySelectorAll("[data-gv]").forEach((b) => b.onclick = () => { st.view = b.dataset.gv; again(); });
  el.querySelectorAll("[data-gg]").forEach((b) => b.onclick = () => { st.on.has(b.dataset.gg) ? st.on.delete(b.dataset.gg) : st.on.add(b.dataset.gg); again(); });
  el.querySelectorAll("[data-gr2]").forEach((b) => b.onclick = () => { st.radar = b.dataset.gr2; again(); });
  el.querySelectorAll("[data-gy]").forEach((b) => b.onclick = () => { st.yr = Number(b.dataset.gy); again(); });
  el.querySelectorAll("[data-gsem]").forEach((c) => c.onclick = () => { st.view = "detail"; st.yr = Number(c.dataset.gsem[0]); again(); });
}
function drawLine(box, G, st) {
  const W = 640, H = 300, L = 40, R = 16, T = 18, B = 34, xs = (i) => L + i * (W - L - R) / (G_SEMS.length - 1), ys = (g) => T + (g - 1) * (H - T - B) / 8;
  let s = `<svg viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="학기별 등급 추이">`;
  for (let g = 1; g <= 9; g++) s += `<line x1="${L}" x2="${W - R}" y1="${ys(g)}" y2="${ys(g)}" stroke="#edf0f5"/><text x="${L - 8}" y="${ys(g) + 4}" font-size="11" text-anchor="end" fill="#737b89">${g}</text>`;
  G_SEMS.forEach((m, i) => { s += `<text x="${xs(i)}" y="${H - 10}" font-size="11" text-anchor="middle" fill="#737b89">${m}학기</text>`; });
  G_GROUPS.filter(([n]) => st.on.has(n)).forEach(([n, grp, c]) => {
    const pts = G_SEMS.map((m, i) => ({ i, v: gAvg(gPick(G, grp, m)) })).filter((p) => p.v != null);
    if (!pts.length) return;
    s += `<polyline fill="none" stroke="${c}" stroke-width="2.4" points="${pts.map((p) => `${xs(p.i)},${ys(p.v)}`).join(" ")}"/>`;
    pts.forEach((p) => { s += `<circle cx="${xs(p.i)}" cy="${ys(p.v)}" r="4.5" fill="#fff" stroke="${c}" stroke-width="2" style="cursor:pointer" data-gsem="${G_SEMS[p.i]}"><title>${n} ${G_SEMS[p.i]} ${f2(p.v)}</title></circle><text x="${xs(p.i)}" y="${ys(p.v) - 9}" font-size="11" text-anchor="middle" fill="${c}" font-weight="700" pointer-events="none">${f2(p.v)}</text>`; });
  });
  box.innerHTML = s + "</svg>";
}
function drawRadar(box, G, st) {
  const W = 300, H = 280, cx = 150, cy = 142, R = 105;
  const last = G_SEMS.filter((m) => gPick(G, null, m).some((r) => r.rank != null)).at(-1);
  const val = (a) => gAvg(gPick(G, [a], st.radar === "last" ? last : null));
  const pt = (i, g) => { const r = R * (9 - g) / 8, ang = -Math.PI / 2 + i * 2 * Math.PI / MAIN.length; return [cx + r * Math.cos(ang), cy + r * Math.sin(ang)]; };
  let s = `<svg viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="주요 교과 비교">`;
  [1, 3, 5, 7].forEach((g) => { s += `<polygon points="${MAIN.map((_, i) => pt(i, g).join(",")).join(" ")}" fill="${g === 1 ? "#f6f8fb" : "none"}" stroke="#e1e6ee"/>`; });
  MAIN.forEach((a, i) => { const [x, y] = pt(i, 0.1); s += `<line x1="${cx}" y1="${cy}" x2="${pt(i, 1)[0]}" y2="${pt(i, 1)[1]}" stroke="#e1e6ee"/><text x="${x}" y="${y + 4}" font-size="12" text-anchor="middle" fill="#4f5663" font-weight="700">${a}</text>`; });
  const P = MAIN.map((a, i) => pt(i, val(a) ?? 9));
  s += `<polygon points="${P.map((p) => p.join(",")).join(" ")}" fill="rgba(232,87,126,.18)" stroke="#e8577e" stroke-width="2"/>`;
  MAIN.forEach((a, i) => { const v = val(a), [x, y] = P[i]; s += `<circle cx="${x}" cy="${y}" r="3.5" fill="#e8577e"/><text x="${x}" y="${y - 7}" font-size="10.5" text-anchor="middle" fill="#e8577e" font-weight="700">${f2(v)}</text>`; });
  box.innerHTML = s + "</svg>";
}
function sumTable(G) {
  let h = `<thead><tr><th rowspan="2">과목 구분</th><th rowspan="2">평균</th><th rowspan="2">등급이수</th><th rowspan="2">전체이수</th><th colspan="6">학기별 평균 등급</th></tr><tr class="sub">${G_SEMS.map((m) => `<th>${m}</th>`).join("")}</tr></thead><tbody>`;
  G_GROUPS.forEach(([n, grp], k) => {
    const all = gPick(G, grp), vs = G_SEMS.map((m) => gAvg(gPick(G, grp, m)));
    if (!all.length) return;
    const ok = vs.filter((v) => v != null), best = Math.min(...ok), worst = Math.max(...ok);
    h += `<tr class="${k < 6 ? "grp" : ""}"><th>${n}</th><td class="avg">${f2(gAvg(all))}</td><td>${all.filter((r) => r.rank != null && r.kind === "general").reduce((t, r) => t + (r.credit || 0), 0)}</td><td>${all.reduce((t, r) => t + (r.credit || 0), 0)}</td>${vs.map((v) => `<td class="${v != null && ok.length > 1 ? (v === best ? "best" : v === worst ? "worst" : "") : ""}">${f2(v)}</td>`).join("")}</tr>`;
  });
  return h + "</tbody>";
}
const esc2 = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const distBar = (d) => d ? `<div class="gr-dist"><span style="width:${d.A || 0}%;background:#1e7a5a"></span><span style="width:${d.B || 0}%;background:#5f78a3"></span><span style="width:${d.C || 0}%;background:#d98a1a"></span></div><span class="muted sm">${["A", "B", "C"].filter((k) => d[k] != null).map((k) => `${k} ${d[k]}%`).join(" · ")}</span>` : "-";
function careerTable(G) {
  return `<thead><tr><th>학기</th><th>교과</th><th>과목</th><th>학점</th><th>원점수 / 과목평균</th><th>성취도 (수강자수)</th><th>성취도별 분포</th></tr></thead><tbody>` +
    G.filter((r) => r.kind === "career").map((r) => `<tr><td>${r.y}-${r.s}</td><td>${esc2(r.area)}</td><td class="l">${esc2(r.sub)}</td><td>${r.credit ?? "-"}</td><td>${r.raw != null ? `${r.raw} / ${r.avg}` : "-"}</td><td><span class="gr-pill ${String(r.ach).toLowerCase()}">${esc2(r.ach || "-")}</span>${r.n != null ? ` (${r.n})` : ""}</td><td>${distBar(r.dist)}</td></tr>`).join("") + "</tbody>";
}
function semCard(G, y, s) {
  const L = G.filter((r) => r.y === y && r.s === s);
  if (!L.length) return `<div class="gr-card muted">${y}학년 ${s}학기 성적이 없어요</div>`;
  const K = { general: "", career: "진로 선택", arts: "체육·예술", other: "" };
  return `<div class="gr-card"><div class="gr-semhd"><b>${y}학년 ${s}학기</b><span class="gr-pill">평균 ${f2(gAvg(L))}등급</span><span class="gr-pill">주요과목 ${f2(gAvg(L.filter((r) => MAIN.includes(gArea(r.area)))))}</span><span class="muted sm">${L.reduce((t, r) => t + (r.credit || 0), 0)}학점</span></div>
    <div class="table-wrap"><table class="gr-t"><thead><tr><th>교과</th><th>과목</th><th>학점</th><th>원점수 / 과목평균 (표준편차)</th><th>성취도 (수강자수)</th><th>석차등급</th></tr></thead><tbody>${L.map((r) => `<tr><td>${esc2(r.area)}${K[r.kind] ? `<div class="muted sm">${K[r.kind]}</div>` : ""}</td><td class="l">${esc2(r.sub)}</td><td>${r.credit ?? "-"}</td>
      <td>${r.raw != null ? `${r.raw} / ${r.avg}${r.sd != null ? ` (${r.sd})` : ""}` : "-"}</td><td>${esc2(r.ach || "-")}${r.n != null ? ` (${r.n})` : ""}${r.dist ? `<div>${distBar(r.dist)}</div>` : ""}</td><td>${r.rank != null ? `<b>${r.rank}</b>` : "-"}</td></tr>`).join("")}</tbody></table></div></div>`;
}

// ================= C. 학생부 화면 =================
let V = null;   // 열려 있는 동안만 (학생부 글·하이라이트·질문). 닫으면 null
export const recordViewerOpen = () => !!V;
export function closeRecordViewer() {
  if (!V) return;
  clearTimeout(V.idle); clearInterval(V.tick);
  V.off.forEach((f) => f());
  document.getElementById("recView")?.remove();
  V = null;
}
function guessStage(st, preset) {
  if (preset?.stage) return Number(preset.stage);
  const mine = myRoles(st).map((r) => Number(r[0]));
  const done = new Set((S.meetings || []).filter((m) => m.studentNo === st.studentNo && !m.planned).map((m) => Number(m.stage)));
  return mine.find((k) => !done.has(k)) || mine[0] || [1, 2, 3].find((k) => !done.has(k)) || 1;
}
export async function openRecordViewer(no, { stage = 0, preset = null } = {}) {
  const st = studentByNo(no);
  if (!canSeeRec(st)) return toast("이 학생의 학생부는 배정 선생님·관리자만 볼 수 있어요.", "error");
  closeRecordViewer();
  closeModal();   // 창(학생 상세·일정 상세) 위가 아니라 화면 전체로 연다. [기록 쓰기 →] 의 기록 창은 이 화면 위에 뜸
  let rec;
  try { const s = await getDoc(doc(db, "records", no)); if (!s.exists()) return toast("아직 학생부가 없어요.", "error"); rec = s.data(); }
  catch (e) { return showError(e, "학생부 열기"); }
  V = { no, st, rec, stage: stage || guessStage(st, preset), preset, marks: [], pending: [], pqs: [], notes: null, asked: new Map(),
    flt: "all", otherHl: true, grade: {}, idle: null, tick: null, t0: 0, run: false, used: 0, off: [], sel: null };
  log(no, "open");
  const me = myName() || S.ctx.user.email;
  const ov = document.createElement("div");
  ov.id = "recView"; ov.className = "rec-ov rv";
  const wm = `<svg xmlns='http://www.w3.org/2000/svg' width='320' height='180'><text x='10' y='100' transform='rotate(-24 160 90)' font-size='15' fill='rgba(30,40,60,0.09)' font-family='sans-serif'>${esc(me)} · ${new Date().toLocaleString("ko-KR")}</text></svg>`;
  const iv = (st.universities || []).filter((u) => u.announceResult !== "fail").map((u) => u.dept).filter(Boolean).slice(0, 2).join(", ");
  ov.innerHTML = `<div class="rv-wm" style="background-image:url(&quot;data:image/svg+xml;utf8,${encodeURIComponent(wm)}&quot;)"></div>
    <div class="rv-hd"><b>${esc(no)} ${esc(st.name)}</b><span class="rv-gr rv-main"><button type="button" data-main="rec" class="on">학생부</button><button type="button" data-main="gr">성적</button></span><span class="rv-stage">${[1, 2, 3].map((k) => `<button type="button" data-stage="${k}" class="${V.stage === k ? "on" : ""} c${k}">${k}차</button>`).join("")}</span>
      <span class="muted">모의면접${preset?.date ? ` · ${esc(fmtDay(preset.date))}` : ""}${iv ? ` · ${esc(iv)} 지원` : ""}</span><span class="sp"></span>
      <span class="rv-tm" id="rvTm">면접 00:00</span><button type="button" class="btn-sm" id="rvTmBtn">면접 시작</button><button type="button" class="btn-sm" id="rvClose">닫기</button></div>
    <div class="rv-body">
      <nav class="rv-toc">${rec.sections.map((s) => `<a href="#rvs-${s.key}" data-toc="${s.key}">${esc(SEC_SHORT[s.key] || s.title)}</a>`).join("")}
        <div class="rv-lg"><b>하이라이트</b><br><i class="c1"></i>1차 담임<br><i class="c2"></i>2차 교과<br><i class="c3"></i>3차 위원
          <label class="inline-check"><input type="checkbox" id="rvOther" checked> 다른 선생님 하이라이트</label><br><b>가림</b> <span class="rv-mask">○○</span> 이름·학교</div></nav>
      <article class="rv-doc" id="rvDoc"></article>
      <aside class="rv-side"><div class="rv-tabs"><button type="button" class="on" data-tab="q">질문 <span id="rvQn"></span></button><button type="button" data-tab="p">지난 면접 <span id="rvPn"></span></button></div>
        <div class="rv-sb" id="rvSb"></div>
        <div class="rv-foot"><span class="muted sm" id="rvAsk"></span><button type="button" class="btn-primary" id="rvRec">기록 쓰기 →</button></div></aside>
    </div>
    <div class="rv-grades" id="rvGrades" hidden></div>
    <div class="rv-pop" id="rvPop" hidden><button type="button" id="rvHl">하이라이트</button><button type="button" id="rvQ">질문 만들기</button></div>
    <div class="rv-cover" id="rvCover" hidden><div><h3>화면을 가렸어요</h3><p>다른 창으로 가면 학생부를 가려요. 5분 동안 조작이 없으면 닫혀요.</p><button type="button" class="btn-primary" id="rvUnCover">다시 보기</button></div></div>`;
  document.body.append(ov);
  document.body.classList.add("rv-open");
  // 보호: 복사·잘라내기·오른쪽 클릭·끌어 놓기 막기, 인쇄 때 숨김, 다른 창 가림, 5분 무조작 닫힘
  ["copy", "cut", "contextmenu", "dragstart"].forEach((t) => ov.addEventListener(t, (e) => { if (!e.target.closest("input, textarea")) e.preventDefault(); }));
  const on = (tgt, t, f, o) => { tgt.addEventListener(t, f, o); V.off.push(() => tgt.removeEventListener(t, f, o)); };
  const cover = () => { if (V) $("#rvCover", ov).hidden = false; };
  on(document, "visibilitychange", () => { if (document.hidden) cover(); });
  on(window, "blur", cover);
  on(window, "beforeprint", () => ov.classList.add("rv-print"));
  on(window, "afterprint", () => ov.classList.remove("rv-print"));
  const idleMs = window.__recIdleMs || IDLE_MS;   // (시험용으로만 짧게 바꿈)
  const bump = () => { if (!V) return; clearTimeout(V.idle); V.idle = setTimeout(() => { closeRecordViewer(); toast("5분 동안 조작이 없어 학생부를 닫았어요."); }, idleMs); };
  ["mousemove", "keydown", "scroll", "pointerdown", "wheel", "touchstart"].forEach((t) => on(document, t, bump, { capture: true, passive: true }));
  bump();
  V.off.push(() => document.body.classList.remove("rv-open"));
  $("#rvUnCover", ov).onclick = () => { $("#rvCover", ov).hidden = true; };
  $("#rvClose", ov).onclick = closeRecordViewer;
  $("#rvTmBtn", ov).onclick = () => {
    V.run = !V.run;
    if (V.run) { V.t0 = Date.now() - V.used * 1000; V.tick = setInterval(() => { V.used = Math.floor((Date.now() - V.t0) / 1000); $("#rvTm", ov).textContent = `면접 ${String(Math.floor(V.used / 60)).padStart(2, "0")}:${String(V.used % 60).padStart(2, "0")}`; }, 500); }
    else clearInterval(V.tick);
    $("#rvTmBtn", ov).textContent = V.run ? "멈춤" : "면접 시작";
  };
  $$("[data-stage]", ov).forEach((b) => b.onclick = () => { V.stage = Number(b.dataset.stage); $$("[data-stage]", ov).forEach((x) => x.classList.toggle("on", x === b)); drawSide(); });
  $("#rvOther", ov).onchange = (e) => { V.otherHl = e.target.checked; drawDoc(); };
  $$(".rv-tabs [data-tab]", ov).forEach((b) => b.onclick = () => { $$(".rv-tabs [data-tab]", ov).forEach((x) => x.classList.toggle("on", x === b)); V.tab = b.dataset.tab; drawSide(); });
  $("#rvRec", ov).onclick = toMeetingForm;
  // [학생부 | 성적]: 성적은 학생부를 넣을 때 '성적 표도 넣기'를 고른 경우에만 있음
  const grSt = { on: new Set(["주요과목", "전과목"]), radar: "all", view: "sum", yr: 0 };
  $$("[data-main]", ov).forEach((b) => b.onclick = () => {
    const gr = b.dataset.main === "gr";
    $$("[data-main]", ov).forEach((x) => x.classList.toggle("on", x === b));
    $(".rv-body", ov).hidden = gr; $("#rvGrades", ov).hidden = !gr; $("#rvPop", ov).hidden = true;
    if (gr) renderGrades($("#rvGrades", ov), V.rec.grades || [], grSt);
  });
  V.tab = "q";
  drawDoc(); drawSide();
  // 선택 → 띄움
  const docEl = $("#rvDoc", ov), pop = $("#rvPop", ov);
  const showPop = () => setTimeout(() => {
    if (!V) return;
    const sel = getSelection(), pos = selPos(sel, ".rv-cell");
    if (!pos) { pop.hidden = true; return; }
    V.sel = { sec: pos.el.dataset.sec, row: Number(pos.el.dataset.row), start: pos.start, end: pos.end, quote: pos.text };
    const r = sel.getRangeAt(0).getBoundingClientRect();
    pop.style.left = `${Math.min(window.innerWidth - 180, Math.max(8, r.left + r.width / 2 - 90))}px`; pop.style.top = `${Math.min(window.innerHeight - 52, Math.max(8, r.top - 46))}px`; pop.hidden = false;
  }, 0);
  docEl.addEventListener("mouseup", showPop);
  docEl.addEventListener("touchend", showPop);
  on(document, "selectionchange", () => { if (V && getSelection().isCollapsed) setTimeout(() => { if (V && getSelection().isCollapsed) pop.hidden = true; }, 200); });
  $("#rvHl", ov).onclick = () => { pop.hidden = true; addMark("hl"); };
  $("#rvQ", ov).onclick = () => { pop.hidden = true; questionForm(); };
  docEl.addEventListener("click", (e) => {
    const gb = e.target.closest("[data-gr]");
    if (gb) { V.grade[gb.closest("[data-grsec]").dataset.grsec] = gb.dataset.gr; drawDoc(); return; }
    const mk = e.target.closest("mark[data-mk]"); if (mk) focusQuestion(mk.dataset.mk);
  });
  // 하이라이트·질문·지난 면접 불러오기
  try {
    const [mk, pd, pq] = await Promise.all([
      getDocs(collection(db, "records", no, "marks")), getDocs(collection(db, "records", no, "pending")), getDocs(collection(db, "students", no, "personalQuestions"))]);
    if (!V || V.no !== no) return;
    V.marks = mk.docs.map((d) => ({ id: d.id, ...d.data() }));
    V.pending = pd.docs.map((d) => ({ id: d.id, ...d.data() }));
    V.pqs = pq.docs.map((d) => ({ id: d.id, ...d.data() }));
  } catch (e) { console.warn("학생부 하이라이트·질문 불러오기", e); toast("하이라이트·질문을 불러오지 못했어요. 학생부는 볼 수 있어요.", "error"); }
  if (!V) return;
  drawDoc(); drawSide();
  loadMeetingNotes(no).then((n) => { if (V && V.no === no) { V.notes = n; drawSide(); } }).catch(() => { if (V && V.no === no) { V.notesFail = true; drawSide(); } });
}
const markStageCls = (m) => `c${Number(m.stage) || 1}`;
function drawDoc() {
  const el = document.getElementById("rvDoc"); if (!el || !V) return;
  const mine = (m) => m.byUid === S.ctx.user.uid;
  // 창체·세특은 학년을 골라 볼 수 있게 (칸 이름 앞 'n학년'으로)
  const gOf = (r) => (String(r.label || "").match(/^([1-3])학년/) || [])[1] || "";
  el.innerHTML = V.rec.sections.map((s) => {
    const gs = ["creative", "subject"].includes(s.key) ? [...new Set(s.rows.map(gOf).filter(Boolean))].sort() : [];
    const pickG = gs.includes(V.grade[s.key]) ? V.grade[s.key] : "";
    return `<h3 id="rvs-${s.key}">${esc(s.title)}${gs.length > 1 ? `<span class="rv-gr" data-grsec="${s.key}">${["", ...gs].map((g) => `<button type="button" data-gr="${g}" class="${pickG === g ? "on" : ""}">${g ? g + "학년" : "전체"}</button>`).join("")}</span>` : ""}</h3><table>${s.rows.map((r, ri) => {
      const ms = V.marks.filter((m) => (V.otherHl || mine(m))).map((m) => ({ ...m, ...placeOf(m, s.key, ri, r.text) })).filter((m) => m.ok);
      return `<tr${pickG && gOf(r) !== pickG ? " hidden" : ""}><th>${esc(r.label || "")}</th><td class="rv-cell" data-sec="${s.key}" data-row="${ri}">${paint(r.text, ms)}</td></tr>`;
    }).join("")}</table>`;
  }).join("") + `<p class="muted sm">대입에 쓰는 항목만 넣었어요 (인적사항·수상·자격증·봉사·독서 없음) · ${V.rec.ver || 1}번째 판</p>`;
}
// 하이라이트 자리: 저장된 자리의 글이 quote 와 같으면 그대로, 아니면 같은 칸에서 quote 를 다시 찾음 (못 찾으면 안 그림)
function placeOf(m, sec, row, text) {
  if (m.sec !== sec || Number(m.row) !== row) return { ok: false };
  if (text.slice(m.start, m.end) === m.quote) return { ok: true, s: m.start, e: m.end };
  const i = m.quote ? text.indexOf(m.quote) : -1;
  return i >= 0 ? { ok: true, s: i, e: i + m.quote.length } : { ok: false };
}
function paint(text, ms) {
  const cuts = new Set([0, text.length]);
  ms.forEach((m) => { cuts.add(m.s); cuts.add(m.e); });
  const pts = [...cuts].sort((a, b) => a - b);
  let h = "";
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i], b = pts[i + 1], seg = text.slice(a, b);
    const top = ms.filter((m) => m.s <= a && m.e >= b).at(-1);
    h += top ? `<mark class="${markStageCls(top)}${top.kind === "q" ? " q" : ""}" data-mk="${esc(top.id)}">${maskSpans(seg)}</mark>` : maskSpans(seg);
  }
  return h;
}
const maskSpans = (s) => esc(s).replace(/○+[가-힣]?(?=[^가-힣]|$)|○+/g, (x) => `<span class="rv-mask">${x}</span>`);
async function addMark(kind, extra = {}) {
  if (!V?.sel) return null;
  const s = V.sel; V.sel = null; getSelection().removeAllRanges();
  const data = { kind, stage: V.stage, by: myName() || S.ctx.user.email, byUid: S.ctx.user.uid, sec: s.sec, row: s.row, start: s.start, end: s.end, quote: s.quote, at: Date.now(), ...extra };
  const ref = doc(collection(db, "records", V.no, "marks"));
  if (kind === "hl") {
    try { await setDoc(ref, data); V.marks.push({ id: ref.id, ...data }); drawDoc(); } catch (e) { showError(e, "하이라이트"); }
  }
  return { ref, data };
}
function questionForm() {
  if (!V?.sel) return;
  const s = V.sel;
  const label = V.rec.sections.find((x) => x.key === s.sec)?.rows[s.row]?.label || "";
  const basis = `${SEC_SHORT[s.sec] || ""}${label ? " · " + label : ""} "${s.quote.length > 120 ? s.quote.slice(0, 120) + "…" : s.quote}"`;
  V.tab = "new";
  $$(".rv-tabs [data-tab]").forEach((x) => x.classList.remove("on"));
  const sb = document.getElementById("rvSb");
  sb.innerHTML = `<div class="rv-new"><h4>질문 만들기 <span class="tag ${`c${V.stage}`}">${V.stage}차</span></h4>
    <div class="muted sm">근거</div><div class="rv-basis">${maskSpans(basis)}</div>
    <div class="field"><label>질문</label><textarea id="rvQt" rows="3" placeholder="학생에게 물을 질문"></textarea></div>
    <div class="field"><label>꼬리질문 (선택 · 한 줄에 하나)</label><textarea id="rvQf" rows="2"></textarea></div>
    <div class="field"><label>공개 시점</label>
      <label class="inline-check"><input type="radio" name="rvPub" value="after" checked> 면접 뒤 공개 <span class="muted sm">(이 차수 대면 기록을 저장할 때 학생 '내 생기부 면접'에 더해져요)</span></label>
      <label class="inline-check"><input type="radio" name="rvPub" value="now"> 바로 공개</label></div>
    <div class="muted sm" id="rvQErr" style="color:var(--danger)"></div>
    <div class="row"><button type="button" class="btn-sm" id="rvQX">취소</button><div class="spacer"></div><button type="button" class="btn-primary btn-sm" id="rvQOk">저장</button></div></div>`;
  $("#rvQX", sb).onclick = () => { V.sel = null; V.tab = "q"; $(".rv-tabs [data-tab=q]")?.classList.add("on"); drawSide(); };
  $("#rvQOk", sb).onclick = async () => {
    const text = $("#rvQt", sb).value.trim(), fu = $("#rvQf", sb).value.split("\n").map((x) => x.trim()).filter(Boolean);
    const bad = !text ? "질문을 적어 주세요." : badQuestionText(text + "\n" + fu.join("\n"), V.no);
    if (bad) { $("#rvQErr", sb).textContent = bad; return; }
    const pub = $("input[name=rvPub]:checked", sb).value;
    const me = myName() || S.ctx.user.email;
    $("#rvQOk", sb).disabled = true;
    try {
      const mref = doc(collection(db, "records", V.no, "marks"));
      const mark = { kind: "q", stage: V.stage, by: me, byUid: S.ctx.user.uid, sec: s.sec, row: s.row, start: s.start, end: s.end, quote: s.quote, at: Date.now() };
      if (pub === "after") {
        const pref = doc(collection(db, "records", V.no, "pending"));
        const p = { text, followUps: fu, basis, sec: s.sec, stage: V.stage, by: me, byUid: S.ctx.user.uid, markId: mref.id, createdAt: serverTimestamp() };
        const b = writeBatch(db);
        b.set(pref, p); b.set(mref, { ...mark, qid: pref.id });
        await b.commit();
        V.pending.push({ id: pref.id, ...p, createdAt: { seconds: Date.now() / 1000 } }); V.marks.push({ id: mref.id, ...mark, qid: pref.id });
      } else {
        const col = collection(db, "students", V.no, "personalQuestions");
        const cur = (await getDocs(col)).docs.map((d) => ({ id: d.id, ...d.data() }));
        const qref = doc(col);
        const row = { text, basis, followUps: fu, category: `${V.stage}차 선생님 질문`, type: "document", by: "teacher", addedBy: me, source: "record", stage: V.stage };
        const stats = pqStats([...cur, row]);
        const b = writeBatch(db);
        b.set(qref, { ...row, createdAt: serverTimestamp() }); b.set(mref, { ...mark, qid: qref.id }); b.update(doc(db, "students", V.no), stats);
        await b.commit();
        Object.assign(studentByNo(V.no) || {}, stats);
        V.pqs = [...cur, { id: qref.id, ...row, createdAt: { seconds: Date.now() / 1000 } }]; V.marks.push({ id: mref.id, ...mark, qid: qref.id });
        log(V.no, "publish");
      }
      V.sel = null; getSelection().removeAllRanges();
      toast(pub === "after" ? "질문을 저장했어요 (면접 뒤 공개)" : "질문을 학생에게 공개했어요");
      V.tab = "q"; $(".rv-tabs [data-tab=q]")?.classList.add("on");
      drawDoc(); drawSide();
    } catch (e) { $("#rvQOk", sb).disabled = false; showError(e, "질문 저장"); }
  };
  $("#rvQt", sb).focus();
}
// 질문 카드 목록: 이 학생의 '내 생기부 면접' + 공개 전 질문
function cards() {
  const me = S.ctx.user.uid, myNm = myName();
  const stageOf = (q) => Number(q.stage) || Number(String(q.category || "").match(/^(\d)차/)?.[1]) || 0;
  const out = [];
  V.pending.forEach((p) => out.push({ key: "p:" + p.id, pend: p.id, text: p.text, basis: p.basis, followUps: p.followUps || [], stage: Number(p.stage), by: p.by, mine: p.byUid === me, status: "after", kind: "teacher" }));
  V.pqs.forEach((q) => {
    const stu = q.by === "student";
    const rec = q.source === "record" || q.source === "meeting";
    out.push({ key: "q:" + q.id, pq: q.id, text: q.text, basis: q.basis, followUps: q.followUps || [], stage: stageOf(q), by: stu ? "학생" : (q.addedBy || "선생님"),
      mine: !stu && rec && !!myNm && q.addedBy === myNm, status: "pub", kind: stu ? "student" : rec ? "teacher" : "old" });
  });
  return out;
}
function drawSide() {
  if (!V) return;
  const sb = document.getElementById("rvSb"); if (!sb) return;
  const all = cards();
  $("#rvQn").textContent = all.length;
  const ag = V.notes ? againOf() : [];
  $("#rvPn").textContent = ag.length ? `↻${ag.length}` : "";
  const asked = [...V.asked.values()].filter((a) => a.asked).length;
  $("#rvAsk").textContent = asked ? `물어봄 ${asked}개 → 받은 질문으로 가요` : "";
  if (V.tab === "new") return;
  if (V.tab === "p") return drawPast(sb);
  const f = V.flt;
  const list = all.filter((c) => f === "all" || (f === "mine" ? c.mine : f === "other" ? c.kind === "teacher" && !c.mine : c.kind !== "teacher"));
  const pendN = V.pending.filter((p) => Number(p.stage) === V.stage).length;
  sb.innerHTML = `<div class="rv-flt">${[["all", "모두"], ["mine", "내 질문"], ["other", "다른 선생님"], ["stu", "학생·예전 질문"]].map(([k, t]) => `<button type="button" data-flt="${k}" class="${f === k ? "on" : ""}">${t}</button>`).join("")}</div>
    ${pendN ? `<div class="muted sm" style="margin:6px 0">${V.stage}차 '면접 뒤 공개' 질문 ${pendN}개 — 이 차수 대면 기록을 저장할 때 학생에게 공개돼요</div>` : ""}
    ${list.map((c) => { const a = V.asked.get(c.key) || {}; const mk = V.marks.find((m) => m.qid === (c.pend || c.pq));
      return `<div class="rv-card${a.asked ? " asked" : ""}" data-card="${esc(c.key)}" ${mk ? `data-mk="${esc(mk.id)}"` : ""}>
        <div class="row">${c.kind === "student" ? '<span class="tag">학생</span>' : c.kind === "old" ? '<span class="tag">예전 질문</span>' : `<span class="tag c${c.stage || 1}">${c.stage || "?"}차</span>`}
          <span class="muted sm">${esc(c.by || "")}${c.mine ? " (나)" : ""}</span><div class="spacer"></div><span class="badge ${c.status === "after" ? "badge-orange" : "badge-green"}">${c.status === "after" ? "면접 뒤 공개" : "공개됨"}</span></div>
        ${c.basis ? `<div class="rv-basis">${maskSpans(c.basis)}</div>` : ""}
        <div class="rv-qt">${esc(c.text)}</div>${c.followUps.length ? `<div class="muted sm">↳ ${c.followUps.map(esc).join(" · ")}</div>` : ""}
        <div class="row rv-acts"><button type="button" class="btn-sm${a.asked ? " on" : ""}" data-asked>${a.asked ? "물어봄 ✓" : "물어봄"}</button>
          <button type="button" class="btn-sm mt-ag${a.again ? " on" : ""}" data-again>↻ 다음 차수에 다시</button>
          ${c.pend && c.mine ? '<div class="spacer"></div><button type="button" class="btn-sm btn-danger" data-delq>지우기</button>' : ""}</div>
        ${a.asked ? `<input class="mt-memo" data-memo placeholder="학생 답 메모 (선생님끼리만)" value="${esc(a.memo || "")}">` : ""}</div>`; }).join("") || '<div class="muted sm">질문이 없어요. 학생부 글을 드래그해 [질문 만들기].</div>'}`;
  $$("[data-flt]", sb).forEach((b) => b.onclick = () => { V.flt = b.dataset.flt; drawSide(); });
  $$("[data-card]", sb).forEach((el) => {
    const c = all.find((x) => x.key === el.dataset.card);
    const st = () => V.asked.get(c.key) || V.asked.set(c.key, { asked: false, again: false, memo: "", q: c.text, pend: c.pend || "", pq: c.pq || "" }).get(c.key);
    $("[data-asked]", el).onclick = () => { const a = st(); a.asked = !a.asked; drawSide(); };
    $("[data-again]", el).onclick = () => { const a = st(); a.again = !a.again; if (a.again) a.asked = true; drawSide(); };
    $("[data-memo]", el)?.addEventListener("input", (e) => { st().memo = e.target.value; });
    $("[data-delq]", el)?.addEventListener("click", async () => {
      if (!(await confirmBox({ title: "이 질문을 지울까요?", what: esc(c.text), note: "공개 전 질문만 지울 수 있어요. 하이라이트도 같이 지워져요.", yes: "지우기" }))) return;
      try {
        const b = writeBatch(db);
        b.delete(doc(db, "records", V.no, "pending", c.pend));
        V.marks.filter((m) => m.qid === c.pend).forEach((m) => b.delete(doc(db, "records", V.no, "marks", m.id)));
        await b.commit();
        V.pending = V.pending.filter((p) => p.id !== c.pend); V.marks = V.marks.filter((m) => m.qid !== c.pend); V.asked.delete(c.key);
        drawDoc(); drawSide();
      } catch (e) { showError(e, "질문 지우기"); }
    });
  });
}
function focusQuestion(markId) {
  const m = V?.marks.find((x) => x.id === markId); if (!m) return;
  if (m.kind !== "q") return;
  V.tab = "q"; V.flt = "all"; $$(".rv-tabs [data-tab]").forEach((x) => x.classList.toggle("on", x.dataset.tab === "q")); drawSide();
  const el = $(`#rvSb [data-mk="${CSS.escape(markId)}"]`);
  el?.scrollIntoView({ block: "center" }); el?.classList.add("flash"); setTimeout(() => el?.classList.remove("flash"), 1200);
}
const againOf = () => (V.notes ? againList(V.no, V.notes) : []);
function drawPast(sb) {
  if (!V.notes) { sb.innerHTML = `<div class="muted sm">${V.notesFail ? "지난 면접을 불러오지 못했어요." : "지난 면접을 불러오는 중…"}</div>`; return; }
  sb.innerHTML = `<div id="rvPast" class="mt-past rv-past"></div>`;
  renderPast($("#rvPast", sb), V.no, V.notes, {
    putLabel: "질문 칸에 넣기",
    put: (a) => { V.asked.set(`a:${a.mid}:${a.qid}`, { asked: true, again: false, memo: "", q: a.q, from: { mid: a.mid, qid: a.qid } }); toast("질문 칸에 넣었어요 — [기록 쓰기] 때 받은 질문으로 가요"); drawSide(); },
    used: new Set([...V.asked.values()].filter((x) => x.from).map((x) => x.from.mid + ":" + x.from.qid))
  });
}
// [기록 쓰기 →] — 2단계 대면 기록 창을 이 화면 위에 엶. '물어봄'한 질문(글·메모·다시·id 만)을 받은 질문 칸으로
async function toMeetingForm() {
  const rows = [...V.asked.values()].filter((a) => a.asked && a.q).map((a) => ({ q: a.q, memo: a.memo || "", again: !!a.again, ...(a.pend ? { pend: a.pend } : {}), ...(a.pq ? { pq: a.pq } : {}), ...(a.from ? { from: a.from } : {}) }));
  const p = V.preset;
  const existing = p?.id && (S.meetings || []).find((m) => m.id === p.id && !m.planned);
  openMeetingForm(existing ? { id: existing.id, fromRecord: { stage: V.stage, rows } }
    : { studentNo: V.no, preset: p && p.id ? { ...p, stage: p.stage || V.stage } : null, fromRecord: { stage: V.stage, rows } });
}

// ================= E. 관리 화면 '학생부' =================
export async function renderRecordAdmin(p) {
  p.innerHTML = `<div class="card"><h3>학생부</h3>
    <p class="muted" style="margin-top:0">배정 선생님(1·2·3차)과 관리자만 보는 가림본 학생부예요. <b>학생부는 백업하지 않아요.</b> 입시가 끝나면 한꺼번에 지워 주세요.<br>
    · 볼 수 있는지는 교사 계정 이름과 학생 배정 칸(1차 담임·2차 교과·3차 위원)의 이름이 같은지로 정해요. 선생님 이름을 바꾸면 배정 칸도 맞춰 주세요.<br>
    · 열람 기록은 남아요 (학생부 내용은 없음).</p>
    <dl class="kv" id="raSum"><dt>넣은 학생</dt><dd class="muted">불러오는 중…</dd></dl>
    <div class="row" style="margin-top:10px"><button type="button" class="btn-sm" id="raLogs">열람 기록 보기</button><div class="spacer"></div><button type="button" class="btn-sm btn-danger" id="raDelAll">입시 후 일괄 삭제</button></div>
    <div id="raLogBox" style="margin-top:12px"></div></div>`;
  let nos = [];
  try {
    const snap = await getDocs(collection(db, "records"));
    // 학생부 글은 바로 버리고 학번·저장 시각만 남긴다
    const rows = snap.docs.map((d) => ({ no: d.id, at: d.data().savedAt?.seconds ? d.data().savedAt.seconds * 1000 : 0, by: d.data().savedBy || "" }));
    nos = rows.map((r) => r.no);
    const last = rows.sort((a, b) => b.at - a.at)[0];
    $("#raSum", p).innerHTML = `<dt>넣은 학생</dt><dd><b>${rows.length}명</b></dd><dt>마지막으로 넣은 날</dt><dd>${last?.at ? `${new Date(last.at).toLocaleString("ko-KR")} · ${esc(last.by)}` : "-"}</dd>`;
  } catch (e) { $("#raSum", p).innerHTML = `<dt>넣은 학생</dt><dd class="muted">불러오지 못했어요</dd>`; console.warn(e); }
  $("#raDelAll", p).onclick = async () => { if (await deleteRecords(nos, { all: true })) renderRecordAdmin(p); };
  $("#raLogs", p).onclick = async () => {
    const box = $("#raLogBox", p);
    box.innerHTML = '<span class="muted">불러오는 중…</span>';
    try {
      const logs = (await getDocs(collection(db, "recordLogs"))).docs.map((d) => d.data()).map((x) => ({ ...x, ms: x.at?.seconds ? x.at.seconds * 1000 : 0 }))
        .sort((a, b) => b.ms - a.ms).slice(0, 200);
      const who = [...new Set(logs.map((l) => l.by))], stu = [...new Set(logs.map((l) => l.studentNo))].sort();
      const ACT = { open: "열람", upload: "넣기", delete: "지우기", publish: "질문 공개" };
      const draw = () => {
        const fs = $("#raStu", box).value, fw = $("#raWho", box).value;
        const L = logs.filter((l) => (!fs || l.studentNo === fs) && (!fw || l.by === fw));
        $("#raBody", box).innerHTML = L.map((l) => `<tr><td class="nowrap">${l.ms ? new Date(l.ms).toLocaleString("ko-KR") : "-"}</td><td>${esc(l.studentNo)} ${esc(studentByNo(l.studentNo)?.name || "")}</td><td>${esc(l.by)}</td><td>${esc(ACT[l.action] || l.action)}</td></tr>`).join("") || '<tr><td colspan="4" class="empty">기록이 없어요</td></tr>';
      };
      box.innerHTML = `<div class="row"><select id="raStu"><option value="">모든 학생</option>${stu.map((n) => `<option value="${esc(n)}">${esc(n)} ${esc(studentByNo(n)?.name || "")}</option>`).join("")}</select>
        <select id="raWho"><option value="">모든 선생님</option>${who.map((n) => `<option>${esc(n)}</option>`).join("")}</select><span class="muted sm">최근 200건</span></div>
        <div class="table-wrap"><table><thead><tr><th>시각</th><th>학생</th><th>선생님</th><th>한 일</th></tr></thead><tbody id="raBody"></tbody></table></div>`;
      $("#raStu", box).onchange = draw; $("#raWho", box).onchange = draw; draw();
    } catch (e) { box.innerHTML = '<span class="muted">열람 기록을 불러오지 못했어요.</span>'; console.warn(e); }
  };
}
