// 교사 화면 · '오늘'
//
// 화면 너비에 따라 구성이 둘로 갈린다. 데이터·인증·저장 로직은 완전히 공유하고,
// 그리는 부분(HTML + 그 화면에만 필요한 클릭 연결)만 나눈다.
//   · 720px 이하(휴대폰) → renderNarrow() : 예전 구성 (수락 대기 → 오늘 면접 → 할 일 → 다가오는 면접)
//   · 721px 이상(컴퓨터) → renderWide()   : 새 구성 (인사말 → 요약 카드 3개 → 2단 → 담당 학생 준비 현황)
//
// 한 번에 한 쪽만 DOM에 들어가므로 id 가 겹치지 않는다.
// 너비가 바뀌면 matchMedia 로 한 번만 다시 그린다(리스너는 모듈당 1개, 구독은 건드리지 않음).
import { $, $$, esc, icon, isoDay, fmtDay, fmtDate, dday, nextInterview, toDate, initials } from "./common.js";
import { S, register, rerender, myName, myRoles, switchTab, setDot, opt, applyHead } from "./t-core.js";
import { openStudent } from "./t-students.js";
import { openMeetingForm, recordWrittenFor } from "./t-meetings.js";
import { openBookingRecord, gotoSchedule, quickBooking } from "./t-schedule.js";
import { BOOK_STAGES, stageTeachers, ACTIVE, DONE } from "./schedule.js";

const WIDE = window.matchMedia("(min-width: 721px)");
const WEEK = "일월화수목금토";
const nameOf = (no) => S.students.find((s) => s.studentNo === no)?.name || "";
const dayOnly = (v) => fmtDay(v).replace(/\(.\)$/, "").trim();

let root = null;
let wasWide = WIDE.matches;
let listening = false;
let filter = "all";   // 컴퓨터 화면 표 필터: all | soon | fb | norec | nosched
let progStage = 1;    // '담당 학생 진행' 카드에서 보는 차수
let askIdx = 0;       // 승인 요청 카드에서 보고 있는 순서

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

  // 완료 처리한 면접은 '오늘 면접'에서 빠진다 (기록을 저장하거나 '면접 완료'를 누르면 done 이 선다)
  const mineToday = (S.bookings || [])
    .filter((b) => b.date === today && ACTIVE(b.status) && !DONE(b) && (!me || (b.teachers || []).includes(me)))
    .sort((a, b) => a.start.localeCompare(b.start));

  // '작성할 피드백'도 같은 예약 단위로 판단한다 (recordWrittenFor).
  // 같은 학생·같은 차수라도 다른 날짜·다른 예약의 면접은 따로 센다.
  const noRecord = S.meetings
    .filter((m) => m.planned && !recordWrittenFor(m) && (!me || (m.teachers || []).includes(me)) && (m.date || "") <= today)
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
  // 오늘 면접 전체 (완료한 것도 '기록 완료'로 보여 준다)
  const todayAll = (S.bookings || [])
    .filter((b) => b.date === today && ACTIVE(b.status) && (!me || (b.teachers || []).includes(me)))
    .sort((a, b) => a.start.localeCompare(b.start));
  return { me, today, now, mine, scope, mineToday, todayAll, noRecord, pending, need, missing };
}

const noticeHtml = (me) => !S.ctx.profile ? `<div class="notice row">
  <span>관리자 이메일로 로그인했습니다. 배정표의 내 이름을 고르면 '내 담당'이 보입니다.</span>
  <select id="pickName" style="width:auto">${opt(S.staff.map((t) => t.name), me, "— 선택 —")}</select></div>` : "";

