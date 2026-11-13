// 학생부 열람 · PDF 넣기 · 드래그 질문 (2026-10-30 3단계, spec-stage3)
// - records/{학번}: 가림본 학생부 (배정 선생님 1·2·3차 + 관리자만 읽기, 넣기는 1차 담임·관리자)
// - records/{학번}/marks: 하이라이트·질문 표시 · records/{학번}/pending: '면접 뒤 공개' 질문
// - recordLogs: 열람·넣기·공개 기록 (관리자만 읽기)
// - records/{학번}/aiq · aimeta: AI 맞춤 예상질문 초안·실행 상태 (2026-11-03, booth-ai Apps Script 가 만듦 — 배정 선생님·관리자만)
// 학생부 글은 브라우저 저장소·캐시 목록·백업에 넣지 않는다. 화면을 닫으면 변수에서도 버린다.
// PDF 는 이 브라우저 안에서만 읽고 어디에도 올리지 않는다 (저장되는 것은 가림본 글뿐).
import {
  db, collection, doc, getDoc, getDocs, setDoc, addDoc, updateDoc, deleteDoc, writeBatch, serverTimestamp, runTransaction, onSnapshot,
  $, $$, esc, toast, showError, confirmBox, pqStats, fmtDay, STAGES, univName, announceFailed, aiCall
} from "./common.js";
import { S, myName, myRoles, studentByNo, closeModal } from "./t-core.js";
import { openMeetingForm, loadMeetingNotes, againList, renderPast } from "./t-meetings.js";

const PDFJS = "lib/pdfjs-3.11.174/";
const IDLE_MS = 5 * 60 * 1000;
const SEC_TITLE = { attend: "출결 상황", creative: "창의적 체험활동", subject: "교과학습발달상황 · 세부능력 및 특기사항", volunteer: "봉사활동실적 (학교 계획)", behavior: "행동특성 및 종합의견", grades: "성적" };
const SEC_SHORT = { attend: "출결", creative: "창의적 체험활동", subject: "교과 세특", volunteer: "봉사활동", behavior: "행동특성 및 종합의견", grades: "성적" };
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
const isHangul = (c) => !!c && /[가-힣]/.test(c);
const PARTICLE = /^(와|과|이|가|은|는|을|를|의|에게|도|랑|이랑|하고|께|님)/;
function namesList(no) {
  const me = studentByNo(no)?.name || "";
  return [...new Set([...(S.students || []).map((s) => s.name), ...(S.staff || []).map((t) => t.name)])]
    .filter((n) => n && n.length >= 2 && n !== me).sort((a, b) => b.length - a.length);
}
// 글에서 자동으로 가릴 자리 [{start,end,kind,repl}] (겹치면 앞의 것)
// 학교는 '○○고등학교·○○여자고등학교·○○중학교·○○초등학교' 이름 전체와 '오송고'만 (2026-10-31: '~고·~중 + 조사' 꼴은 존중·집중 같은 낱말이 걸려서 뺌)
export function autoMasks(text, names) {
  const out = [];
  const add = (start, end, kind, repl) => { if (!out.some((m) => start < m.end && end > m.start)) out.push({ start, end, kind, repl, auto: true }); };
  let m;
  const re1 = /[가-힣]*?(?:여자)?(고등학교|중학교|초등학교)/g;
  while ((m = re1.exec(text))) { if (m[0].length > m[1].length) add(m.index, m.index + m[0].length, "school", m[1] === "중학교" ? "○○중" : m[1] === "초등학교" ? "○○초" : "○○고"); }
  const re2 = /오송고(?:등학교)?/g;
  while ((m = re2.exec(text))) add(m.index, m.index + m[0].length, "school", "○○고");
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
  // 주민등록번호 꼴 (2쪽부터는 쪽을 버리지 않으므로 번호만 가림)
  const re6 = /\d{6}\s*-\s*[1-4*][\d*]{6}/g;
  while ((m = re6.exec(text))) add(m.index, m.index + m[0].length, "id", "○○○");
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
    }).filter((l) => l.text), rules: await pageRules(pg, lib) });
    pg.cleanup?.();
  }
  await pdf.destroy?.();
  return pages;
}

