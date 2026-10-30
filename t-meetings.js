import {
  db, collection, doc, getDocs, query, where, addDoc, setDoc, updateDoc, deleteDoc, writeBatch, serverTimestamp, $, $$, esc, toast, showError,
  STAGES, MEETING_TYPES, isoDay, fmtDay, defaultMeetingType, pqStats
} from "./common.js";
import { S, register, rerender, myName, openModal, closeModal, readForm, opt, studentOptions, studentByNo } from "./t-core.js";
import { requestSync } from "./sync.js";
import { queueNotify } from "./notify.js";

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

// ================= 선생님만 보는 메모 (2026-10-30 2단계) =================
// meetingNotes/{기록 ID}: 받은 질문 칸별 학생 답 메모·'다음 차수에 다시'·선생님 메모.
// 대면 기록(meetings) 문서는 공개하면 학생이 통째로 읽을 수 있어서 여기에 따로 둔다 (규칙: 선생님만).
// 캐시 목록이 아님 — 필요할 때 그 학생 것만 읽는다.
// 같은 글 판단: 앞뒤 공백·끝 문장부호(? . !) 차이는 무시
const qKey = (t) => String(t || "").trim().replace(/[?？.。!！\s]+$/, "");
const newQid = () => Math.random().toString(36).slice(2, 10);
const qLines = (s) => String(s || "").split("\n").map((x) => x.trim()).filter(Boolean);
const notesByNo = {};
export async function loadMeetingNotes(no) {
  const snap = await getDocs(query(collection(db, "meetingNotes"), where("studentNo", "==", String(no))));
  const map = {};
  snap.docs.forEach((d) => { map[d.id] = { id: d.id, ...d.data() }; });
  notesByNo[no] = map;
  return map;
}
export const cachedMeetingNotes = (no) => notesByNo[no] || null;

// 기록의 받은 질문 칸: 메모 문서의 칸 글을 이은 것이 지금 questions 와 같으면 그대로,
// 다르면(시트에서 고친 경우 등) questions 를 줄마다 나누고 같은 글의 메모·다시·id 를 붙인다
export function rowsOf(m, note) {
  const lines = qLines(m?.questions);
  const items = (note?.items || []).filter((i) => i && typeof i.q === "string" && i.q.trim());
  const copy = (i, q) => ({ id: i?.id || newQid(), q, memo: i?.memo || "", again: !!i?.again, ...(i?.from ? { from: i.from } : {}) });
  if (items.length && items.map((i) => i.q.trim()).join("\n") === lines.join("\n")) return items.map((i) => copy(i, i.q.trim()));
  const pool = items.slice();
  return lines.map((q) => {
    const k = pool.findIndex((x) => qKey(x.q) === qKey(q));
    return copy(k >= 0 ? pool.splice(k, 1)[0] : null, q);
  });
}

// '↻ 다시 물어볼 것': 이 학생의 다른 기록에서 '다음 차수에 다시'를 누른 칸 중 아직 어느 기록에도 넣지 않은 것
export function againList(no, notes, exceptMid = "") {
  const meets = new Map((S.meetings || []).filter((x) => String(x.studentNo) === String(no) && !x.planned).map((x) => [x.id, x]));
  const live = Object.values(notes || {}).filter((n) => meets.has(n.id) && n.id !== exceptMid);
  const used = new Set();
  live.forEach((n) => (n.items || []).forEach((i) => { if (i?.from) used.add(i.from.mid + ":" + i.from.qid); }));
  const out = [];
  live.forEach((n) => {
    const m = meets.get(n.id);
    rowsOf(m, n).forEach((i) => {
      if (i.again && !used.has(n.id + ":" + i.id)) out.push({ mid: n.id, qid: i.id, q: i.q, memo: i.memo, stage: m.stage, date: m.date, by: whoOf(m, n) });
    });
  });
  return out.sort((a, b) => String(a.date || "").localeCompare(String(b.date || "")));
}
const whoOf = (m, n) => n?.updatedBy || (m?.teachers || []).join(", ");

