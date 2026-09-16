import {
  db, collection, doc, getDocs, setDoc, updateDoc, deleteDoc, writeBatch, query, where, serverTimestamp,
  $, $$, esc, toast, showError, copyText, issueAccount, loginDocId, randomPw, defaultEmail, createAuthUser
} from "./common.js";
import { S, register, rerender, loadAll, openModal, closeModal, opt, studentByNo } from "./t-core.js";
import { importStaff } from "./importers.js";
import { getSyncConfig, clearSyncCache, testConnection, requestSync } from "./sync.js";

let root;
export function init(el) {
  root = el;
  root.innerHTML = `
    <div class="tabs sub" id="adTabs">
      <button class="active" data-ad="sync">① 시트 연동</button>
      <button data-ad="staff">② 교사 계정</button>
      <button data-ad="student">③ 학생 계정</button>
    </div>
    <div data-adpanel="sync"></div>
    <div data-adpanel="staff" hidden></div>
    <div data-adpanel="student" hidden></div>`;
  $$("[data-ad]", root).forEach((b) => b.onclick = () => {
    $$("[data-ad]", root).forEach((x) => x.classList.toggle("active", x === b));
    $$("[data-adpanel]", root).forEach((p) => p.hidden = p.dataset.adpanel !== b.dataset.ad);
  });
  register("admin", render);
}

// ================= 공통: 계정 결과 표 =================
function siteUrl() { return location.href.replace(/teacher\.html.*$/, ""); }
function resultTable(rows, kind) {
  const url = siteUrl();
  const msg = (r) => kind === "student"
    ? `${r.name} 학생, 면접 연습 플랫폼 계정입니다. 주소: ${url} / 학번: ${r.loginId} / 초기 비밀번호: ${r.pw} (첫 로그인 때 새 비밀번호로 바꿔 주세요)`
    : `${r.name} 선생님, 면접 스튜디오 교사 계정입니다. 주소: ${url} / ID: ${r.loginId} / 초기 비밀번호: ${r.pw} (첫 로그인 때 변경)`;
  return {
    html: `<div class="row" style="margin:10px 0 6px"><b>발급 결과</b><div class="spacer"></div>
      <button class="btn-sm" data-copy="table">표 복사 (시트 붙여넣기용)</button><button class="btn-sm" data-copy="msg">안내문 복사</button></div>
      <div class="table-wrap" style="max-height:45vh;overflow-y:auto"><table><thead><tr><th>${kind === "student" ? "학번" : "ID"}</th><th>이름</th><th>초기 비밀번호</th><th>결과</th></tr></thead><tbody>
      ${rows.map((r) => `<tr><td>${esc(r.loginId)}</td><td>${esc(r.name)}</td><td>${r.pw ? `<span class="pw">${esc(r.pw)}</span>` : "-"}</td><td>${r.pw ? '<span class="badge badge-green">발급</span>' : `<span class="badge badge-red">${esc(r.err)}</span>`}</td></tr>`).join("")}
      </tbody></table></div>`,
    bind(el) {
      const ok = rows.filter((r) => r.pw);
      $("[data-copy=table]", el).onclick = () => copyText([kind === "student" ? "학번\t이름\t초기 비밀번호\t안내문" : "ID\t이름\t초기 비밀번호\t안내문", ...ok.map((r) => `${r.loginId}\t${r.name}\t${r.pw}\t${msg(r)}`)].join("\n"));
      $("[data-copy=msg]", el).onclick = () => copyText(ok.map(msg).join("\n\n"));
    }
  };
}
const errText = (e) => e.code === "auth/too-many-requests" ? "요청 한도 초과 — 1시간 뒤 이어서" : e.code === "auth/email-already-in-use" ? "이미 있는 ID(비번 모름) — 재발급 필요" : (e.message || e.code);

