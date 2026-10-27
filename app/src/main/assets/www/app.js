// app.js —— 基金周净值统计软件（纯前端，无构建步骤，运行于 Android WebView / 浏览器）
// 合并自 parser.js / storage.js / excel.js / main.js：全局使用 pdfjsLib 与 XLSX。

/* ===================== parser.js ===================== */
var CAT_BENCH = {
  '量化500指增': '中证500',
  '量化300指增': '沪深300',
  '量化1000指增': '中证1000',
  '量化对冲': '对冲基准',
  '量化选股': '中证全指',
  '全天候': '全天候基准',
};

function groupLines(textContent) {
  const items = textContent.items.filter(it => typeof it.str === 'string');
  items.sort((a, b) => b.transform[5] - a.transform[5]);
  const lines = [];
  let curY = null, cur = [];
  for (const it of items) {
    const y = it.transform[5];
    if (curY === null || Math.abs(y - curY) > 2.5) {
      if (cur.length) lines.push(cur.join(''));
      cur = [];
      curY = y;
    }
    cur.push(it.str);
  }
  if (cur.length) lines.push(cur.join(''));
  return lines;
}

function isAum(tok) {
  return tok.includes('亿') || tok.includes('未');
}

function pct(s) {
  if (!s) return null;
  let t = s.replace('%', '').replace('+', '').trim();
  if (t === '' || t === '-' || t === '—') return null;
  const v = parseFloat(t);
  return isNaN(v) ? null : v;
}

function detectWeek(text, filename) {
  if (filename) {
    const g = filename.match(/(\d{4})(\d{2})(\d{2})/);
    if (g) return g[1] + '-' + g[2] + '-' + g[3];
  }
  const re = text.match(/(\d{4})(\d{2})(\d{2})/);
  if (re) return re[1] + '-' + re[2] + '-' + re[3];
  return 'unknown';
}

async function extractPdf(arrayBuffer, filename) {
  if (typeof pdfjsLib === 'undefined') throw new Error('pdf.js 未加载，请检查 lib/pdf.min.js');
  // file:// 下 Web Worker 受限，pdf.js 会自动回退到主线程（fake worker）。
  pdfjsLib.GlobalWorkerOptions.workerSrc = 'lib/pdf.worker.min.js';
  const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
  let period = null;
  const cats = {};
  let curCat = null;
  const fullText = [];

  // 分类头（「XXX | 本周收益」）只在每个板块的首页出现，后续页是续页：
  // curCat 必须跨页保持，否则溢出到续页的基金行会被整页跳过（表尾空值的根因）。
  // 分界信号：遇到新板块扉页（业绩周刊/报告期）或板块末尾的「平均值」汇总行时清空 curCat。
  for (let p = 1; p <= pdf.numPages; p++) {
    const page = await pdf.getPage(p);
    const tc = await page.getTextContent();
    const lines = groupLines(tc);
    for (const line of lines) {
      fullText.push(line);
      if (period === null) {
        const mp = line.match(/(\d{1,2})\.(\d{1,2})\s*-\s*(\d{1,2})\.(\d{2})/);
        if (mp) period = mp[1] + '.' + mp[2] + '-' + mp[3] + '.' + mp[4];
      }
      if (/业绩周刊|报告期/.test(line) || line.indexOf('平均值') !== -1) curCat = null;
      const mc = line.match(/(量化\d+指增|量化对冲|量化选股|全天候)\s*\|\s*本周收益/);
      if (mc) {
        curCat = mc[1];
        cats[curCat] = cats[curCat] || {};
        continue;
      }
      if (curCat === null) continue;

      const toks = line.split(/\s+/).filter(Boolean);
      let left, right;
      if (toks.length >= 8) { left = toks.slice(0, 4); right = toks.slice(4, 8); }
      else if (toks.length === 6) { left = toks.slice(0, 3); right = toks.slice(3, 6); }
      else if (toks.length === 4) { left = toks.slice(0, 4); right = []; }
      else continue;

      if (left.length >= 3 && isAum(left[1]) && left[0].includes('·')) {
        const d = cats[curCat][left[0]] = cats[curCat][left[0]] || {};
        const p1 = pct(left[2]); if (p1 !== null) d['当周'] = p1;
        if (left.length > 3) { const e = pct(left[3]); if (e !== null) d['当周超额'] = e; }
      }
      if (right.length >= 3 && isAum(right[1]) && right[0].includes('·')) {
        const d = cats[curCat][right[0]] = cats[curCat][right[0]] || {};
        const p2 = pct(right[2]); if (p2 !== null) d['今年'] = p2;
        if (right.length > 3) { const e2 = pct(right[3]); if (e2 !== null) d['今年超额'] = e2; }
      }
    }
  }
  const text = fullText.join('\n');
  const week = detectWeek(text, filename);
  return { week, period, cats, text };
}

