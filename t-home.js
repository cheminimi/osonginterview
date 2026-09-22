// 교사 화면 · '오늘'
//
// 화면 너비에 따라 구성이 둘로 갈린다. 데이터·인증·저장 로직은 완전히 공유하고,
// 그리는 부분(HTML + 그 화면에만 필요한 클릭 연결)만 나눈다.
//   · 720px 이하(휴대폰) → renderNarrow() : 예전 구성 (수락 대기 → 오늘 면접 → 할 일 → 다가오는 면접)
//   · 721px 이상(컴퓨터) → renderWide()   : 새 구성 (인사말 → 요약 카드 3개 → 2단 → 담당 학생 준비 현황)
//
// 한 번에 한 쪽만 DOM에 들어가므로 id 가 겹치지 않는다.
// 너비가 바뀌면 matchMedia 로 한 번만 다시 그린다(리스너는 모듈당 1개, 구독은 건드리지 않음).
import { $, $$, esc, icon, isoDay, fmtDay, fmtDate, dday, nextInterview, toDate } from "./common.js";
import { S, register, rerender, myName, myRoles, switchTab, setDot, opt } from "./t-core.js";
import { openStudent } from "./t-students.js";
import { openMeetingForm } from "./t-meetings.js";
import { openBookingRecord, gotoSchedule } from "./t-schedule.js";
import { BOOK_STAGES, stageTeachers, ACTIVE } from "./schedule.js";

const WIDE = window.matchMedia("(min-width: 721px)");
const WEEK = "일월화수목금토";
const nameOf = (no) => S.students.find((s) => s.studentNo === no)?.name || "";
const dayOnly = (v) => fmtDay(v).replace(/\(.\)$/, "").trim();

let root = null;
let wasWide = WIDE.matches;
let listening = false;
let filter = "all";   // 컴퓨터 화면 표 필터: all | soon | fb | norec | nosched

export function init(el) {
  root = el;
  register("home", render);
  if (!listening) {   // 리스너는 딱 한 번만 (중복 등록 방지)
    listening = true;
    const onChange = () => {
      if (WIDE.matches === wasWide) return;
      wasWide = WIDE.matches;
      render();
    };
    WIDE.addEventListener ? WIDE.addEventListener("change", onChange) : WIDE.addListener(onChange);
  }
}

// ================= 공통 데이터 (두 화면이 같이 쓴다) =================
function collect() {
  const me = myName();
  const today = isoDay();
  const now = new Date();
  const mine = me ? S.students.filter((s) => myRoles(s, me).length) : [];
  const scope = me ? mine : S.students;   // 이름 미지정 관리자는 전체 기준

  const mineToday = (S.bookings || [])
    .filter((b) => b.date === today && ACTIVE(b.status) && (!me || (b.teachers || []).includes(me)))
    .sort((a, b) => a.start.localeCompare(b.start));

  const noRecord = S.meetings
    .filter((m) => m.planned && (!me || (m.teachers || []).includes(me)) && (m.date || "") <= today)
    .sort((a, b) => (b.date || "").localeCompare(a.date || ""));

  const pending = S.sessions.filter((x) => x.status === "submitted" && !x.reviewedAt);

  const need = (S.needMine || []).filter((b) => ACTIVE(b.status))
    .sort((a, b) => (a.date + a.start).localeCompare(b.date + b.start));

  const missing = [];
  for (const s of scope) {
    for (const sg of BOOK_STAGES) {
      const ts = stageTeachers(s, sg.key);
      if (!ts.length || (me && !ts.includes(me))) continue;
      if (!(S.bookings || []).some((b) => b.studentNo === s.studentNo && b.stage === sg.key && ACTIVE(b.status))) missing.push({ s, sg });
    }
  }
  return { me, today, now, mine, scope, mineToday, noRecord, pending, need, missing };
}

const noticeHtml = (me) => !S.ctx.profile ? `<div class="notice row">
  <span>관리자 이메일로 로그인했습니다. 배정표의 내 이름을 고르면 '내 담당'이 보입니다.</span>
  <select id="pickName" style="width:auto">${opt(S.staff.map((t) => t.name), me, "— 선택 —")}</select></div>` : "";

// ================= 그리기 =================
function render() {
  if (!root) return;
  const d = collect();
  setDot("#todayDot", WIDE.matches ? d.need.length + d.noRecord.length : d.need.length + d.pending.length);
  // 한 번에 한 쪽만 들어간다 → id 중복 없음. innerHTML 교체라 옛 핸들러도 함께 사라진다.
  root.innerHTML = `<div id="homeBody">${WIDE.matches ? wideHtml(d) : narrowHtml(d)}</div>`;
  bindCommon(d);
  if (WIDE.matches) bindWide(d); else bindNarrow(d);
}

