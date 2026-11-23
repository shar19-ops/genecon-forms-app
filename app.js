'use strict';
/*
 * ゼネコン帳票 取込・記入（試作）
 *  ゼネコンの書式（PDF・画像）を背景にして、入力欄を四角で配置 → 記入 → 100%で印刷する。
 *  データの置き場所：帳票（背景画像・欄の配置）は IndexedDB、記入内容と共通情報は localStorage。
 *  帳票は「帳票ファイル（.json）」に書き出して、ほかの人に渡せる。
 */

const pdfjsLib = window.pdfjsLib;
if (pdfjsLib) pdfjsLib.GlobalWorkerOptions.workerSrc = 'vendor/pdf.worker.min.js';

const MM_PER_PT = 25.4 / 72;
const PX_PER_MM = 96 / 25.4;
const RENDER_DPI = 200;
const FONTS = {
  gothic: '"BIZ UDPGothic","BIZ UDPゴシック","Yu Gothic","YuGothic","Meiryo",sans-serif',
  mincho: '"BIZ UDPMincho","BIZ UDP明朝 Medium","Yu Mincho","YuMincho","MS Mincho",serif',
};
const TYPES = {
  text:   { name: '文字（1行）',  short: '文字',     icon: 'Aa' },
  multi:  { name: '文字（複数行）', short: '複数行', icon: '¶' },
  number: { name: '数値',         short: '数値',     icon: '123' },
  date:   { name: '日付',         short: '日付',     icon: '日' },
  check:  { name: 'チェック・○囲み', short: 'チェック', icon: '✓' },
  choice: { name: '記号（○△×を切替）', short: '記号', icon: '○△' },
  stamp:  { name: 'デート印',     short: '印',       icon: '印' },
};
const DATE_FORMATS = [
  ['wareki', '令和8年11月22日'],
  ['wa_num', '8年11月22日（「令和」が印刷済み）'],
  ['seireki', '2026年11月22日'],
  ['slash', '2026/11/22'],
  ['yslash', '26/11/22（西暦下2桁）'],
  ['y', '年だけ（和暦 8）'],
  ['Y', '年だけ（西暦 2026）'],
  ['y2', '年だけ（西暦の下2桁 26。「20　年」と印刷済み）'],
  ['m', '月だけ（11）'],
  ['d', '日だけ（22）'],
];
const MARKS = [
  ['check', '✓ チェック'],
  ['circle', '○ 囲み（欄いっぱいの楕円）'],
  ['cross', '✕'],
  ['dot', '● 塗りつぶし'],
];
const PAPERS = { A4: [210, 297], A3: [297, 420], B4: [257, 364], B5: [182, 257] };
const PROFILE = [
  { group: '会社', items: [['company', '会社名'], ['companyKana', '会社名（フリガナ）'], ['zip', '郵便番号'], ['address', '所在地'], ['tel', '電話番号'], ['fax', 'FAX番号'], ['ceoTitle', '代表者の役職'], ['ceo', '代表者名'], ['permit', '建設業許可番号'], ['branch', '支店・営業所名']] },
  { group: '工事', items: [['koji', '工事名'], ['kojiNo', '工番'], ['site', '工事場所'], ['genecon', '元請（ゼネコン）名'], ['term', '工期'], ['agent', '現場代理人'], ['chief', '主任技術者'], ['tanto', '担当者'], ['tantoTel', '担当者の連絡先']] },
  { group: 'デート印', items: [['stampName', '苗字'], ['stampTitle', '役職（空欄なら苗字を上下に分けます）']] },
];
const PROFILE_KEY = 'gfa:profile';
const vKey = (id) => 'gfa:v:' + id;
const bgKey = (id) => 'gfa:bg:' + id;
const notextKey = (id, i) => `${id}:${i}:notext`; // 文字だけを抜いて描いた背景（PDFのとき。IndexedDB の img ストア）
const origKey = (id, i) => `${id}:${i}:orig`;    // 手直しする前の背景画像

/* ---------- 小物 ---------- */
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const pad = (n) => String(n).padStart(2, '0');
const r05 = (v) => Math.round(v * 2) / 2;
const r1 = (v) => Math.round(v * 10) / 10;
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const today = () => { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
const safeName = (s) => String(s || '').replace(/[\\/:*?"<>|]/g, '_').trim() || '帳票';
function h(html) { const t = document.createElement('template'); t.innerHTML = html.trim(); return t.content.firstElementChild; }
let toastTimer;
function toast(msg, ms = 2600) { const t = $('#toast'); t.textContent = msg; t.classList.add('on'); clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('on'), ms); }
function debounce(fn, ms) {
  let t = null;
  const d = (...a) => { clearTimeout(t); t = setTimeout(() => { t = null; fn(...a); }, ms); };
  d.flush = () => { if (t) { clearTimeout(t); t = null; fn(); } };
  return d;
}
function download(name, text, type = 'application/json') {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type }));
  a.download = name;
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}
function pickFile(accept) {
  return new Promise((res) => { const i = document.createElement('input'); i.type = 'file'; i.accept = accept; i.onchange = () => res(i.files[0] || null); i.click(); });
}
const LS = {
  get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch { toast('ブラウザに保存できませんでした'); return false; } },
  del(k) { try { localStorage.removeItem(k); } catch { /* noop */ } },
};
function loadImage(src) { return new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => rej(new Error('画像を読み込めませんでした')); i.src = src; }); }
function paperName(p) {
  for (const [n, [a, b]] of Object.entries(PAPERS)) {
    if (Math.abs(p.w - a) < 2 && Math.abs(p.h - b) < 2) return n + '縦';
    if (Math.abs(p.w - b) < 2 && Math.abs(p.h - a) < 2) return n + '横';
  }
  return `${Math.round(p.w)}×${Math.round(p.h)}mm`;
}

/* ---------- 保存（IndexedDB）：tpl＝帳票の設定、img＝背景画像（ページごと） ---------- */
const DB = (() => {
  let p;
  const open = () => p || (p = new Promise((res, rej) => {
    const r = indexedDB.open('genecon-forms', 1);
    r.onupgradeneeded = () => { const d = r.result; d.createObjectStore('tpl', { keyPath: 'id' }); d.createObjectStore('img'); };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  }));
  const req = (r) => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
  const os = async (name, mode = 'readonly') => (await open()).transaction(name, mode).objectStore(name);
  return {
    list: async () => req((await os('tpl')).getAll()),
    get: async (id) => req((await os('tpl')).get(id)),
    put: async (t) => req((await os('tpl', 'readwrite')).put(t)),
    del: async (id) => req((await os('tpl', 'readwrite')).delete(id)),
    getImg: async (k) => req((await os('img')).get(k)),
    putImg: async (k, v) => req((await os('img', 'readwrite')).put(v, k)),
    delImg: async (k) => req((await os('img', 'readwrite')).delete(k)),
    imgs: async (t) => Promise.all(t.pages.map((_, i) => DB.getImg(t.id + ':' + i))),
  };
})();

/* ---------- 取込：PDF・画像 → ページ画像 ---------- */
async function pagesFromFile(file, paper) {
  const isPdf = file.type === 'application/pdf' || /\.pdf$/i.test(file.name);
  const out = [];
  if (isPdf) {
    if (!pdfjsLib) throw new Error('PDFを読む部品を読み込めませんでした');
    // 日本語フォントを埋め込んでいないPDF（ゼネコンの書式に多い）は cMaps がないと文字が出ない
    const base = new URL('vendor/', location.href).href;
    const pdf = await pdfjsLib.getDocument({
      data: await file.arrayBuffer(),
      cMapUrl: base + 'cmaps/', cMapPacked: true, standardFontDataUrl: base + 'standard_fonts/',
    }).promise;
    for (let i = 1; i <= pdf.numPages; i++) {
      const pg = await pdf.getPage(i);
      const vp1 = pg.getViewport({ scale: 1 });
      const scale = Math.min(RENDER_DPI / 72, 4200 / Math.max(vp1.width, vp1.height));
      const vp = pg.getViewport({ scale });
      const c = document.createElement('canvas');
      c.width = Math.round(vp.width); c.height = Math.round(vp.height);
      const ctx = c.getContext('2d');
      ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
      await pg.render({ canvasContext: ctx, viewport: vp }).promise;
      // 「書式の手直し」用：文字を描かずに同じページを描いた画像（線・枠・○の図形だけが残る）
      let notext = null;
      try {
        const tc = await pg.getTextContent();
        if (tc.items.some((it) => it.str && it.str.trim())) notext = await renderWithoutText(pg, vp);
      } catch (e) { console.warn(e); }
      out.push({ w: r1(vp1.width * MM_PER_PT), h: r1(vp1.height * MM_PER_PT), canvas: c, notext });
    }
    return out;
  }
  // 画像（スキャン・写真）：用紙に合わせて余白つきで中央に置く（縦横は画像に合わせる）
  const url = URL.createObjectURL(file);
  try {
    const img = await loadImage(url);
    const land = img.naturalWidth > img.naturalHeight;
    const [a, b] = PAPERS[paper] || PAPERS.A4;
    const w = land ? b : a, hh = land ? a : b;
    const long = Math.min(4200, Math.round(Math.max(w, hh) / 25.4 * RENDER_DPI));
    const c = document.createElement('canvas');
    c.width = Math.round(long * w / Math.max(w, hh)); c.height = Math.round(long * hh / Math.max(w, hh));
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
    const s = Math.min(c.width / img.naturalWidth, c.height / img.naturalHeight);
    const dw = img.naturalWidth * s, dh = img.naturalHeight * s;
    ctx.drawImage(img, (c.width - dw) / 2, (c.height - dh) / 2, dw, dh);
    out.push({ w, h: hh, canvas: c });
    return out;
  } finally { URL.revokeObjectURL(url); }
}
/* 文字だけを描かずにページを描く。pdf.js は文字を canvas の fillText／strokeText で描くので、
 * それを何もしない関数に差し替える（罫線・枠・○などの図形と画像はそのまま描かれる）。
 * 「書式の手直し」の「文字を消す」は、囲んだ範囲でこの画像と比べて明るいほう（＝文字のない状態）を使う。 */