// ================= 그리기 =================
function render() {
  if (!root) return;
  const d = collect();
  setDot("#todayDot", WIDE.matches ? d.need.length + d.noRecord.length : d.need.length + d.pending.length);
  S.homeHead = () => {
    const line = `${d.now.getMonth() + 1}월 ${d.now.getDate()}일 ${WEEK[d.now.getDay()]}요일${d.mine.length ? ` · 담당 학생 ${d.mine.length}명` : ""}`;
    const who = d.me ? d.me + " 선생님" : S.ctx.isAdmin ? "관리자님" : "선생님";
    return [WIDE.matches ? `${who}, 오늘도 힘내세요!` : who, line];
  };
  if (S.curTab === "home") applyHead("home");
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
  // 승인 요청 카드: 수락 · 거절(확인 창) · 시간 변경 + 넘겨 보기
  $$("[data-qa]", root).forEach((b) => b.onclick = async () => {
    $$("[data-qa]", root).forEach((x) => x.disabled = true);
    try { await quickBooking(b.dataset.id, b.dataset.qa); } finally { $$("[data-qa]", root).forEach((x) => x.disabled = false); }
  });
  $$("[data-ask]", root).forEach((b) => b.onclick = () => { askIdx += Number(b.dataset.ask); render(); });
  const tog = $("#soonTog", root);
  if (tog) tog.onclick = () => { const l = $("#soonList", root), open = l.hidden; l.hidden = !open; tog.setAttribute("aria-expanded", String(open)); };
}

