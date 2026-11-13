// 지도 일지 — 지도 날짜·시간 자동 배정 (순수 JS, 화면·Firebase 없음 → Node 시험에서도 그대로)
// 시트판 Scheduler.js(2026-11-12 인계)를 옮김. 바꾼 것 (사용자 결정 2026-11-12):
//  - 실제 면접 기록(예약·대면 기록)은 쓰지 않는다 → 고정 행 없음
//  - 같은 조건이면 '이른 날짜' 대신 무작위 (seed 로 다시 돌려도 같은 결과)
//  - 한 선생님의 30분 지도(2·3차)는 되도록 앞뒤로 붙인다 → 지도 일지 한 장 = 1시간에 두 명
// 담당교사는 절대 바꾸지 않고 '언제'만 정한다. 시간이 없으면 그 차수는 미배정으로 남기고 이유를 적는다.

const DAY_MS = 86400000;
export function toDayNum(s) {            // 'YYYY-MM-DD' → 일련 일수 (UTC 기준이라 하루 밀림 없음)
  if (s == null || s === "") return null;
  const m = String(s).match(/(\d{4})\D+(\d{1,2})\D+(\d{1,2})/);
  return m ? Math.round(Date.UTC(+m[1], +m[2] - 1, +m[3]) / DAY_MS) : null;
}
export function dayToStr(d) {
  const dt = new Date(d * DAY_MS);
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, "0")}-${String(dt.getUTCDate()).padStart(2, "0")}`;
}
export const weekday = (d) => new Date(d * DAY_MS).getUTCDay();   // 0=일 … 6=토
export const isWeekend = (d) => { const w = weekday(d); return w === 0 || w === 6; };
export const mondayOf = (d) => d - ((weekday(d) + 6) % 7);
export function toMin(t) {
  if (t == null || t === "") return null;
  const m = String(t).match(/(\d{1,2}):(\d{2})/);
  return m ? +m[1] * 60 + +m[2] : null;
}
export const minToStr = (x) => `${String(Math.floor(x / 60)).padStart(2, "0")}:${String(x % 60).padStart(2, "0")}`;

// ---------- 허용 시간대 (운영 계획: 평일 방과후·야자, 주말 09:00~16:30) ----------
export const WEEKDAY_30 = [990, 1020, 1050, 1140, 1170, 1200, 1230, 1260];   // 16:30 17:00 17:30 | 19:00 … 21:00 시작 (18:00~19:00 없음)
export const WEEKEND_30 = []; for (let s = 540; s <= 960; s += 30) WEEKEND_30.push(s);   // 09:00 ~ 16:00 시작
export function starts(dur, weekend) {
  const base = weekend ? WEEKEND_30 : WEEKDAY_30;
  return dur === 30 ? base : base.filter((x) => base.includes(x + 30));   // 60분 = 이어진 두 칸 (17:30-18:30 같은 공백 걸침 안 됨)
}
export const ROUND_MIN = { "1차": 60, "2차": 30, "3차": 30 };

// 같은 seed → 같은 결과 (mulberry32)
export function rng(seed) {
  let a = (Number(seed) >>> 0) || 1;
  return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

const validT = (x) => !!x && x !== "미정" && x !== "-";

/**
 * input = {
 *   students: [{ id, name, interview:'YYYY-MM-DD'|'', priority, special, early:'YYYY-MM-DD'|'', t1, t2, t3a, t3b, order }],
 *   unavail:  [{ teacher, from, to, start, end }]      // start·end 가 없으면 종일
 *   config:   { periodStart, periodEnd, earlyStart, excluded:[], weeklyMax, dailyMax, prepDays, prepDaysSpecial, seed, improvePasses? }
 * }
 * early: 그 날짜 '전'에 담임 1차 1회 (원본 비고 '9/16 전 담임 1회'). 2·3차는 그 날짜 '뒤'
 */
export function run(input) {
  const cfg = { weeklyMax: 3, dailyMax: 2, prepDays: 14, prepDaysSpecial: 21, ...input.config };
  const W = { weekOver: 25, dayOver: 20, prep: 1, weekend: 8, late: 0.5, pair: 30, rand: 6, ...(cfg.weights || {}) };
  const rand = rng(cfg.seed || 1);
  const P0 = toDayNum(cfg.periodStart), P1 = toDayNum(cfg.periodEnd);
  const E0 = toDayNum(cfg.earlyStart) ?? P0;
  const excluded = {};
  (cfg.excluded || []).forEach((x) => { const d = toDayNum(x); if (d != null) excluded[d] = true; });

  // 불가시간 색인: teacher → day → [[s,e]]
  const un = {};
  (input.unavail || []).forEach((u) => {
    const a = toDayNum(u.from); if (a == null || !u.teacher) return;
    let b = toDayNum(u.to); if (b == null || b < a) b = a;
    let s = toMin(u.start), e = toMin(u.end);
    if (s == null || e == null || e <= s) { s = 0; e = 1440; }      // 시간 없음 = 종일 불가
    for (let d = a; d <= b; d++) ((un[u.teacher] ||= {})[d] ||= []).push([s, e]);
  });
  const teacherFree = (t, d, s, e) => !(un[t]?.[d] || []).some((x) => s < x[1] && e > x[0]);

  const busyT = {}, busyS = {}, weekCnt = {}, dayCnt = {}, halves = {};   // halves: 선생님·날짜별 30분 지도 [[s,e]]
  const overlaps = (list, s, e) => (list || []).some((x) => s < x[1] && e > x[0]);
  // 주·일 횟수 = '학교에 남는 번'. 이어지는 30분 두 개(지도 일지 한 장)는 한 번으로 센다
  function visits(l) {
    const a = (l || []).slice().sort((x, y) => x[0] - y[0]);
    let n = 0;
    for (let i = 0; i < a.length; i++) {
      n++;
      if (a[i][1] - a[i][0] === 30 && a[i + 1] && a[i + 1][0] === a[i][1] && a[i + 1][1] - a[i + 1][0] === 30) i++;
    }
    return n;
  }
  function recount(t, d) {
    const n = visits(busyT[t][d]), old = dayCnt[t]?.[d] || 0, w = mondayOf(d);
    (dayCnt[t] ||= {})[d] = n;
    (weekCnt[t] ||= {})[w] = (weekCnt[t][w] || 0) + n - old;
  }
  function occupy(tk, d, s, e) {
    tk.teachers.forEach((t) => {
      ((busyT[t] ||= {})[d] ||= []).push([s, e]);
      if (tk.dur === 30) ((halves[t] ||= {})[d] ||= []).push([s, e]);
      recount(t, d);
    });
    ((busyS[tk.sid] ||= {})[d] ||= []).push([s, e]);
  }
  const drop = (l, s, e) => { const i = (l || []).findIndex((x) => x[0] === s && x[1] === e); if (i >= 0) l.splice(i, 1); };
  function unoccupy(tk) {
    tk.teachers.forEach((t) => {
      drop(busyT[t][tk.day], tk.s, tk.e);
      if (tk.dur === 30) drop(halves[t][tk.day], tk.s, tk.e);
      recount(t, tk.day);
    });
    drop(busyS[tk.sid][tk.day], tk.s, tk.e);
  }

  const students = input.students.map((st) => ({ ...st }));
  // ---------- 학생별 지도 과제 ----------
  const tasks = [], badSource = [];
  students.forEach((st) => {
    const iv = toDayNum(st.interview);
    const early = toDayNum(st.early);
    const prep = /제시문|MMI/.test(st.special || "") ? cfg.prepDaysSpecial : cfg.prepDays;
    const list = [];
    if (validT(st.t1)) list.push({ round: "1차", teachers: [st.t1], dur: 60 });
    if (validT(st.t2)) list.push({ round: "2차", teachers: [st.t2], dur: 30 });
    if (validT(st.t3a) && validT(st.t3b)) {
      if (st.t3a === st.t3b) badSource.push({ studentNo: st.id, studentName: st.name, round: "3차", teachers: st.t3a, reason: "3차 1위원·2위원이 같은 선생님(원본 배정 확인)" });
      else list.push({ round: "3차", teachers: [st.t3a, st.t3b], dur: 30 });
    }
    list.forEach((tk, i) => {
      Object.assign(tk, { sid: st.id, student: st, seq: i });
      if (early != null && tk.round === "1차") {            // 면접 전 담임 1회
        Object.assign(tk, { lo: E0, hi: early - 1, prepStart: E0, rule: "면접 전 담임 1회" });
      } else if (early != null) {                           // 첫 면접 이후 후속 지도
        const lo = Math.max(P0, early + 1);   // 다음 면접 전날까지 (면접일이 그보다 앞이면 = 이미 본 첫 면접 → 기간 끝까지)
        Object.assign(tk, { lo, hi: iv != null && iv - 1 >= lo ? Math.min(P1, iv - 1) : P1, prepStart: lo, lateFrom: lo, rule: "첫 면접 이후" });
      } else {
        Object.assign(tk, { lo: P0, hi: iv != null ? Math.min(P1, iv - 1) : P1, prepStart: iv != null ? Math.max(P0, iv - prep) : P0, rule: "" });
      }
      tasks.push(tk);
    });
    st.tasks = list;
  });

  // ---------- 처리 순서: 긴급 → 면접일 빠른 순 → 1순위 → 2순위 ----------
  const prRank = { "긴급": 0, "1순위": 1, "2순위": 2 };
  students.sort((a, b) => {
    const ua = a.priority === "긴급" ? 0 : 1, ub = b.priority === "긴급" ? 0 : 1;
    if (ua !== ub) return ua - ub;
    const ia = toDayNum(a.interview) ?? 1e9, ib = toDayNum(b.interview) ?? 1e9;
    if (ia !== ib) return ia - ib;
    const ra = prRank[a.priority] ?? 9, rb = prRank[b.priority] ?? 9;
    return ra - rb || (a.order || 0) - (b.order || 0);
  });

  // ---------- 후보와 비용 ----------
  function hardOk(tk, d, s, e) {
    if (excluded[d]) return false;
    for (const t of tk.teachers) if (!teacherFree(t, d, s, e) || overlaps(busyT[t]?.[d], s, e)) return false;
    return !overlaps(busyS[tk.sid]?.[d], s, e);
  }
  // 30분 지도가 같은 선생님의 짝 없는 30분 지도와 바로 이어지면 → 지도 일지 한 장(1시간), 학교에 한 번 더 남는 것도 아님
  function pairsWith(t, d, s, e) {
    const l = halves[t]?.[d] || [];
    return l.some((x) => (x[1] === s || x[0] === e) && !l.some((y) => y !== x && (y[1] === x[0] || y[0] === x[1])));
  }
  function cost(tk, d, s, e) {
    let c = 0;
    tk.teachers.forEach((t) => {
      if (tk.dur === 30 && pairsWith(t, d, s, e)) { c -= W.pair; return; }   // 주·일 횟수에 더하지 않음 (같은 자리 이어서)
      const wk = weekCnt[t]?.[mondayOf(d)] || 0, dc = dayCnt[t]?.[d] || 0;
      if (wk >= cfg.weeklyMax) { const o = wk - cfg.weeklyMax + 1; c += W.weekOver * o * o; }   // 주 권장 횟수 초과
      if (dc >= cfg.dailyMax) c += W.dayOver * (dc - cfg.dailyMax + 1);
      c += wk;                                                         // 주 안에서도 고르게
    });
    if (d < tk.prepStart) c += W.prep * (tk.prepStart - d);             // 준비기간(D-14/21)보다 이르면
    if (tk.lateFrom !== undefined) c += W.late * (d - tk.lateFrom);
    if (isWeekend(d)) c += W.weekend;                                   // 평일 방과후 우선
    if (busyS[tk.sid]?.[d]?.length) c += 40;                            // 같은 날 두 번 지도 지양
    return c + rand() * W.rand;                                         // 같은 조건이면 무작위
  }
  function candidates(tk, after, before) {
    const out = [];
    let lo = tk.lo, hi = tk.hi;
    if (after && after.day > lo) lo = after.day;
    if (before && before.day < hi) hi = before.day;
    for (let d = lo; d <= hi; d++) {
      for (const s of starts(tk.dur, isWeekend(d))) {
        const e = s + tk.dur;
        if (after && d === after.day && s < after.e) continue;
        if (before && d === before.day && e > before.s) continue;
        if (!hardOk(tk, d, s, e)) continue;
        out.push({ day: d, s, e, c: cost(tk, d, s, e) });
      }
    }
    return out.sort((a, b) => a.c - b.c);
  }

  // ---------- 미배정 이유 ----------
  function diagnose(tk, after) {
    if (tk.hi < tk.lo) return "학생 면접일 이전 가능시간 부족(지도 기간 안에 면접 전 날짜 없음 — 면접 전 담임 1회 학생이면 설정에 기준일을 넣어 주세요)";
    const freeEach = tk.teachers.map(() => false);
    let common = false, commonAfter = false;
    for (let d = tk.lo; d <= tk.hi; d++) {
      if (excluded[d]) continue;
      for (const s of starts(tk.dur, isWeekend(d))) {
        const e = s + tk.dur;
        let all = true;
        tk.teachers.forEach((t, k) => { if (teacherFree(t, d, s, e)) freeEach[k] = true; else all = false; });
        if (all) { common = true; if (!after || d > after.day || (d === after.day && s >= after.e)) commonAfter = true; }
      }
    }
    const none = tk.teachers.filter((t, k) => !freeEach[k]);
    if (none.length) return `담당교사의 모든 시간 불가(${none.join(", ")})`;
    if (!common) return tk.teachers.length > 1 ? "두 3차 교사의 공통 가능시간 없음" : "담당교사의 모든 시간 불가";
    if (!commonAfter) return "학생 면접일 이전 가능시간 부족(앞 차수 이후 남은 시간 없음)";
    return "기존 일정과 충돌(가능시간이 모두 다른 지도로 사용됨)";
  }

  // ---------- 학생 한 명의 차수를 함께 고르기 (3차부터, 2차는 3차 전, 1차는 2차 전) ----------
  function placeStudent(st) {
    const todo = st.tasks;
    const order = todo.map((t, i) => i).reverse();
    let best = null, K = 10;
    function bound(idx, chosen) {
      let after = null, before = null;
      todo.forEach((t, j) => {
        const c = chosen[j]; if (j === idx || !c) return;
        if (j < idx && (!after || c.day > after.day || (c.day === after.day && c.e > after.e))) after = { day: c.day, e: c.e };
        if (j > idx && (!before || c.day < before.day || (c.day === before.day && c.s < before.s))) before = { day: c.day, s: c.s };
      });
      return [after, before];
    }
    function dfs(k, chosen, total) {
      if (best && total >= best.total) return;
      if (k === order.length) { best = { total, chosen: chosen.slice() }; return; }
      const idx = order[k], tk = todo[idx];
      const [a, b] = bound(idx, chosen);
      const cands = candidates(tk, a, b);
      const lim = k === order.length - 1 ? 1 : K;
      let tried = 0;
      for (let i = 0; i < cands.length && tried < lim; i++) {
        const c = cands[i]; let extra = 0, clash = false;
        todo.forEach((o, j) => {
          const x = chosen[j]; if (!x || j === idx || x.day !== c.day) return;
          if (c.s < x.e && c.e > x.s) clash = true;
          extra += 40;
        });
        if (clash) continue;
        tried++;
        chosen[idx] = c;
        dfs(k + 1, chosen, total + c.c + extra);
        chosen[idx] = undefined;
      }
    }
    for (const w of [12, 40, 100000]) { if (best) break; K = w; dfs(0, [], 0); }
    if (!best) return null;
    best.chosen.forEach((c, i) => {
      if (!c) return; const tk = todo[i];
      Object.assign(tk, { day: c.day, s: c.s, e: c.e });
      occupy(tk, c.day, c.s, c.e);
    });
    return best.total;
  }

  const failed = [];
  students.forEach((st) => { if (st.tasks.length && placeStudent(st) == null) failed.push(st); });

  // 고르게 하기: 모두 넣은 뒤 한 명씩 빼고 다시 넣는다
  const passes = cfg.improvePasses ?? 2;
  for (let p = 0; p < passes; p++) {
    students.forEach((st) => {
      if (failed.includes(st)) return;
      const mov = st.tasks.filter((t) => t.day !== undefined);
      if (!mov.length) return;
      const old = mov.map((t) => ({ t, day: t.day, s: t.s, e: t.e }));
      mov.forEach(unoccupy);
      if (placeStudent(st) == null) old.forEach((o) => { Object.assign(o.t, { day: o.day, s: o.s, e: o.e }); occupy(o.t, o.day, o.s, o.e); });
    });
  }

  // 함께 못 넣은 학생: 순서를 지키며 되는 차수만, 나머지는 미배정
  const unassigned = [...badSource];
  failed.forEach((st) => {
    let last = null;
    st.tasks.forEach((tk) => {
      const c = candidates(tk, last, null)[0];
      if (c) { Object.assign(tk, { day: c.day, s: c.s, e: c.e }); occupy(tk, c.day, c.s, c.e); last = { day: c.day, e: c.e }; }
      else unassigned.push({ studentNo: st.id, studentName: st.name, round: tk.round, teachers: tk.teachers.join(" + "), reason: diagnose(tk, last) });
    });
  });

  // ---------- 결과 행 (선생님마다 한 줄, 3차는 두 줄) ----------
  const rows = [];
  tasks.forEach((tk) => {
    if (tk.day === undefined) return;
    tk.teachers.forEach((t, k) => rows.push({
      studentNo: tk.student.id, studentName: tk.student.name, teacher: t,
      date: dayToStr(tk.day), round: tk.round,
      dayType: isWeekend(tk.day) ? "주말" : "평일",
      start: minToStr(tk.s), end: minToStr(tk.e), minutes: tk.e - tk.s,
      role: tk.round === "3차" ? (k === 0 ? "1위원" : "2위원") : ""
    }));
  });
  rows.sort(rowOrder);
  return { rows, unassigned };
}

const ROUND_ORD = { "1차": 1, "2차": 2, "3차": 3 };
export function rowOrder(a, b) {
  return a.date.localeCompare(b.date) || a.start.localeCompare(b.start) || String(a.studentNo).localeCompare(String(b.studentNo))
    || ROUND_ORD[a.round] - ROUND_ORD[b.round] || (a.role < b.role ? -1 : a.role > b.role ? 1 : 0);
}
