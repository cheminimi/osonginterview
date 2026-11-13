// 지도 일지 (2026-11-12) — 교사 화면 '지도 일지' + 관리 ⑩
// 실제 면접 일정(bookings·meetings·availability)과 완전히 따로 돈다: 그 목록은 읽지도 쓰지도 않는다 (사용자 결정 2026-11-12)
//  선생님: 불가시간(초과근무와 겹치는 시간 등) 입력 → [입력 완료] → 공개되면 내 지도 일정·지도 일지(hwpx) 내려받기
//  관리자: 제출 현황 → 설정 → [시간 배정](담당교사 그대로, 허용 시간대 안 무작위) → 검사 → [AI 내용 작성] → [공개]
// 데이터: config/guidance · guidanceUnavail/{staffId}(날짜별 불가 30분 칸) · guidanceSubmit/{staffId} · guidanceRuns/{id} · guidanceNotes/{학번} · guidancePlan/{staffId}
import {
  db, collection, doc, getDoc, getDocs, setDoc, writeBatch,
  $, $$, esc, toast, showError, confirmBox, aiCall, univName, announceFailed
} from "./common.js";
import { S, register, switchTab, myName, openModal, closeModal } from "./t-core.js";
import { run as runEngine, rowOrder } from "./guidance-engine.js";
import { checkRows, targets, actuals, weekly, pagesOf, CHECK_LABELS, dayLabel } from "./guidance-check.js";
import { loadTemplate, buildHwpx, zipStore, ROUND_HEAD } from "./guidance-hwpx.js";
import { mountCal, cleanDays, countOf, rangesOf, toUnavailRows, dayLab, end30 } from "./guidance-cal.js";