// ================= ② 교사 계정 =================
function renderStaff() {
  const p = $("[data-adpanel=staff]", root);
  p.innerHTML = `
    <div class="toolbar"><span class="muted">${S.staff.length}명</span><div class="spacer"></div>
      <button id="stAdd">+ 교사 추가</button><button class="btn-primary" id="stBulk">명단 붙여넣어 한 번에 만들기</button></div>
    <div class="card table-wrap"><table><thead><tr><th>이름</th><th>교과·역할</th><th>로그인 ID</th><th>권한</th><th>비밀번호</th><th></th></tr></thead><tbody>
      ${S.staff.length ? S.staff.map((t) => `<tr>
        <td><b>${esc(t.name)}</b></td><td>${esc(t.subject || "")}</td><td>${t.uid ? `<span class="pw">${esc(t.loginId)}</span>` : '<span class="muted">미발급</span>'}</td>
        <td><select data-role="${t.id}" style="width:auto">${opt([["teacher", "교사"], ["admin", "관리자"]], t.role || "teacher")}</select></td>
        <td>${!t.uid ? "-" : t.mustChangePw ? `초기 <span class="pw">${esc(t.initialPw || "")}</span>` : '<span class="badge badge-green">변경 완료</span>'}</td>
        <td class="nowrap">${t.uid ? `<button class="btn-sm" data-reissue="${t.id}">비번 재발급</button>` : `<button class="btn-sm btn-primary" data-issue="${t.id}">발급</button>`}
          <button class="btn-sm btn-danger" data-del="${t.id}">삭제</button></td></tr>`).join("") : '<tr><td colspan="6" class="empty">아직 없습니다.</td></tr>'}
    </tbody></table></div>
    <p class="muted">배정표의 교사명과 이름이 같아야 '내 담당 학생'이 연결됩니다. 비밀번호를 잊으면 '비번 재발급' — 새 초기 비밀번호가 생기고 이전 비밀번호는 못 씁니다.</p>`;
  $("#stAdd", p).onclick = () => staffBulkModal(true);
  $("#stBulk", p).onclick = () => staffBulkModal(false);
  $$("[data-role]", p).forEach((s) => s.onchange = async () => {
    const t = S.staff.find((x) => x.id === s.dataset.role);
    try {
      const b = writeBatch(db);
      b.update(doc(db, "staff", t.id), { role: s.value });
      if (t.uid) b.update(doc(db, "accounts", t.uid), { role: s.value });
      await b.commit(); t.role = s.value; toast(`${t.name}: ${s.value === "admin" ? "관리자" : "교사"} 권한`);
    } catch (e) { showError(e, "권한 변경"); s.value = t.role || "teacher"; }
  });
  $$("[data-issue],[data-reissue]", p).forEach((b) => b.onclick = async () => {
    const t = S.staff.find((x) => x.id === (b.dataset.issue || b.dataset.reissue));
    if (b.dataset.reissue && !confirm(`${t.name} 선생님 비밀번호를 재발급할까요? 지금 비밀번호는 더 이상 쓸 수 없습니다.`)) return;
    b.disabled = true;
    try {
      const r = await issueAccount({ kind: "staff", key: t.id, loginId: t.loginId || t.id, role: t.role || "teacher", name: t.name, oldUid: t.uid || null, version: t.uid ? (t.loginVersion || 1) + 1 : 1 });
      const out = resultTable([{ loginId: t.loginId || t.id, name: t.name, pw: r.pw }], "staff");
      const body = openModal("교사 계정", out.html); out.bind(body);
      await loadAll();
    } catch (e) { showError(e, "계정 발급"); b.disabled = false; }
  });
  $$("[data-del]", p).forEach((b) => b.onclick = async () => {
    const t = S.staff.find((x) => x.id === b.dataset.del);
    if (!confirm(`${t.name} 선생님 계정을 삭제할까요? (로그인 불가 처리. 기록은 남습니다)`)) return;
    try {
      const batch = writeBatch(db);
      batch.delete(doc(db, "staff", t.id));
      if (t.uid) batch.delete(doc(db, "accounts", t.uid));
      batch.delete(doc(db, "logins", loginDocId("staff", t.loginId || t.id)));
      await batch.commit(); toast("삭제했습니다."); await loadAll();
    } catch (e) { showError(e, "교사 삭제"); }
  });
}

