import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getAuth, onAuthStateChanged, signInWithEmailAndPassword, signOut, createUserWithEmailAndPassword,
  connectAuthEmulator, EmailAuthProvider, reauthenticateWithCredential, updatePassword,
  setPersistence, browserSessionPersistence, browserLocalPersistence, inMemoryPersistence
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  getFirestore, connectFirestoreEmulator, collection, doc, getDoc, getDocs,
  setDoc as fsSetDoc, addDoc as fsAddDoc, updateDoc as fsUpdateDoc, deleteDoc as fsDeleteDoc, writeBatch as fsWriteBatch,
  query, where, serverTimestamp, deleteField, runTransaction, onSnapshot
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { firebaseConfig, ADMIN_EMAILS, LOGIN_EMAIL_DOMAIN } from "./firebase-config.js";

export {
  collection, doc, getDoc, getDocs,
  query, where, serverTimestamp, deleteField, signOut, signInWithEmailAndPassword, runTransaction, onSnapshot
};

// ---- 에뮬레이터(로컬 테스트) 스위치: 주소 뒤에 ?emu=1 을 한 번 붙이면 켜지고 ?emu=0 이면 꺼짐
const params = new URLSearchParams(location.search);
try {
  if (params.get("emu") === "1") localStorage.setItem("useEmulator", "1");
  if (params.get("emu") === "0") localStorage.removeItem("useEmulator");
} catch (_) {}
let USE_EMU = false;
try { USE_EMU = localStorage.getItem("useEmulator") === "1"; } catch (_) {}

// firebase-config.js 에 설정값을 안 넣었으면 화면에 바로 알림
export const CONFIG_MISSING = !firebaseConfig.apiKey || /^YOUR_/.test(firebaseConfig.apiKey) || /^YOUR_/.test(firebaseConfig.projectId || "");
if (CONFIG_MISSING) {
  const show = () => document.body.insertAdjacentHTML("afterbegin",
    `<div style="position:fixed;top:0;left:0;right:0;z-index:999;background:#d33a3a;color:#fff;padding:12px 16px;font-weight:600;line-height:1.5">
      firebase-config.js 에 Firebase 설정값이 아직 없습니다 (apiKey: "YOUR_API_KEY"). GitHub에서 firebase-config.js 를 열어 Firebase 콘솔의 firebaseConfig 값으로 바꿔 주세요.</div>`);
  document.body ? show() : addEventListener("DOMContentLoaded", show);
}
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
// 학생 트랙 → 대면 모의면접 기본 유형
export function defaultMeetingType(st) {
  if (!st) return "학생부 기반";
  if (st.special?.includes("제시문")) return "제시문";
  if (st.track?.includes("인성") && !st.track.includes("학생부")) return "기본 인성";
  if (st.track === "담임 기본지도") return "담임 기본지도";
  return "학생부 기반";
}
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

// ---- 로그인 유지 방식
// 기본: 브라우저(창)를 닫으면 로그아웃 + 60분 동안 아무 조작이 없으면 자동 로그아웃 (학교 공용 PC 대비)
// '이 기기에서 로그인 유지'를 체크한 경우만 브라우저를 닫아도 유지
const KEEP_KEY = "keepLogin";
const IDLE_MIN = 60;
export function keepLoginOn() { try { return localStorage.getItem(KEEP_KEY) === "1"; } catch (_) { return false; } }
export async function signIn(email, pw, keep = false) {
  try { keep ? localStorage.setItem(KEEP_KEY, "1") : localStorage.removeItem(KEEP_KEY); } catch (_) {}
  try {
    await setPersistence(auth, keep ? browserLocalPersistence : browserSessionPersistence);
  } catch (e) {   // 브라우저가 이 사이트의 저장소를 막은 경우(쿠키·사이트 데이터 차단)에도 로그인은 되게
    console.warn("persistence", e);
    try { await setPersistence(auth, inMemoryPersistence); } catch (_) {}
    toast("이 브라우저가 사이트 데이터를 막고 있어, 창을 닫으면 로그아웃됩니다.", "error", 7000);
  }
  return signInWithEmailAndPassword(auth, email, pw);
}
function startIdleLogout() {
  if (keepLoginOn()) return;
  let last = Date.now();
  const bump = () => { last = Date.now(); };
  ["pointerdown", "keydown", "scroll", "touchstart", "mousemove"].forEach((ev) => window.addEventListener(ev, bump, { passive: true }));
  setInterval(() => { if (Date.now() - last > IDLE_MIN * 60000) logout("idle"); }, 30000);
}
// 로그인 이메일 → 화면에 보일 이름 (s3107@… → 학번 3107)
export function loginLabel(email) {
  const m = String(email || "").match(/^([st])([^@.]+)(?:\.v\d+)?@/);
  if (!m || !String(email).endsWith("@" + LOGIN_EMAIL_DOMAIN)) return email || "";
  return m[1] === "s" ? `학번 ${m[2]}` : `교사 ID ${m[2]}`;
}

