// 교사 화면 · '오늘' — 수락 대기 → 오늘 면접 → 할 일
import { $, $$, esc, icon, isoDay, fmtDay, dday, nextInterview } from "./common.js";
import { S, register, rerender, myName, myRoles, switchTab, setDot, opt } from "./t-core.js";
import { openStudent } from "./t-students.js";
import { openMeetingForm } from "./t-meetings.js";
import { openBookingRecord, gotoSchedule } from "./t-schedule.js";
import { BOOK_STAGES, stageTeachers, ACTIVE } from "./schedule.js";

let root;
export function init(el) {
  root = el;
  register("home", render);
}

const WEEK = "일월화수목금토";
const nameOf = (no) => S.students.find((s) => s.studentNo === no)?.name || "";

function render() {
  const me = myName();
  const today = isoDay();
  const now = new Date();
  const mine = me ? S.students.filter((s) => myRoles(s, me).length) : [];

  // ---- 수락 대기: 내 응답이 필요한 요청
  const need = (S.needMine || []).filter((b) => ACTIVE(b.status))
    .sort((a, b) => (a.date + a.start).localeCompare(b.date + b.start));

  // ---- 오늘 면접: 내가 들어가는 오늘 일정
  const mineToday = (S.bookings || [])
    .filter((b) => b.date === today && ACTIVE(b.status) && (!me || (b.teachers || []).includes(me)))
    .sort((a, b) => a.start.localeCompare(b.start));

  // ---- 할 일
  const noRecord = S.meetings.filter((m) => m.planned && (!me || (m.teachers || []).includes(me)) && (m.date || "") <= today)
    .sort((a, b) => (b.date || "").localeCompare(a.date || ""));
  const mineSet = new Set(mine.map((s) => s.studentNo));
  const pending = S.sessions.filter((x) => x.status === "submitted" && !x.reviewedAt);
  const missing = [];
  for (const s of (S.ctx.isAdmin && !me ? S.students : mine)) {
    for (const sg of BOOK_STAGES) {
      const ts = stageTeachers(s, sg.key);
      if (!ts.length || (me && !ts.includes(me))) continue;
      if (!(S.bookings || []).some((b) => b.studentNo === s.studentNo && b.stage === sg.key && ACTIVE(b.status))) missing.push({ s, sg });
    }
  }
  const missBy = BOOK_STAGES.map((sg) => `${sg.short} ${missing.filter((x) => x.sg.key === sg.key).length}`).join(", ");
  setDot("#todayDot", need.length + pending.length);

  const line2 = `${now.getMonth() + 1}월 ${now.getDate()}일 ${WEEK[now.getDay()]}요일${mine.length ? ` · 담당 ${mine.length}명` : ""}`;

  root.innerHTML = `
    ${!S.ctx.profile ? `<div class="notice row">
      <span>관리자 이메일로 로그인했습니다. 배정표의 내 이름을 고르면 '내 담당'이 보입니다.</span>
      <select id="pickName" style="width:auto">${opt(S.staff.map((t) => t.name), me, "— 선택 —")}</select></div>` : ""}

    <div class="me-row"><div style="flex:1;min-width:0">
      <div class="me-name">${esc(me ? me + " 선생님" : S.ctx.isAdmin ? "관리자" : "선생님")}</div>
      <div class="me-sub">${esc(line2)}${me ? "" : " · " + esc(S.ctx.account?.loginId || S.ctx.user.email)}</div>
    </div></div>

    ${need.length ? `<div class="todo-main">
      <span class="t-ic">${icon("clock", 20)}</span>
      <div style="flex:1;min-width:0">
        <b>수락을 기다리는 요청 ${need.length}건</b>
        <span class="muted">${need.slice(0, 3).map((b) => `${esc(nameOf(b.studentNo) || b.studentName || "")} ${b.stage}차 · ${fmtDay(b.date)} ${esc(S.blockLabel(b.block) || "")}`).join("<br>")}${need.length > 3 ? `<br>외 ${need.length - 3}건` : ""}</span>
        <button type="button" class="btn-primary" id="goNeed">일정에서 처리하기</button>
      </div>
    </div>` : ""}

    <div class="sec-head"><h2>오늘 면접</h2><span class="n">${mineToday.length || ""}</span></div>
    <div class="list-card" id="todayList">${mineToday.length ? mineToday.map((b) => {
      const s = S.students.find((x) => x.studentNo === b.studentNo);
      const done = S.meetings.some((m) => m.id === "bk_" + b.id && !m.planned);
      const others = (b.teachers || []).filter((t) => t !== me);
      return `<div class="list-row" style="cursor:default">
        <span class="r-day"><b>${esc(S.blockLabel(b.block) || "")}</b><span>${esc(b.start)}</span></span>
        <button type="button" class="r-tx" data-no="${esc(b.studentNo)}">
          <b>${esc(s?.name || b.studentName || "")}</b> <span class="muted" style="display:inline">${esc(b.studentNo)}</span> · ${b.stage}차
          <span class="muted">${esc(b.room || "장소 미정")} · ${esc(b.start)}–${esc(b.end)}${others.length ? " · " + esc(others.join("·")) + " 선생님과" : ""}</span>
        </button>
        <button type="button" class="btn-sm ${done ? "" : "btn-primary"}" data-rec="${esc(b.id)}">${done ? "기록 보기" : "기록"}</button>
      </div>`;
    }).join("") : `<div class="empty">오늘 잡힌 면접이 없어요.</div>`}</div>

    <div class="sec-head"><h2>할 일</h2></div>
    <div class="list-card" id="todoCard">
      ${todoRow("note", noRecord.length, "danger", "기록을 쓰지 않은 면접",
        noRecord.length ? noRecord.slice(0, 3).map((m) => `${fmtDay(m.date)} ${esc(nameOf(m.studentNo) || m.name || "")}`).join(" · ") : "모두 썼어요",
        "쓰기", "meetings")}
      ${todoRow("mic", pending.length, "warn", "검토를 기다리는 연습 답변",
        pending.length ? "한 줄 피드백만 써도 학생에게 바로 보여요" : "밀린 검토가 없어요",
        "보기", "review", "pendingDot")}
      ${todoRow("calendar", missing.length, "ink", "일정을 아직 안 잡은 차수",
        missing.length ? missBy : "모두 잡혔어요",
        "잡기", "schedule")}
    </div>

    <div class="sec-head"><h2>2주 안에 면접</h2></div>
    <div class="list-card">${soonHtml()}</div>`;

  $("#pickName", root)?.addEventListener("change", (e) => {
    try { localStorage.setItem("myStaffName", e.target.value); } catch (_) {}
    rerender();
  });
  $("#goNeed", root)?.addEventListener("click", () => gotoSchedule());
  $$("[data-rec]", root).forEach((b) => b.onclick = () => {
    const bk = (S.bookings || []).find((x) => x.id === b.dataset.rec);
    if (bk) openBookingRecord(bk);
  });
  $$("[data-no]", root).forEach((b) => b.onclick = () => openStudent(b.dataset.no));
  $$("[data-go]", root).forEach((b) => b.onclick = () => switchTab(b.dataset.go));
}

