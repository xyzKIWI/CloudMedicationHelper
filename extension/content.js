/* 雲端小幫手 — content script（用藥紀錄 IMUE0008 ＋ 檢驗結果 IMUE0060）
 *
 * 設計原則（刻意的限制，改動前請先想清楚）：
 * 1. **完全不連外**：整支檔案沒有 fetch／XMLHttpRequest／WebSocket，manifest 的
 *    permissions 也是空的。病人資料只在這個分頁的記憶體裡處理完就丟掉，
 *    不寫 localStorage、不寫 chrome.storage。這是處理健保雲端資料的底線。
 * 2. **唯讀**：不改頁面上任何原始資料、不代按查詢、不換卡。只讀表格、另開面板。
 * 3. **看得到什麼就整理什麼**：頁面上沒查出來的資料，這支也不會去要。
 *    ⚠️ 分頁只讀「目前顯示的那一頁」——DataTables 分頁時要先切成顯示全部，
 *    面板會標出讀到幾列，數字對不上就是還沒切。
 * 4. **不猜格式**：沒實際看過的頁面不寫解析器。目前只支援上面兩頁。
 */
(() => {
  'use strict';
  const ID = 'nhi-helper-root', BTN = 'nhi-helper-btn', DAY_MS = 86400000;
  let activePanelFingerprint = '';
  if (document.getElementById(ID)) return;
  /* ⚠️ 頁面上可能已經殘留一顆沒有事件的按鈕：老闆在外掛啟用的狀態下把頁面「另存新檔」，
   *    存下來的 HTML 就會夾帶當時的按鈕元素（有 DOM、沒有 JS）。同 id 重複時
   *    getElementById 只會拿到第一顆，也就是那顆死的，按下去完全沒反應。先清乾淨再放新的。 */
  document.querySelectorAll('#' + BTN).forEach(el => el.remove());

  // ── 小工具 ────────────────────────────────────────────
  const txt = el => (el ? el.textContent.replace(/\s+/g, ' ').trim() : '');
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  /** 民國日期 115/07/27 → Date；非預期格式回 null（不要猜） */
  function rocDate(s) {
    const m = String(s).match(/^(\d{2,3})\/(\d{1,2})\/(\d{1,2})$/);
    if (!m) return null;
    const year = +m[1] + 1911, month = +m[2], day = +m[3];
    const d = new Date(year, month - 1, day);
    return d.getFullYear() === year && d.getMonth() === month - 1 && d.getDate() === day
      ? d
      : null;
  }
  const fmt = d => d ? `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` : '';
  const md = d => d ? `${d.getMonth() + 1}/${d.getDate()}` : '';
  const daysBetween = (a, b) => Math.round((b - a) / 86400000);
  const a_max = arr => arr.length ? arr.reduce((m, x) => x > m ? x : m) : null;
  const pct = x => (Math.round(x * 1000) / 1000) + '%';

  function splitDx(s) {
    const m = String(s).match(/^(.*?)([A-Z]\d{2})\.?([0-9A-Z]*)$/);
    if (!m) return { name: String(s).trim(), code: '' };
    return { name: m[1].trim(), code: m[2] + (m[3] ? '.' + m[3] : '') };
  }
  const clinicName = s => String(s).replace(/\s*\d{6,}\s*$/, '').trim() || String(s).trim();

  /** 把一格裡用 <br> 分行的內容拆成陣列。textContent 會把分行黏成一串
   *  （「天德藥局阿藥局5907140126」），拆開才拿得到院所名／就醫類別／院所代碼三段。 */
  function lines(el) {
    if (!el) return [];
    const out = [''];
    for (const n of el.childNodes) {
      if (n.nodeName === 'BR') out.push('');
      else out[out.length - 1] += (n.textContent || '');
    }
    return out.map(s => s.replace(/\s+/g, ' ').trim()).filter(Boolean);
  }
  /** 健保 ICD 碼不帶小數點：I119 → I11.9、B9681 → B96.81、I10 → I10 */
  const icdDot = s => String(s || '').trim().replace(/^([A-Z]\d{2})(\d+)$/, '$1.$2');

  // ── 表格挑選：頁面上會有浮動表頭的複製品（沒有 tbody），挑列數最多那個 ──
  function pickTableBy(wantHeads) {
    let best = null, bestRows = 0;
    for (const t of document.querySelectorAll('table')) {
      const heads = [...t.querySelectorAll('th')].map(txt);
      if (!wantHeads.every(w => heads.some(h => h.includes(w)))) continue;
      const rows = t.querySelectorAll('tbody tr').length;
      if (rows > bestRows) { best = t; bestRows = rows; }
    }
    return best;
  }
  const MED_HEADS = ['就醫日期', '藥品名稱', '給藥日數'];
  const LAB_HEADS = ['檢驗日期', '檢驗項目', '檢驗結果'];
  const IMAGING_HEADS = ['檢驗日期', '醫令名稱', '影像查詢', '報告結果'];

  /** 這一頁是哪一種？先看表格，表格才是真的（網址會因為 SPA 換頁而不準） */
  function detectPage() {
    if (pickTableBy(IMAGING_HEADS)) return 'imaging';
    if (pickTableBy(LAB_HEADS)) return 'lab';
    if (pickTableBy(MED_HEADS)) return 'med';
    return null;
  }

  /** 僅存在記憶體的表格指紋，用來在 SPA 換頁／換病人後立即關掉舊摘要。 */
  function sourceFingerprint(kind = detectPage()) {
    const table = kind === 'imaging' ? pickTableBy(IMAGING_HEADS)
      : kind === 'lab' ? pickTableBy(LAB_HEADS)
      : kind === 'med' ? pickTableBy(MED_HEADS)
      : null;
    if (!table) return `${location.pathname}|none`;
    let hash = 2166136261;
    const rows = table.querySelectorAll('tbody tr');
    const imagingIdx = kind === 'imaging' ? headerIndexer(table) : null;
    const imagingCols = imagingIdx
      ? ['檢驗日期', '醫令名稱', '檢驗類別', '來源'].map(imagingIdx).filter(i => i >= 0)
      : [];
    for (const tr of rows) {
      // 報告點開時頁面可能更新「報告結果」欄；影像頁只用不會變動的欄位做指紋，
      // 避免擷取過程被誤判成換病人而關閉面板。
      const value = kind === 'imaging'
        ? imagingCols.map(i => txt(tr.children[i])).join('|')
        : txt(tr);
      for (let i = 0; i < value.length; i++) {
        hash ^= value.charCodeAt(i);
        hash = Math.imul(hash, 16777619);
      }
    }
    return `${location.pathname}|${kind}|${rows.length}|${hash >>> 0}`;
  }

  const headerIndexer = table => {
    const headerCells = table.querySelectorAll('thead th');
    const heads = [...(headerCells.length ? headerCells : table.querySelectorAll('th'))].map(txt);
    return name => heads.findIndex(h => h.includes(name));
  };

  // ══════════════════════════════════════════════════════
  //  A. 用藥紀錄（IMUE0008）
  // ══════════════════════════════════════════════════════
  function readMedRows(table) {
    const idx = headerIndexer(table);
    const col = {
      date: idx('就醫日期'), src: idx('來源'), dx: idx('主診斷'), atc3: idx('ATC3名稱'),
      ingr: idx('成分名稱'), drug: idx('藥品名稱'), sig: idx('用法用量'),
      qty: idx('藥品用量'), days: idx('給藥日數'), left: idx('餘藥'),
      elder: idx('高齡'), atc5: idx('ATC5代碼'), atc5n: idx('ATC5名稱'), atc7: idx('ATC7代碼')
    };
    const out = [];
    let rowIndex = 0;
    for (const tr of table.querySelectorAll('tbody tr')) {
      const tds = [...tr.children];
      const c = tds.map(txt);
      if (c.length < 8 || !c[col.date]) continue;
      if (c[col.date] === '就醫日期') continue;
      const d = rocDate(c[col.date]);
      const days = parseInt(c[col.days], 10);
      // 來源欄是三行：院所名 / 就醫類別（門診・藥局・住院・急診）/ 院所代碼
      const sl = lines(tds[col.src]);
      const src = sl.length ? sl[0] : clinicName(c[col.src]);
      const srcType = sl.find(s => /^(?:門診|藥局|住院|急診)$/.test(s)) || '';
      const srcCode = sl.find(s => /^\d{6,}$/.test(s)) || '';
      const srcKey = [srcCode || src, srcType].join('|');
      // 主診斷欄是兩行：診斷名 / ICD 碼。拆 <br> 比對字串硬切可靠。
      const dl = lines(tds[col.dx]);
      const dx = dl.length >= 2
        ? { name: dl.slice(0, -1).join(' '), code: icdDot(dl[dl.length - 1]) }
        : splitDx(c[col.dx]);
      out.push({
        id: `med-helper-${++rowIndex}`,
        rawText: c.filter(Boolean).join(' | '),
        dateRaw: c[col.date], date: d,
        src, srcType, srcCode, srcKey, dx,
        atc3: c[col.atc3] || '（未分類）',
        ingr: c[col.ingr], drug: c[col.drug], sig: c[col.sig],
        qty: c[col.qty], days: isNaN(days) ? null : days,
        left: c[col.left], elder: !!(c[col.elder] || '').trim(),
        atc5: c[col.atc5], atc5n: c[col.atc5n], atc7: c[col.atc7],
        endExclusive: (d && Number.isFinite(days) && days > 0)
          ? new Date(d.getTime() + days * DAY_MS)
          : null
      });
    }
    return out;
  }

  function analyseMed(rows) {
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const active = rows.filter(r => r.date && r.date <= today && r.endExclusive && r.endExclusive > today);
    const future = rows.filter(r => r.date && r.date > today);
    const past = rows.filter(r => !active.includes(r) && !future.includes(r));

    const byAtc = new Map();
    for (const r of active.filter(x => x.srcType !== '藥局')) {
      // 僅 ATC7 足以支持「同成分同劑型」警示；ATC5/成分文字只能當人工線索。
      const k = r.atc7;
      if (!k) continue;
      if (!byAtc.has(k)) byAtc.set(k, []);
      byAtc.get(k).push(r);
    }
    const dup = [...byAtc.entries()]
      .filter(([, v]) => new Set(v.map(x => x.srcKey)).size > 1)
      .map(([k, v]) => ({ key: k, name: v[0].ingr || v[0].atc5n, rows: v }));

    // ⭐ 同院所、同一支藥的「續領」合併成一項（見 README 的解析陷阱二）
    const refill = new Map();
    for (const r of active) {
      // 商品名納入 key，避免同 ATC7 但不同強度／劑型被當成同一次續領。
      const k = [r.atc7 || r.ingr || r.drug, r.drug, r.srcKey, r.sig].join('|');
      if (!refill.has(k)) refill.set(k, []);
      refill.get(k).push(r);
    }
    const merged = [];
    for (const list of refill.values()) {
      list.sort((a, b) => b.date - a.date);
      const head = list[0];
      merged.push(Object.assign({}, head, { refills: list.length, since: list[list.length - 1].date }));
    }

    const byClass = new Map();
    for (const r of merged) {
      if (!byClass.has(r.atc3)) byClass.set(r.atc3, []);
      byClass.get(r.atc3).push(r);
    }

    // ⭐ 用藥時序：跟上面的「合併續領」不同，這裡要看的是**同一支藥在時間軸上的每一次開立**，
    //    所以 (a) 涵蓋全部資料列（含已結束的），(b) 只用藥物本身當 key、不含院所，
    //    因為換院所繼續拿同一支藥，臨床上仍是同一條治療線。
    const tl = new Map();
    for (const r of rows) {
      if (!r.date) continue;
      // 同成分的不同商品規格分線顯示，寧可多列也不要把不同強度接成一條治療線。
      const k = [r.atc7 || r.ingr || r.drug, r.drug || r.ingr].join('|');
      if (!k) continue;
      if (!tl.has(k)) tl.set(k, { key: k, name: r.ingr || r.drug, atc3: r.atc3, events: [] });
      tl.get(k).events.push(r);
    }
    const timeline = [...tl.values()].map(g => {
      g.events.sort((a, b) => a.date - b.date);
      const first = g.events[0].date, last = g.events[g.events.length - 1].date;
      const srcs = [...new Set(g.events.map(e => e.src))];
      const srcKeys = [...new Set(g.events.map(e => e.srcKey))];
      // 相鄰兩次之間的空窗：前一次的給藥結束日 → 下一次的就醫日
      const gaps = [];
      for (let i = 1; i < g.events.length; i++) {
        const prev = g.events[i - 1], cur = g.events[i];
        if (prev.endExclusive) {
          const gap = daysBetween(prev.endExclusive, cur.date);
          if (gap >= 14) gaps.push({ from: prev.endExclusive, to: cur.date, days: gap });
        }
      }
      const stillOn = g.events.some(e => e.date <= today && e.endExclusive && e.endExclusive > today);
      return Object.assign(g, {
        first, last, srcs, gaps, stillOn,
        span: daysBetween(first, last),
        crossClinic: srcKeys.length > 1
      });
    }).sort((a, b) => b.events.length - a.events.length || a.first - b.first);

    // ⭐ 依院所分組：院所 → 就醫日 → 那一次的處方。同一天同一院所視為同一張處方箋。
    const byClinic = new Map();
    for (const r of rows) {
      if (!r.date) continue;
      if (!byClinic.has(r.srcKey)) byClinic.set(r.srcKey, { src: r.src, type: r.srcType, visits: new Map() });
      const visits = byClinic.get(r.srcKey).visits;
      if (!visits.has(r.dateRaw)) visits.set(r.dateRaw, { date: r.date, dx: r.dx, items: [] });
      visits.get(r.dateRaw).items.push(r);
    }
    const clinicList = [...byClinic.values()].map(group => {
      const { src, type } = group;
      const visits = [...group.visits.values()].sort((x, y) => y.date - x.date);
      return { src, type, isPharmacy: type === '藥局', visits, n: visits.reduce((s, v) => s + v.items.length, 0), last: visits[0].date };
    }).sort((x, y) => (x.isPharmacy - y.isPharmacy) || (y.last - x.last));

    const clinics = new Map();
    for (const r of rows) {
      const label = `${r.src}${r.srcType ? `（${r.srcType}）` : ''}`;
      clinics.set(label, (clinics.get(label) || 0) + 1);
    }
    const dxMap = new Map();
    for (const r of rows) if (r.dx.name) dxMap.set(r.dx.code + r.dx.name, r.dx);
    const dates = rows.map(r => r.date).filter(Boolean).sort((a, b) => a - b);

    // 甘特圖的時間軸範圍：最早就醫日 ～ max(最晚給藥結束日, 今天)
    let axisEnd = a_max(rows.map(r => r.endExclusive).filter(Boolean));
    if (!axisEnd || axisEnd < today) axisEnd = today;
    const axis = dates.length ? { from: dates[0], to: axisEnd } : null;

    return {
      kind: 'med', rows, active, past, future, dup, byClass, merged, timeline, today, clinicList, axis,
      clinics: [...clinics.entries()].sort((a, b) => b[1] - a[1]),
      dxList: [...dxMap.values()],
      elder: active.filter(r => r.elder),
      span: dates.length ? { from: dates[0], to: dates[dates.length - 1] } : null
    };
  }

  function medToText(a) {
    const L = [];
    L.push(`【雲端藥歷整理】${fmt(a.today)}`);
    if (a.span) L.push(`資料期間：${fmt(a.span.from)} ～ ${fmt(a.span.to)}　共 ${a.rows.length} 筆、${a.clinics.length} 家院所`);
    if (a.dxList.length) L.push(`就醫主診斷：${a.dxList.map(d => `${d.name}${d.code ? `(${d.code})` : ''}`).join('、')}`);
    L.push('');
    L.push(`— 推估仍在服用（${a.merged.length} 種，共 ${a.active.length} 筆處方）—`);
    for (const [cls, list] of a.byClass) {
      L.push(`[${cls}]`);
      for (const r of list) {
        const left = r.endExclusive ? daysBetween(a.today, r.endExclusive) : null;
        L.push(`  ${r.ingr || r.drug}　${r.sig || ''}　${r.days ?? '?'}日　${r.src}　${fmt(r.date)}` +
               (left !== null ? `　餘約 ${left} 日` : '') +
               (r.refills > 1 ? `　(已開 ${r.refills} 次)` : '') + (r.elder ? '　⚠高齡注意' : ''));
      }
    }
    if (a.dup.length) {
      L.push('');
      L.push(`— ⚠ 疑似重複用藥（同成分、不同院所且效期重疊，${a.dup.length} 組）—`);
      for (const d of a.dup) {
        L.push(`  ${d.name}（${d.key}）`);
        for (const r of d.rows) L.push(`    ・${r.drug}　${r.src}　${fmt(r.date)}　${r.days}日`);
      }
    }
    L.push('');
    L.push(medTimelineText(a));
    L.push('');
    L.push('※ 由雲端藥歷欄位自動彙整，「仍在服用」為就醫日＋給藥日數之推估，實際請與病人確認。');
    return L.join('\n');
  }

  /** ⭐ 用藥時序（條列式，方便貼病歷）：一支藥一行，把每一次開立依時間排出來 */
  function medTimelineText(a) {
    const L = [`— 用藥時序（同 ATC7／成分與商品規格的歷次開立，${a.timeline.length} 種）—`];
    for (const g of a.timeline) {
      const seq = g.events.map(e => `${md(e.date)}${e.days ? `(${e.days}d)` : ''}`).join(' → ');
      L.push(`${g.name}${g.stillOn ? '' : '（已停）'}：${seq}`);
      const meta = [];
      meta.push(`共 ${g.events.length} 次`);
      if (g.span > 0) meta.push(`跨 ${g.span} 日`);
      if (g.crossClinic) meta.push(`⚠跨 ${g.srcs.length} 家院所：${g.srcs.join('、')}`);
      if (g.gaps.length) meta.push(`中斷 ${g.gaps.length} 次（最長 ${Math.max(...g.gaps.map(x => x.days))} 日）`);
      L.push(`    ${meta.join('　')}`);
    }
    return L.join('\n');
  }

  /** 參考 emr-paste-formatter 的精簡藥名：保留商品名、規格與必要的緩釋標記，省略劑型。 */
  const MED_FORM = /^(?:TABLETS?|TAB|CAPSULES?|CAP|CAPS|ENTERIC[\w-]*|PROLONGED-RELEASE|EXTENDED[\w-]*|FILM[\w-]*|F\.?C\.?|SUGAR[\w-]*|ORAL|EYE|DROPS?|LOTION|OINTMENT|CREAM|GEL|SYRUP|SOLUTION|SUSPENSION|MIXTURE|LIQUID|EFFERVESCENT|INJECTION|INJ|PATCH|PLASTER|SPRAY|SUPPOSITOR(?:Y|IES)|POWDER|GRANULES?|S\.?R\.?M\.?C\.?|MICROENCAPSULATED)$/i;
  const MED_FORM_MOD = /^(?:SOFT|HARD|COATED|CHEWABLE|DISPERSIBLE|DELAYED|CONTROLLED|SUSTAINED|IMMEDIATE|MODIFIED|GASTRO-RESISTANT)$/i;
  const MED_EXTRA = /^(?:SR|XL|XR|CR|ER|LA|MR|DEPOT|FORTE|RETARD)$/i;
  const MED_TM = /^(?:®|™|TM|\(TM\)|\(R\)|®™)$/i;

  function drugDose(drug) {
    const s = String(drug || '');
    const unit = '(?:MG|MCG|G|ML|IU|%)';
    let m = s.match(new RegExp(`(\\d+(?:\\.\\d+)?\\s*${unit}(?:\\s*\\/\\s*\\d+(?:\\.\\d+)?\\s*${unit})+)`, 'i'));
    if (!m) m = s.match(new RegExp(`(\\d+(?:\\.\\d+)?(?:\\/\\d+(?:\\.\\d+)?)?\\s*${unit})`, 'i'));
    if (!m) m = s.match(/\s(\d+(?:\.\d+)?)(?=\s|\(|（|$)/);
    return m ? m[1].replace(/\s+/g, '').toLowerCase() : '';
  }

  function shortDrug(drug) {
    const raw = String(drug || '').replace(/["＂]/g, ' ').replace(/\s+/g, ' ').trim();
    const toks = raw.split(/\s+/).filter(Boolean);
    const names = [];
    let extra = '', sawForm = false;
    for (const tok of toks) {
      const t = tok.replace(/^[()（）]+|[()（）]+$/g, '');
      if (MED_TM.test(t)) continue;
      if (/^\d/.test(t)) break;
      if (MED_EXTRA.test(t) && names.length) { extra = t.toUpperCase(); continue; }
      if (MED_FORM.test(t) || MED_FORM_MOD.test(t)) { sawForm = true; continue; }
      if (sawForm) break;
      names.push(t.length > 1 ? t.charAt(0).toUpperCase() + t.slice(1).toLowerCase() : t.toUpperCase());
    }
    const dose = drugDose(raw);
    const name = names.join(' ').trim();
    return (name ? `${name}${extra ? ` ${extra}` : ''}${dose ? ` ${dose}` : ''}` : raw) || '未對應藥品';
  }

  /**
   * 精簡藥歷：一個就醫日／來源一行，全部院所與藥局依日期排成單一時序。
   * 同一 ATC7＋規格跨日期重複時只留最新日期；同日不同來源仍全部保留供人工核對。
   */
  function medToPasteFormat(a) {
    const latestAt = new Map();
    for (const r of a.rows) {
      if (!r.date) continue;
      const k = `${r.atc7 || r.ingr || shortDrug(r.drug)}|${drugDose(r.drug)}`;
      const at = r.date.getTime();
      if (!latestAt.has(k) || at > latestAt.get(k)) latestAt.set(k, at);
    }

    const visits = new Map();
    for (const r of a.rows) {
      if (!r.date) continue;
      const medKey = `${r.atc7 || r.ingr || shortDrug(r.drug)}|${drugDose(r.drug)}`;
      if (latestAt.get(medKey) !== r.date.getTime()) continue;
      const visitKey = `${r.dateRaw}|${r.srcKey}`;
      if (!visits.has(visitKey)) visits.set(visitKey, {
        date: r.date, dateRaw: r.dateRaw, src: r.src, srcType: r.srcType, diagnoses: new Map(), items: []
      });
      const visit = visits.get(visitKey);
      if (r.dx && (r.dx.code || r.dx.name)) visit.diagnoses.set(`${r.dx.code}|${r.dx.name}`, r.dx);
      const sigDays = `${r.sig || ''}${r.days !== null ? `×${r.days}d` : ''}`;
      const item = `${shortDrug(r.drug)}${sigDays ? ` ${sigDays}` : ''}`;
      if (!visit.items.includes(item)) visit.items.push(item);
    }

    const lines = [];
    const ordered = [...visits.values()].sort((x, y) => y.date - x.date);
    for (const visit of ordered) {
      const dx = [...visit.diagnoses.values()]
        .map(d => [d.code, d.name].filter(Boolean).join(' ')).filter(Boolean);
      const line = `${visit.dateRaw} ${visit.src}${dx.length ? `（${dx.join('；')}）` : ''}：${visit.items.join('、')}`;
      lines.push(line);
    }
    return lines.join('\n');
  }

  /** 舊版的「推估目前用藥」清單保留為次要複製功能。 */
  function medToEMR(a) {
    const L = [];
    a.merged.forEach((r, i) => {
      const left = r.endExclusive ? daysBetween(a.today, r.endExclusive) : null;
      const dose = (String(r.drug || '').match(/\d+(?:\.\d+)?\s*(?:MG|MCG|G|ML|IU|%)\b/i) || [''])[0].replace(/\s+/g, '');
      L.push(`${i + 1}. ${r.ingr || r.drug}${dose ? ' ' + dose : ''} ${r.sig || ''}` +
             ` (${r.src}, ${md(r.date)}, ${r.days ?? '?'}d${left !== null ? `, 餘${left}d` : ''})` +
             (r.elder ? ' [高齡注意]' : ''));
    });
    if (a.dup.length) {
      L.push('');
      L.push('# 疑似重複用藥（不同院所、同成分、效期重疊）');
      a.dup.forEach((d, i) => L.push(`${i + 1}. ${d.name}：` +
        d.rows.map(r => `${r.src}(${md(r.date)})`).join('、')));
    }
    return L.join('\n');
  }

  /** 保留 1.1.8 的本機工作台交換格式；只在使用者手動按下時下載 JSON。 */
  function toMedSnapshot(a) {
    return {
      schemaVersion: 'medcloud-medication-snapshot/v1',
      source: {
        system: 'NHI MediCloud',
        extractedAt: new Date().toISOString(),
        page: location.pathname.split('/').filter(Boolean).at(-1) || 'IMUE0008',
        rowCount: a.rows.length,
        completeness: 'visible-dom'
      },
      medications: a.rows.map(r => ({
        id: r.id,
        sourceTab: '西醫用藥',
        rawText: r.rawText,
        visitDate: fmt(r.date),
        institution: r.src,
        institutionCode: r.srcCode || undefined,
        sourceType: r.srcType || undefined,
        diagnosisText: r.dx.name || undefined,
        icd10: r.dx.code ? [r.dx.code] : [],
        drugBrand: r.drug || undefined,
        drugGeneric: r.ingr || r.drug || '未對應藥品',
        ingredient: r.ingr || undefined,
        sig: r.sig || undefined,
        days: r.days === null ? undefined : String(r.days),
        quantity: r.qty || undefined,
        remaining: r.left || undefined,
        indication: r.dx.name || undefined,
        atc3Name: r.atc3 === '（未分類）' ? undefined : r.atc3,
        atc5Code: r.atc5 || undefined,
        atc5Name: r.atc5n || undefined,
        atc7Code: r.atc7 || undefined,
        elderlyCaution: r.elder,
        longTerm: Number.isFinite(r.days) && r.days >= 28
      }))
    };
  }

  function downloadJson(value, filename) {
    const blob = new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }

  // ══════════════════════════════════════════════════════
  //  B. 檢驗結果（IMUE0060）
  // ══════════════════════════════════════════════════════
  function readLabRows(table) {
    const idx = headerIndexer(table);
    const col = {
      date: idx('檢驗日期'), order: idx('醫令名稱'), item: idx('檢驗項目'),
      result: idx('檢驗結果'), unit: idx('單位'), ref: idx('參考值'),
      method: idx('檢驗方法'), spec: idx('檢體採檢方法'), cat: idx('檢驗類別'),
      src: idx('來源'), ym: idx('費用年月'), note: idx('註記')
    };
    const out = [];
    for (const tr of table.querySelectorAll('tbody tr')) {
      const c = [...tr.children].map(txt);
      if (c.length < 8 || !c[col.date]) continue;
      if (c[col.date] === '檢驗日期') continue;   // 浮動表頭混進來那列
      const d = rocDate(c[col.date]);
      const unit = c[col.unit];
      out.push({
        dateRaw: c[col.date], date: d,
        order: c[col.order], item: c[col.item] || c[col.order],
        resultRaw: c[col.result], result: stripUnit(c[col.result], unit).replace(/\s+(?:H|L|A)$/i, '').trim(),
        unit, ref: c[col.ref], refText: refText(c[col.ref]),
        method: c[col.method], spec: c[col.spec], cat: c[col.cat] || '（未分類）',
        src: clinicName(c[col.src]), note: c[col.note]
      });
    }
    return out;
  }

  /* ⚠️ 這一頁的欄位格式跟直覺不同，是實際看過樣本頁才確定的（2026-08-13 樣本 50 列全部符合）：
   *   ・「檢驗結果」欄把單位一起接在值後面（"120 mg/dL"），而「單位」欄又重複一次 → 顯示時要拆掉
   *   ・「參考值」欄是 [下限][上限] 兩個中括號（"[3.5][5.1]"、"[Negative][]"、"[無][＜0.5]"），
   *     不是常見的 "3.5-5.1"。上下限任一可為空字串或文字。
   * 舊格式的 fallback 保留著，因為其他頁／其他院所不保證同一種寫法。 */

  /** "120 mg/dL" ＋ 單位 "mg/dL" → "120"；不符就原樣回傳（不要硬切） */
  function stripUnit(v, unit) {
    const s = String(v || '').trim(), u = String(unit || '').trim();
    return (u && s.endsWith(u)) ? s.slice(0, -u.length).trim() : s;
  }

  const isNumStr = s => /^-?\d+(?:\.\d+)?$/.test(String(s || '').trim());

  /** 參考值 → {lo,hi}（數值上下限，可為 null）＋ qual（文字型期望值，如 Negative） */
  function parseRef(s) {
    const raw = String(s || '').trim();
    const b = raw.match(/^\[(.*?)\]\[(.*?)\]$/);
    if (b) {
      const lo = b[1].trim(), hi = b[2].trim();
      const hiN = hi.match(/^([<＜≦≤]?)\s*(-?\d+(?:\.\d+)?)$/);
      const loN = lo.match(/^([>＞≧≥]?)\s*(-?\d+(?:\.\d+)?)$/);
      const loIsBound = !!loN;
      return {
        lo: loIsBound ? +loN[2] : null,
        hi: hiN ? +hiN[2] : null,
        loInclusive: !loN || !/[>＞]/.test(loN[1]),
        hiInclusive: !hiN || !/[<＜]/.test(hiN[1]),
        qual: loIsBound ? '' : lo
      };
    }
    const t = raw.replace(/\s/g, '');
    let m = t.match(/^(-?\d+(?:\.\d+)?)[-~～](-?\d+(?:\.\d+)?)$/);
    if (m) return { lo: +m[1], hi: +m[2], loInclusive: true, hiInclusive: true, qual: '' };
    m = t.match(/^([<＜≦≤])(-?\d+(?:\.\d+)?)$/);
    if (m) return { lo: null, hi: +m[2], loInclusive: true, hiInclusive: !/[<＜]/.test(m[1]), qual: '' };
    m = t.match(/^([>＞≧≥])(-?\d+(?:\.\d+)?)$/);
    if (m) return { lo: +m[2], hi: null, loInclusive: !/[>＞]/.test(m[1]), hiInclusive: true, qual: '' };
    return t ? { lo: null, hi: null, loInclusive: true, hiInclusive: true, qual: raw } : null;
  }

  /** 參考值顯示成人看得懂的樣子："[3.5][5.1]" → "3.5–5.1"、"[Negative][]" → "Negative" */
  function refText(s) {
    const r = parseRef(s);
    if (!r) return '';
    if (r.lo !== null && r.hi !== null) return `${r.lo}–${r.hi}`;
    if (r.lo !== null) return `${r.loInclusive ? '≥' : '>'}${r.lo}`;
    if (r.hi !== null) return r.qual ? `${r.qual}／${r.hiInclusive ? '≤' : '<'}${r.hi}` : `${r.hiInclusive ? '≤' : '<'}${r.hi}`;
    return r.qual;
  }

  /** 結果轉數值；"0-5" 這種範圍取上界，"<0.01" 取界線值，"Negative"／"4+" 回 null */
  function num(v) {
    const s = String(v || '').trim();
    if (isNumStr(s)) return +s;
    let m = s.match(/^(-?\d+(?:\.\d+)?)\s*[-~～]\s*(-?\d+(?:\.\d+)?)$/);
    if (m) return Math.max(+m[1], +m[2]);
    m = s.match(/^[<>＜＞≦≧≤≥]\s*(-?\d+(?:\.\d+)?)$/);
    if (m) return +m[1];
    return null;
  }

  // 定性結果的正負判定：只認明確詞彙，認不出來就不判（寧可漏標也不要誤標）
  const NEG_WORDS = ['negative', 'neg', 'none found', 'not found', 'normal', '-', '陰性', '無', '正常'];
  const isNeg = s => NEG_WORDS.includes(String(s || '').trim().toLowerCase());
  const isPos = s => { const t = String(s || '').trim().toLowerCase();
    return /^\d*\+{1,4}$/.test(t) || ['positive', 'pos', '陽性'].includes(t); };

  /** 依參考值判斷高低；判不出來回 ''（H=高、L=低、A=定性異常） */
  function flagOf(r) {
    // 健保來源若已明確帶 H/L/A，優先保留；自行依參考值計算只作 fallback。
    const sourceFlag = `${r.resultRaw || ''} ${r.note || ''}`.match(/(?:^|\s)(H|L|A)(?:\s|$)/i);
    if (sourceFlag) return sourceFlag[1].toUpperCase();
    const ref = parseRef(r.ref);
    if (!ref) return '';
    const n = num(r.result);
    if (n !== null) {
      if (ref.hi !== null && (n > ref.hi || (!ref.hiInclusive && n === ref.hi))) return 'H';
      if (ref.lo !== null && (n < ref.lo || (!ref.loInclusive && n === ref.lo))) return 'L';
      return '';
    }
    // 參考值是「陰性／無」而結果是「陽性／1+~4+」→ 標異常
    if (ref.qual && isNeg(ref.qual) && isPos(r.result)) return 'A';
    return '';
  }

  function analyseLab(rows) {
    const today = new Date(); today.setHours(0, 0, 0, 0);

    // 日期軸（由舊到新）
    const dateKeys = [...new Set(rows.map(r => r.dateRaw))]
      .sort((a, b) => (rocDate(a) || 0) - (rocDate(b) || 0));

    // 同名但單位、檢體、方法或參考值不同時不可直接畫成同一條趨勢。
    const items = new Map();
    for (const r of rows) {
      const k = [r.item.toLowerCase(), r.unit, r.spec, r.method, r.refText].join('|');
      if (!items.has(k)) items.set(k, {
        item: r.item, cat: r.cat, unit: r.unit, ref: r.refText, refObj: parseRef(r.ref),
        method: r.method, spec: r.spec, cells: new Map(), order: r.order, srcs: new Set()
      });
      const g = items.get(k);
      if (!g.unit && r.unit) g.unit = r.unit;
      if (!g.ref && r.refText) g.ref = r.refText;
      g.srcs.add(r.src);
      const prev = g.cells.get(r.dateRaw);
      const cell = { value: r.result, flag: flagOf(r), n: num(r.result), dateRaw: r.dateRaw, note: r.note };
      if (prev) prev.push(cell); else g.cells.set(r.dateRaw, [cell]);
    }

    const list = [...items.values()].map(g => {
      const series = dateKeys.map(dk => g.cells.get(dk) || null);
      // 同一天若有多筆結果，不任選其中一筆畫趨勢；表格仍完整列出所有值。
      const nums = series.map(cs => {
        const ns = cs ? cs.map(c => c.n).filter(n => n !== null) : [];
        return ns.length === 1 ? ns[0] : null;
      });
      const seen = nums.filter(x => x !== null);
      // 趨勢：只有在至少兩個數值時才算；非數值（陰性/陽性）不做趨勢
      let trend = '';
      if (seen.length >= 2) {
        const a = seen[0], b = seen[seen.length - 1];
        trend = b > a ? '↑' : b < a ? '↓' : '→';
      }
      const latest = [...series].reverse().find(Boolean) || null;
      const everAbnormal = series.some(cs => cs && cs.some(c => c.flag));
      const latestAbnormal = !!(latest && latest.some(c => c.flag));
      return Object.assign(g, { series, nums, trend, latest, everAbnormal, latestAbnormal, srcs: [...g.srcs] });
    });

    // 分類：依「檢驗類別」分組，組內維持原始出現順序
    const byCat = new Map();
    for (const g of list) {
      if (!byCat.has(g.cat)) byCat.set(g.cat, []);
      byCat.get(g.cat).push(g);
    }

    const dates = rows.map(r => r.date).filter(Boolean).sort((a, b) => a - b);
    const clinics = new Map();
    for (const r of rows) clinics.set(r.src, (clinics.get(r.src) || 0) + 1);

    return {
      kind: 'lab', rows, today, dateKeys, items: list, byCat,
      abnormal: list.filter(g => g.latestAbnormal),
      historicalAbnormal: list.filter(g => g.everAbnormal && !g.latestAbnormal),
      clinics: [...clinics.entries()].sort((a, b) => b[1] - a[1]),
      span: dates.length ? { from: dates[0], to: dates[dates.length - 1] } : null
    };
  }

  const cellText = cs => cs ? cs.map(c => c.value + (c.flag ? ` ${c.flag}` : '')).join(' / ') : '';

  /* ⭐ 迷你折線圖（純 SVG，不引外部函式庫）。淡綠色帶＝參考範圍，紅點＝超出參考值。
   *   只有一個時間點時畫成單點——畫不出趨勢就不要假裝有趨勢。 */
  function sparkline(g, nDates) {
    const pts = [];
    g.nums.forEach((n, i) => {
      if (n === null) return;
      pts.push({ i, n, bad: !!(g.series[i] && g.series[i].some(c => c.flag)) });
    });
    if (!pts.length) return '';
    const W = 104, H = 26, P = 3;
    const ref = g.refObj || {};
    const vals = pts.map(p => p.n);
    let lo = Math.min(...vals), hi = Math.max(...vals);
    if (ref.lo != null) { lo = Math.min(lo, ref.lo); hi = Math.max(hi, ref.lo); }
    if (ref.hi != null) { lo = Math.min(lo, ref.hi); hi = Math.max(hi, ref.hi); }
    if (hi === lo) { hi = lo + Math.abs(lo || 1) * 0.5; lo = lo - Math.abs(lo || 1) * 0.5; }
    const pad = (hi - lo) * 0.14; lo -= pad; hi += pad;
    const X = i => nDates > 1 ? P + i * (W - 2 * P) / (nDates - 1) : W / 2;
    const Y = v => H - P - (v - lo) / (hi - lo) * (H - 2 * P);
    let band = '';
    if (ref.lo != null || ref.hi != null) {
      const y1 = Y(ref.hi != null ? ref.hi : hi), y2 = Y(ref.lo != null ? ref.lo : lo);
      band = `<rect x="0" y="${y1.toFixed(1)}" width="${W}" height="${Math.max(1, y2 - y1).toFixed(1)}" class="nh-band"/>`;
    }
    const line = pts.length > 1
      ? `<path d="${pts.map((p, k) => `${k ? 'L' : 'M'}${X(p.i).toFixed(1)},${Y(p.n).toFixed(1)}`).join(' ')}" class="nh-line"/>` : '';
    const dots = pts.map(p => `<circle cx="${X(p.i).toFixed(1)}" cy="${Y(p.n).toFixed(1)}" r="2.1" class="${p.bad ? 'nh-dotbad' : 'nh-dot'}"/>`).join('');
    return `<svg class="nh-spark" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" aria-hidden="true">${band}${line}${dots}</svg>`;
  }

  /** 大表格：TSV。用 Tab 分隔是為了直接貼進 Excel／Word 會自動變表格 */
  function labToTable(a) {
    const L = [];
    L.push(['檢驗項目', '單位', '參考值', '檢體', '方法', '院所', ...a.dateKeys].join('\t'));
    for (const [cat, list] of a.byCat) {
      L.push(`【${cat}】`);
      for (const g of list) L.push([
        g.item, g.unit || '', g.ref || '', g.spec || '', g.method || '', g.srcs.join('、'),
        ...g.series.map(cellText)
      ].join('\t'));
    }
    return L.join('\n');
  }

  /** 簡易條列：依檢驗日期／院所分組，只留項目、結果與異常箭頭。 */
  function labToSimpleList(a) {
    const groups = new Map();
    for (const r of a.rows) {
      const key = `${r.dateRaw}|${r.src}`;
      if (!groups.has(key)) groups.set(key, { date: r.date, dateRaw: r.dateRaw, src: r.src, items: new Map() });
      const group = groups.get(key);
      const itemKey = `${r.item}|${r.unit}`;
      if (!group.items.has(itemKey)) group.items.set(itemKey, { item: r.item, values: [] });
      const flag = flagOf(r);
      const normalized = /^(?:Negative|\(-\))$/i.test(r.result) ? '(-)'
        : /^(?:Positive|\(\+\))$/i.test(r.result) ? '(+)'
        : `${r.result}${flag === 'H' ? '↑' : flag === 'L' ? '↓' : ''}`;
      const values = group.items.get(itemKey).values;
      if (!values.includes(normalized)) values.push(normalized);
    }
    return [...groups.values()]
      .sort((x, y) => y.date - x.date)
      .map(group => `${group.dateRaw} ${group.src}\n` +
        [...group.items.values()].map(item => `- ${item.item} ${item.values.join(' / ')}`).join('\n'))
      .join('\n');
  }

  /** 完整條列：一項一行，把時序串起來，保留既有詳細複製功能。 */
  function labToList(a) {
    const L = [];
    L.push(`【檢驗結果整理】${fmt(a.today)}`);
    if (a.span) L.push(`資料期間：${fmt(a.span.from)} ～ ${fmt(a.span.to)}　共 ${a.rows.length} 筆、${a.dateKeys.length} 個日期、${a.items.length} 個項目`);
    L.push('');
    for (const [cat, list] of a.byCat) {
      L.push(`[${cat}]`);
      for (const g of list) {
        const seq = g.series.map((cs, i) => cs ? `${a.dateKeys[i]} ${cellText(cs)}` : null)
                            .filter(Boolean).join(' → ');
        L.push(`  ${g.item}${g.unit ? ` (${g.unit})` : ''}：${seq}${g.trend ? ` ${g.trend}` : ''}` +
               (g.ref ? `　[參考 ${g.ref}]` : ''));
      }
    }
    if (a.abnormal.length) {
      L.push('');
      L.push(`— ⚠ 超出參考值的項目（${a.abnormal.length} 項）—`);
      for (const g of a.abnormal) {
        L.push(`  ${g.item}：${cellText(g.latest)}${g.unit ? ' ' + g.unit : ''}　[參考 ${g.ref || '—'}]`);
      }
    }
    if (a.historicalAbnormal.length) {
      L.push('');
      L.push(`— 曾有異常、最新已無異常旗標（${a.historicalAbnormal.length} 項）—`);
      for (const g of a.historicalAbnormal) {
        const history = g.series.flatMap((cs, i) => cs ? cs.filter(c => c.flag).map(c => `${a.dateKeys[i]} ${c.value} ${c.flag}`) : []);
        L.push(`  ${g.item}：${history.join('、')}；最新 ${cellText(g.latest)}`);
      }
    }
    L.push('');
    L.push('※ 由雲端檢驗欄位自動彙整；H／L 為依「參考值」欄位自動標示，參考值格式無法解析者不標。');
    return L.join('\n');
  }

  // ══════════════════════════════════════════════════════
  //  C. 影像及病理（IMUE0130）
  // ══════════════════════════════════════════════════════
  const displayText = el => String(el && (el.innerText || el.textContent) || '')
    .replace(/\r/g, '')
    .split('\n')
    .map(s => s.replace(/[ \t\f\v]+/g, ' ').trim())
    .filter(Boolean)
    .join('\n');

  const isVisible = el => {
    if (!el || !el.isConnected) return false;
    const style = getComputedStyle(el), rect = el.getBoundingClientRect();
    return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
  };

  function readImagingRows(table) {
    const idx = headerIndexer(table);
    const col = {
      date: idx('檢驗日期'), order: idx('醫令名稱'), result: idx('報告結果'),
      cat: idx('檢驗類別'), src: idx('來源')
    };
    if (Object.values(col).some(i => i < 0)) return [];
    const out = [];
    let sourceIndex = 0;
    for (const tr of table.querySelectorAll('tbody tr')) {
      const tds = [...tr.children];
      if (tds.length <= Math.max(...Object.values(col))) continue;
      const dateRaw = txt(tds[col.date]);
      if (!dateRaw || dateRaw === '檢驗日期') continue;
      const reportCell = tds[col.result];
      const reportControl = [...reportCell.querySelectorAll('a, button, [role="button"]')]
        .find(el => /報告/.test(txt(el)) && isVisible(el)) || null;
      const cellReport = displayText(reportCell)
        .split('\n')
        .filter(line => !/^報告$/.test(line))
        .join('\n')
        .trim();
      const order = displayText(tds[col.order]);
      const cat = displayText(tds[col.cat]);
      const src = displayText(tds[col.src]);
      out.push({
        sourceIndex,
        key: [dateRaw, order, cat, src, sourceIndex].join('|'),
        dateRaw, date: rocDate(dateRaw), order, cat, src,
        report: cellReport.length >= 20 ? cellReport : '',
        reportCell, reportControl
      });
      sourceIndex += 1;
    }
    return out;
  }

  function reportSurfaceCandidates() {
    const seen = new Set(), surfaces = [];
    const standard = [...document.querySelectorAll(
      '[role="dialog"], dialog, .modal, .ui-dialog, .gary-cover .frow.frow-reports'
    )];
    for (const el of standard) { seen.add(el); surfaces.push(el); }
    const markers = [...document.querySelectorAll('body *')].filter(el => {
      if (el.children.length || el.closest('table') || el.closest('#' + ID)) return false;
      return /^報告日期\s*[：:]/.test(txt(el));
    });
    for (const marker of markers) {
      let el = marker.parentElement;
      for (let depth = 0; el && el !== document.body && depth < 8; depth += 1, el = el.parentElement) {
        if (el.closest('table') || el.closest('#' + ID)) continue;
        if (displayText(el).length < 40) continue;
        if (!seen.has(el)) { seen.add(el); surfaces.push(el); }
        break;
      }
    }
    return surfaces;
  }

  function visibleReportSurfaces() {
    return reportSurfaceCandidates().filter(el => {
      if (isVisible(el)) return true;
      // 健保雲端的 .frow-reports 由外層 open class 控制；部分 Chromium
      // 版本會對這個內層容器回報 0x0 rect，但報告本文實際可見。
      const cover = el.closest('.gary-cover.open');
      const body = el.matches('.show-result-text') ? el : el.querySelector('.show-result-text');
      return !!cover && isVisible(cover) && !!body &&
        getComputedStyle(body).display !== 'none' && getComputedStyle(body).visibility !== 'hidden';
    });
  }

  function reportBodyText(surface) {
    const body = surface.matches('.show-result-text')
      ? surface
      : surface.querySelector('.show-result-text');
    return displayText(body || surface);
  }

  function sanitizeReportText(raw, row) {
    const privateLabel = /^(?:病人姓名|患者姓名|姓名|身分證號|身份證號|病歷號|出生日期|性別|電話|聯絡電話|地址)\s*[：:]/i;
    const signatureLabel = /^(?:報告醫師|判讀醫師|簽署醫師|醫師姓名|Reported\s+By|Verified\s+By|Signed\s+By|Electronically\s+Signed)\s*[：:]?/i;
    const metadataLabel = /^(?:報告日期|檢驗日期|醫令名稱|檢驗類別|來源)\s*[：:]/;
    const orderFlat = String(row && row.order || '').replace(/\s+/g, ' ').trim();
    const linesOut = [];
    const withoutTrailingSignature = String(raw || '').replace(
      /\s+(?:報告醫師|判讀醫師|簽署醫師|Reported\s+By|Verified\s+By|Signed\s+By|Electronically\s+Signed)\s*[：:].*$/i,
      ''
    );
    for (let line of withoutTrailingSignature.replace(/\r/g, '').split('\n')) {
      line = line.replace(/[ \t\f\v]+/g, ' ').trim();
      if (!line || privateLabel.test(line) || signatureLabel.test(line) || metadataLabel.test(line)) continue;
      if (/^(?:報告內容|報告結果|報告|關閉|返回)$/.test(line)) continue;
      if (orderFlat && line.replace(/\s+/g, ' ') === orderFlat) continue;
      linesOut.push(line);
    }
    return linesOut.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  }

  function reportSurfaceSignature(surface) {
    const value = String(surface && surface.textContent || '');
    let hash = 2166136261;
    for (let index = 0; index < value.length; index += 1) {
      hash ^= value.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    return `${value.length}|${hash >>> 0}`;
  }

  const reportSnapshot = () => new Map(reportSurfaceCandidates().map(el => [el, reportSurfaceSignature(el)]));

  function reportSurfaceMatchesRow(surface, row) {
    const order = String(row && row.order || '').replace(/\s+/g, '');
    const surfaceText = String(surface && surface.textContent || '').replace(/\s+/g, '');
    return order.length >= 4 && surfaceText.includes(order);
  }

  async function waitForReport(row, before, cancelled, duplicateReport = '', timeoutMs = 12000) {
    const deadline = Date.now() + timeoutMs;
    const duplicateFallbackAt = Date.now() + 500;
    while (Date.now() < deadline) {
      if (cancelled()) throw new Error('cancelled');
      const currentTable = pickTableBy(IMAGING_HEADS);
      const currentRow = currentTable && readImagingRows(currentTable).find(r => r.key === row.key);
      if (currentRow && currentRow.report) return sanitizeReportText(currentRow.report, row);
      const visible = new Set(visibleReportSurfaces());
      for (const surface of reportSurfaceCandidates()) {
        const value = reportBodyText(surface);
        const changed = before.get(surface) !== reportSurfaceSignature(surface);
        const rowMatched = reportSurfaceMatchesRow(surface, row);
        const visibleMatch = visible.has(surface) && rowMatched;
        // 實際網站會重複利用同一個彈窗 DOM。除了比對本文是否變更，
        // 也用彈窗的「醫令名稱」確認屬於當前列。健保頁會在彈窗仍隱藏時
        // 先更新報告 DOM，因此「內容已變更」本身也是可接受的完成訊號。
        if (value && (changed || visibleMatch || (duplicateReport && rowMatched && Date.now() >= duplicateFallbackAt))) {
          const result = sanitizeReportText(value, row);
          // 心電圖等結果可能只有「Normal ECG」一類的短報告，
          // 不能用字數門檻排除；只排除尚在載入的佔位文字。
          if (result && !/^(?:載入中|讀取中|查詢中|loading)(?:[.…‥⋯]*)$/i.test(result)) {
            // 連續重複報告有時不會再改寫 DOM。只有同組前一份已成功報告
            // 與目前隱藏本文完全相同時才沿用，避免把其他醫令的舊彈窗誤套。
            if (!changed && !visibleMatch && result !== duplicateReport) continue;
            return result;
          }
        }
      }
      await new Promise(resolve => setTimeout(resolve, 120));
    }
    return '';
  }

  function closeReportSurface() {
    for (const surface of visibleReportSurfaces()) {
      const cover = surface.closest('.gary-cover.open');
      const scope = cover || surface;
      const close = [...scope.querySelectorAll(
        'button, a, [role="button"], [data-dismiss="modal"], .ui-dialog-titlebar-close, .close'
      )].find(el => isVisible(el) && (
        /關閉/.test(`${el.getAttribute('aria-label') || ''} ${el.getAttribute('title') || ''}`) ||
        /^關閉$/.test(txt(el)) || el.matches('[data-dismiss="modal"],.ui-dialog-titlebar-close,.close')
      ));
      if (close && isVisible(close)) { close.click(); return; }
      if (cover) { cover.classList.remove('open'); return; }
    }
  }

  async function captureImagingReports(a, progress, cancelled) {
    let captured = 0, missing = 0;
    for (let index = 0; index < a.rows.length; index += 1) {
      if (cancelled()) throw new Error('cancelled');
      const target = a.rows[index];
      progress(index + 1, a.rows.length, target, 'opening');
      const currentTable = pickTableBy(IMAGING_HEADS);
      const current = currentTable && readImagingRows(currentTable).find(row => row.key === target.key);
      if (!current) { missing += 1; continue; }
      if (current.report) {
        target.report = sanitizeReportText(current.report, target);
      } else if (current.reportControl) {
        let duplicateReport = '';
        for (let priorIndex = index - 1; priorIndex >= 0; priorIndex -= 1) {
          const prior = a.rows[priorIndex];
          if (prior.report && prior.order === target.order && prior.cat === target.cat && prior.src === target.src) {
            duplicateReport = prior.report;
            break;
          }
        }
        const before = reportSnapshot();
        current.reportControl.click();
        target.report = await waitForReport(target, before, cancelled, duplicateReport);
        closeReportSurface();
      }
      if (target.report) captured += 1;
      else missing += 1;
      a.captured = captured;
      a.missing = missing;
      progress(index + 1, a.rows.length, target, 'done');
    }
    a.captured = captured;
    a.missing = missing;
    return a;
  }

  const imagingHeaders = ['檢驗日期', '醫令名稱', '報告結果', '檢驗類別', '來源'];
  const imagingRowsSorted = a => [...a.rows].sort((x, y) => {
    const dx = x.date ? x.date.getTime() : -Infinity;
    const dy = y.date ? y.date.getTime() : -Infinity;
    return dy - dx || x.sourceIndex - y.sourceIndex;
  });
  const tsvCell = value => {
    const s = String(value || '');
    return /["\t\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };

  function imagingToTable(a) {
    const rows = imagingRowsSorted(a).map(row => [row.dateRaw, row.order, row.report, row.cat, row.src]);
    return [imagingHeaders, ...rows].map(row => row.map(tsvCell).join('\t')).join('\r\n');
  }

  function imagingToHtmlTable(a) {
    const rows = imagingRowsSorted(a).map(row => [row.dateRaw, row.order, row.report, row.cat, row.src]);
    const cell = value => esc(String(value || '')).replace(/\n/g, '<br>');
    return `<table><thead><tr>${imagingHeaders.map(h => `<th>${cell(h)}</th>`).join('')}</tr></thead>` +
      `<tbody>${rows.map(row => `<tr>${row.map(value => `<td>${cell(value)}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
  }

  async function copyRichTable(html, plain) {
    if (navigator.clipboard && navigator.clipboard.write && window.ClipboardItem) {
      try {
        const item = new ClipboardItem({
          'text/html': new Blob([html], { type: 'text/html' }),
          'text/plain': new Blob([plain], { type: 'text/plain' })
        });
        await navigator.clipboard.write([item]);
        return true;
      } catch (e) { /* 使用下方同步備援 */ }
    }
    const host = document.createElement('div');
    host.contentEditable = 'true';
    host.style.cssText = 'position:fixed;left:-10000px;top:0;opacity:0;pointer-events:none';
    host.innerHTML = html;
    document.body.appendChild(host);
    const selection = window.getSelection(), range = document.createRange();
    range.selectNodeContents(host); selection.removeAllRanges(); selection.addRange(range);
    let ok = false;
    try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
    selection.removeAllRanges(); host.remove();
    if (ok) return true;
    if (navigator.clipboard && navigator.clipboard.writeText) {
      try { await navigator.clipboard.writeText(plain); return true; } catch (e) { /* 回報失敗 */ }
    }
    return false;
  }

  // ══════════════════════════════════════════════════════
  //  面板
  // ══════════════════════════════════════════════════════
  function disposePanel(wrap = document.getElementById(ID)) {
    if (!wrap) return;
    if (typeof wrap._nhCleanup === 'function') wrap._nhCleanup();
    wrap.querySelectorAll('button').forEach(button => { button.onclick = null; });
    wrap.remove();
    activePanelFingerprint = '';
  }

  function shell(title, footBtns) {
    const wrap = document.createElement('div');
    wrap.id = ID;
    wrap.innerHTML = `
      <div class="nh-head">
        <b>${esc(title)}</b>
        <span class="nh-sub">純本機處理・未上傳任何資料</span>
        <button class="nh-x" title="關閉">×</button>
      </div>
      <div class="nh-body"></div>
      <div class="nh-foot">${footBtns}<span class="nh-msg"></span>
        <span class="nh-clipwarn">含醫療資料；貼完請清除剪貼簿</span>
      </div>`;
    return wrap;
  }

  function wireCopy(wrap, a, map) {
    const msg = wrap.querySelector('.nh-msg');
    for (const [sel, [fn, label]] of Object.entries(map)) {
      const b = wrap.querySelector(sel);
      if (!b) continue;
      b.onclick = () => {
        const t = fn(a);
        // ⚠️ clipboard API 在分頁失焦時會 reject；一定要有備援與失敗回饋，
        //    否則按了沒反應，使用者會以為沒點到。
        const done = ok => { msg.textContent = ok ? `已複製${label}` : '複製失敗，請手動選取'; setTimeout(() => msg.textContent = '', 2500); };
        const fallback = () => {
          const ta = document.createElement('textarea');
          ta.value = t; ta.style.cssText = 'position:fixed;top:-9999px';
          document.body.appendChild(ta); ta.select();
          let ok = false; try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
          ta.remove(); done(ok);
        };
        if (navigator.clipboard && window.isSecureContext) navigator.clipboard.writeText(t).then(() => done(true), fallback);
        else fallback();
      };
    }
    wrap.querySelector('.nh-x').onclick = () => disposePanel(wrap);
  }

  /** 檢視切換（滑鼠點 tab 或按數字鍵）。面板關掉要一起把鍵盤監聽拆掉，不然會殘留。 */
  function wireViews(wrap) {
    const tabs = [...wrap.querySelectorAll('.nh-tab')];
    if (!tabs.length) return;
    const show = v => {
      tabs.forEach(t => t.classList.toggle('on', t.dataset.v === v));
      wrap.querySelectorAll('.nh-pane').forEach(p => p.hidden = p.dataset.p !== v);
      wrap.querySelector('.nh-body').scrollTop = 0;
    };
    tabs.forEach(t => t.onclick = () => show(t.dataset.v));
    const onKey = e => {
      if (!document.body.contains(wrap)) { document.removeEventListener('keydown', onKey); return; }
      const el = document.activeElement, tag = el && el.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || (el && el.isContentEditable)) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const i = ['1', '2', '3', '4'].indexOf(e.key);
      if (i >= 0 && tabs[i]) { e.preventDefault(); show(tabs[i].dataset.v); }
      if (e.key === 'Escape') disposePanel(wrap);
    };
    document.addEventListener('keydown', onKey);
    wrap._nhCleanup = () => document.removeEventListener('keydown', onKey);
    show(tabs[0].dataset.v);
  }

  /* ⭐ 用藥甘特圖：一支藥一列，每次處方一條 bar（起＝就醫日、長度＝給藥日數）。
   *   斷藥的空窗直接看得出來，跨院所用不同顏色，今天畫一條紅線。純 SVG/CSS，不引外部函式庫。 */
  const CLINIC_CLASS = (a, src) => 'nh-k' + (a.clinicList.findIndex(c => c.src === src) % 6);

  function ganttHtml(a) {
    if (!a.axis) return '<div class="nh-note">沒有可用的日期資料，畫不出時間軸。</div>';
    const t0 = a.axis.from.getTime(), t1 = a.axis.to.getTime();
    const span = Math.max(86400000, t1 - t0);
    const L = d => (d.getTime() - t0) / span * 100;

    // 月刻度；跨度太長就改成每 3 個月一格，免得標籤擠成一團
    const months = (a.axis.to.getFullYear() - a.axis.from.getFullYear()) * 12 + (a.axis.to.getMonth() - a.axis.from.getMonth());
    const step = months > 14 ? 3 : 1;
    const ticks = [];
    const c = new Date(a.axis.from.getFullYear(), a.axis.from.getMonth(), 1);
    while (c <= a.axis.to) {
      if (c >= a.axis.from) ticks.push({ p: L(c), t: (c.getMonth() === 0 ? `${c.getFullYear()}/1` : `${c.getMonth() + 1}月`) });
      c.setMonth(c.getMonth() + step);
    }
    const grid = ticks.map(k => `<i class="nh-gl" style="left:${pct(k.p)}"></i>`).join('');
    const todayP = L(a.today);
    const todayMark = (todayP >= 0 && todayP <= 100) ? `<i class="nh-gtoday" style="left:${pct(todayP)}" title="今天"></i>` : '';

    const H = [];
    H.push(`<div class="nh-note">橫軸 ${fmt(a.axis.from)} ～ ${fmt(a.axis.to)}；每條長度＝給藥日數，顏色＝開立院所，紅線＝今天。空白處就是沒藥的期間。</div>`);
    H.push(`<div class="nh-legend">` + a.clinicList.map(c =>
      `<span><i class="nh-sw ${CLINIC_CLASS(a, c.src)}"></i>${esc(c.src)}</span>`).join('') + `</div>`);
    H.push('<div class="nh-gwrap">');
    H.push(`<div class="nh-gaxis">${grid}${ticks.map(k => `<span class="nh-gt" style="left:${pct(k.p)}">${k.t}</span>`).join('')}</div>`);
    for (const g of a.timeline) {
      H.push(`<div class="nh-grow">
        <div class="nh-glabel" title="${esc(g.name)}">${esc(g.name)}${g.stillOn ? '' : '<em class="nh-off">停</em>'}</div>
        <div class="nh-gtrack">${grid}${todayMark}` +
        g.events.map(e => {
          const l = L(e.date);
          const w = e.endExclusive ? Math.max(0.6, L(e.endExclusive) - l) : 0.6;
          return `<i class="nh-gbar ${CLINIC_CLASS(a, e.src)}" style="left:${pct(l)};width:${pct(w)}"
            title="${esc(e.src)}　${fmt(e.date)}${e.days ? ` 起 ${e.days} 日` : ''}　${esc(e.drug)}"></i>`;
        }).join('') + `</div></div>`);
    }
    H.push('</div>');
    return H.join('');
  }

  function clinicHtml(a) {
    const H = [];
    const rx = a.clinicList.filter(c => !c.isPharmacy), ph = a.clinicList.filter(c => c.isPharmacy);
    H.push('<div class="nh-note">依「來源」欄分組，同一來源同一天的處方歸為一次。來源欄同時帶了就醫類別（門診／藥局／住院／急診），所以醫療院所與藥局分開列。</div>');
    if (ph.length) {
      // ⚠️ 別讓人以為藥局那段可以自動掛回原醫院——這頁的雲端資料沒有帶開立院所，
      //    實測 37 筆藥局列沒有任何一筆能用「同日＋同診斷」或「同藥品代碼」對回門診列。
      H.push(`<div class="nh-warnbox">藥局那段是<b>調劑</b>紀錄，不是開立紀錄。這一頁的雲端欄位<b>沒有帶原開立院所</b>，
        所以無法自動掛回是哪家醫院／診所開的——實測這份資料的 ${ph.reduce((s, c) => s + c.n, 0)} 筆藥局紀錄，
        沒有一筆能用「同一天＋同一診斷」或「同一藥品代碼」對回門診紀錄。要知道是誰開的只能看處方箋或問病人。</div>`);
    }
    const renderVisits = c => {
      for (const v of c.visits) {
        H.push(`<div class="nh-visit">
          <div class="nh-vhead">${fmt(v.date)}${v.dx.name ? `　${esc(v.dx.name)}${v.dx.code ? `(${esc(v.dx.code)})` : ''}` : ''}
            <span class="nh-vn">${v.items.length} 品項</span></div>` +
          v.items.map(r => {
            const left = r.endExclusive ? daysBetween(a.today, r.endExclusive) : null;
            const on = r.date <= a.today && r.endExclusive && r.endExclusive > a.today;
            return `<div class="nh-vitem${on ? '' : ' nh-vdone'}">
              <b>${esc(r.ingr || r.drug)}</b>${r.elder ? '<em class="nh-warn">⚠高齡</em>' : ''}
              <span>${esc(r.sig || '')}　${r.days ?? '?'} 日${left !== null ? (on ? `　餘約 ${left} 日` : '　已結束') : ''}</span>
              <span class="nh-d3">${esc(r.drug)}</span></div>`;
          }).join('') + `</div>`);
      }
    };
    const section = (list, title) => {
      if (!list.length) return;
      if (title) H.push(`<div class="nh-sect">${title}</div>`);
      for (const c of list) {
        H.push(`<h3 class="nh-h"><i class="nh-sw ${CLINIC_CLASS(a, c.src)}"></i>${esc(c.src)}
          ${c.type ? `<em class="nh-type${c.isPharmacy ? ' nh-typep' : ''}">${esc(c.type)}</em>` : ''}
          <span class="nh-hn">${c.visits.length} 次／${c.n} 筆</span></h3>`);
        renderVisits(c);
      }
    };
    section(rx, ph.length ? '醫療院所（開立）' : '');
    section(ph, '藥局（調劑）');
    return H.join('');
  }

  function renderMed(a) {
    const wrap = shell('雲端藥歷整理',
      `<button class="nh-btn nh-c1">複製精簡藥歷</button>
       <button class="nh-btn nh-ghost nh-c2">複製目前用藥</button>
       <button class="nh-btn nh-ghost nh-c3">複製用藥時序</button>
       <button class="nh-btn nh-ghost nh-c4">複製完整整理</button>
       <button class="nh-btn nh-ghost nh-export">匯出工作台 JSON</button>`);
    const H = [];
    H.push(`<div class="nh-stat">
      <span><b>${a.rows.length}</b> 筆用藥</span>
      <span><b>${a.merged.length}</b> 種推估仍在服用</span>
      <span><b>${a.clinics.length}</b> 家院所</span>
      ${a.dup.length ? `<span class="nh-warn"><b>${a.dup.length}</b> 組疑似重複</span>` : ''}
      ${a.elder.length ? `<span class="nh-warn"><b>${a.elder.length}</b> 項高齡注意</span>` : ''}
    </div>`);
    if (a.span) H.push(`<div class="nh-note">資料期間 ${fmt(a.span.from)} ～ ${fmt(a.span.to)}</div>`);

    if (a.dup.length) {
      // 重複用藥永遠放在最上面、不藏進分頁——這是最需要一眼看到的東西
      H.push('<h3 class="nh-h nh-hw">⚠ 疑似重複用藥</h3>');
      H.push('<div class="nh-note">同一成分（ATC7）由不同院所開立，且給藥期間重疊。</div>');
      for (const d of a.dup) {
        H.push(`<div class="nh-dup"><div class="nh-dupname">${esc(d.name)} <code>${esc(d.key)}</code></div>` +
          d.rows.map(r => `<div class="nh-dupline">・${esc(r.drug)}<span>${esc(r.src)}　${fmt(r.date)}　${r.days ?? '?'}日</span></div>`).join('') + '</div>');
      }
    }

    // ── 三種檢視：藥理分類／依院所／時序圖（數字鍵 1・2・3 切換）──
    H.push(`<div class="nh-tabs">
      <button class="nh-tab" data-v="class"><kbd>1</kbd>藥理分類</button>
      <button class="nh-tab" data-v="clinic"><kbd>2</kbd>依院所<em>${a.clinicList.length}</em></button>
      <button class="nh-tab" data-v="time"><kbd>3</kbd>時序圖<em>${a.timeline.length}</em></button>
    </div>`);

    // ① 藥理分類
    const P1 = [];
    P1.push(`<h3 class="nh-h">推估仍在服用（${a.merged.length} 種／${a.active.length} 筆處方）</h3>`);
    if (!a.merged.length) P1.push('<div class="nh-note">依「就醫日期＋給藥日數」推算，目前沒有仍在效期內的品項。</div>');
    for (const [cls, list] of a.byClass) {
      P1.push(`<div class="nh-cls">${esc(cls)}</div>`);
      for (const r of list) {
        const left = r.endExclusive ? daysBetween(a.today, r.endExclusive) : null;
        P1.push(`<div class="nh-drug">
          <div class="nh-d1">${esc(r.ingr || r.drug)}${r.elder ? '<em class="nh-warn">⚠高齡注意</em>' : ''}</div>
          <div class="nh-d2">${esc(r.sig || '')}　${r.days ?? '?'} 日${left !== null ? `　<b>餘約 ${left} 日</b>` : ''}${r.refills > 1 ? `　<em class="nh-rf">同院所已開 ${r.refills} 次，最早 ${fmt(r.since)}</em>` : ''}</div>
          <div class="nh-d3">${esc(r.drug)}</div>
          <div class="nh-d3">${esc(r.src)}　${fmt(r.date)}${r.dx.name ? `　${esc(r.dx.name)}${r.dx.code ? `(${esc(r.dx.code)})` : ''}` : ''}</div>
        </div>`);
      }
    }
    P1.push(`<h3 class="nh-h">開立院所</h3><div class="nh-clinics">` +
      a.clinics.map(([n, c]) => `<span>${esc(n)} <b>${c}</b></span>`).join('') + '</div>');
    if (a.past.length) P1.push(`<div class="nh-note">另有 ${a.past.length} 筆給藥期間已結束，未列入「仍在服用」，但已納入時序圖。</div>`);
    if (a.future.length) P1.push(`<div class="nh-note">另有 ${a.future.length} 筆未來日期處方，未列入「仍在服用」，但保留於時序圖供人工核對。</div>`);
    H.push(`<div class="nh-pane" data-p="class">${P1.join('')}</div>`);

    // ② 依院所
    H.push(`<div class="nh-pane" data-p="clinic" hidden>${clinicHtml(a)}</div>`);

    // ③ 時序圖＋原本的文字時序
    const P3 = [ganttHtml(a)];
    P3.push(`<h3 class="nh-h">用藥時序（文字版，${a.timeline.length} 種）</h3>`);
    P3.push('<div class="nh-note">同 ATC7／成分與商品規格的每一次開立，含已結束者。不同商品規格分線，換院所續領相同規格仍算同一條線。</div>');
    for (const g of a.timeline) {
      P3.push(`<div class="nh-tl">
        <div class="nh-tlname">${esc(g.name)}${g.stillOn ? '' : '<em class="nh-off">已停</em>'}${g.crossClinic ? `<em class="nh-warn">跨 ${g.srcs.length} 家院所</em>` : ''}</div>
        <div class="nh-tlseq">${g.events.map(e => `<span class="nh-ev" title="${esc(e.src)}　${esc(e.drug)}">${md(e.date)}${e.days ? `<i>${e.days}d</i>` : ''}</span>`).join('<b>›</b>')}</div>
        <div class="nh-d3">共 ${g.events.length} 次${g.span > 0 ? `　跨 ${g.span} 日` : ''}${g.gaps.length ? `　中斷 ${g.gaps.length} 次（最長 ${Math.max(...g.gaps.map(x => x.days))} 日）` : ''}</div>
      </div>`);
    }
    H.push(`<div class="nh-pane" data-p="time" hidden>${P3.join('')}</div>`);

    wrap.querySelector('.nh-body').innerHTML = H.join('');
    document.body.appendChild(wrap);
    wireViews(wrap);
    wireCopy(wrap, a, {
      '.nh-c1': [medToPasteFormat, '（精簡藥歷）'],
      '.nh-c2': [medToEMR, '（目前用藥）'],
      '.nh-c3': [medTimelineText, '（用藥時序）'],
      '.nh-c4': [medToText, '（完整整理）']
    });
    wrap.querySelector('.nh-export').onclick = () => {
      downloadJson(toMedSnapshot(a), `medcloud-medications-${fmt(a.today)}.json`);
      const msg = wrap.querySelector('.nh-msg');
      msg.textContent = '工作台 JSON 已下載';
      setTimeout(() => { if (document.body.contains(msg)) msg.textContent = ''; }, 2500);
    };
  }

  function renderLab(a) {
    const wrap = shell('雲端檢驗整理',
      `<button class="nh-btn nh-c1">複製大表格（Excel）</button>
       <button class="nh-btn nh-ghost nh-c2">複製簡易條列</button>
       <button class="nh-btn nh-ghost nh-c3">複製完整條列</button>`);
    wrap.classList.add('nh-wide');   // 大表格需要更寬的面板
    const H = [];
    H.push(`<div class="nh-stat">
      <span><b>${a.rows.length}</b> 筆結果</span>
      <span><b>${a.items.length}</b> 個項目</span>
      <span><b>${a.dateKeys.length}</b> 個檢驗日</span>
      <span><b>${a.clinics.length}</b> 家院所</span>
      ${a.abnormal.length ? `<span class="nh-warn"><b>${a.abnormal.length}</b> 項最新超出參考值</span>` : ''}
      ${a.historicalAbnormal.length ? `<span><b>${a.historicalAbnormal.length}</b> 項曾有異常</span>` : ''}
    </div>`);
    if (a.span) H.push(`<div class="nh-note">資料期間 ${fmt(a.span.from)} ～ ${fmt(a.span.to)}</div>`);
    if (a.dateKeys.length === 1) H.push('<div class="nh-note">⚠ 目前只讀到一個檢驗日期。若要看趨勢，請在頁面上把查詢期間拉長、或把分頁切成「顯示全部」後再按一次。</div>');

    // 大表格：日期為欄、項目為列
    H.push(`<h3 class="nh-h">時序大表格</h3>`);
    H.push('<div class="nh-tblwrap"><table class="nh-tbl"><thead><tr>' +
      `<th class="nh-sticky">檢驗項目</th><th>趨勢</th><th>單位</th><th>參考值</th>` +
      a.dateKeys.map(d => `<th>${esc(d)}</th>`).join('') + '</tr></thead><tbody>');
    for (const [cat, list] of a.byCat) {
      H.push(`<tr class="nh-catrow"><td colspan="${4 + a.dateKeys.length}">${esc(cat)}</td></tr>`);
      for (const g of list) {
        H.push('<tr>' +
          `<td class="nh-sticky">${esc(g.item)}${g.trend ? `<i class="nh-tr">${g.trend}</i>` : ''}` +
          `${g.spec || g.method ? `<small class="nh-labmeta">${esc([g.spec, g.method].filter(Boolean).join('／'))}</small>` : ''}</td>` +
          `<td class="nh-sparkcell">${sparkline(g, a.dateKeys.length) || '<span class="nh-na">—</span>'}</td>` +
          `<td>${esc(g.unit || '')}</td><td class="nh-ref">${esc(g.ref || '')}</td>` +
          g.series.map(cs => {
            if (!cs) return '<td class="nh-na">—</td>';
            const bad = cs.some(c => c.flag);
            return `<td class="${bad ? 'nh-bad' : ''}">${esc(cellText(cs))}</td>`;
          }).join('') + '</tr>');
      }
    }
    H.push('</tbody></table></div>');

    if (a.abnormal.length) {
      H.push(`<h3 class="nh-h nh-hw">⚠ 最新超出參考值（${a.abnormal.length} 項）</h3>`);
      H.push('<div class="nh-note">優先保留來源系統 H／L／A 旗標；無來源旗標時才依參考值輔助計算。格式無法解析者不判讀。</div>');
      for (const g of a.abnormal) {
        H.push(`<div class="nh-dupline">・${esc(g.item)}<span>${esc(cellText(g.latest))} ${esc(g.unit || '')}　參考 ${esc(g.ref || '—')}</span></div>`);
      }
    }
    if (a.historicalAbnormal.length) {
      H.push(`<h3 class="nh-h">曾有異常、最新已無異常旗標（${a.historicalAbnormal.length} 項）</h3>`);
      H.push('<div class="nh-note">下列項目只代表較早資料曾出現異常；最新結果請以右側時序表及健保原頁核對。</div>');
      for (const g of a.historicalAbnormal) {
        const history = g.series.flatMap((cs, i) => cs ? cs.filter(c => c.flag).map(c => `${a.dateKeys[i]} ${c.value} ${c.flag}`) : []);
        H.push(`<div class="nh-dupline">・${esc(g.item)}<span>${esc(history.join('、'))}；最新 ${esc(cellText(g.latest))}</span></div>`);
      }
    }

    H.push(`<h3 class="nh-h">檢驗院所</h3><div class="nh-clinics">` +
      a.clinics.map(([n, c]) => `<span>${esc(n)} <b>${c}</b></span>`).join('') + '</div>');

    wrap.querySelector('.nh-body').innerHTML = H.join('');
    document.body.appendChild(wrap);
    wireCopy(wrap, a, {
      '.nh-c1': [labToTable, '（大表格，可直接貼 Excel）'],
      '.nh-c2': [labToSimpleList, '（簡易條列）'],
      '.nh-c3': [labToList, '（完整條列）']
    });
  }

  function renderImaging(rows) {
    const a = {
      kind: 'imaging', rows,
      captured: rows.filter(row => row.report).length,
      missing: rows.filter(row => !row.report && !row.reportControl).length
    };
    const wrap = shell('影像及病理報告整理',
      '<button class="nh-btn nh-capture">一鍵讀取並複製</button>');
    wrap.classList.add('nh-wide');
    let cancelled = false, running = false, ready = a.captured === a.rows.length;
    wrap._nhCleanup = () => { cancelled = true; };
    const body = wrap.querySelector('.nh-body');
    const msg = wrap.querySelector('.nh-msg');
    const action = wrap.querySelector('.nh-capture');

    const renderPreview = () => {
      const ordered = imagingRowsSorted(a);
      body.innerHTML = `<div class="nh-stat">
          <span><b>${a.rows.length}</b> 筆檢查</span>
          <span><b data-imaging-captured>${a.captured}</b> 筆已讀取報告</span>
          ${a.missing ? `<span class="nh-warn"><b>${a.missing}</b> 筆無法讀取</span>` : ''}
        </div>
        <div class="nh-note">匯出只保留：檢驗日期、醫令名稱、報告結果、檢驗類別、來源。報告會逐筆在原頁開啟並於本機整理。</div>
        <div class="nh-progress" aria-live="polite"></div>
        <div class="nh-tblwrap nh-reportwrap"><table class="nh-tbl nh-reporttbl">
          <thead><tr>${imagingHeaders.map(h => `<th>${esc(h)}</th>`).join('')}</tr></thead>
          <tbody>${ordered.map(row => `<tr>
            <td>${esc(row.dateRaw)}</td><td>${esc(row.order)}</td>
            <td class="nh-reporttext">${row.report ? esc(row.report).replace(/\n/g, '<br>') : '<span class="nh-na">尚未讀取</span>'}</td>
            <td>${esc(row.cat)}</td><td>${esc(row.src).replace(/\n/g, '<br>')}</td>
          </tr>`).join('')}</tbody>
        </table></div>`;
    };

    const copyNow = async () => {
      const ok = await copyRichTable(imagingToHtmlTable(a), imagingToTable(a));
      msg.textContent = ok ? '已複製 5 欄整理表格' : '自動複製失敗，請再按一次';
      setTimeout(() => { if (document.body.contains(msg)) msg.textContent = ''; }, 3000);
      return ok;
    };

    renderPreview();
    if (ready) action.textContent = '複製整理表格';
    const runCapture = async (copyAfterCapture = false) => {
      if (running) return;
      if (ready) { if (copyAfterCapture) await copyNow(); return; }
      running = true; action.disabled = true; action.textContent = '正在讀取報告…';
      const progress = (current, total, row, phase) => {
        const el = body.querySelector('.nh-progress');
        const capturedEl = body.querySelector('[data-imaging-captured]');
        if (capturedEl) capturedEl.textContent = String(a.captured);
        if (el) el.textContent = phase === 'done'
          ? `已處理 ${current}/${total}（成功 ${a.captured} 筆）`
          : `正在讀取 ${current}/${total}：${row.order}`;
      };
      try {
        await captureImagingReports(a, progress, () => cancelled || !document.body.contains(wrap));
        if (cancelled || !document.body.contains(wrap)) return;
        ready = true;
        renderPreview();
        const progressEl = body.querySelector('.nh-progress');
        if (progressEl) progressEl.textContent = `讀取完成：${a.captured}/${a.rows.length} 筆報告`;
        action.textContent = '複製整理表格';
        if (copyAfterCapture) await copyNow();
      } catch (error) {
        if (String(error && error.message) !== 'cancelled') {
          msg.textContent = '讀取中斷，請保留本頁資料後再試一次';
          action.textContent = '重新讀取報告';
        }
      } finally {
        running = false;
        if (document.body.contains(action)) action.disabled = false;
      }
    };
    action.onclick = async () => {
      if (running) return;
      if (ready) await copyNow();
      else await runCapture(true);
    };
    wrap.querySelector('.nh-x').onclick = () => disposePanel(wrap);
    document.body.appendChild(wrap);
    // 報告本文不在初始表格 DOM，必須觸發原頁「報告」才會載入。
    // 使用者按下「整理影像／病理」即視為開始整理：面板開啟後自動逐筆讀取，
    // 完成時只呈現「複製整理表格」，避免還要再找一次啟動按鈕。
    if (!ready) setTimeout(() => runCapture(false), 0);
  }

  // ── 觸發鈕 ────────────────────────────────────────────
  const btn = document.createElement('button');
  btn.id = BTN;
  btn.textContent = '整理';
  btn.title = '把目前頁面上的用藥、檢驗、影像及病理報告整理成可貼上的格式（純本機）';

  /** 依目前頁面內容更新鈕的文字——SPA 換頁不會重載 script，所以每次點都要重測 */
  function refreshLabel() {
    const k = detectPage();
    btn.textContent = k === 'imaging' ? '整理影像／病理'
      : k === 'lab' ? '整理檢驗'
      : k === 'med' ? '整理藥歷'
      : '整理';
    if (activePanelFingerprint && activePanelFingerprint !== sourceFingerprint(k)) disposePanel();
  }
  refreshLabel();
  setInterval(refreshLabel, 2000);

  btn.onclick = () => {
    disposePanel();
    const kind = detectPage();
    if (!kind) {
      alert('這一頁沒有找到可整理的表格。\n\n目前支援：用藥紀錄、檢驗結果、影像及病理。\n請先在頁面上查詢出資料，再按一次。');
      return;
    }
    if (kind === 'imaging') {
      const rows = readImagingRows(pickTableBy(IMAGING_HEADS));
      if (!rows.length) { alert('找到影像及病理表格但沒有可解析的資料列。\n可能是查詢結果為空，或欄位格式與預期不同。'); return; }
      renderImaging(rows);
    } else if (kind === 'lab') {
      const rows = readLabRows(pickTableBy(LAB_HEADS));
      if (!rows.length) { alert('找到檢驗表格但沒有可解析的資料列。\n可能是查詢結果為空，或欄位格式與預期不同。'); return; }
      renderLab(analyseLab(rows));
    } else {
      const rows = readMedRows(pickTableBy(MED_HEADS));
      if (!rows.length) { alert('找到用藥表格但沒有可解析的資料列。\n可能是查詢結果為空，或欄位格式與預期不同。'); return; }
      renderMed(analyseMed(rows));
    }
    activePanelFingerprint = sourceFingerprint(kind);
  };
  document.body.appendChild(btn);

  // 健保雲端是 SPA；表格換卡、換頁或重新查詢時，不能讓前一位病人的面板殘留。
  let fingerprintCheckQueued = false;
  new MutationObserver(() => {
    if (!activePanelFingerprint || fingerprintCheckQueued) return;
    fingerprintCheckQueued = true;
    setTimeout(() => {
      fingerprintCheckQueued = false;
      if (activePanelFingerprint && activePanelFingerprint !== sourceFingerprint()) disposePanel();
    }, 0);
  }).observe(document.body, { childList: true, subtree: true, characterData: true });
})();
