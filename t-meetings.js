import {
  db, collection, doc, addDoc, setDoc, updateDoc, deleteDoc, writeBatch, serverTimestamp, $, $$, esc, toast, showError,
  STAGES, MEETING_TYPES, isoDay, fmtDay, defaultMeetingType
} from "./common.js";
import { S, register, rerender, myName, openModal, closeModal, readForm, opt, studentOptions, studentByNo } from "./t-core.js";
import { requestSync } from "./sync.js";

let root;
export function init(el) {
  root = el;
  root.innerHTML = `
    <div class="toolbar">
      <select id="mWho"><option value="mine">내가 참여한 기록</option><option value="">전체 기록</option></select>
      <select id="mStage">${opt(STAGES.map((s) => [s.key, s.label]), "", "전체 차수")}</select>
      <input id="mSearch" placeholder="학생 이름·학번">
      <div class="spacer"></div>
      <button class="btn-primary" id="mAdd">+ 대면 기록 추가</button>
    </div>
    <div id="mHidden"></div>
    <div class="card table-wrap"><table class="rows-sm">
      <thead><tr><th>학생</th><th>실시일</th><th>차수</th><th>면접 유형</th><th>담당교사</th><th>학생 공개</th></tr></thead>
      <tbody id="meetBody"></tbody></table></div>
    <p class="muted">'통합 플랫폼' 시트의 모의 면접 기록 탭과 쌍방으로 맞춰집니다. 시트에서 실시일·유형·담당교사를 고치면 앱에도 반영되고, 회차는 학생별 실시일 순서로 매겨집니다.</p>`;
  ["#mWho", "#mStage"].forEach((s) => $(s, root).onchange = render);
  $("#mSearch", root).oninput = render;
  $("#mAdd", root).onclick = () => openMeetingForm({});
  register("meetings", render);
}

const stageLabel = (k) => STAGES.find((s) => s.key === Number(k))?.label || "-";
export function syncBadge(m) {
  if (m.planned) return '<span class="badge badge-blue" title="일정 확정으로 자동 생성 · 면접 후 내용을 적어 주세요">일정 확정 · 기록 전</span>';
  return m.createdBy === "시트" ? '<span class="badge badge-gray" title="시트에서 직접 입력한 기록">시트 입력</span>' : "";
}

function render() {
  const who = $("#mWho", root).value, stage = $("#mStage", root).value, kw = $("#mSearch", root).value.trim();
  const me = myName();
  const list = S.meetings.filter((m) =>
    (!who || (me && (m.teachers || []).includes(me)) || m.createdByUid === S.ctx.user.uid)
    && (!stage || String(m.stage) === stage)
    && (!kw || `${m.name}${m.studentNo}`.includes(kw)));
  const hidden = S.meetings.filter((m) => !m.shared && hasContent(m) && (!me || (m.teachers || []).includes(me) || S.ctx.isAdmin));
  $("#mHidden", root).innerHTML = hidden.length ? `<div class="notice row">피드백을 적었지만 <b>학생에게 비공개</b>인 기록이 ${hidden.length}건 있어요. 학생 화면에 안 보입니다.
    <div class="spacer"></div><button class="btn-sm btn-primary" id="mShowAll">모두 학생에게 공개</button></div>` : "";
  $("#mShowAll", root)?.addEventListener("click", async () => {
    if (!confirm(`${hidden.length}건을 학생 화면에 공개할까요?`)) return;
    try {
      const b = writeBatch(db);
      hidden.forEach((m) => b.update(doc(db, "meetings", m.id), { shared: true }));
      await b.commit(); hidden.forEach((m) => m.shared = true);
      toast("공개했습니다."); render();
    } catch (e) { showError(e, "공개"); }
  });
  if (!list.length) {
    $("#meetBody", root).innerHTML = `<tr><td colspan="6" class="empty">${S.meetings.length ? "조건에 맞는 기록이 없습니다." : "아직 대면 기록이 없습니다."}</td></tr>`;
    return;
  }
  $("#meetBody", root).innerHTML = list.map((m) => `
    <tr class="clickable" data-id="${m.id}">
      <td class="nowrap head" data-l="-"><b>${esc(m.name)}</b> <span class="muted">${esc(m.studentNo)}</span> <span class="sm-only badge">${stageLabel(m.stage)}</span></td>
      <td class="nowrap pack" data-l="실시일">${fmtDay(m.date)}</td>
      <td class="nowrap lg-only">${stageLabel(m.stage)}</td><td class="pack" data-l="유형">${esc(m.type)}</td><td class="pack" data-l="담당">${esc((m.teachers || []).join(", "))}</td>
      <td data-l="학생 공개">${m.shared ? "공개" : '<span class="muted">비공개</span>'} ${syncBadge(m)}</td></tr>`).join("");
  $$("tr[data-id]", root).forEach((tr) => tr.onclick = () => openMeetingForm({ id: tr.dataset.id }));
}

