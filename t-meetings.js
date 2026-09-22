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
    <div id="mLeft"></div>
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
  // 같은 '예약'에서 나온 기록이 따로 쓰여 있어 비어 있는 채로 남은 자리만 정리 대상
  const left = leftoverPlanned();
  const vague = ambiguousPlanned();
  const lineOf = (m) => `${esc(m.name)} ${esc(m.studentNo)} · ${fmtDay(m.date)} · ${stageLabel(m.stage)}`;
  $("#mLeft", root).innerHTML =
    (left.length ? `<div class="notice">같은 면접의 기록을 이미 쓰셨는데 <b>'일정 확정 · 기록 전'</b> 빈 자리가 ${left.length}건 남아 있어요.
      <div class="muted" style="margin:6px 0 8px">${left.map(lineOf).join("<br>")}</div>
      <button class="btn-sm btn-primary" id="mClean">이 ${left.length}건 지우기</button></div>` : "")
    + (vague.length ? `<div class="notice" style="margin-top:8px">아래 <b>'기록 전'</b> 자리는 <b>어느 면접의 것인지 확인되지 않아</b> 자동으로 정리하지 않습니다.
      같은 학생·차수의 기록이 따로 있으니 직접 열어 보고 판단해 주세요.
      <div style="margin-top:6px;display:grid;gap:6px">${vague.map((m) => `<div class="row"><span class="muted">${lineOf(m)}</span>
        <div class="spacer"></div><button type="button" class="btn-sm" data-vague="${esc(m.id)}">이 자리 지우기</button></div>`).join("")}</div></div>` : "");
  $$("#mLeft [data-vague]", root).forEach((btn) => btn.addEventListener("click", async () => {
    const m = vague.find((x) => x.id === btn.dataset.vague);
    if (!m) return;
    if (!confirm(`이 '기록 전' 자리를 지울까요?\n\n· ${m.name} ${m.studentNo} · ${fmtDay(m.date)} · ${stageLabel(m.stage)}\n\n내용이 비어 있는 자리만 지웁니다. 쓰신 기록은 그대로 남습니다.`)) return;
    btn.disabled = true;
    try {
      await deleteDoc(doc(db, "meetings", m.id));
      S.meetings = S.meetings.filter((x) => x.id !== m.id);
      toast("지웠습니다."); rerender("meetings", "home", "students");
      await requestSync(["meetings"]);
    } catch (e) { btn.disabled = false; showError(e, "정리"); }
  }));
  $("#mClean", root)?.addEventListener("click", async () => {
    if (!confirm(`아래 ${left.length}건을 지울까요? 내용이 비어 있고, 같은 면접의 기록이 따로 있는 자리만 지웁니다.\n\n`
      + left.map((m) => `· ${m.name} ${m.studentNo} · ${fmtDay(m.date)} · ${stageLabel(m.stage)}`).join("\n"))) return;
    try {
      const b = writeBatch(db);
      left.forEach((m) => b.delete(doc(db, "meetings", m.id)));
      await b.commit();
      const ids = new Set(left.map((m) => m.id));
      S.meetings = S.meetings.filter((m) => !ids.has(m.id));
      toast(`${ids.size}건을 정리했습니다.`); rerender("meetings", "home", "students");
      await requestSync(["meetings"]);
    } catch (e) { showError(e, "정리"); }
  });
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

// 이 기록이 어느 일정(예약)에서 나온 것인지. 일정 확정으로 자동 생성된 기록은 id 가 'bk_예약ID'.
export function bookingIdOf(m) {
  if (!m) return "";
  if (m.bookingId) return m.bookingId;
  return typeof m.id === "string" && m.id.startsWith("bk_") ? m.id.slice(3) : "";
}

// 한 학생의 '일정 확정 · 기록 전' 자리 목록 (고를 수 있게 날짜순)
export function plannedSlotsOf(studentNo) {
  return (S.meetings || [])
    .filter((x) => x.planned && String(x.studentNo) === String(studentNo))
    .sort((a, b) => String(a.date || "").localeCompare(String(b.date || "")));
}

// 기록을 새로 쓸 때 '확실히 같은 면접'이라고 볼 수 있는 자리만 고른다.
// 날짜가 가깝다는 이유만으로는 절대 연결하지 않는다. (과거 기록이 미래 예약을 덮어쓰던 문제)
// 확실한 경우 = 같은 학생·같은 차수이면서 실시일이 예약 날짜와 정확히 같고, 그런 자리가 하나뿐일 때.
export function findPlannedSlot(studentNo, stage, date) {
  if (!date) return null;
  const exact = plannedSlotsOf(studentNo)
    .filter((x) => Number(x.stage) === Number(stage) && String(x.date || "") === String(date));
  return exact.length === 1 ? exact[0] : null;
}

