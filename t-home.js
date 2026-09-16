import { $, $$, esc, dday, nextInterview, fmtDay, ddayBadge } from "./common.js";
import { S, register, rerender, myName, myRoles, stageChips, nextBadge, switchTab, opt } from "./t-core.js";
import { openStudent } from "./t-students.js";
import { openMeetingForm } from "./t-meetings.js";

let root;
export function init(el) {
  root = el;
  register("home", render);
}

function render() {
  const name = myName();
  const mine = name ? S.students.filter((s) => myRoles(s, name).length) : [];
  const soon = S.students
    .map((s) => ({ s, d: nextInterview(s) }))
    .filter((x) => x.d && dday(x.d) <= 14)
    .sort((a, b) => a.d - b.d);
  const pending = S.sessions.filter((x) => x.status === "submitted" && !x.reviewedAt).length;
  const syncFail = S.meetings.filter((m) => m.syncError).length;
  const count = (k) => mine.filter((s) => myRoles(s, name).includes(k)).length;
  const doneFor = (s, stageKeys) => S.meetings.some((m) => m.studentNo === s.studentNo && stageKeys.includes(m.stage));

  // 내 담당 중 아직 내 차수 기록이 없는 학생
  const todo = mine.filter((s) => {
    const r = myRoles(s, name);
    return (r.includes("1차") && !doneFor(s, [1])) || (r.includes("2차") && !doneFor(s, [2])) || (r.includes("3차") && !doneFor(s, [3]));
  });

  root.innerHTML = `
    ${!S.ctx.profile ? `<div class="notice row">
      <span>관리자 이메일로 로그인했습니다. 배정표의 내 이름을 고르면 '내 담당'이 보입니다.</span>
      <select id="pickName" style="width:auto">${opt(S.staff.map((t) => t.name), name, "— 선택 —")}</select></div>` : ""}
    <div class="grid grid-4">
      <div class="card stat-card"><div class="muted">내 담당 학생</div><div class="stat">${mine.length}</div>
        <div class="muted">1차 ${count("1차")} · 2차 ${count("2차")} · 3차 ${count("3차")}</div></div>
      <div class="card stat-card"><div class="muted">내 차수 기록 남은 학생</div><div class="stat">${todo.length}</div></div>
      <div class="card stat-card"><div class="muted">2주 안에 면접</div><div class="stat">${soon.length}</div><div class="muted">전체 학생 기준</div></div>
      <div class="card stat-card" id="goReview" style="cursor:pointer"><div class="muted">연습 검토 대기</div><div class="stat">${pending}</div>
        ${S.ctx.isAdmin && syncFail ? `<div class="badge badge-red">시트 동기화 실패 ${syncFail}건</div>` : ""}</div>
    </div>

    <div class="section-title"><h3>내 담당 학생</h3><span class="muted">${esc(name || "이름 미지정")}</span></div>
    <div class="card table-wrap">${mine.length ? `<table>
      <thead><tr><th>학생</th><th>트랙</th><th>내 역할</th><th class="nowrap">다음 면접</th><th>진행</th><th></th></tr></thead>
      <tbody>${mine.sort((a, b) => (nextInterview(a) || 9e15) - (nextInterview(b) || 9e15)).map((s) => `
        <tr class="clickable" data-no="${s.studentNo}">
          <td class="nowrap"><b>${esc(s.name)}</b> <span class="muted">${esc(s.studentNo)}</span></td>
          <td>${esc(s.track || "")}${s.special && s.special !== "없음" ? ` <span class="badge badge-violet">${esc(s.special)}</span>` : ""}</td>
          <td class="nowrap">${myRoles(s, name).join(" · ")}</td>
          <td class="nowrap">${nextBadge(s)}</td>
          <td class="nowrap">${stageChips(s)}</td>
          <td class="nowrap">${s.sheetUrl ? `<a class="btn btn-sm" href="${esc(s.sheetUrl)}" target="_blank" rel="noopener" data-stop>시트</a>` : ""}
            <button class="btn-sm btn-primary" data-rec="${s.studentNo}">기록</button></td>
        </tr>`).join("")}</tbody></table>` : `<div class="empty">${name ? "배정된 학생이 없습니다. (배정표의 교사명과 계정 이름이 같은지 확인하세요)" : "이름이 지정되지 않았습니다."}</div>`}
    </div>

    <div class="section-title"><h3>2주 안에 면접 보는 학생</h3></div>
    <div class="card">${soon.length ? soon.map(({ s, d }) => {
      const u = (s.universities || []).find((x) => x.date && fmtDay(x.date) === fmtDay(d));
      return `<div class="row clickable" data-no="${s.studentNo}" style="padding:6px 0;border-bottom:1px solid var(--line);cursor:pointer">
        ${ddayBadge(d)} <b>${esc(s.name)}</b> <span class="muted">${esc(s.studentNo)} · ${fmtDay(d)}</span>
        <span class="muted">${u ? esc(`${u.univ} ${u.dept} (${u.format || ""})`) : ""}</span>
        <div class="spacer"></div>${stageChips(s)}</div>`;
    }).join("") : '<div class="empty">없습니다.</div>'}</div>`;

  $("#pickName", root)?.addEventListener("change", (e) => {
    try { localStorage.setItem("myStaffName", e.target.value); } catch (_) {}
    rerender();
  });
  $("#goReview", root).onclick = () => switchTab("review");
  $$("[data-no]", root).forEach((el) => el.onclick = (e) => {
    if (e.target.closest("[data-stop]")) return;
    const rec = e.target.closest("[data-rec]");
    if (rec) return openMeetingForm({ studentNo: rec.dataset.rec });
    openStudent(el.dataset.no);
  });
}