// 학생 상세 '대면 모의면접 기록' 안쪽 카드 (선생님 화면만 — 답 메모·다시·선생님 메모 포함)
// note: 메모 문서 · null = 메모 없음(예전 방식 카드, 점선) · undefined = 아직 못 읽음
export function meetingCardHtml(m, note) {
  if (m.planned) return meetingSummaryHtml(m);
  const rows = rowsOf(m, note);
  const again = rows.filter((r) => r.again);
  const legacy = note === null;
  const kv = (k, v) => v ? `<div class="mc-kv"><b>${k}</b> ${esc(v)}</div>` : "";
  return `<div class="q-item mc-card${legacy ? " legacy" : ""}" data-mid="${m.id}" style="cursor:pointer">
    <div class="row"><b>${fmtDay(m.date)} · ${stageLabel(m.stage)}</b> <span class="badge">${esc(m.type)}</span>
      <span class="muted">${esc((m.teachers || []).join(", "))}</span>${rows.length ? `<span class="muted">받은 질문 ${rows.length}</span>` : ""}
      <div class="spacer"></div>${m.shared ? "" : '<span class="muted">비공개</span>'} ${syncBadge(m)}</div>
    ${!note && rows.length ? `<div class="mc-kv"><b>받은 질문</b> ${rows.map((r) => esc(r.q)).join(" · ")}</div>` : ""}
    ${kv("보완할 점", m.improve)}
    ${again.length ? `<div class="mc-kv mc-again"><b>↻ 다시 물어볼 것</b> ${again.map((r) => esc(r.q)).join(" · ")} <span class="mc-lock">선생님만</span></div>` : ""}
    <details class="mc-more"><summary>자세히</summary>
      ${rows.map((r, i) => `<div class="mc-qa">${i + 1}. ${r.again ? "↻ " : ""}${esc(r.q)}${r.memo ? `<div class="mc-memo">답 메모 · ${esc(r.memo)}</div>` : ""}</div>`).join("")}
      ${kv("답변 요약", m.answerSummary)}${kv("잘한 점", m.good)}${kv("다음 목표", m.nextGoal)}${kv("선생님 메모", note?.note)}
    </details>
  </div>`;
}

// 받은 질문을 학생 '내 생기부 면접'에 더하기만 (같은 글 — 앞뒤 공백·끝 물음표 차이 무시 — 은 건너뜀). 더한 개수를 돌려준다
async function addReceivedToPq(no, stage, meetingId, qs) {
  const col = collection(db, "students", no, "personalQuestions");
  const cur = (await getDocs(col)).docs.map((d) => ({ id: d.id, ...d.data() }));
  const have = new Set(cur.map((q) => qKey(q.text)));
  const add = [];
  qs.forEach((q) => { const k = qKey(q); if (k && !have.has(k)) { have.add(k); add.push(q.trim()); } });
  if (!add.length) return 0;
  const by = myName() || S.ctx.user.email;
  const batch = writeBatch(db);
  const rows = add.map((text) => ({ text, basis: "", followUps: [], category: `${stage}차 모의면접에서 받은 질문`, type: "document",
    by: "teacher", addedBy: by, source: "meeting", meetingId }));
  rows.forEach((r) => batch.set(doc(col), { ...r, createdAt: serverTimestamp() }));
  const stats = pqStats([...cur, ...rows]);
  batch.update(doc(db, "students", no), stats);
  await batch.commit();
  const st = studentByNo(no); if (st) Object.assign(st, stats);
  return add.length;
}

// 쓰던 내용 임시 저장 (이 브라우저에만, 저장하면 지움)
const draftGet = (k) => { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : null; } catch { return null; } };
const draftPut = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch { return false; } };
const draftDel = (k) => { try { localStorage.removeItem(k); } catch {} };