function staffBulkModal(single) {
  const body = openModal(single ? "교사 추가" : "교사 명단으로 계정 만들기", `
    ${single ? "" : `<p class="muted">수요조사 시트의 <b>지도교사 명단</b> 또는 <b>3회 지도 배정안</b> 위쪽 표(교사명 · 교과·역할)를 머리행과 함께 붙여넣으세요.</p>
    <textarea id="paste" style="min-height:120px"></textarea><div style="margin:6px 0 12px"><button id="read">읽기</button></div>`}
    <div id="rows"></div>
    <div class="row" style="margin-top:12px"><button class="btn-primary" id="make" hidden>계정 만들기</button><span class="muted" id="prog"></span></div>
    <div id="result"></div>`, true);
  let rows = [];
  const usedIds = new Set(S.staff.map((t) => t.id));
  const nextId = () => { let i = 1; while (usedIds.has(`t${String(i).padStart(2, "0")}`)) i++; const id = `t${String(i).padStart(2, "0")}`; usedIds.add(id); return id; };
  const draw = () => {
    $("#rows", body).innerHTML = `<div class="table-wrap"><table><thead><tr><th>이름</th><th>교과·역할</th><th>로그인 ID (영문·숫자)</th><th>권한</th><th></th></tr></thead><tbody>
      ${rows.map((r, i) => `<tr><td><input data-i="${i}" data-k="name" value="${esc(r.name)}"></td><td><input data-i="${i}" data-k="subject" value="${esc(r.subject)}"></td>
        <td><input data-i="${i}" data-k="loginId" value="${esc(r.loginId)}"></td>
        <td><select data-i="${i}" data-k="role">${opt([["teacher", "교사"], ["admin", "관리자"]], r.role)}</select></td>
        <td>${S.staff.some((t) => t.name === r.name) ? '<span class="badge badge-orange">이미 있음</span>' : ""}</td></tr>`).join("")}
      </tbody></table></div>`;
    $$("[data-i]", body).forEach((el) => el.oninput = el.onchange = () => { rows[el.dataset.i][el.dataset.k] = el.value.trim(); });
    $("#make", body).hidden = !rows.length;
  };
  if (single) { rows = [{ name: "", subject: "", loginId: nextId(), role: "teacher" }]; draw(); }
  else $("#read", body).onclick = () => {
    const { list, headerFound } = importStaff($("#paste", body).value);
    if (!headerFound || !list.length) return toast("교사명 머리행이 있는 표를 붙여넣으세요.", "error");
    rows = list.map((r) => ({ ...r, loginId: r.loginId || nextId(), role: /부장/.test(r.subject) ? "admin" : "teacher" }));
    draw();
  };
  $("#make", body).onclick = async () => {
    const todo = rows.filter((r) => r.name && !S.staff.some((t) => t.name === r.name));
    const bad = todo.find((r) => !/^[a-z0-9._-]{2,20}$/.test(r.loginId.toLowerCase()) || S.staff.some((t) => t.id === r.loginId.toLowerCase()));
    if (bad) return toast(`로그인 ID "${bad.loginId}"를 확인하세요 (영문·숫자 2~20자, 중복 불가).`, "error");
    if (new Set(todo.map((r) => r.loginId.toLowerCase())).size !== todo.length) return toast("로그인 ID가 서로 겹칩니다.", "error");
    $("#make", body).disabled = true;
    const out = [];
    for (let i = 0; i < todo.length; i++) {
      const r = todo[i], id = r.loginId.toLowerCase();
      $("#prog", body).textContent = `${i + 1}/${todo.length} 처리 중…`;
      try {
        await setDoc(doc(db, "staff", id), { name: r.name, subject: r.subject, role: r.role, loginId: id, createdAt: serverTimestamp() });
        const res = await issueAccount({ kind: "staff", key: id, loginId: id, role: r.role, name: r.name });
        out.push({ loginId: id, name: r.name, pw: res.pw });
      } catch (e) {
        console.error(e); out.push({ loginId: id, name: r.name, err: errText(e) });
        if (e.code === "auth/too-many-requests") break;
      }
    }
    $("#prog", body).textContent = `완료: ${out.filter((o) => o.pw).length}명 발급`;
    const t = resultTable(out, "staff"); $("#result", body).innerHTML = t.html; t.bind(body);
    await loadAll();
  };
}

