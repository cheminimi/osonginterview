// 지도 일지 — 배정 결과 검사 · 교사별 합계 · 지도 일지 쪽 나누기 (순수 JS)
// 검사는 배정 엔진(guidance-engine.js)과 따로 다시 센다 — 엔진이 스스로 채점하지 않게.

const DAY = 86400000;
const dnum = (s) => { const m = String(s || "").match(/^(\d{4})-(\d{2})-(\d{2})$/); return m ? Math.round(Date.UTC(+m[1], +m[2] - 1, +m[3]) / DAY) : null; };
const mins = (t) => { const m = String(t || "").match(/^(\d{1,2}):(\d{2})$/); return m ? +m[1] * 60 + +m[2] : null; };
const nextDay = (s) => new Date((dnum(s) + 1) * DAY).toISOString().slice(0, 10);
const dow = (s) => new Date(dnum(s) * DAY).getUTCDay();
const weekend = (s) => { const w = dow(s); return w === 0 || w === 6; };
const mondayStr = (s) => { const d = dnum(s), w = (new Date(d * DAY).getUTCDay() + 6) % 7, m = new Date((d - w) * DAY); return m.toISOString().slice(0, 10); };

// 허용 시작 시각 (분) — 엔진과 따로 적어 둔다
const OK30 = { 평일: ["16:30", "17:00", "17:30", "19:00", "19:30", "20:00", "20:30", "21:00"], 주말: [] };
for (let h = 9 * 60; h <= 16 * 60; h += 30) OK30.주말.push(`${String(h / 60 | 0).padStart(2, "0")}:${String(h % 60).padStart(2, "0")}`);
function allowed(date, start, end) {
  const s = mins(start), e = mins(end), list = OK30[weekend(date) ? "주말" : "평일"].map(mins);
  if (s == null || e == null || e <= s || (e - s) % 30) return false;
  for (let t = s; t < e; t += 30) if (!list.includes(t)) return false;   // 60분이면 두 칸 다 허용 칸이어야
  return true;
}
export const ROUND_MIN = { "1차": 60, "2차": 30, "3차": 30 };
export const CHECK_LABELS = {
  teacherOverlap: "교사 시간 중복", studentOverlap: "학생 시간 중복", unavailable: "교사 불가시간 위반",
  pairMismatch: "3차 두 교사 시간 불일치", badDuration: "잘못된 지도시간", dayTypeMismatch: "평일/주말 불일치",
  sourceMismatch: "원본 담당교사 불일치", excludedDay: "운영 제외일 배정", orderViolation: "1·2·3차 순서 어긋남",
  outOfRange: "지도기간·면접일 밖"
};

/**
 * rows: [{ studentNo, teacher, date, start, end, minutes, round, role, dayType }]
 * ctx: { students:[{id, interview, early, t1,t2,t3a,t3b}], unavail:[{teacher,from,to,start,end}], config:{periodStart,periodEnd,earlyStart,excluded} }
 * → { counts:{…}, details:{kind:[문장…]} }
 */