// 두 화면에 공통으로 있는 것만 연결
function bindCommon() {
  $("#pickName", root)?.addEventListener("change", (e) => {
    try { localStorage.setItem("myStaffName", e.target.value); } catch (_) {}
    rerender();
  });
  $("#goNeed", root)?.addEventListener("click", () => gotoSchedule());
  $$("[data-go]", root).forEach((b) => b.onclick = () => switchTab(b.dataset.go));
  $$("[data-rec]", root).forEach((b) => b.onclick = () => {
    const bk = (S.bookings || []).find((x) => x.id === b.dataset.rec);
    if (bk) openBookingRecord(bk);
  });
  $$("[data-no]", root).forEach((b) => b.onclick = () => openStudent(b.dataset.no));
  $$("[data-meet]", root).forEach((b) => b.onclick = () => openMeetingForm({ id: b.dataset.meet }));
}

// ================= 컴퓨터 화면 (721px 이상) =================
function wideHtml({ me, now, mine, mineToday, noRecord, pending, need }) {
  return `
    ${noticeHtml(me)}
    <div class="greet-date">${now.getMonth() + 1}월 ${now.getDate()}일 ${WEEK[now.getDay()]}요일${mine.length ? ` · 담당 ${mine.length}명` : ""}</div>
    <div class="greet-h">${esc(me ? me + " 선생님" : S.ctx.isAdmin ? "관리자님" : "선생님")}, 오늘도 힘내세요!</div>
    <div class="greet-s" style="margin-bottom:20px">오늘의 면접 일정을 확인하고 피드백을 작성해주세요.</div>

    <div class="sum" id="sumCards">
      <button type="button" data-go="schedule">
        <span class="ic">${icon("calendar", 22)}</span>
        <span class="tx"><span class="lab">오늘 면접</span><span class="n">${mineToday.length}건</span></span>
      </button>
      <button type="button" data-scroll="fbCard">
        <span class="ic faint">${icon("note", 22)}</span>
        <span class="tx"><span class="lab">작성할 피드백</span><span class="n">${noRecord.length}건</span></span>
      </button>
      <button type="button" data-go="schedule">
        <span class="ic warn">${icon("clock", 22)}</span>
        <span class="tx"><span class="lab">일정 승인 대기</span><span class="n">${need.length}건</span></span>
      </button>
    </div>

    <div class="cols">
      <div>
        <div class="head-row"><h3>오늘의 면접 일정</h3>
          <button type="button" class="go" data-go="schedule">전체 일정 →</button></div>
        <section class="card sched-card">${mineToday.length ? mineToday.map((b, i) => {
          const s = S.students.find((x) => x.studentNo === b.studentNo);
          const done = S.meetings.some((m) => m.id === "bk_" + b.id && !m.planned);
          const others = (b.teachers || []).filter((t) => t !== me);
          const nowHm = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
          const isNext = i === mineToday.findIndex((x) => x.end >= nowHm);
          return `<div class="srow ${isNext ? "now" : ""}">
            <div class="stime">${isNext ? '<span class="tag">다음 면접</span>' : ""}
              <b>${esc(b.start)} – ${esc(b.end)}</b><span>${esc(S.blockLabel(b.block) || "")}</span></div>
            <button type="button" class="sbody" data-no="${esc(b.studentNo)}">
              <b>${esc(s?.name || b.studentName || "")}</b> <span class="muted" style="display:inline">${esc(b.studentNo)}</span>
              <span>${b.stage}차 · ${esc(s?.track || "")}${others.length ? " · " + esc(others.join("·")) + " 선생님과" : ""}</span>
            </button>
            <div class="sroom">${icon("pin", 16)}${esc(b.room || "장소 미정")}</div>
            <button type="button" class="${done ? "btn-sm" : "btn-primary"}" data-rec="${esc(b.id)}">${done ? "기록 보기" : "기록 쓰기"}</button>
          </div>`;
        }).join("") : `<div class="empty">오늘 잡힌 면접이 없어요.</div>`}</section>
      </div>

      <div>
        <section class="card" id="fbCard">
          <div class="head-row"><h3>작성할 피드백</h3>
            ${noRecord.length ? `<span class="badge badge-blue">${noRecord.length}</span>` : ""}</div>
          ${noRecord.length ? noRecord.slice(0, 5).map((m) => `<div class="frow">
            <span class="tx"><b>${esc(nameOf(m.studentNo) || m.name || "")}</b>
              <small>${dayOnly(m.date)} · ${m.stage}차 면접</small></span>
            <button type="button" class="go" data-meet="${esc(m.id)}">기록 쓰기 →</button>
          </div>`).join("") : `<p class="muted" style="margin:14px 0 4px">밀린 기록이 없어요.</p>`}
          <div class="card-foot">
            <span style="font-size:.9rem;color:var(--ink-2)">검토를 기다리는 연습</span>
            <span class="badge badge-orange" id="pendingDot">${pending.length || ""}</span>
            <button type="button" class="go" data-go="review">연습 리뷰 →</button>
          </div>
        </section>

        ${need.length ? `<section class="ask">
          <div class="head-row"><h3>일정 승인 요청</h3><span class="badge badge-orange">${need.length}건</span></div>
          ${need.slice(0, 2).map((b) => `<div class="line"><b>${esc(nameOf(b.studentNo) || b.studentName || "")}</b> · ${b.stage}차 면접
            <small>${fmtDay(b.date)} ${esc(b.start)} – ${esc(b.end)} · ${esc(b.room || "장소 미정")}</small></div>`).join("")}
          ${need.length > 2 ? `<div class="line muted">외 ${need.length - 2}건</div>` : ""}
          <button type="button" class="btn-primary" id="goNeed">요청 확인</button>
        </section>` : ""}
      </div>
    </div>

    <section class="card" style="margin-top:16px">
      <div class="head-row"><h3>담당 학생 준비 현황</h3><span class="n" id="rowCount"></span>
        <button type="button" class="go" data-go="students">학생 전체 →</button></div>
      <div class="tbl-bar">
        <div class="search-box"><span>${icon("search", 17)}</span>
          <input type="search" id="hSearch" placeholder="이름 · 학번 검색" aria-label="이름 또는 학번"></div>
        <div class="spacer"></div>
        <div class="chips" id="hChips">
          <button type="button" data-f="all">전체</button>
          <button type="button" data-f="soon">면접 임박</button>
          <button type="button" data-f="fb">피드백 대기</button>
          <button type="button" data-f="norec">기록 없음</button>
          <button type="button" data-f="nosched">일정 없음</button>
        </div>
      </div>
      <div class="table-wrap"><table class="plain rows-sm">
        <thead><tr><th>학생</th><th>면접 유형</th><th>최근 활동</th><th>지도 상태</th><th>바로가기</th></tr></thead>
        <tbody id="hBody"></tbody></table></div>
    </section>`;
}