async function renderWithoutText(pg, vp) {
  const c = document.createElement('canvas');
  c.width = Math.round(vp.width); c.height = Math.round(vp.height);
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
  ctx.fillText = () => {};
  ctx.strokeText = () => {};
  await pg.render({ canvasContext: ctx, viewport: vp }).promise;
  return c;
}
function thumbOf(canvas) {
  const t = document.createElement('canvas');
  const s = 360 / Math.max(canvas.width, canvas.height);
  t.width = Math.round(canvas.width * s); t.height = Math.round(canvas.height * s);
  const ctx = t.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(canvas, 0, 0, t.width, t.height);
  return t.toDataURL('image/jpeg', 0.8);
}

/* ---------- 日付・印 ---------- */
function wareki(y, m, d) {
  const n = y * 10000 + m * 100 + d;
  if (n >= 20190501) return ['令和', y - 2018];
  if (n >= 19890108) return ['平成', y - 1988];
  return ['昭和', y - 1925];
}
function fmtDate(v, fmt) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v || '')) return '';
  const [Y, M, D] = v.split('-').map(Number);
  const [g, y] = wareki(Y, M, D);
  switch (fmt) {
    case 'wa_num': return `${y}年${M}月${D}日`;
    case 'seireki': return `${Y}年${M}月${D}日`;
    case 'slash': return `${Y}/${pad(M)}/${pad(D)}`;
    case 'yslash': return `${String(Y).slice(-2)}/${pad(M)}/${pad(D)}`;
    case 'y': return String(y);
    case 'Y': return String(Y);
    case 'y2': return String(Y).slice(-2);
    case 'm': return String(M);
    case 'd': return String(D);
    default: return `${g}${y === 1 ? '元' : y}年${M}月${D}日`;
  }
}
function markSvg(mark) {
  switch (mark) {
    case 'circle': return '<svg viewBox="0 0 100 100" preserveAspectRatio="none"><ellipse cx="50" cy="50" rx="48" ry="47" fill="none" stroke="#000" stroke-width="1.3" vector-effect="non-scaling-stroke"/></svg>';
    case 'cross': return '<svg viewBox="0 0 100 100"><path d="M22 22L78 78M78 22L22 78" stroke="#000" stroke-width="9" stroke-linecap="round"/></svg>';
    case 'dot': return '<svg viewBox="0 0 100 100"><circle cx="50" cy="50" r="30" fill="#000"/></svg>';
    default: return '<svg viewBox="0 0 100 100"><path d="M18 52L42 76L84 22" fill="none" stroke="#000" stroke-width="10" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  }
}
function stampSvg(profile, iso) {
  const [y, m, d] = iso.split('-').map(Number);
  const name = (profile.stampName || '').trim();
  const title = (profile.stampTitle || '').trim();
  const names = title ? { nameTop: name, nameBottom: title } : { name };
  return window.DateStamp ? DateStamp.svg({ ...names, date: { year: y, month: m, day: d }, color: 'red' }) : '';
}

/* ---------- 文字の自動縮小 ---------- */
const measureCtx = document.createElement('canvas').getContext('2d');
function textPx(t, pt, fam) { measureCtx.font = `${pt}pt ${fam}`; return measureCtx.measureText(t).width; }
function fitLine(el, f, fam, text) {
  const base = f.size || 10.5;
  if (f.shrink === false || !text) { el.style.fontSize = ''; return; }
  const room = f.w * PX_PER_MM - 5;
  let pt = base;
  while (pt > 4 && textPx(text, pt, fam) > room) pt -= 0.25;
  el.style.fontSize = pt === base ? '' : pt + 'pt';
}
function fitMulti(ta, f) {
  ta.style.fontSize = '';
  if (f.shrink === false || !ta.value || !ta.isConnected) return;
  let pt = f.size || 9;
  while (pt > 4 && ta.scrollHeight > ta.clientHeight + 1) { pt -= 0.25; ta.style.fontSize = pt + 'pt'; }
}

/* ---------- 画面の切り替え ---------- */
const view = $('#view');
const S = { view: null, tpl: null, sel: null, tool: 'text', zoom: 'fit', z: 1, undo: [], drag: null, leave: null };

async function route() {
  if (S.leave) { try { S.leave(); } catch (e) { console.error(e); } S.leave = null; }
  const [, name = '', id = ''] = (location.hash || '#/').split('/');
  S.view = name || 'home';
  document.body.className = '';
  view.className = '';
  try {
    if (name === 'new') await viewNew();
    else if (name === 'edit') await viewEdit(decodeURIComponent(id));
    else if (name === 'fill') await viewFill(decodeURIComponent(id));
    else await viewHome();
  } catch (e) {
    console.error(e);
    view.innerHTML = `<section class="panel"><h1>開けませんでした</h1><p>${esc(e.message || e)}</p><a class="btn" href="#/">一覧へ戻る</a></section>`;
  }
  window.scrollTo(0, 0);
}
window.addEventListener('hashchange', route);
window.addEventListener('resize', () => { if (S.zoom === 'fit') applyZoom(); });
$('#btnProfile').addEventListener('click', () => openProfile());

/* ---------- 一覧 ---------- */
async function viewHome() {
  const list = (await DB.list()).sort((a, b) => (a.genecon || '').localeCompare(b.genecon || '', 'ja') || (a.name || '').localeCompare(b.name || '', 'ja'));
  const groups = new Map();
  for (const t of list) { const g = t.genecon || '（ゼネコン名なし）'; if (!groups.has(g)) groups.set(g, []); groups.get(g).push(t); }
  view.innerHTML = `
  <section class="home">
    <div class="homeBar">
      <h1>帳票一覧</h1>
      <a class="btn yellow" href="#/new">＋ 帳票を取り込む</a>
      <button class="btn" data-act="import">帳票ファイルを読み込む</button>
      <span class="sp"></span>
      ${list.length ? '<input type="search" id="q" placeholder="ゼネコン名・帳票名で絞り込み">' : ''}
    </div>
    ${list.length ? [...groups].map(([g, ts]) => `
      <div class="group" data-group>
        <h2>${esc(g)}</h2>
        <div class="cards">${ts.map(card).join('')}</div>
      </div>`).join('') : `
      <div class="empty">
        <h2>まだ帳票がありません</h2>
        <ol class="steps">
          <li>ゼネコンからもらった書式を <b>PDF</b> にします（Excelは「名前を付けて保存」で PDF を選ぶ。紙はスキャン）</li>
          <li>「＋ 帳票を取り込む」で PDF を選びます</li>
          <li>書式の上で、入力したい欄を <b>四角で囲んで</b> 配置します</li>
          <li>「記入する」で入力して、印刷（またはPDFで保存）します</li>
        </ol>
        <p class="note">ほかの人が作った帳票は「帳票ファイルを読み込む」で取り込めます。会社名・工事名などは右上の「共通情報」に一度入れておくと、自動で入ります。</p>
      </div>`}
  </section>`;
  const q = $('#q');
  if (q) q.addEventListener('input', () => {
    const s = q.value.trim().toLowerCase();
    $$('.card').forEach((c) => { c.hidden = !!s && !c.dataset.q.includes(s); });
    $$('[data-group]').forEach((g) => { g.hidden = !$$('.card', g).some((c) => !c.hidden); });
  });
  view.onclick = async (e) => {
    const b = e.target.closest('[data-act]');
    if (!b) return;
    const id = b.dataset.id;
    const det = b.closest('details'); if (det) det.open = false;
    if (b.dataset.act === 'import') await importTemplate();
    else if (b.dataset.act === 'export') await exportTemplate(id);
    else if (b.dataset.act === 'dup') await duplicateTemplate(id);
    else if (b.dataset.act === 'del') await deleteTemplate(id);
  };
}
function card(t) {
  const p = t.pages[0];
  return `
  <div class="card" data-q="${esc(((t.genecon || '') + ' ' + (t.name || '')).toLowerCase())}">
    <a class="thumb" href="#/fill/${encodeURIComponent(t.id)}" title="記入する"><img src="${t.thumb}" alt=""></a>
    <div class="cbody">
      <div class="cname">${esc(t.name || '（名前なし）')}</div>
      <div class="cmeta">${paperName(p)}・${t.pages.length}枚・欄 ${t.fields.length}</div>
      <div class="cbtns">
        <a class="btn primary sm" href="#/fill/${encodeURIComponent(t.id)}">記入する</a>
        <a class="btn sm" href="#/edit/${encodeURIComponent(t.id)}">欄を編集</a>
        <details class="more"><summary class="btn sm" title="その他">…</summary>
          <div class="menu">
            <button data-act="export" data-id="${esc(t.id)}">帳票ファイルに書き出す</button>
            <button data-act="dup" data-id="${esc(t.id)}">複製する</button>
            <button data-act="del" data-id="${esc(t.id)}" class="danger">削除する</button>
          </div>
        </details>
      </div>
    </div>
  </div>`;
}

async function exportTemplate(id) {
  const t = await DB.get(id);
  const images = await DB.imgs(t);
  download(`${safeName(t.genecon)}_${safeName(t.name)}.json`, JSON.stringify({ app: 'genecon-forms', version: 1, template: t, images }));
  toast('帳票ファイルを書き出しました。BOXなどに置いて共有できます');
}
async function importTemplate() {
  const file = await pickFile('.json,application/json');
  if (!file) return;
  let data;
  try { data = JSON.parse(await file.text()); } catch { toast('帳票ファイルではありません'); return; }
  if (!data || data.app !== 'genecon-forms' || !data.template || !Array.isArray(data.images)) {
    toast(data && data.app === 'genecon-forms-values' ? 'これは記入データのファイルです。記入画面の「記入データを開く」で読み込んでください' : '帳票ファイルではありません', 4000);
    return;
  }
  const t = data.template;
  const exist = await DB.get(t.id);
  if (exist && !confirm(`「${exist.name}」はもうあります。上書きしますか？\n（キャンセルすると別の帳票として追加します）`)) {
    t.id = uid(); t.name = (t.name || '') + '（読込）';
  }
  for (let i = 0; i < data.images.length; i++) await DB.putImg(t.id + ':' + i, data.images[i]);
  await DB.put(t);
  toast(`「${t.name}」を読み込みました`);
  route();
}
async function duplicateTemplate(id) {
  const t = await DB.get(id);
  const imgs = await DB.imgs(t);
  const n = { ...structuredClone(t), id: uid(), name: (t.name || '') + '（コピー）', created: Date.now(), updated: Date.now() };
  for (let i = 0; i < imgs.length; i++) {
    await DB.putImg(n.id + ':' + i, imgs[i]);
    for (const key of [notextKey, origKey]) { const v = await DB.getImg(key(t.id, i)); if (v) await DB.putImg(key(n.id, i), v); }
  }
  await DB.put(n);
  route();
}
async function deleteTemplate(id) {
  const t = await DB.get(id);
  if (!confirm(`「${t.genecon ? t.genecon + '／' : ''}${t.name}」を削除しますか？\n（このパソコンの記入内容も消えます。元に戻せません）`)) return;
  for (let i = 0; i < t.pages.length; i++) {
    await DB.delImg(t.id + ':' + i);
    await DB.delImg(notextKey(t.id, i));
    await DB.delImg(origKey(t.id, i));
  }
  await DB.del(id);
  LS.del(vKey(id)); LS.del(bgKey(id));
  toast('削除しました');
  route();
}

/* ---------- 取込画面 ---------- */
async function viewNew() {
  const gens = [...new Set((await DB.list()).map((t) => t.genecon).filter(Boolean))];
  view.innerHTML = `
  <section class="panel">
    <h1>帳票を取り込む</h1>
    <p class="note">ゼネコンの書式を <b>PDF</b> にして取り込みます。Excelの書式は「名前を付けて保存」で PDF を選んでください（印刷範囲がそのまま1ページになります）。紙の書式はスキャン（PDF・JPEG・PNG）で取り込めます。</p>
    <div class="form">
      <label>ゼネコン名<input id="nGen" list="genList" placeholder="例：〇〇建設" autocomplete="off"></label>
      <datalist id="genList">${gens.map((g) => `<option value="${esc(g)}">`).join('')}</datalist>
      <label>帳票名<input id="nName" placeholder="例：作業員名簿" autocomplete="off"></label>
      <label>文字の書体<select id="nFont"><option value="gothic">ゴシック</option><option value="mincho">明朝</option></select></label>
      <div class="drop" id="drop">ここに PDF・画像をドラッグ<br>または <button type="button" class="btn sm" id="nPick">ファイルを選ぶ</button>
        <div class="fileInfo" id="nFile"></div>
      </div>
      <label id="paperRow" hidden>用紙の大きさ（画像のとき。縦横は画像に合わせます）
        <select id="nPaper">${Object.keys(PAPERS).map((p) => `<option>${p}</option>`).join('')}</select></label>
    </div>
    <div class="cbtns"><a class="btn" href="#/">キャンセル</a><span class="sp"></span><button class="btn primary" id="nGo" disabled>取り込んで欄を配置する →</button></div>
  </section>`;
  let file = null;
  const setFile = (f) => {
    if (!f) return;
    if (!/pdf|image\/(png|jpeg)/.test(f.type) && !/\.(pdf|png|jpe?g)$/i.test(f.name)) { toast('PDF・JPEG・PNG を選んでください'); return; }
    file = f;
    $('#nFile').textContent = f.name;
    $('#paperRow').hidden = /\.pdf$/i.test(f.name) || f.type === 'application/pdf';
    if (!$('#nName').value.trim()) $('#nName').value = f.name.replace(/\.[^.]+$/, '');
    $('#nGo').disabled = false;
  };
  $('#nPick').onclick = async () => setFile(await pickFile('.pdf,.png,.jpg,.jpeg,application/pdf,image/png,image/jpeg'));
  const drop = $('#drop');
  drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('over'));
  drop.addEventListener('drop', (e) => { e.preventDefault(); drop.classList.remove('over'); setFile(e.dataTransfer.files[0]); });
  $('#nGo').onclick = async () => {
    const btn = $('#nGo');
    btn.disabled = true; btn.innerHTML = '<span class="busy">読み込み中…</span>';
    try {
      const pages = await pagesFromFile(file, $('#nPaper').value);
      if (pages.length > 20 && !confirm(`${pages.length}ページあります。このまま取り込みますか？`)) { btn.disabled = false; btn.textContent = '取り込んで欄を配置する →'; return; }
      const t = {
        id: uid(), genecon: $('#nGen').value.trim(), name: $('#nName').value.trim() || '帳票',
        font: $('#nFont').value, source: file.name,
        pages: pages.map((p) => ({ w: p.w, h: p.h })), fields: [],
        thumb: thumbOf(pages[0].canvas), created: Date.now(), updated: Date.now(),
      };
      for (let i = 0; i < pages.length; i++) {
        await DB.putImg(t.id + ':' + i, pages[i].canvas.toDataURL('image/jpeg', 0.9));
        if (pages[i].notext) await DB.putImg(notextKey(t.id, i), pages[i].notext.toDataURL('image/jpeg', 0.9));
      }
      if (pages.some((p) => p.notext)) S.fixHint = true;
      await DB.put(t);
      location.hash = '#/edit/' + encodeURIComponent(t.id);
    } catch (e) {
      console.error(e);
      toast('取り込めませんでした：' + (e.message || e), 5000);
      btn.disabled = false; btn.textContent = '取り込んで欄を配置する →';
    }
  };
}

