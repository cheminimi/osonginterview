import {
  db, collection, doc, getDoc, getDocs, writeBatch, serverTimestamp, onSnapshot,
  $, $$, esc, toast, showError, pqStats, confirmBox, univName, announceFailed
} from "./common.js";
import { S, register, rerender, readForm, lines, opt, studentByNo, myName } from "./t-core.js";
import { loadList, listOf, pqCardHtml, bindPqActions } from "./t-pqreview.js";
import { canSeeRec, canUploadRec, recordExists, openRecordViewer, openRecordUpload, loadPending, runAiq } from "./t-record.js";

// 질문 가져오기 = [생기부에서 뽑기 | AI 맞춤 질문 | 직접 입력] (2026-11-03). 예전 claude.ai 복사·붙여넣기 화면은 뺌 —
// students/{학번}.recordSummary(예전 생기부 붙여넣기 칸) 데이터는 지우지 않고 그대로 둠
let root, existing = [];
export function init(el) {
  root = el;
  root.innerHTML = `
    <div class="grid grid-2" style="align-items:start">
      <div class="card steps">
        <div class="step"><label>학생 선택</label><select id="qStudent"></select>
          <div class="row" style="margin-top:6px" id="qSheetRow"></div></div>
        <div class="step">
          <label>질문 가져오기</label>
          <div class="tabs sub" style="margin-bottom:10px">
            <button type="button" class="active" data-src="rec">생기부에서 뽑기</button>
            <button type="button" data-src="ai">AI 맞춤 질문</button>
            <button type="button" data-src="manual">직접 입력</button>
          </div>
          <div data-srcpanel="rec" id="qRecBox"><div class="empty">학생을 선택하세요.</div></div>
          <div data-srcpanel="ai" id="qAiBox" hidden><div class="empty">학생을 선택하세요.</div></div>
          <div data-srcpanel="manual" hidden>
            <form id="qManual">
              <div class="field"><label>질문 *</label><textarea name="text" required style="min-height:70px"></textarea></div>
              <div class="grid grid-2" style="gap:0 14px">
                <div class="field"><label>영역</label><input name="category" placeholder="세특-화학Ⅱ"></div>
                <div class="field"><label>근거 활동</label><input name="basis"></div></div>
              <div class="field"><label>꼬리질문 (한 줄에 하나)</label><textarea name="followUps"></textarea></div>
              <button class="btn-primary btn-sm">추가</button>
            </form>
          </div>
        </div>
      </div>
      <div>
        <div class="card"><h3>저장된 예상질문 <span class="muted" id="qCount"></span></h3>
          <p class="muted" style="margin-top:0">'내 생기부 면접' 연습에 모두 나와요. 면접 부스에는 선생님 질문과 검토한 학생 질문만 나와요.</p>
          <div id="qPendBox"></div>
          <div class="q-sect" id="qPubHead" hidden><span class="q-sect-t">공개된 질문</span></div>
          <div id="qExisting"><div class="empty">학생을 선택하세요.</div></div></div>
      </div>
    </div>`;
  $("#qStudent", root).onchange = onStudent;
  $$("[data-src]", root).forEach((b) => b.onclick = () => {
    $$("[data-src]", root).forEach((x) => x.classList.toggle("active", x === b));
    $$("[data-srcpanel]", root).forEach((p) => p.hidden = p.dataset.srcpanel !== b.dataset.src);
  });
  $("#qManual", root).onsubmit = async (e) => {
    e.preventDefault();
    const no = $("#qStudent", root).value; if (!no) return toast("학생을 먼저 선택하세요.", "error");
    const d = readForm($("#qManual", root));
    try { await savePersonal(no, [{ ...d, followUps: lines(d.followUps), source: "manual" }]); $("#qManual", root).reset(); } catch (_) {}
  };
  register("questions", renderSelect);
}

// 학생 선택: 학생이 넣은 질문 중 검토 대기가 있으면 옆에 표시
function renderSelect() {
  const cur = $("#qStudent", root).value;
  $("#qStudent", root).innerHTML = opt(S.students.map((s) => [s.studentNo,
    `${s.studentNo} ${s.name}${Number(s.pqPending) > 0 ? ` · 학생 질문 대기 ${s.pqPending}` : ""}`]), cur, "— 학생 선택 —");
}
export function selectStudentForQuestions(no) {
  renderSelect();
  $("#qStudent", root).value = no;
  onStudent();
}

