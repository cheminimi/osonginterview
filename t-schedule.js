// 교사 화면 · 일정 탭
import { S, register, rerender, myName, myRoles, setDot, switchTab, applyHead } from "./t-core.js";
import { mountSchedule } from "./schedule.js";
import { mountBoothBooking, mountSchedSwitch } from "./booth-booking.js";
import { openMeetingForm } from "./t-meetings.js";
import { $ } from "./common.js";

let sched, booth = null, view = null;
/** 일정에서 만들어진 '예정' 기록 열기 (오늘 화면에서도 씀) */
export function openBookingRecord(b) {
  const id = "bk_" + b.id;
  if (S.meetings.some((m) => m.id === id)) return openMeetingForm({ id });
  openMeetingForm({ studentNo: b.studentNo, preset: { id, stage: b.stage, date: b.date, teachers: b.teachers, bookingId: b.id } });
}
/** 일정 탭으로 가서 달력을 보여준다 (부스 예약을 보고 있었어도 면접 일정으로) */
export function gotoSchedule() {
  view?.set("interview");
  switchTab("schedule");
  sched?.render();
}
/** 오늘 화면 승인 카드: accept | reject | change */
export function quickBooking(id, action) { return sched?.quick(id, action); }
export function openBookingDetail(id) { return sched?.openDetail(id); }
export function openBookingForm(opts) {
  view?.set("interview");
  switchTab("schedule");
  sched?.openForm(opts);
}

export function init(el) {
  // 일정 탭 = 면접 일정 · 부스 예약 두 화면. 부스 예약은 처음 열 때 만든다 (읽기 절약)
  el.innerHTML = `<div id="scInterview"></div><div id="scBooth" hidden></div>`;
  const showView = (v) => {
    S.scView = v;
    try { sessionStorage.setItem("scView", v); } catch (_) {}
    $("#scInterview", el).hidden = v !== "interview";
    $("#scBooth", el).hidden = v !== "booth";
    if (v === "booth" && !booth) booth = mountBoothBooking($("#scBooth", el), {
      role: S.ctx.isAdmin ? "admin" : "teacher", myName: myName(),
      getStudents: () => S.students, isMine: (s) => myRoles(s).length > 0
    });
    applyHead();
  };
  const sw = $("#scSub");
  if (sw) view = mountSchedSwitch(sw, { value: S.scView, onChange: showView });
  showView(S.scView);
  sched = mountSchedule($("#scInterview", el), {
    role: S.ctx.isAdmin ? "admin" : "teacher",
    myName: myName(), staffId: S.ctx.account.key,
    getStudents: () => S.students, getStaff: () => S.staff,
    onBadge: (n) => setDot("#scDot", n),
    // 오늘 화면이 쓸 수 있게 일정 상태를 보관 (추가 읽기 없음)
    onData: (d) => {
      S.bookings = d.bookings || [];
      S.blockLabel = d.blockLabel;
      S.needMine = d.needMine || [];
      rerender("home");
      applyHead();
    },
    openMeeting: (b) => openBookingRecord(b)
  });
  register("schedule", () => { sched.render(); booth?.render(); });
}