/* ===================== storage.js ===================== */
var STORE_KEY = 'fund_nav_store_v1';

function emptyStore() {
  return { weeks: [], report_period: null, week_label: null, funds: {}, benchmarks: {}, cats: {} };
}

function loadStore() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return emptyStore();
    return JSON.parse(raw);
  } catch (e) { return emptyStore(); }
}

function saveStore(store) {
  localStorage.setItem(STORE_KEY, JSON.stringify(store));
}

function processPDF(store, parsed) {
  const { week, period, cats } = parsed;
  if (!store.weeks.includes(week)) store.weeks.push(week);
  store.weeks.sort();
  if (period) store.report_period = period;
  store.week_label = (week !== 'unknown') ? week.replace(/-/g, '') : store.week_label;

  for (const cat of Object.keys(cats)) {
    const benchName = CAT_BENCH[cat] || cat;
    store.cats[cat] = { benchmark: benchName };
    store.benchmarks[cat] = store.benchmarks[cat] || {};
    for (const name of Object.keys(cats[cat])) {
      const rec = cats[cat][name];
      const f = store.funds[name] = store.funds[name] || { category: cat, chg: {}, excess: {} };
      f.category = cat;
      if (typeof rec['当周'] === 'number') f.chg[week] = rec['当周'];
      if (typeof rec['当周超额'] === 'number') f.excess[week] = rec['当周超额'];
      if (typeof rec['今年'] === 'number' && typeof rec['今年超额'] === 'number') {
        if (!(week in store.benchmarks[cat])) {
          store.benchmarks[cat][week] = +(rec['今年'] - rec['今年超额']).toFixed(4);
        }
      }
    }
  }
  return store;
}

function buildData(store) {
  const weeks = store.weeks.slice();
  const categories = [];
  for (const cat of Object.keys(store.cats)) {
    const benchName = store.cats[cat].benchmark;
    const funds = [];
    for (const name of Object.keys(store.funds)) {
      const f = store.funds[name];
      if (f.category !== cat) continue;
      const chg = weeks.map(w => (w in f.chg ? f.chg[w] : null));
      const cum = [];
      let acc = 0;
      for (const v of chg) {
        if (v === null) { cum.push(null); }
        else { acc += v; cum.push(+acc.toFixed(4)); }
      }
      let lastCum = null;
      for (let i = cum.length - 1; i >= 0; i--) { if (cum[i] !== null) { lastCum = cum[i]; break; } }
      funds.push({ name, chg, cum, lastCum: lastCum == null ? -Infinity : lastCum });
    }
    funds.sort((a, b) => b.lastCum - a.lastCum);
    const benchmark_series = weeks.map(w => (store.benchmarks[cat] && w in store.benchmarks[cat]) ? store.benchmarks[cat][w] : null);
    categories.push({ key: cat, benchmark: benchName, funds, benchmark_series });
  }
  return { weeks, categories, report_period: store.report_period, week_label: store.week_label };
}

/* ===================== excel.js ===================== */
function colorFont(v) {
  if (v == null || v === '-' || v === '') return null;
  const n = typeof v === 'number' ? v : parseFloat(String(v).replace('%', '').replace('+', ''));
  if (isNaN(n)) return null;
  return n >= 0 ? { color: { rgb: 'E23C39' } } : { color: { rgb: '16A34A' } };
}

