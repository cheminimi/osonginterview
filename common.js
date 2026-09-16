import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getAuth, onAuthStateChanged, signInWithEmailAndPassword, signOut, createUserWithEmailAndPassword,
  connectAuthEmulator, EmailAuthProvider, reauthenticateWithCredential, updatePassword
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  getFirestore, connectFirestoreEmulator, collection, doc, getDoc, getDocs, setDoc, addDoc,
  updateDoc, deleteDoc, query, where, serverTimestamp, writeBatch, deleteField
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { firebaseConfig, ADMIN_EMAILS, LOGIN_EMAIL_DOMAIN } from "./firebase-config.js";

export {
  collection, doc, getDoc, getDocs, setDoc, addDoc, updateDoc, deleteDoc,
  query, where, serverTimestamp, writeBatch, deleteField, signOut, signInWithEmailAndPassword
};

// ---- 에뮬레이터(로컬 테스트) 스위치: 주소 뒤에 ?emu=1 을 한 번 붙이면 켜지고 ?emu=0 이면 꺼짐
const params = new URLSearchParams(location.search);
try {
  if (params.get("emu") === "1") localStorage.setItem("useEmulator", "1");
  if (params.get("emu") === "0") localStorage.removeItem("useEmulator");
} catch (_) {}
let USE_EMU = false;
try { USE_EMU = localStorage.getItem("useEmulator") === "1"; } catch (_) {}

export const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db = getFirestore(app);
if (USE_EMU) {
  connectAuthEmulator(auth, "http://127.0.0.1:9099", { disableWarnings: true });
  connectFirestoreEmulator(db, "127.0.0.1", 8080);
}

// ================= 상수 =================
export const TYPES = {
  document: { label: "학생부 기반", color: "blue", prep: 0, answer: 90 },
  passage: { label: "제시문", color: "violet", prep: 600, answer: 420 },
  personality: { label: "기본 인성", color: "green", prep: 0, answer: 60 },
  mmi: { label: "MMI", color: "orange", prep: 120, answer: 180 }
};
// 운영 원본의 '기본 트랙' 값
export const TRACKS = ["학생부 기반", "기본 인성", "학생부+기본 인성", "담임 기본지도"];
export const SPECIALS = ["없음", "제시문", "MMI", "제시문+MMI"];
// 질문은행 분류용 계열
export const FIELDS = ["공통", "자연·공학", "의약·보건", "생명·환경", "인문", "사회·경영", "교육"];
export const SUBJECTS = ["화학", "생명과학", "물리학", "지구과학", "수학", "국어", "영어", "사회", "역사", "정보", "교육학", "특정 교과와 관련 없음"];
export const STAGES = [
  { key: 1, label: "1차 담임" },
  { key: 2, label: "2차 교과" },
  { key: 3, label: "3차 모의면접" },
  { key: 4, label: "추가 지도" }
];
export const MEETING_TYPES = ["학생부 기반", "기본 인성", "제시문", "MMI", "복합형", "담임 기본지도"];
export const CRITERIA = [
  { key: "logic", label: "논리성", hint: "주장-근거-결론 흐름" },
  { key: "specific", label: "구체성", hint: "경험·수치·장면" },
  { key: "fit", label: "전공적합성", hint: "학업역량·진로 연결" },
  { key: "delivery", label: "전달력", hint: "시간·어휘·태도" }
];

// ================= 계정 =================
export const isAdminEmail = (email) =>
  !!email && ADMIN_EMAILS.map((e) => e.toLowerCase()).includes(email.toLowerCase());
const cleanId = (id) => String(id).trim().toLowerCase();
export const loginDocId = (kind, id) => `${kind === "student" ? "s" : "t"}_${cleanId(id)}`;
export const defaultEmail = (kind, id, version = 1) =>
  `${kind === "student" ? "s" : "t"}${cleanId(id)}${version > 1 ? ".v" + version : ""}@${LOGIN_EMAIL_DOMAIN}`;

