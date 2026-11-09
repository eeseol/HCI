'use strict';
/* =====================================================================
 * Tab Simulator — Baseline: icon + title/DOI  vs  Proposed: text cloud
 *
 *  IV1 라벨 방식 : baseline | proposed
 *  IV2 탭 폭     : narrow | middle | wide   (탭 수 고정, 폭만 변경)
 *  2×3 = 6 조건 × 조건당 N회 (기본 8) = 48 시행, 시행마다 새 PDF K개 (기본 5)
 *
 *  한 시행 흐름
 *   [흐린 화면: n/8 + Start/Next] → 탭 셔플, 첫 탭 표시
 *   → 모든 탭을 한 번씩 확인 (explore) → 과제박스 Start 활성화
 *   → Start: 단서 표시 + 60초 카운트다운 (search)
 *   → 정답 탭 클릭 = 성공 / 다른 탭 클릭 = Error+1 / 시간 초과 / Missing
 * ===================================================================== */

/* ---------- 버전 (각 버전 폴더의 index.html 이 window.TABSIM_VERSION 으로 지정) ----------
 *  source: cloud     = Proposed 라벨이 본문 빈도 Top-1 단어 (text cloud)
 *          llm       = 엑셀 LLM_text_k        (LLM이 본문에서 뽑은 의미 단어, 중요도 순)
 *          title_llm = 엑셀 title_text_LLM_k  (LLM이 제목에서 뽑은 중요 단어, 중요도 순) */
const V = Object.assign({ id: 'text_cloud', prefix: 'tc', proposedName: 'text cloud', source: 'cloud' }, window.TABSIM_VERSION || {});
const PROPOSED_NAME = V.proposedName;
const SOURCE_COLS = { llm: { col: 'LLM_text', n: 5 }, title_llm: { col: 'title_text_LLM', n: 3 } };
const POOL_SIZES_INIT = [10, 20, 30];
const LS_CFG = `tabsim.${V.prefix}.config.v3`;
const LS_LOG = `tabsim.${V.prefix}.logs.v3`;
const LS_READ = `tabsim.${V.prefix}.readlogs.v1`;
const LS_META = `tabsim.${V.prefix}.meta.v1`;
const DB_NAME = `tabsim_${V.prefix}_v3`;

pdfjsLib.GlobalWorkerOptions.workerSrc =
  'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';

/* ---------- Chrome 탭 내부 배치 (Chromium tab_style.cc / layout_constants.cc 기준) ----------
 * 설정의 탭 폭 = 화면상 폭(겹침 제외). Chrome 내부 폭 W = 화면 폭 + 겹침 18.
 * 내용 폭 = W − 좌우 안쪽 여백 20×2 = 화면 폭 − 22
 * [파비콘16][8][제목][4][닫기16],  비활성 탭은 내용 폭 < 68 이면 닫기 숨김 */
const TAB = { OVERLAP: 18, INSET: 20, ICON: 16, PRE_TITLE: 8, CLOSE_W: 20, CLOSE_MIN_CONTENT: 68, CHAR_PX: 6.6 };

const METHODS = ['baseline', 'proposed'];
const WIDTHS = ['narrow', 'middle', 'wide'];
const CONDS = METHODS.flatMap((m) => WIDTHS.map((w) => ({ method: m, width: w })));
const condName = (c) => `${c.method === 'baseline' ? 'Baseline' : 'Proposed'} · ${c.width}`;

/* ---------- 불용어 ---------- */
const STOP_EN = new Set((`
a about above after again against all almost also am among an and any are aren't as at be because been before being
below between both but by can can't cannot could couldn't did didn't do does doesn't doing don't down during each either
else etc even ever every few for from further get gets got had hadn't has hasn't have haven't having he her here hers
herself him himself his how however i if in into is isn't it it's its itself just let like made make makes many may me
might more most much must my myself neither no nor not now of off often on once one only onto or other others otherwise
our ours ourselves out over own per rather same several shall she should shouldn't since so some such than that the their
theirs them themselves then there therefore these they this those though through thus to too toward towards under until
up upon us very via was wasn't we were weren't what when where whether which while who whom whose why will with within
without would wouldn't yet you your yours yourself yourselves
`).trim().split(/\s+/));

const DEFAULT_EXTRA_STOP = `et al fig figure figures table tables section sections eq equation equations appendix
paper papers work works propose proposed approach approaches method methods result results show shows shown
use used using based also well new first second third two three four five one however respectively
i.e e.g etc http https www com org doi arxiv preprint vol pp ieee acm proc proceedings conference journal
abstract introduction conclusion conclusions related experiment experiments
mr mrs ms dr`;

/* ---------- 설정 ---------- */
const DEFAULT_CFG = {
  participantId: 'P01',
  baselineMode: 'title',     // title (논문 제목) | doi (랜덤 arXiv ID)
  doiConst: 7392581,         // 랜덤 ID 생성 상수 (6~10자리). ID = f(상수 × 논문 번호)
  cueSource: 'desc',         // desc(엑셀 description) | auto(cues.csv) | title | thumb | none
  proposedNumber: true,      // 규칙: Proposed 라벨 앞에 탭 위치 숫자 0~9 + 10개 단위 흰/회색 번갈아
  proposedRank: 1,           // 엑셀 버전: Proposed 라벨에 LLM_text_k / title_text_LLM_k 중 몇 순위를 쓸지
  widths: { narrow: 40, middle: 80, wide: 160 },
  poolSize: 10,              // 사용할 아티클 수: 10 | 20 | 30 (파일명 순 앞에서부터)
  trialsPerCond: 10,         // 조건당 시행 수 N — 6N이 poolSize로 나누어떨어지는 값만 허용 (정답 균등)
  tabsPerTrial: 10,          // 시행당 열리는 탭 수 (≤ poolSize)
  timeLimit: 60,
  seed: 1,
  latin: true,
  admin: false,              // 관리자 모드: 과제박스에 단계 건너뛰기 버튼
  reading: true,             // 세션 시작 시 읽기 단계
  readMinSec: 0,             // 아티클당 최소 읽기 시간 (초, 기본 0)
  readOrder: 'random',       // random(참가자별) | name(파일명 순)
  addressBar: 'path',
  hoverCard: 'label',
  minLen: 3,
  labelCase: 'capitalize',
  cutReferences: true,
  mergePlurals: true,
  extraStopwords: DEFAULT_EXTRA_STOP,
  overrides: {},             // 파일명 -> Proposed 수동 라벨
};

function lsGet(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch { return d; } }
function lsSet(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* 저장 불가 */ } }

const loadedCfg = lsGet(LS_CFG, {});
const state = {
  cfg: Object.assign({}, DEFAULT_CFG, loadedCfg, {
    widths: Object.assign({}, DEFAULT_CFG.widths, loadedCfg.widths),
    overrides: Object.assign({}, loadedCfg.overrides),
  }),
  docs: new Map(),        // 파일명 -> doc {name,size,lastModified,getFile,text,numPages,metaTitle,paperTitle}
  cues: new Map(),        // 파일명 -> 단서 (cues.csv)
  keywords: new Map(),    // 파일명 -> [{w,c}]
  folderName: '',
  dirHandle: null,
  logs: lsGet(LS_LOG, []),
  readLogs: lsGet(LS_READ, []),
  reading: null,          // 읽기 단계 진행 정보 {idx, order, t0, startIso}
  plan: null,
  phase: 'between',       // between | reading | explore | search
  cur: null,              // 현재 시행 계획
  tabs: [],               // 현재 시행의 탭 (doc 배열, 셔플된 순서)
  visited: new Set(),
  activeName: null,
  trial: null,            // search 단계 측정 정보
  viewers: new Map(),
  meta: lsGet(LS_META, null),   // 엑셀: {source, rows:[{no,file,title,desc[],llm[],titleLlm[]}]}
};
// 이전 설정값 호환: paper/meta → title, filename → doi
if (!['title', 'doi'].includes(state.cfg.baselineMode)) state.cfg.baselineMode = state.cfg.baselineMode === 'filename' ? 'doi' : 'title';
if (!POOL_SIZES_INIT.includes(state.cfg.poolSize)) state.cfg.poolSize = 10;
// 규칙: 과제 단서는 description — 이전 설정(auto 등)을 한 번 description으로 전환
if (!state.cfg.descCueMigrated) { state.cfg.cueSource = 'desc'; state.cfg.descCueMigrated = true; }
// 저장된 추가 불용어에 호칭(mr mrs ms dr)이 없으면 한 번 추가
if (!state.cfg.titleStopMigrated) {
  if (!/(^|\s)mrs(\s|$)/.test(state.cfg.extraStopwords)) state.cfg.extraStopwords = state.cfg.extraStopwords.trimEnd() + '\nmr mrs ms dr';
  state.cfg.titleStopMigrated = true;
}
const saveCfg = () => lsSet(LS_CFG, state.cfg);
const saveLogs = () => lsSet(LS_LOG, state.logs);
const saveReadLogs = () => lsSet(LS_READ, state.readLogs);

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function versionName() {
  const b = state.cfg.baselineMode === 'doi' ? 'DOI' : 'title';
  return `Baseline: icon + ${b} vs Proposed: ${PROPOSED_NAME}`;
}

/* ---------- 시드 난수 ---------- */
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function shuffle(arr, rnd = Math.random) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}

/* =====================================================================
 * IndexedDB: 텍스트 추출 캐시 + 폴더 핸들
 * ===================================================================== */