// 표 가로선 [{y, x1, x2, dash}] (2026-11-01): 칸 경계는 '이름 칸까지 덮는 선'으로 찾는다 (글 위치로 짐작하지 않음)
//   선분(moveTo·lineTo)과 얇은 사각형(높이 2 미만, 채운 것 포함). 점선(setDash)인지도 남김. 못 읽으면 [] (지금 방식으로 대신)
async function pageRules(pg, lib) {
  try {
    const O = lib.OPS, ol = await pg.getOperatorList();
    const mul = (m, n) => [m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1], m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3], m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5]];
    const ap = (m, x, y) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
    const PAINT = new Set([O.stroke, O.closeStroke, O.fill, O.eoFill, O.fillStroke, O.eoFillStroke, O.closeFillStroke, O.closeEOFillStroke]);
    let ctm = [1, 0, 0, 1, 0, 0], dash = false, pend = [];
    const st = [], out = [];
    const add = (a, b, d) => { if (Math.abs(a[1] - b[1]) < 2.2 && Math.abs(b[0] - a[0]) > 4) out.push({ y: (a[1] + b[1]) / 2, x1: Math.min(a[0], b[0]), x2: Math.max(a[0], b[0]), dash: d }); };
    for (let i = 0; i < ol.fnArray.length; i++) {
      const f = ol.fnArray[i], a = ol.argsArray[i];
      if (f === O.save) st.push([ctm, dash]);
      else if (f === O.restore) [ctm, dash] = st.pop() || [ctm, dash];
      else if (f === O.transform) ctm = mul(ctm, a);
      else if (f === O.setDash) dash = (a?.[0] || []).length > 0;
      else if (f === O.constructPath) {
        const [ops, c] = a; let k = 0, cur = null;
        for (const op of ops) {
          if (op === O.moveTo) { cur = ap(ctm, c[k], c[k + 1]); k += 2; }
          else if (op === O.lineTo) { const q = ap(ctm, c[k], c[k + 1]); k += 2; if (cur) pend.push([cur, q]); cur = q; }
          else if (op === O.rectangle) { const p0 = ap(ctm, c[k], c[k + 1]), p1 = ap(ctm, c[k] + c[k + 2], c[k + 1] + c[k + 3]); k += 4; pend.push([p0, p1]); }
          else if (op === O.curveTo) k += 6; else if (op === O.curveTo2 || op === O.curveTo3) k += 4;
        }
      } else if (PAINT.has(f)) { pend.forEach(([p0, p1]) => add(p0, p1, dash)); pend = []; }
      else if (f === O.endPath) pend = [];
    }
    // 같은 높이·같은 종류 조각은 하나로 (점선을 짧은 선 여러 개로 그린 PDF)
    const m = [];
    out.sort((a, b) => b.y - a.y || a.x1 - b.x1).forEach((r) => { const g = m.find((x) => Math.abs(x.y - r.y) < 0.8 && x.dash === r.dash && r.x1 <= x.x2 + 12); if (g) { g.x2 = Math.max(g.x2, r.x2); g.x1 = Math.min(g.x1, r.x1); g.n++; } else m.push({ ...r, n: 1 }); });
    return m.map((r) => ({ y: r.y, x1: r.x1, x2: r.x2, dash: r.dash || r.n > 6 }));
  } catch (e) { console.warn("표 선 읽기", e); return []; }
}
// 선으로 칸 나누기: 이름 칸(x0)부터 글 칸(x1)까지 덮는 선 = 칸 경계 (희망분야 밑 점선처럼 글 칸만 덮는 선은 경계 아님)
// T(줄)·A(이름) → partition 과 같은 모양 { prefix, blocks:[{a, lines}], orphan } — 경계가 2개 미만이면 null (지금 방식으로)
function partitionByRules(T, A, rules, x0, x1) {
  const B = [...new Set((rules || []).filter((r) => r.x1 <= x0 && r.x2 >= x1).map((r) => Math.round(r.y * 10) / 10))].sort((a, b) => b - a);
  if (B.length < 2) return null;
  const cells = [];
  const edges = [Infinity, ...B, -Infinity];
  for (let i = 0; i < edges.length - 1; i++) {
    const hi = edges[i], lo = edges[i + 1];
    const lines = T.filter((t) => t.y < hi && t.y > lo), names = A.filter((a) => a.y < hi && a.y > lo);
    if (lines.length || names.length) cells.push({ lines, a: names[0] || null });
  }
  const prefix = [], blocks = [];
  cells.forEach((c) => {
    if (c.a) blocks.push({ a: c.a, lines: c.lines });
    else if (blocks.length) blocks.at(-1).lines.push(...c.lines);   // 이름 없는 칸이 가운데에 있으면 앞 칸에
    else prefix.push(...c.lines);   // 쪽 맨 위 이름 없는 칸 = 앞 쪽에서 이어진 칸
  });
  return { prefix, blocks, orphan: [] };
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
  [head("봉사활동실적"), "volunteer"],
  [head("교과학습발달상황"), "subject"],
  [head("독서활동상황"), "drop", "독서활동상황"],
  [head("행동특성및종합의견"), "behavior"],
  [head("정정대장"), "drop", "정정대장"]   // '개인별 대입전형자료 조회' 끝의 정정대장 표 (2026-11-10: 행특 3학년으로 잡히던 것)
];
// 인적사항 쪽 (2026-10-30 사용자 결정: 인적사항은 1쪽에만 있음):
//   1쪽만 검사 — 주민등록번호 꼴이 있거나 '성명'·'성별' 칸 이름(조각 글 전체, 띄어쓰기만 허용)이 함께 있으면 1쪽 버림 (머리말·꼬리말 줄은 뺌)
//   그런 게 없으면(1쪽을 빼고 올린 파일) 1쪽도 남김. 2쪽부터는 쪽을 버리지 않음 (주민등록번호 꼴은 autoMasks 가 가림)
const PII_NUM = /\d{6}-[1-4*][\d*]{6}/;
// isHF(p, i): 머리말·꼬리말로 지우는 줄 (꼬리말에 '성명'이 찍힐 수 있어서 칸 이름 셀 때 뺌)
function piiWhy(p, isHF = () => false) {
  if (p.lines.some((l) => PII_NUM.test(l.text.replace(/ +/g, "")))) return "주민등록번호";
  const labels = new Set();
  p.lines.forEach((l, i) => { if (!isHF(p, i)) (l.segs || []).forEach((sg) => { const t = sg.s.replace(/\s+/g, ""); if (t === "성명" || t === "성별") labels.add(t); }); });
  return labels.size === 2 ? "성명·성별 칸" : "";
}
const TABLE_HEAD = /^(학년|영역|시간|특기\s*사항|학년\s*영역|영역\s*시간|구분|과\s*목|수업\s*일수|결석\s*일수|지각|조퇴|결과|비고|학기|단위수|원점수|석차등급|성취도)(\s|$)/;   // 출결 표 머리 (첫 낱말만 봄)
// 창체·행특 표 머리 줄: 줄의 낱말이 모두 머리 낱말일 때만 (2026-11-10: '결과 과학 기술 …' 처럼 머리 낱말로 시작하는 글 줄이 버려지던 것)
const HEAD_WORD = /^(학년|영역|시간|특기사항|특기|사항|구분|과목|과|목|수업일수|수업|일수|결석일수|결석|지각|조퇴|결과|비고|학기|단위수|원점수|석차등급|성취도|질병|미인정|기타)$/;
const isTableHead = (t) => t.length < 40 && t.trim().split(/\s+/).every((w) => HEAD_WORD.test(w));
const NOISE = /^[-–]?\s*\d+\s*[-–]?$|^\d+\s*\/\s*\d+$|출력|발급|페이지|쪽\s*\d/;
const AREA_RE = /^(자율\s*[·ㆍ]?\s*자치\s*활동|자율\s*활동|동아리\s*활동|봉사\s*활동|진로\s*활동)$/;
const areaIdx = (n) => /^자율/.test(n) ? 0 : /^동아리/.test(n) ? 1 : /^봉사/.test(n) ? 2 : 3;
const segText = (segs) => { let t = "", end = null; for (const s of segs) { if (end != null && s.x - end > 2) t += " "; t += s.s; end = s.x + (s.w || 0); } return t.replace(/\s+/g, " ").trim(); };
const isHg = (c) => !!c && /[가-힣]/.test(c);
// 줄 이어 붙이기: 앞 줄이 오른쪽 끝까지 찼고 한글끼리 이어지면 낱말 중간에서 끊긴 것
// 줄 이어 붙이기: 앞 줄이 오른쪽 끝까지 찼고 한글끼리 이어지면 낱말 중간에서 끊긴 것 (붙임)
// '찼다' = 줄 끝과 오른쪽 끝 사이가 반 글자 너비보다 좁음 (글자 너비 = 그 줄 글자 폭 평균 cw). 반 글자 이상 비면 띄어쓰기 자리에서 줄바꿈 (2026-11-02)
const lineCw = (x, r, text) => { const n = String(text || "").replace(/\s+/g, "").length; return n && r > x ? (r - x) / n : 0; };
function joinLines(lines, maxR) {
  let t = "", prev = null;
  for (const l of lines) {
    const s = l.t.trim(); if (!s) continue;
    const room = prev ? maxR - prev.r : 99, half = prev?.cw ? prev.cw / 2 : 15;
    const glue = prev && room < half && isHg(t.slice(-1)) && isHg(s[0]) ? "" : " ";
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
      const bottom = 2 * a.y - T[i].y, b = { a, lines: [], bottom };
      while (i < T.length && T[i].y >= bottom - tol) b.lines.push(T[i++]);
      blocks.push(b);
    }
    // mis: 칸 끝 줄이 '이름이 가운데'인 자리보다 한참 위에서 끝난 칸 수 (예: 쪽 끝의 빈 3학년 칸 숫자가 위 글을 모두 끌어가는 경우)
    const mis = blocks.filter((b) => b.lines.length && b.lines.at(-1).y - b.bottom > tol * 1.5).length;
    return { k, blocks, left: T.length - i, rest: T.slice(i), mis };
  };
  let best = null;
  for (let k = 0; k <= T.length; k++) { const r = run(k); if (!best || r.left < best.left || (r.left === best.left && r.mis < best.mis)) best = r; if (r.left === 0 && r.mis === 0) break; }
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
// keepP1: 선생님이 [1쪽도 넣기]를 체크 — 1쪽에 출결·창체(자율활동) 글이 이어지는 학생 (인적·학적사항 구역은 그대로 버림)
export function splitRecord(pages, { withGrades = false, keepP1 = false } = {}) {
  // p1: 1쪽 인적사항 — "drop"(버림) | "none"(없음 — 이미 뺀 파일, 남김)
  const info = { read: pages.length, kept: 0, dropped: [], headerLines: 0, lost: [], p1: "none" };
  // 빠진 글 검사: 특기사항 칸 줄(창체·세특·행특)마다 번호를 붙이고, 칸에 들어간 줄과 견줌
  const rawLines = [];
  const track = (o, page) => { o.id = rawLines.length; o.page = page; rawLines.push(o); return o; };
  const norm = (t) => t.replace(/\d+/g, "#");
  const freq = new Map();
  pages.forEach((p) => { const edge = [...p.lines.slice(0, 3), ...p.lines.slice(-3)]; new Set(edge.map((l) => norm(l.text))).forEach((k) => freq.set(k, (freq.get(k) || 0) + 1)); });
  const rep = pages.length >= 2 ? Math.max(2, Math.ceil(pages.length / 2)) : 99;
  // 숫자만 있는 줄은 쪽의 맨 첫 줄·맨 끝 줄일 때만 쪽 번호로 봄 (쪽 끝 가까이 찍힌 표의 학년 숫자를 지우지 않게)
  const isHF = (p, i) => (i < 3 || i >= p.lines.length - 3) && ((freq.get(norm(p.lines[i].text)) || 0) >= rep
    || (NOISE.test(p.lines[i].text) && (!/^[-–]?\s*\d+\s*[-–]?$/.test(p.lines[i].text.trim()) || i === 0 || i === p.lines.length - 1)));
  // 1) 줄마다 구역 정하기 (창체·행특은 좌표째 모았다가 2)에서 칸으로 나눔)
  const reg = { creative: [], behavior: [], attend: [], volunteer: [] };
  const rulesOf = new Map(pages.map((p) => [p.n, p.rules || []]));
  let volHead = null, volYearX = null;   // 봉사 표 머리 낱말 x (학년·일자·장소·활동내용·시간·누계시간)
  const subj = { rows: [] };
  const gt = [];   // 성적 표 (학년·종류별 줄 모음) — 성적 넣기를 골랐을 때만 읽음
  let curT = null;
  let cur = null, sub = null, grade = "", lastSubY = null, lastSubPage = 0;
  const gaps = [];
  for (const p of pages) {
    const pw = p === pages[0] ? piiWhy(p, isHF) : "";
    if (pw && keepP1) info.p1 = "kept";
    else if (pw) { info.p1 = "drop"; info.dropped.push({ page: p.n, why: `인적사항(${pw})이 있는 쪽`, pii: true }); continue; }
    info.kept++;
    p.lines.forEach((l, i) => { if (i && p.lines[i - 1].y - l.y < 30) gaps.push(p.lines[i - 1].y - l.y); });
    const maxR = Math.max(...p.lines.map((l) => l.right || 0));
    p.lines.forEach((l, i) => {
      if (isHF(p, i)) { info.headerLines++; return; }
      const t0 = l.text;
      const hit = t0.length <= 30 && SECTION_RE.find(([re]) => re.test(t0));
      if (hit) {
        if (hit[1] === "drop") { cur = "drop"; if (!info.dropped.some((d) => d.why === hit[2] + " (구역)")) info.dropped.push({ page: p.n, why: hit[2] + " (구역)" }); }
        else if (cur !== hit[1]) { cur = hit[1]; sub = cur === "subject" ? "grades" : null; if (cur === "subject") grade = ""; }
        return;
      }
      if (!cur || cur === "drop") return;
      const L = { ...l, page: p.n, maxR };
      if (cur === "volunteer") {
        // 표 머리('학년' · '일자 또는 기간 | 장소 또는 주관기관명 | 활동내용 | 시간 | 누계시간')는 칸 위치로만 씀
        const flat = t0.replace(/\s+/g, "");
        if (/^학년$/.test(flat)) { volYearX = (l.segs || [])[0]?.x ?? l.x; return; }
        if (/활동내용/.test(flat) && /누계/.test(flat) && !/\d/.test(flat)) {
          const hx = (re) => (l.segs || []).find((sg) => re.test(sg.s.replace(/\s+/g, "")))?.x;
          volHead = { year: hx(/^학년$/) ?? volYearX, date: hx(/^일자/), place: hx(/^장소/), act: hx(/^활동내용/), hr: hx(/^시간$/), cum: hx(/^누계/) };
          return;
        }
        reg.volunteer.push({ ...L, head: volHead });
        return;
      }
      if (cur === "attend") { if (!(TABLE_HEAD.test(t0) && t0.length < 40)) reg[cur].push(L); return; }
      if (cur === "creative" || cur === "behavior") { if (!isTableHead(t0)) reg[cur].push(L); return; }
      // 교과: [n학년] · 성적 표 · <진로 선택 과목> 같은 묶음 제목 · '과목 / 세부능력 및 특기사항' 표
      let t = t0;
      const g = t.match(/^\[\s*([1-3])\s*학년\s*\]/);
      if (g) { grade = g[1]; sub = "grades"; curT = { year: Number(grade), kind: "general", lines: [] }; gt.push(curT); return; }
      if (/^[<〈]/.test(t)) { sub = "grades"; curT = { year: Number(grade) || 0, kind: /진로/.test(t) ? "career" : /체육|예술/.test(t) ? "arts" : "other", lines: [] }; gt.push(curT); return; }
      if (/^학\s*기(\s|$)/.test(t)) { sub = "grades"; curT?.lines.push(L); return; }
      if (/세부능력및특기사항/.test(t.replace(/\s+/g, "")) && t.length < 40) { sub = "seteuk"; lastSubY = null; return; }   // 글자마다 띄어 찍힌 머리(세 부 능 력 …, 대입전형자료 조회 양식)도 (2026-11-11)
      if (sub === "grades") { curT?.lines.push(L); return; }
      if (sub !== "seteuk") return;
      const m = t.match(/^((?:\(\d학기\))?\s*[가-힣A-Za-z0-9ⅠⅡⅢⅣ·ㆍ\s()]{1,24}?)\s*[:：]\s*(.*)$/);
      const lg = median(gaps);
      // '이름: 내용' 줄은 일단 과목 후보 — 진짜 과목인지는 다 읽은 뒤 성적 표 과목 이름으로 정함 (아니면 앞 과목에 원문 그대로)
      if (m) { subj.rows.push({ label: `${grade ? grade + "학년 " : ""}${m[1].trim()}`, g: Number(grade) || 0, nm: m[1].trim(), raw: t, lines: [track({ t: m[2], r: l.right, cw: lineCw(l.x, l.right, t) }, p.n)], maxR }); lastSubY = l.y; lastSubPage = p.n; return; }
      // 표 밖 글(묶음 제목·빈 줄 다음 글)은 버림: 같은 쪽에서 줄 간격이 크게 벌어지면 표가 끝난 것
      if (lastSubY != null && lastSubPage === p.n && lastSubY - l.y > lg * 1.8) { sub = "skip"; track({ t }, p.n); return; }
      const r = subj.rows.at(-1); if (!r) { track({ t }, p.n); return; }
      r.lines.push(track({ t, r: l.right, cw: lineCw(l.x, l.right, t) }, p.n)); lastSubY = l.y; lastSubPage = p.n;
    });
  }
  const lg = median(gaps), tol = lg * 0.55;
  const secs = {};
  // 2) 창체: 영역 이름(자율·동아리·진로)이 칸 가운데. 학년 숫자도 학년 칸 가운데(쪽마다 다 있지는 않음)
  if (reg.creative.length) {
    // 특기사항 칸이 시작하는 x: 영역 이름·숫자가 아닌 긴 조각 중 가장 왼쪽 (영역 이름보다는 오른쪽)
    // 영역 이름 칸: 가장 왼쪽에 찍힌 영역 이름 근처만 (특기사항 글 속 '자율활동'·'진로활동' 같은 낱말은 빼고)
    const areaXs = reg.creative.flatMap((l) => (l.segs || []).filter((s) => AREA_RE.test(s.s.trim())).map((s) => s.x));
    const areaX0 = Math.min(9999, ...areaXs);
    const areaX = Math.max(0, ...areaXs.filter((x) => x <= areaX0 + 40));
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
          T.push(hm ? { y: l.y, t: "", hope: hm[1].trim(), r: l.right, maxR: l.maxR } : track({ y: l.y, t, r: l.right, maxR: l.maxR, cw: lineCw(right[0].x, l.right, t) }, pg));
        }
      });
      const P = partitionByRules(T, A, rulesOf.get(pg), areaX0 - 4, textX + 40) || partition(T, A, tol);   // 영역 칸까지 덮는 선 = 칸 경계 (희망분야 밑 점선은 아님)
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
        if (d && segs.length === 1) { A.push({ y: l.y, g: Number(d.s.trim()), x: d.x }); return; }
        if (d) { A.push({ y: l.y, g: Number(d.s.trim()), x: d.x }); const tt = segText(segs.slice(1)); T.push(track({ y: l.y, t: tt, r: l.right, maxR: l.maxR, cw: lineCw(segs[1]?.x, l.right, tt) }, pg)); return; }
        T.push(track({ y: l.y, t: segText(segs), r: l.right, maxR: l.maxR, cw: lineCw(segs[0]?.x, l.right, segText(segs)) }, pg));
      });
      const dX = A.length ? Math.min(...A.map((a) => a.x ?? 50)) : 50, tX = Math.min(9999, ...Ls.map((l) => (l.segs || []).find((sg) => sg.x > dX + 8)?.x ?? 9999));
      const P = partitionByRules(T, A, rulesOf.get(pg), dX - 4, tX + 40) || partition(T, A, tol);   // 학년 칸까지 덮는 선 = 칸 경계
      const pre = P.prefix.concat(P.orphan);
      if (pre.length) { if (rows.length) rows.at(-1).lines.push(...pre); else rows.push({ g: 0, lines: pre }); }
      P.blocks.forEach((b) => rows.push({ g: b.a.g, lines: b.lines }));
    });
    secs.behavior = rows.map((r) => { r.lines.forEach((x) => { x.used = true; }); return { label: r.g ? `${r.g}학년` : "", text: joinLines(r.lines, Math.max(0, ...r.lines.map((x) => x.maxR || 0))) }; });
  }
  // 3-1) 봉사활동실적 (2026-10-31 사용자 결정: 학교교육계획에 따른 '(학교)' 실적만 — 개인 봉사는 대입 미반영)
  //   한 줄 = 한 건: 일자(기간이면 '날짜 - 날짜') · 장소 '(학교)…' · 활동내용 · 시간 · 누계. 긴 활동내용은 그 줄 위아래로 넘어감(칸 가운데)
  //   학년 숫자는 그 학년 줄들 가운데. 장소·기관명은 넣지 않음(학교 이름이 보이지 않게)
  if (reg.volunteer.length) {
    const vrows = [], gA = [];
    let lastG = 0;
    [...new Set(reg.volunteer.map((l) => l.page))].forEach((pg) => {
      const Ls = reg.volunteer.filter((l) => l.page === pg);
      const h = Ls.find((l) => l.head)?.head || {};
      // 칸 경계 (머리 낱말 x 사이). 머리를 못 찾으면 나이스 기본 배치
      const xG = h.year != null ? h.year + 25 : 70, xPlace = h.date != null && h.place != null ? (h.date + h.place) / 2 + 10 : 171, xAct = h.place != null && h.act != null ? (h.place + h.act) / 2 : 315,
        xHr = h.hr != null ? h.hr - 15 : 481, xCum = h.hr != null && h.cum != null ? (h.hr + h.cum) / 2 + 2 : 510;
      const T = [], A = [], anchors = [];
      Ls.forEach((l) => {
        const segs = (l.segs || [{ x: l.x, w: (l.right || 0) - l.x, s: l.text }]).filter((sg) => sg.s.trim());
        const col = (c) => segs.filter((sg) => c(sg.x));
        const gd = col((x) => x < xG).find((sg) => /^[1-3]$/.test(sg.s.trim()));
        if (gd) A.push({ y: l.y, g: Number(gd.s.trim()) });
        const date = col((x) => x >= xG && x < xPlace).map((sg) => sg.s.trim()).join("");
        const o = { y: l.y, page: pg, place: segText(col((x) => x >= xPlace && x < xAct)), act: col((x) => x >= xAct && x < xHr), hr: segText(col((x) => x >= xHr && x < xCum)), cum: segText(col((x) => x >= xCum)), r: l.right, maxR: l.maxR };
        if (/^\d{4}\.\s*\d{1,2}\.\s*\d{1,2}\.?/.test(date)) { o.date = date; anchors.push(o); }
        if (o.act.length) o.line = track({ y: l.y, t: segText(o.act), w: o.act.at(-1).x + (o.act.at(-1).w || 0) - o.act[0].x }, pg);
        T.push(o);
      });
      if (!anchors.length) return;
      // 날짜 없는 줄(넘어간 활동내용·장소)은 가장 가까운 건에
      T.forEach((o) => { o.row = o.date ? o : anchors.reduce((b, a) => (Math.abs(a.y - o.y) < Math.abs(b.y - o.y) ? a : b)); });
      anchors.forEach((a) => { a.parts = T.filter((o) => o.row === a); });
      // 학년: 학년 숫자가 그 학년 줄(글 줄 모두)의 가운데 — 창체·행특과 같은 나누기
      const P = partitionByRules(T, A, rulesOf.get(pg), xG - 22, xAct) || partition(T, A, tol);   // 학년 칸까지 덮는 선 = 학년 경계
      const gOf = new Map();
      P.prefix.concat(P.orphan).forEach((o) => gOf.set(o, lastG || 1));
      P.blocks.forEach((b) => b.lines.forEach((o) => gOf.set(o, b.a.g)));
      if (P.blocks.length) lastG = P.blocks.at(-1).a.g;
      anchors.forEach((a) => vrows.push({ ...a, g: gOf.get(a) || lastG || 1 }));
      gA.push(...A);
    });
    info.volDropped = 0;
    const volW = Math.max(0, ...reg.volunteer.length ? rawLines.filter((x) => x.w != null).map((x) => x.w) : [0]);   // 활동내용 칸에서 가장 긴 줄
    secs.volunteer = vrows.flatMap((a) => {
      const place = a.parts.filter((o) => o.place).sort((x, y) => y.y - x.y).map((o) => o.place).join("");
      const lines = a.parts.filter((o) => o.line).sort((x, y) => y.y - x.y).map((o) => o.line);
      if (!/^\(\s*학교\s*\)/.test(place)) { info.volDropped++; lines.forEach((x) => { x.skip = true; }); return []; }   // 개인 봉사 등은 일부러 버림
      lines.forEach((x) => { x.used = true; });
      const act = lines.reduce((t, x, k) => { const pv = lines[k - 1]; return !pv ? x.t : t + (pv.w >= volW - 12 && isHg(pv.t.slice(-1)) && isHg(x.t[0]) ? "" : " ") + x.t; }, "");
      const hr = a.parts.map((o) => o.hr).find(Boolean), cum = a.parts.map((o) => o.cum).find(Boolean);
      return [{ label: `${a.g}학년 ${a.date.replace(/\s+/g, "")}`, text: `${act}${hr ? ` · ${hr}시간` : ""}${cum ? ` (누계 ${cum})` : ""}` }];
    });
  }
  // 4) 출결: 줄 앞 학년 숫자로
  if (reg.attend.length) {
    const rows = [];
    reg.attend.forEach((l) => { const m = l.text.match(/^([1-3])\s+(.*)$/); if (m) rows.push({ label: `${m[1]}학년`, text: m[2] }); else if (rows.length) rows.at(-1).text += " " + l.text; });   // 첫 학년 줄 앞은 표 머리(결석 종류 등) — 넣지 않음
    secs.attend = rows;
  }
  // 세특 과목 후보 정하기 (2026-11-02): 이어 붙이는 표시 — 콜론 양쪽이 숫자(1:1) · 이름 첫 낱말이 조사 · 앞 과목 글이 마침표로 안 끝남.
  // 같은 학년 성적 표 과목 이름 목록이 있으면 '목록에 없음 + 표시'일 때만 이어 붙임 (목록에 없다는 것만으로는 안 붙임 — 성적 표 이름을 잘못 읽어도 과목이 조용히 사라지지 않게).
  // 이어 붙일 때는 콜론 포함 줄 원문 그대로
  if (subj.rows.length > 1) {
    const normN = (x) => String(x || "").replace(/\(\s*\d\s*학기\s*\)/g, "").replace(/\s+/g, "");
    let names = new Map();
    try { parseGradeTables(gt, tol).forEach((r) => { if (r.sub) (names.get(r.y) || names.set(r.y, new Set()).get(r.y)).add(normN(r.sub)); }); } catch (e) { names = new Map(); }
    const kept = [subj.rows[0]];
    subj.rows.slice(1).forEach((r) => {
      const prev = kept.at(-1), list = names.get(r.g);
      const prevEnd = String(prev.lines.at(-1)?.t || "").trim();
      const join = (list?.size ? !list.has(normN(r.nm)) : true)
        && (/\d\s*[:：]\s*\d/.test(r.raw) || /^(을|를|이|가|은|는|의|에|와|과|로|도|및)(\s|$)/.test(r.nm) || !/[.。]$/.test(prevEnd));
      if (!join) { kept.push(r); return; }
      r.lines[0].t = r.raw;   // 원문 그대로 (글자 빠짐 없게)
      prev.lines.push(...r.lines);
    });
    subj.rows = kept;
  }
  if (subj.rows.length) secs.subject = subj.rows.map((r) => { r.lines.forEach((x) => { x.used = true; }); return { label: r.label, text: joinLines(r.lines, r.maxR) }; });
  // 빠진 글: 남긴 쪽 특기사항 칸 글자 수 합과 칸에 들어간 글자 수의 차이 (일부러 버린 창체 봉사 칸은 뺌)
  const cnt = (t) => String(t || "").replace(/\s+/g, "").length;
  const raw = rawLines.filter((x) => !x.skip), lostL = raw.filter((x) => !x.used);
  info.rawChars = raw.reduce((t, x) => t + cnt(x.t), 0);
  info.lostChars = lostL.reduce((t, x) => t + cnt(x.t), 0);
  info.lost = [...new Set(lostL.filter((x) => cnt(x.t)).map((x) => x.page))].sort((a, b) => a - b);
  const order = ["attend", "creative", "subject", "volunteer", "behavior", "grades"];
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
    <div class="ai-consent"><label class="inline-check"><input type="checkbox" id="ruAiOk" checked> <b>AI 맞춤 예상질문·암기 카드 만들기</b>에도 동의를 받았어요</label>
      <div class="muted sm">저장하면 가림 처리된 글(이름·학교 가림)과 지원 대학·전형·학과를 AI(Claude)로 보내, 충북교육청 면접후기 사례집의 기출을 참고해 질문 초안과 암기 카드를 만들어요. AI 회사는 이 글을 학습에 쓰지 않아요. 끄면 AI 없이 학생부만 저장해요.</div></div>
    <div class="row" style="margin-top:12px"><button type="button" class="btn-primary" id="ruNext1" disabled>다음</button></div></div>`;
  $("#ruConsent").onchange = (e) => { $("#ruNext1").disabled = !e.target.checked; };
  $("#ruNext1").onclick = () => { upState.consent = true; upState.aiOk = $("#ruAiOk").checked; stepPick(); };
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
      upState.pages = pages; upState.keepP1 = false;
      stepPages();
    } catch (err) { console.warn(err); stepPick("PDF 를 읽지 못했어요. 나이스에서 'PDF로 저장'한 파일인지 확인해 주세요. (구글 드라이브 파일이면 먼저 내려받아서 올려 주세요)"); }
  };
}
function stepPages() {
  steps(3);
  let res;
  try { res = splitRecord(upState.pages, { withGrades: upState.withGrades, keepP1: !!upState.keepP1 }); }
  catch (err) { console.warn(err); return stepPick("PDF 는 읽었지만 칸을 나누다 문제가 생겼어요. 이 파일 이름(학번)을 담당 선생님께 알려 주세요."); }
  const { sections, info, grades } = res;
  upState.info = info; upState.grades = grades;
  upState.lostWarn = lostWarn(info);
  const dropPages = new Set(info.dropped.filter((d) => /쪽/.test(d.why)).map((d) => d.page));
  body().innerHTML = `<div class="ru-card"><h3>쪽 확인</h3>
    <div class="ru-pages">${upState.pages.map((p) => { const d = info.dropped.find((x) => x.page === p.n && /쪽/.test(x.why)); return `<span class="ru-pg ${d ? "drop" : "keep"}" title="${esc(d?.why || "남김")}">${p.n}쪽 ${d ? "버림" : "남김"}${d ? `<small>${esc(d.why)}</small>` : ""}</span>`; }).join("")}</div>
    <div class="ru-p1" id="ruP1">${info.p1 === "drop" ? "1쪽 인적사항 → 버림" : info.p1 === "kept" ? "1쪽 인적사항 → 1쪽도 넣음 (인적·학적사항 구역은 뺌)" : "1쪽 인적사항 없음(이미 뺀 파일) → 남김"}</div>
    ${info.p1 !== "none" ? `<label class="inline-check"><input type="checkbox" id="ruKeepP1" ${upState.keepP1 ? "checked" : ""}> 1쪽도 넣기 <span class="muted sm">(1쪽에 출결·창의적 체험활동(자율활동) 글이 있을 때 — 인적·학적사항 구역은 그대로 빼요)</span></label>` : ""}
    ${upState.lostWarn}
    <ul class="ru-info">
      <li>남긴 구역: ${sections.filter((s) => s.key !== "grades").map((s) => esc(SEC_SHORT[s.key])).join(" · ") || '<b style="color:var(--danger)">없음</b>'}</li>
      <li>버린 구역: ${[...new Set(info.dropped.filter((d) => /구역/.test(d.why)).map((d) => d.why.replace(" (구역)", "")))].map(esc).join(" · ") || "없음"}${dropPages.size ? ` · 인적사항 쪽 ${dropPages.size}개` : ""}</li>
      <li>지운 머리말·꼬리말 줄: ${info.headerLines}줄</li>
      ${sections.some((x) => x.key === "volunteer") || info.volDropped ? `<li id="ruVol">봉사활동실적: 학교 계획 ${sections.find((x) => x.key === "volunteer")?.rows.length || 0}건 넣음${info.volDropped ? ` · ${info.volDropped}줄(개인 봉사) 버림` : ""} <span class="muted sm">(장소·기관명은 넣지 않음)</span></li>` : ""}
    </ul>
    <label class="inline-check"><input type="checkbox" id="ruGrades" ${upState.withGrades ? "checked" : ""}> 성적(원점수·등급) 표도 넣기 <span class="muted sm">(기본은 빼요)</span></label>
    ${upState.withGrades ? `<div class="muted sm">성적 ${grades.length}과목 읽음 ${grades.length ? "· " + [...new Set(grades.map((g) => `${g.y}-${g.s}`))].sort().map((k) => `${k} ${grades.filter((g) => `${g.y}-${g.s}` === k).length}`).join(" · ") : "— 성적 표를 찾지 못했어요"}</div>` : ""}
    <div class="row" style="margin-top:12px"><button type="button" class="btn-sm" id="ruBack">다른 파일</button><div class="spacer"></div>
      <button type="button" class="btn-primary" id="ruNext3" ${sections.length ? "" : "disabled"}>가림 확인으로</button></div></div>`;
  $("#ruGrades").onchange = (e) => { upState.withGrades = e.target.checked; stepPages(); };
  $("#ruKeepP1")?.addEventListener("change", (e) => { upState.keepP1 = e.target.checked; stepPages(); });
  $("#ruBack").onclick = () => { upState.pages = null; stepPick(); };
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
// 칸이 잘못 나뉜 것 같은 곳 (안전장치): 끝이 문장 중간 · 첫 글자가 낱말 중간 (창체·세특·행특만)
const CUT_END = /([.!?…)\]」』”'"]|[다음함됨임요])$/;
const CUT_START = /^(을|를|은|는|의|에|로|과|와|며|고|른|된|함|음|임|됨)[\s.,]/;   // 문장 첫머리에 올 수 없는 토씨·끝말 ('한 학기', '각 모둠' 같은 첫 낱말은 정상)
export function cutSuspects(sections) {
  const out = [];
  sections.forEach((s, si) => { if (!["creative", "subject", "behavior"].includes(s.key)) return;
    s.rows.forEach((r, ri) => {
      const t = String(r.text || "").trim(), body0 = t.replace(/^희망분야:[^\n]*\n/, "");
      if (!body0) return;
      const why = [!CUT_END.test(t) && "끝이 문장 중간", CUT_START.test(body0) && "첫 글자가 낱말 중간 같음"].filter(Boolean);
      if (why.length) out.push({ si, ri, label: r.label || SEC_SHORT[s.key], why: why.join(" · ") });
    }); });
  return out;
}
function rowHtml(s, si, r, ri) {
  if (r.editing) return `<textarea class="ru-edit" data-si="${si}" data-ri="${ri}">${esc(applyMasks(r.text, r.masks))}</textarea>
    <div class="row ru-edit-acts"><button type="button" class="btn-sm" data-send="prev:${si}:${ri}" ${ri > 0 ? "" : "disabled"} title="글 칸에서 누른 자리 앞 글을 앞 칸 끝으로 옮겨요">앞 칸으로 보내기</button>
      <button type="button" class="btn-sm" data-send="next:${si}:${ri}" ${ri < s.rows.length - 1 ? "" : "disabled"} title="글 칸에서 누른 자리 뒤 글을 다음 칸 앞으로 옮겨요">다음 칸으로 보내기</button>
      <span class="muted sm">글 칸에서 나눌 자리를 누른 뒤</span><div class="spacer"></div>
      <button type="button" class="btn-sm btn-primary" data-editok="${si}:${ri}">고치기 끝</button></div>`;
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
    ${(() => { const cs = cutSuspects(S3); return cs.length ? `<div class="notice ru-warn" id="ruCut"><div><b>칸이 잘못 나뉘었을 수 있는 곳 ${cs.length}칸</b> — 눌러서 확인하고, 섞였으면 [고치기]에서 [앞 칸으로 보내기]·[다음 칸으로 보내기]</div><div class="row">${cs.map((c) => `<button type="button" class="chip" data-cut="${c.si}:${c.ri}">${esc(c.label)} · ${esc(c.why)}</button>`).join(" ")}</div></div>` : ""; })()}
    <p class="muted">다른 사람 이름·학교 이름·전화·메일은 자동으로 가렸어요(학생 본인 이름은 그대로). 글을 <b>드래그</b>해 [가리기], 가린 곳을 누르면 [풀기]. 표가 쪽을 넘어가 섞인 칸은 [고치기]로 글을 직접 고쳐요.</p>
    <details class="ru-autos" open><summary>자동으로 가린 곳 <b>${autos.length}</b>곳</summary>
      <div>${autos.map((a, k) => `<button type="button" class="chip" data-goto="${a.si}:${a.ri}:${a.mi}">${k + 1}. ${esc(a.m.kind === "name" ? "이름" : a.m.kind === "school" ? "학교" : a.m.kind === "phone" ? "전화" : a.m.kind === "id" ? "주민번호" : "메일")} · ${esc(S3[a.si].rows[a.ri].text.slice(a.m.start, a.m.end))}</button>`).join(" ") || '<span class="muted sm">없음</span>'}</div></details>
    <div class="ru-doc" id="ruDoc">${S3.map((s, si) => `<h4>${esc(s.title)}</h4><table>${s.rows.map((r, ri) => `<tr data-row="${si}:${ri}"><th>${esc(r.label || "")}</th><td>${rowHtml(s, si, r, ri)}
      ${r.editing ? "" : `<button type="button" class="ru-fix" data-fix="${si}:${ri}">고치기</button>`}</td></tr>`).join("")}</table>`).join("")}</div>
    ${upState.withGrades && upState.grades?.length ? `<details class="ru-autos"><summary>성적 ${upState.grades.length}과목 — 펼쳐서 학기별로 확인</summary><div id="ruGr" class="rv-grades-in"></div></details>` : ""}
    <div class="ru-pop" id="ruPop" hidden><button type="button" id="ruMask">가리기</button></div>
    <div class="row" style="margin-top:12px"><button type="button" class="btn-sm" id="ruBack4">쪽 확인으로</button><div class="spacer"></div>
      <button type="button" class="btn-primary" id="ruSave">이대로 저장</button></div></div>`;
  const doc0 = $("#ruDoc");
  if ($("#ruGr")) renderGrades($("#ruGr"), upState.grades, { on: new Set(["주요과목"]), bars: "all", view: "detail", sem: "" });
  $$("[data-goto]").forEach((b) => b.onclick = () => { const el = $(`[data-m="${b.dataset.goto}"]`, doc0); el?.scrollIntoView({ block: "center" }); el?.classList.add("flash"); setTimeout(() => el?.classList.remove("flash"), 1200); });
  $$(".ru-mask", doc0).forEach((el) => el.onclick = () => { const [si, ri, mi] = el.dataset.m.split(":").map(Number); S3[si].rows[ri].masks.splice(mi, 1); stepMask(); });
  $$("[data-cut]").forEach((b) => b.onclick = () => { const el = $(`tr[data-row="${b.dataset.cut}"]`, doc0); el?.scrollIntoView({ block: "center" }); el?.classList.add("flash"); setTimeout(() => el?.classList.remove("flash"), 1200); });
  // [앞 칸으로 보내기]·[다음 칸으로 보내기]: 글 칸에서 누른 자리로 나눠 옆 칸에 붙임 (끝이 문장 끝이면 띄어 씀, 낱말 중간에서 끊긴 것이면 붙여 씀)
  $$("[data-send]", doc0).forEach((b) => b.onclick = () => {
    const [dir, si, ri] = [b.dataset.send.split(":")[0], ...b.dataset.send.split(":").slice(1).map(Number)];
    const rows = S3[si].rows, r = rows[ri], o = rows[dir === "prev" ? ri - 1 : ri + 1]; if (!o) return;
    const ta = $(`textarea[data-si="${si}"][data-ri="${ri}"]`, doc0), v = ta.value, at = ta.selectionStart ?? 0;
    const head = v.slice(0, at), tail = v.slice(at), other = applyMasks(o.text, o.masks);
    const glue = (a, z) => (!a || !z ? "" : /[.!?…)]\s*$/.test(a) || /\s$/.test(a) || /^\s/.test(z) ? " " : "");
    if (dir === "prev") { if (!head.trim()) return toast("글 칸에서 옮길 글 끝 자리를 눌러 주세요.", "error"); o.text = (other.trimEnd() + glue(other, head) + head.trim()).trim(); r.text = tail.trim(); }
    else { if (!tail.trim()) return toast("글 칸에서 옮길 글 첫 자리를 눌러 주세요.", "error"); o.text = (tail.trim() + glue(tail, other) + other.trimStart()).trim(); r.text = head.trim(); }
    [r, o].forEach((x) => { x.masks = autoMasks(x.text, namesList(upState.no)); });
    stepMask();
    $(`textarea[data-si="${si}"][data-ri="${ri}"]`)?.focus();
  });
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
      ${upState.aiOk ? '<div class="ai-run" id="ruAi"></div>' : '<p class="muted">AI 만들기를 끄고 저장했어요.</p>'}
      <div class="row" style="margin-top:12px"><button type="button" class="btn-primary" id="ruDone">닫기</button></div></div>`;
    $("#ruDone").onclick = () => { closeUpload(); window.dispatchEvent(new CustomEvent("records-changed", { detail: { no } })); };
    // AI 맞춤 예상질문 (1단계에서 AI 동의를 켰을 때만) — 창을 닫아도 Apps Script 는 서버에서 계속 돎
    if (upState.aiOk) runAiq(no, { scope: "all", consent: true, box: $("#ruAi"), big: true });
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
    note: "열람 기록은 남아요 (학생부 내용은 없음). AI 맞춤 초안도 같이 지워져요.", yes: "다음" }))) return false;
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
      (await getDocs(collection(db, "records", no, "aiq"))).docs.forEach((d) => b.delete(d.ref));      // AI 초안(근거 구절이 학생부 글)도 같이
      b.delete(doc(db, "records", no, "aimeta", "main"));
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
export async function publishPending(no, list, out = null) {
  if (!list?.length) return 0;
  const col = collection(db, "students", no, "personalQuestions");
  const cur = (await getDocs(col)).docs.map((d) => ({ id: d.id, ...d.data() }));
  const marks = (await getDocs(collection(db, "records", no, "marks"))).docs;
  const b = writeBatch(db);
  const rows = [];
  list.forEach((p) => {
    const ref = doc(col);
    const row = { text: p.text, basis: p.basis || "", followUps: p.followUps || [], category: `${p.stage}차 선생님 질문`, type: "document", by: "teacher", addedBy: p.by || "", source: p.aiId ? "ai" : "record", stage: Number(p.stage) || 0,
      ...(p.card ? { card: p.card } : {}), ...(p.aiId ? { aiId: p.aiId } : {}) };   // (2026-11-03) 암기 카드 내용·AI 초안 표시도 함께 옮김
    rows.push(row);
    out?.push({ id: ref.id, ...row });   // (2026-11-13) 공개한 질문 — 카드가 없으면 카드 만들기로 넘김
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
// 묶음 · 교과 (추이 칩 두 줄, 산출표 묶음 6줄 + 교과 5줄)
const G_SETS = [["주요과목", MAIN, "#121316"], ["전과목", null, "#5583cc"], ["국영수", ["국어", "영어", "수학"], "#a8b746"], ["국영", ["국어", "영어"], "#2d4f8f"], ["수과", ["수학", "과학"], "#0e9aa7"], ["영수", ["영어", "수학"], "#7c5cc4"]];
const G_SUBJ = [["국어", ["국어"], "#2d4f8f"], ["수학", ["수학"], "#5583cc"], ["영어", ["영어"], "#a8b746"], ["사회", ["사회"], "#c08a2b"], ["과학", ["과학"], "#1e7a5a"]];
const G_GROUPS = [...G_SETS, ...G_SUBJ];
const gAvg = (list) => { const L = list.filter((r) => r.rank != null && r.kind === "general"); const c = L.reduce((t, r) => t + (r.credit || 0), 0); return c ? L.reduce((t, r) => t + r.rank * (r.credit || 0), 0) / c : null; };
const gPick = (G, grp, sem) => G.filter((r) => (!grp || grp.includes(gArea(r.area))) && (!sem || `${r.y}-${r.s}` === sem));
const f2 = (x) => x == null ? "-" : x.toFixed(2);
const gcls = (g) => g == null ? "" : g <= 2 ? "g-a" : g <= 4 ? "g-b" : "g-c";
const semName = (m) => m.replace("-", "학년 ") + "학기";
export function renderGrades(el, G, st = { on: new Set(["주요과목", "전과목"]), bars: "all", view: "sum", sem: "" }) {
  if (!G?.length) { el.innerHTML = '<div class="gr-wrap"><div class="gr-empty">성적을 넣지 않았어요. 1차 담임이 [학생부 다시 넣기]에서 <b>성적(원점수·등급) 표도 넣기</b>를 체크하면 볼 수 있어요.</div></div>'; return; }
  const have = G_SEMS.filter((m) => gPick(G, null, m).length);
  const ranked = G_SEMS.filter((m) => gPick(G, null, m).some((r) => r.rank != null && r.kind === "general"));
  const carSems = have.filter((m) => gPick(G, null, m).some((r) => r.kind === "career"));
  if (!have.includes(st.sem)) st.sem = have.at(-1);
  let h = `<div class="gr-wrap"><div class="gr-top"><span class="gr-grp gr-view"><button type="button" data-gv="sum" class="${st.view === "sum" ? "on" : ""}">요약</button><button type="button" data-gv="detail" class="${st.view === "detail" ? "on" : ""}">학기별 세부 성적</button></span>
      <span class="gr-m2">평균 등급 = Σ(석차등급×학점)÷Σ학점 · 석차등급 있는 과목만</span></div>`;
  if (st.view === "sum") {
    const last = ranked.at(-1), prev = ranked.at(-2), vL = last ? gAvg(gPick(G, null, last)) : null, vP = prev ? gAvg(gPick(G, null, prev)) : null;
    const dv = vL == null || vP == null ? "" : vL < vP ? `<em class="up">▲ ${(vP - vL).toFixed(2)}</em> 직전 학기보다 좋아짐` : vL > vP ? `<em class="dn">▼ ${(vL - vP).toFixed(2)}</em> 직전 학기보다 나빠짐` : "직전 학기와 같음";
    const car = G.filter((r) => r.kind === "career");
    const kpi = (t, v, sub, id) => `<div class="gr-k" id="${id}"><small>${t}</small><b>${v}</b>${sub ? `<span>${sub}</span>` : ""}</div>`;
    const sets = G_SETS.filter(([, grp]) => gPick(G, grp).some((r) => r.rank != null)), subs = G_SUBJ.filter(([, grp]) => gPick(G, grp).some((r) => r.rank != null));
    h += `<div class="gr-kpis">${kpi("전과목 평균", `${f2(gAvg(G))}<i>등급</i>`, `${ranked.length}학기 · ${G.filter((r) => r.rank != null && r.kind === "general").reduce((t, r) => t + (r.credit || 0), 0)}학점`, "grKAll")}
        ${kpi("주요과목 평균 (국·수·영·사·과)", `${f2(gAvg(gPick(G, MAIN)))}<i>등급</i>`, "", "grKMain")}
        ${kpi(`최근 학기${last ? ` (${last})` : ""}`, `${f2(vL)}<i>등급</i>`, dv, "grKLast")}
        ${car.length ? `<button type="button" class="gr-k" id="grKCar" data-gocar><small>진로 선택 과목</small><b>${esc2(car.map((r) => r.ach || "-").join(" · "))}</b><span>${car.length}과목 · 학기별 세부에서 보기 ›</span></button>` : `<div class="gr-k" id="grKCar"><small>진로 선택 과목</small><b>-</b><span>없음</span></div>`}</div>
      <div class="gr-row2"><div class="gr-card"><h4>학기별 등급 추이 <span class="gr-m2">1등급이 위 · 점을 누르면 그 학기 세부</span></h4>
          <div class="gr-chips"><span class="gr-m2">묶음</span>${sets.map(([n, , c]) => `<button type="button" class="gr-chip ${st.on.has(n) ? "on" : ""}" data-gg="${n}" style="--c:${c}"><i></i>${n}</button>`).join("")}
            ${subs.length ? `<span class="gr-br"></span><span class="gr-m2">교과</span>${subs.map(([n, , c]) => `<button type="button" class="gr-chip ${st.on.has(n) ? "on" : ""}" data-gg="${n}" style="--c:${c}"><i></i>${n}</button>`).join("")}` : ""}</div>
          <div class="gr-line"></div></div>
        <div class="gr-card"><h4>교과별 평균 <span class="gr-grp sm"><button type="button" data-gb="all" class="${st.bars === "all" ? "on" : ""}">전 학기</button><button type="button" data-gb="last" class="${st.bars === "last" ? "on" : ""}">최근 학기</button></span></h4>
          ${MAIN.map((a) => { const v = gAvg(gPick(G, [a], st.bars === "last" ? last : null)); return `<div class="gr-bar" data-bar="${a}"><span>${a}</span><div><i class="${gcls(v)}" style="width:${v == null ? 0 : Math.max(0, (9 - v) / 8 * 100)}%"></i></div><b class="${gcls(v)}">${f2(v)}</b></div>`; }).join("")}
          <div class="gr-m2" style="margin-top:6px">막대가 길수록 좋은 등급 · <span class="gr-lg g-a">1~2</span> <span class="gr-lg g-b">3~4</span> <span class="gr-lg g-c">5~</span></div></div></div>
      <div class="gr-card"><h4>교과 성적 산출표</h4><div class="gr-tw"><table class="gr-t" id="grSum">${sumTable(G)}</table></div>
        <div class="gr-m2">등급이수 = 석차등급이 있는 과목 학점 합 · 학기마다 <b class="gr-best">초록</b> 가장 좋음 · <b class="gr-worst">빨강</b> 가장 낮음 · 빈 학기는 -</div></div>`;
  } else {
    const L = gPick(G, null, st.sem), K = { career: "진로 선택", arts: "체육·예술" };
    const kinds = [["general", "일반 과목"], ["career", "진로 선택"], ["arts", "체육·예술"], ["other", "기타"]];
    const kOf = (r) => ["general", "career", "arts"].includes(r.kind) ? r.kind : "other";
    h += `<div class="gr-sems">${G_SEMS.map((m) => `<button type="button" data-gsem="${m}" class="${st.sem === m ? "on" : ""}" ${have.includes(m) ? "" : "disabled"}>${semName(m)}${carSems.includes(m) ? ' <span class="gr-cdot">진로</span>' : ""}</button>`).join("")}</div>
      <div class="gr-card" id="grSem"><div class="gr-sh"><b>${semName(st.sem)}</b><span class="gr-pl">평균 ${f2(gAvg(L))}등급</span><span class="gr-pl">주요과목 ${f2(gAvg(L.filter((r) => MAIN.includes(gArea(r.area)))))}</span><span class="gr-m2">${L.reduce((t, r) => t + (r.credit || 0), 0)}학점 · ${L.length}과목</span></div>
      <div class="gr-tw"><table class="gr-t det"><thead><tr><th>교과 · 과목</th><th>학점</th><th>원점수 / 평균 (표준편차)</th><th>성취도 (수강자)</th><th>등급</th></tr></thead><tbody>
      ${kinds.filter(([k]) => L.some((r) => kOf(r) === k)).map(([k, t]) => `<tr class="sep" data-kind="${k}"><td colspan="5"><div class="gr-sep"><span class="gr-kp">${t}</span><span class="gr-kn">${L.filter((r) => kOf(r) === k).length}과목</span></div></td></tr>`
        + L.filter((r) => kOf(r) === k).map((r) => `<tr><td class="l"><b>${esc2(r.sub)}</b><div class="gr-m2">${esc2(r.area)}${K[r.kind] ? " · " + K[r.kind] : ""}</div></td><td>${r.credit ?? "-"}</td>
          <td>${r.raw != null ? `${r.raw} / ${r.avg}${r.sd != null ? ` <span class="gr-m2">(${r.sd})</span>` : ""}` : "-"}</td>
          <td>${r.ach ? `<span class="gr-ach a-${String(r.ach).toLowerCase()}">${esc2(r.ach)}</span>` : "-"}${r.n != null ? ` <span class="gr-m2">(${r.n})</span>` : ""}${distBar(r.dist)}</td>
          <td>${r.rank != null ? `<span class="gr-rk ${gcls(r.rank)}">${r.rank}</span>` : "-"}</td></tr>`).join("")).join("")}
      </tbody></table></div></div>`;
  }
  el.innerHTML = h + "</div>";
  if (st.view === "sum") drawLine(el.querySelector(".gr-line"), G, st);
  const again = () => renderGrades(el, G, st);
  const toSem = (m) => { st.sem = m; st.view = "detail"; again(); };
  el.querySelectorAll("[data-gv]").forEach((b) => b.onclick = () => { st.view = b.dataset.gv; again(); });
  el.querySelectorAll("[data-gg]").forEach((b) => b.onclick = () => { st.on.has(b.dataset.gg) ? st.on.delete(b.dataset.gg) : st.on.add(b.dataset.gg); again(); });
  el.querySelectorAll("[data-gb]").forEach((b) => b.onclick = () => { st.bars = b.dataset.gb; again(); });
  el.querySelectorAll("[data-gocar]").forEach((b) => b.onclick = () => toSem(carSems.at(-1)));
  el.querySelectorAll("[data-gsem]").forEach((c) => c.addEventListener("click", () => toSem(c.dataset.gsem)));
}
function drawLine(box, G, st) {
  // 세로축 1~6등급(1이 위, 6보다 아래는 아래 끝), 선 끝에 '이름 값'
  const W = 640, H = 260, L = 34, R = 70, T = 22, B = 30, xs = (i) => L + i * (W - L - R) / (G_SEMS.length - 1), ys = (g) => T + (Math.min(Math.max(g, 1), 6) - 1) * (H - T - B) / 5;
  const have = G_SEMS.filter((m) => gPick(G, null, m).length);
  let s = `<svg viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="학기별 등급 추이">`;
  for (let g = 1; g <= 6; g++) s += `<line x1="${L}" x2="${W - R}" y1="${ys(g)}" y2="${ys(g)}" stroke="#edf0f5"/><text x="${L - 8}" y="${ys(g) + 4}" font-size="11" text-anchor="end" fill="#737b89">${g}</text>`;
  G_SEMS.forEach((m, i) => { s += `<text x="${xs(i)}" y="${H - 8}" font-size="11" text-anchor="middle" fill="${have.includes(m) ? "#4f5663" : "#c3c8d1"}">${m}</text>`; });
  G_GROUPS.filter(([n]) => st.on.has(n)).forEach(([n, grp, c], k) => {
    const pts = G_SEMS.map((m, i) => ({ i, m, v: gAvg(gPick(G, grp, m)) })).filter((p) => p.v != null);
    if (!pts.length) return;
    s += `<polyline fill="none" stroke="${c}" stroke-width="2.2" stroke-linejoin="round" points="${pts.map((p) => `${xs(p.i)},${ys(p.v)}`).join(" ")}" data-line="${n}"/>`;
    pts.forEach((p) => { s += `<circle cx="${xs(p.i)}" cy="${ys(p.v)}" r="5" fill="#fff" stroke="${c}" stroke-width="2" style="cursor:pointer" data-gsem="${p.m}"><title>${n} ${p.m} ${f2(p.v)}</title></circle>`; });
    const lp = pts.at(-1);
    s += `<text x="${xs(lp.i) + 8}" y="${ys(lp.v) + 4 + (k % 2 ? 9 : -3)}" font-size="11" fill="${c}" font-weight="700" pointer-events="none">${n} ${f2(lp.v)}</text>`;
  });
  box.innerHTML = s + "</svg>";
}
function sumTable(G) {
  // 묶음 6줄 + '교과별' + 교과 5줄 · 학기마다 가장 좋은 값 초록 글씨 · 가장 낮은 값 빨강 글씨 (바탕색 없음)
  let h = `<thead><tr><th>구분</th><th>평균</th><th>등급이수</th>${G_SEMS.map((m) => `<th>${m}</th>`).join("")}</tr></thead><tbody>`;
  const row = ([n, grp]) => {
    const all = gPick(G, grp); if (!all.length) return "";
    const vs = G_SEMS.map((m) => gAvg(gPick(G, grp, m))), ok = vs.filter((v) => v != null), best = Math.min(...ok), worst = Math.max(...ok);
    return `<tr data-row="${n}"><th>${n}</th><td class="avg">${f2(gAvg(all))}</td><td>${all.filter((r) => r.rank != null && r.kind === "general").reduce((t, r) => t + (r.credit || 0), 0)}</td>${vs.map((v) => `<td class="${v == null ? "na" : ok.length > 1 && v === best ? "best" : ok.length > 1 && v === worst ? "worst" : ""}">${f2(v)}</td>`).join("")}</tr>`;
  };
  const sub = G_SUBJ.map(row).join("");
  return h + G_SETS.map(row).join("") + (sub ? `<tr class="sep"><td colspan="${3 + G_SEMS.length}">교과별</td></tr>${sub}` : "") + "</tbody>";
}
const esc2 = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const distBar = (d) => d ? `<div class="gr-dist"><span class="da" style="width:${d.A || 0}%"></span><span class="db" style="width:${d.B || 0}%"></span><span class="dc" style="width:${d.C || 0}%"></span></div><div class="gr-m2">${["A", "B", "C"].filter((k) => d[k] != null).map((k) => `${k} ${d[k]}%`).join(" · ")}</div>` : "";

