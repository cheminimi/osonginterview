import {
  db, collection, doc, getDoc, setDoc, addDoc, updateDoc, deleteDoc, $, $$, esc, toast, showError, fmtDate, fmtDay, ddayBadge,
  TRACKS, SPECIALS, STAGES, nextInterview, serverTimestamp, icon, dday, initials
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
    <div class="st-top"><div class="spacer"></div>
      <button class="btn-sm" data-tab="reviews" id="goRvList">${icon("pen", 15)} 대학 면접 후기</button>
      <button class="btn-sm" data-tab="meetings" id="goMeetList">${icon("note", 15)} 대면 기록 전체</button></div>
    <div class="st-grid"><section class="card st-list">
    <div class="search-box"><span>${icon("search", 18)}</span>
      <input id="fSearch" type="search" placeholder="이름 또는 학번" aria-label="이름 또는 학번"></div>
    <div class="chips" id="fChips">
      <button type="button" data-f="mine" class="on">내 담당</button>
      <button type="button" data-f="all">전체</button>
      <button type="button" data-f="soon">면접 임박</button>
      <button type="button" data-f="norec">기록 없음</button>
    </div>
    <details class="more-filter"><summary class="muted">반 · 트랙으로 더 좁히기</summary>
      <div class="toolbar" style="margin-top:8px">
        <select id="fCls"><option value="">전체 반</option></select>
        <select id="fTrack">${opt(TRACKS, "", "전체 트랙")}</select>
        <select id="fSpecial"><option value="">특별 트랙 전체</option><option value="has">제시문/MMI 있음</option></select>
        <select id="fSort"><option value="dday">다음 면접 순</option><option value="no">학번 순</option></select>
      </div>
    </details>
    <div class="st-lh"><b>학생</b><span class="n" id="fCount"></span></div>
    <div id="stBody"></div>
    <div class="st-legend"><span><i class="pill ok">1차</i>기록 있음</span><span><i class="pill warn">1차</i>일정만</span><span><i class="pill">1차</i>아직</span></div>
    <label hidden><input type="checkbox" id="fMine"></label>
    </section>
    <section class="card st-det" id="stDetail"><div class="empty">학생을 고르면 여기에 자세히 보여요.</div></section></div>`;
  ["#fCls", "#fTrack", "#fSpecial", "#fSort"].forEach((s) => $(s, root).onchange = render);
  $("#fSearch", root).oninput = render;
  $("#goMeetList", root).onclick = () => switchTab("meetings");
  $("#goRvList", root).onclick = async () => { switchTab("reviews"); (await import("./t-reviews.js")).load(); };
  $$("#fChips button", root).forEach((b) => b.onclick = () => {
    $$("#fChips button", root).forEach((x) => x.classList.toggle("on", x === b));
    $("#fMine", root).checked = b.dataset.f === "mine";   // 옛 동작(내 담당만)과 맞춤
    render();
  });
  register("students", render);
}

function render() {
  const cls = [...new Set(S.students.map((s) => s.cls).filter(Boolean))].sort((a, b) => a.localeCompare(b, "ko", { numeric: true }));
  const cur = $("#fCls", root).value;
  $("#fCls", root).innerHTML = opt(cls, cur, "전체 반");
  const chip = $("#fChips button.on", root)?.dataset.f || "mine";
  const f = {
    cls: $("#fCls", root).value, track: $("#fTrack", root).value, sp: $("#fSpecial", root).value,
    kw: $("#fSearch", root).value.trim(), sort: $("#fSort", root).value
  };
  const me = myName();
  const noRec = (s) => !S.meetings.some((m) => m.studentNo === s.studentNo && !m.planned);
  let list = S.students.filter((s) =>
    (!f.cls || s.cls === f.cls) && (!f.track || s.track === f.track)
    && (!f.sp || (s.special && s.special !== "없음"))
    && (chip !== "mine" || !me || myRoles(s, me).length)
    && (chip !== "soon" || (nextInterview(s) && dday(nextInterview(s)) <= 14))
    && (chip !== "norec" || noRec(s))
    && (!f.kw || `${s.name}${s.studentNo}`.includes(f.kw)));
  if (f.sort !== "no") list = [...list].sort((a, b) => (nextInterview(a) || 9e15) - (nextInterview(b) || 9e15));
  $("#fCount", root).textContent = `${list.length}명${f.sort !== "no" ? " · 다음 면접 순" : " · 학번 순"}`;
  if (!list.length) {
    $("#stBody", root).innerHTML = `<div class="empty">${S.students.length ? "조건에 맞는 학생이 없습니다." : "등록된 학생이 없습니다. 오른쪽 위 메뉴 → 앱 관리에서 운영 원본을 가져오세요."}</div>`;
    return;
  }
  $("#stBody", root).innerHTML = list.map((s) => {
    const d = nextInterview(s);
    const n = d != null ? dday(d) : null;
    const roles = myRoles(s, me);
    return `<button type="button" class="list-row st-row ${s.studentNo === selNo && panelMode() ? "on" : ""}" data-no="${esc(s.studentNo)}">
      <span class="r-tx">
        <b>${esc(s.name)}</b> <span class="muted" style="display:inline">${esc(s.studentNo)}</span>
        ${n != null ? `<span class="dd2 ${n <= 7 ? "hot" : n <= 21 ? "mid" : ""}">${n === 0 ? "D-DAY" : "D-" + n}</span>` : ""}
        <span class="muted">${esc(s.track || "트랙 미정")}${s.special && s.special !== "없음" ? " · " + esc(s.special) : ""}${roles.length ? " · 내 역할 " + roles.join("·") : ""}</span>
      </span>
      <span class="r-stage">${stagePills(s)}</span>
    </button>`;
  }).join("");
  $$("#stBody [data-no]", root).forEach((el) => el.onclick = () => openStudent(el.dataset.no));
  // 넓은 화면: 오른쪽 칸이 비어 있으면 고른 학생(없으면 맨 위 학생)을 연다
  // 창(모달)이 열려 있으면 건드리지 않는다 — 쓰던 기록 창이 닫히지 않게
  if (panelMode() && $("#modal").hidden) {
    const pane = $("#stDetail", root);
    // 커서가 입력칸에 있으면 글자 치는 중이라 다시 그리지 않는다 (입력값은 어차피 drafts 에 보존된다)
    const typing = pane.contains(document.activeElement) && /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName);
    if (!pane.dataset.shown) {
      const pick = list.find((x) => x.studentNo === selNo) || list[0];
      if (pick) openStudent(pick.studentNo);
    } else if (!typing) {
      // 기록 저장 등으로 내용이 바뀌었으면 오른쪽 칸도 새로 그린다. 저장 안 한 메모·학생 정보 입력은 drafts 에서 되살린다
      const y = pane.scrollTop;
      openStudent(pane.dataset.shown).then(() => { pane.scrollTop = y; });
    }
  }
}
// 넓은 화면의 학생 탭에서는 창 대신 오른쪽 칸에 자세히 보여 준다
let selNo = null;
let modalNo = null;   // 지금 창(모달)으로 보고 있는 학생
// 저장하지 않은 입력 (학번별) — 다시 그리기·탭 이동·화면 폭 전환에도 사라지지 않게
//   note: 교사 메모 글자, form: 학생 정보 수정 칸 { 이름: 값 }
const drafts = {};
const draftOf = (no) => (drafts[no] ||= {});
function dropDraft(no, key) { if (!drafts[no]) return; delete drafts[no][key]; if (!Object.keys(drafts[no]).length) delete drafts[no]; }
// 입력 버전 (학번·칸별): 글자를 고칠 때마다 1씩 올린다. 저장이 끝났을 때 요청 당시 버전과 같을 때만 '저장 완료'로 처리한다
//   → 저장 응답을 기다리는 동안 더 쓴 내용이 이전 저장의 완료 처리로 지워지지 않는다
const inputVer = {};
const verOf = (no, key) => inputVer[no]?.[key] || 0;
const bumpVer = (no, key) => { (inputVer[no] ||= {})[key] = verOf(no, key) + 1; };
// 진행 중인 저장 (학번·칸별): { ver, p } — 같은 내용 중복 저장을 막고, 다음 저장은 앞 저장이 끝난 뒤 보낸다 (응답 순서 역전 방지)
const inflight = {};
function queueSave(no, key, ver, fn) {
  const k = no + "|" + key, cur = inflight[k];
  if (cur && cur.ver === ver) return null;              // 같은 버전을 이미 저장 중 → 중복 클릭 무시
  const p = (cur ? cur.p.catch(() => {}) : Promise.resolve()).then(fn);
  const me = { ver, p };
  inflight[k] = me;
  p.finally(() => { if (inflight[k] === me) delete inflight[k]; }).catch(() => {});
  return p;
}
const savingVer = (no, key) => inflight[no + "|" + key]?.ver;
// 지금 이 학생 상세가 화면(오른쪽 칸 또는 학생 창)에 떠 있는지
function showing(no) {
  const pane = root && $("#stDetail", root);
  if (panelMode() && pane?.dataset.shown === no) return true;
  return !$("#modal").hidden && modalNo === no && $("#mBody").classList.contains("st-detail-body");
}
// 다른 작성 창(면접 기록·면접일·연습 리뷰 등)이 떠 있는지
const otherModalOpen = () => !$("#modal").hidden && !$("#mBody").classList.contains("st-detail-body");
// 다른 창이 떠 있어서 미뤄 둔 학생 상세 (창이 닫히면 되살린다)
let pendingDetail = null;
// 저장·불러오기가 끝난 뒤 학생 상세를 새로 그릴 때: 다른 작성 창이 떠 있으면 그 창을 닫지 않고 창이 닫힌 뒤로 미룬다
//   (오른쪽 칸 openStudent 는 closeModal 을 부르므로, 뒤쪽 칸에 학생이 떠 있어도 바로 그리면 안 된다)
function refreshDetail(no) {
  if (otherModalOpen()) {
    const pane = root && $("#stDetail", root);
    if (panelMode() && pane?.dataset.shown === no) pendingDetail = no;
    return;
  }
  if (showing(no)) openStudent(no);
}
// 1000px 경계를 넘으면: 넓어질 때는 창으로 보던 학생을 오른쪽 칸으로, 좁아질 때는 쓰던 입력이 있으면 창으로 옮긴다
{
  const wideMq = window.matchMedia("(min-width: 1000px)");
  const onCross = () => {
    if (!root || S.curTab !== "students") return;
    const pane = $("#stDetail", root);
    const modalOpen = !$("#modal").hidden && modalNo && $("#mBody").classList.contains("st-detail-body");
    if (wideMq.matches) {
      if (modalOpen) { const no = modalNo; closeModal(); modalNo = null; openStudent(no); }
      else render();
    } else if (pane?.dataset.shown) {
      const no = pane.dataset.shown;
      pane.innerHTML = '<div class="empty">학생을 고르면 여기에 자세히 보여요.</div>'; delete pane.dataset.shown;
      if (drafts[no]) {
        // 쓰던 것이 있으면 창으로 이어서. 단 다른 작성 창이 떠 있으면 그 창을 덮지 않고, 그 창이 닫힌 뒤에 연다
        if (otherModalOpen()) pendingDetail = no;
        else openStudent(no);
      }
      render();
    }
  };
  wideMq.addEventListener ? wideMq.addEventListener("change", onCross) : wideMq.addListener(onCross);
  // 창이 닫히면: 미뤄 둔 학생 상세를 되살리고, 넓은 화면에서 오른쪽 칸이 비었으면 채운다
  const watchModal = () => {
    const m = document.getElementById("modal");
    if (!m) return;
    new MutationObserver((recs) => {
      if (!recs.some((r) => r.oldValue === null) || !m.hidden) return;   // 보이던 창이 막 닫혔을 때만
      if (!root || S.curTab !== "students") { pendingDetail = null; return; }
      const no = pendingDetail; pendingDetail = null;
      if (panelMode()) {
        const pane = $("#stDetail", root);
        if (no) selNo = no;
        if (no && pane.dataset.shown === no) openStudent(no);   // 미뤄 둔 새로 그리기 (저장 안 한 입력은 drafts 에서 되살림)
        else if (!pane.dataset.shown) render();
      }
      else if (no && drafts[no]) openStudent(no);
    }).observe(m, { attributes: true, attributeFilter: ["hidden"], attributeOldValue: true });
  };
  document.readyState === "loading" ? document.addEventListener("DOMContentLoaded", watchModal) : watchModal();
}
const panelMode = () => window.matchMedia("(min-width: 1000px)").matches && S.curTab === "students" && !!root?.querySelector("#stDetail");

// 1·2·3차 진행 알약: 기록 있음=초록, 일정만 잡힘=주황, 아직=회색
function stagePills(s) {
  const done = new Set(S.meetings.filter((m) => m.studentNo === s.studentNo && !m.planned).map((m) => Number(m.stage)));
  const planned = new Set(S.meetings.filter((m) => m.studentNo === s.studentNo && m.planned).map((m) => Number(m.stage)));
  return [1, 2, 3].map((k) => {
    const cls = done.has(k) ? "ok" : planned.has(k) ? "warn" : "";
    return `<span class="pill ${cls}">${k}차</span>`;
  }).join("");
}

export async function openStudent(no) {
  const s = S.students.find((x) => x.studentNo === no);
  if (!s) return;
  const a = s.assign || {};
  const meets = S.meetings.filter((m) => m.studentNo === no).sort((x, y) => (x.date || "").localeCompare(y.date || ""));
  const sess = S.sessions.filter((x) => x.studentNo === no);
  const d = nextInterview(s);
  const bk = (S.bookings || []).filter((b) => b.studentNo === no && (b.status === "requested" || b.status === "confirmed"))
    .sort((x, y) => (x.date + x.start).localeCompare(y.date + y.start));
  const inPanel = panelMode();
  const dh = `<div class="dh"><span class="avatar">${esc(initials(s.name))}</span>
      <div class="t3"><span class="dn"><b>${esc(s.name)}</b><span class="no">${esc(s.studentNo)}${s.cls ? " · " + esc(s.cls) : ""}</span></span>
        <small>${d ? ddayBadge(d) + ` 다음 면접 ${fmtDay(d)}` : "등록된 면접일 없음"}</small></div></div>`;
  const html = `${dh}
    <div class="row" style="margin-bottom:12px">
      <span class="badge">${esc(s.track || "트랙 미정")}</span>
      ${s.special && s.special !== "없음" ? `<span class="badge">${esc(s.special)}</span>` : ""}
      ${s.priority ? `<span class="badge ${s.priority === "긴급" ? "badge-red" : "badge-gray"}">${esc(s.priority)}</span>` : ""}
      <div class="spacer"></div>
      ${s.sheetUrl ? `<a class="btn btn-sm" href="${esc(s.sheetUrl)}" target="_blank" rel="noopener">준비 시트 열기</a>` : '<span class="muted">준비 시트 링크 없음</span>'}
      <button class="btn-sm" id="addMeet">대면 기록 추가</button>
    </div>
    <div class="row" style="margin-bottom:14px">${stagePills(s)}
      <span class="muted">연두 = 기록 있음 · 주황 = 일정만 잡힘</span></div>

    ${bk.length ? `<div class="section-title"><h3>잡힌 일정</h3><span class="muted">내가 들어가는 일정만</span></div>
    <div class="list-card" style="margin-bottom:14px">${bk.map((b) => `<div class="list-row" style="cursor:default">
      <span class="r-day"><b>${esc(fmtDay(b.date).replace(/\(.\)$/, ""))}</b><span>${esc(S.blockLabel(b.block) || "")}</span></span>
      <span class="r-tx"><b>${b.stage}차</b> ${esc((b.teachers || []).join("·"))}
        <span class="muted">${esc(b.room || "장소 미정")} · ${esc(b.start)}–${esc(b.end)}</span></span>
      <span class="badge badge-${b.status === "confirmed" ? "green" : "orange"}" style="flex:none">${b.status === "confirmed" ? "확정" : "요청 중"}</span>
    </div>`).join("")}</div>` : ""}

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
    <textarea id="noteText" placeholder="메모를 불러오는 중…" readonly></textarea>
    <div class="row" style="margin-top:6px"><button class="btn-sm" id="saveNote" disabled>메모 저장</button><span class="muted" id="noteState">불러오는 중…</span>
      <button type="button" class="btn-sm" id="noteRetry" hidden>다시 불러오기</button></div>

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
    </details>

    <div class="modal-foot"><button class="btn-primary" id="writeMeet">${icon("pen", 16)} 면접 기록 쓰기</button></div>`;
  let body;
  if (inPanel) {
    selNo = no; modalNo = null;
    body = $("#stDetail", root);
    body.dataset.shown = no;
    body.innerHTML = html;
    body.scrollTop = 0;
    closeModal();   // 목록·면접일 창에서 '돌아가기'로 온 경우 그 창을 닫는다
    $$("#stBody [data-no]", root).forEach((el) => el.classList.toggle("on", el.dataset.no === no));
  } else {
    // 창으로 열 때는 오른쪽 칸을 비워 둔다 (같은 id 가 두 곳에 생기지 않게)
    const pane = $("#stDetail", root);
    if (pane && pane.dataset.shown) { pane.innerHTML = '<div class="empty">학생을 고르면 여기에 자세히 보여요.</div>'; delete pane.dataset.shown; }
    body = openModal(`${s.studentNo} ${s.name}`, html, true);
    selNo = no; modalNo = no;
  }
  body.classList?.add("st-detail-body");
  if (body.id === "mBody") {
    // 창을 다른 내용(면접일·기록 창)으로 바꾸면 이 표시는 없어져야 한다
    const mo = new MutationObserver(() => { if (!body.querySelector(".dh")) { body.classList.remove("st-detail-body"); mo.disconnect(); } });
    mo.observe(body, { childList: true });
  }

  $("#addMeet", body).onclick = () => openMeetingForm({ studentNo: no });
  $("#writeMeet", body).onclick = () => openMeetingForm({ studentNo: no });
  $("#sessAll", body)?.addEventListener("click", async (e) => { e.preventDefault(); try { await loadAllSessions(); refreshDetail(no); } catch (err) { showError(err, "연습 기록 불러오기"); } });
  $("#toQ", body).onclick = () => { closeModal(); switchTab("questions"); selectStudentForQuestions(no); };
  $$("[data-sid]", body).forEach((el) => el.onclick = () => openReview(el.dataset.sid));
  $$("[data-mid]", body).forEach((el) => el.onclick = () => openMeetingForm({ id: el.dataset.mid }));

  // 교사 메모: 불러오기가 끝나기 전·실패했을 때는 저장을 막는다 (빈 글자로 기존 메모를 덮어쓰지 않게)
  const noteEl = $("#noteText", body), saveBtn = $("#saveNote", body), noteSt = $("#noteState", body), retry = $("#noteRetry", body);
  let noteLoaded = false;
  // 저장 버튼: 지금 버전을 이미 저장 중이면 잠가 둔다 (그 뒤 더 쓰면 다시 누를 수 있다)
  const noteBtnState = () => { if (noteLoaded) saveBtn.disabled = savingVer(no, "note") === verOf(no, "note"); };
  noteEl.addEventListener("input", () => {
    draftOf(no).note = noteEl.value; bumpVer(no, "note");
    noteSt.textContent = "저장 안 됨"; noteBtnState();
  });
  saveBtn.onclick = () => {
    if (!noteLoaded) return toast("메모를 아직 불러오지 못했어요. 다시 불러온 뒤 저장해 주세요.", "error");
    const v = verOf(no, "note"), text = noteEl.value;
    const p = queueSave(no, "note", v, () => setDoc(doc(db, "studentNotes", no), { text, updatedBy: myName() || S.ctx.user.email, updatedAt: serverTimestamp() }, { merge: true }));
    if (!p) return;
    noteSt.textContent = "저장 중…"; noteBtnState();
    // 완료 처리는 그때 화면에 떠 있는 메모 칸에 한다 (그 사이 다시 그려졌을 수 있다)
    const ui = () => { const b = showing(no) && (panelMode() ? $("#stDetail", root) : $("#mBody")); return b && $("#noteState", b) ? { st: $("#noteState", b), btn: $("#saveNote", b), ta: $("#noteText", b) } : null; };
    p.then(() => {
      if (verOf(no, "note") === v) { dropDraft(no, "note"); const u = ui(); if (u) u.st.textContent = "저장됨"; }
      else { const u = ui(); if (u && savingVer(no, "note") == null) u.st.textContent = "저장 안 됨 (저장 후 고친 내용)"; }
    }, (e) => { showError(e, "메모 저장"); const u = ui(); if (u && savingVer(no, "note") == null) u.st.textContent = "저장 안 됨"; })
      .finally(() => { const u = ui(); if (u && !u.ta.readOnly) u.btn.disabled = savingVer(no, "note") === verOf(no, "note"); });
  };
  async function loadNote() {
    noteLoaded = false; saveBtn.disabled = true; noteEl.readOnly = true; retry.hidden = true;
    noteEl.placeholder = "메모를 불러오는 중…"; noteSt.textContent = "불러오는 중…";
    try {
      const n = await getDoc(doc(db, "studentNotes", no));
      if (!noteEl.isConnected) return;   // 그 사이 다른 학생으로 바뀜
      const saved = n.exists() ? (n.data().text || "") : "";
      const d = drafts[no]?.note;
      noteEl.value = d !== undefined ? d : saved;
      noteLoaded = true; noteEl.readOnly = false; noteBtnState();
      noteEl.placeholder = "지도 중 공유할 메모";
      noteSt.textContent = savingVer(no, "note") != null ? "저장 중…" : d !== undefined && d !== saved ? "저장 안 됨" : "";
    } catch (e) {
      if (!noteEl.isConnected) return;
      noteSt.textContent = "메모를 불러오지 못했어요.";
      noteEl.placeholder = "메모를 불러오지 못했어요. '다시 불러오기'를 눌러 주세요.";
      retry.hidden = false;
      console.warn("메모 불러오기", e);
    }
  }
  retry.onclick = () => loadNote();

  const editF = $("#editF", body);
  const fd = drafts[no]?.form;
  if (fd) {   // 저장 안 한 학생 정보 입력 되살리기
    Object.entries(fd).forEach(([k, v]) => { const el = editF.elements[k]; if (el) el.value = v; });
    editF.closest("details").open = true;
  }
  const keepForm = () => { draftOf(no).form = Object.fromEntries([...editF.elements].filter((el) => el.name).map((el) => [el.name, el.value])); bumpVer(no, "form"); };
  editF.addEventListener("input", keepForm);
  editF.addEventListener("change", keepForm);
  editF.onsubmit = async (e) => {
    e.preventDefault();
    const f = readForm($("#editF", body));
    const upd = {
      name: f.name, priority: f.priority, track: f.track, special: f.special, sheetUrl: f.sheetUrl,
      assign: { s1: f.s1, s2: f.s2, s3a: f.s3a, s3b: f.s3b }, syncFieldsAt: Date.now(), syncedBy: myName() || S.ctx.user.email
    };
    const v = verOf(no, "form");
    const p = queueSave(no, "form", v, () => updateDoc(doc(db, "students", no), upd));
    if (!p) return;   // 같은 내용을 이미 저장 중
    try {
      await p;
      Object.assign(s, upd);
      requestSync(["students"]);
      if (verOf(no, "form") === v) {
        // 저장 뒤 더 고친 게 없을 때만 입력을 지우고 폼을 새로 그린다 (다른 창이 떠 있거나 다른 학생을 보고 있으면 그 화면은 건드리지 않는다)
        dropDraft(no, "form");
        toast("저장했습니다."); rerender();
        refreshDetail(no);
      } else {
        toast("저장했습니다. 저장 뒤에 고친 내용은 아직 저장 안 됐어요.");
        rerender();
      }
    } catch (err) { showError(err, "학생 정보 저장"); }
  };

  $("#addIv", body).onclick = () => openInterviewForm(s, null);
  $$("[data-iv]", body).forEach((b) => b.onclick = () => openInterviewForm(s, S.interviews.find((x) => x.id === b.dataset.iv)));

  await loadNote();
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