// ---- 조각
const hm = (d) => `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
const recorded = (b) => DONE(b) || S.meetings.some((m) => m.id === "bk_" + b.id && !m.planned);
// 승인 요청 한 건 (컴퓨터 카드 · 휴대폰 카드 공통)
function askHtml(need, phone) {
  if (!need.length) return "";
  askIdx = Math.max(0, Math.min(askIdx, need.length - 1));
  const b = need[askIdx];
  const nm = nameOf(b.studentNo) || b.studentName || "";
  const by = b.proposedBy === "student" || b.requestedBy === "student" ? "학생이 신청" : "선생님 제안";
  const when = `<b>${fmtDay(b.date)} ${esc(S.blockLabel(b.block) || "")}</b> ${esc(b.start)} – ${esc(b.end)}`;
  const btns = `<div class="yn"><button type="button" class="y" data-qa="accept" data-id="${esc(b.id)}">수락</button>
    <button type="button" class="n" data-qa="reject" data-id="${esc(b.id)}">거절</button>
    <button type="button" class="c" data-qa="change" data-id="${esc(b.id)}">시간 변경</button></div>`;
  const box = phone
    ? `<div class="fbbox"><div class="who2">${esc(nm)}<small>${esc(b.studentNo)} · ${b.stage}차 면접</small></div>
        <div class="when">${when} · ${esc(b.room || "장소 미정")} · ${by}</div>${b.memo ? `<div class="when">“${esc(b.memo)}”</div>` : ""}${btns}</div>`
    : `<div class="fbbox"><span class="tag">${icon("clock", 13)}${esc(nm)} ${esc(b.studentNo)} · ${b.stage}차</span>
        <p>${when}<br>${esc(b.room || "장소 미정")} · ${by}${b.memo ? `<br>“${esc(b.memo)}”` : ""}</p>${btns}</div>`;
  return `${box}<div class="pager"><b>${askIdx + 1}<small>/${need.length}</small></b><div class="sp"></div>
    <button type="button" data-ask="-1" aria-label="이전 요청" ${askIdx ? "" : "disabled"}>${icon("back", 15)}</button>
    <button type="button" data-ask="1" aria-label="다음 요청" ${askIdx < need.length - 1 ? "" : "disabled"}>${icon("chevron", 15)}</button></div>`;
}

// ================= 컴퓨터 화면 (721px 이상) =================
function wideHtml({ me, now, mine, scope, todayAll, noRecord, pending, need, missing }) {
  const nowHm = hm(now);
  const left = todayAll.filter((b) => !recorded(b) && b.status === "confirmed");
  const next = left.find((b) => b.end >= nowHm);
  let sub = "오늘 잡힌 면접이 없어요.";
  if (todayAll.length) {
    if (!next) sub = left.length ? "끝난 면접의 기록을 써 주세요." : "오늘 면접을 모두 마쳤어요. 수고하셨어요!";
    else if (next.start <= nowHm) sub = "지금 면접 시간이에요.";
    else {
      const [h, m] = next.start.split(":").map(Number);
      const mins = h * 60 + m - (now.getHours() * 60 + now.getMinutes());
      sub = `다음 면접까지 ${mins >= 60 ? `${Math.floor(mins / 60)}시간 ${mins % 60 ? (mins % 60) + "분" : ""}`.trim() : mins + "분"} 남았어요.`;
    }
  }
  // 담당 학생 진행 (차수별 점)
  const tsOf = (s, k) => stageTeachers(s, k);
  const inStage = scope.filter((s) => { const t = tsOf(s, progStage); return t.length && (!me || t.includes(me)); });
  const stateOf = (s) => {
    if (S.meetings.some((m) => m.studentNo === s.studentNo && Number(m.stage) === progStage && !m.planned)) return "f";
    const bk = (S.bookings || []).filter((b) => b.studentNo === s.studentNo && b.stage === progStage && ACTIVE(b.status));
    if (bk.some((b) => DONE(b))) return "f";
    return bk.length ? "t" : "";
  };
  const states = inStage.map(stateOf).sort((a, b) => (b === "f") - (a === "f") || (b === "t") - (a === "t"));
  const doneN = states.filter((x) => x === "f").length;
  const pct = inStage.length ? doneN / inStage.length : 0;
  // 작성할 기록: 최근 2주 내 면접 중 기록한 비율
  const since = isoDay(new Date(Date.now() - 14 * 86400000)), today = isoDay();
  const recent = S.meetings.filter((m) => (!me || (m.teachers || []).includes(me)) && (m.date || "") >= since && (m.date || "") <= today);
  const ticks = recent.map((m) => !(m.planned && !recordWrittenFor(m)))
    .sort((a, b) => b - a);
  // 이번 주 면접 (월~금)
  const mon = new Date(now); mon.setHours(0, 0, 0, 0); mon.setDate(mon.getDate() - ((mon.getDay() + 6) % 7));
  const wkDays = Array.from({ length: 5 }, (_, i) => { const x = new Date(mon); x.setDate(mon.getDate() + i); return isoDay(x); });
  const wkBk = (S.bookings || []).filter((b) => wkDays.includes(b.date) && ACTIVE(b.status) && (!me || (b.teachers || []).includes(me)));
  const per = wkDays.map((d) => wkBk.filter((b) => b.date === d).length);
  const maxPer = Math.max(1, ...per);
  // 완료 = 확정된 면접 중 '면접 완료' 또는 기록을 쓴 것. 날짜가 지났다는 것만으로는 완료로 세지 않는다
  const conf = wkBk.filter((b) => b.status === "confirmed");
  const wkDone = conf.filter((b) => recorded(b)).length;
  const wkLeft = conf.filter((b) => !recorded(b) && b.date >= today).length;
  const wkLate = conf.filter((b) => !recorded(b) && b.date < today).length;   // 지났는데 완료·기록 안 한 것
  const wkWait = wkBk.filter((b) => b.status === "requested").length;          // 수락 대기
  const f2 = (d) => { const x = toDate(d); return `${x.getMonth() + 1}/${x.getDate()}`; };

  return `
    ${noticeHtml(me)}
    <div class="t-row1">
      <section class="t-hero">
        <h2>오늘 면접 ${todayAll.filter((b) => b.status === "confirmed").length}건</h2>
        <p class="sub">${sub}</p>
        <div class="slots">${todayAll.length ? todayAll.map((b) => {
          const s = S.students.find((x) => x.studentNo === b.studentNo);
          const others = (b.teachers || []).filter((t) => t !== me);
          const done = recorded(b), isNext = b === next;
          const meta = `${esc(b.room || "장소 미정")}${others.length ? " · " + esc(others.join("·")) + " 선생님과" : ""}`;
          const end = b.status !== "confirmed" ? `<span class="wait">요청 중</span>`
            : done ? `<button type="button" class="ok" data-rec="${esc(b.id)}">기록 보기</button>`
            : isNext ? `<button type="button" class="cta sm" data-rec="${esc(b.id)}">기록 쓰기<span>${icon("arrow", 15)}</span></button>`
            : b.end < nowHm ? `<button type="button" class="wait w2" data-rec="${esc(b.id)}">기록 쓰기</button>`
            : `<span class="wait">예정</span>`;
          return `<div class="slot ${done ? "past" : ""} ${isNext ? "next" : ""}">
            <div class="st">${isNext ? "<em>다음 면접</em>" : ""}<b>${esc(S.blockLabel(b.block) || b.start)}</b>${esc(b.start)}</div>
            <button type="button" class="sb" data-no="${esc(b.studentNo)}"><b>${esc(s?.name || b.studentName || "")}</b> ${esc(b.studentNo)} · ${b.stage}차 <span>${meta}</span></button>
            ${end}</div>`;
        }).join("") : '<div class="slot-none">오늘은 쉬어 가는 날이에요. 이번 주 일정은 아래에서 볼 수 있어요.</div>'}</div>
      </section>

      <section class="t-prog">
        <h3>담당 학생 진행</h3>
        <div class="s">한 칸이 학생 한 명.<br>채운 칸은 이 차수를 마친 학생.</div>
        <div class="dots" aria-label="${inStage.length}명 중 ${doneN}명 마침">${states.slice(0, 36).map((x) => `<i class="${x}"></i>`).join("")}${states.length > 36 ? `<span class="more">+${states.length - 36}</span>` : ""}</div>
        ${inStage.length ? `<div class="good">${pct >= .7 ? "순조로워요" : pct >= .3 ? "진행 중이에요" : "이제 시작이에요"} ${icon("check", 14)}</div>` : '<div class="good">이 차수 담당 학생이 없어요</div>'}
        <div class="seg3">${BOOK_STAGES.map((sg) => `<button type="button" class="${sg.key === progStage ? "on" : ""}" data-prog="${sg.key}">${sg.short}</button>`).join("")}</div>
        <div class="bignum"><b>${doneN}</b><small>/ ${inStage.length}명</small></div>
      </section>
    </div>

    <div class="t-row2">
      <section class="h-card fb ask-w">
        ${need.length ? `<div class="avs">${need.slice(0, 3).map((b, i) => `<span style="background:${["#5583cc", "#a8b746", "#7a8fb8"][i]}">${esc(initials(nameOf(b.studentNo) || b.studentName || ""))}</span>`).join("")}</div>
          <h3>일정 승인 요청이<br>${need.length}건 있어요</h3>${askHtml(need, false)}`
        : `<div class="ch2"><span class="ic">${icon("clock", 19)}</span><h3>일정 승인 요청</h3></div><p class="none">새 요청이 없어요.<br>학생이 신청하면 여기에 바로 떠요.</p>
          <button type="button" class="link" data-go="schedule">일정 보기 →</button>`}
      </section>

      <section class="h-card" id="fbCard">
        <div class="ch2"><span class="ic">${icon("pen", 19)}</span><h3>작성할 기록</h3></div>
        <div class="sub2"><span>최근 2주 면접 ${recent.length}건</span><span>기록한 비율</span></div>
        <div class="big">${noRecord.length}<small>건 남음</small></div>
        ${noRecord.length ? `<div class="nrows">${noRecord.slice(0, 3).map((m) => `<button type="button" class="nrow" data-meet="${esc(m.id)}">
            <b>${esc(nameOf(m.studentNo) || m.name || "")}</b><small>${dayOnly(m.date)} · ${m.stage}차</small><span>기록 쓰기 →</span></button>`).join("")}
            ${noRecord.length > 3 ? `<button type="button" class="nrow more" data-go="meetings">외 ${noRecord.length - 3}건 →</button>` : ""}</div>`
        : ticks.length ? `<div class="scale"><span>0</span><span>${ticks.length}건</span></div>
          <div class="ticks" aria-hidden="true">${ticks.slice(0, 30).map((x) => `<i class="${x ? "" : "o"}"></i>`).join("")}</div>` : '<div class="ticks empty" aria-hidden="true"></div>'}
        <div class="trio">
          <button type="button" class="${noRecord.length ? "warn" : ""}" data-go="meetings"><b>${noRecord.length}</b><small>기록 안 쓴 면접</small></button>
          <button type="button" class="${pending.length ? "warn" : ""}" data-go="review"><b id="pendingDot">${pending.length}</b><small>검토 대기 연습</small></button>
          <button type="button" data-go="schedule"><b>${missing.length}</b><small>일정 없는 차수</small></button>
        </div>
      </section>

      <section class="h-card">
        <div class="ch2"><span class="ic">${icon("calendar", 19)}</span><h3>이번 주 면접</h3></div>
        <div class="sub2"><span>내가 맡은 모의면접</span><span>${f2(wkDays[0])} – ${f2(wkDays[4])}</span></div>
        <div class="wkb" aria-hidden="true">${wkDays.map((d, i) => `<div class="${d === today ? "on" : d > today ? "later" : ""}"><i style="height:${Math.max(8, per[i] / maxPer * 100)}%"></i>${"월화수목금"[i]}</div>`).join("")}</div>
        <div class="nx"><div class="d">${wkBk.length}<small>건</small></div><div class="sp"></div>
          <div class="m"><span>완료 ${wkDone} · 남음 ${wkLeft}</span>${wkLate || wkWait ? `<span>${wkLate ? `<span class="late">기록 필요 ${wkLate}</span>` : ""}${wkLate && wkWait ? " · " : ""}${wkWait ? `수락 대기 ${wkWait}` : ""}</span>` : ""}<button type="button" class="link" data-go="schedule">전체 일정 →</button></div></div>
      </section>
    </div>

    <section class="h-card tbl">
      <div class="ch2"><h3>담당 학생 준비 현황</h3><span class="n" id="rowCount"></span><div class="sp"></div>
        <div class="search-box"><span>${icon("search", 16)}</span>
          <input type="search" id="hSearch" placeholder="이름 · 학번 검색" aria-label="이름 또는 학번"></div></div>
      <div class="chips" id="hChips">
        <button type="button" data-f="all">전체</button>
        <button type="button" data-f="soon">면접 임박</button>
        <button type="button" data-f="fb">피드백 대기</button>
        <button type="button" data-f="norec">기록 없음</button>
        <button type="button" data-f="nosched">일정 없음</button>
      </div>
      <div class="trows" id="hBody"></div>
      <div class="legend"><span><i class="f"></i>마침</span><span><i class="b"></i>확정</span><span><i class="r"></i>요청 중</span><span><i></i>아직 없음</span>
        <button type="button" class="link" data-go="students">학생 전체 →</button></div>
    </section>`;
}

