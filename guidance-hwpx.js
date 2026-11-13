// 지도 일지 — 양식 '2027 대입 모의면접 결과 보고서'(guidance-form/, 한글 hwpx 를 푼 것)에 칸을 채워 hwpx 로 만든다.
// 한 장 = 1시간: 1차(60분)는 왼쪽 칸에 한 명, 이어지는 30분 두 개는 왼쪽·오른쪽 칸에 한 명씩 (guidance-check.js pagesOf)
// 브라우저·Node 둘 다에서 돈다 (fetch 만 바꿔 끼우면 됨). 압축하지 않는 zip(저장 방식)으로 묶는다 — 한글이 그대로 연다.

const FILES = ["mimetype", "version.xml", "settings.xml", "META-INF/container.xml", "META-INF/container.rdf", "META-INF/manifest.xml",
  "Contents/content.hpf", "Contents/header.xml", "Contents/section0.xml"];
let tpl = null;
/** 양식 파일 읽기 (한 번만). loader(path) → 글자 */
export async function loadTemplate(loader = (p) => fetch("guidance-form/" + p, { cache: "no-cache" }).then((r) => { if (!r.ok) throw new Error("양식 파일을 못 읽었어요: " + p); return r.text(); })) {
  if (tpl) return tpl;
  const out = {};
  for (const f of FILES) out[f] = await loader(f);
  tpl = out;
  return tpl;
}

export const xmlEsc = (s) => String(s ?? "").replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "")
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

// ---------- 본문 문단을 맨 위 단계로 나누기 ----------
function topParagraphs(body) {
  const re = /<(\/?)hp:p\b[^>]*?(\/?)>/g;
  const tops = []; let depth = 0, start = 0, m;
  while ((m = re.exec(body))) {
    if (!m[1] && !m[2]) { if (!depth) start = m.index; depth++; }
    else if (m[1]) { depth--; if (!depth) tops.push(body.slice(start, re.lastIndex)); }
  }
  return tops;
}

// ---------- 칸(<hp:tc>) 하나에 글 넣기: 여러 줄이면 문단 여러 개 ----------
function setCell(tc, lines) {
  const a = tc.indexOf(">", tc.indexOf("<hp:subList")) + 1, b = tc.lastIndexOf("</hp:subList>");
  const inner = tc.slice(a, b);
  const pOpen = inner.match(/<hp:p [^>]*>/)[0].replace(/pageBreak="1"/, 'pageBreak="0"');
  const firstP = inner.slice(0, inner.indexOf("</hp:p>"));
  const ctrls = firstP.match(/<hp:run charPrIDRef="\d+"><hp:ctrl>[\s\S]*?<\/hp:ctrl><\/hp:run>/g) || [];
  const textRuns = [...firstP.matchAll(/<hp:run charPrIDRef="(\d+)"(\/>|>(?!<hp:ctrl>))/g)];
  const cp = (textRuns[textRuns.length - 1] || firstP.match(/<hp:run charPrIDRef="(\d+)"/))[1];
  const run = (t) => t ? `<hp:run charPrIDRef="${cp}"><hp:t>${xmlEsc(t)}</hp:t></hp:run>` : `<hp:run charPrIDRef="${cp}"/>`;
  const list = lines.length ? lines : [""];
  const ps = list.map((t, i) => pOpen + (i ? "" : ctrls.join("")) + run(t) + "</hp:p>").join("");
  return tc.slice(0, a) + ps + tc.slice(b);
}

// 양식 칸 순서 (section0.xml 표의 <hp:tc> 차례)
const C = { date: 2, teacher: 4, time: 6, noL: 14, noR: 16, nameL: 18, nameR: 20, univL: 22, univR: 24, typeL: 26, typeR: 28, bodyL: 30, bodyR: 31 };
const WEEK = "일월화수목금토";
function dateText(s) {
  const [y, m, d] = s.split("-").map(Number);
  return `${y}. ${m}. ${d}. (${WEEK[new Date(Date.UTC(y, m - 1, d)).getUTCDay()]})`;
}
export const ROUND_HEAD = { "1차": "1차 학생부 분석 지도 (60분)", "2차": "2차 모의면접 (30분)", "3차": "3차 실전 모의면접 (30분)" };

/**
 * teacher: 선생님 이름, pages: [{date,start,end,items:[row]}]
 * info(studentNo) → { univ:'대학 학과, …', type:'학생부 기반 …' }
 * note(studentNo, round) → '면접 내용 및 피드백' 글 (줄바꿈 가능)
 * → { files:{경로:글자}, pages:n }
 */