/* ---------- 用紙の描画（編集・記入で共通） ---------- */
function sheetEl(t, i, img) {
  const p = t.pages[i];
  return h(`<div class="sheet" data-page="${i}" style="--w:${p.w}mm;--h:${p.h}mm">
    <img class="bg" src="${img || ''}" alt="" draggable="false"><div class="layer"></div>
    ${t.pages.length > 1 ? `<span class="pageNo">${i + 1} / ${t.pages.length}</span>` : ''}</div>`);
}
function place(el, f) { el.style.left = f.x + 'mm'; el.style.top = f.y + 'mm'; el.style.width = f.w + 'mm'; el.style.height = f.h + 'mm'; }
function applyZoom() {
  const stage = $('#stage');
  if (!stage || !S.tpl) return;
  const maxW = Math.max(...S.tpl.pages.map((p) => p.w));
  let z = S.zoom === 'fit' ? (stage.clientWidth - 40) / (maxW * PX_PER_MM) : S.zoom;
  z = clamp(z, 0.25, 4);
  S.z = z;
  $$('.sheet', stage).forEach((s) => { s.style.zoom = z; });
  const lab = $('#zLab');
  if (lab) lab.textContent = Math.round(z * 100) + '%';
}
function zoomButtons() {
  return `<span class="zoom"><button class="btn sm" data-z="out" title="縮小">−</button><span id="zLab"></span><button class="btn sm" data-z="in" title="拡大">＋</button><button class="btn sm" data-z="fit">幅に合わせる</button></span>`;
}
function onZoomClick(e) {
  const b = e.target.closest('[data-z]');
  if (!b) return false;
  const k = b.dataset.z;
  S.zoom = k === 'fit' ? 'fit' : clamp(S.z * (k === 'in' ? 1.2 : 1 / 1.2), 0.25, 4);
  applyZoom();
  return true;
}

/* ---------- 編集画面（欄の配置） ---------- */
const fieldById = (id) => S.tpl && S.tpl.fields.find((f) => f.id === id);
const elOf = (f) => $(`.ef[data-id="${CSS.escape(f.id)}"]`);
const snapshot = () => JSON.stringify(S.tpl.fields);
function pushUndo(snap = snapshot()) { S.undo.push(snap); if (S.undo.length > 100) S.undo.shift(); }
const saveTpl = debounce(async () => {
  if (!S.tpl) return;
  S.tpl.updated = Date.now();
  await DB.put(S.tpl);
  const s = $('#saved'); if (s) s.textContent = '保存しました';
}, 400);
function markDirty() { const s = $('#saved'); if (s) s.textContent = '保存中…'; saveTpl(); }