function bindWide({ scope }) {
  $$("[data-prog]", root).forEach((b) => b.onclick = () => { progStage = Number(b.dataset.prog); render(); });
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
  const waitingFb = (s) => S.meetings.some((m) => m.studentNo === s.studentNo && m.planned && !recordWrittenFor(m))
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
    $("#hBody", root).innerHTML = `<div class="empty">${scope.length ? "조건에 맞는 학생이 없습니다." : "담당 학생이 없습니다."}</div>`;
    return;
  }
  const dot = (s, k) => {
    if (S.meetings.some((m) => m.studentNo === s.studentNo && Number(m.stage) === k && !m.planned)) return "f";
    const bk = (S.bookings || []).filter((b) => b.studentNo === s.studentNo && b.stage === k && ACTIVE(b.status));
    if (bk.some((b) => DONE(b))) return "f";
    if (bk.some((b) => b.status === "confirmed")) return "b";
    return bk.length ? "r" : "";
  };
  $("#hBody", root).innerHTML = `<div class="tr th"><span>학생</span><span>지원 대학</span><span>최근 활동</span><span>1 · 2 · 3차</span><span></span></div>` + list.slice(0, 12).map((s) => {
    const iv = nextInterview(s);
    const n = iv ? dday(iv) : null;
    const u = iv ? (s.universities || []).find((x) => x.date && isoDay(x.date) === isoDay(iv)) : null;
    const lastSess = S.sessions.filter((x) => x.studentNo === s.studentNo && x.status === "submitted")
      .sort((a, b) => (b.submittedAt?.seconds || 0) - (a.submittedAt?.seconds || 0))[0];
    const lastMeet = S.meetings.filter((m) => m.studentNo === s.studentNo && !m.planned)
      .sort((a, b) => (b.date || "").localeCompare(a.date || ""))[0];
    const sTime = (lastSess?.submittedAt?.seconds || 0) * 1000;
    const mTime = lastMeet ? (toDate(lastMeet.date)?.getTime() || 0) : 0;
    const act = !sTime && !mTime ? '<span class="muted">아직 없음</span>'
      : sTime >= mTime ? `${fmtDate(lastSess.submittedAt)} 연습 제출`
      : `${dayOnly(lastMeet.date)} ${lastMeet.stage}차 기록`;
    const [go, label] = waitingFb(s) ? ["fb", "피드백 쓰기 →"]
      : noSched(s) ? ["sched", "일정 잡기 →"]
      : ["open", "학생 보기 →"];
    return `<div class="tr"><span><b>${esc(s.name)}</b> ${esc(s.studentNo)}</span>
      <span>${u ? esc(`${u.univ || ""} ${u.dept || ""}`.trim()) : esc(s.track || "-")}${n != null ? ` <em class="${n <= 7 ? "hot" : ""}">${n === 0 ? "D-DAY" : "D-" + n}</em>` : ""}</span>
      <span>${act}</span>
      <span class="st3">${[1, 2, 3].map((k) => `<i class="${dot(s, k)}" title="${k}차"></i>`).join("")}</span>
      <button type="button" class="go" data-row="${esc(s.studentNo)}" data-act="${go}">${label}</button></div>`;
  }).join("");
  $$("#hBody [data-row]", root).forEach((b) => b.onclick = () => {
    if (b.dataset.act === "sched") return gotoSchedule();
    if (b.dataset.act === "fb") {
      const m = S.meetings.find((x) => x.studentNo === b.dataset.row && x.planned && !recordWrittenFor(x));
      if (m) return openMeetingForm({ id: m.id });
      return switchTab("review");
    }
    openStudent(b.dataset.row);
  });
}