// ================= ③ 학생 계정 =================
function renderStudentAccounts() {
  const p = $("[data-adpanel=student]", root);
  const issued = S.students.filter((s) => s.uid);
  const changed = issued.filter((s) => !s.mustChangePw);
  const kw = p.dataset.kw || "";
  p.innerHTML = `
    <div class="grid grid-4" style="margin-bottom:14px">
      <div class="card"><div class="muted">학생</div><div class="stat">${S.students.length}</div></div>
      <div class="card"><div class="muted">계정 발급</div><div class="stat">${issued.length}</div></div>
      <div class="card"><div class="muted">비밀번호 변경 완료</div><div class="stat">${changed.length}</div></div>
      <div class="card"><div class="muted">미발급</div><div class="stat">${S.students.length - issued.length}</div></div>
    </div>
    <div class="toolbar">
      <input id="saKw" placeholder="이름·학번" value="${esc(kw)}">
      <div class="spacer"></div>
      <button id="saShow">초기 비밀번호 표 보기</button>
      <button class="btn-primary" id="saIssue" ${S.students.length === issued.length ? "disabled" : ""}>미발급 ${S.students.length - issued.length}명 발급</button>
    </div>
    <div class="card table-wrap"><table><thead><tr><th>학번</th><th>이름</th><th>상태</th><th></th></tr></thead><tbody>
      ${S.students.filter((s) => !kw || `${s.name}${s.studentNo}`.includes(kw)).map((s) => `<tr><td>${esc(s.studentNo)}</td><td>${esc(s.name)}</td>
        <td>${!s.uid ? '<span class="muted">미발급</span>' : s.mustChangePw ? `초기 비번 <span class="pw">${esc(s.initialPw || "")}</span>` : '<span class="badge badge-green">변경 완료</span>'}</td>
        <td>${s.uid ? `<button class="btn-sm" data-reissue="${s.studentNo}">비번 재발급</button>` : `<button class="btn-sm" data-issue="${s.studentNo}">발급</button>`}</td></tr>`).join("")}
    </tbody></table></div>
    <p class="muted">Firebase는 한 곳에서 짧은 시간에 계정을 너무 많이 만들면 잠시 막습니다. 중간에 멈추면 1시간 뒤 같은 버튼을 다시 누르면 남은 학생만 이어서 발급합니다.</p>`;
  $("#saKw", p).oninput = (e) => { p.dataset.kw = e.target.value; renderStudentAccounts(); $("#saKw", p).focus(); $("#saKw", p).setSelectionRange(99, 99); };
  $("#saShow", p).onclick = () => {
    const rows = S.students.filter((s) => s.uid && s.mustChangePw && s.initialPw).map((s) => ({ loginId: s.studentNo, name: s.name, pw: s.initialPw }));
    if (!rows.length) return toast("표시할 초기 비밀번호가 없습니다 (모두 변경했거나 미발급).");
    const t = resultTable(rows, "student"); const body = openModal("학생 초기 비밀번호 (아직 안 바꾼 학생)", t.html, true); t.bind(body);
  };
  $("#saIssue", p).onclick = () => issueStudents(S.students.filter((s) => !s.uid));
  $$("[data-issue]", p).forEach((b) => b.onclick = () => issueStudents([studentByNo(b.dataset.issue)]));
  $$("[data-reissue]", p).forEach((b) => b.onclick = () => {
    const s = studentByNo(b.dataset.reissue);
    if (confirm(`${s.name} 학생 비밀번호를 재발급할까요? 지금 비밀번호는 더 이상 쓸 수 없습니다.`)) issueStudents([s], true);
  });
}