// ================= C. 학생부 화면 =================
let V = null;   // 열려 있는 동안만 (학생부 글·하이라이트·질문). 닫으면 null
export const recordViewerOpen = () => !!V;
export function closeRecordViewer() {
  if (!V) return;
  flushDelMark();
  try { V.fb?.flush(); V.fb?.destroy(); } catch (e) { console.warn(e); }   // ② 피드백 임시 저장을 바로 남김
  clearTimeout(V.idle); clearInterval(V.tick);
  V.off.forEach((f) => f());
  document.getElementById("recView")?.remove();
  const done = V.onClose; V = null;
  try { done?.(); } catch (e) { console.warn(e); }
}
function guessStage(st, preset) {
  if (preset?.stage) return Number(preset.stage);
  const mine = myRoles(st).map((r) => Number(r[0]));
  const done = new Set((S.meetings || []).filter((m) => m.studentNo === st.studentNo && !m.planned).map((m) => Number(m.stage)));
  return mine.find((k) => !done.has(k)) || mine[0] || [1, 2, 3].find((k) => !done.has(k)) || 1;
}
// mode: "interview"(모의면접, 지금 화면) | "prep"(질문 준비 — 질문 탭에서, 타이머·기록 쓰기 없음) · onClose: 닫힌 뒤 할 일
export async function openRecordViewer(no, { stage = 0, preset = null, mode = "interview", onClose = null, tab = "" } = {}) {
  const st = studentByNo(no);
  if (!canSeeRec(st)) return toast("이 학생의 학생부는 배정 선생님·관리자만 볼 수 있어요.", "error");
  closeRecordViewer();
  closeModal();   // 창(학생 상세·일정 상세) 위가 아니라 화면 전체로 연다. [기록 쓰기 →] 의 기록 창은 이 화면 위에 뜸
  let rec;
  try { const s = await getDoc(doc(db, "records", no)); if (!s.exists()) return toast("아직 학생부가 없어요.", "error"); rec = s.data(); }
  catch (e) { return showError(e, "학생부 열기"); }
  const prep = mode === "prep";
  // 질문 준비: AI 맞춤 초안이 있으면 [AI 초안] 탭을 맨 앞에 (모의면접 모드에는 없음)
  let aiq = [], aimeta = null;
  if (prep) {
    try { const [a, m] = await Promise.all([getDocs(collection(db, "records", no, "aiq")), getDoc(doc(db, "records", no, "aimeta", "main"))]); aiq = a.docs.map((d) => ({ id: d.id, ...d.data() })); aimeta = m.exists() ? m.data() : null; }
    catch (e) { console.warn("AI 초안 불러오기", e); }
  } else {
    try { const m = await getDoc(doc(db, "records", no, "aimeta", "main")); aimeta = m.exists() ? m.data() : null; } catch (_) { /* 동의 여부만 — 못 읽으면 근거 카드만 */ }
  }
  const hasAi = prep && (aiq.length > 0 || !!aimeta?.unis?.length);
  const myStages = myRoles(st).map((r) => Number(r[0])).filter(Boolean);
  V = { no, st, rec, stage: stage || (prep ? myStages[0] || 1 : guessStage(st, preset)), preset, marks: [], pending: [], pqs: [], notes: null, asked: new Map(),
    aiq, aimeta, hasAi, aiGrp: "common", aiEdit: null,
    mode, prep, onClose, newIds: [], editQ: null, consent: !!aimeta?.consentAt,
    fb: null, fbEl: null, fbDone: null, savedMid: "",   // ② 피드백 (대면 기록 칸을 창 안에) — 2026-11-13
    flt: "mine", otherHl: true, idle: null, tick: null, t0: 0, run: false, used: 0, off: [], sel: null,
    // 보기 상태: 접기(구역·학년·목차)는 열려 있는 동안만, 글자 크기·문장 나누기만 브라우저에 기억
    openS: {}, openY: {}, tocOpen: {}, fs: viewPref("rvFs", 16), sent: viewPref("rvSent", 0) === 1, find: "", wide: false, bulkAt: 0 };
  log(no, prep ? "open:prep" : "open");
  const me = myName() || S.ctx.user.email;
  const ov = document.createElement("div");
  ov.id = "recView"; ov.className = "rec-ov rv";
  const wm = `<svg xmlns='http://www.w3.org/2000/svg' width='320' height='180'><text x='10' y='100' transform='rotate(-24 160 90)' font-size='15' fill='rgba(30,40,60,0.09)' font-family='sans-serif'>${esc(me)} · ${new Date().toLocaleString("ko-KR")}</text></svg>`;
  // 지원: 대학마다 '대학 + 지원전형 / 모집단위' (1차 불합격은 흐리게)
  const apps = (st.universities || []).filter((u) => u.univ || u.admission || u.dept).map((u) => {
    const rest = [u.admission, u.dept].map((x) => String(x || "").trim()).filter(Boolean).join(" / ");
    return `<span class="rv-ap${announceFailed(u) ? " out" : ""}">${u.univ ? `<b>${esc(univName(u.univ))}</b>` : ""}${rest ? " " + esc(rest) : ""}${announceFailed(u) ? "<i>1차 불합격</i>" : ""}</span>`;
  }).join("");
  ov.innerHTML = `<div class="rv-wm" style="background-image:url(&quot;data:image/svg+xml;utf8,${encodeURIComponent(wm)}&quot;)"></div>
    <div class="rv-hd"><b>${esc(no)} ${esc(st.name)}</b><span class="rv-gr rv-main"><button type="button" data-main="rec" class="on">학생부</button><button type="button" data-main="gr">성적</button></span>
      ${prep ? `<span class="rv-preptag" id="rvPrepTag">질문 준비</span>${myStages.length !== 1 ? `<span class="rv-stage">${(myStages.length ? myStages : [1, 2, 3]).map((k) => `<button type="button" data-stage="${k}" class="${V.stage === k ? "on" : ""} c${k}">${k}차</button>`).join("")}</span>` : ""}<span class="muted">면접 전에 질문을 뽑아 두는 화면 · 만든 질문은 바로 학생에게 공개</span><span class="sp"></span>
      <button type="button" class="btn-sm" id="rvClose">질문 탭으로 돌아가기</button>`
    : `<span class="rv-stage">${[1, 2, 3].map((k) => `<button type="button" data-stage="${k}" class="${V.stage === k ? "on" : ""} c${k}">${k}차</button>`).join("")}</span>
      <span class="muted">모의면접${preset?.date ? ` · ${esc(fmtDay(preset.date))}` : ""}</span>
      <span class="rv-steps" id="rvSteps"><button type="button" data-step="q" class="on">① 질문하기</button><i>→</i><button type="button" data-step="fb">② 피드백</button></span><span class="sp"></span>
      <span class="rv-tm" id="rvTm">면접 00:00</span><button type="button" class="btn-sm" id="rvTmBtn">면접 시작</button><button type="button" class="btn-sm" id="rvClose">닫기</button>`}
      ${apps ? `<div class="rv-apps" id="rvApps"><span class="apl">지원</span>${apps}</div>` : ""}</div>
    <div class="rv-body">
      <nav class="rv-toc" id="rvToc"><div id="rvTocL"></div>
        <div class="rv-lg"><b>하이라이트</b><br><i class="c1"></i>1차 담임<br><i class="c2"></i>2차 교과<br><i class="c3"></i>3차 위원
          <label class="inline-check"><input type="checkbox" id="rvOther" checked> 다른 선생님 하이라이트</label><br><b>가림</b> <span class="rv-mask">○○</span> 이름·학교${hasAi ? '<br><span class="ai-lg"></span>AI 초안 근거' : ""}</div></nav>
      <article class="rv-doc" id="rvDoc"><div class="rv-bar" id="rvBar">
          <span class="rv-grp"><button type="button" data-fs="-1" aria-label="글자 작게">가−</button><button type="button" data-fs="0" id="rvFsN" title="16으로">${V.fs}</button><button type="button" data-fs="1" aria-label="글자 크게">가+</button></span>
          <span class="rv-grp"><button type="button" data-all="1">모두 펼치기</button><button type="button" data-all="0">모두 접기</button></span>
          <span class="rv-grp"><button type="button" data-sent="0" class="${V.sent ? "" : "on"}">문단</button><button type="button" data-sent="1" class="${V.sent ? "on" : ""}">문장마다 줄</button></span>
          <input type="search" id="rvFind" placeholder="학생부에서 찾기" autocomplete="off"><span class="muted sm" id="rvFindN"></span>
          <span class="sp"></span><button type="button" class="rv-tog" id="rvWide">질문 칸 접기 ▸</button></div>
        <div class="rv-in" id="rvIn"></div></article>
      <aside class="rv-side">${prep
        ? `<div class="rv-tabs">${hasAi ? '<button type="button" data-tab="ai">AI 초안 <span id="rvAn"></span></button>' : ""}<button type="button" data-tab="mine">뽑은 질문 <span id="rvQn"></span></button><button type="button" data-tab="other">다른 질문 <span id="rvPn"></span></button></div>
        <div class="rv-sb" id="rvSb"></div>
        <div class="rv-foot"><span class="muted sm" id="rvAsk">뽑은 질문은 ${esc(no)} ${esc(st.name)} 질문 목록에 저장돼요</span><button type="button" class="btn-primary" id="rvDone">다 뽑았어요</button></div>`
        : `<div id="rvDraftBar"></div><div class="rv-tabs"><button type="button" class="on" data-tab="q">① 질문하기 <span id="rvQn"></span></button><button type="button" data-tab="fb">② 피드백</button><button type="button" data-tab="p">지난 면접 <span id="rvPn"></span></button></div>
        <div class="rv-sb" id="rvSb"></div>
        <div class="rv-foot" id="rvFoot"><span class="muted sm" id="rvAsk"></span><button type="button" class="btn-primary" id="rvRec">피드백 쓰기 →</button></div>`}</aside>
    </div>
    <div class="rv-grades" id="rvGrades" hidden></div>
    <div class="rv-pop" id="rvPop" hidden><button type="button" id="rvHl">하이라이트</button><button type="button" id="rvQ">질문 만들기</button></div>
    <div class="rv-pop" id="rvMkPop" hidden><button type="button" id="rvMkQ">질문 보기</button><button type="button" id="rvMkDel">하이라이트 지우기</button></div>
    <div class="rv-undo" id="rvUndo" hidden><span>지웠어요</span><button type="button" id="rvUndoBtn">되돌리기</button></div>
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
  $("#rvClose", ov).onclick = async () => {
    // 저장 안 한 ② 피드백이 있으면 한 번 묻기 (임시 저장돼 있다는 안내와 함께)
    if (!prep && V?.fb) {
      V.fb.flush();
      if (V.fb.dirty() && !(await confirmBox({ title: "저장하지 않은 기록이 있어요", what: "② 피드백을 아직 [저장하고 마치기] 하지 않았어요.",
        note: "쓰던 내용(① 물어봄·답 메모 포함)은 이 브라우저에 임시 저장돼 있어요 — 같은 학생·차수로 다시 열면 [불러오기]로 돌아와요.", yes: "닫기", no: "계속 쓰기" }))) return;
    }
    closeRecordViewer();
  };
  if ($("#rvTmBtn", ov)) $("#rvTmBtn", ov).onclick = () => {
    V.run = !V.run;
    if (V.run) { V.t0 = Date.now() - V.used * 1000; V.tick = setInterval(() => { V.used = Math.floor((Date.now() - V.t0) / 1000); $("#rvTm", ov).textContent = `면접 ${String(Math.floor(V.used / 60)).padStart(2, "0")}:${String(V.used % 60).padStart(2, "0")}`; }, 500); }
    else clearInterval(V.tick);
    $("#rvTmBtn", ov).textContent = V.run ? "멈춤" : "면접 시작";
  };
  $$("[data-stage]", ov).forEach((b) => b.onclick = () => {
    V.stage = Number(b.dataset.stage); $$("[data-stage]", ov).forEach((x) => x.classList.toggle("on", x === b));
    if (!prep) { dropFb(); V.savedMid = ""; mountFb(); }   // 차수가 바뀌면 ② 피드백도 그 차수로 (쓰던 것은 임시 저장에 남음)
    drawSide();
  });
  $("#rvOther", ov).onchange = (e) => { V.otherHl = e.target.checked; drawDoc(); };
  $$(".rv-tabs [data-tab]", ov).forEach((b) => b.onclick = () => setTab(b.dataset.tab));
  $$("#rvSteps [data-step]", ov).forEach((b) => b.onclick = () => setTab(b.dataset.step));
  if ($("#rvRec", ov)) $("#rvRec", ov).onclick = () => setTab("fb");
  if ($("#rvDone", ov)) $("#rvDone", ov).onclick = closeRecordViewer;
  // [학생부 | 성적]: 성적은 학생부를 넣을 때 '성적 표도 넣기'를 고른 경우에만 있음
  const grSt = { on: new Set(["주요과목", "전과목"]), bars: "all", view: "sum", sem: "" };
  $$("[data-main]", ov).forEach((b) => b.onclick = () => {
    const gr = b.dataset.main === "gr";
    $$("[data-main]", ov).forEach((x) => x.classList.toggle("on", x === b));
    $(".rv-body", ov).hidden = gr; $("#rvGrades", ov).hidden = !gr; $("#rvPop", ov).hidden = true;
    if (gr) renderGrades($("#rvGrades", ov), V.rec.grades || [], grSt);
  });
  V.tab = prep ? (hasAi && tab !== "mine" ? "ai" : "mine") : "q";
  $$(".rv-tabs [data-tab]", ov).forEach((x) => x.classList.toggle("on", x.dataset.tab === V.tab));
  drawDoc(); drawSide();
  // AI 초안은 다른 선생님이 채택·버리면 바로 사라지게 (질문 준비 화면이 열려 있는 동안만 구독)
  if (hasAi) {
    const un = onSnapshot(collection(db, "records", no, "aiq"), (snap) => {
      if (!V || V.no !== no) return;
      V.aiq = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
      if (V.aiEdit && !V.aiq.some((a) => a.id === V.aiEdit && a.status === "new")) V.aiEdit = null;
      drawDoc(); drawSide();
    }, () => {});
    V.off.push(un);
  }
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
    const jb = e.target.closest("[data-jump]");
    if (jb) { const el = document.getElementById(jb.dataset.jump); if (el) goTo(el, true); return; }
    const mk = e.target.closest("mark[data-mk]"); if (mk) { markPop(mk); return; }
    const am = e.target.closest("mark.ai[data-ai]"); if (am) focusAi(am.dataset.ai);
  });
  // 회색 막대: 글자 크기 · 모두 펼치기/접기 · 문단/문장마다 줄 · 찾기 · 질문 칸 접기
  $$("[data-fs]", ov).forEach((b) => b.onclick = () => { const d = Number(b.dataset.fs); V.fs = d ? Math.min(20, Math.max(14, V.fs + d)) : 16; savePref("rvFs", V.fs); $("#rvFsN", ov).textContent = V.fs; drawDoc(); });
  $$("[data-sent]", ov).forEach((b) => b.onclick = () => { V.sent = b.dataset.sent === "1"; savePref("rvSent", V.sent ? 1 : 0); $$("[data-sent]", ov).forEach((x) => x.classList.toggle("on", x === b)); drawDoc(); });
  $$("[data-all]", ov).forEach((b) => b.onclick = () => {
    const o = b.dataset.all === "1", cur = $(`#rvIn details[data-s="${curSec()}"]`, ov);
    V.bulkAt = performance.now();
    $$("#rvIn details[data-s], #rvIn details[data-y]", ov).forEach((d) => { d.open = o; (d.dataset.s ? V.openS : V.openY)[d.dataset.s || d.dataset.y] = o; });
    if (!o && cur) goTo(cur, false);
  });
  $("#rvFind", ov).addEventListener("input", (e) => { V.find = e.target.value.trim(); drawDoc(); });
  $("#rvWide", ov).onclick = () => { V.wide = !V.wide; $(".rv-body", ov).classList.toggle("wide", V.wide); $("#rvWide", ov).textContent = V.wide ? "질문 칸 펼치기 ◂" : "질문 칸 접기 ▸"; };
  // 접기·펼치기: 다시 그리지 않고 그 자리만. 접을 때 제목이 화면 위로 사라졌으면 제목으로 맞춤 (toggle 은 거품이 없어 capture 로)
  $("#rvIn", ov).addEventListener("toggle", (e) => {
    const d = e.target; if (!(d instanceof HTMLDetailsElement)) return;
    if (d.dataset.s) V.openS[d.dataset.s] = d.open; else if (d.dataset.y) V.openY[d.dataset.y] = d.open; else return;
    if (!d.open && performance.now() - V.bulkAt > 400) { const top = docEl.getBoundingClientRect().top + barH(); if (d.getBoundingClientRect().top < top) goTo(d, false); }
  }, true);
  // 목차: ▾/▸ 는 목차의 학년 목록만 접음, 이름을 누르면 본문 그 자리를 펼치고 학생부 칸 안에서만 이동
  $("#rvTocL", ov).addEventListener("click", (e) => {
    const ch = e.target.closest("[data-chev]");
    if (ch) { const k = ch.dataset.chev; V.tocOpen[k] = V.tocOpen[k] === false; ch.closest(".rv-tg").classList.toggle("open", V.tocOpen[k]); ch.textContent = V.tocOpen[k] ? "▾" : "▸"; return; }
    const a = e.target.closest("[data-go]"); if (!a) return;
    e.preventDefault();
    const [k, g] = a.dataset.go.split("|");
    const sd = $(`#rvIn details[data-s="${k}"]`, ov); if (!sd) return;
    sd.open = true; V.openS[k] = true;
    const yd = g ? $(`#rvIn details[data-y="${k}|${g}"]`, ov) : null;
    if (yd) { yd.open = true; V.openY[`${k}|${g}`] = true; }
    goTo(yd || sd, true);
  });
  docEl.addEventListener("scroll", spyToc, { passive: true });
  // 하이라이트를 누르면: [질문 보기](질문이 달린 것) · [하이라이트 지우기](내 것 · 관리자)
  const mkPop = $("#rvMkPop", ov);
  const markPop = (el) => {
    const m = V.marks.find((x) => x.id === el.dataset.mk); if (!m) return;
    const q = m.kind === "q", del = canDelMark(m);
    if (!q && !del) { mkPop.hidden = true; return; }
    $("#rvMkQ", ov).hidden = !q; $("#rvMkDel", ov).hidden = !del; mkPop.dataset.mk = m.id;
    const r = el.getBoundingClientRect();
    mkPop.style.left = `${Math.min(window.innerWidth - 220, Math.max(8, r.left))}px`; mkPop.style.top = `${Math.min(window.innerHeight - 52, Math.max(8, r.top - 46))}px`; mkPop.hidden = false;
  };
  on(document, "pointerdown", (e) => { if (!e.target.closest("#rvMkPop, mark[data-mk]")) mkPop.hidden = true; }, { capture: true });
  $("#rvMkQ", ov).onclick = () => { mkPop.hidden = true; focusQuestion(mkPop.dataset.mk); };
  $("#rvMkDel", ov).onclick = () => { mkPop.hidden = true; delMark(mkPop.dataset.mk); };
  $("#rvUndoBtn", ov).onclick = undoDelMark;
  on(window, "pagehide", flushDelMark);
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
  if (!prep) mountFb();
  drawDoc(); drawSide();
  loadMeetingNotes(no).then((n) => { if (V && V.no === no) { V.notes = n; drawSide(); } }).catch(() => { if (V && V.no === no) { V.notesFail = true; drawSide(); } });
}
const markStageCls = (m) => `c${Number(m.stage) || 1}`;
// ===== 학생부 보기 (2026-10-31 가독성: 구역 카드 · 학년 접기 · 목차 · 회색 막대) =====
// 글 칸(.rv-cell data-sec·data-row)의 글자 위치는 저장된 글 그대로 — 하이라이트·드래그 질문·지우기가 문단/문장마다 줄 모두 같은 자리
const VIEW_ORDER = ["attend", "creative", "subject", "volunteer", "behavior"];
const VIEW_TITLE = { attend: "출결 상황", creative: "창의적 체험활동", subject: "교과 세부능력 및 특기사항", volunteer: "봉사활동실적 (학교 계획)", behavior: "행동특성 및 종합의견" };
function viewPref(k, d) { try { const v = Number(localStorage.getItem(k)); return localStorage.getItem(k) == null || !Number.isFinite(v) ? d : v; } catch (_) { return d; } }
function savePref(k, v) { try { localStorage.setItem(k, String(v)); } catch (_) {} }
const rowYear = (label) => { const m = String(label || "").match(/^([1-3])학년\s*/); return m ? { g: m[1], name: String(label).slice(m[0].length) } : { g: "", name: String(label || "") }; };
const hopeOf = (text) => { const m = String(text).match(/^희망분야:\s*([^\n]*)\n/); return m ? { hope: m[1].trim(), cut: m[0].length } : { hope: "", cut: 0 }; };
function viewSections() {
  const L = V.rec.sections.map((s) => ({ ...s, rows: s.rows.map((r, ri) => ({ ...r, ri, ...rowYear(r.label) })) }));
  const k = (x) => { const i = VIEW_ORDER.indexOf(x.key); return i < 0 ? 99 : i; };
  return L.filter((s) => s.key !== "grades").sort((a, b) => k(a) - k(b));
}
const yearsOf = (s) => [...new Set(s.rows.map((r) => r.g))].sort((a, b) => (a || "9").localeCompare(b || "9"));
const barH = () => document.getElementById("rvBar")?.offsetHeight || 44;
// 학생부 칸 안에서만 이동 (scrollIntoView 는 바깥 화면까지 움직여서 쓰지 않음)
function goTo(el, smooth) {
  const d = document.getElementById("rvDoc"); if (!d || !el) return;
  const y = el.getBoundingClientRect().top - d.getBoundingClientRect().top + d.scrollTop - barH() - 10;
  d.scrollTo({ top: Math.max(0, y), behavior: smooth ? "smooth" : "auto" });
}
function curSec() {
  const d = document.getElementById("rvDoc"); if (!d) return "";
  const top = d.getBoundingClientRect().top + barH() + 30;
  let cur = "";
  $$("#rvIn details[data-s]").forEach((x) => { if (!cur || x.getBoundingClientRect().top <= top) cur = x.dataset.s; });
  return cur;
}
function spyToc() { const c = curSec(); $$("#rvTocL .rv-tg").forEach((t) => t.classList.toggle("cur", t.dataset.tg === c)); }
function drawToc() {
  const el = document.getElementById("rvTocL"); if (!el || !V) return;
  el.innerHTML = viewSections().map((s) => {
    const ys = s.key === "attend" ? [] : yearsOf(s), to = V.tocOpen[s.key] !== false;
    return `<div class="rv-tg${to ? " open" : ""}" data-tg="${s.key}"><div class="rv-tgh">${ys.length ? `<button type="button" class="rv-chev" data-chev="${s.key}" aria-label="목차 접기">${to ? "▾" : "▸"}</button>` : '<span class="rv-chev"></span>'}<a href="#" data-go="${s.key}">${esc(SEC_SHORT[s.key] || s.title)}</a><small>${s.rows.length}</small></div>
      ${ys.length ? `<div class="rv-tgs">${ys.map((g) => `<a href="#" class="sub" data-go="${s.key}|${g || "etc"}">${g ? g + "학년" : "기타"}<small>${s.rows.filter((r) => r.g === g).length}</small></a>`).join("")}</div>` : ""}</div>`;
  }).join("");
  spyToc();
}
function drawDoc() {
  const el = document.getElementById("rvIn"), docEl = document.getElementById("rvDoc"); if (!el || !V) return;
  const keep = docEl.scrollTop;
  const mine = (m) => m.byUid === S.ctx.user.uid;
  const secs = viewSections();
  let found = 0;
  const aiShow = V.prep && V.hasAi ? aiVisible() : [];
  const cell = (s, r) => {
    const ms = V.marks.filter((m) => (V.otherHl || mine(m))).map((m) => ({ ...m, ...placeOf(m, s.key, r.ri, r.text) })).filter((m) => m.ok);
    const h = s.key === "creative" ? hopeOf(r.text) : { hope: "", cut: 0 };
    const fr = findRanges(r.text, h.cut); found += fr.length;
    const ai = aiShow.filter((a) => a.at?.sec === s.key && Number(a.at?.row) === r.ri).map((a) => { const i = a.b ? r.text.indexOf(a.b) : -1; return i >= h.cut ? { id: a.id, s: i, e: i + a.b.length } : null; }).filter(Boolean);
    return { h, html: paint(r.text, ms, { hide: h.cut, sent: V.sent, find: fr, ai }) };
  };
  const ent = (s, r) => {
    const c = cell(s, r);
    return `<div class="rv-ent" id="rve-${s.key}-${r.ri}">${r.name || c.h.hope ? `<div class="rv-lab">${r.name ? `<b>${esc(r.name)}</b>` : ""}${c.h.hope ? `<span class="rv-hope">희망분야 · ${esc(c.h.hope)}</span>` : ""}</div>` : ""}<div class="rv-cell rv-txt${V.sent ? " sent" : ""}" data-sec="${s.key}" data-row="${r.ri}">${c.html}</div></div>`;
  };
  const ysum = (s, rows) => s.key === "subject" ? `${rows.length}과목` : s.key === "creative" ? rows.map((r) => r.name.replace(/활동$/, "")).join("·") : s.key === "volunteer" ? `${rows.length}건` : s.key === "behavior" ? "" : `${rows.length}칸`;
  el.style.setProperty("--fs", `${V.fs}px`);
  el.innerHTML = secs.map((s) => {
    const ys = s.key === "attend" ? [] : yearsOf(s);
    const body = s.key === "attend" ? s.rows.map((r) => ent(s, { ...r, name: r.label })).join("") : ys.map((g) => {
      const rows = s.rows.filter((r) => r.g === g), yk = `${s.key}|${g || "etc"}`;
      const nav = s.key === "subject" && rows.length > 3 ? `<div class="rv-subjnav">${rows.map((r) => `<button type="button" data-jump="rve-${s.key}-${r.ri}">${esc(r.name || "과목")}</button>`).join("")}</div>` : "";
      return `<details class="rv-fy" data-y="${yk}" id="rvy-${s.key}-${g || "etc"}"${V.openY[yk] !== false ? " open" : ""}><summary class="rv-yr"><span class="rv-yrchip">${g ? g + "학년" : "기타"}</span><span class="rv-yrs">${esc(ysum(s, rows))}</span><span class="ar"></span></summary><div class="rv-yin">${nav}${rows.map((r) => ent(s, r)).join("")}</div></details>`;
    }).join("");
    return `<details class="rv-card-s${s.key === "attend" ? " small" : ""}" data-s="${s.key}" id="rvs-${s.key}"${V.openS[s.key] !== false ? " open" : ""}><summary class="rv-sech"><span class="rv-dot d-${s.key}"></span><h3>${esc(VIEW_TITLE[s.key] || s.title)}</h3>${ys.filter(Boolean).length ? `<small>${ys.filter(Boolean).map((g) => g + "학년").join(" · ")}</small>` : ""}<span class="ar"></span></summary><div class="rv-cin">${body}</div></details>`;
  }).join("") + `<p class="rv-endnote muted sm">대입에 쓰는 항목만 (인적사항·수상·자격증·독서·개인 봉사 없음 · 봉사는 학교 계획 실적만) · 성적은 위 [성적] 탭에 따로 · ${V.rec.ver || 1}번째 판</p>`;
  const fn = document.getElementById("rvFindN"); if (fn) fn.textContent = V.find ? `${found}곳` : "";
  docEl.scrollTop = keep;
  drawToc();
}
// 찾기: 보이는 글(희망분야 머리 뒤)에서 낱말 자리 [{s,e}]
function findRanges(text, from = 0) {
  const q = V?.find; if (!q) return [];
  const out = []; let i = text.indexOf(q, from);
  while (i >= 0) { out.push({ s: i, e: i + q.length }); i = text.indexOf(q, i + q.length); }
  return out;
}
// 하이라이트 자리: 저장된 자리의 글이 quote 와 같으면 그대로, 아니면 같은 칸에서 quote 를 다시 찾음 (못 찾으면 안 그림)
function placeOf(m, sec, row, text) {
  if (m.sec !== sec || Number(m.row) !== row) return { ok: false };
  if (text.slice(m.start, m.end) === m.quote) return { ok: true, s: m.start, e: m.end };
  const i = m.quote ? text.indexOf(m.quote) : -1;
  return i >= 0 ? { ok: true, s: i, e: i + m.quote.length } : { ok: false };
}
function paint(text, ms, { hide = 0, sent = false, find = [], ai = [] } = {}) {
  // 글자 위치는 원래 글 그대로: 희망분야 머리는 숨긴 채 남기고(hidden), 문장 나누기는 감싸기만(글자를 더하지 않음)
  const cuts = new Set([0, text.length, hide]);
  ms.forEach((m) => { cuts.add(m.s); cuts.add(m.e); });
  find.forEach((f) => { cuts.add(f.s); cuts.add(f.e); });
  ai.forEach((f) => { cuts.add(f.s); cuts.add(f.e); });
  const sents = [hide];
  if (sent) { const re = /\.(\s+)(?=\S)/g; let m; while ((m = re.exec(text))) { const b = m.index + m[0].length; if (b > hide) { sents.push(b); cuts.add(b); } } }
  const pts = [...cuts].filter((x) => x >= 0 && x <= text.length).sort((a, b) => a - b);
  let h = hide ? `<span class="rv-hid" hidden>${esc(text.slice(0, hide))}</span>` : "", open = false;
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i], b = pts[i + 1]; if (a < hide) continue;
    if (sent && sents.includes(a)) { if (open) h += "</span>"; h += '<span class="s">'; open = true; }
    const seg = text.slice(a, b);
    const top = ms.filter((m) => m.s <= a && m.e >= b).at(-1), ax = ai.find((f) => f.s <= a && f.e >= b);
    h += top ? `<mark class="${markStageCls(top)}${top.kind === "q" ? " q" : ""}" data-mk="${esc(top.id)}">${maskSpans(seg)}</mark>`
      : ax ? `<mark class="ai" data-ai="${esc(ax.id)}">${maskSpans(seg)}</mark>`
      : find.some((f) => f.s <= a && f.e >= b) ? `<mark class="rv-find">${maskSpans(seg)}</mark>` : maskSpans(seg);
  }
  return h + (open ? "</span>" : "");
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
    <div class="rv-pubnote">저장하면 바로 학생 '내 생기부 면접'에 공개되고, AI가 드래그한 글 속 개념을 한 줄씩 정리해 암기 카드를 만들어요</div>
    <div class="muted sm" id="rvQErr" style="color:var(--danger)"></div>
    <div class="row"><button type="button" class="btn-sm" id="rvQX">취소</button><div class="spacer"></div><button type="button" class="btn-primary btn-sm" id="rvQOk">저장</button></div></div>`;
  const home = V.prep ? "mine" : "q";
  $("#rvQX", sb).onclick = () => { V.sel = null; V.tab = home; $(`.rv-tabs [data-tab=${home}]`)?.classList.add("on"); drawSide(); };
  $("#rvQOk", sb).onclick = async () => {
    const text = $("#rvQt", sb).value.trim(), fu = $("#rvQf", sb).value.split("\n").map((x) => x.trim()).filter(Boolean);
    const bad = !text ? "질문을 적어 주세요." : badQuestionText(text + "\n" + fu.join("\n"), V.no);
    if (bad) { $("#rvQErr", sb).textContent = bad; return; }
    // (2026-11-13) 질문은 늘 바로 공개 — '면접 뒤 공개'(pending)는 더 만들지 않음. 저장 뒤 암기 카드는 뒤에서 (기다리지 않음)
    const me = myName() || S.ctx.user.email;
    $("#rvQOk", sb).disabled = true;
    try {
      const mref = doc(collection(db, "records", V.no, "marks"));
      const mark = { kind: "q", stage: V.stage, by: me, byUid: S.ctx.user.uid, sec: s.sec, row: s.row, start: s.start, end: s.end, quote: s.quote, at: Date.now() };
      const col = collection(db, "students", V.no, "personalQuestions");
      const cur = (await getDocs(col)).docs.map((d) => ({ id: d.id, ...d.data() }));
      const qref = doc(col);
      const row = { text, basis, followUps: fu, category: `${V.stage}차 선생님 질문`, type: "document", by: "teacher", addedBy: me, source: "record", stage: V.stage };
      const stats = pqStats([...cur, row]);
      const b = writeBatch(db);
      b.set(qref, { ...row, createdAt: serverTimestamp() }); b.set(mref, { ...mark, qid: qref.id }); b.update(doc(db, "students", V.no), stats);
      await b.commit();
      Object.assign(studentByNo(V.no) || {}, stats);
      const nq = { id: qref.id, ...row, createdAt: { seconds: Date.now() / 1000 } };
      V.pqs = [...cur, nq]; V.marks.push({ id: mref.id, ...mark, qid: qref.id }); V.newIds.push(qref.id);
      log(V.no, "publish");
      V.sel = null; getSelection().removeAllRanges();
      toast("질문을 학생에게 공개했어요");
      V.tab = home; V.flt = "mine"; $$(".rv-tabs [data-tab]").forEach((x) => x.classList.toggle("on", x.dataset.tab === home));
      drawDoc(); drawSide();
      viewerCards([nq]);
    } catch (e) { $("#rvQOk", sb).disabled = false; showError(e, "질문 저장"); }
  };
  $("#rvQt", sb).focus();
}
// 질문 카드 목록: 이 학생의 '내 생기부 면접' + 공개 전 질문
// mine = 내가 만든 공개 전 질문 + 내가 생기부에서 공개한 질문(addedBy 가 내 이름이거나 내 하이라이트가 가리키는 질문)
function cards() {
  const me = S.ctx.user.uid, myNm = myName();
  const stageOf = (q) => Number(q.stage) || Number(String(q.category || "").match(/^(\d)차/)?.[1]) || 0;
  const at = (x) => x.createdAt?.seconds || 0;
  const out = [];
  V.pending.forEach((p) => out.push({ key: "p:" + p.id, pend: p.id, text: p.text, basis: p.basis, followUps: p.followUps || [], stage: Number(p.stage), by: p.by, mine: p.byUid === me, status: "after", kind: "teacher", at: at(p),
    card: p.card || null, ai: !!p.aiId }));
  V.pqs.forEach((q) => {
    const stu = q.by === "student";
    const rec = q.source === "record" || q.source === "meeting" || q.source === "ai";
    const mine = !stu && ((rec && !!myNm && q.addedBy === myNm) || V.marks.some((m) => m.qid === q.id && m.byUid === me));
    out.push({ key: "q:" + q.id, pq: q.id, text: q.text, basis: q.basis, followUps: q.followUps || [], stage: stageOf(q), by: stu ? "학생" : (q.addedBy || "선생님"),
      mine, status: "pub", kind: stu ? "student" : rec ? "teacher" : "old", at: at(q), card: q.card || null, ai: q.source === "ai" || !!q.aiId });
  });
  // 내 질문: 이 화면에서 방금 만든 것이 맨 위(새것 먼저), 그다음 만든 순서
  const fresh = (c) => V.newIds.indexOf(c.pend || c.pq);
  return out.sort((x, y) => (fresh(y) - fresh(x)) || (x.at - y.at));
}
function cardTag(c) {
  return c.kind === "student" ? '<span class="tag">학생</span>' : c.kind === "old" ? '<span class="tag">예전 질문</span>' : `<span class="tag c${c.stage || 1}">${c.stage || "?"}차</span>`;
}
function drawSide() {
  if (!V) return;
  const sb = document.getElementById("rvSb"); if (!sb) return;
  // ② 피드백 칸은 한 번 만든 것을 그대로 옮겨 다님 (다른 탭을 그리기 전에 떼어 둠 — 입력·임시 저장은 그대로)
  if (V.fbEl?.parentNode === sb && (V.tab !== "fb" || V.fbDone)) V.fbEl.remove();
  const all = cards();
  if (V.prep) {
    // 질문 준비: [뽑은 질문 | 다른 질문] · 물어봄·답 메모·↻ 다시 없음 · 내 질문은 [고치기], 공개 전은 [지우기]
    $("#rvQn").textContent = all.filter((c) => c.mine).length;
    $("#rvPn").textContent = all.filter((c) => !c.mine).length;
    if ($("#rvAn")) $("#rvAn").textContent = aiVisible().length;
    if (V.tab === "new") return;
    if (V.tab === "ai") return drawAi(sb);
    const list = all.filter((c) => (V.tab === "other") !== c.mine);
    sb.innerHTML = list.map((c) => {
      // [고치기]: 질문·꼬리질문 + 학생 암기 카드에 나갈 내용(핵심 키워드·개념·정리할 것·답변 포인트) — 카드가 없는 예전 질문은 빈 칸으로 열림
      if (V.editQ === c.key) return edHtml(edOf(c), { key: c.key, head: `${cardTag(c)}<span class="muted sm">고치는 중 · 질문과 학생 암기 카드에 나갈 내용</span>`,
        extra: editExtra(c) });
      const mk = V.marks.find((m) => m.qid === (c.pend || c.pq));
      return `<div class="rv-card" data-card="${esc(c.key)}" ${mk ? `data-mk="${esc(mk.id)}"` : ""}>
        <div class="row">${cardTag(c)}<span class="muted sm">${esc(c.by || "")}${c.mine ? " (나)" : ""}${c.ai ? " · AI 초안에서" : ""}${c.card?.t ? ` · 기출 유형 · ${esc(c.card.t)}` : ""}</span><div class="spacer"></div><span class="badge ${c.status === "after" ? "badge-orange" : "badge-green"}">${c.status === "after" ? "면접 뒤 공개" : "공개됨"}</span></div>
        <div class="rv-qt">${esc(c.text)}</div>${c.followUps.length ? `<div class="muted sm">↳ ${c.followUps.map(esc).join(" · ")}</div>` : ""}
        ${c.basis ? `<div class="rv-basis">${maskSpans(c.basis)}</div>` : ""}
        ${cardBox(c)}
        ${c.mine ? `<div class="row rv-acts"><button type="button" class="btn-sm" data-edq>고치기</button>${c.pend ? '<button type="button" class="btn-sm btn-danger" data-delq>지우기</button>' : ""}</div>` : ""}</div>`;
    }).join("") || `<div class="muted sm">${V.tab === "other" ? "다른 질문이 없어요." : "아직 뽑은 질문이 없어요. 학생부 글을 드래그해 [질문 만들기]."}</div>`;
    $$("[data-card]", sb).forEach((el) => {
      const c = all.find((x) => x.key === el.dataset.card);
      $("[data-edq]", el)?.addEventListener("click", () => { V.editQ = c.key; drawSide(); });
      bindEditCard(el, c);
      $("[data-delq]", el)?.addEventListener("click", () => delPendingQ(c));
    });
    return;
  }
  $("#rvQn").textContent = all.length;
  const ag = V.notes ? againOf() : [];
  $("#rvPn").textContent = ag.length ? `↻${ag.length}` : "";
  const asked = [...V.asked.values()].filter((a) => a.asked).length;
  $("#rvAsk").textContent = asked ? `물어봄 ${asked}개 → 피드백의 받은 질문으로 가요` : "";
  syncSteps();
  if (V.tab === "new") return;
  if (V.tab === "p") return drawPast(sb);
  if (V.tab === "fb") return drawFb(sb);
  // 모의면접: 처음 거르기 = 내가 준비한 질문 → 다른 선생님·학생 → 모두
  const f = V.flt;
  const list = all.filter((c) => f === "all" || (f === "mine") === c.mine);
  const n = { mine: all.filter((c) => c.mine).length, other: all.filter((c) => !c.mine).length, all: all.length };
  const pendN = V.pending.filter((p) => Number(p.stage) === V.stage).length;
  sb.innerHTML = `<div class="rv-flt">${[["mine", "내가 준비한 질문"], ["other", "다른 선생님·학생"], ["all", "모두"]].map(([k, t]) => `<button type="button" data-flt="${k}" class="${f === k ? "on" : ""}">${t} ${n[k]}</button>`).join("")}</div>
    ${pendN ? `<div class="muted sm" style="margin:6px 0">${V.stage}차 '면접 뒤 공개' 질문 ${pendN}개 — 이 차수 대면 기록을 저장할 때 학생에게 공개돼요</div>` : ""}
    ${list.map((c) => { const a = V.asked.get(c.key) || {}; const mk = V.marks.find((m) => m.qid === (c.pend || c.pq));
      if (V.editQ === c.key) return edHtml(edOf(c), { key: c.key, head: `${cardTag(c)}<span class="muted sm">고치는 중 · 질문과 학생 암기 카드에 나갈 내용</span>`, extra: editExtra(c) });
      return `<div class="rv-card${a.asked ? " asked" : ""}" data-card="${esc(c.key)}" ${mk ? `data-mk="${esc(mk.id)}"` : ""}>
        <div class="row">${cardTag(c)}
          <span class="muted sm">${esc(c.by || "")}${c.mine ? " (나)" : ""}</span><div class="spacer"></div><span class="badge ${c.status === "after" ? "badge-orange" : "badge-green"}">${c.status === "after" ? "면접 뒤 공개" : "공개됨"}</span></div>
        ${c.basis ? `<div class="rv-basis">${maskSpans(c.basis)}</div>` : ""}
        <div class="rv-qt">${esc(c.text)}</div>${c.followUps.length ? `<div class="muted sm">↳ ${c.followUps.map(esc).join(" · ")}</div>` : ""}
        ${cardBox(c)}
        <div class="row rv-acts"><button type="button" class="btn-sm${a.asked ? " on" : ""}" data-asked>${a.asked ? "물어봄 ✓" : "물어봄"}</button>
          <button type="button" class="btn-sm mt-ag${a.again ? " on" : ""}" data-again>↻ 다음 차수에 다시</button>
          ${c.mine && c.pq ? '<button type="button" class="btn-sm" data-edq>고치기</button>' : ""}
          ${c.pend && c.mine ? '<div class="spacer"></div><button type="button" class="btn-sm btn-danger" data-delq>지우기</button>' : ""}</div>
        ${a.asked ? `<input class="mt-memo" data-memo placeholder="학생 답 메모 (선생님끼리만)" value="${esc(a.memo || "")}">` : ""}</div>`; }).join("") || `<div class="muted sm">${f === "mine" ? "내가 준비한 질문이 없어요. 학생부 글을 드래그해 [질문 만들기]." : "질문이 없어요."}</div>`}`;
  $$("[data-flt]", sb).forEach((b) => b.onclick = () => { V.flt = b.dataset.flt; drawSide(); });
  $$("[data-card]", sb).forEach((el) => {
    const c = all.find((x) => x.key === el.dataset.card);
    const st = () => V.asked.get(c.key) || V.asked.set(c.key, { asked: false, again: false, memo: "", q: c.text, pend: c.pend || "", pq: c.pq || "" }).get(c.key);
    // 물어봄·↻·답 메모 → ② 받은 질문과 같은 상태 · 임시 저장에도 (V.fb.touch)
    $("[data-asked]", el)?.addEventListener("click", () => { const a = st(); a.asked = !a.asked; V.fb?.touch(); drawSide(); });
    $("[data-again]", el)?.addEventListener("click", () => { const a = st(); a.again = !a.again; if (a.again) a.asked = true; V.fb?.touch(); drawSide(); });
    $("[data-memo]", el)?.addEventListener("input", (e) => { st().memo = e.target.value; V.fb?.touch(); });
    $("[data-edq]", el)?.addEventListener("click", () => { V.editQ = c.key; drawSide(); });
    bindEditCard(el, c);
    $("[data-delq]", el)?.addEventListener("click", () => delPendingQ(c));
  });
}
async function delPendingQ(c) {
  if (!(await confirmBox({ title: "이 질문을 지울까요?", what: esc(c.text), note: "공개 전 질문만 지울 수 있어요. 하이라이트도 같이 지워져요.", yes: "지우기" }))) return;
  try {
    const b = writeBatch(db);
    b.delete(doc(db, "records", V.no, "pending", c.pend));
    V.marks.filter((m) => m.qid === c.pend).forEach((m) => b.delete(doc(db, "records", V.no, "marks", m.id)));
    await b.commit();
    V.pending = V.pending.filter((p) => p.id !== c.pend); V.marks = V.marks.filter((m) => m.qid !== c.pend); V.asked.delete(c.key);
    drawDoc(); drawSide();
  } catch (e) { showError(e, "질문 지우기"); }
}
// [고치기] (질문 준비, 내 질문만): 질문·꼬리질문. 공개 시점은 공개 전 질문만 '바로 공개'로 바꿀 수 있음 (사용자 결정 2026-11-01 — 예상질문은 더하기만)
async function saveEditQ(c, el) {
  const e = readEd(el), text = e.q, fu = e.fu.map((x) => x.q);
  const bad = !text ? "질문을 적어 주세요." : badQuestionText(text + "\n" + fu.join("\n"), V.no);
  if (bad) { $("[data-e=err]", el).textContent = bad; return; }
  const now = c.pend && $("input[name=rvEPub]:checked", el)?.value === "now";
  // 암기 카드: 이미 있거나 이번에 키워드·개념·정리할 것·답변 포인트를 적었을 때만
  const card = c.card || hasCard(e) ? { ...(c.card || basisParts(c.basis)), kw: e.kw, con: e.con, chk: e.chk, fu: e.fu } : null;
  const upd = { text, followUps: fu, ...(card ? { card } : {}) };
  $("[data-esave]", el).disabled = true;
  try {
    if (c.pend) {
      await updateDoc(doc(db, "records", V.no, "pending", c.pend), upd);
      const p = V.pending.find((x) => x.id === c.pend); Object.assign(p, upd);
      if (now) {
        const pubd = [];
        await publishPending(V.no, [p], pubd);
        await reloadQs();
        toast("질문을 학생에게 공개했어요");
        const need = pubd.map((x) => V.pqs.find((q) => q.id === x.id)).filter((q) => q && !q.card);
        if (need.length) viewerCards(need);
      } else toast("고쳤어요");
    } else {
      await updateDoc(doc(db, "students", V.no, "personalQuestions", c.pq), upd);
      Object.assign(V.pqs.find((x) => x.id === c.pq) || {}, upd);
      toast("고쳤어요");
    }
    V.editQ = null; drawDoc(); drawSide();
  } catch (err) { $("[data-esave]", el).disabled = false; showError(err, "질문 고치기"); }
}
async function reloadQs() {
  const [mk, pd, pq] = await Promise.all([getDocs(collection(db, "records", V.no, "marks")), getDocs(collection(db, "records", V.no, "pending")), getDocs(collection(db, "students", V.no, "personalQuestions"))]);
  if (!V) return;
  V.marks = mk.docs.map((d) => ({ id: d.id, ...d.data() })); V.pending = pd.docs.map((d) => ({ id: d.id, ...d.data() })); V.pqs = pq.docs.map((d) => ({ id: d.id, ...d.data() }));
}
// 하이라이트 지우기: 화면에서는 바로 지우고 "지웠어요 [되돌리기]"를 몇 초 보여 줌. 실제 지우기는 그 뒤(또는 창을 닫을 때)
// — 관리자가 다른 선생님 것을 지운 뒤에도 되돌릴 수 있게 (만들기 규칙은 byUid 가 나인 것만이라 다시 만들 수 없음)
// 질문이 달린 하이라이트(kind q)도 표시만 지움 — 질문(pending·personalQuestions)과 카드의 근거 글은 그대로
const canDelMark = (m) => m.byUid === S.ctx.user.uid || !!S.ctx.isAdmin;
const UNDO_MS = () => window.__recUndoMs || 5000;   // (시험용으로만 짧게 바꿈)
function delMark(id) {
  const m = V?.marks.find((x) => x.id === id); if (!m || !canDelMark(m)) return;
  flushDelMark();
  V.marks = V.marks.filter((x) => x !== m);
  V.undo = { m, no: V.no, timer: setTimeout(flushDelMark, UNDO_MS()) };
  const u = document.getElementById("rvUndo"); if (u) u.hidden = false;
  drawDoc(); drawSide();
}
function flushDelMark() {
  const u = V?.undo; if (!u) return;
  clearTimeout(u.timer); V.undo = null;
  const el = document.getElementById("rvUndo"); if (el) el.hidden = true;
  deleteDoc(doc(db, "records", u.no, "marks", u.m.id)).catch((e) => {
    showError(e, "하이라이트 지우기");
    if (V && V.no === u.no && !V.marks.some((x) => x.id === u.m.id)) { V.marks.push(u.m); drawDoc(); drawSide(); }
  });
}
function undoDelMark() {
  const u = V?.undo; if (!u) return;
  clearTimeout(u.timer); V.undo = null;
  document.getElementById("rvUndo").hidden = true;
  V.marks.push(u.m); drawDoc(); drawSide();
}
function focusQuestion(markId) {
  const m = V?.marks.find((x) => x.id === markId); if (!m) return;
  if (m.kind !== "q") return;
  const c = cards().find((x) => (x.pend || x.pq) === m.qid);
  if (V.prep) V.tab = c && !c.mine ? "other" : "mine"; else { V.tab = "q"; V.flt = "all"; }
  $$(".rv-tabs [data-tab]").forEach((x) => x.classList.toggle("on", x.dataset.tab === V.tab)); drawSide();
  const el = $(`#rvSb [data-mk="${CSS.escape(markId)}"]`);
  el?.scrollIntoView({ block: "center" }); el?.classList.add("flash"); setTimeout(() => el?.classList.remove("flash"), 1200);
}
const againOf = () => (V.notes ? againList(V.no, V.notes) : []);
function drawPast(sb) {
  if (!V.notes) { sb.innerHTML = `<div class="muted sm">${V.notesFail ? "지난 면접을 불러오지 못했어요." : "지난 면접을 불러오는 중…"}</div>`; return; }
  sb.innerHTML = `<div id="rvPast" class="mt-past rv-past"></div>`;
  renderPast($("#rvPast", sb), V.no, V.notes, {
    putLabel: "질문 칸에 넣기",
    put: (a) => { V.asked.set(`a:${a.mid}:${a.qid}`, { asked: true, again: false, memo: "", q: a.q, from: { mid: a.mid, qid: a.qid } }); V.fb?.touch(); toast("질문 칸에 넣었어요 — ② 피드백의 받은 질문으로 가요"); drawSide(); },
    used: new Set([...V.asked.values()].filter((x) => x.from).map((x) => x.from.mid + ":" + x.from.qid))
  });
}
// ===== 모의면접 창 하나로 (2026-11-13, spec-interview-card 3·4장) =====
// 오른쪽 [① 질문하기 | ② 피드백 | 지난 면접]. ② = 대면 기록 칸(openMeetingForm embed)을 이 창 안에 — 받은 질문 = ① 물어봄 (V.asked 가 기준)
// 임시 저장은 대면 기록 창의 것(mdraft:…)을 그대로 쓰고, ① 물어봄·답 메모·↻ 도 같이 넣음
function setTab(t) {
  if (!V) return;
  V.tab = t;
  if (t === "fb") V.fbFresh = true;   // ② 를 열 때만 ① 물어봄과 맞춰 받은 질문을 다시 그림 (쓰는 중 다른 일로 다시 그려져도 입력칸은 그대로)
  $$(".rv-tabs [data-tab]").forEach((x) => x.classList.toggle("on", x.dataset.tab === t));
  drawSide();
}
function syncSteps() {
  const t = V.tab === "fb" ? "fb" : "q";
  $$("#rvSteps [data-step]").forEach((x) => x.classList.toggle("on", x.dataset.step === t));
  const ft = document.getElementById("rvFoot"); if (ft) ft.hidden = V.tab === "fb";
}
const askedRows = () => [...V.asked.entries()].filter(([, a]) => a.asked && a.q).map(([rk, a]) => ({ rk, q: a.q, memo: a.memo || "", again: !!a.again,
  ...(a.pend ? { pend: a.pend } : {}), ...(a.pq ? { pq: a.pq } : {}), ...(a.from ? { from: a.from } : {}) }));
