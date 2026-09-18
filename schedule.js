// 모의면접(연습) 일정: 주간 달력 · 신청/수락/시간 변경 제안/거절/취소 · 교사·장소·학생 겹침 검사
// 학생 화면과 교사 화면이 같이 쓴다.
import {
  db, collection, doc, getDoc, getDocs, setDoc, query, where, runTransaction,
  $, $$, esc, toast, showError, isoDay, toDate, fmtDay, fmtDate, nextInterview, defaultMeetingType, cachedCollection
} from "./common.js";
import { pingScheduleSync } from "./sync.js";

// ================= 기본값 =================
export const DEFAULT_BLOCKS = [
  { key: "p1", label: "1교시", start: "08:30", end: "09:20" },
  { key: "p2", label: "2교시", start: "09:30", end: "10:20" },
  { key: "p3", label: "3교시", start: "10:30", end: "11:20" },
  { key: "p4", label: "4교시", start: "11:30", end: "12:20" },
  { key: "lunch", label: "점심시간", start: "12:20", end: "13:20" },
  { key: "p5", label: "5교시", start: "13:20", end: "14:10" },
  { key: "p6", label: "6교시", start: "14:20", end: "15:10" },
  { key: "p7", label: "7교시", start: "15:20", end: "16:10" },
  { key: "after", label: "방과후", start: "16:30", end: "18:00" },
  { key: "n1", label: "야자 1차시", start: "19:00", end: "20:10" },
  { key: "n2", label: "야자 2차시", start: "20:20", end: "21:30" }
];
export const DEFAULT_ROOMS = ["SW실", "진로진학실"];
export const BOOK_STAGES = [
  { key: 1, label: "1차 담임", short: "1차", min: 0 },   // 1차: 칸(교시) 전체
  { key: 2, label: "2차 교과", short: "2차", min: 30 },
  { key: 3, label: "3차 모의면접", short: "3차", min: 30 }
];
const STATUS = {
  requested: ["요청 중", "orange"], confirmed: ["확정", "green"], cancelled: ["취소", "gray"], rejected: ["거절", "red"]
};
const ACTIVE = (s) => s === "requested" || s === "confirmed";
const WEEK = "일월화수목금토";

export async function loadScheduleConfig() {
  let c = {};
  try { const s = await getDoc(doc(db, "config", "schedule")); if (s.exists()) c = s.data(); } catch (e) { console.warn("schedule config", e); }
  return {
    blocks: Array.isArray(c.blocks) && c.blocks.length ? c.blocks : DEFAULT_BLOCKS,
    rooms: Array.isArray(c.rooms) ? c.rooms : DEFAULT_ROOMS,
    syncUrl: c.syncUrl || ""
  };
}

// ================= 시간 도우미 =================
const toMin = (t) => { const [h, m] = String(t).split(":").map(Number); return h * 60 + (m || 0); };
const fromMin = (n) => `${String(Math.floor(n / 60)).padStart(2, "0")}:${String(n % 60).padStart(2, "0")}`;
const overlap = (a, b) => toMin(a.start) < toMin(b.end) && toMin(b.start) < toMin(a.end);
const normRoom = (r) => String(r || "").replace(/\s+/g, "").toLowerCase();
function mondayOf(d) { const x = new Date(d); x.setHours(0, 0, 0, 0); x.setDate(x.getDate() - ((x.getDay() + 6) % 7)); return x; }
const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
const maskName = (n) => { n = String(n || ""); return n ? n[0] + "○".repeat(Math.max(1, n.length - 1)) : ""; };

/** 칸 하나에서 고를 수 있는 시간: 1차는 칸 전체, 2·3차는 30분 단위 */
export function slotOptions(block, stage) {
  if (!block) return [];
  const st = BOOK_STAGES.find((s) => s.key === Number(stage));
  if (!st || !st.min) return [{ start: block.start, end: block.end }];
  const out = [];
  for (let t = toMin(block.start); t + st.min <= toMin(block.end); t += st.min) out.push({ start: fromMin(t), end: fromMin(t + st.min) });
  return out;
}
export function stageTeachers(st, stage) {
  const a = st?.assign || {};
  return ({ 1: [a.s1], 2: [a.s2], 3: [a.s3a, a.s3b] }[stage] || []).filter(Boolean);
}
const who = (k) => k === "student" ? "학생" : k === "관리자" ? "관리자" : `${k} 선생님`;

/**
 * 겹침 검사. 반환 [{hard, msg}]
 *  - 같은 교사 · 같은 장소 · 같은 학생이 시간이 겹치면 불가 (요청 중인 일정도 자리를 차지)
 *  - 교사 불가 시간(수업 등)은 다른 사람이 신청하면 불가, 본인·관리자는 경고만
 */
export function findConflicts(b, items, { avail = {}, actor = "", isAdmin = false, student = null, bookingId = "" } = {}) {
  const out = [];
  const today = isoDay();
  if (b.date < today) out.push({ hard: !isAdmin, msg: "지난 날짜입니다." });
  for (const [id, x] of Object.entries(items || {})) {
    if (id === bookingId || !ACTIVE(x.status) || !overlap(x, b)) continue;
    const label = `${x.start}–${x.end} ${x.stage}차${x.status === "requested" ? "(요청 중)" : ""}`;
    const common = (x.teachers || []).filter((t) => b.teachers.includes(t));
    common.forEach((t) => out.push({ hard: true, msg: `${t} 선생님이 같은 시간에 다른 일정이 있어요 (${label})` }));
    if (b.room && normRoom(x.room) === normRoom(b.room)) out.push({ hard: true, msg: `${b.room}에 같은 시간 다른 일정이 있어요 (${label})` });
    if (x.no === b.studentNo) out.push({ hard: true, msg: `학생에게 같은 시간 다른 일정이 있어요 (${label})` });
  }
  const dow = String(toDate(b.date)?.getDay());
  for (const t of b.teachers) {
    const av = avail[t];
    if (!av) continue;
    const busyWeekly = (av.weekly?.[dow] || []).includes(b.block);
    const busyDate = (av.dates?.[b.date] || []).includes(b.block);
    if (busyWeekly || busyDate) out.push({ hard: !(isAdmin || actor === t), msg: `${t} 선생님이 이 시간을 '불가'로 표시했어요${busyDate ? " (날짜별 일정)" : " (수업 시간)"}` });
  }
  if (student) {
    const nx = nextInterview(student);
    if (nx && toDate(b.date) > nx) out.push({ hard: false, msg: `대학 면접일(${fmtDay(nx)})보다 늦은 날짜예요.` });
  }
  return out;
}

