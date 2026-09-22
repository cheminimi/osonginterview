// 교사 화면 공통 상태·도우미
import {
  db, collection, getDocs, query, where, onSnapshot, $, $$, esc, toast, showError, STAGES, toDate, nextInterview, ddayBadge, fmtDay,
  cachedCollection, getMetaVersions, icon
} from "./common.js";

export const S = {
  ctx: null,
  students: [], staff: [], meetings: [], sessions: [], bank: [], interviews: [],
  bookings: [], needMine: [], blockLabel: () => "",
  renderers: {}
};

export function register(name, fn) { S.renderers[name] = fn; }
export function rerender(...names) {
  const list = names.length ? names : Object.keys(S.renderers);
  for (const n of list) { try { S.renderers[n]?.(); } catch (e) { showError(e, `화면 그리기(${n})`); } }
}

// 목록은 브라우저 캐시 우선(바뀐 목록만 서버에서), 질문은행은 질문은행 탭을 열 때, 연습 기록은 최근 것만 실시간 구독
export async function loadAll({ force = false, refreshMeta = false } = {}) {
  try {
    if (force || refreshMeta) await getMetaVersions(true);
    const [st, sf, mt, iv] = await Promise.all([
      cachedCollection("students", { force }), cachedCollection("staff", { force }),
      cachedCollection("meetings", { force }), cachedCollection("interviews", { force })
    ]);
    S.students = st.sort((a, b) => String(a.studentNo).localeCompare(String(b.studentNo), "ko", { numeric: true }));
    S.staff = sf.sort((a, b) => String(a.name).localeCompare(String(b.name), "ko"));
    S.meetings = mt.sort((a, b) => (b.date || "").localeCompare(a.date || ""));
    S.interviews = iv;
    attachInterviews();
    if (S.bankLoaded || force) await ensureBank(force);
  } catch (e) { showError(e, "데이터 불러오기"); }
  watchSubmissions();
  rerender();
}

// 질문은행은 필요할 때만
S.bankLoaded = false;
export async function ensureBank(force = false) {
  if (S.bankLoaded && !force) return S.bank;
  const qb = await cachedCollection("questions", { force });
  S.bank = qb.sort((a, b) => (a.createdAt?.seconds || 0) - (b.createdAt?.seconds || 0));
  S.bankLoaded = true;
  return S.bank;
}

// ---- 말하기 연습 기록
// 최근 RECENT_DAYS 일 안에 제출된 것만 실시간 구독 (연습 중 자동 저장은 읽기 비용 없음).
// 오래된 기록·미완료 연습은 필요할 때 loadAllSessions() 로 한 번에 불러온다.
export const RECENT_DAYS = 30;
S.sessionsScope = "recent";
S.sessionsReady = false;
let watching = false;
export function watchSubmissions() {
  if (watching) return;
  watching = true;
  let first = true;
  const cutoff = new Date(Date.now() - RECENT_DAYS * 86400000);
  onSnapshot(query(collection(db, "sessions"), where("submittedAt", ">=", cutoff)), (snap) => {
    const fresh = [];
    snap.docChanges().forEach((ch) => {
      if (ch.type === "removed") return;
      const d = { id: ch.doc.id, ...ch.doc.data() };
      const i = S.sessions.findIndex((x) => x.id === d.id);
      if (!first && (i < 0 || S.sessions[i].status !== "submitted")) fresh.push(d);
      if (i >= 0) S.sessions[i] = d; else S.sessions.push(d);
    });
    S.sessions.sort((a, b) => (b.submittedAt?.seconds || b.startedAt?.seconds || 0) - (a.submittedAt?.seconds || a.startedAt?.seconds || 0));
    if (fresh.length) toast(fresh.length === 1 ? `새 연습 제출: ${fresh[0].studentName} (${fresh[0].modeLabel || "말하기 연습"})` : `새 연습 제출 ${fresh.length}건`, "ok", 5000);
    first = false;
    S.sessionsReady = true;
    rerender("review", "home", "students");
  }, (e) => console.warn("연습 제출 실시간 반영 중단", e));
}
export async function loadAllSessions() {
  const snap = await getDocs(collection(db, "sessions"));
  const byId = new Map(S.sessions.map((x) => [x.id, x]));
  snap.docs.forEach((d) => byId.set(d.id, { id: d.id, ...d.data() }));
  S.sessions = [...byId.values()].sort((a, b) => (b.submittedAt?.seconds || b.startedAt?.seconds || 0) - (a.submittedAt?.seconds || a.startedAt?.seconds || 0));
  S.sessionsScope = "all";
  rerender("review", "home", "students");
}

// 학생마다 universities(= interviews 날짜순)를 붙인다. 화면들은 st.universities 를 읽는다.
export function attachInterviews() {
  const by = {};
  for (const iv of S.interviews) (by[iv.studentNo] ||= []).push(iv);
  for (const st of S.students) {
    st.universities = (by[st.studentNo] || []).sort((a, b) => (a.date || "9999").localeCompare(b.date || "9999"));
  }
}