const askedSave = () => [...V.asked.entries()].filter(([, a]) => a.asked || a.memo || a.again).map(([k, a]) => [k, { asked: !!a.asked, again: !!a.again, memo: a.memo || "", q: a.q || "",
  ...(a.pend ? { pend: a.pend } : {}), ...(a.pq ? { pq: a.pq } : {}), ...(a.from ? { from: a.from } : {}) }]);
function dropFb() {
  if (!V) return;
  try { V.fb?.flush(); V.fb?.destroy(); } catch (e) { console.warn(e); }
  V.fbEl?.remove(); V.fb = null; V.fbEl = null; V.fbDone = null;
  const bar = document.getElementById("rvDraftBar"); if (bar) bar.innerHTML = "";
}
function mountFb({ id = "" } = {}) {
  if (!V || V.prep) return;
  dropFb();
  const el = document.createElement("div"); el.className = "rv-fb";
  V.fbEl = el;
  const p = V.preset, no = V.no;
  const mid = id || V.savedMid || (p?.id && (S.meetings || []).find((m) => m.id === p.id && !m.planned)?.id) || "";
  const embed = {
    el, draftBar: document.getElementById("rvDraftBar"),
    sync: {
      rows: () => (V && V.no === no ? askedRows() : []),
      set: (rk, patch) => { const a = V?.asked.get(rk); if (a) Object.assign(a, patch); }
    },
    extra: {
      get: () => (V && V.no === no ? askedSave() : []),
      set: (list) => { if (!V || V.no !== no) return; V.asked = new Map(Array.isArray(list) ? list : []); drawSide(); }
    },
    onBack: () => setTab("q"),
    onSaved: (info) => {
      if (!V || V.no !== no) return;
      V.savedMid = info.id; V.fbDone = info;
      try { V.fb?.destroy(); } catch (_) {}
      V.fbEl?.remove(); V.fb = null; V.fbEl = null;
      setTab("fb");
      reloadQs().then(() => { if (V && V.no === no) drawSide(); }).catch(() => {});
      loadMeetingNotes(no).then((n) => { if (V && V.no === no) { V.notes = n; drawSide(); } }).catch(() => {});
    }
  };
  V.fb = openMeetingForm(mid ? { id: mid, embed } : { studentNo: no, preset: p && p.id ? { ...p, stage: p.stage || V.stage } : null, fromRecord: { stage: V.stage, rows: [] }, embed });
}
function drawFb(sb) {
  if (V.fbDone) {
    const d = V.fbDone;
    sb.innerHTML = `<div class="rv-done"><h3>저장했어요 ✓</h3><ul>
      <li>${d.shared ? `받은 질문 ${d.qN}개 · 피드백을 학생에게 공개했어요` : "피드백은 학생에게 공개하지 않았어요 (선생님만 봐요)"}</li>
      ${d.shared && d.qN ? `<li>받은 질문은 학생 '내 생기부 면접'에 들어갔어요${d.pqAdded ? ` (새로 ${d.pqAdded}개)` : " (이미 있는 질문은 그대로)"}</li>` : ""}
      ${d.pendMoved ? `<li>공개 전이던 학생부 질문 ${d.pendMoved}개도 공개했어요</li>` : ""}
      <li>↻ 다음 차수에 다시 ${d.againN}개</li>
      ${d.filledSlot ? "<li>잡혀 있던 면접 일정의 기록으로 저장했어요</li>" : ""}
      ${d.fails?.length ? `<li class="bad">${esc(d.fails.join("·"))}를 저장하지 못했어요 — [기록 고치기]로 다시 저장해 주세요</li>` : ""}</ul>
      <div class="row"><button type="button" class="btn-sm" data-fbedit>기록 고치기</button><button type="button" class="btn-primary btn-sm" data-fbclose>창 닫기</button></div></div>`;
    $("[data-fbedit]", sb).onclick = () => { V.fbDone = null; mountFb({ id: V.savedMid }); drawSide(); };
    $("[data-fbclose]", sb).onclick = () => closeRecordViewer();
    return;
  }
  if (!V.fb) { mountFb(); V.fbFresh = true; }
  if (V.fbEl.parentNode !== sb) { sb.innerHTML = ""; sb.append(V.fbEl); V.fbFresh = true; }
  if (V.fbFresh) { V.fbFresh = false; V.fb.show(); }
}

