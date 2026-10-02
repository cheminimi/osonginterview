// 학생이 넣은 예상질문 — 질문 탭 '학생이 넣은 질문' 모아 보기 + 학생별 관리와 같이 쓰는 검토 동작
// 학생 질문 = personalQuestions 의 by:"student". 잠금 기준은 reviewedAt 하나 (있으면 학생은 고치기·지우기 불가).
// 질문을 바꿀 때는 students/{학번} 의 개수(pqCount·pqMine·pqPending)도 같은 writeBatch 로 함께 쓴다.
import {
  db, collection, doc, getDocs, updateDoc, writeBatch, serverTimestamp, $, $$, esc, toast, showError, icon, confirmBox,
  pqStats, isStudentPq
} from "./common.js";
import { S, register, rerender, myName, myRoles, studentByNo, updatePqDots, lines } from "./t-core.js";

let root, view = "wait", loading = false;
const lists = {};   // 학번 → 불러온 예상질문 (모아 보기·학생별 관리가 같이 씀)
const editing = new Set();   // 다듬는 중인 질문 id

export function init(el) {
  root = el;
  root.innerHTML = `
    <div class="pq-top">
      <p class="pq-desc">학생이 넣은 질문은 바로 학생 연습에 나와요. <b>검토함</b>을 누르면 면접 부스에도 나오고, 그때부터 학생은 그 질문을 고치거나 지울 수 없어요. 다듬은 문장은 학생 화면에도 그대로 바뀌어요.</p>
      <label class="pq-view">보기 <select id="pqView">
        <option value="wait">검토 대기만</option><option value="all">검토한 것 포함 전체</option><option value="mine">내 담당 학생만</option>
      </select></label>
    </div>
    <div id="pqGroups"><div class="empty">불러오는 중…</div></div>`;
  $("#pqView", root).onchange = (e) => { view = e.target.value; load(); };
  S.onShow.pqreview = () => { view = "wait"; $("#pqView", root).value = "wait"; load(); };
  register("pqreview", () => { if (!root.hidden && !loading) load(); });
}

// ---- 보기에 맞는 학생 (개수 칸으로 고른다 — 0 인 학생은 읽지 않음)
function targets() {
  const me = myName();
  if (view === "wait") return S.students.filter((s) => (Number(s.pqPending) || 0) > 0);
  if (view === "mine") return S.students.filter((s) => (!me || myRoles(s, me).length) && (Number(s.pqMine) || 0) > 0);
  return S.students.filter((s) => (Number(s.pqMine) || 0) > 0);
}

async function load() {
  const box = $("#pqGroups", root);
  if (!S.students.length) { box.innerHTML = `<div class="empty">불러오는 중…</div>`; return; }
  loading = true;
  const sts = targets();
  try {
    await Promise.all(sts.map((st) => loadList(st.studentNo)));
  } catch (e) { showError(e, "학생 질문 불러오기"); }
  loading = false;
  render();
}

/** 한 학생의 예상질문을 읽고, students 문서의 개수가 실제와 다르면 바로잡는다 */
export async function loadList(no) {
  const snap = await getDocs(collection(db, "students", no, "personalQuestions"));
  lists[no] = snap.docs.map((d) => ({ id: d.id, ...d.data() })).sort((a, b) => (a.createdAt?.seconds || 0) - (b.createdAt?.seconds || 0));
  await fixStats(no);
  return lists[no];
}
export const listOf = (no) => lists[no] || [];

async function fixStats(no) {
  const st = studentByNo(no); if (!st) return;
  const want = pqStats(lists[no]);
  if (Object.keys(want).every((k) => (Number(st[k]) || 0) === want[k])) return;
  try {
    await updateDoc(doc(db, "students", no), want);
    Object.assign(st, want);
    updatePqDots(); rerender("home");
  } catch (e) { console.warn("예상질문 개수 맞추기", e); }
}

function render() {
  const box = $("#pqGroups", root);
  const sts = targets().filter((st) => groupItems(st.studentNo).length);
  if (!sts.length) {
    box.innerHTML = `<div class="card empty">${view === "wait" ? "검토할 학생 질문이 없어요." : "학생이 넣은 질문이 아직 없어요."}</div>`;
    return;
  }
  box.innerHTML = sts.map((st) => {
    const items = groupItems(st.studentNo);
    const wait = listOf(st.studentNo).filter((q) => isStudentPq(q) && !q.reviewedAt).length;
    const dept = st.universities?.[0]?.dept || "";
    return `<section class="card pq-group" data-no="${esc(st.studentNo)}">
      <div class="pq-gh"><b>${esc(st.name || "")}</b><span>${esc(st.studentNo)}${dept ? ` · ${esc(dept)}` : ""}${wait ? ` · 대기 ${wait}` : ""}</span>
        <div class="spacer"></div>${wait ? `<button type="button" class="btn-sm" data-pqall="${esc(st.studentNo)}">이 학생 질문 모두 검토함</button>` : ""}</div>
      ${items.map((q) => pqCardHtml(st.studentNo, q)).join("")}
    </section>`;
  }).join("");
  bindPqActions(box, () => render());
  $$("[data-pqall]", box).forEach((b) => b.onclick = () => reviewAll(b.dataset.pqall, () => render()));
}
function groupItems(no) {
  return listOf(no).filter((q) => isStudentPq(q) && (view !== "wait" || !q.reviewedAt));
}