async function viewEdit(id) {
  const t = await DB.get(id);
  if (!t) throw new Error('帳票が見つかりません');
  const imgs = await DB.imgs(t);
  Object.assign(S, { tpl: t, sel: null, undo: [], drag: null, zoom: 'fit', fix: null, fixDrag: null });
  view.className = 'edit';
  view.innerHTML = `
  <div class="work">
    <div class="toolbar">
      <a class="btn sm" href="#/">← 一覧</a>
      <input class="tname" id="eGen" value="${esc(t.genecon)}" placeholder="ゼネコン名" size="12" aria-label="ゼネコン名">
      <input class="tname" id="eName" value="${esc(t.name)}" placeholder="帳票名" size="18" aria-label="帳票名">
      <span id="fieldTools" class="tgrp">
        <span class="lab">作る欄：</span>
        <span class="tools">${Object.entries(TYPES).map(([k, v]) => `<button class="tool${k === S.tool ? ' on' : ''}" data-tool="${k}" title="${v.name}"><span class="ti">${v.icon}</span>${v.short}</button>`).join('')}</span>
        <button class="btn sm" id="eUndo" title="Ctrl+Z">元に戻す</button>
      </span>
      <span id="fixTools" class="tgrp" hidden>
        <span class="lab">消し方：</span>
        <span class="tools">
          <button class="tool" data-fix="text" title="PDFの文字を四角で囲むと、文字だけを消します（線や○は残ります）"><span class="ti">字</span>文字を消す</button>
          <button class="tool" data-fix="rect" title="囲んだところを白く塗ります"><span class="ti">▭</span>四角で消す</button>
          <button class="tool" data-fix="brush" title="なぞったところを白く塗ります"><span class="ti">✎</span>ブラシで消す</button>
        </span>
        <select id="fixBrush" class="tname" title="ブラシの太さ">${FIX_BRUSH.map((b) => `<option value="${b}"${b === (S.fixBrush || 1) ? ' selected' : ''}>太さ ${b}mm</option>`).join('')}</select>
        <button class="btn sm" id="fixUndo" title="Ctrl+Z">元に戻す</button>
        <button class="btn sm" id="fixReset">取り込んだときの状態に戻す</button>
      </span>
      <button class="btn sm yellow" id="eFix" title="前の記入が残っている書式から、文字や○を消します">書式の手直し</button>
      <span class="sp"></span>
      <span class="saved" id="saved"></span>
      ${zoomButtons()}
      <a class="btn primary sm" href="#/fill/${encodeURIComponent(t.id)}">記入画面で確認 →</a>
    </div>
    <div class="body2">
      <div class="stage" id="stage"></div>
      <aside class="side" id="side"></aside>
    </div>
  </div>`;
  const stage = $('#stage');
  stage.style.fontFamily = FONTS[t.font] || FONTS.gothic;
  t.pages.forEach((_, i) => { const s = sheetEl(t, i, imgs[i]); stage.append(s); bindSheet(s); });
  drawAllFields();
  renderSide();
  applyZoom();

  $('#eGen').addEventListener('input', (e) => { t.genecon = e.target.value.trim(); markDirty(); });
  $('#eName').addEventListener('input', (e) => { t.name = e.target.value.trim(); markDirty(); });
  $('.toolbar').addEventListener('click', (e) => {
    if (onZoomClick(e)) return;
    const tb = e.target.closest('[data-tool]');
    if (tb) { S.tool = tb.dataset.tool; $$('[data-tool]').forEach((b) => b.classList.toggle('on', b === tb)); }
    const fb = e.target.closest('[data-fix]');
    if (fb && S.fix && !fb.disabled) setFixTool(fb.dataset.fix);
  });
  $('#eUndo').onclick = undo;
  $('#eFix').onclick = () => (S.fix ? exitFix() : enterFix());
  $('#fixUndo').onclick = fixUndo;
  $('#fixReset').onclick = fixReset;
  $('#fixBrush').onchange = (e) => { S.fixBrush = parseFloat(e.target.value); if (S.fix) S.fix.brush = S.fixBrush; };
  const side = $('#side');
  side.addEventListener('focusin', (e) => { if (e.target.dataset.p) S.pendingSnap = snapshot(); });
  side.addEventListener('input', onProp);
  side.addEventListener('change', (e) => {
    if (e.target.dataset.p && S.pendingSnap && S.pendingSnap !== snapshot()) { pushUndo(S.pendingSnap); S.pendingSnap = snapshot(); }
    if (e.target.dataset.p === 'type') renderSide();
    if (e.target.dataset.tp) { t[e.target.dataset.tp] = e.target.value; stage.style.fontFamily = FONTS[t.font] || FONTS.gothic; markDirty(); }
  });
  side.addEventListener('click', onSideClick);
  document.addEventListener('keydown', onEditKey);
  S.leave = () => { if (S.fix) exitFix(); document.removeEventListener('keydown', onEditKey); saveTpl.flush(); };
  if (S.fixHint) {
    S.fixHint = false;
    toast('前の記入が残っているときは、上の「書式の手直し」で文字や○を消せます', 5000);
  }
}

function drawAllFields() {
  $$('.sheet .layer').forEach((l) => { l.innerHTML = ''; });
  for (const f of S.tpl.fields) addFieldEl(f);
}
function addFieldEl(f) {
  const layer = $(`.sheet[data-page="${f.page}"] .layer`);
  if (!layer) return;
  const el = h(`<div class="ef t-${f.type}${f.auto ? ' auto' : ''}${S.sel === f.id ? ' sel' : ''}" data-id="${esc(f.id)}" title="${esc(f.label)}"><span class="lbl">${TYPES[f.type].icon} ${esc(f.label)}</span><i class="rh"></i></div>`);
  place(el, f);
  layer.append(el);
}
function redrawField(f) { const el = elOf(f); if (el) el.remove(); addFieldEl(f); }

function toMm(e, sheet, P) {
  const r = sheet.getBoundingClientRect();
  return { x: (e.clientX - r.left) / r.width * P.w, y: (e.clientY - r.top) / r.height * P.h };
}
function bindSheet(sheet) {
  const pi = +sheet.dataset.page;
  const P = S.tpl.pages[pi];
  sheet.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    if (S.fix) { fixDown(e, sheet, pi, P); return; }
    const m = toMm(e, sheet, P);
    const fe = e.target.closest('.ef');
    if (fe) {
      const f = fieldById(fe.dataset.id);
      if (S.sel !== f.id) select(f.id);
      S.drag = { mode: e.target.classList.contains('rh') ? 'resize' : 'move', f, m0: m, o: { x: f.x, y: f.y, w: f.w, h: f.h }, snap: snapshot(), moved: false, P };
    } else {
      const g = h('<div class="ghost"></div>');
      $('.layer', sheet).append(g);
      S.drag = { mode: 'create', m0: m, g, pi, P, moved: false };
    }
    sheet.setPointerCapture(e.pointerId);
    e.preventDefault();
  });
  sheet.addEventListener('pointermove', (e) => {
    if (S.fix && S.fix.tool === 'brush') brushCursor(e, sheet, P);
    if (S.fixDrag) { fixMove(e, sheet); return; }
    const d = S.drag;
    if (!d) return;
    const m = toMm(e, sheet, P);
    const dx = m.x - d.m0.x, dy = m.y - d.m0.y;
    if (!d.moved && Math.hypot(dx, dy) < 0.8) return;
    d.moved = true;
    if (d.mode === 'create') {
      const x1 = r05(clamp(Math.min(m.x, d.m0.x), 0, P.w)), x2 = r05(clamp(Math.max(m.x, d.m0.x), 0, P.w));
      const y1 = r05(clamp(Math.min(m.y, d.m0.y), 0, P.h)), y2 = r05(clamp(Math.max(m.y, d.m0.y), 0, P.h));
      d.rect = { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
      place(d.g, d.rect);
    } else {
      const f = d.f;
      if (d.mode === 'move') {
        f.x = r05(clamp(d.o.x + dx, 0, P.w - f.w));
        f.y = r05(clamp(d.o.y + dy, 0, P.h - f.h));
      } else {
        f.w = r05(clamp(d.o.w + dx, 1.5, P.w - f.x));
        f.h = r05(clamp(d.o.h + dy, 1.5, P.h - f.y));
      }
      place(elOf(f), f);
      syncPosInputs(f);
    }
  });
  const end = (e) => {
    if (S.fixDrag) { fixUp(e, sheet); return; }
    const d = S.drag;
    if (!d) return;
    S.drag = null;
    if (d.mode === 'create') {
      d.g.remove();
      if (d.moved && d.rect && d.rect.w >= 1.5 && d.rect.h >= 1.5) {
        pushUndo();
        const f = newField(d.pi, d.rect);
        S.tpl.fields.push(f);
        addFieldEl(f);
        select(f.id);
        markDirty();
        const lab = $('#side [data-p="label"]');
        if (lab) { lab.focus(); lab.select(); }
      } else select(null);
    } else if (d.moved) { pushUndo(d.snap); markDirty(); }
  };
  sheet.addEventListener('pointerup', end);
  sheet.addEventListener('pointercancel', end);
}
function newField(page, r) {
  const type = S.tool;
  const n = S.tpl.fields.filter((f) => f.type === type).length + 1;
  const size = type === 'multi' ? 9 : clamp(Math.floor(r.h / MM_PER_PT * 0.7 * 2) / 2, 6, 12);
  return {
    id: uid(), page, ...r, type, label: TYPES[type].short + n,
    size, align: defaultAlign(type),
    valign: 'middle', shrink: true, auto: '', link: '', comb: 0, format: 'wareki', mark: 'check', stampSize: 14.4, choices: DEFAULT_CHOICES,
  };
}
const DEFAULT_CHOICES = '○,△,×,／';
function defaultAlign(type) { return type === 'number' ? 'right' : ['check', 'stamp', 'choice'].includes(type) ? 'center' : 'left'; }
const choiceList = (f) => String(f.choices || DEFAULT_CHOICES).split(/[,、，\s]+/).filter(Boolean);
/* 連続して複製：選んだ欄を下（または右）へ、間隔をあけて n 個 */
function repeatField(n, pitch, dir) {
  const f = fieldById(S.sel);
  if (!f || !(n >= 1) || !(pitch > 0)) return;
  const P = S.tpl.pages[f.page];
  pushUndo();
  const m = /^(.*?)(\d+)$/.exec(f.label || '');
  let made = 0;
  for (let i = 1; i <= n; i++) {
    const x = dir === 'right' ? r1(f.x + pitch * i) : f.x;
    const y = dir === 'right' ? f.y : r1(f.y + pitch * i);
    if (x + f.w > P.w + 0.01 || y + f.h > P.h + 0.01) break;
    const label = m ? m[1] + (Number(m[2]) + i) : `${f.label}${i + 1}`;
    const c = { ...f, id: uid(), x, y, label, link: '' };
    S.tpl.fields.push(c);
    addFieldEl(c);
    made++;
  }
  if (made < n) toast(`用紙からはみ出す分は作りませんでした（${made}個 作成）`);
  else toast(`${made}個 複製しました`);
  markDirty();
  renderSide();
}
function select(id) {
  S.sel = id;
  $$('.ef').forEach((el) => el.classList.toggle('sel', el.dataset.id === id));
  renderSide();
}
function syncPosInputs(f) {
  for (const k of ['x', 'y', 'w', 'h']) { const i = $(`#side [data-p="${k}"]`); if (i && document.activeElement !== i) i.value = f[k]; }
}