// ===== 선생님 질문 암기 카드 (2026-11-13, spec-interview-card 5장) =====
// 질문 저장 뒤 booth-ai 'card'(Claude Sonnet 5.5)가 드래그한 글 속 개념 위주로 카드(핵심 키워드 흐름·핵심 개념 한 줄 정의)를 만들어
// Apps Script 가 선생님 토큰으로 personalQuestions/{id}.card·cardState 를 직접 저장 (창을 닫아도 저장됨). 웹앱은 부르기 전 cardState 'making'
// AI 로는 질문·꼬리질문·드래그한 글 한 칸·지원 학과 이름만 (학생 이름·학번·학생부 전체 안 보냄). AI 동의가 없으면 AI 를 부르지 않고 근거 카드만
export const CARD_WON = 13;                 // 질문 1개 약 $0.01 (약 13원) — 일괄 단추에 미리 보여 줌
const CARD_STALE_MS = 10 * 60 * 1000;       // 'making' 이 10분 넘으면 실패로 봄
const stageOfQ = (q) => Number(q.stage) || Number(String(q.category || "").match(/^(\d)차/)?.[1]) || 0;
// 근거 글: 그 질문을 가리키는 하이라이트의 드래그한 글 → 없으면 basis 의 따옴표 안 글 (예전 질문)
export function quoteOf(q, marks = []) {
  const bp = basisParts(q?.basis);
  const m = (marks || []).find((x) => x.qid === q?.id && x.kind === "q" && x.quote);
  if (m) return { quote: String(m.quote), sec: bp.sec || SEC_SHORT[m.sec] || "" };
  return /"[^"]+"\s*$/.test(String(q?.basis || "")) && bp.b ? { quote: bp.b, sec: bp.sec } : null;
}
// "ai" AI 카드 · "has" 카드 있음(AI 맞춤 초안 등) · "basic" 근거 카드(동의 없음) · "making" · "fail" · "none" 만들 수 있음 · "nobasis" 근거 글이 없어 못 만듦 · "" 선생님 질문 아님
export function cardState(q, marks = []) {
  if (!q || q.by !== "teacher") return "";
  const kw = arr(q.card?.kw).length;
  if (q.cardState === "making" && Date.now() - (Number(q.cardAt) || 0) < CARD_STALE_MS) return "making";
  if (q.card && kw) return q.card.ai ? "ai" : "has";
  if (q.card && (q.cardState === "noconsent" || q.card.b)) return "basic";
  const qt = quoteOf(q, marks);
  if (q.cardState === "fail" || q.cardState === "making") return qt ? "fail" : "nobasis";
  return qt ? "none" : "nobasis";
}
// AI 카드를 만들 대상 (동의가 있으면 근거 카드도 AI 카드로 바꿈)
export const cardTodo = (q, marks, consent) => { const s = cardState(q, marks); return s === "none" || s === "fail" || (!!consent && s === "basic"); };
export const cardDept = (st) => [...new Set((st?.universities || []).filter((u) => !announceFailed(u)).map((u) => String(u.dept || "").trim()).filter(Boolean))].join(", ");
export const CARD_ERR = {
  no_consent: "AI 사용 동의가 없어요.", limited: "오늘 암기 카드 한도를 넘었어요. 내일 다시 해 주세요.", no_access: "이 학생 학생부를 볼 수 있는 선생님(배정 선생님·관리자)만 카드를 만들 수 있어요.",
  no_record: "학생부가 없어요.", auth: "로그인을 다시 확인해 주세요.", no_key: "AI 키가 아직 설정되지 않았어요 (관리자).", bad_request: "보낼 질문이 없어요.",
  save: "카드 상태를 저장하지 못했어요."
};
export const cardErrText = (e) => CARD_ERR[e] || `암기 카드를 만들지 못했어요${e ? ` (${e})` : ""}. 잠시 뒤 [다시 만들기]를 눌러 주세요.`;
export async function consentOf(no) { try { const m = await getDoc(doc(db, "records", no, "aimeta", "main")); return !!(m.exists() && m.data().consentAt); } catch (_) { return false; } }
// qs: personalQuestions 문서들({ id, text, followUps, basis, stage, category, card? }) · consent: 이번에 동의를 받았다고 표시 · onLocal(id, patch): 화면 즉시 반영
// → { done:[id], fail:[id], basic:[id], skipped, error }
export async function makeCards(no, qs, { consent = false, marks = null, onLocal = null } = {}) {
  const out = { done: [], fail: [], basic: [], skipped: 0, error: "" };
  if (!qs?.length) return out;
  if (!marks) { try { marks = (await getDocs(collection(db, "records", no, "marks"))).docs.map((d) => ({ id: d.id, ...d.data() })); } catch (_) { marks = []; } }
  const items = qs.map((q) => { const qt = quoteOf(q, marks); return qt ? { q, qt } : null; }).filter(Boolean);
  out.skipped = qs.length - items.length;
  if (!items.length) return out;
  const g = (q) => `${stageOfQ(q) || "?"}차 선생님 질문`;
  const fuOf = (q) => arr(q.followUps).map((x) => String(x || "").trim()).filter(Boolean);
  const ref = (q) => doc(db, "students", no, "personalQuestions", q.id);
  if (!consent && !(await consentOf(no))) {
    // 동의 없음: AI 를 부르지 않고 질문 + 근거 + 꼬리질문 카드 (이미 키워드가 있는 카드는 그대로)
    const b = writeBatch(db);
    const list = items.filter(({ q }) => !arr(q.card?.kw).length).map(({ q, qt }) => ({ q, card: { kw: [], con: [], chk: [], fu: fuOf(q).map((x) => ({ q: x, pt: "" })), g: g(q), t: "", sec: qt.sec, b: qt.quote } }));
    if (!list.length) return out;
    list.forEach(({ q, card }) => b.update(ref(q), { card, cardState: "noconsent" }));
    try { await b.commit(); list.forEach(({ q, card }) => { out.basic.push(q.id); onLocal?.(q.id, { card, cardState: "noconsent" }); }); }
    catch (e) { console.warn("근거 카드", e); out.error = "save"; }
    return out;
  }
  const at = Date.now();
  try { const b = writeBatch(db); items.forEach(({ q }) => b.update(ref(q), { cardState: "making", cardAt: at })); await b.commit(); }
  catch (e) { console.warn("카드 상태", e); out.error = "save"; return out; }
  items.forEach(({ q }) => onLocal?.(q.id, { cardState: "making", cardAt: at }));
  const by = myName() || S.ctx.user.email, dept = cardDept(studentByNo(no));
  for (let i = 0; i < items.length; i += 20) {
    const part = items.slice(i, i + 20);
    const r = await aiCall(S.ctx.user, "card", { no, by, dept, ...(consent ? { consent: true } : {}),
      items: part.map(({ q, qt }) => ({ qid: q.id, q: q.text, fu: fuOf(q), quote: qt.quote.slice(0, 800), sec: qt.sec, g: g(q) })) }, 180000);
    if (r?.ok) { out.done.push(...arr(r.done)); out.fail.push(...arr(r.fail).map((f) => f.qid)); continue; }
    out.error = r?.error || "server";
    if (out.error === "timeout" || out.error === "network") continue;   // 서버에서는 계속 만들 수 있음 — 10분 지나도 '만드는 중'이면 [다시 만들기]
    try { const fb = writeBatch(db); part.forEach(({ q }) => fb.update(ref(q), { cardState: "fail", cardAt: Date.now() })); await fb.commit(); } catch (_) {}
    part.forEach(({ q }) => { out.fail.push(q.id); onLocal?.(q.id, { cardState: "fail" }); });
  }
  return out;
}
// 학생부 화면에서: 화면에 바로 '만드는 중' → 끝나면 그 질문들만 다시 읽어 '카드 생김'
function viewerCards(qs, opts = {}) {
  if (!V || !qs.length) return;
  const no = V.no;
  const onLocal = (id, patch) => { if (V?.no !== no) return; const q = V.pqs.find((x) => x.id === id); if (q) Object.assign(q, patch); if (V.editQ !== "q:" + id) drawSide(); };
  return makeCards(no, qs, { marks: V.marks, onLocal, ...opts }).then(async (r) => {
    if (r.error && r.error !== "timeout" && r.error !== "network") toast(cardErrText(r.error), "error", 6000);
    if (opts.consent && V?.no === no) V.consent = true;
    if (!V || V.no !== no) return r;
    try {
      const snaps = await Promise.all(qs.map((q) => getDoc(doc(db, "students", no, "personalQuestions", q.id)).catch(() => null)));
      if (!V || V.no !== no) return r;
      snaps.forEach((sn) => { if (!sn?.exists()) return; const i = V.pqs.findIndex((x) => x.id === sn.id); if (i >= 0) V.pqs[i] = { id: sn.id, ...sn.data(), createdAt: V.pqs[i].createdAt }; });
      drawSide();
    } catch (_) {}
    return r;
  });
}
// 질문 카드 아래 카드 상태 칸 (목업 ③) — 선생님 질문만
function cardBox(c) {
  if (!c.pq || c.kind !== "teacher") return "";
  const q = V.pqs.find((x) => x.id === c.pq); if (!q) return "";
  const s = cardState(q, V.marks), can = c.mine || !!S.ctx.isAdmin;
  if (s === "making") return '<div class="rv-cst making"><span class="spin" aria-hidden="true"></span><b>암기 카드 만드는 중…</b><span class="muted sm">면접을 계속하셔도 돼요</span></div>';
  if (s === "ai" || s === "has") return `<div class="rv-cst ok"><b>🃏 암기 카드 생김</b>${s === "ai" ? '<span class="ai-tag">AI 작성</span>' : ""}<div class="spacer"></div>${can ? '<button type="button" class="btn-sm" data-cedit>카드 고치기</button>' : ""}</div>
    <details class="rv-cpv"><summary>학생 카드 뒷면 미리 보기</summary>${backHtml(q.card)}</details>`;
  if (s === "basic") return `<div class="rv-cst basic"><b>🃏 AI 동의가 없어 카드는 질문·근거만</b><div class="spacer"></div>${can ? '<button type="button" class="btn-sm" data-cconsent>동의 받았어요 → AI 카드 만들기</button>' : ""}</div>`;
  if (s === "fail") return `<div class="rv-cst fail"><b>암기 카드를 만들지 못했어요</b><div class="spacer"></div>${can ? '<button type="button" class="btn-sm" data-cmake>다시 만들기</button>' : ""}</div>`;
  if (s === "none") return `<div class="rv-cst none"><b>암기 카드 없음</b><div class="spacer"></div>${can ? '<button type="button" class="btn-sm" data-cmake>카드 만들기</button>' : ""}</div>`;
  return "";
}
// 고치기 칸 아래: 공개 전 질문은 공개 시점(기본 '바로 공개'), 공개된 선생님 질문은 [카드 다시 만들기]
function editExtra(c) {
  if (c.pend) return `<div class="field"><label>공개 시점</label>
    <label class="inline-check"><input type="radio" name="rvEPub" value="now" checked> 바로 공개 <span class="muted sm">(학생 '내 생기부 면접'에 더해지고 암기 카드가 생겨요)</span></label>
    <label class="inline-check"><input type="radio" name="rvEPub" value="after"> 면접 뒤 공개 (그대로 두기)</label></div>`;
  const q = c.pq && V.pqs.find((x) => x.id === c.pq);
  const re = q && c.kind === "teacher" && quoteOf(q, V.marks) ? '<div class="row" style="margin-top:6px"><button type="button" class="btn-sm" data-cremake>카드 다시 만들기</button><span class="muted sm">AI 가 드래그한 글로 키워드·개념을 다시 써요 (지금 카드 내용은 바뀌어요)</span></div>' : "";
  return '<div class="muted sm">이미 공개된 질문이라 공개 시점은 그대로예요.</div>' + re;
}
function bindEditCard(el, c) {
  const q = () => c.pq && V.pqs.find((x) => x.id === c.pq);
  $("[data-ecancel]", el)?.addEventListener("click", () => { V.editQ = null; drawSide(); });
  $("[data-esave]", el)?.addEventListener("click", () => saveEditQ(c, el));
  if (el.classList.contains("ai-ed")) bindEd(el);
  $("[data-cedit]", el)?.addEventListener("click", () => { V.editQ = c.key; drawSide(); });
  $("[data-cmake]", el)?.addEventListener("click", () => { const x = q(); if (x) viewerCards([x]); });
  $("[data-cremake]", el)?.addEventListener("click", () => { const x = q(); if (!x) return; V.editQ = null; viewerCards([x], { consent: false }); });
  $("[data-cconsent]", el)?.addEventListener("click", async () => {
    if (!(await confirmBox({ title: "AI 사용 동의를 받았나요?", what: `${esc(V.no)} ${esc(V.st.name)} — 학생·보호자에게 AI 사용 동의를 받았을 때만 눌러 주세요.`,
      note: "질문·꼬리질문·드래그한 학생부 글 한 칸·지원 학과 이름만 AI(Claude Sonnet 5.5)로 보내 암기 카드를 만들어요. 학생 이름·학번은 보내지 않아요. 이 학생의 근거 카드를 모두 AI 카드로 바꿔요.", yes: "동의 받았어요 · 만들기" }))) return;
    const list = V.pqs.filter((x) => cardTodo(x, V.marks, true));
    viewerCards(list, { consent: true });
  });
}