// ================= 본체 =================
/**
 * opts:
 *  role: 'student' | 'teacher' | 'admin'
 *  student: 학생 화면의 내 학생 문서 (assign·universities 포함)
 *  myName, staffId: 교사
 *  getStudents(), getStaff(): 교사 화면의 명단
 *  openMeeting(booking): 교사 화면 '대면 기록 쓰기'
 *  onBadge(n): 처리할 요청 수 알림
 */
export function mountSchedule(root, opts) {
  const role = opts.role;
  const isStudent = role === "student", isAdmin = role === "admin";
  const me = isStudent ? "student" : (opts.myName || "관리자");
  const st = {
    cfg: { blocks: DEFAULT_BLOCKS, rooms: DEFAULT_ROOMS, syncUrl: "" },
    week: mondayOf(new Date()), dayIdx: Math.min((new Date().getDay() + 6) % 7, 4),
    view: window.innerWidth < 720 ? "day" : "week", weekend: false,
    days: {}, avail: {}, bookings: [],
    fTeacher: "", fRoom: "", fMine: false, shadeStage: 1
  };
  const students = () => isStudent ? [opts.student] : (opts.getStudents?.() || []);
  const studentByNo = (no) => students().find((s) => s.studentNo === no);
  const staffNames = () => [...new Set((opts.getStaff?.() || []).map((t) => t.name).filter(Boolean))];

  root.innerHTML = `
    <div id="scMine"></div>
    <div class="card sc-card">
      <div class="sc-bar">
        <div class="row">
          <button class="btn-sm" id="scPrev">◀</button>
          <b id="scRange"></b>
          <button class="btn-sm" id="scNext">▶</button>
          <button class="btn-sm" id="scToday">오늘</button>
        </div>
        <div class="row">
          <div class="seg-mini"><button data-view="week">주</button><button data-view="day">일</button></div>
          <label class="inline-check"><input type="checkbox" id="scWeekend"> 주말</label>
          ${isStudent ? `<select id="scShade" title="회색 칸 = 선생님 불가 시간">${BOOK_STAGES.map((s) => `<option value="${s.key}">${s.short} 선생님 기준</option>`).join("")}</select>` : `
          <select id="scTeacher"><option value="">모든 선생님</option></select>
          <select id="scRoom"><option value="">모든 장소</option></select>
          <label class="inline-check"><input type="checkbox" id="scMineOnly"> 내 일정만</label>`}
          ${isStudent ? "" : `<button class="btn-sm" id="scAvail">${isAdmin ? "선생님 불가 시간" : "내 불가 시간"}</button>`}
        </div>
      </div>
      <div class="sc-legend"><span class="sc-chip s1">1차</span><span class="sc-chip s2">2차</span><span class="sc-chip s3">3차</span>
        <span class="sc-chip s1 req">점선 = 요청 중</span><span class="sc-legend-busy">회색 칸 = ${isStudent ? "선생님 불가" : "내 불가 시간"}</span>
        <span class="muted">같은 교실·같은 시간은 겹칠 수 없어요 · <b>＋</b> 를 누르면 ${isStudent ? "신청" : "일정 잡기"}</span></div>
      <div id="scGrid" class="sc-grid-wrap"></div>
    </div>`;

  $("#scPrev", root).onclick = () => move(-1);
  $("#scNext", root).onclick = () => move(1);
  $("#scToday", root).onclick = () => { st.week = mondayOf(new Date()); st.dayIdx = Math.min((new Date().getDay() + 6) % 7, 6); refreshDays(); };
  $$("[data-view]", root).forEach((b) => b.onclick = () => { st.view = b.dataset.view; render(); });
  $("#scWeekend", root).onchange = (e) => { st.weekend = e.target.checked; refreshDays(); };
  if (isStudent) $("#scShade", root).onchange = (e) => { st.shadeStage = Number(e.target.value); render(); };
  else {
    $("#scTeacher", root).onchange = (e) => { st.fTeacher = e.target.value; render(); };
    $("#scRoom", root).onchange = (e) => { st.fRoom = e.target.value; render(); };
    $("#scMineOnly", root).onchange = (e) => { st.fMine = e.target.checked; render(); };
    $("#scAvail", root).onclick = () => openAvailability();
  }

  function move(dir) {
    if (st.view === "day") {
      const n = st.weekend ? 7 : 5;
      st.dayIdx += dir;
      if (st.dayIdx < 0) { st.week = addDays(st.week, -7); st.dayIdx = n - 1; return refreshDays(); }
      if (st.dayIdx >= n) { st.week = addDays(st.week, 7); st.dayIdx = 0; return refreshDays(); }
      return render();
    }
    st.week = addDays(st.week, 7 * dir); refreshDays();
  }
  const visibleDates = () => Array.from({ length: st.weekend ? 7 : 5 }, (_, i) => isoDay(addDays(st.week, i)));

  // ---------- 데이터 ----------
  async function refresh() {
    try {
      const [cfg, av, bk] = await Promise.all([
        loadScheduleConfig(),
        cachedCollection("availability"),
        isStudent ? getDocs(query(collection(db, "bookings"), where("studentNo", "==", opts.student.studentNo)))
          : isAdmin ? getDocs(collection(db, "bookings"))
          : getDocs(query(collection(db, "bookings"), where("teachers", "array-contains", me)))
      ]);
      st.cfg = cfg;
      st.avail = {};
      av.forEach((x) => { if (x.name) st.avail[x.name] = x; });
      st.bookings = bk.docs.map((d) => ({ id: d.id, ...d.data() }));
    } catch (e) { showError(e, "일정 불러오기"); }
    await refreshDays();
  }
  async function refreshDays() {
    const dates = visibleDates();
    try {
      const snaps = await Promise.all(dates.map((d) => getDoc(doc(db, "days", d))));
      snaps.forEach((s, i) => { st.days[dates[i]] = s.exists() ? (s.data().items || {}) : {}; });
    } catch (e) { showError(e, "달력 불러오기"); }
    render();
  }

  // ---------- 그리기 ----------
  function render() {
    fillFilters();
    renderMine();
    renderGrid();
    opts.onBadge?.(needMine().length);
  }
  function fillFilters() {
    if (isStudent) return;
    const tSel = $("#scTeacher", root), rSel = $("#scRoom", root);
    const tNames = staffNames();
    tSel.innerHTML = `<option value="">모든 선생님</option>` + tNames.map((n) => `<option ${n === st.fTeacher ? "selected" : ""}>${esc(n)}</option>`).join("");
    const rooms = [...new Set([...st.cfg.rooms, ...Object.values(st.days).flatMap((it) => Object.values(it).map((x) => x.room)).filter(Boolean)])];
    rSel.innerHTML = `<option value="">모든 장소</option>` + rooms.map((n) => `<option ${n === st.fRoom ? "selected" : ""}>${esc(n)}</option>`).join("");
  }
  const needMine = () => st.bookings.filter((b) => b.status === "requested" && (b.need || []).includes(me) && !(b.approvedBy || []).includes(me));
  const statusBadge = (s) => `<span class="badge badge-${STATUS[s]?.[1] || "gray"}">${STATUS[s]?.[0] || s}</span>`;
  const timeText = (b) => `${fmtDay(b.date)} ${blockLabel(b.block)} ${b.start}–${b.end}`;
  const blockLabel = (k) => st.cfg.blocks.find((x) => x.key === k)?.label || "";
  const waiting = (b) => (b.need || []).filter((n) => !(b.approvedBy || []).includes(n)).map(who).join(", ");

  function bookingLine(b, { withStudent = !isStudent } = {}) {
    const s = studentByNo(b.studentNo);
    return `<div class="q-item sc-item" data-bid="${b.id}">
      <div class="row"><span class="sc-chip s${b.stage}">${b.stage}차</span>
        ${withStudent ? `<b>${esc(s?.name || b.studentName)}</b> <span class="muted">${esc(b.studentNo)}</span>` : `<b>${esc((b.teachers || []).join("·"))} 선생님</b>`}
        <span>${timeText(b)}</span><span class="muted">${esc(b.room || "장소 미정")}</span>
        <div class="spacer"></div>${statusBadge(b.status)}</div>
      ${b.status === "requested" ? `<div class="q-meta">수락 대기: ${esc(waiting(b))}${b.memo ? ` · “${esc(b.memo)}”` : ""}</div>` : b.memo ? `<div class="q-meta">“${esc(b.memo)}”</div>` : ""}
    </div>`;
  }

  function renderMine() {
    const box = $("#scMine", root);
    const today = isoDay();
    if (isStudent) {
      const me0 = opts.student;
      box.innerHTML = `<div class="grid sc-stage-grid">${BOOK_STAGES.map((sg) => {
        const ts = stageTeachers(me0, sg.key);
        const list = st.bookings.filter((b) => b.stage === sg.key && ACTIVE(b.status)).sort((a, b) => (a.date + a.start).localeCompare(b.date + b.start));
        const cur = list[0];
        let body;
        if (!ts.length) body = `<div class="muted">배정된 선생님이 없어요</div>`;
        else if (!cur) body = `<div class="muted">아직 신청하지 않았어요</div><button class="btn-sm btn-primary" data-new="${sg.key}">달력에서 신청</button>`;
        else body = `<div><b>${timeText(cur)}</b></div><div class="muted">${esc(cur.room || "장소 미정")}</div>
          <div class="row" style="margin-top:4px">${statusBadge(cur.status)}${cur.status === "requested" ? `<span class="muted">대기: ${esc(waiting(cur))}</span>` : ""}
          ${needMine().some((x) => x.id === cur.id) ? '<span class="badge badge-red">내 응답 필요</span>' : ""}</div>
          <button class="btn-sm" data-bid="${cur.id}">자세히</button>`;
        return `<div class="card sc-stage"><div class="row"><span class="sc-chip s${sg.key}">${sg.short}</span><b>${sg.label}</b></div>
          <div class="muted" style="margin:2px 0 6px">${ts.length ? esc(ts.join(", ")) + " 선생님" : ""}</div>${body}</div>`;
      }).join("")}</div>`;
    } else {
      const pend = needMine().sort((a, b) => (a.date + a.start).localeCompare(b.date + b.start));
      const mineUp = st.bookings.filter((b) => (b.teachers || []).includes(me) && b.status === "confirmed" && b.date >= today)
        .sort((a, b) => (a.date + a.start).localeCompare(b.date + b.start)).slice(0, 8);
      const myStudents = isAdmin ? students() : students().filter((s) => BOOK_STAGES.some((sg) => stageTeachers(s, sg.key).includes(me)));
      const missing = [];
      for (const s of myStudents) for (const sg of BOOK_STAGES) {
        const ts = stageTeachers(s, sg.key);
        if (!ts.length || (!isAdmin && !ts.includes(me))) continue;
        if (!st.bookings.some((b) => b.studentNo === s.studentNo && b.stage === sg.key && ACTIVE(b.status))) missing.push({ s, sg });
      }
      box.innerHTML = `<div class="grid grid-2" style="align-items:start;margin-bottom:14px">
        <div class="card"><div class="row"><h3 style="margin:0">처리할 요청</h3>${pend.length ? `<span class="dot-new">${pend.length}</span>` : ""}</div>
          <div style="margin-top:8px">${pend.length ? pend.map((b) => bookingLine(b)).join("") : '<div class="muted">새 요청이 없습니다.</div>'}</div></div>
        <div class="card"><h3 style="margin:0 0 8px">다가오는 확정 일정</h3>
          ${mineUp.length ? mineUp.map((b) => bookingLine(b)).join("") : '<div class="muted">확정된 일정이 없습니다.</div>'}
          <details style="margin-top:10px"><summary class="muted">일정이 없는 ${isAdmin ? "" : "담당 "}학생·차수 ${missing.length}건</summary>
            <div style="max-height:260px;overflow-y:auto;margin-top:6px">${missing.map(({ s, sg }) => `<div class="row sc-miss"><span class="sc-chip s${sg.key}">${sg.short}</span>${esc(s.name)} <span class="muted">${esc(s.studentNo)}</span><div class="spacer"></div>
              <button class="btn-sm" data-newfor="${esc(s.studentNo)}" data-stage="${sg.key}">일정 잡기</button></div>`).join("") || '<div class="muted">모두 신청됨</div>'}</div>
          </details></div></div>`;
    }
    $$("[data-bid]", box).forEach((el) => el.onclick = () => openDetail(el.dataset.bid));
    $$("[data-new]", box).forEach((el) => el.onclick = () => {
      st.shadeStage = Number(el.dataset.new); if ($("#scShade", root)) $("#scShade", root).value = el.dataset.new;
      render(); $("#scGrid", root).scrollIntoView({ behavior: "smooth", block: "start" });
      toast("달력에서 흰 칸을 눌러 신청하세요.");
    });
    $$("[data-newfor]", box).forEach((el) => el.onclick = () => openForm({ studentNo: el.dataset.newfor, stage: Number(el.dataset.stage), date: isoDay(), block: "" }));
  }

  function busyFor(names, date, blockKey) {
    const dow = String(toDate(date).getDay());
    return names.filter((t) => { const av = st.avail[t]; return av && ((av.weekly?.[dow] || []).includes(blockKey) || (av.dates?.[date] || []).includes(blockKey)); });
  }
  function shadeNames() {
    if (isStudent) return stageTeachers(opts.student, st.shadeStage);
    if (st.fTeacher) return [st.fTeacher];
    return isAdmin && me === "관리자" ? [] : [me];
  }

  function chipHtml(id, x) {
    const own = isStudent ? x.no === opts.student.studentNo : (x.teachers || []).includes(me);
    const s = studentByNo(x.no);
    const name = isStudent ? (own ? opts.student.name : `${x.cls ? x.cls + " " : ""}${x.nm}`) : `${s?.name || x.nm}`;
    return `<div class="sc-chip s${x.stage} ${x.status === "requested" ? "req" : ""} ${own ? "own" : ""}" data-chip="${id}" title="${esc(`${x.start}–${x.end} ${x.stage}차 · ${name} · ${(x.teachers || []).join(", ")} · ${x.room || "장소 미정"}${x.status === "requested" ? " · 요청 중" : ""}`)}">
      <span class="t">${x.start}</span> ${x.stage}차 ${esc(name)}<span class="sub">${esc((x.teachers || []).join("·"))}${x.room ? " · " + esc(x.room) : ""}</span></div>`;
  }
  function cellItems(date, blk) {
    const items = st.days[date] || {};
    return Object.entries(items).filter(([, x]) => ACTIVE(x.status) && x.block === blk.key
      && (isStudent || ((!st.fTeacher || (x.teachers || []).includes(st.fTeacher)) && (!st.fRoom || normRoom(x.room) === normRoom(st.fRoom))
        && (!st.fMine || (x.teachers || []).includes(me)))))
      .sort((a, b) => a[1].start.localeCompare(b[1].start));
  }

  function renderGrid() {
    const dates = visibleDates();
    const today = isoDay();
    const shown = st.view === "day" ? [dates[Math.min(st.dayIdx, dates.length - 1)]] : dates;
    const first = toDate(dates[0]), last = toDate(dates[dates.length - 1]);
    $("#scRange", root).textContent = st.view === "day" ? fmtDay(shown[0]) : `${first.getMonth() + 1}/${first.getDate()} – ${last.getMonth() + 1}/${last.getDate()}`;
    $$("[data-view]", root).forEach((b) => b.classList.toggle("active", b.dataset.view === st.view));
    const names = shadeNames();
    $("#scGrid", root).innerHTML = `<table class="sc-grid ${st.view}"><thead><tr><th class="sc-blk"></th>${shown.map((d) => {
      const x = toDate(d);
      return `<th class="${d === today ? "today" : ""}">${x.getMonth() + 1}/${x.getDate()} (${WEEK[x.getDay()]})</th>`;
    }).join("")}</tr></thead><tbody>${st.cfg.blocks.map((blk) => `<tr><th class="sc-blk">${esc(blk.label)}<small>${blk.start}–${blk.end}</small></th>${shown.map((d) => {
      const past = d < today;
      const busy = names.length ? busyFor(names, d, blk.key) : [];
      const items = cellItems(d, blk);
      return `<td class="sc-cell ${past ? "past" : ""} ${busy.length ? "busy" : ""}" data-date="${d}" data-block="${blk.key}" ${busy.length ? `title="${esc(busy.join(", "))} 선생님 불가"` : ""}>
        ${items.map(([id, x]) => chipHtml(id, x)).join("")}${!past ? '<span class="sc-plus">+</span>' : ""}</td>`;
    }).join("")}</tr>`).join("")}</tbody></table>`;
    $$(".sc-cell", root).forEach((td) => td.onclick = (e) => {
      if (e.target.closest("[data-chip]")) return;
      if (td.classList.contains("past") && !isAdmin) return toast("지난 날짜에는 일정을 잡을 수 없어요.", "error");
      openForm({ date: td.dataset.date, block: td.dataset.block, stage: isStudent ? st.shadeStage : undefined });
    });
    $$("[data-chip]", root).forEach((el) => el.onclick = () => {
      const id = el.dataset.chip;
      const x = Object.values(st.days).map((it) => it[id]).find(Boolean);
      if (isStudent && x && x.no !== opts.student.studentNo) {
        return toast(`${x.start}–${x.end} · ${x.stage}차 · ${(x.teachers || []).join(", ")} 선생님 · ${x.room || "장소 미정"}${x.status === "requested" ? " (요청 중)" : ""}`, "ok", 5000);
      }
      openDetail(id);
    });
  }

  // ---------- 모달 ----------
  function modal(title, html) {
    $("#mTitle").textContent = title;
    $("#mBody").innerHTML = html;
    const m = $("#modal .modal"); if (m) m.style.maxWidth = "680px";
    $("#modal").hidden = false; $("#modal").scrollTop = 0;
    return $("#mBody");
  }
  const close = () => { $("#modal").hidden = true; };

  // 신청·제안 폼 (새 일정 또는 시간 변경)
  function openForm({ booking = null, date, block, stage, studentNo }) {
    const b0 = booking;
    const canPickStudent = !isStudent && !b0;
    const stuList = isStudent ? [opts.student] : students().filter((s) => isAdmin || BOOK_STAGES.some((sg) => stageTeachers(s, sg.key).includes(me)));
    if (!isStudent && !stuList.length) return toast("배정된 담당 학생이 없습니다. (관리자는 모든 학생 가능)", "error");
    let sNo = b0?.studentNo || studentNo || (isStudent ? opts.student.studentNo : "");
    const body = modal(b0 ? "시간 변경 제안" : isStudent ? "모의면접 신청" : "일정 잡기", `<form id="bkF">
      ${b0 ? `<div class="notice">지금 일정: <b>${timeText(b0)}</b> · ${esc(b0.room || "장소 미정")} ${statusBadge(b0.status)}<br><span class="muted">바꾸면 상대방이 다시 수락해야 확정됩니다.</span></div>` : ""}
      <div class="grid grid-2" style="gap:0 14px">
        ${isStudent ? "" : `<div class="field"><label>학생 *</label><select name="studentNo" ${canPickStudent ? "" : "disabled"}>
          <option value="">— 학생 선택 —</option>${stuList.map((s) => `<option value="${esc(s.studentNo)}" ${s.studentNo === sNo ? "selected" : ""}>${esc(s.studentNo)} ${esc(s.name)}</option>`).join("")}</select></div>`}
        <div class="field"><label>차수 *</label><select name="stage" ${b0 ? "disabled" : ""}></select></div>
        <div class="field"><label>날짜 *</label><input type="date" name="date" value="${esc(b0?.date || date || isoDay())}" required></div>
        <div class="field"><label>칸 (교시) *</label><select name="block">${st.cfg.blocks.map((x) => `<option value="${x.key}" ${x.key === (b0?.block || block) ? "selected" : ""}>${esc(x.label)} (${x.start}–${x.end})</option>`).join("")}</select></div>
      </div>
      <div class="field"><label>시간 *</label><div id="bkSlots" class="sc-slots"></div></div>
      <div class="field"><label>장소</label><select name="room"></select>
        <input name="roomOther" placeholder="장소 직접 입력 (예: 3-2 교실)" style="margin-top:6px" hidden></div>
      <div class="field"><label>메시지 (선택)</label><input name="memo" maxlength="200" placeholder="${isStudent ? "예: 이 시간이 어려우면 다른 시간 제안 부탁드려요" : "예: 생기부 출력해서 오세요"}"></div>
      <div id="bkTeachers" class="muted" style="margin-bottom:8px"></div>
      <div id="bkWarn"></div>
      ${isAdmin ? `<label class="inline-check" style="margin-bottom:12px"><input type="checkbox" name="force"> 상대 수락 없이 바로 확정 (관리자)</label>` : ""}
      <div class="row"><button class="btn-primary" id="bkSave">${isStudent ? "신청하기" : b0 ? "변경 제안 보내기" : "제안 보내기"}</button><span class="muted" id="bkInfo"></span></div>
    </form>`);
    const f = (n) => $(`[name=${n}]`, body);
    let chosen = null;

    const curStudent = () => isStudent ? opts.student : studentByNo(isStudent ? "" : (f("studentNo")?.value || sNo));
    function fillStages() {
      const s = curStudent();
      const sel = f("stage");
      const want = b0?.stage || Number(sel.value) || stage || 1;
      sel.innerHTML = BOOK_STAGES.map((sg) => {
        const ts = s ? stageTeachers(s, sg.key) : [];
        const allowed = ts.length && (isStudent || isAdmin || ts.includes(me));
        return `<option value="${sg.key}" ${allowed ? "" : "disabled"} ${sg.key === want ? "selected" : ""}>${sg.label}${ts.length ? ` · ${ts.join(", ")}` : " (배정 없음)"}</option>`;
      }).join("");
      if (sel.selectedOptions[0]?.disabled) { const ok = [...sel.options].find((o) => !o.disabled); if (ok) sel.value = ok.value; }
    }
    function fillRooms() {
      const sel = f("room");
      const cur = b0?.room || "";
      const inList = !cur || st.cfg.rooms.includes(cur);
      sel.innerHTML = `<option value="">미정 (${isStudent ? "선생님과 협의" : "나중에 정함"})</option>` +
        st.cfg.rooms.map((r) => `<option ${r === cur ? "selected" : ""}>${esc(r)}</option>`).join("") +
        (isStudent ? (inList ? "" : `<option selected>${esc(cur)}</option>`) : `<option value="__other" ${inList ? "" : "selected"}>기타 (직접 입력)</option>`);
      if (!isStudent && !inList) { f("roomOther").hidden = false; f("roomOther").value = cur; }
      sel.onchange = () => { f("roomOther").hidden = sel.value !== "__other"; check(); };
    }
    const roomVal = () => f("room").value === "__other" ? f("roomOther").value.trim() : f("room").value;

    async function check() {
      const s = curStudent();
      const stageN = Number(f("stage").value);
      const blk = st.cfg.blocks.find((x) => x.key === f("block").value);
      const d = f("date").value;
      const teachers = s ? stageTeachers(s, stageN) : [];
      $("#bkTeachers", body).textContent = teachers.length ? `상대: ${teachers.join(", ")} 선생님${isStudent ? "" : " · " + (s?.name || "") + " 학생"}` : "";
      if (!d || !blk) return;
      if (!(d in st.days)) {
        try { const snap = await getDoc(doc(db, "days", d)); st.days[d] = snap.exists() ? (snap.data().items || {}) : {}; } catch (e) { showError(e, "날짜 일정 확인"); }
      }
      const slots = slotOptions(blk, stageN);
      const base = { studentNo: s?.studentNo || "", teachers, date: d, block: blk.key, room: roomVal() };
      const ctx = { avail: st.avail, actor: me, isAdmin, student: s, bookingId: b0?.id || "" };
      const res = slots.map((sl) => ({ sl, c: findConflicts({ ...base, ...sl }, st.days[d], ctx) }));
      if (!chosen || !res.some((r) => r.sl.start === chosen.start && r.sl.end === chosen.end)) {
        const same = b0 && b0.date === d && b0.block === blk.key ? res.find((r) => r.sl.start === b0.start) : null;
        chosen = (same || res.find((r) => !r.c.some((x) => x.hard)) || res[0])?.sl || null;
      }
      $("#bkSlots", body).innerHTML = res.map(({ sl, c }) => {
        const hard = c.some((x) => x.hard);
        return `<label class="sc-slot ${hard ? "bad" : ""} ${chosen && chosen.start === sl.start ? "on" : ""}"><input type="radio" name="slot" value="${sl.start}" ${chosen && chosen.start === sl.start ? "checked" : ""}> ${sl.start}–${sl.end}${hard ? " · 불가" : ""}</label>`;
      }).join("") || '<span class="muted">이 칸에 들어갈 시간이 없습니다.</span>';
      $$("[name=slot]", body).forEach((r) => r.onchange = () => { chosen = slots.find((x) => x.start === r.value); check(); });
      const cur = res.find((r) => chosen && r.sl.start === chosen.start);
      const cs = cur ? cur.c : [];
      $("#bkWarn", body).innerHTML = cs.map((x) => `<div class="sc-warn ${x.hard ? "hard" : ""}">${x.hard ? "⛔" : "⚠️"} ${esc(x.msg)}</div>`).join("");
      $("#bkSave", body).disabled = !teachers.length || !chosen || (cs.some((x) => x.hard) && !(isAdmin && f("force")?.checked));
    }

    if (f("studentNo")) f("studentNo").onchange = () => { sNo = f("studentNo").value; fillStages(); check(); };
    fillStages(); fillRooms();
    ["stage", "date", "block"].forEach((n) => f(n).onchange = () => { chosen = null; check(); });
    f("roomOther").oninput = () => check();
    if (f("force")) f("force").onchange = check;
    check();

    $("#bkF", body).onsubmit = async (e) => {
      e.preventDefault();
      const s = curStudent();
      if (!s) return toast("학생을 선택하세요.", "error");
      if (f("room").value === "__other" && !f("roomOther").value.trim()) return toast("장소를 입력하세요.", "error");
      const stageN = Number(f("stage").value);
      const teachers = stageTeachers(s, stageN);
      const blk = st.cfg.blocks.find((x) => x.key === f("block").value);
      const force = isAdmin && f("force")?.checked;
      const need = [...teachers, "student"];
      const actorKey = isStudent ? "student" : teachers.includes(me) ? me : "관리자";
      const next = {
        studentNo: s.studentNo, studentName: s.name, cls: s.cls || "", studentUid: s.uid || "",
        stage: stageN, teachers, need,
        date: f("date").value, block: blk.key, start: chosen.start, end: chosen.end, room: roomVal(),
        memo: f("memo").value.trim(),
        approvedBy: force ? need : actorKey === "관리자" ? [] : [actorKey],
        status: force ? "confirmed" : "requested",
        proposedBy: actorKey, updatedAtMs: Date.now(), updatedBy: isStudent ? s.name : me
      };
      if (!b0) Object.assign(next, { requestedBy: actorKey, createdAtMs: Date.now() });
      // 경고(비차단)는 한 번 더 묻기
      const warns = findConflicts(next, st.days[next.date], { avail: st.avail, actor: me, isAdmin, student: s, bookingId: b0?.id || "" });
      const hard = warns.filter((x) => x.hard);
      if (hard.length && !force) return toast(hard[0].msg, "error");
      if (warns.length && !confirm(warns.map((x) => "• " + x.msg).join("\n") + "\n\n그래도 진행할까요?")) return;
      $("#bkSave", body).disabled = true;
      try {
        await commit(b0?.id || null, next, force ? "관리자 확정" : b0 ? "시간 변경 제안" : isStudent ? "신청" : "일정 제안", { force, expectMs: b0?.updatedAtMs });
        close();
        toast(force ? "확정했습니다." : isStudent ? "신청했습니다. 선생님이 수락하면 확정돼요." : "제안을 보냈습니다. 상대가 수락하면 확정돼요.");
        await refresh();
      } catch (err) { if (err.conflict) { toast(err.message, "error", 7000); delete st.days[next.date]; check(); } else showError(err, "일정 저장"); $("#bkSave", body).disabled = false; }
    };
  }

  // 트랜잭션: 일정 문서 + 날짜별 요약 + 로그를 한 번에. 저장 직전에 다시 겹침 검사
  async function commit(id, data, action, { force = false, expectMs = null } = {}) {
    const ref = id ? doc(db, "bookings", id) : doc(collection(db, "bookings"));
    const bid = ref.id;
    const now = Date.now();
    let saved;
    await runTransaction(db, async (tx) => {
      const curSnap = id ? await tx.get(ref) : null;
      const cur = curSnap && curSnap.exists() ? curSnap.data() : null;
      if (id && !cur) throw Object.assign(new Error("일정이 삭제되었습니다. 새로고침하세요."), { conflict: true });
      if (id && expectMs && cur.updatedAtMs !== expectMs) throw Object.assign(new Error("그 사이 다른 사람이 이 일정을 바꿨습니다. 새로고침한 뒤 다시 하세요."), { conflict: true });
      const next = { ...(cur || {}), ...data, updatedAtMs: now };
      const dates = [...new Set([cur && ACTIVE(cur.status) ? cur.date : null, ACTIVE(next.status) ? next.date : null].filter(Boolean))];
      const dayItems = {};
      for (const d of dates) { const s = await tx.get(doc(db, "days", d)); dayItems[d] = s.exists() ? (s.data().items || {}) : {}; }
      // 시간·장소가 그대로이고 이미 자리를 잡고 있던 일정(수락·확정)은 다시 검사하지 않음
      const sameSlot = cur && ACTIVE(cur.status) && ["date", "start", "end", "room"].every((k) => cur[k] === next[k]);
      if (ACTIVE(next.status) && !force && !sameSlot) {
        const hard = findConflicts(next, dayItems[next.date], { avail: st.avail, actor: me, isAdmin, bookingId: bid }).filter((x) => x.hard);
        if (hard.length) throw Object.assign(new Error("방금 다른 일정이 먼저 잡혔어요: " + hard[0].msg), { conflict: true });
      }
      tx.set(ref, next);
      for (const d of dates) {
        const items = { ...dayItems[d] };
        delete items[bid];
        if (ACTIVE(next.status) && next.date === d) {
          items[bid] = { no: next.studentNo, nm: maskName(next.studentName), cls: next.cls || "", stage: next.stage, teachers: next.teachers,
            block: next.block, start: next.start, end: next.end, room: next.room || "", status: next.status };
        }
        tx.set(doc(db, "days", d), { items, lastId: bid, updatedAtMs: now });
      }
      const s = studentByNo(next.studentNo);
      tx.set(doc(collection(db, "bookingLogs")), {
        atMs: now, bookingId: bid, action, by: isStudent ? `${next.studentName}(학생)` : me === "관리자" ? "관리자" : `${me} 선생님`,
        byRole: role, studentNo: next.studentNo, studentName: next.studentName, cls: next.cls || "", studentUid: next.studentUid || "",
        stage: next.stage, teachers: next.teachers, date: next.date, block: next.block, blockLabel: blockLabel(next.block),
        start: next.start, end: next.end, room: next.room || "", status: next.status, memo: data.memo ?? next.memo ?? "",
        meetingType: defaultMeetingType(s),
        waiting: next.status === "requested" ? (next.need || []).filter((n) => !(next.approvedBy || []).includes(n)).map(who).join(", ") : ""
      });
      saved = { id: bid, ...next };
    });
    pingScheduleSync(st.cfg.syncUrl);
    return saved;
  }

  // 일정 상세 + 수락/거절/취소
  async function openDetail(id) {
    let b = st.bookings.find((x) => x.id === id);
    try { const s = await getDoc(doc(db, "bookings", id)); if (s.exists()) b = { id, ...s.data() }; } catch (e) { if (!b) return showError(e, "일정 열기"); }
    if (!b) return toast("일정을 찾을 수 없습니다.", "error");
    const s = studentByNo(b.studentNo);
    const part = isStudent || (b.need || []).includes(me) || isAdmin;
    const iApproved = (b.approvedBy || []).includes(me);
    const act = ACTIVE(b.status);
    const canAccept = b.status === "requested" && (b.need || []).includes(me) && !iApproved;
    const body = modal(`${b.stage}차 모의면접 · ${s?.name || b.studentName}`, `
      <dl class="kv">
        <dt>학생</dt><dd>${esc(b.studentNo)} ${esc(s?.name || b.studentName)}</dd>
        <dt>선생님</dt><dd>${esc((b.teachers || []).join(", "))}</dd>
        <dt>일시</dt><dd><b>${timeText(b)}</b></dd>
        <dt>장소</dt><dd>${esc(b.room || "미정")}</dd>
        <dt>상태</dt><dd>${statusBadge(b.status)}</dd>
        <dt>수락</dt><dd>${(b.need || []).map((n) => `<span class="chip ${(b.approvedBy || []).includes(n) ? "chip-on" : ""}">${esc(who(n))} ${(b.approvedBy || []).includes(n) ? "✓" : "대기"}</span>`).join(" ")}</dd>
        ${b.memo ? `<dt>메시지</dt><dd>“${esc(b.memo)}” <span class="muted">— ${esc(b.updatedBy || "")}</span></dd>` : ""}
      </dl>
      ${part && act ? `<div class="field" style="margin-top:14px"><label>메시지 (선택 · 거절·취소 사유 등)</label><input id="bdMemo" maxlength="200"></div>
      <div class="row">
        ${canAccept ? '<button class="btn-primary" id="bdAccept">수락</button>' : ""}
        <button id="bdChange">시간 변경 제안</button>
        ${canAccept ? '<button class="btn-danger" id="bdReject">거절</button>' : ""}
        <button class="btn-danger" id="bdCancel">일정 취소</button>
        ${isAdmin && b.status !== "confirmed" ? '<button id="bdForce">바로 확정</button>' : ""}
        <div class="spacer"></div>
        ${!isStudent && b.status === "confirmed" && opts.openMeeting ? '<button id="bdMeet">대면 기록 쓰기</button>' : ""}
      </div>` : ""}
      ${!isStudent ? '<h3 style="margin-top:18px">변경 기록</h3><div id="bdLog" class="muted">불러오는 중…</div>' : ""}`);

    const memo = () => $("#bdMemo", body)?.value.trim() || "";
    const run = async (patch, action, msg, extra = {}) => {
      $$("button", body).forEach((x) => x.disabled = true);
      try {
        await commit(b.id, { ...patch, memo: memo() || (patch.memo ?? ""), updatedBy: isStudent ? (s?.name || b.studentName) : me }, action, { expectMs: b.updatedAtMs, ...extra });
        close(); toast(msg); await refresh();
      } catch (err) { if (err.conflict) toast(err.message, "error", 7000); else showError(err, action); $$("button", body).forEach((x) => x.disabled = false); }
    };
    $("#bdAccept", body)?.addEventListener("click", () => {
      const approvedBy = [...new Set([...(b.approvedBy || []), me])];
      const done = (b.need || []).every((n) => approvedBy.includes(n));
      run({ approvedBy, status: done ? "confirmed" : "requested" }, done ? "확정" : "수락", done ? "확정되었습니다." : "수락했습니다. 다른 분의 수락을 기다립니다.");
    });
    $("#bdReject", body)?.addEventListener("click", () => { if (confirm("이 요청을 거절할까요? 시간이 비워집니다.")) run({ status: "rejected" }, "거절", "거절했습니다."); });
    $("#bdCancel", body)?.addEventListener("click", () => { if (confirm("이 일정을 취소할까요? 시간이 비워지고 상대에게도 취소로 보입니다.")) run({ status: "cancelled" }, "취소", "취소했습니다."); });
    $("#bdForce", body)?.addEventListener("click", () => run({ approvedBy: b.need || [], status: "confirmed" }, "관리자 확정", "확정했습니다.", { force: true }));
    $("#bdChange", body)?.addEventListener("click", () => openForm({ booking: b }));
    $("#bdMeet", body)?.addEventListener("click", () => { close(); opts.openMeeting(b); });

    if (!isStudent) {
      try {
        const logs = (await getDocs(query(collection(db, "bookingLogs"), where("bookingId", "==", b.id)))).docs.map((d) => d.data()).sort((x, y) => y.atMs - x.atMs);
        $("#bdLog", body).innerHTML = logs.length ? `<div class="table-wrap"><table><thead><tr><th>시각</th><th>행동</th><th>한 사람</th><th>일시·장소</th><th>메시지</th></tr></thead><tbody>
          ${logs.map((l) => `<tr><td class="nowrap">${fmtDate(l.atMs)}</td><td class="nowrap">${esc(l.action)}</td><td class="nowrap">${esc(l.by)}</td>
            <td>${fmtDay(l.date)} ${l.start}–${l.end} ${esc(l.room || "")}</td><td>${esc(l.memo || "")}</td></tr>`).join("")}</tbody></table></div>` : "기록 없음";
      } catch (e) { $("#bdLog", body).textContent = "기록을 불러오지 못했습니다."; }
    }
  }

  // 교사 불가 시간 (요일별 수업 교시 + 날짜별 예외)
  async function openAvailability() {
    const staff = opts.getStaff?.() || [];
    let target = isAdmin ? (staff.find((t) => t.name === me) || staff[0]) : staff.find((t) => t.id === opts.staffId) || { id: opts.staffId, name: me };
    if (!target?.id) return toast("교사 명단이 없습니다.", "error");
    const body = modal(isAdmin ? "선생님 불가 시간" : "내 불가 시간", `<div id="avBox"></div>`);
    const draw = async () => {
      let av = { weekly: {}, dates: {} };
      try { const s = await getDoc(doc(db, "availability", target.id)); if (s.exists()) av = { weekly: {}, dates: {}, ...s.data() }; } catch (e) { showError(e, "불가 시간 불러오기"); }
      const days = [1, 2, 3, 4, 5];
      $("#avBox", body).innerHTML = `
        ${isAdmin ? `<div class="field"><label>선생님</label><select id="avWho">${staff.map((t) => `<option value="${esc(t.id)}" ${t.id === target.id ? "selected" : ""}>${esc(t.name)}</option>`).join("")}</select></div>` : ""}
        <p class="muted" style="margin-top:0">체크한 칸은 학생 달력에 회색으로 보이고, 학생이 그 시간에 신청할 수 없습니다. (선생님 본인이 제안하는 건 가능)</p>
        <h3>매주 반복 (수업 시간 등)</h3>
        <div class="table-wrap"><table class="av-grid"><thead><tr><th></th>${days.map((d) => `<th>${WEEK[d]}</th>`).join("")}</tr></thead><tbody>
          ${st.cfg.blocks.map((blk) => `<tr><th class="nowrap">${esc(blk.label)}</th>${days.map((d) => `<td><input type="checkbox" data-w="${d}" value="${blk.key}" ${(av.weekly[d] || []).includes(blk.key) ? "checked" : ""}></td>`).join("")}</tr>`).join("")}
        </tbody></table></div>
        <h3 style="margin-top:16px">날짜별 (출장·회의 등)</h3>
        <div class="row"><input type="date" id="avDate" style="width:auto"><select id="avBlocks" multiple size="4" style="width:auto;min-width:150px">${st.cfg.blocks.map((blk) => `<option value="${blk.key}">${esc(blk.label)}</option>`).join("")}</select>
          <button type="button" class="btn-sm" id="avAll">하루 종일</button><button type="button" class="btn-sm" id="avAdd">추가</button></div>
        <div id="avDates" style="margin-top:8px"></div>
        <div class="row" style="margin-top:14px"><button class="btn-primary" id="avSave">저장</button></div>`;
      const dates = { ...av.dates };
      const drawDates = () => {
        const keys = Object.keys(dates).filter((k) => k >= isoDay()).sort();
        $("#avDates", body).innerHTML = keys.length ? keys.map((k) => `<div class="row sc-miss"><b>${fmtDay(k)}</b> <span class="muted">${dates[k].length >= st.cfg.blocks.length ? "하루 종일" : dates[k].map(blockLabel).join(", ")}</span><div class="spacer"></div><button type="button" class="btn-sm btn-danger" data-rm="${k}">삭제</button></div>`).join("") : '<span class="muted">없음</span>';
        $$("[data-rm]", body).forEach((x) => x.onclick = () => { delete dates[x.dataset.rm]; drawDates(); });
      };
      drawDates();
      $("#avAll", body).onclick = () => [...$("#avBlocks", body).options].forEach((o) => o.selected = true);
      $("#avAdd", body).onclick = () => {
        const d = $("#avDate", body).value, sel = [...$("#avBlocks", body).selectedOptions].map((o) => o.value);
        if (!d || !sel.length) return toast("날짜와 칸을 고르세요.", "error");
        dates[d] = [...new Set([...(dates[d] || []), ...sel])]; drawDates();
      };
      $("#avWho", body)?.addEventListener("change", (e) => { target = staff.find((t) => t.id === e.target.value); draw(); });
      $("#avSave", body).onclick = async () => {
        const weekly = {};
        $$("[data-w]:checked", body).forEach((c) => (weekly[c.dataset.w] ||= []).push(c.value));
        const clean = Object.fromEntries(Object.entries(dates).filter(([k]) => k >= isoDay()));
        try {
          await setDoc(doc(db, "availability", target.id), { name: target.name, weekly, dates: clean, updatedAtMs: Date.now() });
          st.avail[target.name] = { id: target.id, name: target.name, weekly, dates: clean };
          toast("저장했습니다."); close(); render();
        } catch (e) { showError(e, "불가 시간 저장"); }
      };
    };
    draw();
  }

  refresh();
  return { refresh, render, openForm };
}