// preset: 일정 탭 '대면 기록 쓰기' → { id: 'bk_예약ID', stage, date, teachers, bookingId }
export function openMeetingForm({ id = null, studentNo = "", preset = null }) {
  const m = id ? S.meetings.find((x) => x.id === id) : null;
  const st0 = studentByNo(m?.studentNo || studentNo);
  const stage0 = m?.stage || preset?.stage || (st0 ? guessStage(st0) : 1);
  const teachers0 = m?.teachers || preset?.teachers || defaultTeachers(st0, stage0);
  const staffNames = [...new Set([...S.staff.map((t) => t.name), ...teachers0])];
  // '내 생기부 면접에도 넣기' 기본값 (사용자 결정 2026-10-30): 새 기록·'일정 확정 · 기록 전'(planned) 자리를 처음 채울 때는 켜짐,
  // 이미 있는 기록(planned 아님)을 다시 열면 내용과 상관없이 꺼짐
  const written = !!m && !m.planned;
  const body = openModal(m ? "대면 모의면접 기록 수정" : "대면 모의면접 기록", `<div class="mt-wrap"><form id="mf" class="mt-main">
    <div id="mDraftBar"></div>
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
    <div class="mt-sec">
      <div class="mt-hd"><b>받은 질문</b><span class="mt-open">학생 공개</span><span class="muted sm">답 메모 · ↻ 표시는 <span class="mt-lock">선생님만</span></span>
        <div class="spacer"></div><button type="button" class="btn-sm" id="mAddQ">+ 질문</button><button type="button" class="btn-sm" id="mPickQ">예상질문에서 고르기</button></div>
      <div id="mQList"></div>
    </div>
    <div class="mt-sec">
      <div class="mt-hd"><b>피드백</b><span class="mt-open">학생 공개</span></div>
      <div class="field"><label>답변 요약</label><textarea name="answerSummary" style="min-height:60px">${esc(m?.answerSummary || "")}</textarea></div>
      <div class="grid grid-2" style="gap:0 14px">
        <div class="field"><label>잘한 점</label><textarea name="good">${esc(m?.good || "")}</textarea></div>
        <div class="field"><label>보완할 점</label><textarea name="improve">${esc(m?.improve || "")}</textarea></div>
      </div>
      <div class="field" style="margin-bottom:0"><label>다음 회차 목표</label><input name="nextGoal" value="${esc(m?.nextGoal || "")}"></div>
    </div>
    <div class="mt-sec mt-teacher">
      <div class="mt-hd"><b>선생님 메모</b><span class="mt-lock">선생님만</span><span class="muted sm">다음 차수 선생님이 '지난 면접'에서 봐요</span></div>
      <textarea id="mNote" placeholder="면접 태도, 다음 선생님께 전할 말" disabled></textarea>
      <div class="muted sm" id="mNoteSt">선생님 메모를 불러오는 중…</div>
    </div>
    <label class="inline-check"><input type="checkbox" name="shared" ${!m || m.shared || m.planned || !hasContent(m) ? "checked" : ""}> 학생 화면에 피드백 공개 <span class="muted sm">(받은 질문 · 피드백 4칸)</span></label>
    <label class="inline-check" style="margin-bottom:14px"><input type="checkbox" id="mToPq" ${written ? "" : "checked"}> 받은 질문을 학생 '내 생기부 면접'에도 넣기
      <span class="muted sm" style="display:block">"<span id="mPqLab">${stage0}</span>차 모의면접에서 받은 질문"으로 더해져요. 이미 있는 질문은 다시 넣지 않고, 예전 질문은 그대로예요. (공개할 때만)</span></label>
    <div class="row">
      <button class="btn-primary" id="mSave">저장</button><span class="muted sm" id="mDraftSt"></span>
      ${m ? `${syncBadge(m)}<div class="spacer"></div><button type="button" class="btn-sm btn-danger" id="mDel">삭제</button>` : ""}
    </div></form>
    <aside class="mt-past" id="mPast"><h4>지난 면접 <span class="mt-lock">선생님만</span></h4><div class="muted sm">불러오는 중…</div></aside></div>`, true);

  const selNo = $("select[name=studentNo]", body), selStage = $("select[name=stage]", body);
  const noNow = () => m?.studentNo || selNo.value;
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
  selNo.onchange = () => { const st = studentByNo(selNo.value); if (st && !m) selStage.value = guessStage(st); refreshDefaults(); refreshLinks(); loadPast(); onEdit(); };
  selStage.onchange = () => { refreshDefaults(); refreshLinks(); $("#mPqLab", body).textContent = selStage.value; onEdit(); };
  dateInput.onchange = () => { refreshLinks(); onEdit(); };
  refreshLinks();

  // ── 받은 질문 칸 (질문은 학생 공개, 답 메모·다시는 선생님만)
  let rows = rowsOf(m, null);
  let notes = null;            // 이 학생의 meetingNotes (기록 ID → 문서). 못 읽으면 null
  let noteDoc = null;          // 지금 기록의 meetingNotes
  let notesOk = !m;            // 지금 기록의 메모를 읽었는가 (새 기록은 읽을 것이 없음)
  const pickedPq = new Set();  // 예상질문에서 고른 칸 (출처 표시용)
  const qList = $("#mQList", body);
  const srcOf = (r) => {
    if (r.from) {
      const fm = S.meetings.find((x) => x.id === r.from.mid);
      return fm ? `↻ ${fm.stage}차에서 다시 · ${whoOf(fm, notes?.[fm.id])}` : "↻ 지난 면접에서 다시";
    }
    return pickedPq.has(r.id) ? "예상질문에서" : "";
  };
  function drawRows() {
    qList.innerHTML = rows.length ? rows.map((r, i) => `<div class="mt-q" data-qid="${esc(r.id)}"><div class="mt-n">${i + 1}</div><div class="mt-qbody">
        <input data-q value="${esc(r.q)}" placeholder="질문 (학생에게 보임)">
        <input class="mt-memo" data-memo value="${esc(r.memo)}" placeholder="학생 답 메모 (선생님끼리만)">
        ${srcOf(r) ? `<div class="mt-src">${esc(srcOf(r))}</div>` : ""}</div>
      <div class="mt-tools"><button type="button" class="mt-ag${r.again ? " on" : ""}" data-ag aria-pressed="${r.again}">↻ 다음 차수에 다시</button>
        <button type="button" class="mt-del" data-del title="이 줄 지우기" aria-label="이 줄 지우기">✕</button></div></div>`).join("")
      : '<div class="muted sm">받은 질문이 없어요. [+ 질문]을 눌러 적어 주세요.</div>';
    $$(".mt-q", qList).forEach((el) => {
      const r = rows.find((x) => x.id === el.dataset.qid);
      $("[data-q]", el).oninput = (e) => { r.q = e.target.value; onEdit(); };
      $("[data-memo]", el).oninput = (e) => { r.memo = e.target.value; onEdit(); };
      $("[data-ag]", el).onclick = () => { r.again = !r.again; drawRows(); onEdit(); if (r.again) toast("다음 차수 선생님의 '지난 면접' 맨 위에 보여요 (학생에게는 안 보여요)"); };
      $("[data-del]", el).onclick = () => { rows = rows.filter((x) => x !== r); drawRows(); drawPast(); onEdit(); };
    });
  }
  const addRows = (list) => { if (rows.length === 1 && !rows[0].q.trim() && !rows[0].memo.trim()) rows = []; rows.push(...list); drawRows(); drawPast(); onEdit(); };
  $("#mAddQ", body).onclick = () => { rows.push({ id: newQid(), q: "", memo: "", again: false }); drawRows(); onEdit(); $$("[data-q]", qList).pop()?.focus(); };
  $("#mPickQ", body).onclick = async () => {
    const no = noNow();
    if (!no) return toast("학생을 먼저 고르세요.", "error");
    let list;
    try { list = (await getDocs(collection(db, "students", no, "personalQuestions"))).docs.map((d) => d.data()).filter((q) => (q.text || "").trim()); }
    catch (e) { return showError(e, "예상질문 불러오기"); }
    if (!list.length) return toast("이 학생의 '내 생기부 면접' 예상질문이 아직 없어요.");
    const have = new Set(rows.map((r) => qKey(r.q)));
    const pk = document.createElement("div");
    pk.className = "mt-pick";
    pk.innerHTML = `<div class="mt-pbox" role="dialog" aria-label="예상질문에서 고르기"><b>예상질문에서 고르기</b> <span class="muted sm">· ${esc(studentByNo(no)?.name || no)} '내 생기부 면접'</span>
      <div class="mt-plist">${list.map((q, i) => { const on = have.has(qKey(q.text)); return `<label><input type="checkbox" value="${i}" ${on ? "checked disabled" : ""}> <span>${esc(q.text)}${on ? ' <span class="muted sm">· 이미 넣음</span>' : ""}${q.category ? `<span class="muted sm" style="display:block">${esc(q.category)}</span>` : ""}</span></label>`; }).join("")}</div>
      <div class="row" style="justify-content:flex-end;margin-top:10px"><button type="button" class="btn-sm" data-x>취소</button><button type="button" class="btn-sm btn-primary" data-ok>넣기</button></div></div>`;
    body.append(pk);
    $("[data-x]", pk).onclick = () => pk.remove();
    $("[data-ok]", pk).onclick = () => {
      const sel = $$("input:checked:not(:disabled)", pk).map((x) => list[Number(x.value)].text.trim());
      pk.remove();
      if (!sel.length) return;
      const add = sel.map((q) => { const r = { id: newQid(), q, memo: "", again: false }; pickedPq.add(r.id); return r; });
      addRows(add);
      toast(`${add.length}개 넣었어요`);
    };
  };

  // ── 지난 면접 (이 학생의 다른 기록 + 선생님 메모)
  const past = $("#mPast", body);
  let pastFor = "";
  async function loadPast() {
    const no = noNow();
    pastFor = no;
    if (!no) { past.innerHTML = '<h4>지난 면접 <span class="mt-lock">선생님만</span></h4><div class="muted sm">학생을 고르면 이 학생의 지난 기록이 보여요.</div>'; return; }
    past.innerHTML = '<h4>지난 면접 <span class="mt-lock">선생님만</span></h4><div class="muted sm">불러오는 중…</div>';
    try {
      const map = await loadMeetingNotes(no);
      if (pastFor !== no || !body.isConnected) return;
      notes = map;
    } catch (e) {
      if (pastFor !== no || !body.isConnected) return;
      console.warn("지난 면접 불러오기", e);
      notes = null;
      past.innerHTML = '<h4>지난 면접 <span class="mt-lock">선생님만</span></h4><div class="muted sm">지난 면접을 불러오지 못했어요. <button type="button" class="btn-sm" id="mPastRetry">다시</button></div>';
      $("#mPastRetry", past).onclick = loadPast;
      if (m && !notesOk) { noteFailed(); if (!draftChecked) { draftChecked = true; checkDraft(); } }
      return;
    }
    if (m && !notesOk) {
      noteDoc = notes[m.id] || null;
      notesOk = true;
      if (!draftApplied) { rows = rowsOf(m, noteDoc); $("#mNote", body).value = noteDoc?.note || ""; }
      base = snapshot();
      drawRows();
      $("#mDraftBar", body).innerHTML = "";
      checkDraft();
    }
    noteReady();
    drawPast();
  }
  function noteReady() { const t = $("#mNote", body); t.disabled = false; $("#mNoteSt", body).textContent = ""; }
  function noteFailed() {
    $("#mNoteSt", body).innerHTML = '선생님 메모·답 메모를 불러오지 못해 지금은 고칠 수 없어요. (받은 질문·피드백은 저장돼요) <button type="button" class="btn-sm" id="mNoteRetry">다시</button>';
    $("#mNoteRetry", body).onclick = loadPast;
  }
  function drawPast() {
    if (!notes) return;
    const no = noNow();
    const curId = m?.id || "";
    const others = S.meetings.filter((x) => String(x.studentNo) === String(no) && !x.planned && x.id !== curId)
      .sort((a, b) => String(b.date || "").localeCompare(String(a.date || "")));
    const ag = againList(no, notes, curId);
    const usedHere = new Set(rows.filter((r) => r.from).map((r) => r.from.mid + ":" + r.from.qid));
    let h = '<h4>지난 면접 <span class="mt-lock">선생님만</span></h4>';
    if (!others.length) h += `<div class="mt-pc muted sm">이 학생의 첫 대면 기록이에요.<br>여기서 <b>↻ 다음 차수에 다시</b>를 누른 질문은 다음 차수 선생님의 이 칸 맨 위에 보여요.</div>`;
    if (ag.length) h += `<div class="mt-aq"><b>↻ 다시 물어볼 것 ${ag.filter((a) => !usedHere.has(a.mid + ":" + a.qid)).length}</b>${ag.map((a) => `<div class="mt-qa">
        <span class="badge">${stageLabel(a.stage)} · ${esc(a.by)}</span> <b>${esc(a.q)}</b>${a.memo ? `<div class="mt-m">답 메모 · ${esc(a.memo)}</div>` : ""}
        ${usedHere.has(a.mid + ":" + a.qid) ? '<div class="mt-done">받은 질문에 넣었어요 ✓</div>' : `<button type="button" class="btn-sm" data-put="${esc(a.mid)}:${esc(a.qid)}">받은 질문에 넣기</button>`}</div>`).join("")}</div>`;
    h += others.map((x) => {
      const n = notes[x.id], rs = rowsOf(x, n);
      const kv = (k, v) => v ? `<div class="mc-kv"><b>${k}</b> ${esc(v)}</div>` : "";
      return n ? `<div class="mt-pc"><div class="row"><span class="badge">${stageLabel(x.stage)}</span><b>${fmtDay(x.date)} · ${esc((x.teachers || []).join(", "))}</b></div>
          ${rs.map((r) => `<div class="mt-qa">${r.again ? "↻ " : ""}${esc(r.q)}${r.memo ? `<div class="mt-m">${esc(r.memo)}</div>` : ""}</div>`).join("")}
          ${kv("보완할 점", x.improve)}${kv("다음 목표", x.nextGoal)}${kv("선생님 메모", n.note)}</div>`
        : `<div class="mt-pc legacy"><div class="row"><span class="badge">${stageLabel(x.stage)}</span><b>${fmtDay(x.date)} · ${esc((x.teachers || []).join(", "))}</b></div>
          ${rs.length ? kv("받은 질문", rs.map((r) => r.q).join(" · ")) : ""}${kv("보완할 점", x.improve)}${kv("다음 목표", x.nextGoal)}</div>`;
    }).join("");
    past.innerHTML = h;
    $$("[data-put]", past).forEach((b) => b.onclick = () => {
      const [mid, qid] = b.dataset.put.split(":");
      const a = ag.find((x) => x.mid === mid && x.qid === qid);
      if (!a) return;
      addRows([{ id: newQid(), q: a.q, memo: "", again: false, from: { mid, qid } }]);
      toast("받은 질문에 넣었어요");
    });
  }

  // ── 임시 저장 (이 브라우저, 1.2초 묶어서)
  const keyNow = () => "mdraft:" + (m ? m.id : preset?.bookingId || preset?.id || `new:${selNo.value || ""}:${selStage.value}`);
  const key0 = keyNow();
  const snapshot = () => {
    const f = readForm(body);
    return { studentNo: noNow(), stage: selStage.value, date: dateInput.value, type: f.type,
      teachers: $$("#tList input:checked", body).map((c) => c.value),
      rows: rows.map(({ id, q, memo, again, from }) => ({ id, q, memo, again, ...(from ? { from } : {}) })),
      answerSummary: f.answerSummary || "", good: f.good || "", improve: f.improve || "", nextGoal: f.nextGoal || "",
      note: $("#mNote", body).value, shared: !!f.shared, toPq: $("#mToPq", body).checked };
  };
  let base = snapshot();
  let draftApplied = false, draftChecked = false, draftTimer = null, finished = false;
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  function onEdit() {
    clearTimeout(draftTimer);
    draftTimer = setTimeout(() => {
      if (finished || !formEl.isConnected) return;
      const s = snapshot();
      if (same(s, base)) { draftDel(keyNow()); $("#mDraftSt", body).textContent = ""; return; }
      $("#mDraftSt", body).textContent = draftPut(keyNow(), { ...s, at: Date.now() }) ? "임시 저장됨 · 방금" : "";
    }, 1200);
  }
  function applyDraft(d) {
    if (!m && d.studentNo && selNo.value !== d.studentNo) { selNo.value = d.studentNo; refreshLinks(); }
    if (d.stage) selStage.value = d.stage;
    if (d.date) dateInput.value = d.date;
    if (d.type) $("select[name=type]", body).value = d.type;
    $$("#tList input", body).forEach((c) => c.checked = (d.teachers || []).includes(c.value));
    rows = (d.rows || []).map((r) => ({ id: r.id || newQid(), q: r.q || "", memo: r.memo || "", again: !!r.again, ...(r.from ? { from: r.from } : {}) }));
    ["answerSummary", "good", "improve"].forEach((k) => { $(`textarea[name=${k}]`, body).value = d[k] || ""; });
    $("input[name=nextGoal]", body).value = d.nextGoal || "";
    $("#mNote", body).value = d.note || "";
    $("input[name=shared]", body).checked = !!d.shared;
    $("#mToPq", body).checked = !!d.toPq;
    $("#mPqLab", body).textContent = selStage.value;
    draftApplied = true;
    drawRows(); drawPast();
  }
  function checkDraft() {
    const d = draftGet(key0);
    const bar = $("#mDraftBar", body);
    if (!d || !bar) return;
    const { at, ...rest } = d;
    if (same(rest, base)) { draftDel(key0); return; }
    const t = new Date(at || Date.now());
    bar.innerHTML = `<div class="notice row mt-draftbar">쓰던 내용이 있어요 <span class="muted sm">(${t.getMonth() + 1}/${t.getDate()} ${String(t.getHours()).padStart(2, "0")}:${String(t.getMinutes()).padStart(2, "0")})</span>
      <div class="spacer"></div><button type="button" class="btn-sm btn-primary" id="mDraftLoad">불러오기</button><button type="button" class="btn-sm" id="mDraftDrop">버리기</button></div>`;
    $("#mDraftLoad", bar).onclick = () => { applyDraft(rest); bar.innerHTML = ""; $("#mDraftSt", body).textContent = "쓰던 내용을 불러왔어요"; };
    $("#mDraftDrop", bar).onclick = () => { draftDel(key0); bar.innerHTML = ""; };
  }
  const formEl = $("#mf", body);
  $("#mf", body).addEventListener("input", (e) => { if (!e.target.closest("#mQList")) onEdit(); });
  $("#mf", body).addEventListener("change", (e) => { if (e.target.closest("#tList") || e.target.name === "shared" || e.target.id === "mToPq" || e.target.name === "type") onEdit(); });

  drawRows();
  if (!m) { noteReady(); checkDraft(); }   // 새 기록: 메모를 읽을 것이 없으니 바로 (지난 면접은 따로 불러옴)
  loadPast();

  $("#mf", body).onsubmit = async (e) => {
    e.preventDefault();
    const f = readForm(body);
    const no = m?.studentNo || f.studentNo;
    const st = studentByNo(no);
    if (!st) return toast("학생을 선택하세요.", "error");
    const teachers = $$("#tList input:checked", body).map((c) => c.value);
    if (!teachers.length) return toast("담당교사를 한 명 이상 선택하세요.", "error");
    const qRows = rows.map((r) => ({ ...r, q: r.q.trim(), memo: r.memo.trim() })).filter((r) => r.q);
    const data = {
      studentNo: no, name: st.name, cls: st.cls || "", studentUid: st.uid || "",
      stage: Number(f.stage), date: f.date, type: f.type, teachers,
      questions: qRows.map((r) => r.q).join("\n"), answerSummary: f.answerSummary, good: f.good, improve: f.improve, nextGoal: f.nextGoal,
      shared: !!f.shared, planned: false, updatedAt: serverTimestamp(), updatedAtMs: Date.now()
    };
    const noteText = $("#mNote", body).value.trim();
    const toPq = $("#mToPq", body).checked && data.shared;
    const draftKey = keyNow();
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

    // 선생님만 보는 메모: 답 메모·다시·출처·선생님 메모가 하나도 없으면 문서를 두지 않는다
    // (지금 기록의 메모를 읽지 못했으면 덮어쓰지 않는다 — 있던 메모를 지울 수 있으므로)
    const fails = [];
    if (notesOk) {
      const keep = qRows.some((r) => r.memo || r.again || r.from) || noteText;
      const ref = doc(db, "meetingNotes", savedId);
      try {
        if (keep) {
          const nd = { studentNo: no, stage: data.stage, date: data.date,
            items: qRows.map(({ id, q, memo, again, from }) => ({ id, q, memo, again: !!again, ...(from ? { from } : {}) })),
            note: noteText, updatedAtMs: Date.now(), updatedBy: myName() || S.ctx.user.email };
          await setDoc(ref, nd);
          if (notesByNo[no]) notesByNo[no][savedId] = { id: savedId, ...nd };
        } else if (noteDoc || (notesByNo[no] && notesByNo[no][savedId])) {
          await deleteDoc(ref);
          if (notesByNo[no]) delete notesByNo[no][savedId];
        }
      } catch (err) { console.warn("선생님 메모 저장", err); fails.push("선생님 메모"); }
    } else if (qRows.some((r) => r.memo || r.again) || noteText) fails.push("선생님 메모");
    // 받은 질문 → '내 생기부 면접' (더하기만)
    let pqAdded = 0;
    if (toPq && qRows.length) {
      try { pqAdded = await addReceivedToPq(no, data.stage, savedId, qRows.map((r) => r.q)); }
      catch (err) { console.warn("예상질문 넣기", err); fails.push("예상질문 넣기"); }
    }
    clearTimeout(draftTimer);
    if (!fails.length) { finished = true; draftDel(draftKey); draftDel(key0); }

    // 이 기록이 잡아 둔 일정에서 나온 것이면 그 일정을 '완료'로 표시한다.
    // → 오늘 면접 / 다가오는 확정 일정 목록에서 빠진다. (실패해도 기록 저장은 그대로 둔다)
    const bid = bookingIdOf(m) || bookingIdOf({ id: savedId, bookingId: slot?.bookingId || data.bookingId });
    const doneOk = bid ? await markBookingDone(bid) : true;

    closeModal();
    if (fails.length) {
      toast(`기록은 저장했어요. 다만 ${fails.join("·")}를 저장하지 못했어요 — 창을 다시 열어 저장해 주세요.`, "error", 10000);
    } else if (!doneOk) {
      // 기록은 저장됐지만 일정 완료 표시만 실패 → 무엇을 해야 하는지 알려 준다
      toast("기록은 저장했습니다. 다만 일정을 '완료'로 표시하지 못했어요. 일정 탭에서 그 일정을 열어 [면접 완료]를 눌러 주세요.", "error", 9000);
    } else {
      const extra = pqAdded ? ` · 내 생기부 면접에 ${pqAdded}개 더함` : "";
      toast((filledSlot ? "잡혀 있던 면접의 기록으로 저장했습니다." : "기록을 저장했습니다.") + extra + " 시트에 반영 중…");
    }
    // 학생에게 공개한 기록이면 휴대폰으로 알린다 (알림을 켜 둔 학생만)
    if (data.shared && hasContent(data)) {
      queueNotify({ key: data.studentNo, title: "선생님 피드백이 도착했어요",
        body: `${stageLabel(data.stage)} · ${(data.teachers || []).join(", ")} 선생님`,
        url: "student.html#feedback", tag: `fb_m_${savedId}` });
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
      // 선생님 메모도 함께 지운다 (내 생기부 면접에 넣은 질문은 그대로)
      try { await deleteDoc(doc(db, "meetingNotes", m.id)); if (notesByNo[m.studentNo]) delete notesByNo[m.studentNo][m.id]; }
      catch (e3) { console.warn("선생님 메모 삭제", e3); }
      finished = true; clearTimeout(draftTimer); draftDel(key0);
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