async function onStudent() {
  const st = studentByNo($("#qStudent", root).value);
  $("#qSheetRow", root).innerHTML = st?.sheetUrl ? `<a class="btn btn-sm" href="${esc(st.sheetUrl)}" target="_blank" rel="noopener">${esc(st.name)} 준비 시트 열기</a>` : "";
  if (!st) { $("#qExisting", root).innerHTML = `<div class="empty">학생을 선택하세요.</div>`; $("#qCount", root).textContent = ""; $("#qRecBox", root).innerHTML = $("#qAiBox", root).innerHTML = `<div class="empty">학생을 선택하세요.</div>`; $("#qPendBox", root).innerHTML = ""; $("#qPubHead", root).hidden = true; return; }
  await loadExisting(st.studentNo);
  await renderRecPanel(st.studentNo);
}

// ===== [생기부에서] (2026-11-01): 학생부 화면을 '질문 준비'로 열어 드래그로 질문 뽑기 =====
// 오른쪽 '공개 전 · 면접 뒤 공개' 묶음은 선생님만 (pending 을 읽을 수 있는 배정 선생님·관리자 — 못 읽으면 숨김)
let pend = [];
async function renderRecPanel(no) {
  const st = studentByNo(no), box = $("#qRecBox", root);
  const see = canSeeRec(st);
  pend = [];
  if (see) { try { pend = await loadPending(no); } catch (_) { pend = []; } }
  if ($("#qStudent", root).value !== no) return;
  const has = see ? await recordExists(no, true) : false;
  let info = null;
  if (has) { try { const d = (await getDoc(doc(db, "records", no))).data() || {}; info = { ver: d.ver || 1, at: d.savedAt?.seconds ? d.savedAt.seconds * 1000 : 0, by: d.savedBy || "" }; } catch (_) {} }
  if ($("#qStudent", root).value !== no) return;
  const me = S.ctx.user.uid, myNm = myName();
  const minePend = pend.filter((p) => p.byUid === me);
  const minePub = existing.filter((q) => q.by !== "student" && q.source === "record" && !!myNm && q.addedBy === myNm);
  const mine = [...minePend.map((p) => ({ ...p, _w: 1 })), ...minePub];
  box.innerHTML = !see ? `<div class="qrec"><div class="row"><b>학생부</b><span class="muted">배정 선생님만 볼 수 있어요</span></div>
      <button type="button" class="btn-primary qrec-big" disabled>생기부 열고 질문 뽑기</button></div>`
    : !has ? `<div class="qrec"><div class="row"><b>학생부</b><span class="muted">아직 학생부가 없어요</span></div>
      ${canUploadRec(st) ? '<button type="button" class="btn-sm" id="qRecUp">학생부 넣기</button>' : '<div class="muted sm">1차 담임 선생님·관리자가 학생부를 넣으면 질문을 뽑을 수 있어요.</div>'}
      <button type="button" class="btn-primary qrec-big" disabled>생기부 열고 질문 뽑기</button></div>`
    : `<div class="qrec"><div class="row"><b>학생부</b><span class="badge badge-green">넣음 · ${info?.ver || 1}번째 판</span><span class="muted sm">${info?.at ? new Date(info.at).toLocaleDateString("ko-KR", { month: "numeric", day: "numeric" }) : ""} ${esc(info?.by || "")}</span></div>
      <button type="button" class="btn-primary qrec-big" id="qRecOpen">생기부 열고 질문 뽑기</button>
      <div class="muted sm">학생부 화면이 <b>'질문 준비'</b>로 열려요. 글을 드래그해 [질문 만들기] → 이 학생 질문 목록에 들어가요. 근거 문장은 자동으로 붙어요.</div>
      <div class="row qrec-sum"><span class="muted sm">내가 이 학생에게 뽑은 질문</span><span class="badge" id="qRecN">${mine.length}</span><span class="badge badge-orange">면접 뒤 공개 ${minePend.length}</span><span class="badge badge-green">공개 ${minePub.length}</span></div>
      <div class="qrec-mini" id="qRecMini">${mine.slice(0, 6).map((q) => `<div class="m"><b>${esc(q.text)}</b>${q.basis ? `<span class="muted sm">${esc(q.basis)}</span>` : ""}</div>`).join("")}${mine.length > 6 ? `<div class="muted sm">… ${mine.length - 6}개 더</div>` : ""}</div></div>`;
  $("#qRecOpen", box)?.addEventListener("click", () => openRecordViewer(no, { mode: "prep", tab: "mine", onClose: () => { if ($("#qStudent", root).value === no) loadExisting(no).then(() => renderRecPanel(no)); } }));
  $("#qRecUp", box)?.addEventListener("click", () => openRecordUpload(no));
  renderAiPanel(no, { see, has });
  // 오른쪽: 공개 전 묶음 + '공개된 질문' 제목
  const pb = $("#qPendBox", root);
  pb.innerHTML = see ? `<div class="q-sect"><span class="q-sect-t w">공개 전 · 면접 뒤 공개</span><span class="muted sm">${pend.length} · 선생님만 보임</span></div>
    ${pend.length ? pend.map((p) => `<div class="q-item pq-tcard" data-pend="${esc(p.id)}"><div class="pq-tline"><span class="pq-tag teacher">${Number(p.stage) || "?"}차 · ${esc(p.by || "")}${p.byUid === me ? " (나)" : ""}</span><span class="pq-tag wait2">${Number(p.stage) || "?"}차 면접 뒤 공개</span></div>
      <div class="pq-row"><div class="pq-main"><div class="q-text">${esc(p.text)}</div>${p.basis ? `<div class="q-meta"><span class="pq-bl">근거</span> · ${esc(p.basis)}</div>` : ""}
      ${(p.followUps || []).length ? `<ul class="follow">${p.followUps.map((f) => `<li>${esc(f)}</li>`).join("")}</ul>` : ""}</div>
      ${p.byUid === me ? '<div class="pq-btns2"><button type="button" class="btn-sm pq-del" data-pdel>지우기</button></div>' : ""}</div></div>`).join("") : '<div class="muted sm" style="padding:6px 0">없어요</div>'}` : "";
  $("#qPubHead", root).hidden = !see;
  $$("[data-pdel]", pb).forEach((b) => b.onclick = async () => {
    const id = b.closest("[data-pend]").dataset.pend, p = pend.find((x) => x.id === id);
    if (!(await confirmBox({ title: "이 질문을 지울까요?", what: esc(p.text), note: "공개 전 질문만 지울 수 있어요. 하이라이트도 같이 지워져요.", yes: "지우기" }))) return;
    try {
      const bt = writeBatch(db);
      bt.delete(doc(db, "records", no, "pending", id));
      (await getDocs(collection(db, "records", no, "marks"))).docs.filter((m) => m.data().qid === id).forEach((m) => bt.delete(m.ref));
      await bt.commit();
      await renderRecPanel(no);
    } catch (e) { showError(e, "질문 지우기"); }
  });
}

