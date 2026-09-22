// 교사 화면 · '오늘'
// 인사말 → 요약 카드 3개 → (오늘의 면접 일정 | 작성할 피드백 + 일정 승인 요청) → 담당 학생 준비 현황
import { $, $$, esc, icon, isoDay, fmtDay, fmtDate, dday, nextInterview, toDate } from "./common.js";
import { S, register, rerender, myName, myRoles, switchTab, setDot, opt } from "./t-core.js";
import { openStudent } from "./t-students.js";
import { openMeetingForm } from "./t-meetings.js";
import { openBookingRecord, gotoSchedule } from "./t-schedule.js";
import { BOOK_STAGES, stageTeachers, ACTIVE } from "./schedule.js";

let root;
let filter = "all";   // all | soon | fb | norec | nosched
export function init(el) {
  root = el;
  register("home", render);
}

const WEEK = "일월화수목금토";
const nameOf = (no) => S.students.find((s) => s.studentNo === no)?.name || "";
const dayOnly = (v) => fmtDay(v).replace(/\(.\)$/, "").trim();

function render() {
  const me = myName();
  const today = isoDay();
  const now = new Date();
  const mine = me ? S.students.filter((s) => myRoles(s, me).length) : [];
  const scope = me ? mine : S.students;   // 이름 미지정 관리자는 전체 기준

  // ---- 오늘 면접 (내가 들어가는 것)
  const mineToday = (S.bookings || [])
    .filter((b) => b.date === today && ACTIVE(b.status) && (!me || (b.teachers || []).includes(me)))
    .sort((a, b) => a.start.localeCompare(b.start));

  // ---- 작성할 피드백 = 면접은 했는데 기록이 비어 있는 것
  const noRecord = S.meetings
    .filter((m) => m.planned && (!me || (m.teachers || []).includes(me)) && (m.date || "") <= today)
    .sort((a, b) => (b.date || "").localeCompare(a.date || ""));
  // ---- 검토를 기다리는 연습 답변
  const pending = S.sessions.filter((x) => x.status === "submitted" && !x.reviewedAt);
  // ---- 수락 대기
  const need = (S.needMine || []).filter((b) => ACTIVE(b.status))
    .sort((a, b) => (a.date + a.start).localeCompare(b.date + b.start));

  setDot("#todayDot", need.length + noRecord.length);

  root.innerHTML = `
    ${!S.ctx.profile ? `<div class="notice row">
      <span>관리자 이메일로 로그인했습니다. 배정표의 내 이름을 고르면 '내 담당'이 보입니다.</span>
      <select id="pickName" style="width:auto">${opt(S.staff.map((t) => t.name), me, "— 선택 —")}</select></div>` : ""}

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
          const isNext = i === mineToday.findIndex((x) => x.end >= `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`);
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
          </div>`).join("") : `<p class="muted" style="margin:14px 0 4px">밀린 기록이 없어요. 👍</p>`}
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

  $("#pickName", root)?.addEventListener("change", (e) => {
    try { localStorage.setItem("myStaffName", e.target.value); } catch (_) {}
    rerender();
  });
  $("#goNeed", root)?.addEventListener("click", () => gotoSchedule());
  $$("[data-go]", root).forEach((b) => b.onclick = () => switchTab(b.dataset.go));
  $$("[data-scroll]", root).forEach((b) => b.onclick = () => $("#" + b.dataset.scroll, root)?.scrollIntoView({ behavior: "smooth", block: "center" }));
  $$("[data-rec]", root).forEach((b) => b.onclick = () => {
    const bk = (S.bookings || []).find((x) => x.id === b.dataset.rec);
    if (bk) openBookingRecord(bk);
  });
  $$("[data-meet]", root).forEach((b) => b.onclick = () => openMeetingForm({ id: b.dataset.meet }));
  $$("[data-no]", root).forEach((b) => b.onclick = () => openStudent(b.dataset.no));
  $("#hSearch", root).oninput = () => renderRows(scope);
  $$("#hChips button", root).forEach((b) => {
    b.classList.toggle("on", b.dataset.f === filter);
    b.onclick = () => { filter = b.dataset.f; $$("#hChips button", root).forEach((x) => x.classList.toggle("on", x === b)); renderRows(scope); };
  });
  renderRows(scope);
}

// ---- 담당 학생 준비 현황 표
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
    // 최근 활동: 마지막 연습 제출 / 마지막 면접 기록 중 늦은 것
    const lastSess = S.sessions.filter((x) => x.studentNo === s.studentNo && x.status === "submitted")
      .sort((a, b) => (b.submittedAt?.seconds || 0) - (a.submittedAt?.seconds || 0))[0];
    const lastMeet = S.meetings.filter((m) => m.studentNo === s.studentNo && !m.planned)
      .sort((a, b) => (b.date || "").localeCompare(a.date || ""))[0];
    const sTime = (lastSess?.submittedAt?.seconds || 0) * 1000;
    const mTime = lastMeet ? (toDate(lastMeet.date)?.getTime() || 0) : 0;
    const act = !sTime && !mTime ? '<span class="muted">아직 없음</span>'
      : sTime >= mTime ? `${fmtDate(lastSess.submittedAt)} 연습 제출`
      : `${dayOnly(lastMeet.date)} ${lastMeet.stage}차 기록`;
    // 지도 상태
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