function buildWorkbook(data) {
  const { weeks, categories, report_period, week_label } = data;
  const wb = XLSX.utils.book_new();

  const ov = [['基金周净值统计 · 总览'], []];
  ov.push(['报告期', report_period || '-', '周数', weeks.length, '生成', new Date().toLocaleString('zh-CN')]);
  ov.push([]);
  ov.push(['对标指数分类', '基金数', '对标指数', '最新累计收益前3']);
  categories.forEach(c => {
    const top3 = c.funds.slice(0, 3).map(f => {
      const last = f.cum.filter(v => v !== null).pop();
      return f.name + '(' + (last != null ? (last >= 0 ? '+' : '') + last.toFixed(2) + '%' : '-') + ')';
    }).join('、');
    ov.push([c.key, c.funds.length, c.benchmark, top3]);
  });
  const wsOv = XLSX.utils.aoa_to_sheet(ov);
  wsOv['!cols'] = [{ wch: 22 }, { wch: 10 }, { wch: 14 }, { wch: 50 }];
  XLSX.utils.book_append_sheet(wb, wsOv, '总览');

  categories.forEach(c => {
    const safe = c.key.length > 28 ? c.key.slice(0, 28) : c.key;
    const aoa = [];
    aoa.push(['周净值统计表 · ' + c.key + '（对标指数：' + c.benchmark + '）']);
    aoa.push([]);
    const hr = ['日期'];
    c.funds.forEach(f => { hr.push(f.name); hr.push(f.name); });
    aoa.push(hr);
    const sub = [''];
    c.funds.forEach(() => { sub.push('本周收益'); sub.push('累计收益'); });
    aoa.push(sub);
    weeks.forEach((w, i) => {
      const row = [w];
      c.funds.forEach(f => {
        const chg = f.chg[i], cum = f.cum[i];
        row.push(chg == null ? '-' : chg / 100);
        row.push(cum == null ? '-' : cum / 100);
      });
      aoa.push(row);
    });

    const ws = XLSX.utils.aoa_to_sheet(aoa);
    const merges = [{ s: { r: 0, c: 0 }, e: { r: 0, c: 1 + c.funds.length * 2 - 1 } }];
    c.funds.forEach((_, fi) => {
      const col = 1 + fi * 2;
      merges.push({ s: { r: 2, c: col }, e: { r: 2, c: col + 1 } });
    });
    ws['!merges'] = merges;

    const cols = [{ wch: 12 }];
    c.funds.forEach(() => { cols.push({ wch: 11 }); cols.push({ wch: 11 }); });
    ws['!cols'] = cols;
    const nRows = aoa.length;
    for (let r = 3; r < nRows; r++) {
      for (let fi = 0; fi < c.funds.length; fi++) {
        const colC = 1 + fi * 2, colN = 2 + fi * 2;
        [colC, colN].forEach(cc => {
          const addr = XLSX.utils.encode_cell({ r, c: cc });
          if (!ws[addr]) return;
          if (typeof ws[addr].v === 'number') ws[addr].z = '0.00%';
          const f = colorFont(ws[addr].v);
          if (f) ws[addr].s = f;
        });
      }
    }
    XLSX.utils.book_append_sheet(wb, ws, safe);
  });

  return wb;
}

/* ===================== 走势图导出（PNG） ===================== */
var PNG_SCALE = 1.5;

function lastVal(series) {
  for (let i = series.length - 1; i >= 0; i--) { if (series[i] !== null) return series[i]; }
  return null;
}

function chartLegendRows(cat) {
  const topN = Math.min(10, cat.funds.length);
  const idxPresent = normalize(cat.benchmark_series || []).some(v => v !== null);
  return Math.ceil((topN + (idxPresent ? 1 : 0)) / 2);
}

function chartBlockHeight(cat, weeks) {
  const topN = Math.min(10, cat.funds.length);
  const chartH = weeks.length === 1 ? (24 + topN * 34 + 40) : 520;
  return 44 + chartH + 14 + chartLegendRows(cat) * 24 + 26;
}

function drawLinesCanvas(ctx, weeks, cat, top10, oy) {
  const W = 940, H = 520, m = { t: 24, r: 24, b: 46, l: 54 };
  const pw = W - m.l - m.r, ph = H - m.t - m.b;
  const idxSeries = normalize(cat.benchmark_series || []);
  const fundSeries = top10.map(f => normalize(f.cum));
  const all = [];
  fundSeries.forEach(s => s.forEach(v => { if (v !== null) all.push(v); }));
  idxSeries.forEach(v => { if (v !== null) all.push(v); });
  if (!all.length) all.push(0, 1);
  let ymin = Math.min.apply(null, all), ymax = Math.max.apply(null, all);
  const pad = (ymax - ymin) * 0.1 || 0.1; ymin -= pad; ymax += pad;
  const x = i => m.l + (weeks.length === 1 ? 0 : (i / (weeks.length - 1)) * pw);
  const y = v => oy + m.t + ph - ((v - ymin) / (ymax - ymin)) * ph;

  ctx.font = '11px sans-serif'; ctx.textAlign = 'right';
  for (let k = 0; k <= 5; k++) {
    const v = ymin + (ymax - ymin) * k / 5, yy = y(v);
    ctx.strokeStyle = '#eef0f3'; ctx.beginPath(); ctx.moveTo(m.l, yy); ctx.lineTo(W - m.r, yy); ctx.stroke();
    ctx.fillStyle = '#6b7280'; ctx.fillText(v.toFixed(2), m.l - 8, yy + 4);
  }
  ctx.textAlign = 'center'; ctx.fillStyle = '#6b7280';
  weeks.forEach((d, i) => { ctx.fillText(d.slice(5), x(i), oy + H - m.b + 20); });
  ctx.strokeStyle = '#cbd5e1';
  ctx.beginPath(); ctx.moveTo(m.l, oy + m.t); ctx.lineTo(m.l, oy + m.t + ph); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(m.l, oy + m.t + ph); ctx.lineTo(W - m.r, oy + m.t + ph); ctx.stroke();

  const path = series => {
    ctx.beginPath(); let started = false;
    series.forEach((v, i) => {
      if (v === null) { started = false; return; }
      const xx = x(i), yy = y(v);
      if (!started) { ctx.moveTo(xx, yy); started = true; } else ctx.lineTo(xx, yy);
    });
    ctx.stroke();
  };
  if (idxSeries.some(v => v !== null)) {
    ctx.strokeStyle = '#111827'; ctx.lineWidth = 2; ctx.setLineDash([6, 4]);
    path(idxSeries); ctx.setLineDash([]); ctx.lineWidth = 1;
  }
  top10.forEach((f, fi) => {
    ctx.strokeStyle = f._c; ctx.lineWidth = 2.2; path(fundSeries[fi]); ctx.lineWidth = 1;
    fundSeries[fi].forEach((v, i) => {
      if (v === null) return;
      ctx.fillStyle = f._c; ctx.beginPath(); ctx.arc(x(i), y(v), 3, 0, Math.PI * 2); ctx.fill();
    });
  });
  ctx.fillStyle = '#374151'; ctx.font = '12px sans-serif'; ctx.textAlign = 'center';
  ctx.fillText('周度日期', m.l + pw / 2, oy + H - 6);
  ctx.save(); ctx.translate(14, oy + m.t + ph / 2); ctx.rotate(-Math.PI / 2);
  ctx.fillText('累计收益(%)', 0, 0); ctx.restore();
  ctx.textAlign = 'left';
}