let dbPromise = null;
function openDb() {
  if (!dbPromise) {
    dbPromise = new Promise((res, rej) => {
      const r = indexedDB.open(DB_NAME, 1);
      r.onupgradeneeded = () => {
        r.result.createObjectStore('cache');
        r.result.createObjectStore('handles');
      };
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
  }
  return dbPromise;
}
async function idb(store, mode, fn) {
  const db = await openDb();
  return new Promise((res, rej) => {
    const tx = db.transaction(store, mode);
    const req = fn(tx.objectStore(store));
    tx.oncomplete = () => res(req && req.result);
    tx.onerror = () => rej(tx.error);
    tx.onabort = () => rej(tx.error);
  });
}
async function cacheAll() {
  const db = await openDb();
  return new Promise((res, rej) => {
    const out = new Map();
    const tx = db.transaction('cache', 'readonly');
    const req = tx.objectStore('cache').openCursor();
    req.onsuccess = () => { const c = req.result; if (c) { out.set(c.key, c.value); c.continue(); } };
    tx.oncomplete = () => res(out);
    tx.onerror = () => rej(tx.error);
  });
}
const cachePut = (key, v) => idb('cache', 'readwrite', (s) => s.put(v, key));
const handleGet = () => idb('handles', 'readonly', (s) => s.get('dir'));
const handlePut = (h) => idb('handles', 'readwrite', (s) => s.put(h, 'dir'));

/* =====================================================================
 * PDF 텍스트 추출
 * ===================================================================== */
async function extractText(buf) {
  const pdf = await pdfjsLib.getDocument({ data: buf }).promise;
  const parts = [];
  let paperTitle = '';
  for (let p = 1; p <= pdf.numPages; p++) {
    const page = await pdf.getPage(p);
    const tc = await page.getTextContent();
    let prev = null;
    for (const it of tc.items) {
      if (typeof it.str !== 'string') continue;
      const x = it.transform[4], y = it.transform[5];
      const h = Math.abs(it.transform[3]) || it.height || 10;
      if (prev) {
        if (prev.eol) parts.push('\n');
        else {
          const sameLine = Math.abs(y - prev.y) < h * 0.5;
          const gap = x - prev.end;
          parts.push(sameLine ? (gap < h * 0.15 && gap > -h ? '' : ' ') : '\n');
        }
      }
      parts.push(it.str);
      prev = { end: x + (it.width || 0), y, eol: !!it.hasEOL };
    }
    parts.push('\n');
    if (p === 1) paperTitle = guessTitle(tc.items, page.view[3]);
    page.cleanup();
  }
  let metaTitle = '';
  try { const m = await pdf.getMetadata(); metaTitle = ((m.info && m.info.Title) || '').trim(); } catch { /* 없음 */ }
  const numPages = pdf.numPages;
  await pdf.destroy();
  const text = parts.join('').replace(/(\p{L})-[ \t]*\n[ \t]*(\p{Ll})/gu, '$1$2');
  return { text, numPages, metaTitle, paperTitle };
}

/** 첫 페이지 위쪽에서 글자가 가장 큰 줄들 = 논문 제목으로 추정 (회전된 arXiv 워터마크 제외) */
function guessTitle(items, pageH) {
  const cand = items.filter((it) => typeof it.str === 'string' && it.str.trim()
    && Math.abs(it.transform[1]) < 0.01 && Math.abs(it.transform[2]) < 0.01
    && it.transform[5] > pageH * 0.45);
  if (!cand.length) return '';
  const maxH = Math.max(...cand.map((it) => Math.abs(it.transform[3])));
  const big = cand.filter((it) => Math.abs(it.transform[3]) >= maxH * 0.9);
  big.sort((a, b) => b.transform[5] - a.transform[5] || a.transform[4] - b.transform[4]);
  const t = big.map((it) => it.str).join(' ').replace(/\s+/g, ' ').trim();
  return t.length >= 6 ? t.slice(0, 220) : '';
}

/* =====================================================================
 * 키워드 (Proposed: text cloud)
 * ===================================================================== */
function cutReferences(text) {
  const re = /(^|\n)[ \t]*(?:\d+\.?|[IVX]+\.)?[ \t]*(references|bibliography|참고[ \t]*문헌)[ \t]*(?=\n|$)/gi;
  let last = -1, m;
  while ((m = re.exec(text))) last = m.index;
  if (last < 0) { const re2 = /\bREFERENCES\b/g; while ((m = re2.exec(text))) last = m.index; }
  return last > text.length * 0.4 ? text.slice(0, last) : text;
}
function buildStopSet() {
  const s = new Set(STOP_EN);
  for (const w of state.cfg.extraStopwords.toLowerCase().split(/[\s,]+/)) if (w) s.add(w);
  return s;
}
function computeKeywords(text, stops) {
  const cfg = state.cfg;
  if (cfg.cutReferences) text = cutReferences(text);
  const re = /\p{L}[\p{L}\p{N}]*(?:['’\-][\p{L}\p{N}]+)*/gu;
  const counts = new Map();
  let idx = 0;
  for (const m of text.matchAll(re)) {
    idx++;
    const w = m[0].toLowerCase().replace(/['’]s$/, '');
    if ([...w].length < cfg.minLen || stops.has(w)) continue;
    const e = counts.get(w);
    if (e) e.c++; else counts.set(w, { w, c: 1, first: idx });
  }
  if (cfg.mergePlurals) {
    for (const [w, e] of [...counts]) {
      let base = null;
      if (w.length > 4 && w.endsWith('ies') && counts.has(w.slice(0, -3) + 'y')) base = w.slice(0, -3) + 'y';
      else if (w.endsWith('es') && counts.has(w.slice(0, -2))) base = w.slice(0, -2);
      else if (w.endsWith('s') && !w.endsWith('ss') && counts.has(w.slice(0, -1))) base = w.slice(0, -1);
      if (base && base !== w) { const b = counts.get(base); b.c += e.c; b.first = Math.min(b.first, e.first); counts.delete(w); }
    }
  }
  return [...counts.values()].sort((a, b) => b.c - a.c || a.first - b.first).slice(0, 10);
}
function recomputeKeywords() {
  const stops = buildStopSet();
  state.keywords.clear();
  for (const d of state.docs.values()) state.keywords.set(d.name, computeKeywords(d.text || '', stops));
  computeIds();
}
function applyCase(w) {
  switch (state.cfg.labelCase) {
    case 'lower': return w.toLowerCase();
    case 'upper': return w.toUpperCase();
    default: return w.charAt(0).toUpperCase() + w.slice(1);
  }
}

/* ---------- 엑셀 (아티클 정보) ---------- */
/** 엑셀 → rows. 'PDF 파일명' 또는 'description_1' 이 있는 행을 헤더로 인식 */
function parseWorkbook(buf) {
  const wb = XLSX.read(buf, { type: 'array' });
  for (const sn of wb.SheetNames) {
    const aoa = XLSX.utils.sheet_to_json(wb.Sheets[sn], { header: 1, defval: null, raw: false });
    const h = aoa.findIndex((r) => r && r.some((v) => v === 'description_1' || v === 'PDF 파일명'));
    if (h < 0) continue;
    const head = aoa[h].map((v) => (v == null ? '' : String(v).trim()));
    const ci = (name) => head.indexOf(name);
    const fileCol = head.findIndex((v) => v === 'PDF 파일명' || /^(pdf\s*)?file(name)?$/i.test(v));
    const series = (base, n) => Array.from({ length: n }, (_, i) => ci(`${base}_${i + 1}`));
    const dC = series('description', 10), lC = series('LLM_text', 5), tC = series('title_text_LLM', 3);
    const get = (r, c) => (c >= 0 && r[c] != null ? String(r[c]).trim() : '');
    const rows = [];
    for (const r of aoa.slice(h + 1)) {
      if (!r || !r.some((v) => v != null && String(v).trim())) continue;
      const file = get(r, fileCol);
      const m = file.match(/\d+/);
      const no = parseInt(get(r, ci('No.')), 10) || (m ? parseInt(m[0], 10) : NaN);
      if (!file && !Number.isFinite(no)) continue;
      rows.push({ no, file, title: get(r, ci('Article Title')),
        desc: dC.map((c) => get(r, c)).filter(Boolean),
        llm: lC.map((c) => get(r, c)), titleLlm: tC.map((c) => get(r, c)) });
    }
    if (rows.length) return rows;
  }
  throw new Error('엑셀에서 "PDF 파일명" 또는 "description_1" 헤더를 찾지 못했습니다.');
}
/** 폴더 안 xlsx 자동 로드 (실패해도 조용히) */
async function loadMetaFileQuiet(file) {
  try {
    const rows = parseWorkbook(await file.arrayBuffer());
    state.meta = { source: file.name, loadedAt: new Date().toISOString(), rows };
    lsSet(LS_META, state.meta);
  } catch (e) { console.warn('폴더 안 엑셀 무시:', file.name, e.message); }
}
async function loadMetaFile(file) {
  try {
    const rows = parseWorkbook(await file.arrayBuffer());
    state.meta = { source: file.name, loadedAt: new Date().toISOString(), rows };
    lsSet(LS_META, state.meta);
  } catch (e) { alert('엑셀을 읽지 못했습니다: ' + e.message); return; }
  onPlanInputsChanged();
}
/** 아티클(PDF)에 해당하는 엑셀 행: 파일명 일치 → 없으면 번호(파일명 첫 숫자) 일치 */
function metaFor(d) {
  if (!state.meta || !d) return null;
  const rows = state.meta.rows;
  return rows.find((r) => r.file === d.name) || rows.find((r) => r.no === paperNo(d.name, -1)) || null;
}
const needsMeta = () => V.source !== 'cloud' || state.cfg.cueSource === 'desc';

/* ---------- 라벨 ---------- */
const stem = (name) => name.replace(/\.pdf$/i, '');
/** 논문 번호: 파일명의 첫 숫자 (01.pdf → 1). 없으면 파일명 정렬 순서 */
function paperNo(name, sortedIdx) { const m = stem(name).match(/\d+/); return m ? parseInt(m[0], 10) : sortedIdx + 1; }

/** 랜덤 arXiv 형식 ID (예: 2403.17219v1).
 *  q = 상수 × 논문 번호 → q³ + 1000003·q 의 뒤쪽 12자리(끝 2자리 제외)를 잘라 YYMM.NNNNN vN 으로.
 *  상수는 끝자리가 0이 아닌 복잡한 수일수록 고르게 섞임 */
function computeIds() {
  const C = BigInt(Math.max(1, Math.floor(Number(state.cfg.doiConst) || 7392581)));
  const used = new Set();
  state.ids = new Map();
  [...state.docs.keys()].sort().forEach((n, i) => {
    const q = C * BigInt(paperNo(n, i));
    const s = (q * q * q + 1000003n * q).toString().padStart(20, '0');
    const mid = s.slice(-14, -2);                     // 뒤쪽 12자리 (값 크기와 무관하게 잘 섞임)
    const yy = 15 + (+mid[0] % 10);                   // 15~24
    const mm = 1 + (+mid.slice(1, 3) % 12);           // 01~12
    let num = +mid.slice(3, 8);                       // 5자리 일련번호
    const v = 1 + (+mid[8] % 3);                      // v1~v3
    let id;
    do { id = `${yy}${String(mm).padStart(2, '0')}.${String(num).padStart(5, '0')}`; num = (num + 1) % 100000; } while (used.has(id));
    used.add(id);
    state.ids.set(n, `${id}v${v}`);
  });
}
const arxivId = (d) => (state.ids && state.ids.get(d.name)) || stem(d.name);

function baselineTitle(d) { const m = metaFor(d); return (m && m.title) || d.paperTitle || d.metaTitle || stem(d.name); }
function baselineLabel(d) { return state.cfg.baselineMode === 'doi' ? arxivId(d) : baselineTitle(d); }
/** Proposed 후보 목록 (중요도 순): cloud = 빈도 Top-10, llm/title_llm = 엑셀 열 */
function proposedList(d) {
  if (V.source === 'cloud') return (state.keywords.get(d.name) || []).map((k) => applyCase(k.w));
  const m = metaFor(d);
  return m ? (V.source === 'llm' ? m.llm : m.titleLlm).filter(Boolean) : [];
}
function autoProposed(d) {
  const list = proposedList(d);
  if (V.source === 'cloud') return list[0] || null;
  const k = Math.max(1, state.cfg.proposedRank || 1);
  return list[k - 1] || list[list.length - 1] || null;     // 그 순위가 비어 있으면 마지막 순위
}
function proposedLabel(d) {
  const ov = (state.cfg.overrides[d.name] || '').trim();
  return ov || autoProposed(d) || stem(d.name);
}
function labelFor(d, method) { return method === 'baseline' ? baselineLabel(d) : proposedLabel(d); }
/** 탭에 실제로 보이는 라벨. Proposed: 탭 위치(제일 왼쪽 = 0)의 일의 자리 숫자를 바로 앞에 붙임 (6 + rain → 6rain) */
function tabLabel(d, method, pos) {
  const t = labelFor(d, method);
  return method === 'proposed' && state.cfg.proposedNumber && pos >= 0 ? `${pos % 10}${t}` : t;
}
/** 10개 단위 그룹: 0~9 흰색(기본), 10~19 회색, 20~29 흰색 … (Proposed 에서만) */
const tabGroupOdd = (method, pos) => method === 'proposed' && state.cfg.proposedNumber && Math.floor(pos / 10) % 2 === 1;
/** 과제 단서. trial 이 주어지면 description 방식은 그 시행에 배정된 description */
function cueFor(d, trial) {
  const src = state.cfg.cueSource;
  if (src === 'none' || src === 'thumb') return '';
  const m = metaFor(d);
  if (src === 'desc') {
    if (!m || !m.desc.length) return '';
    return m.desc[((trial && trial.descNo ? trial.descNo : 1) - 1) % m.desc.length];
  }
  if (src === 'auto' && state.cues.has(d.name)) return state.cues.get(d.name);
  return (m && m.title) || d.paperTitle || d.metaTitle || '';
}

/* =====================================================================
 * 세션 계획: Latin square + PDF 배정
 * ===================================================================== */
function participantNo() { const m = String(state.cfg.participantId).match(/\d+/); return m ? Math.max(1, parseInt(m[0], 10)) : 1; }

/** balanced Latin square (Williams): 첫 행 0,1,n-1,2,n-2,… 를 행마다 +1 */
function latinRow(n, r) {
  const seq = [0];
  for (let i = 1; i < n; i++) seq.push(i % 2 ? (i + 1) / 2 : n - i / 2);
  return seq.map((v) => (v + r) % n);
}

/* ---------- 아티클 풀 & 균등 trial 수 ---------- */
const natural = (a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
/** 이번 세션에 쓰는 아티클 = 폴더 PDF를 파일명 순으로 정렬한 앞의 poolSize개 */
function poolNames() { return [...state.docs.keys()].sort(natural).slice(0, state.cfg.poolSize); }

/** 6 × N 이 아티클 수 P로 나누어떨어지는 N (= 모든 아티클이 정답으로 정확히 같은 횟수) — 작은 것부터 10개 */
function validNs(P = state.cfg.poolSize) {
  const out = [];
  for (let n = 1; out.length < 10 && n <= 2000; n++) if ((CONDS.length * n) % P === 0) out.push(n);
  return out;
}
/** 현재 N이 균등 조건을 못 맞추면 가장 가까운 후보로 */
function snapTrialsPerCond() {
  const v = validNs();
  const c = state.cfg;
  if (!v.includes(c.trialsPerCond)) c.trialsPerCond = v.reduce((a, b) => (Math.abs(b - c.trialsPerCond) < Math.abs(a - c.trialsPerCond) ? b : a), v[0]);
  c.tabsPerTrial = Math.min(c.tabsPerTrial, c.poolSize);
}

function buildPlan() {
  const c = state.cfg;
  const nC = CONDS.length, T = c.trialsPerCond;
  const row = (participantNo() - 1) % nC;
  const order = c.latin ? latinRow(nC, row) : CONDS.map((_, i) => i);
  const names = poolNames();
  const P = names.length;
  const K = Math.min(c.tabsPerTrial, P);
  const total = nC * T;
  const rnd = mulberry32(c.seed);
  const ok = P >= c.poolSize && P >= 2;
  const shown = new Map(names.map((n) => [n, 0]));
  const targeted = new Map(names.map((n) => [n, 0]));
  const trials = [];
  if (ok) {
    // 1) 정답 순서: 아티클 P개를 셔플한 묶음을 total/P 번 이어 붙임 → 모든 아티클이 정확히 같은 횟수 정답.
    //    묶음 경계에서 같은 아티클이 연달아 나오지 않도록 교환.
    const targets = [];
    while (targets.length < total) {
      const blk = shuffle(names, rnd);
      if (targets.length && blk[0] === targets[targets.length - 1] && P > 1) [blk[0], blk[1]] = [blk[1], blk[0]];
      targets.push(...blk);
    }
    targets.length = total;
    // 2) 각 시행의 탭 K개 = 정답 + 지금까지 탭 등장이 가장 적은 나머지 K-1개 (동률은 시드 난수)
    let g = 0;
    order.forEach((ci, b) => {
      for (let t = 0; t < T; t++, g++) {
        const target = targets[g];
        const others = names.filter((n) => n !== target).map((n) => ({ n, r: rnd() }))
          .sort((a, b2) => shown.get(a.n) - shown.get(b2.n) || a.r - b2.r)
          .slice(0, K - 1).map((x) => x.n);
        const set = [target, ...others];
        set.forEach((n) => shown.set(n, shown.get(n) + 1));
        targeted.set(target, targeted.get(target) + 1);
        trials.push({ g, block: b, condIdx: ci, cond: CONDS[ci], tInBlock: t, set, target, descNo: 0 });
      }
    });
  }
  // description 배정: 참가자·아티클마다 description 순서를 셔플해 두고, 그 아티클이 k번째 정답일 때 k번째를 사용
  //  → 한 참가자 안에서 같은 아티클에 같은 description이 반복되지 않음 (정답 횟수 ≤ description 수일 때)
  const pno = participantNo();
  const seen = new Map();
  let descRepeat = false;
  for (const tr of trials) {
    const md = metaFor(state.docs.get(tr.target));
    const nd = md && md.desc.length ? md.desc.length : 10;
    const k = seen.get(tr.target) || 0;
    seen.set(tr.target, k + 1);
    if (k >= nd) descRepeat = true;
    const ai = names.indexOf(tr.target);
    const ord = shuffle([...Array(nd).keys()], mulberry32((c.seed * 1000003) ^ (pno * 7919) ^ ((ai + 1) * 104729)));
    tr.descNo = ord[k % nd] + 1;
  }
  const span = (m) => { const v = [...m.values()]; if (!v.length) return '-'; const lo = Math.min(...v), hi = Math.max(...v); return lo === hi ? `${lo}` : `${lo}~${hi}`; };
  const metaOk = !needsMeta() || names.every((n) => {
    const d = state.docs.get(n), m = metaFor(d);
    return m && (c.cueSource !== 'desc' || m.desc.length) && (V.source === 'cloud' || proposedList(d).length);
  });
  return { row, order, trials, P, K, have: state.docs.size, ok, total, balanced: total % (P || 1) === 0, metaOk, descRepeat,
    shownSpan: span(shown), targetSpan: span(targeted) };
}

/* ---------- 읽기 단계 ---------- */
function readingOrder() {
  const names = poolNames();
  return state.cfg.readOrder === 'name' ? names : shuffle(names, mulberry32(state.cfg.seed * 7919 + participantNo()));
}
function myReadLogs() { return state.readLogs.filter((l) => l.participant_id === state.cfg.participantId); }
function readingDone() {
  if (!state.cfg.reading || !state.docs.size) return true;
  const read = new Set(myReadLogs().map((l) => l.file));
  return poolNames().every((n) => read.has(n));
}

function myLogs() { return state.logs.filter((l) => l.participant_id === state.cfg.participantId); }
function completedCount() { return myLogs().length; }

/* =====================================================================
 * 탭 렌더링
 * ===================================================================== */
function tabParts(v, isActive, hasIcon = true) {
  const content = v + TAB.OVERLAP - 2 * TAB.INSET;
  const lead = TAB.ICON + TAB.PRE_TITLE;
  let fav, close, titleW;
  if (!hasIcon) {
    // Proposed: 아이콘 없이 텍스트가 바로 시작 → 파비콘 자리(16+8px)까지 제목이 씀
    fav = false;
    close = isActive || content >= TAB.CLOSE_MIN_CONTENT;
    titleW = content - (close ? TAB.CLOSE_W : 0);
  } else if (isActive) {
    close = true;
    fav = content >= TAB.ICON + TAB.CLOSE_W;
    titleW = fav ? content - lead - TAB.CLOSE_W : 0;
  } else {
    fav = true;
    close = content >= TAB.CLOSE_MIN_CONTENT;
    titleW = content - lead - (close ? TAB.CLOSE_W : 0);
  }
  titleW = Math.max(0, Math.floor(titleW));
  return { fav, close, titleW, centered: !titleW };
}

const FAVICON = `<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
  <path d="M3.5 1.5h6l3 3v10h-9z" fill="#fff" stroke="#5f6368" stroke-width="1"/>
  <path d="M9.5 1.5v3h3" fill="none" stroke="#5f6368" stroke-width="1"/>
  <rect x="2" y="8" width="9" height="5" rx="1" fill="#d93025"/>
  <text x="6.5" y="12" font-size="4" font-family="Arial" font-weight="700" fill="#fff" text-anchor="middle">PDF</text>
</svg>`;
const CLOSE_ICON = `<svg viewBox="0 0 16 16" width="10" height="10"><path d="M3 3l10 10M13 3L3 13" stroke="currentColor" stroke-width="1.8"/></svg>`;
/* arXiv 로고마크 풍 파비콘 (배경 없음, arXiv 레드 #B31B1B 곡선 획 + 회색 획이 교차하는 χ).
 * 실제 arXiv 파비콘을 쓰려면 PDF 폴더에 baseline_icon.png(.ico/.svg)로 저장해 두면 자동으로 대체됨 */
const ARXIV_ICON = `<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
  <path d="M3 2.2 C6.2 5.4 9 9.6 13.2 14" fill="none" stroke="#B31B1B" stroke-width="3" stroke-linecap="round"/>
  <path d="M12.6 2.4 C10.2 5.8 7.4 9.4 3.4 13.8" fill="none" stroke="#5f6368" stroke-width="1.6" stroke-linecap="round"/>
  <path d="M2.4 2.2 L5.2 2.2" stroke="#B31B1B" stroke-width="1.6" stroke-linecap="round"/>
</svg>`;
const TUNE_ICON = `<svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true"><path d="M2 5h7M12 5h2M2 11h2M7 11h7" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><circle cx="10.5" cy="5" r="1.6" fill="none" stroke="currentColor" stroke-width="1.4"/><circle cx="5.5" cy="11" r="1.6" fill="none" stroke="currentColor" stroke-width="1.4"/></svg>`;
function baselineIcon() {
  return state.baseIconUrl ? `<img src="${state.baseIconUrl}" width="16" height="16" alt="">` : ARXIV_ICON;
}

function curWidth() { return state.cur ? state.cfg.widths[state.cur.cond.width] : 0; }

function renderTabs() {
  const box = $('#tabs');
  box.innerHTML = '';
  if (state.phase === 'reading' && state.reading) {
    // 읽기 단계: 탭 1개, 조건 중립 라벨 (Baseline/Proposed 어느 쪽 라벨도 미리 노출하지 않음)
    const r = state.reading;
    const p = tabParts(240, true);
    box.innerHTML = `<div class="tab active" style="width:240px"><span class="curve-l"></span><span class="fav">${FAVICON}</span>` +
      `<span class="title" style="width:${p.titleW}px">아티클 ${r.idx + 1} / ${r.order.length}</span><span class="close">${CLOSE_ICON}</span></div>`;
    updateAddress();
    updateTabScroll();
    return;
  }
  if (!state.cur) { updateAddress(); updateTabScroll(); return; }
  const v = curWidth();
  const method = state.cur.cond.method;
  const hasIcon = method === 'baseline';   // 규칙: Proposed는 아이콘 없이 텍스트만
  state.tabs.forEach((d, pos) => {
    const isActive = d.name === state.activeName;
    const p = tabParts(v, isActive, hasIcon);
    const el = document.createElement('div');
    el.className = 'tab' + (isActive ? ' active' : '') + (p.centered ? ' centered' : '') + (hasIcon ? '' : ' noicon') +
      (tabGroupOdd(method, pos) ? ' grp-odd' : '');
    el.style.width = v + 'px';
    el.setAttribute('role', 'tab');
    let html = isActive ? '<span class="curve-l"></span>' : '';
    if (p.fav) html += `<span class="fav">${baselineIcon()}</span>`;
    if (p.titleW) html += `<span class="title" style="width:${p.titleW}px">${esc(tabLabel(d, method, pos))}</span>`;
    if (p.close) html += `<span class="close"${p.fav && !p.titleW ? ' style="margin-left:4px"' : ''}>${CLOSE_ICON}</span>`;
    el.innerHTML = html;
    el.addEventListener('mousedown', (e) => { if (e.button === 0) onTabPick(d.name); });
    el.addEventListener('mouseenter', () => hoverStart(el, d, pos));
    el.addEventListener('mouseleave', hoverEnd);
    box.appendChild(el);
  });
  // 스크롤되는 탭 줄에서 활성 탭이 항상 보이도록
  const act = box.querySelector('.tab.active');
  if (act) act.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  updateAddress();
  updateTabScroll();
}

/* ---------- 탭 줄 아래 스크롤바 (직접 그림) ---------- */
function updateTabScroll() {
  const area = $('#tabsArea'), track = $('#tabScroll'), thumb = $('#tabScrollThumb');
  const sw = area.scrollWidth, cw = area.clientWidth;
  if (sw <= cw + 1) { track.hidden = true; return; }
  track.hidden = false;
  const left = area.getBoundingClientRect().left - $('#browser').getBoundingClientRect().left;
  track.style.left = left + 'px';
  track.style.width = cw + 'px';
  const tw = Math.max(30, (cw * cw) / sw);
  thumb.style.width = tw + 'px';
  thumb.style.left = (area.scrollLeft / (sw - cw)) * (cw - tw) + 'px';
}
function bindTabScroll() {
  const area = $('#tabsArea'), track = $('#tabScroll'), thumb = $('#tabScrollThumb');
  area.addEventListener('scroll', updateTabScroll);
  window.addEventListener('resize', updateTabScroll);
  const ratio = () => { const sw = area.scrollWidth, cw = area.clientWidth; const tw = thumb.offsetWidth; return (sw - cw) / Math.max(1, cw - tw); };
  thumb.addEventListener('mousedown', (e) => {
    e.preventDefault(); e.stopPropagation();
    const x0 = e.clientX, s0 = area.scrollLeft, r = ratio();
    track.classList.add('dragging');
    const move = (ev) => { area.scrollLeft = s0 + (ev.clientX - x0) * r; };
    const up = () => { track.classList.remove('dragging'); window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up); };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  });
  track.addEventListener('mousedown', (e) => {   // 트랙 클릭: 그 위치로 썸 중앙 이동
    if (e.target === thumb) return;
    const rect = track.getBoundingClientRect();
    const tw = thumb.offsetWidth;
    area.scrollLeft = (e.clientX - rect.left - tw / 2) * ratio();
  });
}

function updateAddress() {
  const mode = state.cfg.addressBar;
  $('#toolbar').classList.toggle('hidden', mode === 'none');
  $('#omnibox').classList.toggle('blank', mode === 'blank');
  const d = state.activeName && state.docs.get(state.activeName);
  const chip = document.querySelector('#omnibox .chip');
  if (chip && !chip.dataset.tune) { chip.innerHTML = TUNE_ICON; chip.dataset.tune = '1'; }
  // 모든 조건에서 동일하게 arXiv 주소 (랜덤 ID) — 실제 arXiv PDF를 연 것처럼
  $('#url').textContent = mode === 'path' && d ? `arxiv.org/pdf/${arxivId(d)}` : '';
}

let hoverTimer = null, hoverWarm = false, hoverCool = null;
function hoverStart(el, d, pos = -1) {
  if (state.cfg.hoverCard === 'off' || !state.cur) return;
  clearTimeout(hoverTimer); clearTimeout(hoverCool);
  hoverTimer = setTimeout(() => {
    $('#hcTitle').textContent = tabLabel(d, state.cur.cond.method, pos);
    const r = el.getBoundingClientRect();
    const card = $('#hovercard');
    card.hidden = false;
    card.style.left = Math.max(4, Math.min(r.left, window.innerWidth - 248)) + 'px';
    card.style.top = (r.bottom + 4) + 'px';
    hoverWarm = true;
  }, hoverWarm ? 60 : 500);
}
function hoverEnd() {
  clearTimeout(hoverTimer);
  $('#hovercard').hidden = true;
  clearTimeout(hoverCool);
  hoverCool = setTimeout(() => { hoverWarm = false; }, 400);
}

/* =====================================================================
 * PDF 뷰어 (보이는 페이지만 렌더)
 * ===================================================================== */
function getViewer(doc) {
  let v = state.viewers.get(doc.name);
  if (v) return v;
  const el = document.createElement('div');
  el.className = 'viewer';
  $('#viewport').appendChild(el);
  v = { el, pdf: null, pages: [], scrollTop: 0, observer: null, dead: false };
  state.viewers.set(doc.name, v);
  v.ready = (async () => {
    const file = await doc.getFile();
    const buf = await file.arrayBuffer();
    v.pdf = await pdfjsLib.getDocument({ data: buf }).promise;
    if (v.dead) { v.pdf.destroy(); return; }
    const vp = (await v.pdf.getPage(1)).getViewport({ scale: 1 });
    v.observer = new IntersectionObserver((entries) => {
      for (const e of entries) {
        const pg = v.pages[+e.target.dataset.p];
        if (e.isIntersecting) renderPage(v, pg); else releasePage(pg);
      }
    }, { root: el, rootMargin: '1200px 0px' });
    for (let i = 0; i < v.pdf.numPages; i++) {
      const div = document.createElement('div');
      div.className = 'page';
      div.dataset.p = i;
      div.style.aspectRatio = `${vp.width} / ${vp.height}`;
      el.appendChild(div);
      v.pages.push({ i, div, canvas: null, task: null, status: 'idle', gen: 0 });
      v.observer.observe(div);
    }
  })();
  return v;
}
async function renderPage(v, pg) {
  if (pg.status !== 'idle' || v.dead) return;
  pg.status = 'loading';
  const gen = pg.gen;
  try {
    const page = await v.pdf.getPage(pg.i + 1);
    if (gen !== pg.gen) return;
    const base = page.getViewport({ scale: 1 });
    pg.div.style.aspectRatio = `${base.width} / ${base.height}`;
    const dpr = window.devicePixelRatio || 1;
    const vp = page.getViewport({ scale: ((pg.div.clientWidth || 900) / base.width) * dpr });
    const c = document.createElement('canvas');
    c.width = Math.floor(vp.width); c.height = Math.floor(vp.height);
    pg.canvas = c; pg.div.appendChild(c);
    pg.task = page.render({ canvasContext: c.getContext('2d'), viewport: vp });
    await pg.task.promise;
    if (gen === pg.gen) { pg.task = null; pg.status = 'done'; }
  } catch {
    if (gen === pg.gen) { pg.status = 'idle'; pg.task = null; }
  }
}
function releasePage(pg) {
  pg.gen++;
  if (pg.task) { try { pg.task.cancel(); } catch { /* */ } pg.task = null; }
  if (pg.canvas) { pg.canvas.width = 0; pg.canvas.height = 0; pg.canvas.remove(); pg.canvas = null; }
  pg.status = 'idle';
}
async function showViewer(doc) {
  const v = getViewer(doc);
  const loading = $('#loadingMsg');
  loading.hidden = false; loading.textContent = '불러오는 중…';
  try { await v.ready; } catch (e) { loading.textContent = 'PDF를 열 수 없습니다: ' + e.message; return; }
  if (state.activeName !== doc.name) return;
  loading.hidden = true;
  v.el.classList.add('show');
  v.el.scrollTop = v.scrollTop;
}
function hideViewer(name) {
  const v = state.viewers.get(name);
  if (!v) return;
  if (v.el.classList.contains('show')) v.scrollTop = v.el.scrollTop;
  v.el.classList.remove('show');
}
function destroyAllViewers() {
  for (const v of state.viewers.values()) {
    v.dead = true;
    if (v.observer) v.observer.disconnect();
    v.pages.forEach(releasePage);
    if (v.pdf) v.pdf.destroy();
    v.el.remove();
  }
  state.viewers.clear();
}

/* =====================================================================
 * 시행 진행
 * ===================================================================== */
let rafId = 0, limitTimer = 0;

function activate(name) {
  if (name === state.activeName) return;
  if (state.activeName) hideViewer(state.activeName);
  state.activeName = name;
  if (state.trial) state.trial.switches++;
  hoverEnd();
  renderTabs();
  showViewer(state.docs.get(name));
}

function onTabPick(name) {
  if (state.phase === 'explore') {
    activate(name);
    state.visited.add(name);
    renderTaskbox();
    return;
  }
  if (state.phase !== 'search') return;
  const t = state.trial;
  const idx = state.tabs.findIndex((d) => d.name === name) + 1;
  if (name === state.cur.target) {
    const elapsed = performance.now() - t.t0;
    t.clicks.push(idx);
    activate(name);
    finishTrial('success', elapsed);
    return;
  }
  if (name === state.activeName) return;   // 이미 보고 있는 탭을 다시 누른 것은 오답 아님
  t.clicks.push(idx);
  t.errors++;
  activate(name);
}

/* ---------- 읽기 단계 진행 ---------- */
function beginReading() {
  const order = readingOrder();
  const read = new Set(myReadLogs().map((l) => l.file));
  const idx = order.findIndex((n) => !read.has(n));   // 새로고침 후 이어 읽기
  if (idx < 0) return;
  destroyAllViewers();
  state.cur = null;
  state.phase = 'reading';
  state.reading = { order, idx, t0: 0, startIso: '' };
  $('#between').hidden = true;
  openReadingDoc();
}
function openReadingDoc() {
  const r = state.reading;
  const name = r.order[r.idx];
  destroyAllViewers();
  state.activeName = name;
  r.t0 = performance.now();
  r.startIso = new Date().toISOString();
  renderTabs();
  showViewer(state.docs.get(name));
  renderTaskbox();
  const tick = () => {
    if (state.phase !== 'reading') return;
    const left = Math.max(0, state.cfg.readMinSec * 1000 - (performance.now() - r.t0));
    if (left > 0) setClock(Math.ceil(left / 1000), 'idle');
    else { setClock('✓', 'running'); $('#btnStart').disabled = false; }
    rafId = requestAnimationFrame(tick);
  };
  cancelAnimationFrame(rafId);
  tick();
}
function readNext(force = false) {
  const r = state.reading;
  if (state.phase !== 'reading' || !r) return;
  const dur = performance.now() - r.t0;
  if (!force && dur < state.cfg.readMinSec * 1000) return;
  state.readLogs.push({
    participant_id: state.cfg.participantId,
    read_order: r.idx + 1,
    file: r.order[r.idx],
    read_s: +(dur / 1000).toFixed(3),
    min_s: state.cfg.readMinSec,
    admin: force ? 1 : '',
    start_iso: r.startIso,
    end_iso: new Date().toISOString(),
  });
  saveReadLogs();
  r.idx++;
  if (r.idx < r.order.length) { openReadingDoc(); return; }
  // 읽기 끝 → 실험 시작 화면
  cancelAnimationFrame(rafId);
  state.reading = null;
  state.phase = 'between';
  state.activeName = null;
  destroyAllViewers();
  renderTabs();
  renderTaskbox();
  showBetween();
  renderPlan();
}

/** 흐린 화면 버튼: 읽기 단계가 남아 있으면 읽기, 아니면 다음 시행 */
function onBetweenButton() {
  if (!readingDone()) beginReading(); else beginTrial();
}

/** 흐린 화면의 Start/Next → 다음 시행 준비 */
function beginTrial() {
  const plan = state.plan;
  const g = completedCount();
  const cur = plan && plan.trials[g];
  if (!cur) return;
  destroyAllViewers();
  state.cur = cur;
  state.tabs = shuffle(cur.set).map((n) => state.docs.get(n));
  state.activeName = null;
  state.visited = new Set();
  state.phase = 'explore';
  state.exploreT0 = performance.now();
  $('#between').hidden = true;
  $('#tabsArea').scrollLeft = 0;   // 새 시행은 탭 줄 맨 왼쪽부터
  const first = state.tabs[0];
  activate(first.name);
  state.visited.add(first.name);
  renderTaskbox();
}

function startSearch() {
  if (state.phase !== 'explore' || state.visited.size < state.tabs.length) return;
  state.phase = 'search';
  const now = performance.now();
  state.trial = {
    t0: now, startIso: new Date().toISOString(), exploreMs: now - state.exploreT0,
    errors: 0, switches: 0, clicks: [],
    startTabIndex: state.tabs.findIndex((d) => d.name === state.activeName) + 1,
  };
  const limitMs = state.cfg.timeLimit * 1000;
  limitTimer = setTimeout(() => finishTrial('timeout'), limitMs);
  const tick = () => {
    if (state.phase !== 'search') return;
    const left = Math.max(0, limitMs - (performance.now() - state.trial.t0));
    setClock(Math.ceil(left / 1000), left <= 10000 ? 'low' : 'running');
    rafId = requestAnimationFrame(tick);
  };
  tick();
  renderTaskbox();
}

function finishTrial(outcome, elapsedMs) {
  const t = state.trial;
  if (state.phase !== 'search' || !t) return;
  clearTimeout(limitTimer);
  cancelAnimationFrame(rafId);
  const limitMs = state.cfg.timeLimit * 1000;
  let dur = elapsedMs ?? performance.now() - t.t0;
  if (outcome === 'timeout' || dur > limitMs) { dur = limitMs; outcome = 'timeout'; }
  const cur = state.cur;
  const target = state.docs.get(cur.target);
  const success = outcome === 'success' ? 1 : 0;
  const plan = state.plan;
  state.logs.push({
    participant_id: state.cfg.participantId,
    participant_no: participantNo(),
    version: versionName(),
    latin_row: state.cfg.latin ? plan.row + 1 : '',
    seed: state.cfg.seed,
    trial_global: cur.g + 1,
    block: cur.block + 1,
    condition: condName(cur.cond),
    method: cur.cond.method,
    width_cond: cur.cond.width,
    tab_width_px: curWidth(),
    trial_in_block: cur.tInBlock + 1,
    success,
    outcome,
    elapsed_s: +(dur / 1000).toFixed(3),
    successful_completion_s: success ? +(dur / 1000).toFixed(3) : 'Missing',
    errors: t.errors,
    time_limit_s: state.cfg.timeLimit,
    explore_s: +(t.exploreMs / 1000).toFixed(3),
    target_tab_index: state.tabs.findIndex((d) => d.name === cur.target) + 1,
    target_file: cur.target,
    target_label: labelFor(target, cur.cond.method),
    cue: state.cfg.cueSource === 'thumb' ? '[thumbnail]' : cueFor(target, cur),
    cue_desc_no: state.cfg.cueSource === 'desc' ? cur.descNo : '',
    proposed_source: V.source === 'cloud' ? 'text_cloud_top1' : `${SOURCE_COLS[V.source].col}_${state.cfg.proposedRank}`,
    start_tab_index: t.startTabIndex,
    click_sequence: t.clicks.join('>'),
    tab_switches: t.switches,
    admin: t.admin ? 1 : '',          // 관리자 모드 '정답 처리'로 끝난 시행 (분석에서 제외)
    tab_order: state.tabs.map((d) => d.name).join(';'),
    tab_labels: state.tabs.map((d, i) => tabLabel(d, cur.cond.method, i)).join(';'),
    start_iso: t.startIso,
    end_iso: new Date().toISOString(),
  });
  saveLogs();
  state.trial = null;
  state.phase = 'between';
  showBetween(outcome);
  renderTaskbox();
  renderLogs();
  renderPlan();
}

/* ---------- 흐린 화면 ---------- */
function showBetween(lastOutcome) {
  const plan = state.plan;
  const box = $('#between');
  box.hidden = false;
  hoverEnd();
  const btn = $('#btnNext');
  const g = completedCount();
  if (!plan || !plan.ok) {
    $('#bSub').textContent = '준비 안 됨';
    $('#bCount').textContent = '—';
    $('#bNote').textContent = !state.docs.size ? '설정(⚙)에서 PDF 폴더를 선택하세요.'
      : `PDF가 부족합니다 (${plan.have}/${plan.need}개).`;
    btn.hidden = true;
    return;
  }
  if (!plan.metaOk) {
    $('#bSub').textContent = '준비 안 됨';
    $('#bCount').textContent = '—';
    $('#bNote').textContent = '설정(⚙)에서 아티클 정보 엑셀을 연결하세요.\n(description 단서' + (V.source !== 'cloud' ? ' · Proposed 라벨' : '') + '에 필요)';
    btn.hidden = true;
    return;
  }
  if (!readingDone()) {
    const pool = poolNames();
    const N = pool.length;
    const read = new Set(myReadLogs().map((l) => l.file));
    const k = pool.filter((n) => read.has(n)).length;
    $('#bSub').textContent = '읽기 단계';
    $('#bCount').textContent = `${k} / ${N}`;
    $('#bNote').textContent = `실험에 나올 아티클 ${N}개를 하나씩 읽습니다.\n원하는 만큼 읽고 '다음'을 누르세요${state.cfg.readMinSec ? ` (아티클당 최소 ${state.cfg.readMinSec}초)` : ''}.`;
    btn.hidden = false;
    btn.textContent = k ? '이어서 읽기' : '읽기 시작';
    return;
  }
  if (g >= plan.trials.length) {
    $('#bSub').textContent = `${state.cfg.participantId}`;
    $('#bCount').textContent = '완료';
    $('#bNote').textContent = '모든 실험을 마쳤습니다. 수고하셨습니다!';
    btn.hidden = true;
    return;
  }
  const cur = plan.trials[g];
  const T = state.cfg.trialsPerCond;
  const prev = g > 0 ? plan.trials[g - 1] : null;
  const blockChanged = prev && prev.block !== cur.block;
  $('#bSub').textContent = `블록 ${cur.block + 1} / ${plan.order.length}`;
  $('#bCount').textContent = `${cur.tInBlock} / ${T}`;
  $('#bNote').textContent = blockChanged ? `이전 블록 완료 (${T} / ${T})\n잠시 쉬었다가 시작하세요.` : '';
  btn.hidden = false;
  btn.textContent = cur.tInBlock === 0 ? 'Start' : 'Next';
}

/* ---------- 과제박스 ---------- */
function setClock(sec, cls) {
  const c = $('#tbClock');
  c.textContent = sec;
  c.className = 'tb-clock ' + cls;
}

async function drawThumb(doc) {
  const cv = $('#tbThumb');
  try {
    const buf = await (await doc.getFile()).arrayBuffer();
    const pdf = await pdfjsLib.getDocument({ data: buf }).promise;
    const page = await pdf.getPage(1);
    const base = page.getViewport({ scale: 1 });
    const dpr = window.devicePixelRatio || 1;
    const vp = page.getViewport({ scale: (312 / base.width) * dpr });
    cv.width = vp.width; cv.height = Math.min(vp.height, vp.width * 0.6); // 위쪽 일부만
    await page.render({ canvasContext: cv.getContext('2d'), viewport: vp }).promise;
    pdf.destroy();
  } catch (e) { console.warn('thumbnail 실패', e); }
}

function renderTaskbox() {
  const T = state.cfg.trialsPerCond;
  const cur = state.cur;
  const thumb = $('#tbThumb');
  const startBtn = $('#btnStart'), missBtn = $('#btnMissing');
  const reading = state.phase === 'reading' && state.reading;
  startBtn.textContent = reading ? (state.reading.idx + 1 < state.reading.order.length ? '다음 ▶' : '읽기 완료 ▶') : 'Start';
  missBtn.hidden = !!reading;
  if (reading) {
    const r = state.reading;
    $('#tbNo').textContent = `읽기 단계 · 아티클 ${r.idx + 1} / ${r.order.length}`;
    $('#tbText').innerHTML = `<span class="hint">원하는 만큼 읽은 뒤 다음을 누르세요.${state.cfg.readMinSec ? ` (최소 ${state.cfg.readMinSec}초)` : ''}</span>`;
    thumb.hidden = true;
    startBtn.disabled = performance.now() - r.t0 < state.cfg.readMinSec * 1000;
    missBtn.disabled = true;
  } else if (state.phase === 'explore' && cur) {
    const n = state.visited.size, K = state.tabs.length;
    $('#tbNo').textContent = `과제 ${cur.tInBlock + 1} / ${T}`;
    $('#tbText').innerHTML = n < K
      ? `<span class="hint">모든 탭을 한 번씩 확인하세요 (${n} / ${K})</span>`
      : `<span class="hint">준비되면 <b>Start</b>를 누르세요. 찾아야 할 탭이 표시됩니다.</span>`;
    thumb.hidden = true;
    setClock(state.cfg.timeLimit, 'idle');
    startBtn.disabled = n < K;
    missBtn.disabled = true;
  } else if (state.phase === 'search' && cur) {
    const target = state.docs.get(cur.target);
    $('#tbNo').textContent = `과제 ${cur.tInBlock + 1} / ${T} · 이 탭을 찾아 클릭하세요`;
    if (state.cfg.cueSource === 'thumb') {
      $('#tbText').innerHTML = '';
      thumb.hidden = false;
      drawThumb(target);
    } else {
      const cue = cueFor(target, cur);
      $('#tbText').innerHTML = cue ? `<span class="cue">${esc(cue)}</span>` : '<span class="hint">진행자가 안내한 탭을 찾아 클릭하세요.</span>';
      thumb.hidden = true;
    }
    startBtn.disabled = true;
    missBtn.disabled = false;
  } else {
    $('#tbNo').textContent = '';
    $('#tbText').innerHTML = '<span class="hint">대기 중</span>';
    thumb.hidden = true;
    setClock(state.cfg.timeLimit, 'idle');
    startBtn.disabled = true;
    missBtn.disabled = true;
  }
  // 관리자 모드: 단계 건너뛰기 버튼
  const adm = $('#btnAdminNext');
  const admOn = state.cfg.admin && (reading || ((state.phase === 'explore' || state.phase === 'search') && cur));
  adm.hidden = !admOn;
  if (admOn) adm.textContent = reading ? '⏭ 다음 아티클' : state.phase === 'explore' ? '⏭ 탭 확인 완료' : '⏭ 정답 처리';
  $('#tbAdmin').hidden = !state.cfg.admin;
}

/** 관리자 모드 넥스트 스텝: 읽기 → 다음 아티클 / 탐색 → 모든 탭 확인 처리 / 검색 → 정답 처리 */
function adminNext() {
  if (!state.cfg.admin) return;
  if (state.phase === 'reading') { readNext(true); return; }
  if (state.phase === 'explore') { state.tabs.forEach((d) => state.visited.add(d.name)); renderTaskbox(); return; }
  if (state.phase === 'search' && state.trial) { state.trial.admin = true; onTabPick(state.cur.target); }
}

/** 설정이 바뀌면 진행 중이던 시행을 버리고 흐린 화면으로 */
function resetToBetween() {
  clearTimeout(limitTimer);
  cancelAnimationFrame(rafId);
  state.trial = null;
  state.reading = null;
  state.cur = null;
  state.tabs = [];
  state.activeName = null;
  state.phase = 'between';
  destroyAllViewers();
  renderTabs();
  renderTaskbox();
  showBetween();
}

/* =====================================================================
 * 폴더 로드
 * ===================================================================== */
function parseCsv(text) {
  text = text.replace(/^\ufeff/, '');
  const rows = []; let row = [], f = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) {
      if (ch === '"') { if (text[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += ch;
    } else if (ch === '"') q = true;
    else if (ch === ',') { row.push(f); f = ''; }
    else if (ch === '\n') { row.push(f); rows.push(row); row = []; f = ''; }
    else if (ch !== '\r') f += ch;
  }
  if (f || row.length) { row.push(f); rows.push(row); }
  return rows;
}

/** entries: [{name,size,lastModified,getFile}] */
async function loadEntries(entries, folderName, cueText) {
  const prog = $('#progress');
  prog.hidden = false;
  state.folderName = folderName;
  state.cues = new Map();
  if (cueText) {
    for (const r of parseCsv(cueText)) {
      const fn = (r[0] || '').trim();
      if (/\.pdf$/i.test(fn) && (r[1] || '').trim()) state.cues.set(fn, r.slice(1).join(',').trim());
    }
  }
  let cache = new Map();
  try { cache = await cacheAll(); } catch (e) { console.warn('캐시 사용 불가', e); }

  const docs = new Map();
  const todo = [];
  for (const e of entries) {
    const key = `${e.name}|${e.size}|${e.lastModified}`;
    const d = { name: e.name, size: e.size, lastModified: e.lastModified, getFile: e.getFile, key };
    const c = cache.get(key);
    if (c) Object.assign(d, c); else todo.push(d);
    docs.set(e.name, d);
  }
  let done = 0;
  const failed = [];
  const worker = async () => {
    while (todo.length) {
      const d = todo.shift();
      try {
        const buf = await (await d.getFile()).arrayBuffer();
        const r = await extractText(buf);
        Object.assign(d, r);
        try { await cachePut(d.key, r); } catch { /* 캐시 실패 무시 */ }
      } catch (err) {
        console.error(d.name, err);
        Object.assign(d, { text: '', numPages: 0, metaTitle: '', paperTitle: '' });
        failed.push(d.name);
      }
      done++;
      prog.textContent = `텍스트 추출 중… ${done} / ${done + todo.length} (처음 한 번만, 이후 캐시 사용)`;
    }
  };
  const total = todo.length;
  if (total) prog.textContent = `텍스트 추출 중… 0 / ${total}`;
  await Promise.all([worker(), worker(), worker()]);
  state.docs = docs;
  recomputeKeywords();
  prog.textContent = total ? `추출 완료 (${total}개${failed.length ? `, 실패 ${failed.length}개: ${failed.join(', ')}` : ''})` : '';
  prog.hidden = !total;
  onPlanInputsChanged();
}

function setBaseIcon(file) {
  if (state.baseIconUrl) URL.revokeObjectURL(state.baseIconUrl);
  state.baseIconUrl = file ? URL.createObjectURL(file) : null;
}

async function scanHandle(h) {
  setBaseIcon(null);
  const entries = [];
  let cueText = '';
  let xlsx = null;
  for await (const [name, fh] of h.entries()) {
    if (fh.kind !== 'file') continue;
    if (/\.pdf$/i.test(name)) {
      const f = await fh.getFile();
      entries.push({ name, size: f.size, lastModified: f.lastModified, getFile: () => fh.getFile() });
    } else if (/^cues\.csv$/i.test(name)) {
      cueText = await (await fh.getFile()).text();
    } else if (/^baseline_icon\.(png|ico|svg|jpe?g|gif|webp)$/i.test(name)) {
      setBaseIcon(await fh.getFile());
    } else if (/\.xlsx?$/i.test(name) && !name.startsWith('~$') && !xlsx) {
      xlsx = await fh.getFile();
    }
  }
  state.dirHandle = h;
  $('#btnReconnect').hidden = true;
  if (xlsx) await loadMetaFileQuiet(xlsx);
  await loadEntries(entries, h.name, cueText);
}

async function loadFromInput(fileList) {
  const files = [...fileList];
  // 폴더 바로 아래 파일만 (하위 폴더 제외)
  const top = files.filter((f) => !f.webkitRelativePath || f.webkitRelativePath.split('/').length === 2);
  const folder = (files[0] && files[0].webkitRelativePath.split('/')[0]) || '';
  const cueFile = top.find((f) => /^cues\.csv$/i.test(f.name));
  const xlsx = top.find((f) => /\.xlsx?$/i.test(f.name) && !f.name.startsWith('~$'));
  if (xlsx) await loadMetaFileQuiet(xlsx);
  setBaseIcon(top.find((f) => /^baseline_icon\.(png|ico|svg|jpe?g|gif|webp)$/i.test(f.name)) || null);
  const entries = top.filter((f) => /\.pdf$/i.test(f.name))
    .map((f) => ({ name: f.name, size: f.size, lastModified: f.lastModified, getFile: async () => f }));
  state.dirHandle = null;
  await loadEntries(entries, folder, cueFile ? await cueFile.text() : '');
}

async function pickFolder() {
  if (window.showDirectoryPicker) {
    try {
      const h = await window.showDirectoryPicker({ id: 'tabsim-pdfs', mode: 'read' });
      try { await handlePut(h); } catch { /* 저장 실패 무시 */ }
      await scanHandle(h);
      return;
    } catch (e) {
      if (e.name === 'AbortError') return;
      console.warn('showDirectoryPicker 실패, 기본 폴더 선택으로 대체', e);
    }
  }
  $('#dirInput').click();
}

async function reconnect() {
  try {
    const h = await handleGet();
    if (!h) return;
    if ((await h.requestPermission({ mode: 'read' })) === 'granted') await scanHandle(h);
  } catch (e) { console.warn(e); }
}

/* =====================================================================
 * 설정 패널
 * ===================================================================== */
function onPlanInputsChanged() {
  state.plan = buildPlan();
  if (state.phase !== 'between') resetToBetween(); else showBetween();
  renderSetup();
}

function renderSetup() {
  $('#versionTitle').textContent = versionName();
  document.title = versionName();
  renderFolder();
  renderPlan();
  renderWidthInfo();
  renderDocs();
  renderLogs();
}

function renderMeta() {
  const m = state.meta;
  const el = $('#metaStatus');
  if (!m) {
    el.innerHTML = needsMeta() ? '<span class="bad">엑셀이 연결되지 않았습니다 — "📊 엑셀 선택" 또는 PDF 폴더에 xlsx를 두세요.</span>'
      : '엑셀이 연결되지 않았습니다 (현재 설정에서는 선택 사항).';
    return;
  }
  const pool = poolNames();
  const matched = pool.filter((n) => metaFor(state.docs.get(n))).length;
  const withDesc = pool.filter((n) => (metaFor(state.docs.get(n)) || { desc: [] }).desc.length).length;
  el.innerHTML = `📊 <b>${esc(m.source)}</b> · ${m.rows.length}행 · 사용 아티클 ${pool.length}개 중 매칭 ` +
    `<b class="${matched === pool.length ? 'good' : 'bad'}">${matched}</b> · description 있음 ${withDesc}` +
    (V.source !== 'cloud' ? ` · Proposed 열: <b>${SOURCE_COLS[V.source].col}_${state.cfg.proposedRank}</b>` : '');
}

function renderFolder() {
  renderMeta();
  const n = state.docs.size;
  const cues = state.cues.size;
  $('#folderStatus').innerHTML = n
    ? `📁 <b>${esc(state.folderName || '(폴더)')}</b> · PDF <b>${n}</b>개` +
      (cues ? ` · cues.csv 단서 ${cues}개` : ' · cues.csv 없음') +
      (state.dirHandle ? '' : ' <span class="muted">(새로고침하면 폴더를 다시 선택해야 함)</span>')
    : '폴더가 선택되지 않았습니다.';
}

function renderPlan() {
  const p = state.plan;
  const c = state.cfg;
  const done = completedCount();
  $('#pidInfo').innerHTML = p
    ? `참가자 번호 <b>${participantNo()}</b>` + (c.latin ? ` → Latin square 행 <b>${p.row + 1}</b> / ${CONDS.length}` : ' · Latin square 끔 (고정 순서)') +
      `<br>진행: <b>${Math.min(done, p.total)}</b> / ${p.total} 시행`
    : '';
  const T = c.trialsPerCond;
  $('#planRows').innerHTML = p ? p.order.map((ci, b) => {
    const cond = CONDS[ci];
    const k = Math.max(0, Math.min(T, done - b * T));
    const cls = k >= T ? 'done' : (done >= b * T && done < (b + 1) * T ? 'current' : '');
    return `<tr class="${cls}"><td>${b + 1}</td><td>C${ci + 1}</td>
      <td class="${cond.method === 'baseline' ? 'cond-b' : 'cond-p'}">${cond.method === 'baseline' ? 'Baseline' : 'Proposed'}</td>
      <td>${cond.width} (${c.widths[cond.width]}px)</td><td>${k} / ${T}</td></tr>`;
  }).join('') : '';
  const have = state.docs.size;
  const pool = poolNames();
  $('#needInfo').innerHTML = !have ? 'PDF 폴더를 선택하세요.' : !p.ok
    ? `<span class="bad">✗ 폴더의 PDF(${have}개)가 선택한 아티클 수(${c.poolSize}개)보다 적습니다.</span>`
    : `아티클 <b>${p.P}</b>개 (파일명 순 앞 ${p.P}개: ${esc(pool[0])} … ${esc(pool[pool.length - 1])}) · ` +
      `6 조건 × ${c.trialsPerCond} = <b>${p.total}</b> 시행 · 시행당 탭 ${p.K}개` +
      `<br>정답(찾을 탭): 아티클마다 정확히 <b class="good">${p.targetSpan}회</b> (${p.total} ÷ ${p.P})` +
      ` · 탭 등장: 아티클마다 <b>${p.shownSpan}</b>회` +
      (p.K === p.P ? ' (매 시행 모든 아티클이 탭으로 열림)' : '') +
      (c.cueSource === 'desc' ? `<br>단서: description — 참가자마다 아티클별로 ${p.descRepeat ? '<span class="bad">⚠ 정답 횟수가 description 수보다 많아 일부 반복</span>' : '<span class="good">중복 없이</span>'} 랜덤 배정` : '') +
      `<br>배정은 시드 ${c.seed}로 고정 (모든 참가자 동일). 조건 순서만 Latin square로 바뀌므로 같은 정답이 참가자마다 다른 조건에 놓입니다.`;
  const read = new Set(myReadLogs().map((l) => l.file));
  const k = pool.filter((n) => read.has(n)).length;
  if (p) $('#pidInfo').innerHTML += `<br>읽기 단계: ${c.reading ? `<b>${k}</b> / ${pool.length}` : '끔'}`;
}

function renderWidthInfo() {
  const c = state.cfg;
  const K = c.tabsPerTrial;
  const avail = Math.max(0, $('#tabsArea').clientWidth - 44);
  const chars = (px) => `약 ${Math.floor(px / TAB.CHAR_PX)}자`;
  const desc = (v, active, icon) => {
    const p = tabParts(v, active, icon);
    const parts = [];
    if (p.fav) parts.push('아이콘');
    if (p.titleW) parts.push(`글자 ${p.titleW}px(${chars(p.titleW)})`);
    if (p.close) parts.push('닫기');
    return parts.join('+') || '빈 탭';
  };
  $('#widthInfo').innerHTML = `<table class="mini"><tr><th></th><th>Baseline 비활성</th><th>Baseline 활성</th><th>Proposed 비활성</th><th>Proposed 활성</th></tr>` +
    WIDTHS.map((w) => {
      const v = c.widths[w];
      const over = v * K > avail;
      return `<tr><td><b>${w}</b> ${v}px${over ? ` <span class="muted" title="탭 ${K}개 × ${v}px > ${avail}px → 탭 줄 좌우 스크롤">↔ 스크롤</span>` : ''}</td>` +
        `<td>${desc(v, false, true)}</td><td>${desc(v, true, true)}</td><td>${desc(v, false, false)}</td><td>${desc(v, true, false)}</td></tr>`;
    }).join('') + '</table>';
}

function renderDocs() {
  const names = [...state.docs.keys()].sort(natural);
  const inPool = new Set(poolNames());
  $('#docRows').innerHTML = names.map((n, i) => {
    const d = state.docs.get(n);
    const ov = (state.cfg.overrides[n] || '').trim();
    let kwHtml;
    if (V.source === 'cloud') {
      const kw = state.keywords.get(n) || [];
      kwHtml = kw.length ? kw.slice(0, 5).map((k, j) => j === 0 ? `<b>${esc(k.w)}</b>(${k.c})` : `${esc(k.w)}(${k.c})`).join(', ')
        : '<span class="warn">텍스트 없음</span>';
    } else {
      const list = proposedList(d);
      kwHtml = list.length ? list.map((w, j) => (j + 1 === state.cfg.proposedRank ? `<b>${j + 1}. ${esc(w)}</b>` : `${j + 1}. ${esc(w)}`)).join(' · ')
        : '<span class="warn">엑셀 값 없음</span>';
    }
    const md = metaFor(d);
    const cue = md && md.desc.length ? `${md.desc.length}개 — ${md.desc[0]}` : state.cues.get(n);
    return `<tr data-name="${esc(n)}"${inPool.has(n) ? '' : ' class="done" title="이번 설정의 아티클 수 밖 — 사용 안 함"'}>
      <td>${i + 1}</td><td class="fname">${esc(n)}</td><td>${d.numPages ?? ''}</td>
      <td class="btitle"><span class="lbl base">${esc(baselineTitle(d))}</span><br><span class="muted small">${esc(arxivId(d))}</span></td>
      <td class="kw">${kwHtml}</td>
      <td><span class="lbl${ov ? ' ov' : ''}">${esc(proposedLabel(d))}</span></td>
      <td><input class="ovr" type="text" placeholder="${esc(autoProposed(d) || '')}" value="${esc(ov)}"></td>
      <td class="small">${cue ? esc(cue) : '<span class="muted">—</span>'}</td></tr>`;
  }).join('') || '<tr><td colspan="8" class="muted">PDF 폴더를 선택하세요.</td></tr>';
}

function renderLogs() {
  const RES = { success: '성공', timeout: '시간 초과', missing: 'Missing' };
  $('#logCount').textContent = `(${state.logs.length}건)`;
  $('#logRows').innerHTML = state.logs.map((l, i) => `<tr title="${esc(l.target_file)} · ${esc(l.start_iso)}">
    <td>${esc(l.participant_id)}</td><td>${l.trial_global}</td><td>${l.block}</td>
    <td class="${l.method === 'baseline' ? 'cond-b' : 'cond-p'}">${esc(l.condition)}</td><td>${l.trial_in_block}</td>
    <td class="num">${l.success}</td><td class="num">${l.elapsed_s.toFixed(1)}s</td>
    <td class="num">${l.success ? l.successful_completion_s.toFixed(1) + 's' : 'Missing'}</td>
    <td class="num">${l.errors}</td><td><span class="res ${l.outcome}">${RES[l.outcome]}</span>${l.admin ? ' <span class="res admin">ADMIN</span>' : ''}</td>
    <td><button class="small danger" data-log="${i}">삭제</button></td></tr>`).reverse().join('')
    || '<tr><td colspan="11" class="muted">기록 없음</td></tr>';
}

const CSV_COLS = ['participant_id', 'participant_no', 'version', 'latin_row', 'seed', 'trial_global', 'block', 'condition',
  'method', 'width_cond', 'tab_width_px', 'trial_in_block', 'success', 'outcome', 'elapsed_s', 'successful_completion_s',
  'errors', 'time_limit_s', 'explore_s', 'target_tab_index', 'target_file', 'target_label', 'cue', 'cue_desc_no', 'proposed_source', 'start_tab_index',
  'click_sequence', 'tab_switches', 'tab_order', 'tab_labels', 'admin', 'start_iso', 'end_iso'];

function downloadCsv() { downloadRows(state.logs, CSV_COLS, 'trials'); }
function downloadRows(rows, cols, kind) {
  const q = (v) => { const s = String(v ?? ''); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
  const lines = [cols.join(',')].concat(rows.map((l) => cols.map((c) => q(l[c])).join(',')));
  const blob = new Blob(['\ufeff' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `tabsim_${PROPOSED_NAME.replace(/\s+/g, '_')}_${kind}_${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.csv`;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

function renderSetupValues() {
  const c = state.cfg;
  $('#cfgPid').value = c.participantId;
  $('#cfgBaseline').value = c.baselineMode;
  $('#cfgDoiConst').value = c.doiConst;
  $('#cfgCue').value = c.cueSource;
  $('#cfgNumber').checked = c.proposedNumber !== false;
  if (V.source !== 'cloud') {
    const sc = SOURCE_COLS[V.source];
    $('#cfgRank').innerHTML = Array.from({ length: sc.n }, (_, i) => `<option value="${i + 1}">${sc.col}_${i + 1}${i === 0 ? ' (가장 중요, 기본)' : ''}</option>`).join('');
    $('#cfgRank').value = String(c.proposedRank);
  }
  $('#cfgWN').value = c.widths.narrow;
  $('#cfgWM').value = c.widths.middle;
  $('#cfgWW').value = c.widths.wide;
  $('#cfgPool').value = String(c.poolSize);
  $('#cfgTPC').innerHTML = validNs().map((n) => `<option value="${n}">${n}  (총 ${CONDS.length * n} 시행 · 아티클마다 정답 ${CONDS.length * n / c.poolSize}회)</option>`).join('');
  $('#cfgTPC').value = String(c.trialsPerCond);
  $('#cfgTPT').max = c.poolSize;
  $('#cfgTPT').value = c.tabsPerTrial;
  $('#cfgLimit').value = c.timeLimit;
  $('#cfgSeed').value = c.seed;
  $('#cfgLatin').checked = c.latin;
  $('#cfgAdmin').checked = !!c.admin;
  $('#cfgRead').checked = c.reading;
  $('#cfgReadMin').value = c.readMinSec;
  $('#cfgReadOrder').value = c.readOrder;
  $('#cfgAddr').value = c.addressBar;
  $('#cfgHover').value = c.hoverCard;
  $('#cfgMinLen').value = c.minLen;
  $('#cfgCase').value = c.labelCase;
  $('#cfgRefs').checked = c.cutReferences;
  $('#cfgPlural').checked = c.mergePlurals;
  $('#cfgStop').value = c.extraStopwords;
}

function applyVersionUI() {
  document.title = versionName();
  $('#secKeywords').hidden = V.source !== 'cloud';
  $('#wrapRank').hidden = V.source === 'cloud';
  $('#propDesc').value = V.source === 'cloud' ? 'text cloud — 본문 빈도 Top-1 단어'
    : V.source === 'llm' ? 'text LLM — 엑셀 LLM_text (본문 의미 단어)' : 'text title LLM — 엑셀 title_text_LLM (제목 중요 단어)';
  $('#thSource').textContent = V.source === 'cloud' ? 'Top-5 단어 (빈도)' : `${SOURCE_COLS[V.source].col} 1~${SOURCE_COLS[V.source].n}`;
}

function openSetup() { $('#setup').hidden = false; hoverEnd(); renderSetupValues(); renderSetup(); }
function closeSetup() { $('#setup').hidden = true; renderTabs(); }

function bindSetup() {
  const c = state.cfg;
  const int = (v, lo, hi, d) => { const n = parseInt(v, 10); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d; };
  // 세션 계획에 영향 → 진행 중 시행 리셋
  const plan = (sel, fn) => $(sel).addEventListener('change', (e) => { fn(e.target); saveCfg(); renderSetupValues(); onPlanInputsChanged(); });
  plan('#cfgPid', (t) => { c.participantId = t.value.trim() || 'P01'; });
  plan('#cfgPool', (t) => { c.poolSize = +t.value; snapTrialsPerCond(); });
  plan('#cfgTPC', (t) => { c.trialsPerCond = +t.value; snapTrialsPerCond(); });
  plan('#cfgTPT', (t) => { c.tabsPerTrial = int(t.value, 2, c.poolSize, 10); });
  plan('#cfgSeed', (t) => { c.seed = int(t.value, 1, 1e9, 1); });
  plan('#cfgLatin', (t) => { c.latin = t.checked; });
  plan('#cfgRead', (t) => { c.reading = t.checked; });
  plan('#cfgReadMin', (t) => { c.readMinSec = int(t.value, 0, 600, 0); });
  plan('#cfgReadOrder', (t) => { c.readOrder = t.value; });
  // 화면에만 영향
  const view = (sel, fn) => $(sel).addEventListener('change', (e) => { fn(e.target); saveCfg(); renderSetup(); renderTabs(); renderTaskbox(); });
  view('#cfgWN', (t) => { c.widths.narrow = int(t.value, 20, 400, 40); });
  view('#cfgWM', (t) => { c.widths.middle = int(t.value, 20, 400, 80); });
  view('#cfgWW', (t) => { c.widths.wide = int(t.value, 20, 400, 160); });
  view('#cfgLimit', (t) => { c.timeLimit = int(t.value, 5, 600, 60); });
  view('#cfgBaseline', (t) => { c.baselineMode = t.value; });
  view('#cfgDoiConst', (t) => { c.doiConst = int(t.value, 100000, 9999999999, 7392581); computeIds(); });
  plan('#cfgCue', (t) => { c.cueSource = t.value; });
  view('#cfgNumber', (t) => { c.proposedNumber = t.checked; });
  plan('#cfgRank', (t) => { c.proposedRank = parseInt(t.value, 10) || 1; });
  $('#btnPickXlsx').addEventListener('click', () => $('#xlsxInput').click());
  $('#xlsxInput').addEventListener('change', (e) => { if (e.target.files[0]) loadMetaFile(e.target.files[0]); e.target.value = ''; });
  view('#cfgAddr', (t) => { c.addressBar = t.value; });
  view('#cfgHover', (t) => { c.hoverCard = t.value; });
  view('#cfgAdmin', (t) => { c.admin = t.checked; });
  const kw = (sel, fn) => $(sel).addEventListener('change', (e) => { fn(e.target); saveCfg(); recomputeKeywords(); renderSetup(); renderTabs(); });
  kw('#cfgMinLen', (t) => { c.minLen = int(t.value, 1, 10, 3); });
  kw('#cfgCase', (t) => { c.labelCase = t.value; });
  kw('#cfgRefs', (t) => { c.cutReferences = t.checked; });
  kw('#cfgPlural', (t) => { c.mergePlurals = t.checked; });
  let stopTimer = null;
  $('#cfgStop').addEventListener('input', (e) => {
    clearTimeout(stopTimer);
    stopTimer = setTimeout(() => { c.extraStopwords = e.target.value; saveCfg(); recomputeKeywords(); renderSetup(); renderTabs(); }, 400);
  });
  $('#btnResetStop').addEventListener('click', () => {
    c.extraStopwords = DEFAULT_EXTRA_STOP; $('#cfgStop').value = c.extraStopwords; saveCfg(); recomputeKeywords(); renderSetup(); renderTabs();
  });
  $('#docRows').addEventListener('change', (e) => {
    if (!e.target.classList.contains('ovr')) return;
    const n = e.target.closest('tr').dataset.name;
    const v = e.target.value.trim();
    if (v) c.overrides[n] = v; else delete c.overrides[n];
    saveCfg(); renderDocs(); renderTabs();
  });

  $('#btnPickDir').addEventListener('click', pickFolder);
  $('#btnReconnect').addEventListener('click', reconnect);
  $('#btnRescan').addEventListener('click', () => { if (state.dirHandle) scanHandle(state.dirHandle); else pickFolder(); });
  $('#dirInput').addEventListener('change', (e) => { if (e.target.files.length) loadFromInput(e.target.files); e.target.value = ''; });

  $('#btnResetPid').addEventListener('click', () => {
    const n = myLogs().length, r = myReadLogs().length;
    if (!n && !r) return;
    if (!confirm(`${c.participantId}의 시행 기록 ${n}건과 읽기 기록 ${r}건을 삭제하고 처음(읽기 단계)부터 시작할까요? (먼저 CSV를 받아두세요)`)) return;
    state.logs = state.logs.filter((l) => l.participant_id !== c.participantId);
    state.readLogs = state.readLogs.filter((l) => l.participant_id !== c.participantId);
    saveLogs(); saveReadLogs(); onPlanInputsChanged();
  });
  $('#btnCsv').addEventListener('click', downloadCsv);
  $('#btnReadCsv').addEventListener('click', () => downloadRows(state.readLogs,
    ['participant_id', 'read_order', 'file', 'read_s', 'min_s', 'admin', 'start_iso', 'end_iso'], 'reading'));
  $('#btnClearLogs').addEventListener('click', () => {
    if (!state.logs.length) return;
    if (!confirm(`측정 기록 ${state.logs.length}건을 모두 삭제할까요? (먼저 CSV로 받아두는 것을 권장)`)) return;
    state.logs = []; saveLogs(); onPlanInputsChanged();
  });
  $('#logRows').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-log]');
    if (!b || !confirm('이 기록을 삭제할까요? (해당 시행을 다시 하게 됩니다)')) return;
    state.logs.splice(+b.dataset.log, 1); saveLogs(); onPlanInputsChanged();
  });
  $('#btnCloseSetup').addEventListener('click', closeSetup);
  $('#btnResetCfg').addEventListener('click', () => {
    if (!confirm('모든 설정을 기본값으로 되돌릴까요?\n(참가자 ID, 아티클 수·시행 수·탭 수, 탭 폭, 라벨·단서, 읽기, 관리자 모드, 키워드 규칙, 수동 라벨 등)\n\n측정 기록·읽기 기록·불러온 PDF 폴더는 그대로 유지됩니다.')) return;
    // 같은 객체를 유지한 채 내용만 교체 (설정 핸들러들이 state.cfg 참조를 잡고 있음)
    for (const k of Object.keys(state.cfg)) delete state.cfg[k];
    Object.assign(state.cfg, JSON.parse(JSON.stringify(DEFAULT_CFG)));
    saveCfg();
    recomputeKeywords();
    renderSetupValues();
    onPlanInputsChanged();   // 진행 중 시행은 취소되고 흐린 화면으로
  });
}

/* =====================================================================
 * 시작
 * ===================================================================== */
async function init() {
  applyVersionUI();
  bindSetup();
  $('#btnStart').addEventListener('click', () => (state.phase === 'reading' ? readNext() : startSearch()));
  $('#btnMissing').addEventListener('click', () => finishTrial('missing'));
  $('#btnAdminNext').addEventListener('click', adminNext);
  $('#btnNext').addEventListener('click', onBetweenButton);
  $('#btnSetup').addEventListener('click', () => ($('#setup').hidden ? openSetup() : closeSetup()));
  document.addEventListener('keydown', (e) => {
    if (e.ctrlKey && e.shiftKey && (e.key === 'S' || e.key === 's')) { e.preventDefault(); $('#setup').hidden ? openSetup() : closeSetup(); }
  });
  window.addEventListener('resize', () => { if (!$('#setup').hidden) renderWidthInfo(); });
  bindTabScroll();
  // 탭 줄: 세로 휠을 좌우 스크롤로
  $('#tabsArea').addEventListener('wheel', (e) => {
    const a = e.currentTarget;
    if (a.scrollWidth <= a.clientWidth || Math.abs(e.deltaX) > Math.abs(e.deltaY)) return;
    a.scrollLeft += e.deltaY;
    e.preventDefault();
  }, { passive: false });

  snapTrialsPerCond();
  saveCfg();
  state.plan = buildPlan();
  renderTaskbox();
  showBetween();

  // 이전에 고른 폴더가 있으면 권한 확인 후 자동 로드
  try {
    const h = await handleGet();
    if (h) {
      if ((await h.queryPermission({ mode: 'read' })) === 'granted') { await scanHandle(h); return; }
      $('#btnReconnect').hidden = false;
      $('#btnReconnect').textContent = `🔗 이전 폴더 "${h.name}" 다시 연결`;
    }
  } catch (e) { console.warn(e); }
  openSetup();
}

init();