// 로그인 ID → 실제 이메일 (비밀번호 재발급으로 바뀐 경우 logins 문서에 기록됨)
export async function resolveLoginEmail(kind, id) {
  if (kind !== "student" && id.includes("@")) return id.trim();
  try {
    const snap = await getDoc(doc(db, "logins", loginDocId(kind, id)));
    if (snap.exists() && snap.data().email) return snap.data().email;
  } catch (e) { console.warn("login lookup", e); }
  return defaultEmail(kind, id);
}

// 로그인 화면과 각 페이지에서 동일한 계정 판정 사용. 조회 실패를 학생으로 간주하지 않는다.
export async function readAccount(user) {
  const snap = await getDoc(doc(db, "accounts", user.uid));
  if (snap.exists()) return snap.data();
  if (isAdminEmail(user.email)) return { role: "admin", key: null, bootstrap: true };
  return null;
}

export function accountHome(account) {
  if (!account) throw new Error("계정 정보가 없습니다. 관리자에게 문의하세요.");
  if (account.role === "student") return "student.html";
  if (account.role === "teacher" || account.role === "admin") return "teacher.html";
  if (account.role === "sync") throw new Error("시트 동기화 전용 계정은 화면에 로그인할 수 없습니다.");
  throw new Error("계정 권한을 확인할 수 없습니다. 관리자에게 문의하세요.");
}

/**
 * 로그인 확인 후 사용자 정보 반환.
 * want: 'staff' | 'student'
 * 반환: { user, account: {role, key}, profile }  profile = staff 또는 students 문서
 */
export function requireRole(want) {
  return new Promise((resolve) => {
    const unsub = onAuthStateChanged(auth, async (user) => {
      unsub();
      if (!user) { location.replace("index.html"); return; }
      try {
        const account = await readAccount(user);
        if (!account) {
          toast("계정 정보가 없습니다. 관리자에게 문의하세요.", "error", 10000);
          setTimeout(() => signOut(auth).then(() => location.replace("index.html")), 2500);
          return;
        }
        if (account.role === "sync") {
          toast("시트 동기화 전용 계정은 화면에 로그인할 수 없습니다.", "error", 8000);
          setTimeout(() => signOut(auth).then(() => location.replace("index.html")), 2500);
          return;
        }
        // 알 수 없는 역할도 학생으로 통과시키지 않는다.
        const home = accountHome(account);
        const isStaff = home === "teacher.html";
        if (want === "staff" && !isStaff) { location.replace("student.html"); return; }
        if (want === "student" && isStaff) { location.replace("teacher.html"); return; }
        let profile = null;
        if (account.key) {
          const p = await getDoc(doc(db, isStaff ? "staff" : "students", account.key));
          if (p.exists()) profile = { id: p.id, ...p.data() };
        }
        if (!isStaff && !profile) { toast("학생 정보가 없습니다. 선생님께 문의하세요.", "error", 10000); return; }
        const ctx = { user, account, profile, isAdmin: account.role === "admin", isStaff };
        if (profile?.mustChangePw) await forcePasswordChange(ctx);
        resolve(ctx);
      } catch (e) { showError(e, "로그인 정보 확인"); }
    });
  });
}

export async function logout() {
  await signOut(auth);
  location.replace("index.html");
}

// ---- 계정 생성 (현재 로그인을 유지하려고 보조 앱 인스턴스 사용)
let secondary = null;
function secondaryAuth() {
  if (!secondary) {
    const secApp = initializeApp(firebaseConfig, "secondary");
    secondary = getAuth(secApp);
    if (USE_EMU) connectAuthEmulator(secondary, "http://127.0.0.1:9099", { disableWarnings: true });
  }
  return secondary;
}
// 이미 있는 계정이면 같은 비밀번호로 로그인해 uid를 되찾는다.
export async function createAuthUser(email, password) {
  const sa = secondaryAuth();
  let cred;
  try {
    cred = await createUserWithEmailAndPassword(sa, email, password);
  } catch (e) {
    if (e.code !== "auth/email-already-in-use") throw e;
    try { cred = await signInWithEmailAndPassword(sa, email, password); } catch (_) { throw e; }
  }
  const uid = cred.user.uid;
  await signOut(sa);
  return uid;
}