// 로그인 ID → 실제 이메일 (비밀번호 재발급으로 바뀐 경우 logins 문서에 기록됨)
export async function resolveLoginEmail(kind, id) {
  if (kind !== "student" && id.includes("@")) return id.trim();
  try {
    const snap = await getDoc(doc(db, "logins", loginDocId(kind, id)));
    if (snap.exists() && snap.data().email) return snap.data().email;
  } catch (e) { console.warn("login lookup", e); }
  return defaultEmail(kind, id);
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
        let account = null;
        const a = await getDoc(doc(db, "accounts", user.uid));
        if (a.exists()) account = a.data();
        else if (isAdminEmail(user.email)) account = { role: "admin", key: null, bootstrap: true };
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
        const isStaff = account.role === "admin" || account.role === "teacher";
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
        startIdleLogout();
        resolve(ctx);
      } catch (e) { showError(e, "로그인 정보 확인"); }
    });
  });
}

export async function logout(reason = "out") {
  try { await signOut(auth); } catch (e) { console.warn("signOut", e); }
  clearDataCache();
  try { sessionStorage.clear(); localStorage.removeItem(KEEP_KEY); localStorage.removeItem("myStaffName"); } catch (_) {}
  location.replace(`index.html?${reason === "idle" ? "idle" : "out"}=1`);
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
  el.querySelector("#acctOut").onclick = () => logout();
  const pwBtn = el.querySelector("#acctPw");
  if (ctx.account.bootstrap) pwBtn.hidden = true; // 관리자 이메일 계정은 Firebase 콘솔에서 관리
  pwBtn.onclick = () => openPasswordModal(ctx);
}

// ================= 읽기 줄이기: 변경 표시 + 브라우저 캐시 =================
// Firebase 무료 요금제는 하루 읽기 5만 건. 자주 안 바뀌는 목록(학생·교사·면접일·대면 기록·질문은행·교사 불가 시간)은
// 브라우저에 저장해 두고, meta/versions 문서 1건만 읽어 바뀐 목록만 서버에서 다시 받는다.
// 이 목록에 쓰는 코드는 모두 아래 setDoc/updateDoc/addDoc/deleteDoc/writeBatch 를 거치므로 자동으로 '바뀜'이 표시된다.
// (Apps Script 가 시트 내용을 앱에 쓸 때도 같은 표시를 남긴다)
export const CACHED = ["students", "staff", "interviews", "meetings", "questions", "availability"];
// 자주 바뀌는 목록은 바뀐 문서만 받아 합친다 (이 필드에 수정 시각(ms)을 항상 기록)
const INCREMENTAL = { meetings: "updatedAtMs", interviews: "updatedAt" };
const CLOCK_SLACK = 15 * 60 * 1000;   // 기기 시계 차이 대비 여유
const PUBLIC_CACHE = ["questions", "availability"];   // 개인정보 아님 → 기기에 오래 보관
const CACHE_PREFIX = "c1:";
const CACHE_TTL = 12 * 3600 * 1000;
let metaPromise = null;
const pendingBump = new Set();
let bumpTimer = null;

function topCollection(path) { return String(path || "").split("/")[0]; }
const pendingDeleted = {};
function flushBumps() {
  if (!pendingBump.size) return;
  const now = Date.now();
  const patch = {};
  pendingBump.forEach((c) => { patch[c] = now; });
  pendingBump.clear();
  if (Object.keys(pendingDeleted).length) { patch.deleted = { ...pendingDeleted }; for (const k in pendingDeleted) delete pendingDeleted[k]; }
  fsSetDoc(doc(db, "meta", "versions"), patch, { merge: true }).catch((e) => {
    if (e?.code !== "permission-denied") console.warn("meta bump", e);   // 학생 계정은 표시 권한 없음 (영향 없음)
  });
}
function markChanged(path, deleted = false) {
  const c = topCollection(path);
  if (!CACHED.includes(c)) return;
  const parts = String(path).split("/");
  if (deleted && parts.length === 2 && INCREMENTAL[c]) (pendingDeleted[c] ||= {})[parts[1]] = Date.now();
  dropCache(c);
  metaPromise = null;
  pendingBump.add(c);
  clearTimeout(bumpTimer);
  bumpTimer = setTimeout(flushBumps, 400);
}
addEventListener("pagehide", flushBumps);