// ===== [AI 맞춤 질문] (2026-11-03): 지원 대학·기출 표 + 초안 상태 → [AI 초안 검토하기] / [AI 맞춤 질문 만들기] =====
// 이미 학생부를 넣은 학생은 다시 올리지 않고 저장된 가림본으로 만듦. 실제 만들기는 booth-ai Apps Script (t-record.js runAiq)
const uShort = (u) => univName(u).replace(/대학교/g, "대");
let aiUnsub = null;
async function renderAiPanel(no, { see, has }) {
  const st = studentByNo(no), box = $("#qAiBox", root);
  aiUnsub?.(); aiUnsub = null;
  if (!see || !has) {
    box.innerHTML = `<div class="qai"><div class="qai-st"><b>${!see ? "배정 선생님만 볼 수 있어요" : "아직 학생부가 없어요"}</b><div class="muted sm">${!see ? "AI 맞춤 질문은 이 학생의 배정 선생님(1·2·3차)·관리자만 만들고 검토해요." : "학생부를 넣을 때 AI 동의를 켜면 자동으로 만들어요."}</div></div>
      ${see && canUploadRec(st) ? '<button type="button" class="btn-sm" id="qaiUp">학생부 넣기</button>' : ""}<button type="button" class="btn-primary qrec-big" disabled>AI 맞춤 질문 만들기</button></div>`;
    $("#qaiUp", box)?.addEventListener("click", () => openRecordUpload(no));
    return;
  }
  let aiq = [], meta = null;
  try { const [a, m] = await Promise.all([getDocs(collection(db, "records", no, "aiq")), getDoc(doc(db, "records", no, "aimeta", "main"))]); aiq = a.docs.map((d) => ({ id: d.id, ...d.data() })); meta = m.exists() ? m.data() : null; }
  catch (e) { console.warn("AI 초안 불러오기", e); }
  if ($("#qStudent", root).value !== no) return;
  const ivs = st.universities || [];
  const mu = (iv) => (meta?.unis || []).find((u) => u.iid === iv.id);
  const ok = new Set(ivs.filter((iv) => !announceFailed(iv)).map((iv) => "u_" + iv.id));
  const vis = aiq.filter((a) => a.status === "new" && (a.grp === "common" || ok.has(a.grp)));
  const n = (g) => vis.filter((a) => a.grp === g).length;
  const badge = (u) => {
    const s = u?.src; if (!s) return '<span class="muted sm">아직 안 찾음</span>';
    const nm = uShort(u.univ), tail = s.title.includes("→") ? s.title.split("→").slice(1).join("→").trim() : "";
    const top = s.kind === "exact" ? `<span class="src-b ok">✓ 기출 ${s.n}건${(s.title.match(/\(([^)]*학년도)\)/) || [])[1] ? ` (${s.title.match(/\(([^)]*학년도)\)/)[1].replace(/학년도$/, "")})` : ""}</span>`
      : `<span class="src-b fb">⚠ ${s.kind === "same-uni" ? "같은 학과 기출 없음" : s.kind === "none" ? "기출 없음" : nm + " 기출 없음"}</span>`;
    const sub = u.kind === "passage" ? "제시문 면접" : u.kind === "given" ? "대학 제공 질문 면접" : tail ? "→ " + tail : "";
    return `${top}${sub ? `<br><span class="muted sm">${esc(sub)}</span>` : ""}<br><span class="muted sm">판단: ${esc(u.why || s.why || "")}</span>`;
  };
  const right = (iv, u) => announceFailed(iv) ? "1차 불합격" : !u ? "—" : u.todo ? "아직 못 만듦" : u.kind === "passage" ? "제시문 안내" : u.kind === "given" ? "기출 안내" : `맞춤 ${n(u.key)}`;
  const table = ivs.length ? `<table class="qai-t"><tbody>${ivs.map((iv) => { const u = mu(iv); return `<tr class="${announceFailed(iv) ? "out" : ""}"><td><b>${esc(univName(iv.univ))}</b><br><span class="muted sm">${esc([iv.admission, iv.dept].filter(Boolean).join(" · "))}${iv.format ? ` · ${esc(iv.format)}` : ""}</span></td>
      <td>${announceFailed(iv) ? '<span class="muted sm">1차 불합격 — 초안은 숨겨요</span>' : badge(u)}</td><td class="r">${esc(right(iv, u))}</td></tr>`; }).join("")}</tbody></table>`
    : '<div class="muted sm">대학별 면접일 자료가 없어요. 공통 질문만 만들어요.</div>';
  const todo = (meta?.unis || []).filter((u) => u.todo && ok.has(u.key)).map((u) => u.key);
  const missing = ivs.filter((iv) => !announceFailed(iv) && !mu(iv)).map((iv) => "u_" + iv.id);
  const first = [...new Set([...todo, ...missing])];
  const running = meta?.status === "running" && Date.now() - (meta.runAt?.seconds ? meta.runAt.seconds * 1000 : 0) < 10 * 60 * 1000;
  const adopted = aiq.filter((a) => a.status === "adopted").length, dropped = aiq.filter((a) => a.status === "dropped").length;
  const runAt = meta?.doneAt?.seconds ? new Date(meta.doneAt.seconds * 1000).toLocaleDateString("ko-KR", { month: "numeric", day: "numeric" }) : "";
  const haveHtml = `<div id="qaiHave"><div class="qai-st"><div class="row"><span class="ai-tag">AI 초안</span><b>${vis.length}개 검토 전</b><span class="muted sm">${[`공통 ${n("common")}`, ...(meta?.unis || []).filter((u) => ok.has(u.key) && (u.kind === "record" || u.kind === "personality")).map((u) => `${uShort(u.univ)} ${u.dept} ${n(u.key)}`), `채택 ${adopted}`, `버림 ${dropped}`].join(" · ")}</span></div>
      <div class="muted sm">${runAt ? `${runAt} ` : ""}${esc(meta?.runBy || "")} 선생님이 만들었어요. 학생부 화면의 <b>AI 맞춤 초안</b>에서 근거 문장을 보며 채택·고치기·버리기 해요. 채택한 질문만 학생에게 공개되고, 암기 카드도 그때 생겨요.</div>
      ${meta?.error === "common_partial" ? '<div class="muted sm">공통 질문 일부(핵심 또는 심화·확장)를 만들지 못했어요.</div>' : ""}</div>
    <button type="button" class="btn-primary qrec-big" id="qaiOpen">AI 초안 검토하기 →</button>
    <div class="row" style="gap:8px;flex-wrap:wrap"><button type="button" class="btn-sm" id="qaiRe">대학별 다시 만들기</button><span class="muted sm">${first.length ? `아직 못 만든 대학 ${first.length}곳부터 만들어요` : "지원 대학이 바뀌었을 때"} · 채택한 질문은 그대로 · 약 200원</span></div>
    <div id="qaiRun"></div></div>`;
  const noneHtml = `<div id="qaiNone"><div class="qai-st"><b>${meta?.status === "error" ? "AI 초안을 만들지 못했어요" : "아직 AI 초안이 없어요"}</b><div class="muted sm">${meta?.status === "error" ? `다시 눌러 주세요. (이유: ${esc(meta.error || "알 수 없음")})` : "학생부를 AI 기능 전에 넣은 학생이에요. 저장된 학생부(가림본)로 바로 만들 수 있어요 — 다시 올리지 않아도 돼요."}</div></div>
    <label class="inline-check"><input type="checkbox" id="qaiOk"> <span>학생·보호자에게 <b>AI 사용 동의</b>를 받았어요 <span class="muted sm">(가림본 글과 지원 대학·학과를 AI 로 보내요)</span></span></label>
    <button type="button" class="btn-primary qrec-big" id="qaiMake" disabled>AI 맞춤 질문 만들기</button><div class="muted sm">약 1~2분 · 학생 1명 약 500원 · 만든 뒤 학생부 화면에서 검토해요</div>
    <div id="qaiRun"></div></div>`;
  box.innerHTML = `<div class="qai"><div class="qai-h"><b>지원 대학 · 전형 · 학과</b><span class="muted sm">대학별 면접일 자료에서 자동으로</span></div>${table}
    <div class="muted sm">기출: 충북교육청 면접후기 사례집 (질문만 참고, 선배 답변은 쓰지 않음) · 모델: Claude Opus 5.5</div>
    ${running ? '<div class="qai-st"><div class="row"><span class="ai-tag">AI</span><b>만드는 중이에요</b><span class="muted sm">창을 닫아도 계속돼요</span></div><ol class="qai-run" id="qaiLive"></ol></div>' : aiq.length ? haveHtml : noneHtml}</div>`;
  const done = () => { if ($("#qStudent", root).value === no) { loadExisting(no).then(() => renderRecPanel(no)); } };
  if (running) {
    const L = ["저장된 학생부 읽기 (가림본)", "지원 대학·전형·학과 확인", "기출 찾기 (면접후기 사례집)", "공통·대학별 맞춤 질문 만들기", "근거 문장 확인", "암기 카드 만들기"];
    aiUnsub = onSnapshot(doc(db, "records", no, "aimeta", "main"), (s) => {
      const m = s.exists() ? s.data() : null, el = $("#qaiLive", box);
      if (!m || m.status !== "running") { aiUnsub?.(); aiUnsub = null; if ($("#qStudent", root).value === no) renderRecPanel(no); return; }
      if (el) el.innerHTML = L.map((t, i) => `<li class="${i < m.step ? "done" : i === Number(m.step) ? "on" : ""}"><i>${i < m.step ? "✓" : ""}</i>${t}</li>`).join("");
    }, () => {});
    return;
  }
  $("#qaiOpen", box)?.addEventListener("click", () => openRecordViewer(no, { mode: "prep", tab: "ai", onClose: done }));
  $("#qaiOk", box)?.addEventListener("change", (e) => { $("#qaiMake", box).disabled = !e.target.checked; });
  $("#qaiMake", box)?.addEventListener("click", () => {
    $("#qaiMake", box).disabled = true;
    runAiq(no, { scope: "all", consent: true, box: $("#qaiRun", box), onDone: (r) => { if (r?.ok) setTimeout(done, 400); else $("#qaiMake", box) && ($("#qaiMake", box).disabled = !$("#qaiOk", box).checked); } });
  });
  $("#qaiRe", box)?.addEventListener("click", async () => {
    if (!first.length && !(await confirmBox({ title: "대학별 초안을 다시 만들까요?", what: "대학 맞춤 초안 중 검토 전('new')인 것만 새로 만들어요.", note: "공통 초안·채택한 질문·버린 초안은 그대로예요. 약 200원 들어요.", yes: "다시 만들기" }))) return;
    $("#qaiRe", box).disabled = true;
    runAiq(no, { scope: "unis", ...(first.length ? { only: first } : {}), box: $("#qaiRun", box), onDone: (r) => { if (r?.ok) setTimeout(done, 400); else if ($("#qaiRe", box)) $("#qaiRe", box).disabled = false; } });
  });
}