function bindWide({ scope }) {
  $$("[data-scroll]", root).forEach((b) => b.onclick = () => $("#" + b.dataset.scroll, root)?.scrollIntoView({ behavior: "smooth", block: "center" }));
  $("#hSearch", root).oninput = () => renderRows(scope);
  $$("#hChips button", root).forEach((b) => {
    b.classList.toggle("on", b.dataset.f === filter);
    b.onclick = () => { filter = b.dataset.f; $$("#hChips button", root).forEach((x) => x.classList.toggle("on", x === b)); renderRows(scope); };
  });
  renderRows(scope);
}

// 담당 학생 준비 현황 표 (컴퓨터 화면 전용)
function renderRows(scope) {
  const me = myName();
  const kw = ($("#hSearch", root)?.value || "").trim();
  const noRec = (s) => !S.meetings.some((m) => m.studentNo === s.studentNo && !m.planned);
  const waitingFb = (s) => S.meetings.some((m) => m.studentNo === s.studentNo && m.planned)
    || S.sessions.some((x) => x.studentNo === s.studentNo && x.status === "submitted" && !x.reviewedAt);
  const noSched = (s) => BOOK_STAGES.some((sg) => {
    const ts = stageTeachers(s, sg.key);
    if (!ts.length || (me && !ts.includes(me))) return false;
    return !(S.bookings || []).some((b) => b.studentNo === s.studentNo && b.stage === sg.key && ACTIVE(b.status));
  });

  let list = scope.filter((s) =>
    (!kw || `${s.name}${s.studentNo}`.includes(kw))
    && (filter !== "soon" || (nextInterview(s) && dday(nextInterview(s)) <= 14))
    && (filter !== "fb" || waitingFb(s))
    && (filter !== "norec" || noRec(s))
    && (filter !== "nosched" || noSched(s)));
  list = [...list].sort((a, b) => (nextInterview(a) || 9e15) - (nextInterview(b) || 9e15));
  $("#rowCount", root).textContent = `${list.length}명`;

  if (!list.length) {
    $("#hBody", root).innerHTML = `<tr><td colspan="5" class="empty" data-l="-">${scope.length ? "조건에 맞는 학생이 없습니다." : "담당 학생이 없습니다."}</td></tr>`;
    return;
  }
  $("#hBody", root).innerHTML = list.slice(0, 12).map((s) => {
    const iv = nextInterview(s);
    const n = iv ? dday(iv) : null;
    const lastSess = S.sessions.filter((x) => x.studentNo === s.studentNo && x.status === "submitted")
      .sort((a, b) => (b.submittedAt?.seconds || 0) - (a.submittedAt?.seconds || 0))[0];
    const lastMeet = S.meetings.filter((m) => m.studentNo === s.studentNo && !m.planned)
      .sort((a, b) => (b.date || "").localeCompare(a.date || ""))[0];
    const sTime = (lastSess?.submittedAt?.seconds || 0) * 1000;
    const mTime = lastMeet ? (toDate(lastMeet.date)?.getTime() || 0) : 0;
    const act = !sTime && !mTime ? '<span class="muted">아직 없음</span>'
      : sTime >= mTime ? `${fmtDate(lastSess.submittedAt)} 연습 제출`
      : `${dayOnly(lastMeet.date)} ${lastMeet.stage}차 기록`;
    const [lab, cls, go, label] = waitingFb(s) ? ["피드백 대기", "orange", "fb", "피드백 쓰기 →"]
      : noSched(s) ? ["일정 없음", "gray", "sched", "일정 잡기 →"]
      : n != null && n <= 14 ? ["면접 임박", "red", "open", "학생 보기 →"]
      : noRec(s) ? ["기록 없음", "gray", "open", "학생 보기 →"]
      : ["확인 완료", "green", "open", "학생 보기 →"];
    return `<tr><td class="nowrap head" data-l="-"><b>${esc(s.name)}</b> <span class="muted">${esc(s.studentNo)}</span>
        ${n != null ? `<span class="badge badge-${n <= 7 ? "red" : n <= 21 ? "orange" : "blue"}">${n === 0 ? "D-DAY" : "D-" + n}</span>` : ""}</td>
      <td class="pack" data-l="유형">${esc(s.track || "-")}</td>
      <td class="nowrap pack" data-l="최근">${act}</td>
      <td data-l="-"><span class="badge badge-${cls}">${lab}</span></td>
      <td data-l="-"><button type="button" class="go" data-row="${esc(s.studentNo)}" data-act="${go}">${label}</button></td></tr>`;
  }).join("");
  $$("#hBody [data-row]", root).forEach((b) => b.onclick = () => {
    if (b.dataset.act === "sched") return gotoSchedule();
    if (b.dataset.act === "fb") {
      const m = S.meetings.find((x) => x.studentNo === b.dataset.row && x.planned);
      if (m) return openMeetingForm({ id: m.id });
      return switchTab("review");
    }
    openStudent(b.dataset.row);
  });
}