function renderSide() {
  const side = $('#side');
  if (!side) return;
  if (S.fix) { renderFixSide(); return; }
  const f = fieldById(S.sel);
  const t = S.tpl;
  if (!f) {
    const byPage = t.pages.map((_, i) => t.fields.filter((x) => x.page === i));
    side.innerHTML = `
      <div class="help">
        <ol>
          <li>上の「作る欄」で種類を選ぶ</li>
          <li>書式の上を <b>ドラッグして四角で囲む</b></li>
          <li>右で項目名などを設定</li>
        </ol>
        <div style="margin-top:6px">欄はドラッグで移動、右下の■で大きさを変えます。<br>
        <kbd>←↑↓→</kbd> 0.5mm 移動　<kbd>Shift</kbd>＋矢印 大きさ<br>
        <kbd>Ctrl</kbd>+<kbd>D</kbd> 複製　<kbd>Delete</kbd> 削除　<kbd>Ctrl</kbd>+<kbd>Z</kbd> 元に戻す</div>
        <div style="margin-top:6px">前の記入が残っている書式は、上の <b>「書式の手直し」</b> で文字や○を消せます。</div>
      </div>
      <h3>帳票の設定</h3>
      <label class="row">文字の書体<select data-tp="font"><option value="gothic"${t.font !== 'mincho' ? ' selected' : ''}>ゴシック</option><option value="mincho"${t.font === 'mincho' ? ' selected' : ''}>明朝</option></select></label>
      <h3>配置した欄（${t.fields.length}）</h3>
      ${t.fields.length ? byPage.map((fs, i) => `${t.pages.length > 1 ? `<div class="flist pg">${i + 1}ページ</div>` : ''}<ul class="flist">${fs.map((x) => `<li><button data-act="pick" data-id="${esc(x.id)}"><span class="ti">${TYPES[x.type].icon}</span>${esc(x.label)}${x.auto ? ' <span class="note">（共通）</span>' : ''}</button></li>`).join('')}</ul>`).join('') : '<p class="note">まだありません</p>'}`;
    return;
  }
  const opt = (list, cur) => list.map(([v, l]) => `<option value="${v}"${v === cur ? ' selected' : ''}>${esc(l)}</option>`).join('');
  const isText = ['text', 'multi', 'number'].includes(f.type);
  const hasFont = f.type !== 'check' && f.type !== 'stamp';
  side.innerHTML = `
    <h3>欄の設定<button class="btn sm x" data-act="close" title="Esc">閉じる</button></h3>
    <label class="row">項目名<input data-p="label" value="${esc(f.label)}"><span class="hint">記入画面で欄にマウスを乗せると出ます</span></label>
    <label class="row">種類<select data-p="type">${opt(Object.entries(TYPES).map(([k, v]) => [k, v.name]), f.type)}</select></label>
    ${isText ? `<label class="row">共通情報から入れる<select data-p="auto"><option value="">（使わない）</option>${PROFILE.map((g) => `<optgroup label="${g.group}">${opt(g.items.filter(([k]) => !k.startsWith('stamp')), f.auto)}</optgroup>`).join('')}</select><span class="hint">右上の「共通情報」の内容が最初から入ります（記入画面で書き換えもできます）</span></label>` : ''}
    ${f.type === 'date' ? `<label class="row">日付の形<select data-p="format">${opt(DATE_FORMATS, f.format)}</select><span class="hint">「年」「月」「日」が別々の欄のときは、それぞれ年だけ・月だけ・日だけにして、同じ連動名を付けます</span></label>` : ''}
    ${f.type === 'check' ? `<label class="row">印の形<select data-p="mark">${opt(MARKS, f.mark)}</select><span class="hint">「有・無」などを○で囲むときは「○ 囲み」にして、文字を囲むように欄を置きます</span></label>` : ''}
    ${f.type === 'choice' ? `<label class="row">記号（クリックの順）<input data-p="choices" value="${esc(f.choices || DEFAULT_CHOICES)}"><span class="hint">カンマで区切ります。クリックするたびにこの順で切り替わり、最後の次は空欄に戻ります</span></label>` : ''}
    ${f.type === 'stamp' ? `<label class="row">印の直径（mm）<input type="number" data-p="stampSize" value="${f.stampSize || 14.4}" step="0.5" min="6" max="30"></label>` : ''}
    <label class="row">連動名<input data-p="link" value="${esc(f.link || '')}" placeholder="例：作成日"><span class="hint">同じ連動名の欄は同じ内容になります（別ページの同じ項目など）</span></label>
    ${hasFont ? `
    <div class="grid4">
      <label class="row">文字の大きさ（pt）<input type="number" data-p="size" value="${f.size}" step="0.5" min="4" max="40"></label>
      <label class="row">横の位置<select data-p="align">${opt([['left', '左'], ['center', '中央'], ['right', '右']], f.align)}</select></label>
    </div>
    ${f.type !== 'multi' ? `<label class="row">縦の位置<select data-p="valign">${opt([['top', '上'], ['middle', '中央'], ['bottom', '下']], f.valign || 'middle')}</select></label>` : ''}
    <label class="inl"><input type="checkbox" data-p="shrink"${f.shrink !== false ? ' checked' : ''}>入りきらないときは文字を小さくする</label>` : ''}
    ${f.type === 'text' || f.type === 'number' ? `<label class="row">マス目の数<input type="number" data-p="comb" value="${f.comb || 0}" min="0" max="40"><span class="hint">郵便番号などのマス目に1文字ずつ入れるとき。0＝使わない</span></label>` : ''}
    <div class="row">位置と大きさ（mm）
      <div class="grid4">
        <label class="row">左 <input type="number" data-p="x" value="${f.x}" step="0.5"></label>
        <label class="row">上 <input type="number" data-p="y" value="${f.y}" step="0.5"></label>
        <label class="row">幅 <input type="number" data-p="w" value="${f.w}" step="0.5" min="1.5"></label>
        <label class="row">高さ <input type="number" data-p="h" value="${f.h}" step="0.5" min="1.5"></label>
      </div>
    </div>
    <div class="btns"><button class="btn sm" data-act="dup">複製（Ctrl+D）</button><button class="btn sm danger" data-act="del">削除（Delete）</button></div>
    <details class="rep"${S.repOpen ? ' open' : ''}><summary>連続して複製（表の行など）</summary>
      <div class="grid4">
        <label class="row">個数<input type="number" id="repN" value="${S.repN || 5}" min="1" max="200"></label>
        <label class="row">間隔（mm）<input type="number" id="repP" value="${S.repP || f.h}" step="0.1" min="0.5"></label>
      </div>
      <label class="row">向き<select id="repD"><option value="down">下へ</option><option value="right"${S.repD === 'right' ? ' selected' : ''}>右へ</option></select></label>
      <span class="hint note">項目名の最後が数字なら、続きの番号を付けます。行の高さが少しずつ違う表は、複製したあとで矢印キーで合わせてください。</span>
      <div class="btns"><button class="btn sm primary" data-act="repeat">複製する</button></div>
    </details>`;
  const rep = $('details.rep', side);
  rep.addEventListener('toggle', () => { S.repOpen = rep.open; });
}
function onProp(e) {
  const tEl = e.target, p = tEl.dataset.p;
  if (!p) return;
  const f = fieldById(S.sel);
  if (!f) return;
  let v = tEl.type === 'checkbox' ? tEl.checked : tEl.value;
  if (['x', 'y', 'w', 'h', 'size', 'comb', 'stampSize'].includes(p)) {
    v = parseFloat(v);
    if (!isFinite(v)) return;
    if (p === 'w' || p === 'h') v = Math.max(1.5, v);
    if (p === 'comb') v = clamp(Math.round(v), 0, 40);
  }
  f[p] = v;
  if (p === 'type') {
    f.align = defaultAlign(v);
    if (v === 'choice' && !f.choices) f.choices = DEFAULT_CHOICES;
    if (!['text', 'multi', 'number'].includes(v)) f.auto = '';
    if (v !== 'text' && v !== 'number') f.comb = 0;
  }
  redrawField(f);
  markDirty();
}
function onSideClick(e) {
  const b = e.target.closest('[data-act]');
  if (!b) return;
  const a = b.dataset.act;
  if (a === 'close') select(null);
  else if (a === 'dup') dupField();
  else if (a === 'del') delField();
  else if (a === 'repeat') {
    S.repN = Math.round(parseFloat($('#repN').value));
    S.repP = parseFloat($('#repP').value);
    S.repD = $('#repD').value;
    repeatField(S.repN, S.repP, S.repD);
  }
  else if (a === 'pick') {
    select(b.dataset.id);
    const el = elOf(fieldById(b.dataset.id));
    if (el) el.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }
}
function dupField() {
  const f = fieldById(S.sel);
  if (!f) return;
  pushUndo();
  const P = S.tpl.pages[f.page];
  const n = { ...f, id: uid(), y: r05(Math.min(f.y + f.h, P.h - f.h)) };
  S.tpl.fields.push(n);
  addFieldEl(n);
  select(n.id);
  markDirty();
}
function delField() {
  const f = fieldById(S.sel);
  if (!f) return;
  pushUndo();
  S.tpl.fields = S.tpl.fields.filter((x) => x !== f);
  const el = elOf(f); if (el) el.remove();
  select(null);
  markDirty();
}
function undo() {
  if (!S.undo.length) { toast('元に戻す操作はありません'); return; }
  S.tpl.fields = JSON.parse(S.undo.pop());
  if (!fieldById(S.sel)) S.sel = null;
  drawAllFields();
  renderSide();
  markDirty();
}
function onEditKey(e) {
  if (S.view !== 'edit') return;
  const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName);
  const mod = e.ctrlKey || e.metaKey;
  if (S.fix) {
    if (mod && e.key.toLowerCase() === 'z' && !typing) { e.preventDefault(); fixUndo(); }
    return;
  }
  if (mod && e.key.toLowerCase() === 'z' && !typing) { e.preventDefault(); undo(); return; }
  if (typing) { if (e.key === 'Escape') e.target.blur(); return; }
  const f = fieldById(S.sel);
  if (!f) return;
  const P = S.tpl.pages[f.page];
  if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); delField(); }
  else if (mod && e.key.toLowerCase() === 'd') { e.preventDefault(); dupField(); }
  else if (e.key === 'Escape') select(null);
  else if (e.key.startsWith('Arrow')) {
    e.preventDefault();
    pushUndo();
    const dx = e.key === 'ArrowLeft' ? -0.5 : e.key === 'ArrowRight' ? 0.5 : 0;
    const dy = e.key === 'ArrowUp' ? -0.5 : e.key === 'ArrowDown' ? 0.5 : 0;
    if (e.shiftKey) { f.w = clamp(f.w + dx, 1.5, P.w - f.x); f.h = clamp(f.h + dy, 1.5, P.h - f.y); }
    else { f.x = clamp(f.x + dx, 0, P.w - f.w); f.y = clamp(f.y + dy, 0, P.h - f.h); }
    place(elOf(f), f);
    syncPosInputs(f);
    markDirty();
  }
}