// ================= AI 맞춤 예상질문 (2026-11-03, spec-ai-questions) =================
// 초안(records/{학번}/aiq)은 booth-ai Apps Script 가 만들고, 선생님이 질문 준비 화면의 [AI 초안] 탭에서 채택·고치기·버리기.
// 채택 = 지금 [질문 만들기] 저장과 같은 길 (면접 뒤 공개 → pending, 바로 공개 → personalQuestions source "ai") + 하이라이트 + 암기 카드(card)
// 카드: { kw[], con[{t,d}], chk[], fu[{q,pt}], g(묶음 이름), t(기출 유형), sec, b } — Firestore 는 배열 안 배열을 못 담아 {t,d}·{q,pt} 꼴
const univShort = (u) => univName(u).replace(/대학교/g, "대");
const PRI_LABEL = { A: "A 최우선", B: "B 권장", C: "C 확인" };
const TIER_ORDER = { 핵심: 0, 심화: 1, 확장: 2, 맞춤: 3 };
const SRC_CLS = { exact: "exact", "same-uni": "fallback", fallback: "fallback", none: "fallback" };
const SRC_NOTE = "출처: 충북교육청 면접후기 사례집 — 질문만 참고, 선배 답변은 쓰지 않음";
// 대학 묶음: aimeta.unis 중 지금 면접일 자료에 있는 대학만 (1차 불합격은 흐리게 · 초안 숨김)
function aiUnis() {
  const ivs = V.st.universities || [];
  return (V.aimeta?.unis || []).map((u) => { const iv = ivs.find((x) => x.id === u.iid); return iv ? { ...u, failed: announceFailed(iv) } : null; }).filter(Boolean);
}
const grpLabel = (g) => { if (g === "common") return "공통"; const u = (V?.aimeta?.unis || []).find((x) => x.key === g); return u ? [univShort(u.univ), u.dept].filter(Boolean).join(" ") : "대학 맞춤"; };
function aiVisible() {
  const ok = new Set(aiUnis().filter((u) => !u.failed).map((u) => u.key));
  return (V.aiq || []).filter((a) => a.status === "new" && (a.grp === "common" || ok.has(a.grp)))
    .sort((a, b) => (a.pri || "B").localeCompare(b.pri || "B") || (TIER_ORDER[a.tier] ?? 9) - (TIER_ORDER[b.tier] ?? 9));
}
const arr = (x) => (Array.isArray(x) ? x : []);
// 학생 암기 카드 뒷면 미리 보기 (핵심 키워드 → 핵심 개념 → 학생이 정리할 것 → 꼬리질문)
function backHtml(o) {
  return `<div class="pv">${arr(o.kw).length ? `<div class="pv-l">핵심 키워드</div><div class="ai-kw">${arr(o.kw).map(esc).join(" <i>→</i> ")}</div>` : ""}
    ${arr(o.con).length ? `<div class="pv-l">핵심 개념 <span class="aiw">AI 작성 — 교과 내용과 맞는지 확인해 주세요</span></div><div class="pv-con">${arr(o.con).map((c) => `<div><b>${esc(c.t)}</b> ${esc(c.d)}</div>`).join("")}</div>` : ""}
    ${arr(o.chk).length ? `<div class="pv-l">학생이 직접 정리할 것</div><div class="chk">${arr(o.chk).map((c) => `<span>[${esc(c)}]</span>`).join(" ")}</div>` : ""}
    ${arr(o.fu).length ? `<div class="pv-l">꼬리질문 대비</div><ul>${arr(o.fu).map((f) => `<li>${esc(f.q)}${f.pt ? `<br><span class="pt">답변 포인트 · ${esc(f.pt)}</span>` : ""}</li>`).join("")}</ul>` : ""}
    ${!arr(o.kw).length && !arr(o.con).length && !arr(o.chk).length && !arr(o.fu).length ? '<div class="muted sm">아직 카드 내용이 없어요 — 핵심 키워드를 적으면 학생 암기 카드가 돼요</div>' : ""}</div>`;
}
function aiCardHtml(a) {
  return `<div class="rv-card ai-card" data-ai="${esc(a.id)}">
    <div class="row"><span class="ai-tag">AI 초안</span><span class="tier">${esc(a.tier || "")}</span><span class="pri p${esc(a.pri || "B")}">${PRI_LABEL[a.pri] || esc(a.pri || "")}</span>${a.type ? `<span class="kt">기출 유형 · ${esc(a.type)}</span>` : ""}${a.edited ? '<span class="edt">고침</span>' : ""}<div class="spacer"></div><span class="muted sm">근거 ✓</span></div>
    <div class="rv-qt">${esc(a.q)}</div>
    ${arr(a.intent).length ? `<div class="ai-int">의도 · ${arr(a.intent).map(esc).join(" · ")}</div>` : ""}
    <div class="rv-basis">${esc(a.sec || "")} "<u>${maskSpans(a.b || "")}</u>"</div>
    ${arr(a.kw).length ? `<div class="ai-kw">${arr(a.kw).map(esc).join(" <i>→</i> ")}</div>` : ""}
    <details class="ai-back"><summary>학생 암기 카드 뒷면 미리 보기${arr(a.con).length ? ` · 개념 ${arr(a.con).length}` : ""} · 꼬리질문 ${arr(a.fu).length}</summary>${backHtml(a)}</details>
    <div class="row rv-acts"><button type="button" class="btn-sm btn-primary" data-adopt>채택</button><button type="button" class="btn-sm" data-edit>고치기</button><div class="spacer"></div><button type="button" class="btn-sm btn-danger" data-drop>버리기</button></div></div>`;
}
// 편집 칸 (AI 초안 · 뽑은 질문 같이 씀): 질문 / 핵심 키워드(→) / 핵심 개념(용어 — 정리) / 정리할 것 / 꼬리질문 | 답변 포인트 + 미리 보기
const edOf = (c) => ({ q: c.text, kw: arr(c.card?.kw), con: arr(c.card?.con), chk: arr(c.card?.chk), fu: arr(c.card?.fu).length ? c.card.fu : c.followUps.map((q) => ({ q, pt: "" })) });
function edHtml(o, { key = "", ai = "", head = "", extra = "" } = {}) {
  return `<div class="rv-card rv-edit ai-card ai-ed"${key ? ` data-card="${esc(key)}"` : ""}${ai ? ` data-ed="${esc(ai)}"` : ""}><div class="row">${head}</div>
    <label>질문<textarea data-f="q" rows="2">${esc(o.q || "")}</textarea></label>
    <label>핵심 키워드 <span class="hint">→ 로 나눠 적기</span><input data-f="kw" value="${esc(arr(o.kw).join(" → "))}"></label>
    <label>핵심 개념 <span class="hint">한 줄에 하나 · 용어 — 한 줄 정리</span><textarea data-f="con" rows="3">${esc(arr(o.con).map((c) => `${c.t} — ${c.d}`).join("\n"))}</textarea></label>
    <label>학생이 직접 정리할 것 <span class="hint">한 줄에 하나</span><textarea data-f="chk" rows="2">${esc(arr(o.chk).join("\n"))}</textarea></label>
    <label>꼬리질문 | 답변 포인트 <span class="hint">한 줄에 하나</span><textarea data-f="fu" rows="3">${esc(arr(o.fu).map((f) => f.pt ? `${f.q} | ${f.pt}` : f.q).join("\n"))}</textarea></label>
    <div class="pvw"><b>학생 카드 뒷면 미리 보기</b><div></div></div>${extra}
    <div class="muted sm" data-e="err" style="color:var(--danger)"></div>
    <div class="row"><button type="button" class="btn-sm" data-ecancel>취소</button><div class="spacer"></div><button type="button" class="btn-sm btn-primary" data-esave>저장</button></div></div>`;
}
const edLines = (t) => String(t || "").split("\n").map((x) => x.trim()).filter(Boolean);
function readEd(el) {
  const v = (k) => $(`[data-f="${k}"]`, el).value;
  return {
    q: v("q").trim(),
    kw: v("kw").split(/→|->/).map((x) => x.trim()).filter(Boolean).slice(0, 8),
    con: edLines(v("con")).slice(0, 4).map((l) => { const k = l.search(/\s[—–-]\s|—/); return k < 0 ? { t: l, d: "" } : { t: l.slice(0, k).trim(), d: l.slice(k).replace(/^\s*[—–-]\s*/, "").trim() }; }),
    chk: edLines(v("chk")).slice(0, 5),
    fu: edLines(v("fu")).slice(0, 6).map((l) => { const [q, ...p] = l.split("|"); return { q: q.trim(), pt: p.join("|").trim() }; }).filter((f) => f.q)
  };
}
function bindEd(el) { const pv = () => { $(".pvw > div", el).innerHTML = backHtml(readEd(el)); }; pv(); el.addEventListener("input", pv); }
const hasCard = (e) => e.kw.length > 0 || e.con.length > 0 || e.chk.length > 0 || e.fu.some((f) => f.pt);
// 예전 질문 근거 '구역 · 칸 "글"' → { sec, b } (카드 뒷면 '내 학생부'용)
function basisParts(basis) { const m = String(basis || "").match(/^(.*?)\s*"([^"]+)"\s*$/); return m ? { g: "", t: "", sec: m[1].trim(), b: m[2].replace(/…$/, "") } : { g: "", t: "", sec: "", b: String(basis || "") }; }

