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
      return { text: t.replace(/\s+/g, " ").trim(), x: l.items[0].x, right: end };
    }).filter((l) => l.text) });
    pg.cleanup?.();
  }
  await pdf.destroy?.();
  return pages;
}

const SECTION_RE = [
  [/^(\d+\s*[.．]\s*)?(인적\s*[·ㆍ.]?\s*학적\s*사항|인적\s*사항|학적\s*사항)/, "drop", "인적·학적사항"],
  [/^(\d+\s*[.．]\s*)?출결\s*상황/, "attend"],
  [/^(\d+\s*[.．]\s*)?수상\s*경력/, "drop", "수상경력"],
  [/^(\d+\s*[.．]\s*)?자격증/, "drop", "자격증"],
  [/^(\d+\s*[.．]\s*)?창의적\s*체험\s*활동\s*상황/, "creative"],
  [/^(\d+\s*[.．]\s*)?교과\s*학습\s*발달\s*상황/, "subject"],
  [/^(\d+\s*[.．]\s*)?독서\s*활동\s*상황/, "drop", "독서활동상황"],
  [/^(\d+\s*[.．]\s*)?행동\s*특성\s*및\s*종합\s*의견/, "behavior"],
  [/^(\d+\s*[.．]\s*)?봉사\s*활동\s*실적/, "drop", "봉사활동실적"]
];
const PII_RE = /\d{6}\s*-\s*[1-4*]\s*[\d*]{6}|주\s*소\s*[:：]?|보\s*호\s*자|(성\s*명[\s\S]{0,40}성\s*별)/;
const TABLE_HEAD = /^(학년|영역|시간|특기\s*사항|학년\s*영역|구분|과\s*목|세부\s*능력\s*및\s*특기\s*사항|수업\s*일수|결석\s*일수|지각|조퇴|결과|비고|학기|단위수|원점수|석차등급|성취도)(\s|$)/;
const NOISE = /^[-–]?\s*\d+\s*[-–]?$|^\d+\s*\/\s*\d+$|출력|발급|페이지|쪽\s*\d/;