// 같은 '예약'에서 나온 기록이 이미 따로 쓰여 있어서 비어 있는 채로 남은 '기록 전' 자리.
// 학생·차수만 같은 다른 날짜의 정상 예정 기록은 절대 포함하지 않는다.
export function leftoverPlanned() {
  const all = S.meetings || [];
  return all.filter((m) => {
    if (!m.planned || hasContent(m)) return false;        // 내용이 있으면 손대지 않는다
    const bid = bookingIdOf(m);
    if (!bid) return false;                                // 예약을 알 수 없으면 자동 정리하지 않는다
    return all.some((x) => !x.planned && x.id !== m.id && bookingIdOf(x) === bid);
  });
}

// 연결 정보가 없어 자동 판단이 불가능한 '기록 전' 자리 (선생님이 직접 보고 정하도록 알려만 준다)
export function ambiguousPlanned() {
  const all = S.meetings || [];
  const auto = new Set(leftoverPlanned().map((m) => m.id));
  return all.filter((m) => {
    if (!m.planned || hasContent(m) || auto.has(m.id)) return false;
    // 예약을 알 수 없는 기록이 같은 학생·차수로 따로 있다 → 어느 면접의 것인지 단정할 수 없다
    return all.some((x) => !x.planned && x.id !== m.id && !bookingIdOf(x)
      && String(x.studentNo) === String(m.studentNo) && Number(x.stage) === Number(m.stage));
  });
}

// 이 '기록 전' 자리에 해당하는 면접 기록이 이미 쓰였는가 — 같은 '예약' 단위로 판단한다.
// 예약을 알 수 없는 옛 기록은 학생·차수·실시일이 모두 같을 때만 같은 면접으로 본다.
// (학생·차수만 같으면 다른 날짜의 면접까지 '다 썼다'고 보던 문제)
export function recordWrittenFor(m) {
  if (!m) return false;
  const all = S.meetings || [];
  const bid = bookingIdOf(m);
  return all.some((x) => {
    if (x.planned || x.id === m.id) return false;
    const xb = bookingIdOf(x);
    if (bid && xb) return xb === bid;            // 양쪽 다 예약을 알면 예약으로만 판단
    if (xb) return false;                        // 저쪽은 다른 예약의 기록
    return String(x.studentNo) === String(m.studentNo)
      && Number(x.stage) === Number(m.stage)
      && String(x.date || "") === String(m.date || "");
  });
}