// ---- 카드 (모아 보기·학생별 관리 공용). num 이 있으면 앞에 번호
const hm = (d) => `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
function whenText(t) {
  if (!t?.seconds) return "";
  const d = new Date(t.seconds * 1000), today = new Date(); today.setHours(0, 0, 0, 0);
  const diff = Math.round((new Date(d).setHours(0, 0, 0, 0) - today.getTime()) / 86400000);
  return diff === 0 ? `오늘 ${hm(d)}` : diff === -1 ? `어제 ${hm(d)}` : `${d.getMonth() + 1}/${d.getDate()} ${hm(d)}`;
}
const md = (t) => { if (!t?.seconds) return ""; const d = new Date(t.seconds * 1000); return `${d.getMonth() + 1}/${d.getDate()}`; };

export function pqCardHtml(no, q, { num = 0, showStatus = false } = {}) {
  const key = `${no}/${q.id}`;
  const n = num ? `${num}. ` : "";
  if (!isStudentPq(q)) {
    // 선생님이 넣은 질문: 읽기·삭제만 (기존과 같음)
    return `<div class="q-item pq-tcard" data-key="${esc(key)}">
      <div class="pq-tline"><span class="pq-tag teacher">선생님</span><span class="muted">${esc([q.category, q.addedBy].filter(Boolean).join(" · "))}</span></div>
      <div class="pq-row"><div class="pq-main">
        <div class="q-text">${n}${esc(q.text)}</div>
        ${q.basis ? `<div class="q-meta"><span class="pq-bl">근거</span> · ${esc(q.basis)}</div>` : ""}
        ${q.followUps?.length ? `<ul class="follow">${q.followUps.map((f) => `<li>${esc(f)}</li>`).join("")}</ul>` : ""}
      </div><div class="pq-btns2"><button type="button" class="btn-sm pq-del" data-pqdel="${esc(key)}">삭제</button></div></div>
    </div>`;
  }
  const wait = !q.reviewedAt;
  if (editing.has(key)) {
    return `<div class="q-item pq-tcard pq-editing" data-key="${esc(key)}">
      <div class="pq-tline"><span class="pq-tag mine">학생 작성</span><span class="muted">${esc(whenText(q.createdAt))} · </span><b>다듬는 중</b></div>
      <div class="pq-edit">
        <div><label>질문</label><textarea data-f="text">${esc(q.text)}</textarea>
          <div class="pq-orig">학생 원문: ${esc(q.origText || q.text)}</div></div>
        <div><label>생기부 근거</label><input data-f="basis" value="${esc(q.basis || "")}">
          <label>꼬리질문 <span class="muted">(선택, 한 줄에 하나)</span></label><textarea data-f="followUps" class="sm">${esc((q.followUps || []).join("\n"))}</textarea></div>
      </div>
      <div class="pq-btns2 end"><button type="button" class="btn-sm" data-pqcancel="${esc(key)}">취소</button><button type="button" class="btn-sm btn-primary" data-pqsave="${esc(key)}">저장 (검토함으로 처리)</button></div>
      <div class="pq-note">다듬어 저장하면 자동으로 '검토함'이 되고, 학생은 이 질문을 더 고치거나 지울 수 없어요.</div>
    </div>`;
  }
  const status = showStatus
    ? (wait ? '<span class="pq-tag wait2">검토 대기</span>' : `<span class="pq-tag ok">${q.editedByTeacher ? "다듬음" : "검토함"}</span><span class="muted">${esc([q.reviewedBy, md(q.reviewedAt)].filter(Boolean).join(" · "))}</span>`)
    : `<span class="muted">${esc(whenText(q.createdAt))}</span>${!wait ? `<span class="pq-tag ok">${q.editedByTeacher ? "다듬음" : "검토함"}</span>` : ""}`;
  return `<div class="q-item pq-tcard ${wait && showStatus ? "wait" : ""}" data-key="${esc(key)}">
    <div class="pq-tline"><span class="pq-tag mine">학생 작성</span>${status}</div>
    <div class="pq-row"><div class="pq-main">
      <div class="q-text">${n}${esc(q.text)}</div>
      ${q.basis ? `<div class="q-meta"><span class="pq-bl">생기부 근거</span> · ${esc(q.basis)}</div>` : ""}
      ${q.followUps?.length ? `<ul class="follow">${q.followUps.map((f) => `<li>꼬리질문 · ${esc(f)}</li>`).join("")}</ul>` : ""}
    </div><div class="pq-btns2">
      ${wait ? `<button type="button" class="btn-sm btn-primary" data-pqok="${esc(key)}">검토함</button>` : ""}
      <button type="button" class="btn-sm" data-pqedit="${esc(key)}">다듬기</button>
      <button type="button" class="btn-sm pq-del" data-pqdel="${esc(key)}">지우기</button>
    </div></div>
  </div>`;
}

const splitKey = (key) => { const i = key.indexOf("/"); return [key.slice(0, i), key.slice(i + 1)]; };
const findQ = (key) => { const [no, id] = splitKey(key); return [no, listOf(no).find((q) => q.id === id)]; };

/** 카드 단추 연결. after: 다시 그리기 */
export function bindPqActions(box, after) {
  $$("[data-pqok]", box).forEach((b) => b.onclick = () => { const [no, q] = findQ(b.dataset.pqok); if (q) review(no, [q], after, b); });
  $$("[data-pqedit]", box).forEach((b) => b.onclick = () => { editing.add(b.dataset.pqedit); after(); });
  $$("[data-pqcancel]", box).forEach((b) => b.onclick = () => { editing.delete(b.dataset.pqcancel); after(); });
  $$("[data-pqsave]", box).forEach((b) => b.onclick = () => {
    const key = b.dataset.pqsave, card = b.closest("[data-key]");
    const [no, q] = findQ(key); if (!q) return;
    const val = (f) => $(`[data-f="${f}"]`, card).value;
    refine(no, q, { text: val("text").trim(), basis: val("basis").trim(), followUps: lines(val("followUps")) }, () => { editing.delete(key); after(); }, b);
  });
  $$("[data-pqdel]", box).forEach((b) => b.onclick = () => { const [no, q] = findQ(b.dataset.pqdel); if (q) remove(no, q, after); });
}

// ---- 쓰기 (질문 + 학생 개수를 한 번에)
async function commit(no, ops, next, btn) {
  const st = studentByNo(no);
  const stats = pqStats(next);
  if (btn) btn.disabled = true;
  try {
    const b = writeBatch(db);
    ops(b);
    b.update(doc(db, "students", no), stats);
    await b.commit();
    lists[no] = next;
    if (st) Object.assign(st, stats);
    updatePqDots(); rerender("home");
    return true;
  } catch (e) { showError(e, "학생 질문 저장"); if (btn) btn.disabled = false; return false; }
}
const qRef = (no, id) => doc(db, "students", no, "personalQuestions", id);

async function review(no, qs, after, btn) {
  const by = myName() || S.ctx.user.email;
  const ids = new Set(qs.map((q) => q.id));
  const nowTs = { seconds: Date.now() / 1000 };
  const next = listOf(no).map((q) => (ids.has(q.id) ? { ...q, reviewedAt: nowTs, reviewedBy: by } : q));
  if (await commit(no, (b) => qs.forEach((q) => b.update(qRef(no, q.id), { reviewedAt: serverTimestamp(), reviewedBy: by })), next, btn)) {
    toast(qs.length > 1 ? `${qs.length}개를 검토함으로 바꿨어요.` : "검토함으로 바꿨어요. 이제 면접 부스에도 나와요.");
    after();
  }
}
export async function reviewAll(no, after) {
  const qs = listOf(no).filter((q) => isStudentPq(q) && !q.reviewedAt);
  if (qs.length) await review(no, qs, after);
}
async function refine(no, q, v, after, btn) {
  if (!v.text) return toast("질문을 비워 둘 수 없어요.", "error");
  if (!v.basis) return toast("생기부 근거를 비워 둘 수 없어요.", "error");
  const changed = v.text !== q.text || v.basis !== (q.basis || "") || JSON.stringify(v.followUps) !== JSON.stringify(q.followUps || []);
  const by = myName() || S.ctx.user.email;
  const patch = { ...v };
  if (changed) { patch.editedByTeacher = true; if (!q.origText) patch.origText = q.text; }
  if (!q.reviewedAt) { patch.reviewedBy = by; }
  const local = { ...q, ...patch, ...(!q.reviewedAt ? { reviewedAt: { seconds: Date.now() / 1000 } } : {}) };
  const next = listOf(no).map((x) => (x.id === q.id ? local : x));
  const write = { ...patch, ...(!q.reviewedAt ? { reviewedAt: serverTimestamp() } : {}) };
  if (await commit(no, (b) => b.update(qRef(no, q.id), write), next, btn)) {
    toast(changed ? "다듬어 저장했어요. 검토함으로 바뀌었어요." : "검토함으로 바꿨어요.");
    after();
  }
}
export async function remove(no, q, after) {
  const ok = await confirmBox({ title: "이 질문을 지울까요?", what: `<b>${esc(q.text)}</b>`, note: isStudentPq(q) ? "학생 화면과 연습에서도 사라져요." : "", yes: "지우기" });
  if (!ok) return;
  const next = listOf(no).filter((x) => x.id !== q.id);
  if (await commit(no, (b) => b.delete(qRef(no, q.id)), next)) { toast("지웠어요."); after(); }
}