function drawBarsCanvas(ctx, cat, top10, oy) {
  const W = 940, rowH = 34, barH = 18, m = { l: 160, r: 90, t: 24, b: 30 };
  const totalH = m.t + top10.length * rowH + 40;
  const pw = W - m.l - m.r;
  const idxSeries = normalize(cat.benchmark_series || []);
  const vals = top10.map(f => (f.cum[0] != null ? f.cum[0] : 0));
  const maxV = Math.max.apply(null, vals.concat(idxSeries.filter(v => v !== null), [0.0001]));
  const x = v => m.l + (v / maxV) * pw;

  ctx.font = '12px sans-serif'; ctx.textAlign = 'right';
  top10.forEach((f, i) => {
    const yc = oy + m.t + i * rowH + rowH / 2;
    const v = f.cum[0];
    ctx.fillStyle = '#374151'; ctx.fillText(f.name, m.l - 8, yc + 4);
    if (v != null) {
      const bw = Math.max(2, x(v) - m.l);
      ctx.fillStyle = f._c; ctx.fillRect(m.l, yc - barH / 2, bw, barH);
      ctx.textAlign = 'left'; ctx.fillText((v >= 0 ? '+' : '') + v.toFixed(2) + '%', m.l + bw + 6, yc + 4);
      ctx.textAlign = 'right';
    }
  });
  const bv = idxSeries[0];
  if (bv != null) {
    const bx = x(bv);
    ctx.strokeStyle = '#111827'; ctx.setLineDash([6, 4]);
    ctx.beginPath(); ctx.moveTo(bx, oy + m.t); ctx.lineTo(bx, oy + m.t + top10.length * rowH); ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = '#111827'; ctx.textAlign = 'center';
    ctx.fillText(cat.benchmark + ' ' + (bv >= 0 ? '+' : '') + bv.toFixed(2) + '%', bx, oy + m.t - 8);
  }
  ctx.textAlign = 'left';
  return totalH;
}

function drawCatChartCanvas(ctx, cat, weeks, oy) {
  const top10 = cat.funds.slice(0, 10);
  top10.forEach((f, i) => { f._c = PALETTE[i % PALETTE.length]; });
  ctx.fillStyle = '#111827'; ctx.font = 'bold 18px sans-serif'; ctx.textAlign = 'left';
  ctx.fillText('累计收益走势图 · ' + cat.key + '（对标指数：' + cat.benchmark + '）', 24, oy + 30);
  const chartTop = oy + 44;
  const chartH = weeks.length === 1 ? drawBarsCanvas(ctx, cat, top10, chartTop) : (drawLinesCanvas(ctx, weeks, cat, top10, chartTop), 520);
  const ly = chartTop + chartH + 14;
  const entries = top10.map(f => ({ color: f._c, name: f.name, v: lastVal(f.cum) }));
  const idxSeries = normalize(cat.benchmark_series || []);
  if (idxSeries.some(v => v !== null)) entries.push({ dash: true, name: cat.benchmark, v: lastVal(cat.benchmark_series) });
  ctx.font = '13px sans-serif';
  entries.forEach((e, i) => {
    const ex = 24 + (i % 2) * 460, ey = ly + Math.floor(i / 2) * 24;
    if (e.dash) {
      ctx.strokeStyle = '#111827'; ctx.setLineDash([4, 3]);
      ctx.beginPath(); ctx.moveTo(ex, ey - 4); ctx.lineTo(ex + 16, ey - 4); ctx.stroke(); ctx.setLineDash([]);
    } else {
      ctx.fillStyle = e.color; ctx.fillRect(ex, ey - 11, 12, 12);
    }
    ctx.fillStyle = '#374151';
    ctx.fillText(e.name + '  ' + (e.v == null ? '-' : (e.v >= 0 ? '+' : '') + e.v.toFixed(2) + '%'), ex + 20, ey);
  });
}