export function meetingSummaryHtml(m) {
  return `<div class="q-item" data-mid="${m.id}" style="cursor:pointer">
    <div class="row"><b>${fmtDay(m.date)} · ${stageLabel(m.stage)}</b> <span class="badge">${esc(m.type)}</span>
      <span class="muted">${esc((m.teachers || []).join(", "))}</span><div class="spacer"></div>${m.shared ? "" : '<span class="muted">비공개</span>'} ${syncBadge(m)}</div>
    ${m.improve ? `<div class="q-meta">보완: ${esc(m.improve).slice(0, 120)}</div>` : ""}
  </div>`;
}

function defaultTeachers(st, stage) {
  const a = st?.assign || {};
  const me = myName();
  const byStage = { 1: [a.s1], 2: [a.s2], 3: [a.s3a, a.s3b] }[stage] || [];
  const list = byStage.filter(Boolean);
  if (me && !list.includes(me) && (!list.length || stage === 4)) list.unshift(me);
  return list.length ? list : (me ? [me] : []);
}
const defaultType = defaultMeetingType;
// 일정 확정·시트 입력으로 생긴 빈 기록은 처음 내용을 쓸 때 기본으로 '공개'
const hasContent = (m) => !!(m.questions || m.answerSummary || m.good || m.improve || m.nextGoal);
function guessStage(st) {
  const me = myName(); const a = st?.assign || {};
  const done = new Set(S.meetings.filter((m) => m.studentNo === st?.studentNo && !m.planned).map((m) => m.stage));
  if (a.s1 === me && !done.has(1)) return 1;
  if (a.s2 === me && !done.has(2)) return 2;
  if ((a.s3a === me || a.s3b === me) && !done.has(3)) return 3;
  return [1, 2, 3].find((k) => !done.has(k)) || 4;
}