/* ---------- 書式の手直し（前の記入の文字・○を消す） ----------
 *  背景画像を白く塗って消す。操作は「消した記録（ops）」として持ち、元に戻すときは
 *  手直しを始めたときの画像（base）に記録を描き直す。保存すると背景画像を置き換え、
 *  最初に手直ししたときだけ、取り込んだときの画像を origKey に残す（「取り込んだときの状態に戻す」用）。 */
const FIX_BRUSH = [0.5, 1, 2, 4];
async function enterFix() {
  const t = S.tpl;
  select(null);
  const F = { tool: 'rect', brush: S.fixBrush || 1, pages: [], hist: [], hasText: false };
  for (let i = 0; i < t.pages.length; i++) {
    const sheet = $(`.sheet[data-page="${i}"]`);
    const img = $('.bg', sheet);
    try { await img.decode(); } catch { /* 読み込み済み */ }
    const cv = document.createElement('canvas');
    cv.width = img.naturalWidth; cv.height = img.naturalHeight;
    cv.className = 'fixcv';
    cv.getContext('2d').drawImage(img, 0, 0);
    const base = document.createElement('canvas');
    base.width = cv.width; base.height = cv.height;
    base.getContext('2d').drawImage(cv, 0, 0);
    const ntUrl = await DB.getImg(notextKey(t.id, i));
    let nt = null;
    if (ntUrl) { try { nt = await loadImage(ntUrl); F.hasText = true; } catch { nt = null; } }
    sheet.insertBefore(cv, $('.layer', sheet));
    img.hidden = true;
    F.pages.push({ sheet, img, cv, base, nt, ops: [], dirty: false, origUrl: img.src });
  }
  S.fix = F;
  document.body.classList.add('fixing');
  $('#fieldTools').hidden = true;
  $('#fixTools').hidden = false;
  $('#eFix').textContent = '手直しを終わる';
  $('[data-fix="text"]').disabled = !F.hasText;
  $('[data-fix="text"]').title = F.hasText ? 'PDFの文字を四角で囲むと、文字だけを消します（線や○は残ります）'
    : 'この帳票では使えません（画像から取り込んだ帳票・帳票ファイルから読み込んだ帳票）';
  setFixTool(F.hasText ? 'text' : 'rect');
  applyZoom();
}
function exitFix() {
  const F = S.fix;
  if (!F) return;
  saveFix.flush();
  S.fix = null; S.fixDrag = null;
  for (const p of F.pages) { p.cv.remove(); p.img.hidden = false; }
  $$('.brushCur').forEach((x) => x.remove());
  document.body.classList.remove('fixing');
  const ft = $('#fieldTools'); if (ft) ft.hidden = false;
  const xt = $('#fixTools'); if (xt) xt.hidden = true;
  const b = $('#eFix'); if (b) b.textContent = '書式の手直し';
  renderSide();
}
function setFixTool(tool) {
  const F = S.fix;
  F.tool = tool;
  $$('[data-fix]').forEach((b) => b.classList.toggle('on', b.dataset.fix === tool));
  // 太さの欄は出したまま（隠すとツールバーの折り返しが変わって用紙の位置がずれる）
  $('#fixBrush').disabled = tool !== 'brush';
  if (tool !== 'brush') $$('.brushCur').forEach((x) => x.remove());
  renderFixSide();
}
function renderFixSide() {
  const side = $('#side');
  const F = S.fix;
  if (!side || !F) return;
  const tips = {
    text: `<b>文字を消す</b><br>消したい文字を <b>四角で囲む</b> と、囲んだ中の文字だけを消します。罫線・下線・枠は残ります。<br>書式の見出しの文字も消えるので、記入した部分だけを囲んでください。<br>○印は図形なのでこれでは消えません。ブラシで消してください。`,
    rect: `<b>四角で消す</b><br>囲んだところを白く塗ります。罫線にかからないように囲んでください。スキャンした書式の書き込みもこれで消せます。`,
    brush: `<b>ブラシで消す</b><br>なぞったところを白く塗ります。文字と重なった○は、<b>○の線だけ</b>をなぞって消します。拡大すると細かく消せます。`,
  };
  side.innerHTML = `
    <h3>書式の手直し</h3>
    <div class="help">${tips[F.tool]}</div>
    <div class="help">
      <kbd>Ctrl</kbd>+<kbd>Z</kbd> または「元に戻す」で1つずつ戻せます。<br>
      「取り込んだときの状態に戻す」で、消したものをすべて元に戻せます。<br>
      直した書式は自動で保存されます。終わったら「手直しを終わる」を押してください。
    </div>
    ${F.hasText ? '' : '<p class="note">この帳票では「文字を消す」は使えません（画像から取り込んだ帳票、帳票ファイルから読み込んだ帳票）。四角かブラシで消してください。</p>'}`;
}
function applyOp(p, o, P) {
  const ctx = p.cv.getContext('2d');
  const k = p.cv.width / P.w;
  ctx.save();
  ctx.fillStyle = '#fff'; ctx.strokeStyle = '#fff';
  if (o.t === 'rect') ctx.fillRect(o.x * k, o.y * k, o.w * k, o.h * k);
  else if (o.t === 'text' && p.nt) {
    // 文字なしの画像と比べて明るいほう：文字（暗い）は白に、線や枠（両方に暗い）はそのまま、消したところ（白）は白のまま
    const sx = p.nt.naturalWidth / p.cv.width;
    ctx.globalCompositeOperation = 'lighten';
    ctx.drawImage(p.nt, o.x * k * sx, o.y * k * sx, o.w * k * sx, o.h * k * sx, o.x * k, o.y * k, o.w * k, o.h * k);
  } else if (o.t === 'brush') strokeBrush(ctx, o.pts, o.r * k, k);
  ctx.restore();
}
function strokeBrush(ctx, pts, lw, k) {
  ctx.lineWidth = lw; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  if (pts.length === 1) { ctx.beginPath(); ctx.arc(pts[0][0] * k, pts[0][1] * k, lw / 2, 0, Math.PI * 2); ctx.fill(); return; }
  ctx.beginPath();
  ctx.moveTo(pts[0][0] * k, pts[0][1] * k);
  for (const [x, y] of pts.slice(1)) ctx.lineTo(x * k, y * k);
  ctx.stroke();
}
function redrawFix(pi) {
  const p = S.fix.pages[pi];
  const P = S.tpl.pages[pi];
  const ctx = p.cv.getContext('2d');
  ctx.drawImage(p.base, 0, 0);
  for (const o of p.ops) applyOp(p, o, P);
}
function addFixOp(pi, o, drawn = false) {
  const F = S.fix;
  const p = F.pages[pi];
  p.ops.push(o);
  F.hist.push(pi);
  if (!drawn) applyOp(p, o, S.tpl.pages[pi]);
  p.dirty = true;
  const s = $('#saved'); if (s) s.textContent = '保存中…';
  saveFix();
}
function fixUndo() {
  const F = S.fix;
  if (!F) return;
  if (!F.hist.length) { toast('元に戻す操作はありません'); return; }
  const pi = F.hist.pop();
  F.pages[pi].ops.pop();
  redrawFix(pi);
  F.pages[pi].dirty = true;
  saveFix();
}
async function fixReset() {
  const F = S.fix;
  if (!F) return;
  if (!confirm('書式を、取り込んだときの状態に戻しますか？\n（この帳票で消した文字や○が、すべて元に戻ります）')) return;
  const t = S.tpl;
  for (let i = 0; i < F.pages.length; i++) {
    const p = F.pages[i];
    const orig = await DB.getImg(origKey(t.id, i));
    if (!orig && !p.ops.length) continue;
    const im = await loadImage(orig || p.origUrl);
    const bctx = p.base.getContext('2d');
    bctx.fillStyle = '#fff'; bctx.fillRect(0, 0, p.base.width, p.base.height);
    bctx.drawImage(im, 0, 0, p.base.width, p.base.height);
    p.ops = [];
    redrawFix(i);
    p.dirty = true;
  }
  F.hist = [];
  saveFix();
  saveFix.flush();
  toast('取り込んだときの状態に戻しました');
}
const saveFix = debounce(() => { if (S.fix) persistFix(S.fix); }, 1200);
async function persistFix(F) {
  const t = S.tpl;
  for (let i = 0; i < F.pages.length; i++) {
    const p = F.pages[i];
    if (!p.dirty) continue;
    p.dirty = false;
    if (!(await DB.getImg(origKey(t.id, i)))) await DB.putImg(origKey(t.id, i), p.origUrl);
    const url = p.cv.toDataURL('image/jpeg', 0.92);
    await DB.putImg(t.id + ':' + i, url);
    p.img.src = url;
    if (i === 0) t.thumb = thumbOf(p.cv);
  }
  // 画面を移ったあとでも、この帳票（t）だけを保存する
  t.updated = Date.now();
  await DB.put(t);
  const s = $('#saved'); if (s && S.tpl === t) s.textContent = '保存しました';
}
/* ブラシの大きさの円をマウスの位置に出す（どこまで消えるかが分かるように） */
function brushCursor(e, sheet, P) {
  let c = $('.brushCur', sheet);
  if (!c) {
    $$('.brushCur').forEach((x) => x.remove());
    c = h('<div class="brushCur"></div>');
    sheet.append(c);
  }
  const m = toMm(e, sheet, P);
  const r = S.fix.brush;
  Object.assign(c.style, { left: (m.x - r / 2) + 'mm', top: (m.y - r / 2) + 'mm', width: r + 'mm', height: r + 'mm' });
}
function fixDown(e, sheet, pi, P) {
  const F = S.fix;
  const m = toMm(e, sheet, P);
  sheet.setPointerCapture(e.pointerId);
  e.preventDefault();
  if (F.tool === 'brush') {
    const p = F.pages[pi];
    const o = { t: 'brush', r: F.brush, pts: [[r1(m.x * 10) / 10, r1(m.y * 10) / 10]] };
    const ctx = p.cv.getContext('2d');
    ctx.save(); ctx.fillStyle = '#fff';
    strokeBrush(ctx, o.pts, o.r * p.cv.width / P.w, p.cv.width / P.w);
    ctx.restore();
    S.fixDrag = { pi, P, o };
  } else {
    const g = h(`<div class="fixGhost${F.tool === 'rect' ? ' white' : ''}"></div>`);
    sheet.append(g);
    S.fixDrag = { pi, P, m0: m, g, moved: false };
  }
}
function fixMove(e, sheet) {
  const d = S.fixDrag;
  const m = toMm(e, sheet, d.P);
  if (d.o) {
    const p = S.fix.pages[d.pi];
    const last = d.o.pts[d.o.pts.length - 1];
    const pt = [Math.round(m.x * 100) / 100, Math.round(m.y * 100) / 100];
    if (Math.hypot(pt[0] - last[0], pt[1] - last[1]) < 0.15) return;
    d.o.pts.push(pt);
    const k = p.cv.width / d.P.w;
    const ctx = p.cv.getContext('2d');
    ctx.save(); ctx.strokeStyle = '#fff';
    strokeBrush(ctx, [last, pt], d.o.r * k, k);
    ctx.restore();
    return;
  }
  const x0 = Math.min(m.x, d.m0.x), y0 = Math.min(m.y, d.m0.y);
  d.rect = { x: x0, y: y0, w: Math.abs(m.x - d.m0.x), h: Math.abs(m.y - d.m0.y) };
  if (d.rect.w > 0.5 || d.rect.h > 0.5) d.moved = true;
  place(d.g, d.rect);
}
function fixUp(e, sheet) {
  const d = S.fixDrag;
  S.fixDrag = null;
  if (d.o) { addFixOp(d.pi, d.o, true); return; }
  d.g.remove();
  const F = S.fix;
  if (!d.moved || !d.rect || d.rect.w < 0.5 || d.rect.h < 0.5) return;
  const r = { x: r1(d.rect.x * 10) / 10, y: r1(d.rect.y * 10) / 10, w: r1(d.rect.w * 10) / 10, h: r1(d.rect.h * 10) / 10 };
  if (F.tool === 'rect') addFixOp(d.pi, { t: 'rect', ...r });
  else if (F.tool === 'text' && F.pages[d.pi].nt) addFixOp(d.pi, { t: 'text', ...r });
}

