import {
  db, doc, updateDoc, deleteDoc, serverTimestamp, $, $$, esc, toast, showError, copyText, fmtDate, typeBadge, CRITERIA
} from "./common.js";
import { S, register, rerender, openModal, closeModal, opt, myRoles, loadAllSessions, RECENT_DAYS, setDot } from "./t-core.js";
import { feedbackPrompt } from "./prompts.js";
import { queueNotify } from "./notify.js";

let root;
export function init(el) {
  root = el;
  root.innerHTML = `
    <div class="toolbar">
      <select id="rStatus"><option value="pending">검토 대기</option><option value="done">검토 완료</option><option value="progress">미완료</option><option value="">전체</option></select>
      <select id="rStudent"></select>
      <label class="inline-check"><input type="checkbox" id="rMine"> 내 담당 학생만</label>
      <div class="spacer"></div>
    </div>
    <p class="muted" style="margin-top:0">학생이 스스로 한 말하기 연습(타이머 모의면접) 기록입니다. 선생님 누구나 피드백할 수 있습니다.</p>
    <div id="rScope"></div>
    <div class="card table-wrap"><table>
      <thead><tr><th>제출</th><th>학생</th><th>유형</th><th>문항</th><th>시간 초과</th><th>상태</th><th>검토</th></tr></thead>
      <tbody id="rBody"></tbody></table></div>`;
  ["#rStatus", "#rStudent", "#rMine"].forEach((s) => $(s, root).onchange = render);
  register("review", render);
}

function render() {
  const cur = $("#rStudent", root).value;
  $("#rStudent", root).innerHTML = opt(S.students.map((s) => [s.studentNo, `${s.studentNo} ${s.name}`]), cur, "전체 학생");
  const pending = S.sessions.filter((s) => s.status === "submitted" && !s.reviewedAt).length;
  setDot("#pendingDot", pending);
  const st = $("#rStatus", root).value, no = $("#rStudent", root).value, mine = $("#rMine", root).checked;
  $("#rScope", root).innerHTML = S.sessionsScope === "all" ? "" : `<div class="notice row" style="padding:8px 12px"><span>최근 ${RECENT_DAYS}일 안에 제출된 연습만 표시 중이에요.${st === "progress" || st === "" ? " <b>미완료</b> 연습은 불러와야 보여요." : ""}</span><div class="spacer"></div><button class="btn-sm" id="rLoadAll">이전 기록·미완료까지 불러오기</button></div>`;
  $("#rLoadAll", root)?.addEventListener("click", async (e) => { e.target.disabled = true; try { await loadAllSessions(); } catch (err) { showError(err, "연습 기록 불러오기"); e.target.disabled = false; } });
  const mineSet = new Set(S.students.filter((s) => myRoles(s).length).map((s) => s.studentNo));
  const list = S.sessions.filter((s) => (!no || s.studentNo === no) && (!mine || mineSet.has(s.studentNo)) && (
    !st || (st === "pending" && s.status === "submitted" && !s.reviewedAt) || (st === "done" && s.reviewedAt) || (st === "progress" && s.status !== "submitted")));
  if (!list.length) { $("#rBody", root).innerHTML = `<tr><td colspan="7" class="empty">해당하는 기록이 없습니다.</td></tr>`; return; }
  $("#rBody", root).innerHTML = list.map((s) => {
    const over = (s.items || []).filter((i) => i.usedSec > i.answerSec).length;
    return `<tr class="clickable" data-id="${s.id}"><td class="nowrap">${fmtDate(s.submittedAt || s.startedAt)}</td>
      <td class="nowrap">${esc(s.studentNo)} <b>${esc(s.studentName)}</b></td><td>${esc(s.modeLabel)}</td>
      <td>${(s.items || []).filter((i) => i.answer).length}/${(s.items || []).length}</td><td>${over || "-"}</td>
      <td>${s.status !== "submitted" ? '<span class="badge badge-gray">미완료</span>' : s.reviewedAt ? '<span class="badge badge-green">검토 완료</span>' : '<span class="badge badge-orange">검토 대기</span>'}</td>
      <td class="muted">${esc(s.reviewedBy || "")}</td></tr>`;
  }).join("");
  $$("tr[data-id]", root).forEach((tr) => tr.onclick = () => openReview(tr.dataset.id));
}