function chartsPngBase64(data) {
  if (!data.categories.length) throw new Error('暂无数据');
  const W = 940, headH = 96;
  const H = headH + data.categories.reduce((s, c) => s + chartBlockHeight(c, data.weeks), 0) + 16;
  const cv = document.createElement('canvas');
  cv.width = Math.round(W * PNG_SCALE);
  cv.height = Math.round(H * PNG_SCALE);
  const ctx = cv.getContext('2d');
  ctx.scale(PNG_SCALE, PNG_SCALE);
  ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = '#111827'; ctx.font = 'bold 26px sans-serif';
  ctx.fillText('基金净值 · 累计收益走势图', 24, 44);
  ctx.fillStyle = '#6b7280'; ctx.font = '14px sans-serif';
  ctx.fillText('报告期 ' + (data.report_period || '-') + ' · 共 ' + data.weeks.length + ' 周 · 生成于 ' + new Date().toLocaleString('zh-CN'), 24, 74);
  let oy = headH;
  data.categories.forEach(c => { drawCatChartCanvas(ctx, c, data.weeks, oy); oy += chartBlockHeight(c, data.weeks); });
  return cv.toDataURL('image/png').split(',')[1];
}

/* ===================== main.js ===================== */
var PALETTE = ['#e23c39','#2563eb','#16a34a','#d97706','#7c3aed','#0891b2','#db2777','#65a30d','#334155','#ea580c'];
var DATA = null;

function setStatus(msg, kind) {
  const el = document.getElementById('status');
  el.textContent = msg || '';
  el.className = 'status' + (kind ? ' ' + kind : '');
}

function render() {
  const store = loadStore();
  DATA = buildData(store);
  const panels = document.getElementById('panels');
  panels.innerHTML = '';

  const sub = document.getElementById('subtitle');
  if (!DATA.weeks.length) {
    sub.textContent = '暂无数据，请点击右上角「提供本周 PDF」导入';
  } else {
    sub.textContent = '报告期 ' + (DATA.report_period || '-') + ' · 共 ' + DATA.weeks.length + ' 周 · ' + DATA.categories.reduce((s,c)=>s+c.funds.length,0) + ' 支基金';
  }

  DATA.categories.forEach(cat => {
    panels.appendChild(buildTablePanel(cat));
    panels.appendChild(buildChartPanel(cat));
  });
}

function buildTablePanel(cat) {
  const sec = document.createElement('section');
  sec.className = 'panel';
  const h = document.createElement('h2');
  h.innerHTML = '周净值统计表 · ' + cat.key + ' <span class="bn">对标指数：' + cat.benchmark + '</span>';
  sec.appendChild(h);

  const wrap = document.createElement('div'); wrap.className = 'tablewrap';
  const table = document.createElement('table');

  const r1 = document.createElement('tr');
  const thDate = document.createElement('th'); thDate.rowSpan = 2; thDate.textContent = '日期';
  r1.appendChild(thDate);
  const r2 = document.createElement('tr');
  cat.funds.forEach(f => {
    const th = document.createElement('th'); th.className = 'fund'; th.colSpan = 2; th.textContent = f.name;
    r1.appendChild(th);
    const c1 = document.createElement('th'); c1.className = 'col-head'; c1.textContent = '本周收益';
    const c2 = document.createElement('th'); c2.className = 'col-head'; c2.textContent = '累计收益';
    r2.appendChild(c1); r2.appendChild(c2);
  });
  const thead = document.createElement('thead'); thead.appendChild(r1); thead.appendChild(r2);
  table.appendChild(thead);

  const tbody = document.createElement('tbody');
  DATA.weeks.forEach((w, i) => {
    const tr = document.createElement('tr');
    const tdD = document.createElement('td'); tdD.className = 'col-date'; tdD.textContent = w;
    tr.appendChild(tdD);
    cat.funds.forEach(f => {
      const chg = f.chg[i], cum = f.cum[i];
      const tdC = document.createElement('td'); tdC.className = 'col-nav';
      if (chg === null) tdC.className = 'null';
      else { tdC.className = (chg >= 0 ? 'up' : 'down'); tdC.textContent = (chg >= 0 ? '+' : '') + chg.toFixed(2) + '%'; }
      const tdN = document.createElement('td'); tdN.className = 'col-nav';
      if (cum === null) tdN.className = 'null';
      else { tdN.className = (cum >= 0 ? 'up' : 'down'); tdN.textContent = (cum >= 0 ? '+' : '') + cum.toFixed(2) + '%'; }
      tr.appendChild(tdC); tr.appendChild(tdN);
    });
    tbody.appendChild(tr);
  });
  table.appendChild(tbody);
  wrap.appendChild(table);
  sec.appendChild(wrap);

  const note = document.createElement('div'); note.className = 'note';
  note.innerHTML = '第一列为日期；自第二列起，每个基金占两列——「本周收益」与「累计收益」（从首次提交逐周累计）。'
    + '涨用<span class="up">红色</span>、跌用<span class="down">绿色</span>（A股惯例）。表头第一行为基金名称（按最新累计收益降序）。';
  sec.appendChild(note);
  return sec;
}

