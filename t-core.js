// 교사 화면 공통 상태·도우미
import {
  db, collection, getDocs, $, $$, esc, showError, STAGES, toDate, nextInterview, ddayBadge, fmtDay
} from "./common.js";

export const S = {
  ctx: null,
  students: [], staff: [], meetings: [], sessions: [], bank: [], interviews: [],
  renderers: {}
};

export function register(name, fn) { S.renderers[name] = fn; }
export function rerender(...names) {
  const list = names.length ? names : Object.keys(S.renderers);
  for (const n of list) { try { S.renderers[n]?.(); } catch (e) { showError(e, `화면 그리기(${n})`); } }
}

export async function loadAll() {
  try {
    const [st, sf, mt, ss, qb, iv] = await Promise.all([
      getDocs(collection(db, "students")), getDocs(collection(db, "staff")),
      getDocs(collection(db, "meetings")), getDocs(collection(db, "sessions")), getDocs(collection(db, "questions")),
      getDocs(collection(db, "interviews"))
    ]);
    const rows = (s) => s.docs.map((d) => ({ id: d.id, ...d.data() }));
    S.students = rows(st).sort((a, b) => String(a.studentNo).localeCompare(String(b.studentNo), "ko", { numeric: true }));
    S.staff = rows(sf).sort((a, b) => String(a.name).localeCompare(String(b.name), "ko"));
    S.meetings = rows(mt).sort((a, b) => (b.date || "").localeCompare(a.date || ""));
    S.sessions = rows(ss).sort((a, b) => (b.startedAt?.seconds || 0) - (a.startedAt?.seconds || 0));
    S.bank = rows(qb).sort((a, b) => (a.createdAt?.seconds || 0) - (b.createdAt?.seconds || 0));
    S.interviews = rows(iv);
    attachInterviews();
  } catch (e) { showError(e, "데이터 불러오기"); }
  rerender();
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

export function switchTab(tab) {
  $$(".tabs:not(.sub) > button").forEach((x) => x.classList.toggle("active", x.dataset.tab === tab));
  $$("[data-panel]").forEach((p) => p.hidden = p.dataset.panel !== tab);
  try { sessionStorage.setItem("teacherTab", tab); } catch (_) {}
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