// ================= 휴대폰 화면 (720px 이하) =================
function narrowHtml({ me, now, todayAll, noRecord, pending, need, missing }) {
  const missBy = BOOK_STAGES.map((sg) => `${sg.short} ${missing.filter((x) => x.sg.key === sg.key).length}`).join(", ");
  const soon = soonList();
  return `
    ${noticeHtml(me)}

    ${need.length ? `<section class="p-card ask-card">
      <h3><span class="hi2">${icon("clock", 17)}</span>일정 승인 요청 <em>${need.length}건</em></h3>
      ${askHtml(need, true)}</section>` : ""}

    <section class="tday">
      <h2>${icon("calendar", 19)}오늘 면접 ${todayAll.length ? `<span>${todayAll.filter((b) => b.status === "confirmed").length}</span>` : ""}</h2>
      <div id="todayList">${todayAll.length ? todayAll.map((b) => {
        const s = S.students.find((x) => x.studentNo === b.studentNo);
        const done = recorded(b);
        const others = (b.teachers || []).filter((t) => t !== me);
        return `<div class="trow2">
          <div class="dd"><b>${esc(S.blockLabel(b.block) || "")}</b><span>${esc(b.start)}</span></div>
          <button type="button" class="tx" data-no="${esc(b.studentNo)}"><b>${esc(s?.name || b.studentName || "")}</b><span class="no">${esc(b.studentNo)} · ${b.stage}차</span>
            <small>${esc(b.room || "장소 미정")} · ${esc(b.start)}–${esc(b.end)}${others.length ? " · " + esc(others.join("·")) + " 선생님과" : ""}</small></button>
          ${b.status !== "confirmed" ? '<span class="rec view">요청 중</span>' : `<button type="button" class="rec ${done ? "view" : "go"}" data-rec="${esc(b.id)}">${done ? "기록 보기" : "기록"}</button>`}</div>`;
      }).join("") : '<div class="trow2 none">오늘 잡힌 면접이 없어요.</div>'}</div>
    </section>

    <section class="p-card todo-t" id="todoCard">
      <h3>할 일</h3>
      ${todoRow("note", noRecord.length, "r", "기록을 쓰지 않은 면접",
        noRecord.length ? noRecord.slice(0, 3).map((m) => `${dayOnly(m.date)} ${esc(nameOf(m.studentNo) || m.name || "")}`).join(" · ") : "모두 썼어요",
        "쓰기", "meetings")}
      ${todoRow("mic", pending.length, "w", "검토를 기다리는 연습 답변",
        pending.length ? "한 줄 피드백만 써도 학생에게 바로 보여요" : "밀린 검토가 없어요",
        "보기", "review", "pendingDot")}
      ${todoRow("calendar", missing.length, "b", "일정을 아직 안 잡은 차수",
        missing.length ? missBy : "모두 잡혔어요", "잡기", "schedule")}
    </section>

    <section class="p-card soon">
      <button type="button" class="tog" id="soonTog" aria-expanded="false" aria-controls="soonList">
        <b>다가오는 면접</b><small>${soon.length}명</small><span class="sp"></span>
        ${soon.length ? `<em>가장 가까운 ${soon[0].n === 0 ? "D-DAY" : "D-" + soon[0].n}</em>` : ""}${icon("down", 18)}</button>
      <div class="list" id="soonList" hidden>${soonHtml(soon)}</div>
    </section>`;
}