async function loadExisting(no) {
  try { existing = await loadList(no); }
  catch (e) { showError(e, "예상질문 불러오기"); existing = []; }
  renderExisting(no);
}
function renderExisting(no) {
  if ($("#qStudent", root).value !== no) return;
  // 학생 질문(검토 대기 → 검토함) 먼저, 그다음 선생님 질문 — 각각 넣은 순서
  const rank = (q) => (q.by === "student" ? (q.reviewedAt ? 1 : 0) : 2);
  existing = [...listOf(no)].sort((a, b) => rank(a) - rank(b) || (a.createdAt?.seconds || 0) - (b.createdAt?.seconds || 0));
  const st = pqStats(existing);
  $("#qCount", root).textContent = st.pqMine
    ? `${st.pqCount}개 · 선생님 ${st.pqCount - st.pqMine} · 학생 ${st.pqMine}${st.pqPending ? ` (검토 대기 ${st.pqPending})` : ""}`
    : `(${st.pqCount})`;
  const box = $("#qExisting", root);
  box.innerHTML = existing.length ? existing.map((q, i) => pqCardHtml(no, q, { num: i + 1, showStatus: true })).join("")
    : `<div class="empty">아직 없습니다.</div>`;
  bindPqActions(box, () => { renderExisting(no); renderSelect(); rerender("students"); });
}

export async function savePersonal(no, qs, quiet = false) {
  try {
    const col = collection(db, "students", no, "personalQuestions");
    const cur = (await getDocs(col)).docs.map((d) => ({ id: d.id, ...d.data() }));
    const batch = writeBatch(db);
    const by = myName() || S.ctx.user.email;
    qs.forEach((q) => batch.set(doc(col), { type: "document", ...q, by: "teacher", addedBy: by, createdAt: serverTimestamp() }));
    const stats = pqStats([...cur, ...qs.map((q) => ({ ...q, by: "teacher" }))]);
    batch.update(doc(db, "students", no), stats);
    await batch.commit();
    const st = studentByNo(no); if (st) Object.assign(st, stats);
    if (!quiet) toast(`${st?.name || ""} 학생에게 ${qs.length}개 저장했습니다.`);
    rerender("students");
    if ($("#qStudent", root).value === no) loadExisting(no);
  } catch (e) { showError(e, "예상질문 저장"); throw e; }
}