export function fillSection(t, teacher, pages, info, note) {
  const sec = t["Contents/section0.xml"];
  const a = sec.indexOf(">", sec.indexOf("<hs:sec")) + 1, z = sec.lastIndexOf("</hs:sec>");
  const tops = topParagraphs(sec.slice(a, z));
  if (tops.length < 4 || !tops[3].includes("<hp:tbl")) throw new Error("양식 모양이 예상과 달라요");
  const [p0, p1, p2, p3] = tops;
  const cells = (tbl) => [...tbl.matchAll(/<hp:tc [^>]*>[\s\S]*?<\/hp:tc>/g)];
  const tblId = Number((p3.match(/<hp:tbl id="(\d+)"/) || [])[1] || 1000);
  const out = [];
  pages.forEach((pg, k) => {
    const side = (r) => r ? {
      no: r.studentNo, name: r.studentName || "", univ: info(r.studentNo).univ || "", type: info(r.studentNo).type || "",
      body: [`[${ROUND_HEAD[r.round]}${r.role ? " · " + r.role : ""}]`, ...String(note(r.studentNo, r.round) || "").split(/\n+/).map((x) => x.trim()).filter(Boolean)]
    } : { no: "", name: "", univ: "", type: "", body: [] };
    const L = side(pg.items[0]), R = side(pg.items[1]);
    const val = {
      [C.date]: [dateText(pg.date)], [C.teacher]: [`${teacher}  (인)`], [C.time]: [`${pg.start} ~ ${pg.end}`],
      [C.noL]: [L.no], [C.noR]: [R.no], [C.nameL]: [L.name], [C.nameR]: [R.name], [C.univL]: [L.univ], [C.univR]: [R.univ],
      [C.typeL]: [L.type], [C.typeR]: [R.type], [C.bodyL]: L.body, [C.bodyR]: R.body
    };
    let tbl = p3, shift = 0;
    for (const [i, m] of cells(p3).entries()) {
      if (!(i in val)) continue;
      const nw = setCell(m[0], val[i].filter((x) => x !== undefined));
      tbl = tbl.slice(0, m.index + shift) + nw + tbl.slice(m.index + shift + m[0].length);
      shift += nw.length - m[0].length;
    }
    tbl = tbl.replace(/<hp:tbl id="\d+"/, `<hp:tbl id="${tblId + k}"`);
    if (k === 0) out.push(p0.replace(/<hp:t>[^<]*<\/hp:t>/, "<hp:t></hp:t>"), p1, p2, tbl);   // 첫 쪽: 쪽 설정 문단 그대로, '[양식]' 글만 지움
    else out.push(p1.replace(/pageBreak="0"/, 'pageBreak="1"'), p1, p2, tbl);
  });
  // 줄 자리 정보는 지운다 → 한글이 열 때 다시 계산
  const body = out.join("").replace(/<hp:linesegarray>[\s\S]*?<\/hp:linesegarray>/g, "");
  return sec.slice(0, a) + body + sec.slice(z);
}

export function buildHwpx(t, teacher, pages, info, note) {
  const files = { ...t, "Contents/section0.xml": fillSection(t, teacher, pages, info, note) };
  files["Preview/PrvText.txt"] = `2027 대입 모의면접 결과 보고서 - ${teacher} (${pages.length}쪽)`;
  const order = ["mimetype", ...Object.keys(files).filter((f) => f !== "mimetype")];
  return zipStore(order.map((name) => ({ name, data: files[name] })));
}

// ---------- 압축 없는 zip ----------
const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
export function crc32(u8) { let c = 0xFFFFFFFF; for (let i = 0; i < u8.length; i++) c = CRC[(c ^ u8[i]) & 0xFF] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; }
/** files: [{name, data: 글자|Uint8Array}] → Uint8Array (첫 파일이 맨 앞에, 압축 없이) */
export function zipStore(files, when = new Date()) {
  const enc = new TextEncoder();
  const dosT = (when.getHours() << 11) | (when.getMinutes() << 5) | (when.getSeconds() >> 1);
  const dosD = ((when.getFullYear() - 1980) << 9) | ((when.getMonth() + 1) << 5) | when.getDate();
  const parts = [], central = [];
  let off = 0;
  for (const f of files) {
    const name = enc.encode(f.name), data = typeof f.data === "string" ? enc.encode(f.data) : f.data;
    const crc = crc32(data), utf = /[^\x20-\x7e]/.test(f.name) ? 0x0800 : 0;
    const lh = new DataView(new ArrayBuffer(30));
    lh.setUint32(0, 0x04034b50, true); lh.setUint16(4, 20, true); lh.setUint16(6, utf, true); lh.setUint16(8, 0, true);
    lh.setUint16(10, dosT, true); lh.setUint16(12, dosD, true); lh.setUint32(14, crc, true);
    lh.setUint32(18, data.length, true); lh.setUint32(22, data.length, true); lh.setUint16(26, name.length, true); lh.setUint16(28, 0, true);
    parts.push(new Uint8Array(lh.buffer), name, data);
    const ch = new DataView(new ArrayBuffer(46));
    ch.setUint32(0, 0x02014b50, true); ch.setUint16(4, 20, true); ch.setUint16(6, 20, true); ch.setUint16(8, utf, true); ch.setUint16(10, 0, true);
    ch.setUint16(12, dosT, true); ch.setUint16(14, dosD, true); ch.setUint32(16, crc, true); ch.setUint32(20, data.length, true); ch.setUint32(24, data.length, true);
    ch.setUint16(28, name.length, true); ch.setUint32(42, off, true);
    central.push(new Uint8Array(ch.buffer), name);
    off += 30 + name.length + data.length;
  }
  const cSize = central.reduce((n, x) => n + x.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true); end.setUint16(8, files.length, true); end.setUint16(10, files.length, true);
  end.setUint32(12, cSize, true); end.setUint32(16, off, true);
  const all = [...parts, ...central, new Uint8Array(end.buffer)];
  const outp = new Uint8Array(all.reduce((n, x) => n + x.length, 0));
  let p = 0; for (const x of all) { outp.set(x, p); p += x.length; }
  return outp;
}