/* ---------- 記入画面 ---------- */
const valKey = (f) => (f.link && f.link.trim() ? 'L:' + f.link.trim() : f.id);

async function viewFill(id) {
  const t = await DB.get(id);
  if (!t) throw new Error('帳票が見つかりません');
  const imgs = await DB.imgs(t);
  Object.assign(S, { tpl: t, zoom: 'fit' });
  const ctx = {
    tpl: t, fam: FONTS[t.font] || FONTS.gothic,
    vals: LS.get(vKey(id), {}), profile: LS.get(PROFILE_KEY, {}),
  };
  ctx.save = debounce(() => LS.set(vKey(id), ctx.vals), 300);
  const printBg = LS.get(bgKey(id), true);
  const p0 = t.pages[0];
  $('#pageStyle').textContent = `@page { size: ${p0.w}mm ${p0.h}mm; margin: 0; }`;
  view.className = 'fill';
  view.innerHTML = `
  <div class="work">
    <div class="toolbar">
      <a class="btn sm" href="#/">← 一覧</a>
      <span class="title">${esc(t.genecon ? t.genecon + '／' : '')}${esc(t.name)}</span>
      <a class="btn sm" href="#/edit/${encodeURIComponent(t.id)}">欄を編集</a>
      <span class="sp"></span>
      <button class="btn sm" data-act="reauto" title="共通情報から入れる欄を、いまの共通情報に戻します">共通情報を入れ直す</button>
      <button class="btn sm" data-act="clear">記入内容を消す</button>
      <button class="btn sm" data-act="saveVals">記入データを保存</button>
      <button class="btn sm" data-act="loadVals">記入データを開く</button>
      ${zoomButtons()}
      <label class="chk" title="外すと書式の線や文字は印刷せず、記入した内容だけを印刷します（印刷済みの用紙に重ねて印刷するとき）"><input type="checkbox" id="fBg"${printBg ? ' checked' : ''}>書式も印刷</label>
      <button class="btn primary sm" data-act="print">印刷</button>
    </div>
    <div class="body2"><div class="stage" id="stage"></div></div>
  </div>`;
  document.body.classList.toggle('noBg', !printBg);
  const stage = $('#stage');
  stage.style.fontFamily = ctx.fam;
  t.pages.forEach((_, i) => stage.append(sheetEl(t, i, imgs[i])));
  for (const f of t.fields) {
    const layer = $(`.sheet[data-page="${f.page}"] .layer`, stage);
    if (layer) layer.append(fillEl(f, ctx));
  }
  applyZoom();
  updateAll();
  if (!t.fields.length) toast('まだ欄がありません。「欄を編集」で入力欄を配置してください', 4000);

  function updateAll() { $$('.fw', stage).forEach((el) => el._update()); }
  $('#fBg').onchange = (e) => { LS.set(bgKey(id), e.target.checked); document.body.classList.toggle('noBg', !e.target.checked); };
  $('.toolbar').addEventListener('click', async (e) => {
    if (onZoomClick(e)) { requestAnimationFrame(updateAll); return; }
    const b = e.target.closest('[data-act]');
    if (!b) return;
    const a = b.dataset.act;
    if (a === 'print') { ctx.save.flush(); window.print(); }
    else if (a === 'clear') {
      if (!confirm('この帳票の記入内容をすべて消しますか？')) return;
      ctx.vals = {}; ctx.save(); updateAll();
    } else if (a === 'reauto') {
      ctx.profile = LS.get(PROFILE_KEY, {});
      for (const f of t.fields) if (f.auto) delete ctx.vals[valKey(f)];
      ctx.save(); updateAll(); toast('共通情報を入れ直しました');
    } else if (a === 'saveVals') {
      ctx.save.flush();
      const d = new Date();
      download(`${safeName(t.name)}_記入データ_${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}.json`,
        JSON.stringify({ app: 'genecon-forms-values', version: 1, tplId: t.id, tplName: t.name, values: ctx.vals }, null, 1));
    } else if (a === 'loadVals') {
      const file = await pickFile('.json,application/json');
      if (!file) return;
      let d;
      try { d = JSON.parse(await file.text()); } catch { toast('記入データのファイルではありません'); return; }
      if (!d || d.app !== 'genecon-forms-values' || typeof d.values !== 'object') { toast('記入データのファイルではありません'); return; }
      if (d.tplId !== t.id && !confirm(`このファイルは「${d.tplName}」の記入データです。この帳票に読み込みますか？`)) return;
      if (Object.keys(ctx.vals).length && !confirm('いまの記入内容は置き換わります。読み込みますか？')) return;
      ctx.vals = d.values; ctx.save(); updateAll(); toast('記入データを読み込みました');
    }
  });
  S.onProfile = (p) => { ctx.profile = p; updateAll(); };
  S.leave = () => { ctx.save.flush(); S.onProfile = null; document.body.classList.remove('noBg'); };
}