// ================= 휴대폰 화면 (720px 이하) — 예전 구성 =================
function narrowHtml({ me, now, mine, mineToday, noRecord, pending, need, missing }) {
  const missBy = BOOK_STAGES.map((sg) => `${sg.short} ${missing.filter((x) => x.sg.key === sg.key).length}`).join(", ");
  const line2 = `${now.getMonth() + 1}월 ${now.getDate()}일 ${WEEK[now.getDay()]}요일${mine.length ? ` · 담당 ${mine.length}명` : ""}`;
  return `
    ${noticeHtml(me)}

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

    <div class="sec-head"><h2>다가오는 면접</h2></div>
    <div class="list-card">${soonHtml()}</div>`;
}

function bindNarrow() { /* 휴대폰 화면의 클릭은 모두 bindCommon 이 처리한다 */ }

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
      <span class="r-day"><b>${n === 0 ? "D-DAY" : "D-" + n}</b><span>${dayOnly(d)}</span></span>
      <span class="r-tx"><b>${esc(s.name)}</b> <span class="muted" style="display:inline">${esc(s.studentNo)}</span>
        <span class="muted">${esc(u ? `${u.univ} ${u.dept || ""}` : s.track || "")}${roles.length ? " · 내 역할 " + roles.join("·") : ""}</span></span>
      <span class="r-end">${icon("chevron", 18)}</span></button>`;
  }).join("");
}