function buildChartPanel(cat) {
  const sec = document.createElement('section'); sec.className = 'panel';
  const h = document.createElement('h2');
  h.innerHTML = '累计收益前十 · ' + cat.key + ' · 累计收益走势图';
  const sw = document.createElement('label'); sw.className = 'switch';
  sw.innerHTML = '<input type="checkbox" checked> 显示对标指数';
  sw.querySelector('input').onchange = e => sec.classList.toggle('hide-idx', !e.target.checked);
  h.appendChild(sw);
  sec.appendChild(h);

  const box = document.createElement('div'); box.className = 'chartbox';
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 940 520');
  box.appendChild(svg);
  sec.appendChild(box);

  const lf = document.createElement('div'); lf.className = 'legend';
  const li = document.createElement('div'); li.className = 'legend';
  sec.appendChild(lf); sec.appendChild(li);

  const note = document.createElement('div'); note.className = 'note';
  note.textContent = '实线为基金累计收益（按最新累计收益取前 10 名），已同期归一开始（均从 0 起算）便于比较强弱；'
    + '虚线为对标指数（由「今年收益 − 今年超额」反推）。当前为单周数据时以条形展示，累计多周后自动切换为折线走势图。';
  sec.appendChild(note);

  renderChart(svg, cat, lf, li);
  return sec;
}

function normalize(series) {
  const out = series.map(v => (v === null ? null : v));
  let base = null;
  for (const v of out) { if (v !== null) { base = v; break; } }
  if (base === null) return out;
  return out.map(v => (v === null ? null : +(v - base).toFixed(4)));
}

function renderChart(svg, cat, lf, li) {
  const weeks = DATA.weeks;
  const top10 = cat.funds.slice(0, 10);
  top10.forEach((f, i) => f._c = PALETTE[i % PALETTE.length]);
  const idxName = cat.benchmark;
  const idxSeries = normalize(cat.benchmark_series || []);
  const fundSeries = top10.map(f => normalize(f.cum));
  if (weeks.length === 1) drawBars(svg, top10, idxName, idxSeries, lf, li);
  else drawLines(svg, weeks, fundSeries, idxName, idxSeries, lf, li, top10);
}