async function issueStudents(list, reissue = false) {
  const body = openModal(reissue ? "학생 비밀번호 재발급" : `학생 계정 발급 (${list.length}명)`, `<div class="row"><span id="prog" class="muted">시작…</span></div><div id="result"></div>`, true);
  const out = [];
  for (let i = 0; i < list.length; i++) {
    const s = list[i];
    $("#prog", body).textContent = `${i + 1}/${list.length} ${s.name} 처리 중…`;
    try {
      const r = await issueAccount({
        kind: "student", key: s.studentNo, loginId: s.studentNo, role: "student", name: s.name,
        oldUid: s.uid || null, version: s.uid ? (s.loginVersion || 1) + 1 : 1
      });
      // 이 학생의 기존 연습·대면 기록을 새 계정에 연결
      const [ss, mt] = await Promise.all([
        getDocs(query(collection(db, "sessions"), where("studentNo", "==", s.studentNo))),
        getDocs(query(collection(db, "meetings"), where("studentNo", "==", s.studentNo)))
      ]);
      if (ss.size || mt.size) {
        const b = writeBatch(db);
        ss.docs.forEach((d) => b.update(d.ref, { studentUid: r.uid }));
        mt.docs.forEach((d) => b.update(d.ref, { studentUid: r.uid }));
        await b.commit();
      }
      out.push({ loginId: s.studentNo, name: s.name, pw: r.pw });
    } catch (e) {
      console.error(e); out.push({ loginId: s.studentNo, name: s.name, err: errText(e) });
      if (e.code === "auth/too-many-requests") { toast("Firebase 요청 한도에 걸려 멈췄습니다. 1시간 뒤 이어서 발급하세요.", "error", 9000); break; }
    }
  }
  const ok = out.filter((o) => o.pw).length;
  $("#prog", body).textContent = `완료: 발급 ${ok}명${out.length - ok ? `, 실패 ${out.length - ok}명` : ""}${out.length < list.length ? `, 남은 ${list.length - out.length}명` : ""}`;
  const t = resultTable(out, "student"); $("#result", body).innerHTML = t.html; t.bind(body);
  await loadAll();
}