export function checkRows(rows, ctx) {
  const counts = Object.fromEntries(Object.keys(CHECK_LABELS).map((k) => [k, 0]));
  const details = Object.fromEntries(Object.keys(CHECK_LABELS).map((k) => [k, []]));
  const bad = (k, msg) => { counts[k]++; if (details[k].length < 30) details[k].push(msg); };
  const who = (r) => `${r.date} ${r.start}-${r.end} ${r.teacher} · ${r.studentNo} ${r.round}${r.role ? " " + r.role : ""}`;
  const cfg = ctx.config || {};
  const excluded = new Set(cfg.excluded || []);
  const stBy = Object.fromEntries((ctx.students || []).map((s) => [String(s.id), s]));
  const unBy = {};
  (ctx.unavail || []).forEach((u) => (unBy[u.teacher] ||= []).push(u));

  rows.forEach((r) => {
    const s = mins(r.start), e = mins(r.end);
    if (!allowed(r.date, r.start, r.end) || e - s !== ROUND_MIN[r.round] || Number(r.minutes) !== ROUND_MIN[r.round]) bad("badDuration", who(r));
    if (r.dayType !== (weekend(r.date) ? "주말" : "평일")) bad("dayTypeMismatch", who(r));
    if (excluded.has(r.date)) bad("excludedDay", who(r));
    // 불가시간: 기간(from~to) 안 날짜이고, 시간이 1분이라도 겹치면 (시간 없음 = 종일)
    for (const u of unBy[r.teacher] || []) {
      const to = u.to && u.to >= u.from ? u.to : u.from;
      if (r.date < u.from || r.date > to) continue;
      const us = mins(u.start), ue = mins(u.end);
      const allDay = us == null || ue == null || ue <= us;
      if (allDay || (s < ue && e > us)) { bad("unavailable", `${who(r)} ↔ 불가 ${u.from}${u.to && u.to !== u.from ? "~" + u.to : ""} ${allDay ? "종일" : u.start + "-" + u.end}`); break; }
    }
    const st = stBy[String(r.studentNo)];
    const want = !st ? null : r.round === "1차" ? st.t1 : r.round === "2차" ? st.t2 : r.role === "1위원" ? st.t3a : r.role === "2위원" ? st.t3b : null;
    if (!st || want !== r.teacher) bad("sourceMismatch", `${who(r)} (원본: ${want || "없음"})`);
    // 기간: 지도기간 안 (면접 전 1회 예외는 earlyStart 부터), 면접일 전날까지
    if (st) {
      const early = st.early && r.round === "1차";
      const lo = early ? (cfg.earlyStart || cfg.periodStart) : cfg.periodStart;
      // 면접 전 1회 학생의 2·3차: 기준일 다음 날(또는 지도기간 시작)보다 뒤에 있는 면접이면 그 전날까지, 아니면 기간 끝까지 (엔진과 같은 뜻)
      const lo2 = st.early ? [cfg.periodStart, nextDay(st.early)].sort()[1] : "";
      const hiIv = st.early && r.round !== "1차" ? (st.interview && st.interview > lo2 ? st.interview : null) : st.interview;
      let out = (lo && r.date < lo) || (cfg.periodEnd && r.date > cfg.periodEnd);
      if (early && r.date >= st.early) out = true;
      if (st.early && r.round !== "1차" && r.date <= st.early) out = true;
      if (hiIv && r.date >= hiIv) out = true;
      if (out) bad("outOfRange", `${who(r)} (면접일 ${st.interview || "없음"})`);
    }
  });
  // 겹침: 같은 날끼리만
  const byDay = {};
  rows.forEach((r) => (byDay[r.date] ||= []).push(r));
  Object.values(byDay).forEach((l) => {
    for (let i = 0; i < l.length; i++) for (let j = i + 1; j < l.length; j++) {
      const a = l[i], b = l[j];
      if (!(mins(a.start) < mins(b.end) && mins(a.end) > mins(b.start))) continue;
      if (a.teacher === b.teacher) bad("teacherOverlap", `${who(a)} ↔ ${who(b)}`);
      if (a.studentNo === b.studentNo) {
        const partner = a.round === "3차" && b.round === "3차" && a.start === b.start && a.end === b.end && a.teacher !== b.teacher;
        if (!partner) bad("studentOverlap", `${who(a)} ↔ ${who(b)}`);
      }
    }
  });
  // 3차: 학생마다 1위원·2위원 두 줄이 같은 날짜·시각
  const g = {};
  rows.filter((r) => r.round === "3차").forEach((r) => (g[r.studentNo] ||= []).push(r));
  Object.entries(g).forEach(([no, l]) => {
    if (l.length !== 2 || l[0].date !== l[1].date || l[0].start !== l[1].start || l[0].end !== l[1].end || l[0].role === l[1].role) bad("pairMismatch", `${no}: ${l.map(who).join(" / ")}`);
  });
  // 순서 1차 → 2차 → 3차
  const at = {};
  rows.forEach((r) => { (at[r.studentNo] ||= {})[r.round] = r.date + " " + r.start; });
  Object.entries(at).forEach(([no, o]) => {
    const seq = ["1차", "2차", "3차"].filter((k) => o[k]);
    for (let i = 1; i < seq.length; i++) if (o[seq[i]] < o[seq[i - 1]]) bad("orderViolation", `${no}: ${seq.map((k) => k + " " + o[k]).join(" → ")}`);
  });
  return { counts, details, total: Object.values(counts).reduce((a, b) => a + b, 0) };
}

// 원본 배정(students.assign)에서 교사별 목표 횟수. 1차 60분, 나머지 30분
const ok = (x) => !!x && x !== "미정" && x !== "-";
export function targets(students) {
  const t = {};
  const add = (name, k) => { if (!ok(name)) return; (t[name] ||= { r1: 0, r2: 0, r3a: 0, r3b: 0 })[k]++; };
  students.forEach((s) => { add(s.t1, "r1"); add(s.t2, "r2"); if (ok(s.t3a) && ok(s.t3b)) { add(s.t3a, "r3a"); add(s.t3b, "r3b"); } });
  Object.values(t).forEach(fill);
  return t;
}
export function actuals(rows) {
  const t = {};
  rows.forEach((r) => {
    const x = (t[r.teacher] ||= { r1: 0, r2: 0, r3a: 0, r3b: 0 });
    if (r.round === "1차") x.r1++; else if (r.round === "2차") x.r2++; else if (r.role === "1위원") x.r3a++; else x.r3b++;
  });
  Object.values(t).forEach(fill);
  return t;
}
function fill(x) { x.r3 = x.r3a + x.r3b; x.min = x.r1 * 60 + (x.r2 + x.r3) * 30; return x; }

// 교사별 주(월요일 기준) 지도 '번' — 지도 일지 한 장(이어지는 30분 두 개)을 한 번으로
export function weekly(rows) {
  const w = {}, by = {};
  rows.forEach((r) => (by[r.teacher] ||= []).push(r));
  Object.entries(by).forEach(([t, l]) => pagesOf(l).forEach((p) => { const k = mondayStr(p.date); ((w[t] ||= {})[k] = (w[t][k] || 0) + 1); }));
  return w;
}

/**
 * 한 선생님의 지도 일지 쪽: 1차(60분)는 한 장에 한 명, 30분 지도는 같은 날 바로 이어지는 두 개를 한 장에.
 * → [{ date, start, end, items:[row] | [row,row] }]  (날짜·시각 순)
 */
export function pagesOf(rows) {
  const sorted = rows.slice().sort((a, b) => a.date.localeCompare(b.date) || a.start.localeCompare(b.start));
  const pages = [];
  for (let i = 0; i < sorted.length; i++) {
    const r = sorted[i];
    if (r.round !== "1차") {
      const n = sorted[i + 1];
      if (n && n.round !== "1차" && n.date === r.date && n.start === r.end && n.studentNo !== r.studentNo) {
        pages.push({ date: r.date, start: r.start, end: n.end, items: [r, n] }); i++; continue;
      }
    }
    pages.push({ date: r.date, start: r.start, end: r.end, items: [r] });
  }
  return pages;
}
export const WEEK_KO = "일월화수목금토";
export const dayLabel = (s) => `${Number(s.slice(5, 7))}/${Number(s.slice(8, 10))}(${WEEK_KO[dow(s)]})`;
export { mondayStr, weekend as isWeekendStr };