/**
 * 계정 발급/재발급 (관리자만).
 * kind: 'student' | 'staff', key: 학번 또는 staffId, loginId, role: 'student'|'teacher'|'admin'
 * 재발급이면 새 이메일(.v2, .v3…)로 새 Auth 계정을 만들고 기존 uid의 권한을 지운다.
 */
export async function issueAccount({ kind, key, loginId, role, name, oldUid = null, version = 1 }) {
  const pw = randomPw(8);
  const email = defaultEmail(kind, loginId, version);
  const uid = await createAuthUser(email, pw);
  const batch = writeBatch(db);
  batch.set(doc(db, "accounts", uid), { role, key, name: name || "", createdAt: serverTimestamp() });
  batch.set(doc(db, "logins", loginDocId(kind, loginId)), { email });
  batch.update(doc(db, kind === "student" ? "students" : "staff", key), {
    uid, loginId, loginVersion: version, initialPw: pw, mustChangePw: true, issuedAt: serverTimestamp()
  });
  if (oldUid && oldUid !== uid) batch.delete(doc(db, "accounts", oldUid));
  await batch.commit();
  return { uid, pw, email };
}

// ---- 비밀번호 변경
export async function changePassword(ctx, current, next) {
  if (next.length < 8) throw Object.assign(new Error("새 비밀번호는 8자 이상이어야 합니다."), { code: "weak" });
  const cred = EmailAuthProvider.credential(ctx.user.email, current);
  await reauthenticateWithCredential(ctx.user, cred);
  await updatePassword(ctx.user, next);
  if (ctx.account.key) {
    const col = ctx.isStaff ? "staff" : "students";
    await updateDoc(doc(db, col, ctx.account.key), { mustChangePw: false, initialPw: deleteField(), pwChangedAt: serverTimestamp() });
    if (ctx.profile) { ctx.profile.mustChangePw = false; delete ctx.profile.initialPw; }
  }
}

function pwModalHtml(forced) {
  return `<div class="modal-bg" id="pwModal"><div class="modal" style="max-width:420px">
    <div class="modal-head"><h2>${forced ? "처음 로그인 · 비밀번호 변경" : "비밀번호 변경"}</h2>${forced ? "" : '<button type="button" id="pwClose">닫기</button>'}</div>
    ${forced ? '<p class="muted">받은 초기 비밀번호를 본인만 아는 비밀번호로 바꿔 주세요.</p>' : ""}
    <form id="pwForm">
      <div class="field"><label>현재 비밀번호</label><input type="password" id="pwCur" autocomplete="current-password" required></div>
      <div class="field"><label>새 비밀번호 (8자 이상)</label><input type="password" id="pwNew" autocomplete="new-password" minlength="8" required></div>
      <div class="field"><label>새 비밀번호 확인</label><input type="password" id="pwNew2" autocomplete="new-password" minlength="8" required></div>
      <button class="btn-primary" style="width:100%;justify-content:center">변경</button>
    </form></div></div>`;
}
export function openPasswordModal(ctx, forced = false) {
  return new Promise((resolve) => {
    document.body.insertAdjacentHTML("beforeend", pwModalHtml(forced));
    const m = document.getElementById("pwModal");
    const close = () => { m.remove(); resolve(); };
    m.querySelector("#pwClose")?.addEventListener("click", close);
    m.querySelector("#pwForm").onsubmit = async (e) => {
      e.preventDefault();
      const cur = m.querySelector("#pwCur").value, n1 = m.querySelector("#pwNew").value, n2 = m.querySelector("#pwNew2").value;
      if (n1 !== n2) return toast("새 비밀번호가 서로 다릅니다.", "error");
      if (n1 === cur) return toast("현재 비밀번호와 다른 비밀번호를 쓰세요.", "error");
      const btn = m.querySelector("button.btn-primary"); btn.disabled = true;
      try { await changePassword(ctx, cur, n1); toast("비밀번호를 바꿨습니다."); close(); }
      catch (err) { showError(err, "비밀번호 변경"); btn.disabled = false; }
    };
  });
}
const forcePasswordChange = (ctx) => openPasswordModal(ctx, true);