// ================= ① 시트 연동 =================
async function renderSync() {
  const p = $("[data-adpanel=sync]", root);
  let cfg = {};
  try { cfg = await getSyncConfig(true); } catch (e) { showError(e, "연동 설정 불러오기"); }
  const syncAcct = cfg.syncEmail;
  p.innerHTML = `
    <div class="notice">학생 명단·트랙·배정·면접일은 <b>구글 시트('앱연동_학생', '앱연동_면접일')와 쌍방으로</b> 맞춰집니다.
      시트에서 고치면 수 초 안에 앱에, 앱에서 고치면 바로 시트에 반영되고, 30분마다(07~22시) 전체를 다시 대조합니다. 설치 순서는 SETUP.md 3장.</div>
    <div class="grid grid-2" style="align-items:start">
      <div class="card">
        <h3>1. 동기화 전용 계정</h3>
        <p class="muted" style="margin-top:0">시트의 Apps Script가 앱 데이터에 쓸 때 사용하는 계정입니다. 화면 로그인은 안 됩니다.</p>
        ${syncAcct ? `<dl class="kv"><dt>이메일</dt><dd><span class="pw">${esc(syncAcct)}</span></dd></dl>` : '<p>아직 없습니다.</p>'}
        <button id="syAcct" class="${syncAcct ? "btn-sm" : "btn-primary"}">${syncAcct ? "비밀번호 재발급" : "동기화 계정 만들기"}</button>
        <div id="syAcctOut"></div>
      </div>
      <div class="card">
        <h3>2. Apps Script 웹 앱 연결</h3>
        <div class="field"><label>웹 앱 URL</label><input id="syUrl" value="${esc(cfg.url || "")}" placeholder="https://script.google.com/macros/s/…/exec"></div>
        <div class="field"><label>토큰 (시트 메뉴 ② 앱 연결 설정에서 표시)</label><input id="syToken" value="${esc(cfg.token || "")}"></div>
        <div class="row"><button class="btn-primary" id="sySave">저장</button><button id="syTest">연결 테스트</button><button id="syNow">지금 동기화</button></div>
        <div class="muted" id="syState" style="margin-top:8px"></div>
      </div>
    </div>`;
  $("#syAcct", p).onclick = async () => {
    if (syncAcct && !confirm("동기화 계정 비밀번호를 새로 만들까요? 시트 메뉴 ② 앱 연결 설정에 새 비밀번호를 다시 넣어야 합니다.")) return;
    $("#syAcct", p).disabled = true;
    try {
      const version = (cfg.syncVersion || 0) + 1;
      const pw = randomPw(16);
      const email = defaultEmail("staff", "sync", version);
      const uid = await createAuthUser(email, pw);
      const batch = writeBatch(db);
      batch.set(doc(db, "accounts", uid), { role: "sync", key: "sync", name: "시트 동기화", createdAt: serverTimestamp() });
      if (cfg.syncUid && cfg.syncUid !== uid) batch.delete(doc(db, "accounts", cfg.syncUid));
      batch.set(doc(db, "config", "sync"), { ...cfg, syncEmail: email, syncUid: uid, syncVersion: version, updatedAt: serverTimestamp() });
      await batch.commit();
      clearSyncCache();
      await renderSync();
      $("#syAcctOut", p).innerHTML = `<div class="notice" style="margin-top:10px">시트 메뉴 <b>② 앱 연결 설정</b>에 입력하세요. 이 비밀번호는 다시 볼 수 없습니다.<br>
        이메일 <span class="pw">${esc(email)}</span><br>비밀번호 <span class="pw">${esc(pw)}</span>
        <div style="margin-top:6px"><button class="btn-sm" id="cpAcct">복사</button></div></div>`;
      $("#cpAcct", p).onclick = () => copyText(`${email}\n${pw}`);
    } catch (e) { showError(e, "동기화 계정 만들기"); $("#syAcct", p).disabled = false; }
  };
  $("#sySave", p).onclick = async () => {
    const url = $("#syUrl", p).value.trim(), token = $("#syToken", p).value.trim();
    if (url && !/^https:\/\/script\.google\.com\/.+\/exec$/.test(url)) return toast("URL은 https://script.google.com/…/exec 형태여야 합니다.", "error");
    try { await setDoc(doc(db, "config", "sync"), { url, token, updatedAt: serverTimestamp() }, { merge: true }); clearSyncCache(); $("#syState", p).textContent = "저장됨"; }
    catch (e) { showError(e, "설정 저장"); }
  };
  $("#syTest", p).onclick = async () => {
    $("#syState", p).textContent = "확인 중…";
    try {
      const r = await testConnection($("#syUrl", p).value.trim(), $("#syToken", p).value.trim());
      $("#syState", p).innerHTML = `연결됨 · 시트 학생 ${r.students ?? "탭 없음"}명 · 면접일 ${r.interviews ?? "탭 없음"}건 · 모의 면접 기록 탭 ${r.meetingsSheet ? "확인" : "<b>없음</b>"} · Firebase 계정 ${r.firebase ? "설정됨" : "<b>미설정</b>"} · 자동 트리거 ${r.triggers ? "켜짐" : "<b>꺼짐</b>"}`;
    } catch (e) { $("#syState", p).textContent = ""; showError(e, "연결 테스트"); }
  };
  $("#syNow", p).onclick = async () => {
    $("#syState", p).textContent = "동기화 중… (학생 수가 많으면 1분 가까이 걸릴 수 있어요)";
    const r = await requestSync(["students", "interviews", "meetings"], { quiet: true });
    if (r.ok) {
      const x = r.result || {};
      toast(`동기화 완료 · 시트→앱 ${x.pushed || 0} · 앱→시트 ${x.pulled || 0} · 새로 추가 ${x.created || 0} · 삭제 ${x.deleted || 0}`, "ok", 6000);
      await loadAll();
    } else $("#syState", p).textContent = r.skipped ? "URL·토큰을 먼저 저장하세요." : `실패: ${r.error}`;
  };
}

function render() {
  renderStaff();
  renderStudentAccounts();
  renderSync();
}