function fillEl(f, ctx) {
  const key = valKey(f);
  const el = h(`<div class="fw t-${f.type} al-${f.align || 'left'} va-${f.valign || 'middle'}" title="${esc(f.label)}"></div>`);
  el.dataset.key = key;
  place(el, f);
  if (f.type !== 'check' && f.type !== 'stamp') el.style.fontSize = (f.size || 10.5) + 'pt';
  const get = () => { const v = ctx.vals[key]; return v === undefined && f.auto ? (ctx.profile[f.auto] || '') : (v ?? ''); };
  const set = (v) => {
    ctx.vals[key] = v;
    ctx.save();
    $$('.fw').forEach((o) => { if (o !== el && o.dataset.key === key) o._update(); });
  };
  switch (f.type) {
    case 'text':
    case 'number': {
      const inp = h('<input type="text" autocomplete="off" spellcheck="false">');
      inp.setAttribute('aria-label', f.label);
      if (f.type === 'number') inp.inputMode = 'decimal';
      el.append(inp);
      let comb = null;
      if (f.comb > 1) { el.classList.add('comb'); comb = h('<div class="combv"></div>'); el.append(comb); inp.maxLength = f.comb; }
      el._update = () => {
        const v = String(get());
        if (document.activeElement !== inp) inp.value = v;
        if (comb) { const cs = [...v]; comb.innerHTML = Array.from({ length: f.comb }, (_, i) => `<span>${esc(cs[i] || '')}</span>`).join(''); }
        else fitLine(inp, f, ctx.fam, inp.value);
      };
      inp.addEventListener('input', () => { set(inp.value); el._update(); });
      if (f.type === 'number') inp.addEventListener('blur', () => {
        const s = inp.value.replace(/[０-９．，－]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0)).replace(/[,\s]/g, '');
        if (/^-?\d+(\.\d+)?$/.test(s)) {
          const t = Number(s).toLocaleString('ja-JP', { maximumFractionDigits: 10 });
          if (t !== inp.value) { inp.value = t; set(t); el._update(); }
        }
      });
      break;
    }
    case 'multi': {
      const ta = h('<textarea spellcheck="false"></textarea>');
      ta.setAttribute('aria-label', f.label);
      el.append(ta);
      el._update = () => { if (document.activeElement !== ta) ta.value = String(get()); fitMulti(ta, f); };
      ta.addEventListener('input', () => { set(ta.value); fitMulti(ta, f); });
      break;
    }
    case 'date': {
      const dv = h('<span class="dv"></span>');
      const inp = h('<input type="date" class="dpick" tabindex="-1">');
      el.append(dv, inp);
      el.tabIndex = 0;
      el.setAttribute('role', 'button');
      el.setAttribute('aria-label', f.label);
      el._update = () => { const v = get(); const s = fmtDate(v, f.format); dv.textContent = s; fitLine(dv, f, ctx.fam, s); inp.value = /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : ''; };
      const open = () => { try { inp.showPicker(); } catch { inp.focus(); } };
      el.addEventListener('click', open);
      el.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); }
        else if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); set(''); el._update(); }
      });
      inp.addEventListener('change', () => { set(inp.value); el._update(); });
      break;
    }
    case 'check': {
      el.tabIndex = 0;
      el.setAttribute('role', 'checkbox');
      el.setAttribute('aria-label', f.label);
      el._update = () => { const on = !!get(); el.innerHTML = on ? markSvg(f.mark) : ''; el.setAttribute('aria-checked', on); };
      const toggle = () => { set(!get()); el._update(); };
      el.addEventListener('click', toggle);
      el.addEventListener('keydown', (e) => { if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); toggle(); } });
      break;
    }
    case 'choice': {
      // クリックで ○→△→×→／→空欄 の順に切り替え。キーで直接選ぶこともできる（1〜9、Delete で空欄）
      el.tabIndex = 0;
      el.setAttribute('role', 'button');
      el.setAttribute('aria-label', f.label);
      const dv = h('<span class="dv"></span>');
      el.append(dv);
      el._update = () => { dv.textContent = get(); };
      const list = choiceList(f);
      const step = (d) => {
        const i = list.indexOf(get()); // 空欄は -1
        const next = d > 0 ? (i + 1 < list.length ? list[i + 1] : '') : (i === -1 ? list[list.length - 1] : i === 0 ? '' : list[i - 1]);
        set(next);
        el._update();
      };
      el.addEventListener('click', () => step(1));
      el.addEventListener('contextmenu', (e) => { e.preventDefault(); step(-1); });
      el.addEventListener('keydown', (e) => {
        if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); step(1); }
        else if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); set(''); el._update(); }
        else if (/^[1-9]$/.test(e.key) && list[e.key - 1]) { e.preventDefault(); set(list[e.key - 1]); el._update(); }
        else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
          // 同じ種類の欄を上下に移動（チェックリストを続けて入力しやすく）
          const all = $$('.fw.t-choice');
          const k = all.indexOf(el) + (e.key === 'ArrowDown' ? 1 : -1);
          if (all[k]) { e.preventDefault(); all[k].focus(); }
        }
      });
      break;
    }
    case 'stamp': {
      el.tabIndex = 0;
      el.setAttribute('role', 'button');
      el.setAttribute('aria-label', f.label);
      el._update = () => {
        const v = get();
        const sz = (f.stampSize || 14.4) + 'mm';
        el.innerHTML = /^\d{4}-\d{2}-\d{2}$/.test(v) && ctx.profile.stampName
          ? `<div class="stampBox" style="width:${sz};height:${sz}">${stampSvg(ctx.profile, v)}</div>`
          : '<span class="ph">クリックで<br>押印</span>';
      };
      const press = () => {
        if (get()) { if (confirm('印を取り消しますか？')) { set(''); el._update(); } return; }
        if (!ctx.profile.stampName) {
          toast('先に共通情報の「デート印」に苗字を入れてください', 4000);
          openProfile(() => { if (ctx.profile.stampName) { set(today()); el._update(); } });
          return;
        }
        set(today()); el._update();
      };
      el.addEventListener('click', press);
      el.addEventListener('keydown', (e) => { if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); press(); } });
      break;
    }
    default:
      el._update = () => {};
  }
  return el;
}

/* ---------- 共通情報 ---------- */
function openProfile(after) {
  const d = $('#dlgProfile');
  const p = LS.get(PROFILE_KEY, {});
  d.innerHTML = `
  <form method="dialog">
    <div class="dlgIn">
      <h2>共通情報</h2>
      <p class="note">ここに入れた内容は、欄の設定で「共通情報から入れる」を選んだ欄に自動で入ります。このパソコンのブラウザにだけ保存されます。</p>
      ${PROFILE.map((g) => `<fieldset><legend>${g.group}</legend>${g.items.map(([k, l]) => `<label>${l}<input name="${k}" value="${esc(p[k] || '')}" autocomplete="off"></label>`).join('')}</fieldset>`).join('')}
    </div>
    <div class="dlgBtns"><button class="btn" value="cancel">閉じる</button><button class="btn primary" value="ok">保存</button></div>
  </form>`;
  d.returnValue = '';
  d.onclose = () => {
    if (d.returnValue !== 'ok') return;
    const np = {};
    for (const [k, v] of new FormData($('form', d))) np[k] = String(v).trim();
    LS.set(PROFILE_KEY, np);
    toast('共通情報を保存しました');
    if (S.onProfile) S.onProfile(np);
    if (after) after(np);
  };
  d.showModal();
}

route();