function drawAi(sb) {
  const unis = aiUnis(), vis = aiVisible(), ax = arr(V.aimeta?.axes);
  if (V.aiGrp !== "common" && !unis.some((u) => u.key === V.aiGrp)) V.aiGrp = "common";
  const n = (g) => vis.filter((a) => a.grp === g).length;
  const kindLab = (u) => u.kind === "passage" ? "제시문" : u.kind === "given" ? "대학 제공 질문" : "";
  const chip = (u) => `<button type="button" data-gc="${esc(u.key)}" class="${V.aiGrp === u.key ? "on" : ""}${u.failed ? " dim" : ""}">${esc(grpLabel(u.key))} ${u.failed ? "· 1차 불합격" : kindLab(u) ? "· " + kindLab(u) : u.todo ? "· 아직 못 만듦" : `<span>${n(u.key)}</span>`}</button>`;
  const g = V.aiGrp, u = unis.find((x) => x.key === g);
  const list = vis.filter((a) => a.grp === g);
  const editing = (a) => V.aiEdit === a.id;
  const cardsHtml = list.map((a) => editing(a) ? edHtml(a, { ai: a.id, head: '<span class="ai-tag">AI 초안</span><b>고치기</b><span class="muted sm">질문과 학생 암기 카드에 나갈 내용</span>' }) : aiCardHtml(a)).join("");
  let body = "";
  if (!u) body = cardsHtml || `<div class="muted sm">${V.aimeta?.status === "running" ? "AI 가 만드는 중이에요… 질문 탭에서 진행을 볼 수 있어요." : "남은 공통 초안이 없어요."}</div>`;
  else {
    const src = u.src || {};
    body = `<div class="uhd"><b>${esc(grpLabel(u.key))}</b> <span class="muted sm">${esc([u.admission, u.format ? "면접 유형 " + u.format : ""].filter(Boolean).join(" · "))}</span></div>
      <div class="src ${SRC_CLS[src.kind] || "fallback"}"><b>${src.kind === "exact" ? "✓" : "⚠"} ${esc(src.title || "기출 정보 없음")}</b><div class="muted sm">${src.who ? esc(src.who) + " · " : ""}판단: ${esc(u.why || src.why || "")} · ${SRC_NOTE}</div></div>
      ${arr(u.guide).length ? `<div class="guide"><b>면접 안내 (기출 요약)</b><ul>${u.guide.map((x) => `<li>${esc(x)}</li>`).join("")}</ul></div>` : ""}
      ${u.failed ? '<div class="muted sm">1차 불합격으로 남긴 대학이라 이 대학 초안은 숨겼어요. 채택한 질문은 그대로예요. 결과를 되돌리면 다시 보여요.</div>'
        : u.todo ? '<div class="muted sm">시간이 모자라 아직 못 만들었어요. 질문 탭 [대학별 다시 만들기]를 누르면 이 대학부터 만들어요.</div>'
        : (u.kind === "passage" || u.kind === "given") ? "" : cardsHtml || '<div class="muted sm">남은 초안이 없어요.</div>'}
      ${!u.failed && arr(u.past).length ? `<div class="guide"><b>${u.kind === "record" || u.kind === "personality" ? "제시문 기출 질문" : "기출 질문"} (${u.past.length})</b><ol>${u.past.map((x) => `<li>${esc(x)}</li>`).join("")}</ol>
        ${u.kind === "passage" || u.kind === "given" ? `<div class="muted sm">${kindLab(u)} 면접이라 학생부 질문은 만들지 않았어요.</div>` : ""}</div>` : ""}`;
  }
  sb.innerHTML = `<div class="ai-ban"><b>AI 맞춤 초안 · ${esc(V.no)} ${esc(V.st.name)} <span class="muted sm" style="font-weight:500">선생님만 보임</span></b>
      ${ax.length ? `<details><summary style="cursor:pointer;font-weight:700;font-size:.8rem">면접 핵심 축 ${ax.length}</summary><ol>${ax.map((x) => `<li>${esc(x)}</li>`).join("")}</ol></details>` : ""}
      <div class="muted sm">근거 문장이 학생부에 있는 것만 남겼어요. 채택하면 내 질문(${V.stage}차)이 돼요. 다른 배정 선생님도 같은 초안을 봐요 — 먼저 채택한 사람 것이 돼요.</div>
      <div class="rv-pubnote">[채택]하면 바로 학생에게 공개되고 암기 카드가 생겨요</div></div>
    <div class="gchips"><button type="button" data-gc="common" class="${g === "common" ? "on" : ""}">공통 <span>${n("common")}</span></button>${unis.map(chip).join("")}</div>
    <div data-g="${esc(g)}">${body}</div>`;
  $$("[data-gc]", sb).forEach((b) => b.onclick = () => { V.aiGrp = b.dataset.gc; V.aiEdit = null; drawSide(); });
  $$(".ai-card[data-ai]", sb).forEach((el) => {
    const a = V.aiq.find((x) => x.id === el.dataset.ai); if (!a) return;
    const mk = () => document.querySelector(`#rvIn mark.ai[data-ai="${CSS.escape(a.id)}"]`);
    el.addEventListener("mouseenter", () => mk()?.classList.add("flash"));
    el.addEventListener("mouseleave", () => mk()?.classList.remove("flash"));
    $("[data-adopt]", el)?.addEventListener("click", () => adoptAi(a, $("[data-adopt]", el)));
    $("[data-edit]", el)?.addEventListener("click", () => { V.aiEdit = a.id; drawSide(); });
    $("[data-drop]", el)?.addEventListener("click", () => dropAi(a));
  });
  $$(".ai-ed[data-ed]", sb).forEach((el) => {
    const a = V.aiq.find((x) => x.id === el.dataset.ed); if (!a) return;
    bindEd(el);
    $("[data-ecancel]", el).onclick = () => { V.aiEdit = null; drawSide(); };
    $("[data-esave]", el).onclick = () => saveAiEdit(a, el);
  });
}
function focusAi(id) {
  const a = V?.aiq.find((x) => x.id === id); if (!a) return;
  V.tab = "ai"; V.aiGrp = a.grp;
  $$(".rv-tabs [data-tab]").forEach((x) => x.classList.toggle("on", x.dataset.tab === "ai")); drawSide();
  const el = $(`#rvSb .ai-card[data-ai="${CSS.escape(id)}"]`);
  el?.scrollIntoView({ block: "center", behavior: "smooth" }); el?.classList.add("flash"); setTimeout(() => el?.classList.remove("flash"), 1200);
}
async function saveAiEdit(a, el) {
  const e = readEd(el);
  const bad = !e.q ? "질문을 적어 주세요." : !e.kw.length ? "핵심 키워드를 하나 이상 적어 주세요." : badQuestionText([e.q, ...e.fu.map((f) => f.q)].join("\n"), V.no);
  if (bad) { $("[data-e=err]", el).textContent = bad; return; }
  $("[data-esave]", el).disabled = true;
  try {
    await updateDoc(doc(db, "records", V.no, "aiq", a.id), { q: e.q, kw: e.kw, con: e.con, chk: e.chk, fu: e.fu, edited: true });
    Object.assign(a, { q: e.q, kw: e.kw, con: e.con, chk: e.chk, fu: e.fu, edited: true });
    V.aiEdit = null; drawSide();
    toast("고쳤어요 — 채택하면 이 내용이 학생 암기 카드에 나가요");
  } catch (err) { $("[data-esave]", el).disabled = false; showError(err, "AI 초안 고치기"); }
}
async function dropAi(a) {
  try {
    await updateDoc(doc(db, "records", V.no, "aiq", a.id), { status: "dropped", droppedBy: myName() || S.ctx.user.email, droppedAt: serverTimestamp() });
    a.status = "dropped"; drawDoc(); drawSide(); toast("버렸어요");
  } catch (e) { showError(e, "AI 초안 버리기"); }
}
// 채택: 트랜잭션으로 아직 'new' 인지 확인하고(먼저 채택한 사람 것) 질문·하이라이트·카드를 한 번에
async function adoptAi(a, btn) {
  const pub = "now", no = V.no, me = myName() || S.ctx.user.email, stage = V.stage;   // (2026-11-13) 채택 = 늘 바로 공개
  const bad = badQuestionText([a.q, ...arr(a.fu).map((f) => f.q)].join("\n"), no);
  if (bad) return toast(bad, "error", 6000);
  const card = { kw: arr(a.kw), con: arr(a.con), chk: arr(a.chk), fu: arr(a.fu), g: grpLabel(a.grp), t: a.type || "", sec: a.sec || "", b: a.b || "" };
  const basis = `${a.sec || ""} "${a.b || ""}"`.trim();
  const followUps = arr(a.fu).map((f) => f.q);
  // 하이라이트 자리: 초안이 가리키는 칸에서 근거를 찾고, 없으면 학생부 전체에서
  const rows = V.rec.sections || [];
  let hit = null;
  const row = rows.find((x) => x.key === a.at?.sec)?.rows?.[Number(a.at?.row)];
  const i = row && a.b ? row.text.indexOf(a.b) : -1;
  hit = i >= 0 ? { sec: a.at.sec, row: Number(a.at.row), start: i, end: i + a.b.length } : findQuote(rows, { quote: a.b, sec: a.at?.sec, row: Number(a.at?.row) });
  const aref = doc(db, "records", no, "aiq", a.id), mref = doc(collection(db, "records", no, "marks"));
  const ref = pub === "after" ? doc(collection(db, "records", no, "pending")) : doc(collection(db, "students", no, "personalQuestions"));
  const data = pub === "after"
    ? { text: a.q, followUps, basis, sec: a.at?.sec || "", stage, by: me, byUid: S.ctx.user.uid, ...(hit ? { markId: mref.id } : {}), card, aiId: a.id, createdAt: serverTimestamp() }
    : { text: a.q, basis, followUps, category: `${stage}차 선생님 질문`, type: "document", by: "teacher", addedBy: me, source: "ai", stage, card, aiId: a.id, createdAt: serverTimestamp() };
  const mark = hit ? { kind: "q", stage, by: me, byUid: S.ctx.user.uid, ...hit, quote: a.b, at: Date.now(), qid: ref.id } : null;
  if (btn) btn.disabled = true;
  try {
    let cur = null;
    if (pub === "now") cur = (await getDocs(collection(db, "students", no, "personalQuestions"))).docs.map((d) => ({ id: d.id, ...d.data() }));
    await runTransaction(db, async (tx) => {
      const s = await tx.get(aref);
      if (!s.exists() || s.data().status !== "new") throw Object.assign(new Error("taken"), { code: "taken" });
      tx.update(aref, { status: "adopted", adoptedBy: me, adoptedAt: serverTimestamp(), toId: ref.id, toPub: pub });
      tx.set(ref, data);
      if (mark) tx.set(mref, mark);
    });
    a.status = "adopted";
    if (pub === "now") {
      const stats = pqStats([...cur, { ...data, by: "teacher" }]);
      await updateDoc(doc(db, "students", no), stats);   // 개수 칸 (캐시 목록이라 쓰기 래퍼로)
      Object.assign(studentByNo(no) || {}, stats);
      V.pqs = [...cur, { id: ref.id, ...data, createdAt: { seconds: Date.now() / 1000 } }];
      log(no, "publish");
    } else V.pending.push({ id: ref.id, ...data, createdAt: { seconds: Date.now() / 1000 } });
    if (mark) V.marks.push({ id: mref.id, ...mark });
    V.newIds.push(ref.id);
    drawDoc(); drawSide();
    toast(pub === "now" ? "채택했어요 — 바로 공개, 학생 암기 카드에도 생겼어요" : `채택했어요 — ${stage}차 면접 기록을 저장할 때 학생에게 공개돼요`);
  } catch (e) {
    if (btn) btn.disabled = false;
    if (e?.code === "taken") { toast("다른 선생님이 먼저 채택했거나 버린 초안이에요.", "error"); a.status = "taken"; drawDoc(); drawSide(); }
    else showError(e, "AI 초안 채택");
  }
}

