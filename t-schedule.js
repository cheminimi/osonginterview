// 교사 화면 · 일정 탭
import { S, register, myName } from "./t-core.js";
import { mountSchedule } from "./schedule.js";
import { openMeetingForm } from "./t-meetings.js";
import { $ } from "./common.js";

let sched;
export function init(el) {
  sched = mountSchedule(el, {
    role: S.ctx.isAdmin ? "admin" : "teacher",
    myName: myName(), staffId: S.ctx.account.key,
    getStudents: () => S.students, getStaff: () => S.staff,
    onBadge: (n) => { $("#scDot").innerHTML = n ? `<span class="dot-new">${n}</span>` : ""; },
    openMeeting: (b) => {
      const id = "bk_" + b.id;
      if (S.meetings.some((m) => m.id === id)) return openMeetingForm({ id });
      openMeetingForm({ studentNo: b.studentNo, preset: { id, stage: b.stage, date: b.date, teachers: b.teachers, bookingId: b.id } });
    }
  });
  register("schedule", () => sched.render());
}