function bindNarrow() { /* 휴대폰 화면의 클릭은 모두 bindCommon 이 처리한다 */ }

function todoRow(ic, n, tone, title, desc, cta, go, id = "") {
  return `<div class="row3">
    <span class="ic3 ${n ? tone : ""}">${icon(ic, 18)}</span>
    <span class="n ${n ? tone : ""}"${id ? ` id="${id}"` : ""}>${n}</span>
    <span class="tt"><b>${esc(title)}</b><small>${desc}</small></span>
    <button type="button" class="btn2" data-go="${go}" data-tab="${go}">${esc(cta)}</button>
  </div>`;
}

function soonList() {
  return S.students
    .map((s) => ({ s, d: nextInterview(s) }))
    .filter((x) => x.d && dday(x.d) <= 14)
    .map((x) => ({ ...x, n: dday(x.d) }))
    .sort((a, b) => a.d - b.d)
    .slice(0, 12);
}
function soonHtml(list) {
  if (!list.length) return '<div class="empty">2주 안에 면접 보는 학생이 없어요.</div>';
  const me = myName();
  return list.map(({ s, d }) => {
    const n = dday(d);
    const u = (s.universities || []).find((x) => x.date && fmtDay(x.date) === fmtDay(d));
    const roles = myRoles(s, me);
    return `<button type="button" class="srow3 ${n <= 7 ? "hot" : ""}" data-no="${esc(s.studentNo)}">
      <span class="dd"><b>${n === 0 ? "D-DAY" : "D-" + n}</b><span>${dayOnly(d)}</span></span>
      <span class="tx"><b>${esc(s.name)}</b><span class="no">${esc(s.studentNo)}</span>
        <small>${esc(u ? `${u.univ} ${u.dept || ""}` : s.track || "")}${roles.length ? " · 내 역할 " + roles.join("·") : ""}</small></span>
      ${icon("chevron", 14)}</button>`;
  }).join("");
}
