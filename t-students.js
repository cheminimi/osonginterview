import {
  db, collection, doc, getDoc, setDoc, addDoc, updateDoc, deleteDoc, $, $$, esc, toast, showError, fmtDate, fmtDay, ddayBadge,
  TRACKS, SPECIALS, STAGES, nextInterview, serverTimestamp
} from "./common.js";
import { S, register, rerender, myName, myRoles, stageChips, nextBadge, openModal, closeModal, switchTab, readForm, opt, attachInterviews, loadAllSessions, RECENT_DAYS } from "./t-core.js";
import { requestSync } from "./sync.js";
import { openMeetingForm, meetingSummaryHtml } from "./t-meetings.js";
import { selectStudentForQuestions } from "./t-questions.js";
import { openReview } from "./t-review.js";

let root;
export function init(el) {
  root = el;
  root.innerHTML = `
    <div class="toolbar">
      <select id="fCls"><option value="">전체 반</option></select>
      <select id="fTrack">${opt(TRACKS, "", "전체 트랙")}</select>
      <select id="fSpecial"><option value="">특별 트랙 전체</option><option value="has">제시문/MMI 있음</option></select>
      <label class="inline-check"><input type="checkbox" id="fMine"> 내 담당만</label>
      <input id="fSearch" placeholder="이름·학번">
      <select id="fSort"><option value="dday">다음 면접 순</option><option value="no">학번 순</option></select>
      <div class="spacer"></div><span class="muted" id="fCount"></span>
    </div>
    <div class="card table-wrap"><table>
      <thead><tr><th>학번</th><th>이름</th><th>트랙</th><th class="nowrap">다음 면접</th><th>1차 담임</th><th>2차 교과</th><th>3차 위원</th><th>진행</th><th>연습</th><th>시트</th></tr></thead>
      <tbody id="stBody"></tbody></table></div>`;
  ["#fCls", "#fTrack", "#fSpecial", "#fMine", "#fSort"].forEach((s) => $(s, root).onchange = render);
  $("#fSearch", root).oninput = render;
  register("students", render);
}

function render() {
  const cls = [...new Set(S.students.map((s) => s.cls).filter(Boolean))].sort((a, b) => a.localeCompare(b, "ko", { numeric: true }));
  const cur = $("#fCls", root).value;
  $("#fCls", root).innerHTML = opt(cls, cur, "전체 반");
  const f = {
    cls: $("#fCls", root).value, track: $("#fTrack", root).value, sp: $("#fSpecial", root).value,
    mine: $("#fMine", root).checked, kw: $("#fSearch", root).value.trim(), sort: $("#fSort", root).value
  };
  let list = S.students.filter((s) =>
    (!f.cls || s.cls === f.cls) && (!f.track || s.track === f.track)
    && (!f.sp || (s.special && s.special !== "없음"))
    && (!f.mine || myRoles(s).length) && (!f.kw || `${s.name}${s.studentNo}`.includes(f.kw)));
  if (f.sort === "dday") list = [...list].sort((a, b) => (nextInterview(a) || 9e15) - (nextInterview(b) || 9e15));
  $("#fCount", root).textContent = `${list.length}명`;
  if (!list.length) {
    $("#stBody", root).innerHTML = `<tr><td colspan="10" class="empty">${S.students.length ? "조건에 맞는 학생이 없습니다." : "등록된 학생이 없습니다. 관리 탭에서 운영 원본을 가져오세요."}</td></tr>`;
    return;
  }
  const me = myName();
  const hl = (n) => n ? (n === me ? `<b style="color:var(--accent)">${esc(n)}</b>` : esc(n)) : '<span class="muted">-</span>';
  $("#stBody", root).innerHTML = list.map((s) => {
    const a = s.assign || {};
    const practice = S.sessions.filter((x) => x.studentNo === s.studentNo && x.status === "submitted").length;
    return `<tr class="clickable" data-no="${s.studentNo}">
      <td>${esc(s.studentNo)}</td><td class="nowrap"><b>${esc(s.name)}</b></td>
      <td>${esc(s.track || "")}${s.special && s.special !== "없음" ? ` <span class="badge badge-violet">${esc(s.special)}</span>` : ""}</td>
      <td class="nowrap">${nextBadge(s)}</td>
      <td class="nowrap">${hl(a.s1)}</td><td class="nowrap">${hl(a.s2)}</td><td class="nowrap">${hl(a.s3a)}${a.s3b ? " · " + hl(a.s3b) : ""}</td>
      <td class="nowrap">${stageChips(s)}</td><td>${practice || "-"}</td>
      <td>${s.sheetUrl ? `<a href="${esc(s.sheetUrl)}" target="_blank" rel="noopener" data-stop>열기</a>` : "-"}</td></tr>`;
  }).join("");
  $$("tr[data-no]", root).forEach((tr) => tr.onclick = (e) => { if (!e.target.closest("[data-stop]")) openStudent(tr.dataset.no); });
}

