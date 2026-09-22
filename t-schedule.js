// 교사 화면 · 일정 탭
import { S, register, rerender, myName, setDot, switchTab } from "./t-core.js";
import { mountSchedule } from "./schedule.js";
import { openMeetingForm } from "./t-meetings.js";
import { $ } from "./common.js";

let sched;
/** 일정에서 만들어진 '예정' 기록 열기 (오늘 화면에서도 씀) */
export function openBookingRecord(b) {
  const id = "bk_" + b.id;
  if (S.meetings.some((m) => m.id === id)) return openMeetingForm({ id });
  openMeetingForm({ studentNo: b.studentNo, preset: { id, stage: b.stage, date: b.date, teachers: b.teachers, bookingId: b.id } });
}
/** 일정 탭으로 가서 달력을 보여준다 */
export function gotoSchedule() {
  switchTab("schedule");
  sched?.render();
}
export function openBookingForm(opts) {
  switchTab("schedule");
  sched?.openForm(opts);
}

export function init(el) {
  sched = mountSchedule(el, {
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
    },
    openMeeting: (b) => openBookingRecord(b)
  });
  register("schedule", () => sched.render());
}