export function openReview(id) {
  const s = S.sessions.find((x) => x.id === id);
  if (!s) return;
  const fb = s.teacherFeedback || {};
  const body = openModal(`${s.studentName} · ${s.modeLabel}`, `
    <div class="muted">${fmtDate(s.startedAt)} 시작${s.submittedAt ? ` · ${fmtDate(s.submittedAt)} 제출` : " · 미완료"}${s.reviewedBy ? ` · 검토: ${esc(s.reviewedBy)}` : ""}</div>
    ${(s.items || []).map((it, i) => `
      <div class="q-item" style="margin-top:12px">
        <div class="row">${typeBadge(it.type)} <span class="muted">Q${i + 1} · ${it.usedSec}초 / ${it.answerSec}초</span>${it.usedSec > it.answerSec ? ' <span class="badge badge-red">초과</span>' : ""}</div>
        <div class="q-text pre" style="margin-top:6px">${esc(it.text)}</div>
        ${it.passage ? `<details><summary class="muted">제시문</summary><div class="ans">${esc(it.passage)}</div></details>` : ""}
        ${it.prepMemo ? `<details><summary class="muted">학생 메모</summary><div class="ans">${esc(it.prepMemo)}</div></details>` : ""}
        <div class="ans">${esc(it.answer) || '<span class="muted">(답변 없음)</span>'}</div>
        ${it.followUp ? `<div><b>꼬리질문</b> ${esc(it.followUp)} <span class="muted">(${it.followUsedSec}초)</span></div><div class="ans">${esc(it.followAnswer) || '<span class="muted">(답변 없음)</span>'}</div>` : ""}
        <textarea data-ic="${i}" placeholder="이 문항 코멘트 (선택)" style="min-height:56px">${esc(fb.itemComments?.[i] || "")}</textarea>
      </div>`).join("")}
    ${s.reflection ? `<div class="q-item" style="margin-top:12px"><b>학생 돌아보기</b><div class="pre muted">잘한 점: ${esc(s.reflection.good)}\n아쉬운 점: ${esc(s.reflection.improve)}</div></div>` : ""}
    <h3 style="margin-top:20px">평가</h3>
    ${CRITERIA.map((c) => `<div class="score-row"><div><b>${c.label}</b><div class="muted" style="font-size:.75rem">${c.hint}</div></div>
      <input type="range" min="1" max="5" step="1" data-score="${c.key}" value="${fb.scores?.[c.key] ?? 3}"><b data-sv="${c.key}">${fb.scores?.[c.key] ?? 3}</b></div>`).join("")}
    <div class="field"><label>총평</label><textarea id="rComment">${esc(fb.comment || "")}</textarea></div>
    <div class="field">
      <div class="row" style="margin-bottom:4px"><label style="margin:0">AI 피드백</label><div class="spacer"></div><button class="btn-sm" id="rPrompt">AI 피드백 프롬프트 복사</button></div>
      <textarea id="rAi" placeholder="Claude 결과를 붙여넣고 필요하면 다듬으세요." style="min-height:140px">${esc(s.aiFeedback || "")}</textarea>
    </div>
    <div class="row"><button id="rDraft">임시 저장</button><button class="btn-primary" id="rPublish">${s.reviewedAt ? "수정 내용 공개" : "저장하고 학생에게 공개"}</button>
      <div class="spacer"></div><button class="btn-sm btn-danger" id="rDelete">기록 삭제</button></div>`);
  $$("[data-score]", body).forEach((r) => r.oninput = () => { $(`[data-sv="${r.dataset.score}"]`, body).textContent = r.value; });
  $("#rPrompt", body).onclick = () => copyText(feedbackPrompt(s));
  const persist = async (publish) => {
    const d = {
      teacherFeedback: {
        scores: Object.fromEntries($$("[data-score]", body).map((r) => [r.dataset.score, Number(r.value)])),
        comment: $("#rComment", body).value.trim(),
        itemComments: $$("[data-ic]", body).map((t) => t.value.trim())
      },
      aiFeedback: $("#rAi", body).value.trim(),
      reviewedBy: S.ctx.profile?.name || S.ctx.user.email
    };
    if (publish) d.reviewedAt = serverTimestamp();
    try {
      await updateDoc(doc(db, "sessions", id), d);
      Object.assign(s, d, publish ? { reviewedAt: { seconds: Date.now() / 1000 } } : {});
      toast(publish ? "학생에게 공개했습니다." : "임시 저장했습니다.");
      // 학생 휴대폰으로 알림 (알림을 켜 둔 학생만 받습니다)
      if (publish) queueNotify({ key: s.studentNo, title: "선생님 피드백이 도착했어요",
        body: `${s.modeLabel || s.mode || "말하기 연습"} · ${S.ctx.profile?.name || ""} 선생님`,
        url: "student.html#feedback", tag: `fb_s_${id}` });
      if (publish) closeModal();
      rerender("review", "home", "students");
    } catch (e) { showError(e, "피드백 저장"); }
  };
  $("#rDraft", body).onclick = () => persist(false);
  $("#rPublish", body).onclick = () => persist(true);
  $("#rDelete", body).onclick = async () => {
    if (!confirm("이 연습 기록을 삭제할까요? 되돌릴 수 없습니다.")) return;
    try { await deleteDoc(doc(db, "sessions", id)); S.sessions = S.sessions.filter((x) => x.id !== id); closeModal(); rerender("review", "home", "students"); }
    catch (e) { showError(e, "기록 삭제"); }
  };
}