// 증분 목록(대면 기록·면접일)에 쓸 때 수정 시각을 빠뜨리지 않게 자동으로 넣는다
function stamp(path, data) {
  const c = topCollection(path), f = INCREMENTAL[c];
  if (!f || String(path).split("/").length !== 2 || !data || typeof data !== "object" || Array.isArray(data)) return data;
  return f in data ? data : { ...data, [f]: Date.now() };
}
export async function setDoc(ref, data, opts) { const r = await fsSetDoc(ref, stamp(ref.path, data), opts); markChanged(ref.path); return r; }
export async function updateDoc(ref, data) { const r = await fsUpdateDoc(ref, stamp(ref.path, data)); markChanged(ref.path); return r; }
export async function addDoc(col, data) { const r = await fsAddDoc(col, stamp(col.path + "/x", data)); markChanged(r.path); return r; }
export async function deleteDoc(ref) { const r = await fsDeleteDoc(ref); markChanged(ref.path, true); return r; }
export function writeBatch(d) {
  const b = fsWriteBatch(d), ops = [];
  return {
    set(ref, data, opts) { ops.push([ref.path, false]); b.set(ref, stamp(ref.path, data), opts); return this; },
    update(ref, data) { ops.push([ref.path, false]); b.update(ref, stamp(ref.path, data)); return this; },
    delete(ref) { ops.push([ref.path, true]); b.delete(ref); return this; },
    async commit() { const r = await b.commit(); ops.forEach(([p, del]) => markChanged(p, del)); return r; }
  };
}