export const DEFAULT_CFG = {
  periodStart: "2026-09-21", periodEnd: "2026-12-16", earlyStart: "2026-09-14",
  excluded: ["2026-09-24", "2026-09-25", "2026-09-26", "2026-10-05", "2026-10-09", "2026-11-19"],
  weeklyMax: 3, dailyMax: 2, prepDays: 14, prepDaysSpecial: 21, early: {}, collecting: true
};
const ROUNDS = ["1차", "2차", "3차"];
const okName = (x) => !!x && x !== "미정" && x !== "-";
const today = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };
const fmtMs = (ms) => { if (!ms) return "-"; const d = new Date(ms); return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`; };

export async function loadCfg() {
  const s = await getDoc(doc(db, "config", "guidance"));
  return { ...DEFAULT_CFG, ...(s.exists() ? s.data() : {}) };
}

// ---------- 화면 모양 (이 모듈 안에만. body.nd 아래 .gd-) ----------
function injectStyle() {
  if (document.getElementById("gdStyle")) return;
  const st = document.createElement("style");
  st.id = "gdStyle";
  st.textContent = `
body.nd .gd{display:grid;gap:14px;min-width:0}
body.nd .gd .card{min-width:0}
body.nd .gd h3{margin:0 0 6px}
body.nd .gd-lead{margin:0;line-height:1.6}
body.nd .gd-list{list-style:none;margin:8px 0 0;padding:0;display:grid;gap:6px}
body.nd .gd-list li{display:flex;gap:8px;align-items:center;flex-wrap:wrap;padding:8px 10px;border:1px solid var(--line,#e5e7eb);border-radius:10px;min-width:0}
body.nd .gd-list li .w{font-weight:700}
body.nd .gd-list li .m{flex:1 1 140px;min-width:0;color:var(--muted,#6b7280);overflow-wrap:anywhere}
body.nd .gd-f{display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:8px;margin-top:10px;align-items:end}
body.nd .gd-f label{display:grid;gap:4px;font-size:13px;min-width:0}
body.nd .gd-f input,body.nd .gd-f select{width:100%;min-width:0;max-width:100%;box-sizing:border-box}
body.nd .gd-f input[type=date]{display:block;-webkit-appearance:none;appearance:none;min-height:38px}
body.nd .gd-f .wide{grid-column:1/-1}
body.nd .gd-done{display:flex;gap:12px;align-items:center;width:100%;text-align:left;padding:12px 14px;border-radius:12px;border:2px solid var(--line,#d1d5db);background:none;cursor:pointer;font:inherit}
body.nd .gd-done i{flex:none;width:26px;height:26px;border-radius:50%;border:2px solid currentColor;display:grid;place-items:center;font-style:normal;font-weight:800}
body.nd .gd-done.on{border-color:#16a34a;color:#15803d;background:rgba(22,163,74,.07)}
body.nd .gd-sum{display:flex;gap:8px;flex-wrap:wrap;margin:6px 0 10px}
body.nd .gd-sum span{padding:4px 10px;border-radius:999px;background:var(--soft,#f3f4f6);font-size:13px}
body.nd .gd-warn{color:#b45309}
body.nd .gd-bad{color:#b91c1c;font-weight:700}
body.nd .gd-ok{color:#15803d;font-weight:700}
body.nd .gd table td.n,body.nd .gd table th.n{text-align:right}
body.nd .gd-row{display:flex;gap:8px;flex-wrap:wrap;align-items:center}
body.nd .gd-past{opacity:.55}
body.nd .gd textarea{width:100%;box-sizing:border-box;min-height:70px}
body.nd .gd-prog{height:8px;border-radius:99px;background:var(--soft,#eee);overflow:hidden;margin:8px 0}
body.nd .gd-prog b{display:block;height:100%;background:#2563eb;width:0}
body.nd .gd-pill{padding:4px 10px;border-radius:99px;background:var(--soft,#f3f4f6);font-size:13px}
body.nd .gd-pill.o{background:#ffedd5;color:#9a3412}
body.nd .gd-list.gd-un li{display:grid;grid-template-columns:minmax(0,1fr) auto auto;gap:6px 8px}
body.nd .gd-list.gd-un li .t{min-width:0}
body.nd .gd-list.gd-un li .t small{display:block;font-weight:400;color:var(--ink-2,#4b5160);font-size:13px}
`;
  document.head.appendChild(st);
}

// ================= 선생님 화면 =================
let root, G = { cfg: null, days: {}, submit: null, plan: null, who: null, loading: false, cal: null, saveT: null, saving: null, showList: false };
export function init(el) {
  root = el;
  injectStyle();
  S.onShow.guidance = () => loadMine();
  register("guidance", () => { if (!root.hidden) drawMine(); });
  homeTip();
}
// (2026-11-13) 지도 일지 알림은 이름 메뉴에서만 — 탭 위 안내 줄은 없앰 (일정 등 다른 탭과 헷갈림)
// · 이름 메뉴 '지도 일지' 설명 글이 상황에 맞게 바뀜 (menuDesc, teacher.html 메뉴 항목이 메뉴를 열 때 읽음)
// · 할 일이 있을 때만 이름 버튼에 점: 불가시간 입력 기간인데 [입력 완료] 전 / 지도 일지 공개 뒤 아직 이 기기에서 안 열어 봄
// 선생님 계정만, 앱을 열 때 2건 읽기 (예전 안내 줄과 같음)
export const MENU_DESC0 = "불가시간 입력 · 내 지도 일지 내려받기";
let tipState = "";   // "" | "input" | "inputDone" | "published"
export function menuDesc() {
  return tipState === "published" ? "지도 일지가 나왔어요 · 내 지도 일정 확인·내려받기"
    : tipState === "input" ? "불가시간을 넣고 [입력 완료]를 눌러 주세요"
    : tipState === "inputDone" ? "입력 완료 · 시간 배정을 기다리는 중이에요"
    : MENU_DESC0;
}
const seenKey = (runId) => `gdSeen:${runId}`;
function seenPublished() { try { return !!G.cfg?.publishedRunId && localStorage.getItem(seenKey(G.cfg.publishedRunId)) === "1"; } catch (_) { return false; } }
export function setMenuDot() {   // teacher.html mountMenu 가 이름 버튼을 다시 그린 뒤에도 부름
  const on = tipState === "input" || (tipState === "published" && !seenPublished());
  ["acctBtn", "railMe"].forEach((id) => document.getElementById(id)?.classList.toggle("gd-dot", on));
}
async function homeTip() {
  const key = S.ctx.account?.key;
  if (!key || S.ctx.account?.role === "student") return;
  try {
    const [cfg, sub] = await Promise.all([loadCfg(), getDoc(doc(db, "guidanceSubmit", key))]);
    G.cfg = cfg;
    const done = sub.exists() && sub.data().done;
    tipState = cfg.publishedRunId ? "published" : cfg.collecting ? (done ? "inputDone" : "input") : "";
    setMenuDot();
  } catch (_) { /* 규칙 배포 전이면 조용히 */ }
}
// 지도 일지 화면을 열면 '공개됨' 점은 끔 (이 기기에 기억)
function markSeen() {
  if (!G.cfg?.publishedRunId) return;
  try { localStorage.setItem(seenKey(G.cfg.publishedRunId), "1"); } catch (_) { /* 저장 못 해도 다음에 다시 점이 뜰 뿐 */ }
  setMenuDot();
}

function whoAmI() {
  const key = S.ctx.account?.key;
  if (key) { const st = S.staff.find((t) => t.id === key); return { id: key, name: st?.name || myName() }; }
  return G.who;   // 이름 없는 관리자: 고른 선생님 대신 입력
}
async function loadMine() {
  if (G.loading) return;
  injectStyle();
  const me = whoAmI();
  G.loading = true;
  root.innerHTML = `<div class="gd"><div class="card"><div class="muted">불러오는 중…</div></div></div>`;
  try {
    G.cfg = await loadCfg();
    if (me) {
      const [un, sub, plan] = await Promise.all([
        getDoc(doc(db, "guidanceUnavail", me.id)),
        getDoc(doc(db, "guidanceSubmit", me.id)),
        G.cfg.publishedRunId ? getDoc(doc(db, "guidancePlan", me.id)) : Promise.resolve(null)
      ]);
      G.days = cleanDays(un.exists() ? un.data().days : {});
      G.submit = sub.exists() ? sub.data() : null;
      G.plan = plan?.exists() ? plan.data() : null;
    }
  } catch (e) { showError(e, "지도 일지 불러오기"); }
  finally { G.loading = false; }
  drawMine();
  if (S.ctx.account?.key) markSeen();
}

function drawMine() {
  if (!root || !G.cfg) return;
  const me = whoAmI(), cfg = G.cfg;
  const pick = !S.ctx.account?.key ? `<div class="card"><label class="gd-row">대신 입력할 선생님
      <select id="gdWho" style="width:auto"><option value="">— 선택 —</option>${S.staff.map((t) => `<option value="${esc(t.id)}" ${me?.id === t.id ? "selected" : ""}>${esc(t.name)}</option>`).join("")}</select></label>
      <p class="muted" style="margin:6px 0 0">관리자 이메일로 로그인했어요. 전체 현황은 앱 관리 → ⑩ 지도 일지에서 봐요.</p></div>` : "";
  const intro = `<div class="card"><h3>지도 일지</h3>
    <p class="gd-lead">교사 수당 지급 서류(모의면접 결과 보고서)를 위한 지도 시간 배정이에요. <b>실제로 잡는 모의면접 일정과는 따로</b> 운영돼요.</p>
    <p class="gd-lead muted">지도기간 ${esc(dayLabel(cfg.periodStart))} ~ ${esc(dayLabel(cfg.periodEnd))} · 지도는 30분 칸 단위 · 평일 방과후 16:30~18:00 · 야자 19:00~21:30 · 주말 09:00~16:30</p></div>`;
  if (!me) { root.innerHTML = `<div class="gd">${pick}${intro}</div>`; bindWho(); return; }
  root.innerHTML = `<div class="gd">${pick}${intro}${G.plan ? planHtml(me) : ""}${unavailHtml()}${submitHtml()}</div>`;
  bindWho();
  bindUnavail(me);
  bindSubmit(me);
  $("#gdDown", root)?.addEventListener("click", () => downloadMine(me));
}
function bindWho() {
  $("#gdWho", root)?.addEventListener("change", (e) => {
    const t = S.staff.find((x) => x.id === e.target.value);
    G.who = t ? { id: t.id, name: t.name } : null;
    loadMine();
  });
}

function planHtml(me) {
  const rows = (G.plan.rows || []).slice().sort(rowOrder);
  const a = actuals(rows.map((r) => ({ ...r, teacher: me.name })))[me.name] || { r1: 0, r2: 0, r3: 0, min: 0 };
  const t = today();
  const pages = pagesOf(rows);
  return `<div class="card"><h3>내 지도 일정 <span class="muted" style="font-weight:400;font-size:14px">공개 ${esc(fmtMs(G.plan.publishedAtMs))}</span></h3>
    <div class="gd-sum"><span>1차 ${a.r1}회</span><span>2차 ${a.r2}회</span><span>3차 ${a.r3}회</span><span>총 ${a.min}분 (${(a.min / 60).toFixed(1)}시간)</span><span>지도 일지 ${pages.length}장</span></div>
    <button type="button" class="btn-primary" id="gdDown">지도 일지 내려받기 (한글 hwpx)</button>
    <ul class="gd-list">${rows.map((r) => `<li class="${r.date < t ? "gd-past" : ""}"><span class="w">${esc(dayLabel(r.date))} ${esc(r.start)}~${esc(r.end)}</span>
      <span>${esc(r.round)}${r.role ? " " + esc(r.role) : ""}</span><span class="m">${esc(r.studentNo)} ${esc(r.studentName || "")}${r.partner ? ` · 함께: ${esc(r.partner)}` : ""}</span></li>`).join("")}</ul></div>`;
}

function unavailHtml() {
  return `<div id="gdCal"></div><div class="card" id="gdSum">${sumHtml()}</div>`;
}
function sumHtml() {
  const c = countOf(G.days), rs = rangesOf(G.days), locked = !G.cfg.collecting && !S.ctx.isAdmin;
  return `<div class="gd-row"><h3 style="margin:0;flex:1">넣은 불가시간</h3><span class="gd-pill o" id="gdCnt">${c.days}일 · ${c.slots}칸</span><span class="muted" id="gdSaveSt"></span>
      <button type="button" class="btn-sm" id="gdListTg" aria-expanded="${!!G.showList}">${G.showList ? "접기" : "목록으로 보기"}</button></div>
    ${locked ? `<p class="gd-warn" style="margin:8px 0 0">입력 기간이 끝났어요. 고칠 것이 있으면 관리자에게 알려 주세요.</p>` : ""}
    ${G.showList ? (rs.length ? `<ul class="gd-list gd-un">${rs.map((r) => `<li><b class="t">${esc(dayLab(r.from))}${r.to !== r.from ? " ~ " + esc(dayLab(r.to)) : ""}<small>${esc(r.text)}</small></b>
      <button type="button" class="btn-sm" data-go="${esc(r.from)}">보기</button>${locked ? "" : `<button type="button" class="btn-sm btn-danger" data-delr="${esc(r.from)}|${esc(r.to)}">지우기</button>`}</li>`).join("")}</ul>` : `<p class="muted">아직 넣은 불가시간이 없어요.</p>`)
      : `<p class="muted" style="margin:8px 0 0">이어진 날을 묶어 한 줄로 보여 줘요 (예: 10/20 ~ 10/22 종일).</p>`}`;
}
function bindUnavail(me) {
  const locked = !G.cfg.collecting && !S.ctx.isAdmin;
  G.cal = mountCal($("#gdCal", root), { cfg: G.cfg, days: G.days, readOnly: locked, onChange: (days, changed) => {
    G.days = days;
    warnPlan(changed);
    if (G.submit?.done) G.submit = { ...G.submit, dirty: true };
    queueSave(me);
    drawSum(me);
  } });
  bindSum(me);
}
function drawSum(me) { const el = $("#gdSum", root); if (!el) return; const st = $("#gdSaveSt", root)?.textContent || ""; el.innerHTML = sumHtml(); $("#gdSaveSt", root).textContent = st; bindSum(me); }
function bindSum(me) {
  $("#gdListTg", root)?.addEventListener("click", () => { G.showList = !G.showList; drawSum(me); });
  $$("[data-go]", root).forEach((b) => b.onclick = () => { G.cal?.goto(b.dataset.go); $("#gdCal", root)?.scrollIntoView({ behavior: "smooth", block: "start" }); });
  $$("[data-delr]", root).forEach((b) => b.onclick = async () => {
    const [a, z] = b.dataset.delr.split("|");
    if (!(await confirmBox({ title: "불가시간 지우기", what: esc(`${dayLab(a)}${z !== a ? " ~ " + dayLab(z) : ""}`), yes: "지우기" }))) return;
    const days = { ...G.days }; Object.keys(days).forEach((d) => { if (d >= a && d <= z) delete days[d]; });
    G.days = days; G.cal?.set(days); queueSave(me); drawSum(me);
  });
}
// 이미 공개된 지도 일정과 겹치는 칸을 새로 끄면 알림
function warnPlan(changed) {
  const hit = (G.plan?.rows || []).filter((r) => changed.includes(r.date) && (G.days[r.date] || []).some((t) => t < r.end && end30(t) > r.start));
  if (hit.length) toast(`이미 공개된 지도 일정 ${hit.length}건과 겹쳐요. 관리자에게 알려 주세요.`, "error", 8000);
}
// 누를 때마다 바로 저장 (0.6초 모아서 한 번)
function queueSave(me) {
  clearTimeout(G.saveT);
  const st = $("#gdSaveSt", root); if (st) st.textContent = "저장 중…";
  G.saveT = setTimeout(() => saveDays(me), 600);
}
export function unavailDoc(me, days, uid) {
  return { staffId: me.id, staffName: me.name, days: cleanDays(days), updatedAtMs: Date.now(), byUid: uid };
}
async function saveDays(me) {
  clearTimeout(G.saveT); G.saveT = null;
  const p = setDoc(doc(db, "guidanceUnavail", me.id), unavailDoc(me, G.days, S.ctx.user.uid));
  G.saving = p;
  try { await p; const st = $("#gdSaveSt", root); if (st) st.textContent = "저장됨"; }
  catch (e) { showError(e, "불가시간 저장"); const st = $("#gdSaveSt", root); if (st) st.textContent = "저장 안 됨"; }
  finally { if (G.saving === p) G.saving = null; }
}
async function flushSave(me) { if (G.saveT) await saveDays(me); else if (G.saving) await G.saving.catch(() => {}); }

function submitHtml() {
  const on = !!G.submit?.done;
  return `<div class="card"><h3>입력 완료</h3>
    <button type="button" class="gd-done ${on ? "on" : ""}" id="gdDone" aria-pressed="${on}"><i>${on ? "✓" : ""}</i>
      <span>${on ? `<b>입력을 마쳤어요</b> · ${esc(fmtMs(G.submit.atMs))}<br><small>더 넣을 것이 생기면 넣으면 바로 저장돼요.</small>` : `<b>불가시간을 다 넣었으면 눌러 주세요</b><br><small>불가시간이 없어도 눌러야 배정을 시작할 수 있어요.</small>`}</span></button></div>`;
}
function bindSubmit(me) {
  $("#gdDone", root)?.addEventListener("click", async () => {
    const done = !G.submit?.done;
    await flushSave(me);
    const data = { done, atMs: Date.now(), name: me.name, count: countOf(G.days).slots };
    try { await setDoc(doc(db, "guidanceSubmit", me.id), data); G.submit = data; toast(done ? "입력 완료로 표시했어요." : "입력 완료를 풀었어요."); drawMine(); homeTip(); }
    catch (e) { showError(e, "입력 완료"); }
  });
}

async function downloadMine(me) {
  const btn = $("#gdDown", root); if (btn) btn.disabled = true;
  try {
    const p = G.plan;
    await saveHwpx(me.name, p.rows || [], (no) => p.students?.[no] || {}, (no, r) => p.notes?.[no]?.[r] || "");
  } catch (e) { showError(e, "지도 일지 만들기"); }
  finally { if (btn) btn.disabled = false; }
}

// ---------- 공통: 파일 만들기 · 내려받기 ----------
function saveBlob(name, data, type) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([data], { type }));
  a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}
async function hwpxBytes(teacher, rows, info, note) {
  const t = await loadTemplate();
  return buildHwpx(t, teacher, pagesOf(rows), info, note);
}
async function saveHwpx(teacher, rows, info, note) {
  if (!rows.length) return toast("지도 일정이 없어요.", "error");
  saveBlob(`지도 일지_${teacher}.hwpx`, await hwpxBytes(teacher, rows, info, note), "application/hwp+zip");
}

// 학생 한 명의 지원 정보 (면접 대학 모두 · 1차 불합격 뺌) — 지도 일지 '지원정보'·'면접유형' 칸
export function studentInfo(st) {
  const us = (st?.universities || []).filter((u) => !announceFailed(u));
  const univ = us.map((u) => [univName(u.univ) || u.univ, u.dept].filter(Boolean).join(" ")).filter(Boolean);
  const fm = [...new Set(us.map((u) => String(u.format || "").trim()).filter(Boolean))];
  return { univ: [...new Set(univ)].join(", "), type: fm.join(", ") || st?.track || "" };
}
// 엔진에 넣을 면접일: 1차 불합격 뺀 대학 면접일 중 가장 빠른 날, 없으면 최초 면접일
export function firstInterviewOf(st) {
  const ds = (st.universities || []).filter((u) => u.date && !announceFailed(u)).map((u) => String(u.date).slice(0, 10)).sort();
  if (ds.length) return ds[0];
  return (st.universities || []).some((u) => u.date) ? "" : String(st.firstInterview || "").slice(0, 10);
}
export function engineStudents(students, cfg) {
  return students.map((s, i) => {
    const a = s.assign || {};
    return { id: String(s.studentNo), name: s.name || "", interview: /^\d{4}-\d{2}-\d{2}$/.test(firstInterviewOf(s)) ? firstInterviewOf(s) : "",
      priority: s.priority || "", special: s.special || "", early: cfg.early?.[s.studentNo] || "",
      t1: a.s1 || "", t2: a.s2 || "", t3a: a.s3a || "", t3b: a.s3b || "", order: i };
  });
}

// ================= 관리 ⑩ =================
let A = { el: null, cfg: null, un: [], subs: {}, run: null, notes: {}, plans: [] };
export async function renderGuidanceAdmin(el) {
  injectStyle();
  A.el = el;
  el.innerHTML = `<div class="gd"><div class="card"><div class="muted">불러오는 중…</div></div></div>`;
  try {
    A.cfg = await loadCfg();
    const [un, sub, notes] = await Promise.all([getDocs(collection(db, "guidanceUnavail")), getDocs(collection(db, "guidanceSubmit")), getDocs(collection(db, "guidanceNotes"))]);
    A.un = un.docs.map((d) => ({ id: d.id, ...d.data() }));
    A.subs = Object.fromEntries(sub.docs.map((d) => [d.id, d.data()]));
    A.notes = Object.fromEntries(notes.docs.map((d) => [d.id, d.data().r || {}]));
    A.run = null;
    if (A.cfg.lastRunId) { const r = await getDoc(doc(db, "guidanceRuns", A.cfg.lastRunId)); if (r.exists()) A.run = { id: r.id, ...r.data() }; }
  } catch (e) { showError(e, "지도 일지 불러오기"); el.innerHTML = `<div class="card">불러오지 못했어요. Firestore 규칙이 배포됐는지 확인해 주세요.</div>`; return; }
  drawAdmin();
}

// 배정표에 나오는 선생님 이름 (13명) + 계정 연결
function teacherList() {
  const names = new Set();
  S.students.forEach((s) => { const a = s.assign || {}; [a.s1, a.s2, a.s3a, a.s3b].forEach((n) => okName(n) && names.add(n)); });
  return [...names].sort((a, b) => a.localeCompare(b, "ko")).map((name) => ({ name, staff: S.staff.find((t) => t.name === name) || null }));
}
function unOfName(name) {
  const st = S.staff.find((t) => t.name === name);
  return A.un.find((u) => (st && u.id === st.id) || (!st && u.staffName === name)) || null;
}
function ctxForCheck(cfg) {
  const students = engineStudents(S.students, cfg);
  const unavail = A.un.flatMap((u) => toUnavailRows(S.staff.find((t) => t.id === u.id)?.name || u.staffName, u.days));
  return { students, unavail, config: cfg };
}

function drawAdmin() {
  const el = A.el, cfg = A.cfg, ts = teacherList();
  const doneN = ts.filter((t) => t.staff && A.subs[t.staff.id]?.done).length;
  el.innerHTML = `<div class="gd">
    <div class="card"><h3>지도 일지</h3><p class="gd-lead muted">수당 서류용 지도 시간 배정이에요. 실제 모의면접 일정·기록은 쓰지 않아요. 순서: 선생님 불가시간 입력 → 설정 확인 → [시간 배정] → 검사 0건 확인 → [AI 내용 작성] → [공개]</p></div>
    <div class="card"><div class="gd-row"><h3 style="margin:0">1. 제출 현황</h3><span class="${doneN === ts.length ? "gd-ok" : "gd-warn"}">${doneN} / ${ts.length}명 입력 완료</span>
      <span class="spacer" style="flex:1"></span><label class="gd-row"><input type="checkbox" id="gdColl" ${cfg.collecting ? "checked" : ""}> 선생님 입력 받기</label></div>
      <div class="table-wrap"><table><thead><tr><th>선생님</th><th class="n">불가 날짜</th><th class="n">불가 칸</th><th>입력 완료</th><th>마지막 수정</th><th></th></tr></thead><tbody>
      ${ts.map((t) => { const u = unOfName(t.name), s = t.staff && A.subs[t.staff.id], c = countOf(u?.days); const last = Math.max(0, u?.updatedAtMs || 0, s?.atMs || 0);
        return `<tr><td><b>${esc(t.name)}</b>${t.staff ? "" : ' <span class="gd-bad">계정 없음</span>'}</td><td class="n">${c.days}일</td><td class="n">${c.slots}칸</td><td>${s?.done ? '<span class="gd-ok">✓ 완료</span>' : '<span class="muted">아직</span>'}</td><td>${esc(fmtMs(last))}</td>
        <td><button type="button" class="btn-sm" data-gdsee="${esc(t.name)}">달력 보기</button></td></tr>`; }).join("")}
      </tbody></table></div>
      <p class="muted">'계정 없음'인 선생님은 배정표 이름과 같은 이름의 교사 계정이 없어 입력·공개를 못 받아요 (② 교사 계정에서 이름 확인).</p></div>
    ${settingsHtml(cfg)}
    ${targetHtml()}
    <div class="card"><h3>4. 시간 배정</h3>
      <p class="gd-lead muted">담당교사는 그대로 두고, 불가시간·운영 제외일을 피해 허용 시간대 안에서 무작위로 배정해요. 같은 선생님의 30분 지도는 되도록 이어 붙여 지도 일지 한 장(1시간)에 두 명이 들어가게 해요.</p>
      <div class="gd-row"><button type="button" class="btn-primary" id="gdRun">${A.run ? "다시 배정 (새 무작위)" : "시간 배정"}</button>
      ${doneN < ts.length ? `<span class="gd-warn">아직 입력 완료하지 않은 선생님이 ${ts.length - doneN}명 있어요.</span>` : ""}</div>
      <div id="gdRunOut">${A.run ? runHtml() : ""}</div></div>
  </div>`;
  bindAdmin();
}

function settingsHtml(cfg) {
  const early = Object.entries(cfg.early || {}).map(([k, v]) => `${k} ${v}`).join("\n");
  return `<div class="card"><h3>2. 설정</h3><div class="gd-f">
    <label>지도기간 시작<input type="date" id="gcP0" value="${esc(cfg.periodStart)}"></label>
    <label>지도기간 끝<input type="date" id="gcP1" value="${esc(cfg.periodEnd)}"></label>
    <label>면접 전 1회 시작일<input type="date" id="gcE0" value="${esc(cfg.earlyStart)}"></label>
    <label>주 권장 최대(번)<input type="number" min="1" max="10" id="gcW" value="${esc(cfg.weeklyMax)}"></label>
    <label>하루 권장 최대(번)<input type="number" min="1" max="6" id="gcD" value="${esc(cfg.dailyMax)}"></label>
    <label>준비기간(일)<input type="number" min="0" max="60" id="gcPrep" value="${esc(cfg.prepDays)}"></label>
    <label>제시문·MMI 준비기간(일)<input type="number" min="0" max="60" id="gcPrep2" value="${esc(cfg.prepDaysSpecial)}"></label>
    <label class="wide">운영 제외일 (한 줄에 하나, 2026-10-09 꼴)<textarea id="gcEx">${esc((cfg.excluded || []).join("\n"))}</textarea></label>
    <label class="wide">학생별 '면접 전 담임 1회' 기준일 (한 줄에 '학번 날짜', 예: 3107 2026-09-16) — 1차는 그 날짜 전에, 2·3차는 그 날짜 뒤에 배정<textarea id="gcEarly">${esc(early)}</textarea></label>
    <div class="wide"><button type="button" class="btn-primary" id="gcSave">설정 저장</button></div></div></div>`;
}
function targetHtml() {
  const tg = targets(engineStudents(S.students, A.cfg));
  const names = Object.keys(tg).sort((a, b) => a.localeCompare(b, "ko"));
  const sum = names.reduce((s, n) => { ["r1", "r2", "r3a", "r3b", "r3", "min"].forEach((k) => s[k] += tg[n][k]); return s; }, { r1: 0, r2: 0, r3a: 0, r3b: 0, r3: 0, min: 0 });
  const noDate = engineStudents(S.students, A.cfg).filter((s) => !s.interview && (okName(s.t1) || okName(s.t2)));
  return `<div class="card"><h3>3. 원본 배정량 (학생 담당 배정에서 다시 셈)</h3>
    <div class="table-wrap"><table><thead><tr><th>선생님</th><th class="n">1차(60분)</th><th class="n">2차</th><th class="n">3차 1위원</th><th class="n">3차 2위원</th><th class="n">3차 총</th><th class="n">총 분</th></tr></thead><tbody>
    ${names.map((n) => { const x = tg[n]; return `<tr><td>${esc(n)}</td><td class="n">${x.r1}</td><td class="n">${x.r2}</td><td class="n">${x.r3a}</td><td class="n">${x.r3b}</td><td class="n">${x.r3}</td><td class="n">${x.min.toLocaleString()}</td></tr>`; }).join("")}
    <tr><td><b>합계</b></td><td class="n"><b>${sum.r1}</b></td><td class="n"><b>${sum.r2}</b></td><td class="n"><b>${sum.r3a}</b></td><td class="n"><b>${sum.r3b}</b></td><td class="n"><b>${sum.r3}</b></td><td class="n"><b>${sum.min.toLocaleString()}</b></td></tr></tbody></table></div>
    <p class="muted">운영 계획서 표(1차 92 · 2차 90 · 3차 1위원 90 · 2위원 90 · 총 13,620분)와 다르면 학생 담당 배정(시트 동기화)을 먼저 확인해 주세요.</p>
    ${noDate.length ? `<p class="gd-warn">면접일이 없는 학생 ${noDate.length}명: ${noDate.slice(0, 12).map((s) => esc(s.id)).join(", ")}${noDate.length > 12 ? " …" : ""} — 지도기간 끝까지 아무 날에나 배정돼요.</p>` : ""}</div>`;
}

function bindAdmin() {
  const el = A.el;
  $("#gdColl", el).onchange = async (e) => {
    try { await setDoc(doc(db, "config", "guidance"), { collecting: e.target.checked }, { merge: true }); A.cfg.collecting = e.target.checked; toast(e.target.checked ? "선생님 입력을 받아요." : "선생님 입력을 막았어요 (관리자는 계속 고칠 수 있어요)."); }
    catch (err) { showError(err, "설정 저장"); e.target.checked = !e.target.checked; }
  };
  $$("[data-gdsee]", el).forEach((b) => b.onclick = () => seeTeacher(b.dataset.gdsee));
  $("#gcSave", el).onclick = saveSettings;
  $("#gdRun", el).onclick = doRun;
  bindRun();
}
function seeTeacher(name) {
  const st = S.staff.find((t) => t.name === name), u = unOfName(name);
  const body = openModal(`${name} 선생님 불가시간`, `<div class="gd"><p class="muted" style="margin:0">${st ? "관리자는 여기서 대신 고칠 수 있어요. 누를 때마다 바로 저장돼요." : '<span class="gd-bad">교사 계정이 없어 넣을 수 없어요.</span>'} <span id="gdSeeSt"></span></p><div id="gdSeeCal"></div></div>`, true);
  let t = null;
  mountCal($("#gdSeeCal", body), { cfg: A.cfg, days: u?.days || {}, readOnly: !st, onChange: (days) => {
    clearTimeout(t); $("#gdSeeSt", body).textContent = "저장 중…";
    t = setTimeout(async () => {
      const data = unavailDoc({ id: st.id, name: st.name }, days, S.ctx.user.uid);
      try { await setDoc(doc(db, "guidanceUnavail", st.id), data); A.un = [...A.un.filter((x) => x.id !== st.id), { id: st.id, ...data }]; $("#gdSeeSt", body).textContent = "저장됨"; drawAdmin(); }
      catch (e) { showError(e, "불가시간 저장"); }
    }, 600);
  } });
}
async function saveSettings() {
  const el = A.el, v = (id) => $(id, el).value.trim();
  const ex = v("#gcEx").split(/\s+/).filter(Boolean);
  const bad = ex.find((d) => !/^\d{4}-\d{2}-\d{2}$/.test(d));
  if (bad) return toast(`운영 제외일 형식이 틀렸어요: ${bad}`, "error");
  const early = {};
  for (const line of v("#gcEarly").split("\n").map((x) => x.trim()).filter(Boolean)) {
    const m = line.match(/^(\d{4,6})\s+(\d{4}-\d{2}-\d{2})$/);
    if (!m) return toast(`'학번 날짜' 꼴이 아니에요: ${line}`, "error");
    early[m[1]] = m[2];
  }
  const data = { periodStart: v("#gcP0"), periodEnd: v("#gcP1"), earlyStart: v("#gcE0"), weeklyMax: Number(v("#gcW")) || 3, dailyMax: Number(v("#gcD")) || 2,
    prepDays: Number(v("#gcPrep")) || 0, prepDaysSpecial: Number(v("#gcPrep2")) || 0, excluded: [...new Set(ex)].sort(), early };
  if (!data.periodStart || !data.periodEnd || data.periodEnd < data.periodStart) return toast("지도기간을 확인해 주세요.", "error");
  try { const next = { ...A.cfg, ...data }; await setDoc(doc(db, "config", "guidance"), next); A.cfg = next; toast("설정을 저장했어요."); drawAdmin(); }
  catch (e) { showError(e, "설정 저장"); }
}

// ---------- 배정 ----------
async function doRun() {
  const btn = $("#gdRun", A.el);
  if (A.cfg.publishedRunId && !(await confirmBox({ title: "다시 배정할까요?", what: "이미 공개한 지도 일정이 있어요.", note: "새로 배정해도 [공개]를 누르기 전까지 선생님 화면은 그대로예요.", yes: "다시 배정" }))) return;
  btn.disabled = true; btn.textContent = "배정하는 중…";
  await new Promise((r) => setTimeout(r, 30));
  try {
    const ctx = ctxForCheck(A.cfg);
    const seed = crypto.getRandomValues(new Uint32Array(1))[0] || 7;
    const t0 = performance.now();
    const res = runEngine({ students: ctx.students, unavail: ctx.unavail, config: { ...A.cfg, seed } });
    const ck = checkRows(res.rows, ctx);
    const id = doc(collection(db, "guidanceRuns")).id;   // 자동 ID (같은 초에 두 번 눌러도 안 겹침)
    const submitted = Object.values(A.subs).filter((s) => s.done).length;
    const run = { createdAtMs: Date.now(), by: myName() || S.ctx.user.email || "", seed, status: "draft", ms: Math.round(performance.now() - t0),
      cfg: { periodStart: A.cfg.periodStart, periodEnd: A.cfg.periodEnd, earlyStart: A.cfg.earlyStart, excluded: A.cfg.excluded, early: A.cfg.early || {}, weeklyMax: A.cfg.weeklyMax, dailyMax: A.cfg.dailyMax, prepDays: A.cfg.prepDays, prepDaysSpecial: A.cfg.prepDaysSpecial },
      summary: { students: ctx.students.length, unavail: ctx.unavail.length, submitted }, rows: res.rows, unassigned: res.unassigned, counts: ck.counts };
    await setDoc(doc(db, "guidanceRuns", id), run);
    await setDoc(doc(db, "config", "guidance"), { lastRunId: id }, { merge: true });
    A.cfg.lastRunId = id;
    A.run = { id, ...run };
    toast(`배정했어요: ${res.rows.length}줄, 미배정 ${res.unassigned.length}건`);
  } catch (e) { showError(e, "시간 배정"); }
  drawAdmin();
}
function runHtml() {
  const r = A.run, ctx = ctxForCheck(r.cfg ? { ...A.cfg, ...r.cfg } : A.cfg);
  const ck = checkRows(r.rows, ctx);   // 저장된 결과도 지금 데이터(불가시간·배정)로 다시 검사
  const tg = targets(ctx.students), ac = actuals(r.rows), wk = weekly(r.rows);
  const names = [...new Set([...Object.keys(tg), ...Object.keys(ac)])].sort((a, b) => a.localeCompare(b, "ko"));
  const z = { r1: 0, r2: 0, r3a: 0, r3b: 0, r3: 0, min: 0 };
  const cell = (a, b) => { const d = a - b; return `<td class="n">${a}${d ? ` <span class="gd-bad">(${d > 0 ? "+" : ""}${d})</span>` : ""}</td>`; };
  const over = (n) => Object.values(wk[n] || {}).filter((x) => x > (A.cfg.weeklyMax || 3)).length;
  const pagesN = (n) => pagesOf(r.rows.filter((x) => x.teacher === n)).length;
  const needNotes = notesNeeded(r.rows), haveNotes = needNotes.filter((x) => x.rounds.every((rd) => A.notes[x.no]?.[rd])).length;
  const pub = A.cfg.publishedRunId === r.id;
  const unStudents = r.unassigned || [];
  return `<p class="muted">${esc(fmtMs(r.createdAtMs))} 배정 · ${r.rows.length}줄 · 불가시간 ${r.summary?.unavail ?? "-"}건 · 입력 완료 ${r.summary?.submitted ?? "-"}명${pub ? ' · <span class="gd-ok">공개됨</span>' : ' · <span class="gd-warn">아직 공개 안 함</span>'}</p>
    <h4>검사 (모두 0이어야 공개)</h4>
    <ul class="gd-list">${Object.entries(CHECK_LABELS).map(([k, lab]) => `<li><span class="w">${esc(lab)}</span><span class="${ck.counts[k] ? "gd-bad" : "gd-ok"}">${ck.counts[k]}건</span>${ck.details[k].length ? `<span class="m">${ck.details[k].slice(0, 3).map(esc).join("<br>")}</span>` : ""}</li>`).join("")}
      <li><span class="w">미배정</span><span class="${unStudents.length ? "gd-bad" : "gd-ok"}">${unStudents.length}건</span></li></ul>
    ${unStudents.length ? `<div class="table-wrap"><table><thead><tr><th>학생</th><th>차수</th><th>담당</th><th>이유</th></tr></thead><tbody>${unStudents.map((u) => `<tr><td>${esc(u.studentNo)} ${esc(u.studentName || "")}</td><td>${esc(u.round)}</td><td>${esc(u.teachers)}</td><td>${esc(u.reason)}</td></tr>`).join("")}</tbody></table></div>` : ""}
    <h4>선생님별 목표 / 실제 (괄호 = 차이)</h4>
    <div class="table-wrap"><table><thead><tr><th>선생님</th><th class="n">1차</th><th class="n">2차</th><th class="n">3차 1위원</th><th class="n">3차 2위원</th><th class="n">3차 총</th><th class="n">총 분</th><th class="n">시간</th><th class="n">지도 일지</th><th class="n">주 ${A.cfg.weeklyMax || 3}번 넘는 주</th><th></th></tr></thead><tbody>
    ${names.map((n) => { const a = ac[n] || z, t = tg[n] || z; return `<tr><td>${esc(n)}</td>${cell(a.r1, t.r1)}${cell(a.r2, t.r2)}${cell(a.r3a, t.r3a)}${cell(a.r3b, t.r3b)}${cell(a.r3, t.r3)}${cell(a.min, t.min)}<td class="n">${(a.min / 60).toFixed(1)}</td><td class="n">${pagesN(n)}장</td><td class="n">${over(n) ? `<span class="gd-warn">${over(n)}</span>` : 0}</td>
      <td><button type="button" class="btn-sm" data-gdhw="${esc(n)}">hwpx</button></td></tr>`; }).join("")}</tbody></table></div>
    <div class="gd-row" style="margin-top:8px"><button type="button" id="gdCsv">전체 일정 CSV</button><button type="button" id="gdAll">선생님 전원 지도 일지 (zip)</button></div>
    <h4>5. 면접 내용 및 피드백 (AI 작성)</h4>
    <p class="muted">학생마다 지원 대학·전형과 학생부(있으면)를 보고 1·2·3차 글을 따로 만들어요. Claude Sonnet 5.5 · 학생 한 명에 약 100~200원, 92명이면 약 1만~2만 원 (추정 · 관리 ⑤ AI 사용 비용에 '지도 일지'로 쌓여요). 이름·학번은 보내지 않아요.</p>
    <div class="gd-row"><b>${haveNotes} / ${needNotes.length}명 작성됨</b><button type="button" class="btn-primary" id="gdAi" ${haveNotes === needNotes.length ? "disabled" : ""}>${haveNotes ? "남은 학생 AI 작성" : "AI 내용 작성"}</button><button type="button" id="gdNotes">학생별 글 보기·고치기</button></div>
    <div class="gd-prog" id="gdProg" hidden><b></b></div><div id="gdAiMsg" class="muted"></div>
    <h4>6. 공개</h4>
    <p class="muted">공개하면 선생님마다 '지도 일지' 화면에서 내 지도 일정과 지도 일지(hwpx)를 받을 수 있어요. 다시 배정해서 공개하면 새 결과로 바뀌어요.</p>
    <button type="button" class="btn-primary" id="gdPub" ${ck.total ? "disabled" : ""}>${pub ? "다시 공개 (글 고친 것 반영)" : "공개"}</button>${ck.total ? ' <span class="gd-bad">검사에서 걸린 것이 있어 공개할 수 없어요.</span>' : ""}`;
}
function bindRun() {
  const el = A.el;
  if (!A.run) return;
  $$("[data-gdhw]", el).forEach((b) => b.onclick = async () => {
    try { const n = b.dataset.gdhw; await saveHwpx(n, A.run.rows.filter((x) => x.teacher === n), (no) => studentInfo(S.students.find((s) => s.studentNo === no)), (no, rd) => A.notes[no]?.[rd] || ""); }
    catch (e) { showError(e, "지도 일지 만들기"); }
  });
  $("#gdCsv", el).onclick = () => exportCsv(A.run.rows);
  $("#gdAll", el).onclick = () => downloadAll();
  $("#gdAi", el).onclick = () => runAi();
  $("#gdNotes", el).onclick = () => notesModal();
  $("#gdPub", el).onclick = () => publish();
}

function exportCsv(rows) {
  const q = (v) => { const s = String(v ?? ""); return /[",\n]/.test(s) || /^[=+\-@]/.test(s) ? `"${(/^[=+\-@]/.test(s) ? "'" : "") + s.replace(/"/g, '""')}"` : s; };
  const by = Object.fromEntries(S.students.map((s) => [s.studentNo, s]));
  const lines = [["교사", "날짜", "요일", "시작", "종료", "분", "차수", "역할", "평일/주말", "학번", "이름"].join(",")];
  rows.slice().sort((a, b) => a.teacher.localeCompare(b.teacher, "ko") || rowOrder(a, b)).forEach((r) => lines.push([r.teacher, r.date, "일월화수목금토"[new Date(r.date + "T00:00:00").getDay()], r.start, r.end, r.minutes, r.round, r.role, r.dayType, r.studentNo, by[r.studentNo]?.name || r.studentName || ""].map(q).join(",")));
  saveBlob(`지도 일정_${today()}.csv`, "﻿" + lines.join("\r\n"), "text/csv;charset=utf-8");
}
async function downloadAll() {
  const btn = $("#gdAll", A.el); btn.disabled = true;
  try {
    const names = [...new Set(A.run.rows.map((r) => r.teacher))].sort((a, b) => a.localeCompare(b, "ko"));
    const files = [];
    for (const n of names) files.push({ name: `지도 일지_${n}.hwpx`, data: await hwpxBytes(n, A.run.rows.filter((x) => x.teacher === n), (no) => studentInfo(S.students.find((s) => s.studentNo === no)), (no, rd) => A.notes[no]?.[rd] || "") });
    saveBlob(`지도 일지_전체_${today()}.zip`, zipStore(files), "application/zip");
  } catch (e) { showError(e, "지도 일지 묶기"); }
  finally { btn.disabled = false; }
}

// ---------- AI 내용 ----------
function notesNeeded(rows) {
  const by = {};
  rows.forEach((r) => (by[r.studentNo] ||= new Set()).add(r.round));
  return Object.entries(by).map(([no, s]) => ({ no, rounds: ROUNDS.filter((x) => s.has(x)) }));
}
async function runAi() {
  const el = A.el, btn = $("#gdAi", el), prog = $("#gdProg", el), msg = $("#gdAiMsg", el);
  const todo = notesNeeded(A.run.rows).map((x) => ({ ...x, rounds: x.rounds.filter((rd) => !A.notes[x.no]?.[rd]) })).filter((x) => x.rounds.length);
  if (!todo.length) return;
  if (!(await confirmBox({ title: "AI 내용 작성", what: `학생 ${todo.length}명 · 차수 ${todo.reduce((n, x) => n + x.rounds.length, 0)}칸`, note: "몇 분 걸려요. 이 화면을 닫지 마세요. 중간에 멈추면 다시 누르면 남은 학생만 이어서 해요.", yes: "작성 시작" }))) return;
  btn.disabled = true; prog.hidden = false;
  const batches = [];
  for (let i = 0; i < todo.length; i += 4) batches.push(todo.slice(i, i + 4));
  let done = 0, fail = [];
  const one = async (batch) => {
    const students = batch.map((x) => { const st = S.students.find((s) => s.studentNo === x.no) || {}; return { no: x.no, rounds: x.rounds, track: st.track || "", special: st.special || "" }; });
    const r = await aiCall(S.ctx.user, "gjournal", { students }, 360000);
    if (!r?.ok) { fail.push(...batch.map((x) => `${x.no}(${r?.error || "실패"})`)); return; }
    for (const x of batch) {
      const got = r.results?.[x.no];
      if (!got || got.error) { fail.push(`${x.no}(${got?.error || "없음"})`); continue; }
      const merged = { ...(A.notes[x.no] || {}), ...Object.fromEntries(x.rounds.filter((rd) => got[rd]).map((rd) => [rd, got[rd]])) };
      try { await setDoc(doc(db, "guidanceNotes", x.no), { r: merged, atMs: Date.now() }); A.notes[x.no] = merged; }
      catch (e) { fail.push(`${x.no}(저장)`); }
    }
  };
  const queue = batches.slice();
  const worker = async () => { while (queue.length) { const b = queue.shift(); await one(b); done += b.length; $("b", prog).style.width = `${Math.round(done / todo.length * 100)}%`; msg.textContent = `${done} / ${todo.length}명`; } };
  await Promise.all([worker(), worker()]);
  toast(fail.length ? `${fail.length}명은 못 만들었어요. 다시 누르면 이어서 해요.` : "AI 내용을 모두 만들었어요.", fail.length ? "error" : "ok", 6000);
  drawAdmin();
  if (fail.length) $("#gdAiMsg", A.el).textContent = "못 만든 학생: " + fail.join(", ");
}
function notesModal() {
  const need = notesNeeded(A.run.rows);
  const nm = (no) => S.students.find((s) => s.studentNo === no)?.name || "";
  const body = openModal("면접 내용 및 피드백 (학생별)", `<div class="gd"><label class="gd-row">학생 <select id="gnPick" style="width:auto">${need.map((x) => `<option value="${esc(x.no)}">${esc(x.no)} ${esc(nm(x.no))}${x.rounds.every((rd) => A.notes[x.no]?.[rd]) ? "" : " (빈칸 있음)"}</option>`).join("")}</select></label><div id="gnBody"></div></div>`, true);
  const draw = () => {
    const no = $("#gnPick", body).value, x = need.find((y) => y.no === no), info = studentInfo(S.students.find((s) => s.studentNo === no));
    $("#gnBody", body).innerHTML = `<p class="muted">${esc(info.univ || "지원 대학 정보 없음")} · ${esc(info.type || "")}</p>
      ${x.rounds.map((rd) => `<label style="display:grid;gap:4px;margin-bottom:10px"><b>${esc(ROUND_HEAD[rd])}</b><textarea data-rd="${rd}" rows="7">${esc(A.notes[no]?.[rd] || "")}</textarea></label>`).join("")}
      <button type="button" class="btn-primary" id="gnSave">저장</button> <span class="muted">저장한 뒤 [다시 공개]를 눌러야 선생님 지도 일지에 반영돼요.</span>`;
    $("#gnSave", body).onclick = async () => {
      const r = { ...(A.notes[no] || {}) };
      $$("[data-rd]", body).forEach((t) => { r[t.dataset.rd] = t.value.trim().slice(0, 1200); });
      try { await setDoc(doc(db, "guidanceNotes", no), { r, atMs: Date.now(), edited: true }); A.notes[no] = r; toast("저장했어요."); } catch (e) { showError(e, "글 저장"); }
    };
  };
  $("#gnPick", body).onchange = draw;
  draw();
}

// ---------- 공개 ----------
export function planDocs(rows, staff, info, notes) {
  const by = {};
  rows.forEach((r) => (by[r.teacher] ||= []).push(r));
  const out = [], missing = [];
  Object.entries(by).forEach(([name, list]) => {
    const st = staff.find((t) => t.name === name);
    if (!st) { missing.push(name); return; }
    const nos = [...new Set(list.map((r) => r.studentNo))];
    const partner = (r) => r.round === "3차" ? (rows.find((x) => x.studentNo === r.studentNo && x.round === "3차" && x.teacher !== r.teacher)?.teacher || "") : "";
    out.push({ id: st.id, data: {
      staffId: st.id, staffName: name,
      rows: list.slice().sort(rowOrder).map((r) => ({ date: r.date, start: r.start, end: r.end, minutes: r.minutes, round: r.round, role: r.role || "", dayType: r.dayType, studentNo: r.studentNo, studentName: r.studentName || "", partner: partner(r) })),
      students: Object.fromEntries(nos.map((no) => [no, info(no)])),
      notes: Object.fromEntries(nos.map((no) => [no, notes[no] || {}]))
    } });
  });
  return { out, missing };
}
async function publish() {
  const r = A.run;
  const ck = checkRows(r.rows, ctxForCheck({ ...A.cfg, ...(r.cfg || {}) }));
  if (ck.total) return toast("검사에서 걸린 것이 있어요.", "error");
  const info = (no) => studentInfo(S.students.find((s) => s.studentNo === no));
  const { out, missing } = planDocs(r.rows, S.staff, info, A.notes);
  const emptyNotes = notesNeeded(r.rows).filter((x) => x.rounds.some((rd) => !A.notes[x.no]?.[rd])).length;
  const what = `선생님 ${out.length}명 · 지도 ${r.rows.length}줄${r.unassigned?.length ? ` · <b>미배정 ${r.unassigned.length}건</b>` : ""}${emptyNotes ? ` · <b>내용 칸 빈 학생 ${emptyNotes}명</b>` : ""}${missing.length ? `<br><b>계정 없어 못 받는 선생님: ${missing.map(esc).join(", ")}</b>` : ""}`;
  if (!(await confirmBox({ title: A.cfg.publishedRunId ? "새 결과로 다시 공개할까요?" : "공개할까요?", what, note: "선생님 화면의 지도 일정·지도 일지가 이 결과로 바뀌어요.", yes: "공개" }))) return;
  try {
    const old = await getDocs(collection(db, "guidancePlan"));
    const keep = new Set(out.map((x) => x.id));
    const now = Date.now();
    const ops = [...out.map((x) => ["set", x.id, { ...x.data, runId: r.id, publishedAtMs: now }]), ...old.docs.filter((d) => !keep.has(d.id)).map((d) => ["del", d.id])];
    for (let i = 0; i < ops.length; i += 400) {
      const b = writeBatch(db);
      ops.slice(i, i + 400).forEach(([k, id, data]) => k === "set" ? b.set(doc(db, "guidancePlan", id), data) : b.delete(doc(db, "guidancePlan", id)));
      await b.commit();
    }
    await setDoc(doc(db, "guidanceRuns", r.id), { status: "published", publishedAtMs: now }, { merge: true });
    await setDoc(doc(db, "config", "guidance"), { publishedRunId: r.id, publishedAtMs: now }, { merge: true });
    A.cfg.publishedRunId = r.id; A.cfg.publishedAtMs = now;
    toast("공개했어요. 선생님들이 지도 일지를 내려받을 수 있어요.", "ok", 6000);
    drawAdmin();
  } catch (e) { showError(e, "공개"); }
}