export async function openStudent(no) {
  const s = S.students.find((x) => x.studentNo === no);
  if (!s) return;
  const a = s.assign || {};
  const meets = S.meetings.filter((m) => m.studentNo === no).sort((x, y) => (x.date || "").localeCompare(y.date || ""));
  const sess = S.sessions.filter((x) => x.studentNo === no);
  const d = nextInterview(s);
  const body = openModal(`${s.studentNo} ${s.name}`, `
    <div class="row" style="margin-bottom:12px">
      ${d ? ddayBadge(d) + ` <span class="muted">다음 면접 ${fmtDay(d)}</span>` : ""}
      <span class="badge">${esc(s.track || "트랙 미정")}</span>
      ${s.special && s.special !== "없음" ? `<span class="badge badge-violet">${esc(s.special)}</span>` : ""}
      ${s.priority ? `<span class="badge ${s.priority === "긴급" ? "badge-red" : "badge-gray"}">${esc(s.priority)}</span>` : ""}
      <div class="spacer"></div>
      ${s.sheetUrl ? `<a class="btn btn-sm" href="${esc(s.sheetUrl)}" target="_blank" rel="noopener">준비 시트 열기</a>` : '<span class="muted">준비 시트 링크 없음</span>'}
      <button class="btn-sm btn-primary" id="addMeet">대면 기록 추가</button>
    </div>

    <div class="grid grid-2">
      <div class="card" style="box-shadow:none">
        <h3>지도 배정</h3>
        <dl class="kv">
          <dt>1차 담임</dt><dd>${esc(a.s1 || "-")}</dd>
          <dt>2차 교과</dt><dd>${esc(a.s2 || "-")}${s.focus2 ? `<div class="muted">${esc(s.focus2)}</div>` : ""}</dd>
          <dt>3차 위원</dt><dd>${esc([a.s3a, a.s3b].filter(Boolean).join(", ") || "-")}${s.focus3 ? `<div class="muted">${esc(s.focus3)}</div>` : ""}</dd>
          ${s.note ? `<dt>비고</dt><dd class="muted">${esc(s.note)}</dd>` : ""}
        </dl>
      </div>
      <div class="card" style="box-shadow:none">
        <h3>수요조사</h3>
        <dl class="kv">
          <dt>희망 교과</dt><dd>${esc(s.subject1 || "-")}${s.subject2 ? ` <span class="muted">+ ${esc(s.subject2)}</span>` : ""}</dd>
          <dt>준비 정도</dt><dd>${esc(s.readiness || "-")}</dd>
          <dt>도움 필요</dt><dd>${(s.needs || []).map((n) => `<span class="chip">${esc(n)}</span>`).join("") || "-"}</dd>
          ${(s.memos || []).length ? `<dt>전달 메모</dt><dd class="pre">${esc(s.memos.join("\n"))}</dd>` : ""}
        </dl>
      </div>
    </div>

    <div class="section-title"><h3>지원 대학 · 면접일</h3><span class="muted">시트 '앱연동_면접일'과 연동</span>
      <div class="spacer"></div><button class="btn-sm" id="addIv">+ 대학 추가</button></div>
    ${(s.universities || []).length ? `<div class="table-wrap"><table><thead><tr><th>면접일</th><th>대학</th><th>학과</th><th>전형</th><th>면접 유형</th><th></th></tr></thead><tbody>
      ${s.universities.map((u) => `<tr><td class="nowrap">${u.date ? `${ddayBadge(u.date)} ${fmtDay(u.date)}` : "-"}</td><td>${esc(u.univ)}</td><td>${esc(u.dept)}</td><td>${esc(u.admission)}</td><td>${esc(u.format)}</td>
        <td class="nowrap"><button class="btn-sm" data-iv="${u.id}">수정</button></td></tr>`).join("")}
      </tbody></table></div>` : '<div class="muted">등록된 면접일이 없습니다.</div>'}

    <div class="section-title"><h3>대면 모의면접 기록</h3>${stageChips(s)}</div>
    <div id="meetList">${meets.length ? meets.map((m) => meetingSummaryHtml(m)).join("") : '<div class="muted">아직 없습니다.</div>'}</div>

    <div class="section-title"><h3>말하기 연습</h3><span class="muted">예상질문 ${s.pqCount || 0}개 · 제출 ${sess.filter((x) => x.status === "submitted").length}회${S.sessionsScope === "all" ? "" : ` (최근 ${RECENT_DAYS}일) <a href="#" id="sessAll">전체 보기</a>`}</span>
      <div class="spacer"></div><button class="btn-sm" id="toQ">예상질문 관리 →</button></div>
    ${sess.length ? sess.slice(0, 8).map((x) => `<div class="q-item clickable" data-sid="${x.id}" style="cursor:pointer">
      <b>${esc(x.modeLabel)}</b> <span class="muted">${fmtDate(x.startedAt)} · ${(x.items || []).length}문항</span>
      ${x.status !== "submitted" ? '<span class="badge badge-gray">미완료</span>' : x.reviewedAt ? '<span class="badge badge-green">검토 완료</span>' : '<span class="badge badge-orange">검토 대기</span>'}</div>`).join("") : '<div class="muted">연습 기록 없음</div>'}

    <div class="section-title"><h3>교사 메모</h3><span class="muted">학생에게 보이지 않음</span></div>
    <textarea id="noteText" placeholder="지도 중 공유할 메모"></textarea>
    <div class="row" style="margin-top:6px"><button class="btn-sm" id="saveNote">메모 저장</button><span class="muted" id="noteState"></span></div>

    <details style="margin-top:20px"><summary class="muted">트랙·배정·시트 링크 수정 (시트 '앱연동_학생'과 연동)</summary>
      <form id="editF" style="margin-top:10px">
        <div class="grid grid-2" style="gap:0 14px">
          <div class="field"><label>이름</label><input name="name" value="${esc(s.name)}"></div>
          <div class="field"><label>우선도</label><input name="priority" value="${esc(s.priority || "")}" placeholder="긴급 / 1순위 / 2순위"></div>
          <div class="field"><label>기본 트랙</label><select name="track">${opt(TRACKS, s.track, "미정")}</select></div>
          <div class="field"><label>특별 트랙</label><select name="special">${opt(SPECIALS, s.special || "없음")}</select></div>
          <div class="field"><label>1차 담임</label><input name="s1" value="${esc(a.s1 || "")}" list="staffNames"></div>
          <div class="field"><label>2차 교과</label><input name="s2" value="${esc(a.s2 || "")}" list="staffNames"></div>
          <div class="field"><label>3차 1위원</label><input name="s3a" value="${esc(a.s3a || "")}" list="staffNames"></div>
          <div class="field"><label>3차 2위원</label><input name="s3b" value="${esc(a.s3b || "")}" list="staffNames"></div>
        </div>
        <div class="field"><label>준비 시트 링크</label><input name="sheetUrl" value="${esc(s.sheetUrl || "")}"></div>
        <datalist id="staffNames">${S.staff.map((t) => `<option value="${esc(t.name)}">`).join("")}</datalist>
        <button class="btn-primary btn-sm">저장</button>
      </form>
    </details>`, true);

  $("#addMeet", body).onclick = () => openMeetingForm({ studentNo: no });
  $("#sessAll", body)?.addEventListener("click", async (e) => { e.preventDefault(); try { await loadAllSessions(); openStudent(no); } catch (err) { showError(err, "연습 기록 불러오기"); } });
  $("#toQ", body).onclick = () => { closeModal(); switchTab("questions"); selectStudentForQuestions(no); };
  $$("[data-sid]", body).forEach((el) => el.onclick = () => openReview(el.dataset.sid));
  $$("[data-mid]", body).forEach((el) => el.onclick = () => openMeetingForm({ id: el.dataset.mid }));

  // 교사 메모
  try {
    const n = await getDoc(doc(db, "studentNotes", no));
    if (n.exists()) $("#noteText", body).value = n.data().text || "";
  } catch (e) { showError(e, "메모 불러오기"); }
  $("#saveNote", body).onclick = async () => {
    try {
      await setDoc(doc(db, "studentNotes", no), { text: $("#noteText", body).value, updatedBy: myName() || S.ctx.user.email, updatedAt: serverTimestamp() }, { merge: true });
      $("#noteState", body).textContent = "저장됨";
    } catch (e) { showError(e, "메모 저장"); }
  };

  $("#editF", body).onsubmit = async (e) => {
    e.preventDefault();
    const f = readForm($("#editF", body));
    const upd = {
      name: f.name, priority: f.priority, track: f.track, special: f.special, sheetUrl: f.sheetUrl,
      assign: { s1: f.s1, s2: f.s2, s3a: f.s3a, s3b: f.s3b }, syncFieldsAt: Date.now(), syncedBy: myName() || S.ctx.user.email
    };
    try {
      await updateDoc(doc(db, "students", no), upd);
      Object.assign(s, upd); toast("저장했습니다."); rerender(); openStudent(no);
      requestSync(["students"]);
    } catch (err) { showError(err, "학생 정보 저장"); }
  };

  $("#addIv", body).onclick = () => openInterviewForm(s, null);
  $$("[data-iv]", body).forEach((b) => b.onclick = () => openInterviewForm(s, S.interviews.find((x) => x.id === b.dataset.iv)));
}