function drawLines(svg, weeks, fundSeries, idxName, idxSeries, lf, li, top10) {
  const W = 940, H = 520, m = { t: 24, r: 24, b: 46, l: 54 };
  const pw = W - m.l - m.r, ph = H - m.t - m.b;
  const all = [];
  fundSeries.forEach(s => s.forEach(v => { if (v !== null) all.push(v); }));
  idxSeries.forEach(v => { if (v !== null) all.push(v); });
  if (!all.length) all.push(0, 1);
  let ymin = Math.min.apply(null, all), ymax = Math.max.apply(null, all);
  const pad = (ymax - ymin) * 0.1 || 0.1; ymin -= pad; ymax += pad;
  const x = i => m.l + (weeks.length === 1 ? 0 : (i / (weeks.length - 1)) * pw);
  const y = v => m.t + ph - ((v - ymin) / (ymax - ymin)) * ph;
  let s = '';
  for (let k = 0; k <= 5; k++) {
    const v = ymin + (ymax - ymin) * k / 5, yy = y(v);
    s += '<line x1="' + m.l + '" y1="' + yy + '" x2="' + (W - m.r) + '" y2="' + yy + '" stroke="#eef0f3"/>';
    s += '<text x="' + (m.l - 8) + '" y="' + (yy + 4) + '" text-anchor="end" font-size="11" fill="#6b7280">' + v.toFixed(2) + '</text>';
  }
  weeks.forEach((d, i) => { const xx = x(i); s += '<text x="' + xx + '" y="' + (H - m.b + 20) + '" text-anchor="middle" font-size="11" fill="#6b7280">' + d.slice(5) + '</text>'; });
  s += '<line x1="' + m.l + '" y1="' + m.t + '" x2="' + m.l + '" y2="' + (m.t + ph) + '" stroke="#cbd5e1"/>';
  s += '<line x1="' + m.l + '" y1="' + (m.t + ph) + '" x2="' + (W - m.r) + '" y2="' + (m.t + ph) + '" stroke="#cbd5e1"/>';
  if (idxSeries.some(v => v !== null)) {
    let dP = '';
    idxSeries.forEach((v, i) => { if (v === null) return; const xx = x(i), yy = y(v); dP += (dP ? 'L' : 'M') + xx + ' ' + yy + ' '; });
    s += '<path class="idx" d="' + dP + '" fill="none" stroke="#111827" stroke-width="2" stroke-dasharray="6 4" opacity="0.9"/>';
  }
  fundSeries.forEach((ser, fi) => {
    const f = top10[fi];
    let dP = '', pts = '';
    ser.forEach((v, i) => { if (v === null) return; const xx = x(i), yy = y(v); dP += (dP ? 'L' : 'M') + xx + ' ' + yy + ' '; pts += '<circle cx="' + xx + '" cy="' + yy + '" r="3" fill="' + f._c + '"/>'; });
    s += '<path d="' + dP + '" fill="none" stroke="' + f._c + '" stroke-width="2.2"/>' + pts;
  });
  s += '<text x="' + (m.l + pw / 2) + '" y="' + (H - 6) + '" text-anchor="middle" font-size="12" fill="#374151">周度日期</text>';
  s += '<text x="14" y="' + (m.t + ph / 2) + '" text-anchor="middle" font-size="12" fill="#374151" transform="rotate(-90 14 ' + (m.t + ph / 2) + ')">累计收益(%)</text>';
  svg.innerHTML = s;
  lf.innerHTML = ''; li.innerHTML = '';
  top10.forEach(f => {
    const e = document.createElement('span');
    const last = f.cum.filter(v => v !== null).pop();
    e.innerHTML = '<i style="background:' + f._c + '"></i>' + f.name + ' <b>' + (last != null ? (last >= 0 ? '+' : '') + last.toFixed(2) + '%' : '-') + '</b>';
    lf.appendChild(e);
  });
  if (idxSeries.some(v => v !== null)) {
    const e = document.createElement('span'); e.className = 'idx-legend';
    e.innerHTML = '<i class="dash"></i>' + idxName;
    li.appendChild(e);
  }
}

function drawBars(svg, top10, idxName, idxSeries, lf, li) {
  const W = 940, rowH = 34, barH = 18, m = { l: 160, r: 90, t: 24, b: 30 };
  const H = m.t + top10.length * rowH + 40;
  const pw = W - m.l - m.r;
  const vals = top10.map(f => (f.cum[0] != null ? f.cum[0] : 0));
  const maxV = Math.max.apply(null, vals.concat(idxSeries.filter(v => v !== null), [0.0001]));
  const x = v => m.l + (v / maxV) * pw;
  let s = '';
  top10.forEach((f, i) => {
    const yc = m.t + i * rowH + rowH / 2;
    const v = f.cum[0];
    s += '<text x="' + (m.l - 8) + '" y="' + (yc + 4) + '" text-anchor="end" font-size="12" fill="#374151">' + f.name + '</text>';
    if (v != null) {
      const bw = Math.max(2, x(v) - m.l);
      s += '<rect x="' + m.l + '" y="' + (yc - barH / 2) + '" width="' + bw + '" height="' + barH + '" rx="3" fill="' + f._c + '" opacity="0.9"/>';
      s += '<text x="' + (m.l + bw + 6) + '" y="' + (yc + 4) + '" font-size="12" fill="#374151">' + (v >= 0 ? '+' : '') + v.toFixed(2) + '%</text>';
    }
  });
  const bv = idxSeries[0];
  if (bv != null) {
    const bx = x(bv);
    s += '<line x1="' + bx + '" y1="' + m.t + '" x2="' + bx + '" y2="' + (m.t + top10.length * rowH) + '" stroke="#111827" stroke-width="2" stroke-dasharray="6 4" class="idx"/>';
    s += '<text x="' + bx + '" y="' + (m.t - 12) + '" text-anchor="middle" font-size="11" fill="#111827">' + idxName + ' ' + (bv >= 0 ? '+' : '') + bv.toFixed(2) + '%</text>';
  }
  svg.setAttribute('viewBox', '0 0 ' + W + ' ' + H);
  svg.innerHTML = s;
  lf.innerHTML = ''; li.innerHTML = '';
  top10.forEach(f => {
    const e = document.createElement('span');
    const v = f.cum[0];
    e.innerHTML = '<i style="background:' + f._c + '"></i>' + f.name + ' <b>' + (v != null ? (v >= 0 ? '+' : '') + v.toFixed(2) + '%' : '-') + '</b>';
    lf.appendChild(e);
  });
  if (bv != null) { const e = document.createElement('span'); e.className = 'idx-legend'; e.innerHTML = '<i class="dash"></i>' + idxName; li.appendChild(e); }
}