// ---- 만들기·진행 표시 (학생부 넣기 5단계 · 질문 탭 [AI 맞춤 질문]이 같이 씀)
// Apps Script 는 요청 안에서 끝까지 돎(최대 6분). 진행은 aimeta.step 을 구독해서 보여 줌. 창을 닫아도 서버 실행은 이어짐
// 끝난 뒤 '아직 못 만듦' 대학이 있고 화면이 열려 있으면 그 대학만 한 번 더 자동으로 (사용자 결정 2026-11-03)
const AI_STEPS_BIG = (unis) => ["학생부 읽기 (가림본)", `지원 대학·전형·학과 확인 (대학별 면접일 자료)${unis ? " — " + unis : ""}`, "기출 찾기 (충북교육청 면접후기 사례집)", "공통 질문 · 대학별 맞춤 질문 만들기", "근거 문장이 학생부에 있는지 확인", "암기 카드(핵심 키워드·확인할 것) 만들기"];
const AI_STEPS_SM = ["저장된 학생부 읽기 (가림본)", "지원 대학·전형·학과 확인", "기출 찾기 (면접후기 사례집)", "공통·대학별 맞춤 질문 만들기", "근거 문장 확인", "암기 카드 만들기"];
export const AI_ERR = {
  no_consent: "AI 사용 동의가 없어요. 동의를 받았다고 표시한 뒤 다시 눌러 주세요.", running: "이미 만드는 중이에요. 잠시 뒤 다시 확인해 주세요.",
  limited: "오늘 AI 맞춤 질문 한도(학생 수)를 넘었어요. 내일 다시 해 주세요.", no_access: "이 학생 학생부를 볼 수 있는 선생님(배정 선생님·관리자)만 만들 수 있어요.",
  no_record: "학생부가 없어요.", auth: "로그인을 다시 확인해 주세요.", timeout: "응답을 기다리다 끊겼어요. 서버에서는 계속 만들 수 있어요 — 잠시 뒤 질문 탭에서 확인해 주세요.",
  network: "연결이 끊겼어요. 서버에서는 계속 만들 수 있어요 — 잠시 뒤 질문 탭에서 확인해 주세요."
};
export const aiErrText = (r) => AI_ERR[r?.error] || `AI 맞춤 질문을 만들지 못했어요${r?.error ? ` (${r.error})` : ""}. 잠시 뒤 다시 해 주세요.`;
export async function runAiq(no, { scope = "all", only = null, consent = false, box, big = false, onDone = null } = {}) {
  const st = studentByNo(no), by = myName() || S.ctx.user.email;
  const uniNames = (st?.universities || []).filter((u) => !announceFailed(u)).map((u) => [univShort(u.univ), u.dept].filter(Boolean).join(" ")).join(" · ");
  const labels = big ? AI_STEPS_BIG(uniNames) : AI_STEPS_SM;
  const live = () => box?.isConnected;
  const draw = (step, title = "맞춤 예상질문·암기 카드를 만들고 있어요") => {
    if (!live()) return;
    const ol = `<ol class="${big ? "" : "qai-run"}">${labels.map((t, i) => `<li class="${i < step ? "done" : i === step ? "on" : ""}"><i>${i < step ? "✓" : ""}</i>${esc(t)}</li>`).join("")}</ol>`;
    box.innerHTML = big ? `<div class="row" style="gap:8px;align-items:center"><span class="ai-tag">AI</span><b>${esc(title)}</b><span class="muted sm">약 1~2분 · 창을 닫아도 계속돼요</span></div>${ol}` : ol;
  };
  draw(0);
  const un = onSnapshot(doc(db, "records", no, "aimeta", "main"), (s) => { const m = s.exists() ? s.data() : null; if (m?.status === "running") draw(Number(m.step) || 0); }, () => {});
  let res = await aiCall(S.ctx.user, "aiq", { no, scope, ...(only ? { only } : {}), consent, by });
  if (res?.ok && res.todo?.length && live()) {
    draw(3, "시간이 모자란 대학을 한 번 더 만들고 있어요");
    const r2 = await aiCall(S.ctx.user, "aiq", { no, scope: "unis", only: res.todo, consent: false, by });
    if (r2?.ok) res = { ...r2, first: res };
  }
  un();
  let meta = null;
  try { const m = await getDoc(doc(db, "records", no, "aimeta", "main")); meta = m.exists() ? m.data() : null; } catch (_) {}
  if (live()) {
    if (!res?.ok) box.innerHTML = `<div class="notice">${esc(aiErrText(res))}</div>`;
    else {
      box.innerHTML = (big ? `<div class="row" style="gap:8px;align-items:center"><span class="ai-tag">AI</span><b>맞춤 예상질문·암기 카드를 만들었어요</b></div>` : "") + aiSummaryHtml(meta, st)
        + `<div class="muted sm">배정 선생님(1·2·3차)이 학생부 '질문 준비' 화면의 <b>AI 초안</b>에서 채택해야 학생에게 보여요.</div>
        ${canSeeRec(st) ? '<div class="row" style="margin-top:6px"><button type="button" class="btn-sm btn-primary" data-aireview>AI 초안 검토하기 →</button></div>' : ""}`;
      $("[data-aireview]", box)?.addEventListener("click", () => { if (big) { closeUpload(); window.dispatchEvent(new CustomEvent("records-changed", { detail: { no } })); } openRecordViewer(no, { mode: "prep", tab: "ai", onClose: () => onDone?.(res, meta, true) }); });
    }
  }
  onDone?.(res, meta);
  return res;
}
export function aiSummaryHtml(meta, st) {
  const c = meta?.counts || {}, ivs = st?.universities || [];
  const unis = (meta?.unis || []).filter((u) => { const iv = ivs.find((x) => x.id === u.iid); return iv && !announceFailed(iv); });
  const nCom = c.common || 0;
  const rows = [`<tr><td><b>공통</b></td><td>${nCom}개${nCom < 15 ? " — 학생부에서 근거가 충분한 것만" : ""}${c.dropped ? ` (근거를 학생부에서 못 찾은 ${c.dropped}개는 뺌)` : ""}</td></tr>`]
    .concat(unis.map((u) => `<tr><td><b>${esc([univShort(u.univ), u.dept].filter(Boolean).join(" "))}</b></td><td>${u.todo ? "아직 못 만듦 — 질문 탭 [대학별 다시 만들기]"
      : u.kind === "passage" || u.kind === "given" ? `${u.kind === "given" ? "대학 제공 질문" : "제시문"} 면접 — 학생부 질문 대신 기출 안내 · ${esc(u.src?.title || "")}`
      : `맞춤 ${(c.byUni || {})[u.key] || 0}개 — ${esc(u.src?.title || "")}`}</td></tr>`));
  return `<table class="ai-sum">${rows.join("")}</table>`;
}

// ================= E. 관리 화면 '학생부' =================
export async function renderRecordAdmin(p) {
  p.innerHTML = `<div class="card ra-pend" id="raPend"><h3>공개 전 질문 한 번에 공개 <span class="muted sm" style="font-weight:500">관리자만 · 한 번만 쓰는 정리 단추</span></h3>
      <p class="muted sm" style="margin-top:0">'면접 뒤 공개'로 만들어 두고 아직 공개되지 않은 질문이에요. 이제 질문은 만들면 바로 공개되므로, 남은 것을 한꺼번에 공개해요.</p>
      <div id="raPendBody" class="muted">세는 중…</div></div>
    <div class="card ra-card" id="raCard"><h3>🃏 카드 없는 선생님 질문 (전체)</h3><div id="raCardBody" class="muted">세는 중…</div></div>
    <div class="card"><h3>학생부</h3>
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
  adminPend(p, nos).then(() => adminCards(p, nos));
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

// ---- 관리자 ⑨ (2026-11-13, spec-interview-card 2장·5장): 남은 '면접 뒤 공개' 질문 한 번에 공개 · 카드 없는 선생님 질문 전체 카드 만들기
async function adminPend(p, nos) {
  const box = $("#raPendBody", p); if (!box) return;
  const rows = [];
  for (const no of nos) { try { const l = await loadPending(no); if (l.length) rows.push({ no, list: l }); } catch (e) { console.warn("공개 전 질문", no, e); } }
  if (!box.isConnected) return;
  const total = rows.reduce((a, r) => a + r.list.length, 0);
  if (!total) { box.className = "muted"; box.textContent = "남은 공개 전 질문이 없어요"; return; }
  box.className = "";
  box.innerHTML = `<div class="table-wrap"><table class="ra-t"><thead><tr><th>학생</th><th>차수</th><th class="n">질문</th></tr></thead><tbody>
    ${rows.map((r) => `<tr><td>${esc(r.no)} ${esc(studentByNo(r.no)?.name || "")}</td><td>${[...new Set(r.list.map((x) => Number(x.stage) || 0))].sort().map((k) => `${k || "?"}차`).join(" · ")}</td><td class="n">${r.list.length}</td></tr>`).join("")}
    <tr class="sum"><td>합계 · 학생 ${rows.length}명</td><td></td><td class="n">${total}</td></tr></tbody></table></div>
    <div class="row" style="margin-top:8px"><button type="button" class="btn-primary btn-sm" id="raPub">${total}개 모두 지금 공개</button><span class="muted sm">학생 '내 생기부 면접'으로 옮기고, 암기 카드가 없으면 카드도 만들어요</span></div>
    <div id="raPubRun"></div>`;
  $("#raPub", box).onclick = async () => {
    if (!(await confirmBox({ title: `공개 전 질문 ${total}개를 지금 공개할까요?`, what: `학생 ${rows.length}명 · 질문 ${total}개를 학생 '내 생기부 면접'으로 옮겨요.`,
      note: "되돌릴 수 없어요. 공개한 질문 중 암기 카드가 없는 것은 이어서 카드를 만들어요 (AI 동의가 없는 학생은 질문·근거 카드만).", yes: "모두 공개" }))) return;
    $("#raPub", box).disabled = true;
    const run = $("#raPubRun", box);
    const bar = (k, all, t) => { if (run.isConnected) run.innerHTML = `<div class="ra-prog"><i style="width:${all ? Math.round(k / all * 100) : 100}%"></i></div><div class="muted sm">${esc(t)}</div>`; };
    const made = []; let n = 0, failN = 0, c = 0;
    for (let i = 0; i < rows.length; i++) {
      bar(i, rows.length, `공개하는 중… ${i + 1} / ${rows.length}명`);
      const out = [];
      try { n += await publishPending(rows[i].no, rows[i].list, out); made.push({ no: rows[i].no, qs: out.filter((q) => !arr(q.card?.kw).length) }); }
      catch (e) { console.warn("공개", rows[i].no, e); failN++; }
    }
    const need = made.filter((m) => m.qs.length);
    for (let i = 0; i < need.length; i++) {
      bar(i, need.length, `암기 카드 만드는 중… ${i + 1} / ${need.length}명`);
      const r = await makeCards(need[i].no, need[i].qs);
      c += r.done.length + r.basic.length;
    }
    toast(`질문 ${n}개를 공개했어요${c ? ` · 암기 카드 ${c}장` : ""}${failN ? ` · ${failN}명은 공개하지 못했어요 (다시 눌러 주세요)` : ""}`, failN ? "error" : undefined, 8000);
    window.dispatchEvent(new CustomEvent("records-changed", { detail: {} }));
    renderRecordAdmin(p);
  };
}
async function adminCards(p, nos) {
  const box = $("#raCardBody", p); if (!box) return;
  const per = [];
  for (const no of nos) {
    try {
      const [pq, mk, cs] = await Promise.all([getDocs(collection(db, "students", no, "personalQuestions")), getDocs(collection(db, "records", no, "marks")), consentOf(no)]);
      const qs = pq.docs.map((d) => ({ id: d.id, ...d.data() })), marks = mk.docs.map((d) => ({ id: d.id, ...d.data() }));
      const todo = qs.filter((q) => cardTodo(q, marks, cs));
      if (todo.length) per.push({ no, todo, marks, consent: cs });
    } catch (e) { console.warn("카드 세기", no, e); }
  }
  if (!box.isConnected) return;
  const ai = per.filter((x) => x.consent), noC = per.filter((x) => !x.consent);
  const nAi = ai.reduce((a, x) => a + x.todo.length, 0);
  if (!per.length) { box.className = "muted"; box.textContent = "카드가 없는 선생님 질문이 없어요"; return; }
  box.className = "";
  box.innerHTML = `<div class="ra-chips"><span>학생 <b>${ai.length}</b>명</span><span>질문 <b>${nAi}</b>개</span>${noC.length ? `<span>AI 동의 없음 <b>${noC.length}</b>명 (건너뜀)</span>` : ""}</div>
    <div class="row" style="margin-top:8px"><button type="button" class="btn-sm" id="raMake" ${nAi ? "" : "disabled"}>${nAi}개 카드 만들기</button><span class="muted sm">약 $${(nAi * 0.01).toFixed(2)} (약 ${(nAi * CARD_WON).toLocaleString("ko-KR")}원) · Sonnet 5.5</span></div>
    <div class="muted sm" style="margin-top:4px">근거 글(드래그한 학생부 글)이 있는 선생님 질문만 만들어요. 동의 없는 학생은 질문 탭에서 [동의 받았어요 → AI 카드 만들기]로 만들어요.</div>
    <div id="raCardRun"></div>`;
  $("#raMake", box)?.addEventListener("click", async () => {
    if (!(await confirmBox({ title: `암기 카드 ${nAi}장을 만들까요?`, what: `학생 ${ai.length}명 · 질문 ${nAi}개 · 약 ${(nAi * CARD_WON).toLocaleString("ko-KR")}원 (Claude Sonnet 5.5)`,
      note: "질문·꼬리질문·드래그한 학생부 글 한 칸·지원 학과 이름만 AI 로 보내요. 학생 이름·학번은 보내지 않아요.", yes: "만들기" }))) return;
    $("#raMake", box).disabled = true;
    const run = $("#raCardRun", box);
    let done = 0, fail = 0, err = "";
    for (let i = 0; i < ai.length; i++) {
      if (run.isConnected) run.innerHTML = `<div class="ra-prog"><i style="width:${Math.round(i / ai.length * 100)}%"></i></div><div class="muted sm">만드는 중… ${i + 1} / ${ai.length}명 · 카드 ${done}장</div>`;
      const r = await makeCards(ai[i].no, ai[i].todo, { marks: ai[i].marks });
      done += r.done.length; fail += r.fail.length; if (r.error) err = r.error;
      if (r.error === "limited") break;
    }
    toast(`암기 카드 ${done}장을 만들었어요${fail ? ` · ${fail}장은 못 만들었어요` : ""}${err && err !== "timeout" && err !== "network" ? ` — ${cardErrText(err)}` : ""}`, fail ? "error" : undefined, 8000);
    adminCards(p, nos);
  });
}