// ---- 대학별 면접일 추가·수정·삭제 (교사만)
function openInterviewForm(st, iv) {
  const body = openModal(iv ? `${st.name} · 면접일 수정` : `${st.name} · 대학 추가`, `<form id="ivF">
    <div class="grid grid-2" style="gap:0 14px">
      <div class="field"><label>대학 *</label><input name="univ" value="${esc(iv?.univ || "")}" required></div>
      <div class="field"><label>학과</label><input name="dept" value="${esc(iv?.dept || "")}"></div>
      <div class="field"><label>전형</label><input name="admission" value="${esc(iv?.admission || "")}"></div>
      <div class="field"><label>면접 유형</label><select name="format">${opt(["학생부 기반", "기본 인성", "제시문", "MMI", "학생부 기반+제시문", "복합형", "기타"], iv?.format || "학생부 기반")}</select></div>
      <div class="field"><label>면접일 *</label><input type="date" name="date" value="${esc(iv?.date || "")}" required></div>
    </div>
    ${iv?.updatedBy ? `<p class="muted">마지막 수정: ${esc(iv.updatedBy)}${iv.updatedAt ? " · " + esc(new Date(iv.updatedAt).toLocaleString("ko-KR")) : ""}</p>` : ""}
    <div class="row"><button class="btn-primary" id="ivSave">저장</button>
      <span class="muted">저장하면 구글 시트에도 바로 반영됩니다.</span>
      ${iv ? '<div class="spacer"></div><button type="button" class="btn-sm btn-danger" id="ivDel">이 대학 삭제</button>' : ""}</div>
  </form>`);
  const back = () => openStudent(st.studentNo);
  $("#ivF", body).onsubmit = async (e) => {
    e.preventDefault();
    const f = readForm($("#ivF", body));
    const data = {
      studentNo: st.studentNo, name: st.name, univ: f.univ, dept: f.dept, admission: f.admission, format: f.format, date: f.date,
      updatedAt: Date.now(), updatedBy: myName() || S.ctx.user.email
    };
    $("#ivSave", body).disabled = true;
    try {
      if (iv) { await updateDoc(doc(db, "interviews", iv.id), data); Object.assign(iv, data); }
      else {
        const ref = await addDoc(collection(db, "interviews"), data);
        S.interviews.push({ id: ref.id, ...data });
      }
      st.firstInterview = firstOf(st.studentNo);
      await updateDoc(doc(db, "students", st.studentNo), { firstInterview: st.firstInterview });
      attachInterviews(); rerender(); back();
      toast("면접일을 저장했습니다.");
      requestSync(["interviews"]);
    } catch (err) { showError(err, "면접일 저장"); $("#ivSave", body).disabled = false; }
  };
  $("#ivDel", body)?.addEventListener("click", async () => {
    if (!confirm(`${iv.univ} 면접일을 삭제할까요? 시트에서도 지워집니다.`)) return;
    try {
      await deleteDoc(doc(db, "interviews", iv.id));
      S.interviews = S.interviews.filter((x) => x.id !== iv.id);
      st.firstInterview = firstOf(st.studentNo);
      await updateDoc(doc(db, "students", st.studentNo), { firstInterview: st.firstInterview });
      attachInterviews(); rerender(); back();
      requestSync(["interviews"]);
    } catch (err) { showError(err, "면접일 삭제"); }
  });
}
const firstOf = (no) => S.interviews.filter((x) => x.studentNo === no && x.date).map((x) => x.date).sort()[0] || "";