function cacheStore(name) {
  try { return PUBLIC_CACHE.includes(name) || keepLoginOn() ? localStorage : sessionStorage; } catch (_) { return null; }
}
function cacheKey(name) { return `${CACHE_PREFIX}${auth.currentUser?.uid || "-"}:${name}`; }
function dropCache(name) {
  try { localStorage.removeItem(cacheKey(name)); sessionStorage.removeItem(cacheKey(name)); } catch (_) {}
}
export function clearDataCache(publicToo = false) {
  for (const st of [localStorage, sessionStorage]) {
    try {
      Object.keys(st).filter((k) => k.startsWith(CACHE_PREFIX)).forEach((k) => {
        if (publicToo || !PUBLIC_CACHE.some((n) => k.endsWith(":" + n))) st.removeItem(k);
      });
    } catch (_) {}
  }
}
// Firestore 날짜(Timestamp)를 저장했다가 되살림
function reviveTs(v) {
  if (Array.isArray(v)) return v.map(reviveTs);
  if (v && typeof v === "object") {
    if (typeof v.seconds === "number" && typeof v.nanoseconds === "number") {
      const ms = v.seconds * 1000 + Math.floor(v.nanoseconds / 1e6);
      return { seconds: v.seconds, nanoseconds: v.nanoseconds, toDate: () => new Date(ms), toMillis: () => ms };
    }
    const o = {}; for (const k in v) o[k] = reviveTs(v[k]); return o;
  }
  return v;
}
export function getMetaVersions(force = false) {
  if (!metaPromise || force) {
    metaPromise = getDoc(doc(db, "meta", "versions")).then((s) => (s.exists() ? s.data() : {})).catch(() => null);
  }
  return metaPromise;
}
export const readStats = { server: {}, cache: {} };
/** 목록 전체를 캐시 우선으로 읽기. force: 서버에서 다시 받기 */
export async function cachedCollection(name, { force = false } = {}) {
  const meta = await getMetaVersions();
  // 앱에서 바뀐 표시(name) + 시트 동기화가 바꾼 표시(s_name). null = 표시 문서를 못 읽음(규칙 미반영) → 캐시 안 씀
  const ver = meta ? `${meta[name] || 0}:${meta["s_" + name] || 0}` : null;
  const store = cacheStore(name), key = cacheKey(name);
  const save = (rows, at) => {
    if (ver === null || !store) return;
    try { store.setItem(key, JSON.stringify({ v: ver, at, rows })); }
    catch (_) { try { store.removeItem(key); } catch (__) {} }   // 저장 공간 부족 → 캐시 없이 사용
  };
  let c = null;
  if (!force && ver !== null && store) {
    try { c = JSON.parse(store.getItem(key) || "null"); } catch (_) { c = null; }
    if (c && Date.now() - c.at >= CACHE_TTL) c = null;
    if (c && c.v === ver) { readStats.cache[name] = c.rows.length; return reviveTs(c.rows); }
    // 바뀐 문서만 받아 합치기
    const f = INCREMENTAL[name];
    if (c && f && Array.isArray(c.rows)) {
      const since = Math.max(0, ...c.rows.map((r) => Number(r[f]) || 0)) - CLOCK_SLACK;
      const snap = await getDocs(query(collection(db, name), where(f, ">", since)));
      const byId = new Map(c.rows.map((r) => [r.id, r]));
      snap.docs.forEach((d) => byId.set(d.id, { id: d.id, ...d.data() }));
      const gone = (meta.deleted || {})[name] || {};
      Object.entries(gone).forEach(([id, ms]) => { if (ms >= c.at - CLOCK_SLACK) byId.delete(id); });
      const rows = [...byId.values()];
      readStats.server[name] = snap.size;
      save(JSON.parse(JSON.stringify(rows)), c.at);
      return reviveTs(JSON.parse(JSON.stringify(rows)));
    }
  }
  const snap = await getDocs(collection(db, name));
  const rows = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
  readStats.server[name] = rows.length;
  save(rows, Date.now());
  return rows;
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
  "auth/invalid-api-key": "firebase-config.js 의 apiKey 가 올바르지 않습니다. Firebase 설정값을 다시 붙여넣으세요.",
  "auth/api-key-not-valid.-please-pass-a-valid-api-key.": "firebase-config.js 의 apiKey 가 올바르지 않습니다. Firebase 설정값을 다시 붙여넣으세요.",
  "auth/operation-not-allowed": "Firebase Authentication 에서 '이메일/비밀번호' 로그인이 꺼져 있습니다.",
  "auth/configuration-not-found": "Firebase Authentication 이 아직 시작되지 않았습니다 (콘솔 → Authentication → 시작하기).",
  "auth/invalid-email": "로그인 ID 형식이 맞지 않습니다.",
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

// AI 답변 붙여넣기 파서: 코드블록·앞뒤 설명·요청문이 섞여 있어도 질문 목록(JSON)만 뽑아낸다.
// 여러 후보가 있으면 항목이 가장 많은 배열(보통 Claude 답변)을 고른다.
export function parseLooseJSON(text) {
  const t = String(text || "").replace(/[\u201C\u201D]/g, '"').trim();
  if (!t) throw new Error("붙여넣은 내용이 없습니다. Claude 답변을 복사해 붙여넣으세요.");
  const found = [];
  const blocks = [...t.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)].map((m) => m[1]);
  for (const src of [...blocks, t]) {
    for (let i = 0; i < src.length; i++) {
      const ch = src[i];
      if (ch !== "[" && ch !== "{") continue;
      const end = matchBracket(src, i);
      if (end < 0) continue;
      try {
        const v = JSON.parse(src.slice(i, end + 1));
        const arr = Array.isArray(v) ? v : [v];
        const real = arr.filter((q) => q && typeof q === "object" && typeof q.text === "string" && q.text.trim() && q.text.trim() !== "질문");
        if (real.length) found.push({ v, n: real.length, at: i });
        i = end;  // 이 덩어리 안쪽은 다시 보지 않음
      } catch (_) { /* 이 위치는 JSON이 아님 → 다음 괄호 */ }
    }
    if (found.length) break;
  }
  if (found.length) return found.sort((a, b) => b.n - a.n || b.at - a.at)[0].v;
  if (/\[작성 원칙\]|\[출력 형식\]|너는 대한민국 대학/.test(t))
    throw new Error("Claude에게 보낼 '요청문'을 붙여넣으셨어요. 요청문은 Claude 채팅에 보내고, Claude가 답한 내용을 복사해 여기에 붙여넣으세요.");
  throw new Error("Claude 답변에서 질문 목록을 찾지 못했습니다. 답변 전체를 복사했는지 확인하세요. (답변이 중간에 끊겼다면 Claude에게 '이어서 JSON만 다시 출력해 줘'라고 요청)");
}
function matchBracket(s, i) {
  const stack = []; let inStr = false, esc = false;
  for (let j = i; j < s.length; j++) {
    const c = s[j];
    if (inStr) { if (esc) esc = false; else if (c === "\\") esc = true; else if (c === '"') inStr = false; continue; }
    if (c === '"') inStr = true;
    else if (c === "[" || c === "{") stack.push(c);
    else if (c === "]" || c === "}") {
      const o = stack.pop();
      if ((c === "]" && o !== "[") || (c === "}" && o !== "{")) return -1;
      if (!stack.length) return j;
    }
  }
  return -1;
}