// ---- 상단 바 계정 메뉴
export function mountAccountMenu(ctx, el) {
  const name = ctx.profile?.name || ctx.user.email;
  el.innerHTML = `<span class="muted">${esc(name)}${ctx.isAdmin ? ' <span class="badge badge-red">관리자</span>' : ""}</span>
    <button class="btn-sm" id="acctPw">비밀번호</button><button class="btn-sm" id="acctOut">로그아웃</button>`;
  el.querySelector("#acctOut").onclick = logout;
  const pwBtn = el.querySelector("#acctPw");
  if (ctx.account.bootstrap) pwBtn.hidden = true; // 관리자 이메일 계정은 Firebase 콘솔에서 관리
  pwBtn.onclick = () => openPasswordModal(ctx);
}

// ================= UI 도우미 =================
export function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
export function $(sel, root = document) { return root.querySelector(sel); }
export function $$(sel, root = document) { return [...root.querySelectorAll(sel)]; }

function toastBox() {
  let box = document.getElementById("toast-box");
  if (!box) { box = document.createElement("div"); box.id = "toast-box"; document.body.appendChild(box); }
  return box;
}
export function toast(msg, type = "ok", ms = 3000) {
  const t = document.createElement("div");
  t.className = `toast toast-${type}`;
  t.textContent = msg;
  toastBox().appendChild(t);
  setTimeout(() => t.remove(), ms);
}

const ERR_KO = {
  "auth/invalid-credential": "아이디 또는 비밀번호가 맞지 않습니다.",
  "auth/wrong-password": "비밀번호가 맞지 않습니다.",
  "auth/user-not-found": "등록되지 않은 아이디입니다.",
  "auth/email-already-in-use": "이미 존재하는 로그인 ID입니다.",
  "auth/weak-password": "비밀번호는 6자 이상이어야 합니다.",
  "auth/too-many-requests": "시도가 너무 많습니다. 잠시 후 다시 시도하세요.",
  "auth/network-request-failed": "네트워크 연결을 확인하세요.",
  "auth/requires-recent-login": "보안을 위해 다시 로그인한 뒤 시도하세요.",
  "permission-denied": "권한이 없습니다.",
  "unavailable": "서버에 연결할 수 없습니다. 인터넷 연결을 확인하세요."
};
// 실패를 조용히 넘기지 않기: 모든 오류는 화면에 표시하고 콘솔에도 남긴다.
export function showError(e, where = "") {
  console.error(where, e);
  const msg = ERR_KO[e?.code] || e?.message || String(e);
  toast(`${where ? where + " 실패: " : ""}${msg}`, "error", 7000);
}

export async function copyText(text, msg = "클립보드에 복사했습니다.") {
  try {
    await navigator.clipboard.writeText(text);
  } catch (_) {
    const ta = document.createElement("textarea");
    ta.value = text; document.body.appendChild(ta); ta.select();
    document.execCommand("copy"); ta.remove();
  }
  toast(msg);
}