function todoRow(ic, n, tone, title, desc, cta, go, id = "") {
  const color = n === 0 ? "var(--ink-3)" : tone === "danger" ? "var(--danger)" : tone === "warn" ? "var(--warn)" : "var(--ink)";
  return `<div class="list-row" style="cursor:default">
    <span class="r-ic" style="color:${color}">${icon(ic, 20)}</span>
    <span class="r-num" style="color:${color}"${id ? ` id="${id}"` : ""}>${n}</span>
    <span class="r-tx"><b>${esc(title)}</b><span class="muted">${desc}</span></span>
    <button type="button" class="btn-sm" data-go="${go}" data-tab="${go}">${esc(cta)}</button>
  </div>`;
}

function soonHtml() {
  const list = S.students
    .map((s) => ({ s, d: nextInterview(s) }))
    .filter((x) => x.d && dday(x.d) <= 14)
    .sort((a, b) => a.d - b.d)
    .slice(0, 12);
  if (!list.length) return '<div class="empty">2주 안에 면접 보는 학생이 없어요.</div>';
  const me = myName();
  return list.map(({ s, d }) => {
    const n = dday(d);
    const u = (s.universities || []).find((x) => x.date && fmtDay(x.date) === fmtDay(d));
    const roles = myRoles(s, me);
    return `<button type="button" class="list-row" data-no="${esc(s.studentNo)}">
      <span class="r-day"><b>${n === 0 ? "D-DAY" : "D-" + n}</b><span>${fmtDay(d).replace(/\(.\)$/, "")}</span></span>
      <span class="r-tx"><b>${esc(s.name)}</b> <span class="muted" style="display:inline">${esc(s.studentNo)}</span>
        <span class="muted">${esc(u ? `${u.univ} ${u.dept || ""}` : s.track || "")}${roles.length ? " · 내 역할 " + roles.join("·") : ""}</span></span>
      <span class="r-end">${icon("chevron", 18)}</span></button>`;
  }).join("");
}
