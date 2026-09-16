import {
  db, collection, doc, getDocs, deleteDoc, updateDoc, writeBatch, serverTimestamp,
  $, $$, esc, toast, showError, copyText, parseLooseJSON
} from "./common.js";
import { S, register, rerender, openModal, closeModal, readForm, lines, studentOptions, studentByNo, myName } from "./t-core.js";
import { personalQuestionPrompt } from "./prompts.js";
import { importSheetQuestions } from "./importers.js";

let root, parsed = [], existing = [];
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
            <button type="button" class="active" data-src="sheet">준비 시트에서</button>
            <button type="button" data-src="claude">생기부 → Claude</button>
            <button type="button" data-src="manual">직접 입력</button>
          </div>
          <div data-srcpanel="sheet">
            <p class="muted" style="margin-top:0">학생 준비 시트의 <b>교과 선생님 질문</b> 표에서 머리행(번호·관련 활동·교사 예상 질문·꼬리질문 1·꼬리질문 2)부터 필요한 행까지 복사해 붙여넣으세요.</p>
            <textarea id="qSheetPaste" placeholder="번호	관련 활동·생기부 내용	교사 예상 질문	꼬리질문 1	꼬리질문 2 …"></textarea>
            <div style="margin-top:6px"><button id="qSheetParse">미리보기</button></div>
          </div>
          <div data-srcpanel="claude" hidden>
            <label>생기부 내용 <span class="muted">(세특·창체·행특 등)</span></label>
            <textarea id="qRecord" style="min-height:180px" placeholder="예) [화학Ⅱ 세특] …"></textarea>
            <div class="row" style="margin:6px 0 12px"><button class="btn-sm" id="qSaveRecord">생기부 저장</button><span class="muted" id="qRecordState"></span></div>
            <div class="row">
              <select id="qN" style="width:auto"><option>10</option><option selected>15</option><option>20</option></select>
              <label class="inline-check"><input type="checkbox" id="qMask" checked> 이름 가리기</label>
              <label class="inline-check"><input type="checkbox" id="qNoDup" checked> 기존 질문과 중복 피하기</label>
              <button class="btn-primary btn-sm" id="qCopy">프롬프트 복사</button>
            </div>
            <label style="margin-top:12px">Claude 결과(JSON) 붙여넣기</label>
            <textarea id="qPaste" placeholder='[{"text": "...", "followUps": [...]}]'></textarea>
            <div style="margin-top:6px"><button id="qParse">미리보기</button></div>
          </div>
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
        <div class="card" id="qPreviewCard" hidden>
          <div class="row" style="margin-bottom:8px"><h3 style="margin:0">가져올 질문</h3><div class="spacer"></div>
            <button class="btn-sm" id="qToggleAll">전체 선택/해제</button><button class="btn-primary btn-sm" id="qSave">선택 저장</button></div>
          <div id="qPreview"></div>
        </div>
        <div class="card"><h3>저장된 예상질문 <span class="muted" id="qCount"></span></h3>
          <p class="muted" style="margin-top:0">학생의 '내 생기부 면접' 말하기 연습에 무작위로 출제됩니다.</p>
          <div id="qExisting"><div class="empty">학생을 선택하세요.</div></div></div>
      </div>
    </div>`;
  $("#qStudent", root).onchange = onStudent;
  $$("[data-src]", root).forEach((b) => b.onclick = () => {
    $$("[data-src]", root).forEach((x) => x.classList.toggle("active", x === b));
    $$("[data-srcpanel]", root).forEach((p) => p.hidden = p.dataset.srcpanel !== b.dataset.src);
  });
  $("#qSheetParse", root).onclick = () => {
    const { list } = importSheetQuestions($("#qSheetPaste", root).value);
    if (!list.length) return toast("질문을 찾지 못했습니다. '교사 예상 질문' 머리행까지 함께 복사했는지 확인하세요.", "error", 6000);
    parsed = list.map((q) => ({ ...q, category: "교과 선생님 질문", source: "sheet", _on: true }));
    renderPreview();
  };
  $("#qSaveRecord", root).onclick = saveRecord;
  $("#qCopy", root).onclick = copyPrompt;
  $("#qParse", root).onclick = parseClaude;
  $("#qToggleAll", root).onclick = () => { const on = !parsed.every((q) => q._on); parsed.forEach((q) => q._on = on); renderPreview(); };
  $("#qSave", root).onclick = async () => {
    const no = $("#qStudent", root).value; if (!no) return toast("학생을 먼저 선택하세요.", "error");
    const sel = parsed.filter((q) => q._on);
    if (!sel.length) return toast("선택한 질문이 없습니다.", "error");
    try {
      await savePersonal(no, sel.map(({ _on, ...q }) => q));
      $("#qPaste", root).value = ""; $("#qSheetPaste", root).value = ""; parsed = []; $("#qPreviewCard", root).hidden = true;
    } catch (_) {}
  };
  $("#qManual", root).onsubmit = async (e) => {
    e.preventDefault();
    const no = $("#qStudent", root).value; if (!no) return toast("학생을 먼저 선택하세요.", "error");
    const d = readForm($("#qManual", root));
    try { await savePersonal(no, [{ ...d, followUps: lines(d.followUps), source: "manual" }]); $("#qManual", root).reset(); } catch (_) {}
  };
  register("questions", renderSelect);
}

function renderSelect() {
  const cur = $("#qStudent", root).value;
  $("#qStudent", root).innerHTML = studentOptions(cur);
}
export function selectStudentForQuestions(no) {
  renderSelect();
  $("#qStudent", root).value = no;
  onStudent();
}

async function onStudent() {
  const st = studentByNo($("#qStudent", root).value);
  $("#qRecord", root).value = st?.recordSummary || "";
  $("#qRecordState", root).textContent = "";
  $("#qSheetRow", root).innerHTML = st?.sheetUrl ? `<a class="btn btn-sm" href="${esc(st.sheetUrl)}" target="_blank" rel="noopener">${esc(st.name)} 준비 시트 열기</a>` : "";
  parsed = []; $("#qPreviewCard", root).hidden = true;
  if (!st) { $("#qExisting", root).innerHTML = `<div class="empty">학생을 선택하세요.</div>`; $("#qCount", root).textContent = ""; return; }
  await loadExisting(st.studentNo);
}

async function loadExisting(no) {
  try {
    const snap = await getDocs(collection(db, "students", no, "personalQuestions"));
    existing = snap.docs.map((d) => ({ id: d.id, ...d.data() })).sort((a, b) => (a.createdAt?.seconds || 0) - (b.createdAt?.seconds || 0));
  } catch (e) { showError(e, "예상질문 불러오기"); existing = []; }
  $("#qCount", root).textContent = `(${existing.length})`;
  $("#qExisting", root).innerHTML = existing.length ? existing.map((q, i) => `
    <div class="q-item"><div class="q-text">${i + 1}. ${esc(q.text)}</div>
      <div class="q-meta">${esc(q.category || "")}${q.basis ? ` · ${esc(q.basis)}` : ""}${q.addedBy ? ` · ${esc(q.addedBy)}` : ""}</div>
      ${q.followUps?.length ? `<ul class="follow">${q.followUps.map((f) => `<li>${esc(f)}</li>`).join("")}</ul>` : ""}
      <div class="q-actions"><button class="btn-sm btn-danger" data-del="${q.id}">삭제</button></div></div>`).join("")
    : `<div class="empty">아직 없습니다.</div>`;
  $$("[data-del]", $("#qExisting", root)).forEach((b) => b.onclick = async () => {
    try {
      await deleteDoc(doc(db, "students", no, "personalQuestions", b.dataset.del));
      const n = existing.length - 1;
      await updateDoc(doc(db, "students", no), { pqCount: n });
      const st = studentByNo(no); if (st) st.pqCount = n;
      loadExisting(no); rerender("students");
    } catch (e) { showError(e, "삭제"); }
  });
}

async function saveRecord() {
  const no = $("#qStudent", root).value; if (!no) return toast("학생을 먼저 선택하세요.", "error");
  try {
    await updateDoc(doc(db, "students", no), { recordSummary: $("#qRecord", root).value });
    studentByNo(no).recordSummary = $("#qRecord", root).value;
    $("#qRecordState", root).textContent = "저장됨";
  } catch (e) { showError(e, "생기부 저장"); }
}

function copyPrompt() {
  const st = studentByNo($("#qStudent", root).value);
  if (!st) return toast("학생을 먼저 선택하세요.", "error");
  let record = $("#qRecord", root).value.trim();
  if (record.length < 30) return toast("생기부 내용을 먼저 붙여넣으세요.", "error");
  if ($("#qMask", root).checked && st.name) record = record.split(st.name).join("학생");
  const univ = (st.universities || []).map((u) => `${u.univ} ${u.dept}(${u.admission}, ${u.format})`).join(" / ");
  copyText(personalQuestionPrompt({
    record, major: (st.universities || []).map((u) => u.dept).filter(Boolean).join(", "), targets: univ,
    n: Number($("#qN", root).value), existing: $("#qNoDup", root).checked ? existing.map((q) => q.text) : []
  }));
}

function parseClaude() {
  let arr;
  try { arr = parseLooseJSON($("#qPaste", root).value); if (!Array.isArray(arr)) arr = [arr]; }
  catch (e) { return showError(e, "JSON 읽기"); }
  parsed = arr.filter((q) => q && typeof q.text === "string" && q.text.trim()).map((q) => ({
    text: q.text.trim(), category: q.category || "", basis: q.basis || "", intent: q.intent || "",
    followUps: Array.isArray(q.followUps) ? q.followUps.filter(Boolean).map(String) : [], source: "claude", _on: true
  }));
  if (!parsed.length) return toast("질문을 찾지 못했습니다. text 항목이 있는지 확인하세요.", "error");
  renderPreview();
}

function renderPreview() {
  $("#qPreviewCard", root).hidden = false;
  $("#qPreview", root).innerHTML = parsed.map((q, i) => `
    <div class="q-item ${q._on ? "sel" : ""}" data-i="${i}" style="cursor:pointer">
      <div class="row"><input type="checkbox" ${q._on ? "checked" : ""} style="width:auto"><span class="q-text pre">${esc(q.text)}</span></div>
      <div class="q-meta">${esc(q.category || "")}${q.basis ? ` · ${esc(q.basis)}` : ""}${q.intent ? ` · 의도: ${esc(q.intent)}` : ""}</div>
      ${q.followUps?.length ? `<ul class="follow">${q.followUps.map((f) => `<li>${esc(f)}</li>`).join("")}</ul>` : ""}
    </div>`).join("");
  $$("#qPreview .q-item", root).forEach((el) => el.onclick = () => { const q = parsed[el.dataset.i]; q._on = !q._on; renderPreview(); });
}

export async function savePersonal(no, qs, quiet = false) {
  try {
    const col = collection(db, "students", no, "personalQuestions");
    const count = (await getDocs(col)).size;
    const batch = writeBatch(db);
    const by = myName() || S.ctx.user.email;
    qs.forEach((q) => batch.set(doc(col), { type: "document", ...q, addedBy: by, createdAt: serverTimestamp() }));
    batch.update(doc(db, "students", no), { pqCount: count + qs.length });
    await batch.commit();
    const st = studentByNo(no); if (st) st.pqCount = count + qs.length;
    if (!quiet) toast(`${st?.name || ""} 학생에게 ${qs.length}개 저장했습니다.`);
    rerender("students");
    if ($("#qStudent", root).value === no) loadExisting(no);
  } catch (e) { showError(e, "예상질문 저장"); throw e; }
}