// 일정에 done 표시만 세운다. 상태(확정)와 시간·장소는 건드리지 않으므로
// 시간 겹침 검사나 '일정 없는 차수' 계산에는 영향이 없다.
async function markBookingDone(bookingId) {
  const b = (S.bookings || []).find((x) => x.id === bookingId);
  if (b && b.done) return true;
  try {
    await updateDoc(doc(db, "bookings", bookingId), { done: true, doneAtMs: Date.now(), updatedAtMs: Date.now() });
    if (b) b.done = true;
    return true;
  } catch (err) {
    console.warn("일정 완료 표시 실패", err);   // 기록 저장은 이미 끝났으므로 되돌리지 않는다
    return false;
  }
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
    <div class="field" id="mLinkBox" hidden><label>잡아 둔 일정에 연결</label>
      <select id="mLink"></select>
      <span class="muted" style="display:block;margin-top:4px;font-size:.82rem">연결하면 그 일정의 기록이 되고 일정이 '완료'로 표시됩니다.</span></div>
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
  // ── 잡아 둔 일정 연결 (새 기록이고, 예약 화면에서 연 것이 아닐 때만)
  const linkBox = $("#mLinkBox", body), linkSel = $("#mLink", body);
  const dateInput = $('input[name="date"]', body);
  function refreshLinks() {
    if (m || preset?.id) { linkBox.hidden = true; return; }
    const no = selNo.value, stage = Number(selStage.value), date = dateInput.value;
    const cand = plannedSlotsOf(no);
    if (!cand.length) { linkBox.hidden = true; linkSel.innerHTML = ""; return; }
    const auto = findPlannedSlot(no, stage, date);   // 같은 차수 + 날짜가 정확히 일치하고 하나뿐일 때만
    linkBox.hidden = false;
    linkSel.innerHTML = `<option value="">연결 안 함 (새 기록으로 저장)</option>`
      + cand.map((x) => `<option value="${esc(x.id)}" ${auto && auto.id === x.id ? "selected" : ""}>${fmtDay(x.date)} · ${stageLabel(x.stage)} · ${esc((x.teachers || []).join(", "))}</option>`).join("");
  }
  selNo.onchange = () => { const st = studentByNo(selNo.value); if (st && !m) selStage.value = guessStage(st); refreshDefaults(); refreshLinks(); };
  selStage.onchange = () => { refreshDefaults(); refreshLinks(); };
  dateInput.onchange = refreshLinks;
  refreshLinks();

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
    // 새 기록이라도, 일정 확정으로 미리 만들어진 '기록 전' 자리가 있으면 그 자리에 쓴다.
    // 따로 만들면 빈 자리가 남아 '작성할 피드백' 에 계속 떠 있게 된다.
    // 연결은 ① 예약 화면에서 연 경우(preset) ② 선생님이 목록에서 고른 경우 둘뿐이다.
    // 날짜가 가깝다는 이유만으로 자동 연결하지 않는다.
    const pickedId = (!m && !preset?.id && !linkBox.hidden) ? (linkSel.value || "") : "";
    const picked = pickedId ? S.meetings.find((x) => x.id === pickedId && x.planned) : null;
    const slot = m ? null
      : preset?.id ? { id: preset.id, bookingId: preset.bookingId }
      : picked ? { id: picked.id, bookingId: bookingIdOf(picked) }
      : null;
    if (pickedId && !picked) return toast("고른 일정을 찾을 수 없어요. 창을 닫고 다시 열어 주세요.", "error");
    const filledSlot = !m && !preset?.id && !!slot;
    $("#mSave", body).disabled = true;
    let savedId = "";
    try {
      if (m) {
        await updateDoc(doc(db, "meetings", m.id), data);
        Object.assign(m, data);
        savedId = m.id;
      } else {
        data.createdAt = serverTimestamp(); data.createdByUid = S.ctx.user.uid; data.createdBy = myName() || S.ctx.user.email;
        if (slot?.bookingId) data.bookingId = slot.bookingId;
        if (slot) {
          await setDoc(doc(db, "meetings", slot.id), data, { merge: true });
          savedId = slot.id;
          const old = S.meetings.find((x) => x.id === slot.id);
          if (old) Object.assign(old, data); else S.meetings.unshift({ id: slot.id, ...data });
        } else {
          savedId = (await addDoc(collection(db, "meetings"), data)).id;
          S.meetings.unshift({ id: savedId, ...data });
        }
      }
    } catch (err) { showError(err, "기록 저장"); $("#mSave", body).disabled = false; return; }

    // 이 기록이 잡아 둔 일정에서 나온 것이면 그 일정을 '완료'로 표시한다.
    // → 오늘 면접 / 다가오는 확정 일정 목록에서 빠진다. (실패해도 기록 저장은 그대로 둔다)
    const bid = bookingIdOf(m) || bookingIdOf({ id: savedId, bookingId: slot?.bookingId || data.bookingId });
    const doneOk = bid ? await markBookingDone(bid) : true;

    closeModal();
    if (!doneOk) {
      // 기록은 저장됐지만 일정 완료 표시만 실패 → 무엇을 해야 하는지 알려 준다
      toast("기록은 저장했습니다. 다만 일정을 '완료'로 표시하지 못했어요. 일정 탭에서 그 일정을 열어 [면접 완료]를 눌러 주세요.", "error", 9000);
    } else {
      toast(filledSlot ? "잡혀 있던 면접의 기록으로 저장했습니다. 시트에 반영 중…" : "기록을 저장했습니다. 시트에 반영 중…");
    }
    rerender("meetings", "home", "students");
    await requestSync(["meetings"]);
  };

  $("#mDel", body)?.addEventListener("click", async () => {
    if (!confirm("이 기록을 삭제할까요? 시트의 해당 행도 지웁니다.")) return;
    const delBid = bookingIdOf(m);
    const delBk = delBid ? (S.bookings || []).find((x) => x.id === delBid) : null;
    try {
      await deleteDoc(doc(db, "meetings", m.id));
      S.meetings = S.meetings.filter((x) => x.id !== m.id);
      // 이 기록 때문에 '완료'로 표시된 일정이 있으면 어떻게 할지 물어본다
      if (delBk && delBk.done && confirm("이 기록과 이어진 일정이 '완료'로 표시돼 있어요. 완료 표시도 해제할까요?\n(해제하면 다가오는 일정 목록에 다시 나타납니다)")) {
        try { await updateDoc(doc(db, "bookings", delBid), { done: false, updatedAtMs: Date.now() }); delBk.done = false; }
        catch (e2) { toast("완료 표시를 해제하지 못했어요. 일정 탭에서 직접 풀어 주세요.", "error", 8000); }
      }
      closeModal(); rerender("meetings", "home", "students");
      await requestSync(["meetings"]);
    } catch (err) { showError(err, "기록 삭제"); }
  });
}