// ---- 내 이름 (배정표의 교사명과 맞춰 '내 담당'을 찾음)
export function myName() {
  if (S.ctx?.profile?.name) return S.ctx.profile.name;
  try { return localStorage.getItem("myStaffName") || ""; } catch (_) { return ""; }
}
export function myRoles(st, name = myName()) {
  if (!name) return [];
  const a = st.assign || {}, out = [];
  if (a.s1 === name) out.push("1차");
  if (a.s2 === name) out.push("2차");
  if (a.s3a === name || a.s3b === name) out.push("3차");
  return out;
}
export const studentByNo = (no) => S.students.find((s) => s.studentNo === no);

// 대면 기록 진행 칩: 1차 ✓ 2차 · 3차 ·
export function stageChips(st) {
  const done = new Set(S.meetings.filter((m) => m.studentNo === st.studentNo && !m.planned).map((m) => m.stage));
  return STAGES.slice(0, 3).map((s) =>
    `<span class="chip ${done.has(s.key) ? "chip-on" : ""}" title="${s.label}">${s.key}차${done.has(s.key) ? "✓" : ""}</span>`).join("");
}
export function nextBadge(st) {
  const d = nextInterview(st);
  return d ? `${ddayBadge(d)} <span class="muted">${fmtDay(d)}</span>` : '<span class="muted">-</span>';
}

// ---- 모달
export function openModal(title, html, wide = false) {
  $("#mTitle").textContent = title;
  $("#mBody").innerHTML = html;
  $("#modal .modal").style.maxWidth = wide ? "980px" : "760px";
  $("#modal").hidden = false;
  $("#modal").scrollTop = 0;
  return $("#mBody");
}
export const closeModal = () => { $("#modal").hidden = true; };

// ---- 탭 4개 (오늘·학생·일정·질문) + 그 아래 딸린 화면들
export const TOP_TABS = [
  { key: "home", label: "오늘", ic: "home", dot: "todayDot" },
  { key: "students", label: "학생", ic: "users" },
  { key: "schedule", label: "일정", ic: "calendar", dot: "scDot" },
  { key: "questions", label: "질문", ic: "note" }
];
// 탭에 없는 화면은 어느 탭에 딸린 것으로 볼지 + 위에 뜨는 되돌아가기 줄
const SUB = {
  bank: { parent: "questions", title: "" },
  meetings: { parent: "students", title: "대면 기록 전체", back: "students", backLabel: "학생" },
  review: { parent: "home", title: "연습 리뷰", back: "home", backLabel: "오늘" },
  admin: { parent: null, title: "앱 관리", back: "home", backLabel: "오늘" }
};
export function mountTabs() {
  const bar = $("#tabs");
  if (!bar) return;
  bar.innerHTML = TOP_TABS.map((t, i) => `<button type="button" class="${i ? "" : "active"}" data-tab="${t.key}">
    ${icon(t.ic, 22)}<span>${t.label}</span>${t.dot ? `<span class="tb-dot" id="${t.dot}"></span>` : ""}</button>`).join("");
  bar.hidden = false;
  $$("#tabs button, #qSub button").forEach((b) => b.onclick = () => switchTab(b.dataset.tab));
}
export function setDot(sel, n) { const el = $(sel); if (el) el.textContent = n ? String(n) : ""; }

export function switchTab(tab) {
  const sub = SUB[tab];
  const top = sub ? sub.parent : tab;
  $$("#tabs button").forEach((x) => x.classList.toggle("active", x.dataset.tab === top));
  $$("[data-panel]").forEach((p) => p.hidden = p.dataset.panel !== tab);
  const qs = $("#qSub");
  if (qs) {
    qs.hidden = !(tab === "questions" || tab === "bank");
    $$("#qSub button").forEach((b) => b.classList.toggle("active", b.dataset.tab === tab));
  }
  const bar = $("#subBar");
  if (bar) {
    bar.hidden = !(sub && sub.title);
    if (sub && sub.title) {
      bar.innerHTML = `<button type="button" class="btn-sm btn-back" id="subBack">${icon("back", 18)} ${esc(sub.backLabel)}</button><h2 style="margin:0">${esc(sub.title)}</h2>`;
      $("#subBack", bar).onclick = () => switchTab(sub.back);
    }
  }
  try { sessionStorage.setItem("teacherTab", tab); } catch (_) {}
  window.scrollTo({ top: 0, behavior: "instant" });
}

export const readForm = (root) => Object.fromEntries($$("input[name],select[name],textarea[name]", root)
  .map((el) => [el.name, el.type === "checkbox" ? el.checked : el.value.trim()]));
export const lines = (s) => String(s || "").split("\n").map((x) => x.trim()).filter(Boolean);
export const opt = (list, sel = "", blank = "") =>
  (blank ? `<option value="">${esc(blank)}</option>` : "") + list.map((v) => {
    const [val, label] = Array.isArray(v) ? v : [v, v];
    return `<option value="${esc(val)}" ${String(val) === String(sel) ? "selected" : ""}>${esc(label)}</option>`;
  }).join("");

export function studentOptions(sel = "") {
  return opt(S.students.map((s) => [s.studentNo, `${s.studentNo} ${s.name}`]), sel, "— 학생 선택 —");
}
export const byDateDesc = (a, b) => (toDate(b.date) || 0) - (toDate(a.date) || 0);