const fileInput = document.getElementById('fileInput');
document.getElementById('uploadBtn').onclick = () => fileInput.click();
fileInput.onchange = e => { if (e.target.files[0]) handleFile(e.target.files[0]); };

async function handleFile(file) {
  setStatus('正在解析 PDF…');
  try {
    const buf = await file.arrayBuffer();
    const parsed = await extractPdf(buf, file.name);
    const store = loadStore();
    processPDF(store, parsed);
    saveStore(store);
    render();
    setStatus('已导入 ' + parsed.week + ' 周数据，共解析 ' + Object.values(parsed.cats).reduce((s, c) => s + Object.keys(c).length, 0) + ' 支基金', 'ok');
  } catch (err) {
    console.error(err);
    setStatus('解析失败：' + (err && err.message ? err.message : err), 'err');
  }
  fileInput.value = '';
}

['dragenter','dragover'].forEach(ev => document.addEventListener(ev, e => { e.preventDefault(); document.body.classList.add('dragging'); }));
['dragleave','drop'].forEach(ev => document.addEventListener(ev, e => { e.preventDefault(); if (ev === 'drop' || e.target === document || !document.elementFromPoint(e.clientX, e.clientY)) document.body.classList.remove('dragging'); }));
document.addEventListener('drop', e => {
  e.preventDefault();
  document.body.classList.remove('dragging');
  const f = e.dataTransfer && e.dataTransfer.files[0];
  if (f && /\.pdf$/i.test(f.name)) handleFile(f);
});

function base64ToBlob(b64, mime) {
  const bin = atob(b64);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return new Blob([arr], { type: mime });
}

function downloadFile(f) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(base64ToBlob(f.base64, f.mime));
  a.download = f.name;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 800);
}

document.getElementById('diagBtn').onclick = () => {
  if (!LAST_PARSE_TEXT) { setStatus('还没有解析过 PDF，请先「提供本周 PDF」导入一次', 'err'); return; }
  try {
    const f = {
      name: 'PDF解析原文.txt',
      base64: btoa(unescape(encodeURIComponent(LAST_PARSE_TEXT))),
      mime: 'text/plain',
    };
    if (window.Android && window.Android.saveFile) window.Android.saveFile(f.name, f.base64, f.mime);
    else downloadFile(f);
    setStatus('已生成 PDF解析原文.txt，把它发给开发者即可排查解析问题', 'ok');
  } catch (err) {
    setStatus('导出原文失败：' + (err && err.message ? err.message : err), 'err');
  }
};

document.getElementById('exportBtn').onclick = () => {
  if (!DATA || !DATA.weeks.length) { setStatus('暂无数据可导出', 'err'); return; }
  setStatus('正在生成导出文件（Excel + 走势图 PNG）…');
  setTimeout(() => {
    try {
      const wl = DATA.week_label || 'export';
      const files = [
        {
          name: '基金净值统计_' + wl + '.xlsx',
          base64: XLSX.write(buildWorkbook(DATA), { bookType: 'xlsx', type: 'base64' }),
          mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        },
        { name: '基金净值走势图_' + wl + '.png', base64: chartsPngBase64(DATA), mime: 'image/png' },
      ];
      if (window.Android && window.Android.saveFiles) {
        window.Android.saveFiles(JSON.stringify(files));
      } else if (window.Android && window.Android.saveFile) {
        files.forEach(f => window.Android.saveFile(f.name, f.base64, f.mime));
      } else {
        files.forEach(downloadFile);
      }
      setStatus('已生成 2 个文件：Excel 数据表 + 走势图 PNG，请在分享面板中选择保存', 'ok');
    } catch (err) {
      console.error(err);
      setStatus('导出失败：' + (err && err.message ? err.message : err), 'err');
    }
  }, 30);
};

render();