// preset: 일정 탭 '대면 기록 쓰기' → { id: 'bk_예약ID', stage, date, teachers, bookingId }
export function openMeetingForm({ id = null, studentNo = "", preset = null }) {
  const m = id ? S.meetings.find((x) => x.id === id) : null;
  const st0 = studentByNo(m?.studentNo || studentNo);
  const stage0 = m?.stage || preset?.stage || (st0 ? guessStage(st0) : 1);
  const teachers0 = m?.teachers || preset?.teachers || defaultTeachers(st0, stage0);
  const staffNames = [...new Set([...S.staff.map((t) => t.name), ...teachers0])];
  const body = openModal(m ? "대면 모의면접 기록 수정" : "대면 모의면접 기록", `<form id="mf">
    <div class="grid grid-2" style="gap:0 14px">
      <div class="field"><label>학생 *</label><select name="studentNo" required ${m ? "disabled" : ""}>${studentOptions(st0?.studentNo || "")}</select></div>
      <div class="field"><label>차수</label><select name="stage">${opt(STAGES.map((s) => [s.key, s.label]), stage0)}</select></div>
      <div class="field"><label>실시일 *</label><input type="date" name="date" value="${esc(m?.date || preset?.date || isoDay())}" required></div>
      <div class="field"><label>면접 유형</label><select name="type">${opt(MEETING_TYPES, m?.type || defaultType(st0))}</select></div>
    </div>
    <div class="field"><label>담당교사</label>
      <div class="check-grid" id="tList">${staffNames.map((n) => `<label><input type="checkbox" value="${esc(n)}" ${teachers0.includes(n) ? "checked" : ""}> ${esc(n)}</label>`).join("") || '<span class="muted">교사 명단이 없습니다</span>'}</div>
    </div>
    <div class="field"><label>받은 질문</label><textarea name="questions" placeholder="한 줄에 한 질문">${esc(m?.questions || "")}</textarea></div>
    <div class="field"><label>답변 요약</label><textarea name="answerSummary" style="min-height:60px">${esc(m?.answerSummary || "")}</textarea></div>
    <div class="grid grid-2" style="gap:0 14px">
      <div class="field"><label>잘한 점</label><textarea name="good">${esc(m?.good || "")}</textarea></div>
      <div class="field"><label>보완할 점</label><textarea name="improve">${esc(m?.improve || "")}</textarea></div>
    </div>
    <div class="field"><label>다음 회차 목표</label><input name="nextGoal" value="${esc(m?.nextGoal || "")}"></div>
    <label class="inline-check" style="margin-bottom:14px"><input type="checkbox" name="shared" ${!m || m.shared || m.planned || !hasContent(m) ? "checked" : ""}> 학생 화면에 피드백 공개</label>
    <div class="row">
      <button class="btn-primary" id="mSave">저장</button>
      ${m ? `${syncBadge(m)}<div class="spacer"></div><button type="button" class="btn-sm btn-danger" id="mDel">삭제</button>` : ""}
    </div></form>`);

  const selNo = $("select[name=studentNo]", body), selStage = $("select[name=stage]", body);
  const refreshDefaults = () => {
    if (m) return;
    const st = studentByNo(selNo.value);
    if (!st) return;
    const dt = defaultTeachers(st, Number(selStage.value));
    $$("#tList input", body).forEach((c) => c.checked = dt.includes(c.value));
    $("select[name=type]", body).value = defaultType(st);
  };
  selNo.onchange = () => { const st = studentByNo(selNo.value); if (st && !m) selStage.value = guessStage(st); refreshDefaults(); };
  selStage.onchange = refreshDefaults;

  $("#mf", body).onsubmit = async (e) => {
    e.preventDefault();
    const f = readForm(body);
    const no = m?.studentNo || f.studentNo;
    const st = studentByNo(no);
    if (!st) return toast("학생을 선택하세요.", "error");
    const teachers = $$("#tList input:checked", body).map((c) => c.value);
    if (!teachers.length) return toast("담당교사를 한 명 이상 선택하세요.", "error");
    const data = {
      studentNo: no, name: st.name, cls: st.cls || "", studentUid: st.uid || "",
      stage: Number(f.stage), date: f.date, type: f.type, teachers,
      questions: f.questions, answerSummary: f.answerSummary, good: f.good, improve: f.improve, nextGoal: f.nextGoal,
      shared: !!f.shared, planned: false, updatedAt: serverTimestamp(), updatedAtMs: Date.now()
    };
    $("#mSave", body).disabled = true;
    try {
      if (m) {
        await updateDoc(doc(db, "meetings", m.id), data);
        Object.assign(m, data);
      } else {
        data.createdAt = serverTimestamp(); data.createdByUid = S.ctx.user.uid; data.createdBy = myName() || S.ctx.user.email;
        if (preset?.bookingId) data.bookingId = preset.bookingId;
        let newId;
        if (preset?.id) { await setDoc(doc(db, "meetings", preset.id), data, { merge: true }); newId = preset.id; }
        else newId = (await addDoc(collection(db, "meetings"), data)).id;
        S.meetings.unshift({ id: newId, ...data });
      }
    } catch (err) { showError(err, "기록 저장"); $("#mSave", body).disabled = false; return; }
    closeModal();
    toast("기록을 저장했습니다. 시트에 반영 중…");
    rerender("meetings", "home", "students");
    await requestSync(["meetings"]);
  };

  $("#mDel", body)?.addEventListener("click", async () => {
    if (!confirm("이 기록을 삭제할까요? 시트의 해당 행도 지웁니다.")) return;
    try {
      await deleteDoc(doc(db, "meetings", m.id));
      S.meetings = S.meetings.filter((x) => x.id !== m.id);
      closeModal(); rerender("meetings", "home", "students");
      await requestSync(["meetings"]);
    } catch (err) { showError(err, "기록 삭제"); }
  });
}