export function toDate(v) {
  if (!v) return null;
  if (v.toDate) return v.toDate();
  if (typeof v === "string") { const m = v.match(/(\d{4})\D+(\d{1,2})\D+(\d{1,2})/); if (m) return new Date(+m[1], +m[2] - 1, +m[3]); }
  const d = new Date(v); return isNaN(d) ? null : d;
}
export function fmtDate(ts) {
  const d = toDate(ts); if (!d) return "-";
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getMonth() + 1}/${d.getDate()} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
export function fmtDay(v) {
  const d = toDate(v); if (!d) return "-";
  const w = "일월화수목금토"[d.getDay()];
  return `${d.getMonth() + 1}/${d.getDate()}(${w})`;
}
export function isoDay(v = new Date()) {
  const d = toDate(v); if (!d) return "";
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
export function dday(v) {
  const d = toDate(v); if (!d) return null;
  const t = new Date(); t.setHours(0, 0, 0, 0);
  const x = new Date(d); x.setHours(0, 0, 0, 0);
  return Math.round((x - t) / 86400000);
}
export function ddayBadge(v) {
  const n = dday(v); if (n == null) return "";
  if (n < 0) return `<span class="badge badge-gray">종료</span>`;
  const cls = n <= 7 ? "red" : n <= 21 ? "orange" : "blue";
  return `<span class="badge badge-${cls}">${n === 0 ? "D-DAY" : "D-" + n}</span>`;
}
// 학생의 다음 면접일 (지원 대학 면접일·최초 면접일 중 오늘 이후 가장 가까운 날)
export function nextInterview(st) {
  // 대학별 면접일이 있으면 그것만, 없을 때만 최초 면접일을 쓴다
  const list = (st.universities || []).map((u) => u.date).filter(Boolean);
  const dates = (list.length ? list : [st.firstInterview]).map(toDate).filter(Boolean);
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const up = dates.filter((d) => d >= today).sort((a, b) => a - b);
  return up[0] || null;
}
export function fmtSec(s) {
  const neg = s < 0; s = Math.abs(Math.round(s));
  return `${neg ? "+" : ""}${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}
export function typeBadge(type) {
  const t = TYPES[type] || { label: type, color: "gray" };
  return `<span class="badge badge-${t.color}">${esc(t.label)}</span>`;
}
export function randomPw(n = 8) {
  const chars = "abcdefghjkmnpqrstuvwxyz23456789";
  let s = ""; const arr = crypto.getRandomValues(new Uint32Array(n));
  for (const v of arr) s += chars[v % chars.length];
  return s;
}
export function shuffle(a) {
  a = [...a];
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}
// 학생 한 명의 대학별 면접일 (interviews 컬렉션) → 날짜순
export async function loadInterviewsFor(studentNo) {
  const snap = await getDocs(query(collection(db, "interviews"), where("studentNo", "==", String(studentNo))));
  return snap.docs.map((d) => ({ id: d.id, ...d.data() })).sort((a, b) => (a.date || "9999").localeCompare(b.date || "9999"));
}

// 학생 트랙 → 추천 연습 모드
export function recommendedModes(st) {
  const t = st.track || "", sp = st.special || "";
  const out = [];
  if (t.includes("학생부")) out.push("personal", "document");
  if (t.includes("인성") || t.includes("담임")) out.push("personality");
  if (sp.includes("제시문")) out.push("passage");
  if (sp.includes("MMI")) out.push("personality");
  if (!out.length) out.push("document", "personality");
  return [...new Set(out)];
}

// JSON 붙여넣기 파서: 코드블록(```json)이나 앞뒤 설명이 섞여 있어도 배열/객체만 뽑아낸다.
export function parseLooseJSON(text) {
  let t = String(text).trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) t = fence[1].trim();
  const start = t.search(/[\[{]/);
  if (start < 0) throw new Error("JSON을 찾을 수 없습니다.");
  const open = t[start], close = open === "[" ? "]" : "}";
  const end = t.lastIndexOf(close);
  if (end < start) throw new Error("JSON 끝 괄호가 없습니다.");
  return JSON.parse(t.slice(start, end + 1));
}