// 쪽 → 구역·칸 (나이스 '학교생활기록부' PDF 꼴을 기준으로 한 추정 — 섞인 칸은 선생님이 고침)
export function splitRecord(pages, { withGrades = false } = {}) {
  const info = { read: pages.length, kept: 0, dropped: [], headerLines: 0 };
  // 머리말·꼬리말: 여러 쪽의 위·아래 3줄에 되풀이되는 줄 (숫자는 같게 봄)
  const norm = (t) => t.replace(/\d+/g, "#");
  const freq = new Map();
  pages.forEach((p) => { const edge = [...p.lines.slice(0, 3), ...p.lines.slice(-3)]; new Set(edge.map((l) => norm(l.text))).forEach((k) => freq.set(k, (freq.get(k) || 0) + 1)); });
  const rep = pages.length >= 2 ? Math.max(2, Math.ceil(pages.length / 2)) : 99;
  const secs = {};
  let cur = null, sub = null, grade = "";
  const row = () => secs[cur]?.rows.at(-1);
  const push = (label, text, l) => { (secs[cur] ||= { key: cur, title: SEC_TITLE[cur], rows: [] }).rows.push({ label, text: text || "", _r: l?.right || 0 }); };
  for (const p of pages) {
    const all = p.lines.map((l) => l.text).join("\n");
    if (PII_RE.test(all)) { info.dropped.push({ page: p.n, why: "인적사항(주민등록번호·주소·보호자·성명/성별)이 있는 쪽" }); continue; }
    info.kept++;
    const maxR = Math.max(...p.lines.map((l) => l.right || 0));
    p.lines.forEach((l, i) => {
      const edge = i < 3 || i >= p.lines.length - 3;
      if (edge && ((freq.get(norm(l.text)) || 0) >= rep || NOISE.test(l.text))) { info.headerLines++; return; }
      const hit = SECTION_RE.find(([re]) => re.test(l.text));
      if (hit) {
        if (hit[1] === "drop") { cur = "drop"; if (!info.dropped.some((d) => d.why === hit[2] + " (구역)")) info.dropped.push({ page: p.n, why: hit[2] + " (구역)" }); }
        else { cur = hit[1]; sub = cur === "subject" ? "grades" : null; grade = ""; }
        return;
      }
      if (!cur || cur === "drop") return;
      let t = l.text;
      if (cur === "subject" && /세부\s*능력\s*및\s*특기\s*사항/.test(t) && t.length < 40) { sub = "seteuk"; return; }
      if (TABLE_HEAD.test(t) && t.length < 40) return;
      const g = t.match(/^\[?\(?([1-3])\s*학년\)?\]?\s*/) || t.match(/^([1-3])\s+(?=\S)/);
      if (cur === "creative") {
        const m = t.replace(/^([1-3])\s+/, (x, d) => { grade = d; return ""; }).match(/^(자율\s*[·ㆍ]?\s*자치\s*활동|자율\s*활동|동아리\s*활동|진로\s*활동|봉사\s*활동)\s*(\d+\s*)?(.*)$/);
        if (m) {
          const name = m[1].replace(/\s+/g, "");
          if (name.startsWith("봉사")) { push("__skip", "", l); return; }
          push(`${grade ? grade + "학년 " : ""}${name}`, m[3], l); return;
        }
      } else if (cur === "subject") {
        if (sub === "grades") { if (!withGrades) return; const keep = cur; cur = "grades"; push("", t, l); cur = keep; return; }
        if (g) { grade = g[1]; t = t.slice(g[0].length); }
        const m = t.match(/^((?:\(\d학기\))?\s*[가-힣A-Za-z0-9ⅠⅡⅢⅣ·\s()]{1,24}?)\s*[:：]\s*(.*)$/);
        if (m) { push(`${grade ? grade + "학년 " : ""}${m[1].trim()}`, m[2], l); return; }
      } else if (cur === "attend" || cur === "behavior") {
        if (g) { push(`${g[1]}학년`, t.slice(g[0].length), l); return; }
      }
      const r = row();
      if (!r) { push("", t, l); return; }
      if (r.label === "__skip") return;
      // 줄바꿈 이어 붙이기: 앞 줄이 오른쪽 끝까지 찼으면 낱말 중간에서 끊긴 것
      const glue = r._r >= maxR - 15 && isHangul(r.text.slice(-1)) && isHangul(t[0]) ? "" : " ";
      r.text = (r.text ? r.text + glue : "") + t; r._r = l.right || 0;
    });
  }
  const order = ["attend", "creative", "subject", "behavior", "grades"];
  const sections = order.filter((k) => secs[k]).map((k) => ({ key: k, title: SEC_TITLE[k], rows: secs[k].rows.filter((r) => r.label !== "__skip" && (r.text || "").trim()).map((r) => ({ label: r.label, text: r.text.trim() })) }))
    .filter((s) => s.rows.length);
  return { sections, info };
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
  const { sections, info } = splitRecord(upState.pages, { withGrades: upState.withGrades });
  upState.info = info;
  const dropPages = new Set(info.dropped.filter((d) => /쪽/.test(d.why)).map((d) => d.page));
  body().innerHTML = `<div class="ru-card"><h3>쪽 확인</h3>
    <div class="ru-pages">${upState.pages.map((p) => { const d = info.dropped.find((x) => x.page === p.n && /쪽/.test(x.why)); return `<span class="ru-pg ${d ? "drop" : "keep"}" title="${esc(d?.why || "남김")}">${p.n}쪽 ${d ? "버림" : "남김"}${d ? `<small>${esc(d.why)}</small>` : ""}</span>`; }).join("")}</div>
    <ul class="ru-info">
      <li>남긴 구역: ${sections.filter((s) => s.key !== "grades").map((s) => esc(SEC_SHORT[s.key])).join(" · ") || '<b style="color:var(--danger)">없음</b>'}</li>
      <li>버린 구역: ${[...new Set(info.dropped.filter((d) => /구역/.test(d.why)).map((d) => d.why.replace(" (구역)", "")))].map(esc).join(" · ") || "없음"}${dropPages.size ? ` · 인적사항 쪽 ${dropPages.size}개` : ""}</li>
      <li>지운 머리말·꼬리말 줄: ${info.headerLines}줄</li>
    </ul>
    <label class="inline-check"><input type="checkbox" id="ruGrades" ${upState.withGrades ? "checked" : ""}> 성적(원점수·등급) 표도 넣기 <span class="muted sm">(기본은 빼요)</span></label>
    <div class="row" style="margin-top:12px"><button type="button" class="btn-sm" id="ruBack">다른 파일</button><div class="spacer"></div>
      <button type="button" class="btn-primary" id="ruNext3" ${sections.length ? "" : "disabled"}>가림 확인으로</button></div></div>`;
  $("#ruGrades").onchange = (e) => { upState.withGrades = e.target.checked; stepPages(); };
  $("#ruBack").onclick = () => { upState.pages = null; stepPick(); };
  $("#ruNext3").onclick = () => {
    const names = namesList(upState.no);
    upState.sections = sections.map((s) => ({ ...s, rows: s.rows.map((r) => ({ label: r.label, text: r.text, masks: autoMasks(r.text, names) })) }));
    upState.pages = null;   // 쪽 글은 여기서 버림
    stepMask();
  };
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
    <p class="muted">다른 사람 이름·학교 이름·전화·메일은 자동으로 가렸어요(학생 본인 이름은 그대로). 글을 <b>드래그</b>해 [가리기], 가린 곳을 누르면 [풀기]. 표가 쪽을 넘어가 섞인 칸은 [고치기]로 글을 직접 고쳐요.</p>
    <details class="ru-autos" open><summary>자동으로 가린 곳 <b>${autos.length}</b>곳</summary>
      <div>${autos.map((a, k) => `<button type="button" class="chip" data-goto="${a.si}:${a.ri}:${a.mi}">${k + 1}. ${esc(a.m.kind === "name" ? "이름" : a.m.kind === "school" ? "학교" : a.m.kind === "phone" ? "전화" : "메일")} · ${esc(S3[a.si].rows[a.ri].text.slice(a.m.start, a.m.end))}</button>`).join(" ") || '<span class="muted sm">없음</span>'}</div></details>
    <div class="ru-doc" id="ruDoc">${S3.map((s, si) => `<h4>${esc(s.title)}</h4><table>${s.rows.map((r, ri) => `<tr><th>${esc(r.label || "")}</th><td>${rowHtml(s, si, r, ri)}
      ${r.editing ? "" : `<button type="button" class="ru-fix" data-fix="${si}:${ri}">고치기</button>`}</td></tr>`).join("")}</table>`).join("")}</div>
    <div class="ru-pop" id="ruPop" hidden><button type="button" id="ruMask">가리기</button></div>
    <div class="row" style="margin-top:12px"><button type="button" class="btn-sm" id="ruBack4">쪽 확인으로</button><div class="spacer"></div>
      <button type="button" class="btn-primary" id="ruSave">이대로 저장</button></div></div>`;
  const doc0 = $("#ruDoc");
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
    const rec = { studentNo: no, sections, pages: { read: upState.info.read, kept: upState.info.kept, dropped: upState.info.dropped }, ver,
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
    flt: "all", otherHl: true, idle: null, tick: null, t0: 0, run: false, used: 0, off: [], sel: null };
  log(no, "open");
  const me = myName() || S.ctx.user.email;
  const ov = document.createElement("div");
  ov.id = "recView"; ov.className = "rec-ov rv";
  const wm = `<svg xmlns='http://www.w3.org/2000/svg' width='320' height='180'><text x='10' y='100' transform='rotate(-24 160 90)' font-size='15' fill='rgba(30,40,60,0.09)' font-family='sans-serif'>${esc(me)} · ${new Date().toLocaleString("ko-KR")}</text></svg>`;
  const iv = (st.universities || []).filter((u) => u.announceResult !== "fail").map((u) => u.dept).filter(Boolean).slice(0, 2).join(", ");
  ov.innerHTML = `<div class="rv-wm" style="background-image:url(&quot;data:image/svg+xml;utf8,${encodeURIComponent(wm)}&quot;)"></div>
    <div class="rv-hd"><b>${esc(no)} ${esc(st.name)}</b><span class="rv-stage">${[1, 2, 3].map((k) => `<button type="button" data-stage="${k}" class="${V.stage === k ? "on" : ""} c${k}">${k}차</button>`).join("")}</span>
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
    pop.style.left = `${Math.min(window.innerWidth - 180, Math.max(8, r.left + r.width / 2 - 90))}px`; pop.style.top = `${Math.max(8, r.top - 46)}px`; pop.hidden = false;
  }, 0);
  docEl.addEventListener("mouseup", showPop);
  docEl.addEventListener("touchend", showPop);
  on(document, "selectionchange", () => { if (V && getSelection().isCollapsed) setTimeout(() => { if (V && getSelection().isCollapsed) pop.hidden = true; }, 200); });
  $("#rvHl", ov).onclick = () => { pop.hidden = true; addMark("hl"); };
  $("#rvQ", ov).onclick = () => { pop.hidden = true; questionForm(); };
  docEl.addEventListener("click", (e) => { const mk = e.target.closest("mark[data-mk]"); if (mk) focusQuestion(mk.dataset.mk); });
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
  el.innerHTML = V.rec.sections.map((s) => `<h3 id="rvs-${s.key}">${esc(s.title)}</h3><table>${s.rows.map((r, ri) => {
    const ms = V.marks.filter((m) => (V.otherHl || mine(m))).map((m) => ({ ...m, ...placeOf(m, s.key, ri, r.text) })).filter((m) => m.ok);
    return `<tr><th>${esc(r.label || "")}</th><td class="rv-cell" data-sec="${s.key}" data-row="${ri}">${paint(r.text, ms)}</td></tr>`;
  }).join("")}</table>`).join("") + `<p class="muted sm">대입에 쓰는 항목만 넣었어요 (인적사항·수상·자격증·봉사·독서 없음) · ${V.rec.ver || 1}번째 판</p>`;
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
