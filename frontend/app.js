(function () {
  if (!requireLogin()) return;

  var RM = matchMedia('(prefers-reduced-motion:reduce)').matches;
  var $ = function (id) { return document.getElementById(id); };
  function pick() {
    for (var i = 0; i < arguments.length; i++) { var n = document.getElementById(arguments[i]); if (n) return n; }
    return null;
  }
  var plan = null, lastPrompt = '';

  // ---------- top bar ----------
  var who = $('who');
  if (who) {
    who.textContent = (getUser().name || 'Account') + ' / ';
    var out = document.createElement('a');
    out.href = '#'; out.textContent = 'Log out';
    out.onclick = function (e) { e.preventDefault(); logout(); };
    who.appendChild(out);
  }

  // ---------- small helpers ----------
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, RM ? 0 : ms); }); }
  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined) n.textContent = text;
    return n;
  }
  function row(label, value, cls) {
    var d = el('div', 'row2');
    d.appendChild(el('span', '', label));
    d.appendChild(el('strong', cls || '', value));
    return d;
  }
  function setStep(n) {
    document.querySelectorAll('#steps li').forEach(function (li) {
      var k = +li.dataset.step;
      li.className = k < n ? 'done' : (k === n ? 'active' : '');
    });
  }
  function f1(v) { return Math.round(v * 10) / 10; }
  function inr(n) { return '\u20B9 ' + Math.round(+n || 0).toLocaleString('en-IN'); }
  function pretty(k) { return String(k).replace(/_/g, ' ').replace(/^./, function (c) { return c.toUpperCase(); }); }
  function slug(t) { return (t || 'house').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 30) || 'house'; }

  // ---------- backend reply -> one flat "plan" object ----------
  // planner.py returns { parsed, plot, margins, checks, metrics, cost, autofix, variants:[{floors,cars,roof,buildable,vastu}] }
  function normalize(d, idx) {
    if (!d) throw new Error('Empty reply from the server.');
    if (!d.variants && d.plan && d.plan.variants) d = d.plan;
    var vs = d.variants || [];
    var i = Math.min(Math.max(idx || 0, 0), Math.max(vs.length - 1, 0));
    var v = vs[i];
    if (!v && d.floors) { v = d; i = 0; }   // older flat shape
    if (!v || !v.floors || !v.floors.length) {
      throw new Error('Server reply has no floors (keys: ' + Object.keys(d).join(', ') + ').');
    }
    var P = d.parsed || {};
    return {
      raw: d, option: i, variants: vs, parsed: P,
      plot: d.plot || { w: P.plot_w, l: P.plot_l },
      margins: d.margins || { front: 3, rear: 3, left: 3, right: 3 },
      buildable: v.buildable || null,
      floors: v.floors, cars: v.cars || [], roof: v.roof || {},
      vastu: v.vastu || null,
      checks: d.checks || [], metrics: d.metrics || {}, cost: d.cost || null,
      autofix: d.autofix || [], initial: d.initial || {}
    };
  }

  // ---------- view toggle (2D / 3D / Both) ----------
  var stage = $('stage');
  document.querySelectorAll('.toolbar .tab[data-view]').forEach(function (b) {
    b.onclick = function () {
      stage.dataset.view = b.dataset.view;
      document.querySelectorAll('.toolbar .tab[data-view]').forEach(function (x) { x.setAttribute('aria-pressed', x === b ? 'true' : 'false'); });
      View3D.resize();
    };
  });

  // ---------- layout option tabs (Option 1 / 2 / 3) ----------
  function drawVariantTabs() {
    var tb = document.querySelector('.toolbar');
    if (!tb) return;
    var box = $('variant-tabs');
    if (!box) {
      box = el('div', 'grp'); box.id = 'variant-tabs';
      tb.insertBefore(box, tb.querySelector('.grp.right') || null);
    }
    box.textContent = '';
    if (!plan || !plan.variants || plan.variants.length < 2) return;
    box.appendChild(el('span', 'mono lbl', 'Layout'));
    plan.variants.forEach(function (v, i) {
      var b = el('button', 'tab', v.label || ('Option ' + (i + 1)));
      b.type = 'button';
      b.setAttribute('aria-pressed', i === plan.option ? 'true' : 'false');
      b.onclick = function () { switchOption(i); };
      box.appendChild(b);
    });
  }

  function switchOption(i) {
    if (!plan) return;
    try {
      plan = normalize(plan.raw, i);
      draw2D(0); build3D(); showVastu(); drawVariantTabs();
    } catch (e) { msg.textContent = 'Draw error: ' + (e && e.message ? e.message : e); }
  }

  // ---------- 2D plan (SVG) ----------
  var NS = 'http://www.w3.org/2000/svg';
  function s(tag, attrs, text) {
    var n = document.createElementNS(NS, tag);
    for (var k in attrs) n.setAttribute(k, attrs[k]);
    if (text !== undefined) n.textContent = text;
    return n;
  }

  function draw2D(level) {
    var W = plan.plot.w, L = plan.plot.l, pad = 5;
    var box = $('plan2d');
    box.textContent = '';
    var fl = plan.floors[level];
    var svg = s('svg', { viewBox: (-pad) + ' ' + (-pad) + ' ' + (W + pad * 2) + ' ' + (L + pad * 2 + 2), preserveAspectRatio: 'xMidYMid meet', role: 'img', 'aria-label': 'Floor plan, ' + fl.label });
    svg.appendChild(s('rect', { class: 'plot', x: 0, y: 0, width: W, height: L }));
    if (plan.buildable) {
      var bd = plan.buildable;
      svg.appendChild(s('rect', { x: bd.x, y: L - (bd.y + bd.l), width: bd.w, height: bd.l, fill: 'none', stroke: '#9aa3b5', 'stroke-width': 0.25, 'stroke-dasharray': '1 1' }));
    }

    var fs = Math.max(1.1, Math.max(W, L) / 32);
    fl.rooms.forEach(function (r) {
      var y = L - (r.y + r.l); // front of the plot (y=0) is drawn at the bottom
      svg.appendChild(s('rect', { class: 'room ' + r.type, x: r.x, y: y, width: r.w, height: r.l }));
      if (r.type === 'stair') {
        for (var i = 1; i < 6; i++) svg.appendChild(s('line', { class: 'steps-line', x1: r.x, x2: r.x + r.w, y1: y + r.l * i / 6, y2: y + r.l * i / 6 }));
      }
      var small = r.w < 6 || r.l < 4;
      var f = small ? fs * 0.75 : fs;
      var cx = r.x + r.w / 2, cy = y + r.l / 2;
      var showDim = r.l >= 3.5 && r.w >= 5 && r.type !== 'stair';
      svg.appendChild(s('text', { class: 'rlabel', x: cx, y: cy + (showDim ? -0.1 : f * 0.35), 'font-size': f }, r.name));
      if (showDim) svg.appendChild(s('text', { class: 'rdim', x: cx, y: cy + f * 1.2, 'font-size': f * 0.8 }, f1(r.w) + ' x ' + f1(r.l) + ' ft'));
    });

    // windows, then doors (o:'v' = wall runs along y, o:'h' = wall runs along x)
    function seg(d, color, width) {
      var h = d.len / 2, cy = L - d.y;
      var a = d.o === 'v' ? { x1: d.x, x2: d.x, y1: cy - h, y2: cy + h } : { x1: d.x - h, x2: d.x + h, y1: cy, y2: cy };
      a.stroke = color; a['stroke-width'] = width; a['stroke-linecap'] = 'butt';
      svg.appendChild(s('line', a));
    }
    (fl.windows || []).forEach(function (d) { seg(d, '#4aa3df', 0.55); });
    (fl.doors || []).forEach(function (d) { seg(d, d.main ? '#7a2e0e' : '#b8793a', d.main ? 0.8 : 0.6); });

    // cars (ground floor)
    if (fl.level === 0) {
      (plan.cars || []).forEach(function (c) {
        var cw = 5.5, ch = 11;
        svg.appendChild(s('rect', { x: c.x - cw / 2, y: L - c.y - ch / 2, width: cw, height: ch, rx: 1, fill: 'rgba(74,111,165,.55)', stroke: '#4a6fa5', 'stroke-width': 0.25 }));
      });
    }

    svg.appendChild(s('text', { class: 'road', x: W / 2, y: L + 3.6, 'font-size': fs }, 'ROAD SIDE / ' + String(plan.parsed.facing || '').toUpperCase() + '-FACING'));
    box.appendChild(svg);

    var tabs = $('floor-tabs');
    tabs.textContent = '';
    plan.floors.forEach(function (f, i) {
      var b = el('button', 'tab', f.level === 0 ? 'G' : String(f.level));
      b.type = 'button';
      b.title = f.label;
      b.setAttribute('aria-label', f.label);
      b.setAttribute('aria-pressed', i === level ? 'true' : 'false');
      b.onclick = function () { draw2D(i); };
      tabs.appendChild(b);
    });
  }

  // ---------- 3D (see view3d.js) ----------
  function build3D() {
    var ok = View3D.ready() || View3D.init($('gl3d'), $('view3d'));
    if (!ok) { $('empty3d').textContent = '3D is not supported on this device.'; return; }
    $('empty3d').style.display = 'none';
    View3D.build(plan);
  }

  function bindOption(opt, node) {
    var isCheck = node.type === 'checkbox';
    if (isCheck) { node.checked = View3D.getOption(opt); node.onchange = function () { View3D.setOption(opt, node.checked); }; }
    else {
      node.setAttribute('aria-pressed', View3D.getOption(opt) ? 'true' : 'false');
      node.onclick = function () {
        var on = node.getAttribute('aria-pressed') !== 'true';
        node.setAttribute('aria-pressed', on ? 'true' : 'false');
        View3D.setOption(opt, on);
      };
    }
  }

  function setupControls() {
    var holder = $('view3d');
    var bar = null;
    function ensureBar() {
      if (bar) return bar;
      if (getComputedStyle(holder).position === 'static') holder.style.position = 'relative';
      bar = el('div', 'v3-controls');
      bar.style.cssText = 'position:absolute;left:8px;bottom:8px;display:flex;flex-wrap:wrap;gap:6px;align-items:center;z-index:2;';
      holder.appendChild(bar);
      return bar;
    }
    var defs = [['labels', 'Labels'], ['furniture', 'Furniture'], ['openings', 'Doors & windows'], ['garden', 'Garden']];
    defs.forEach(function (d) {
      var node = pick('tg-' + d[0], 'toggle-' + d[0], 'opt-' + d[0]);
      if (!node) {
        var lab = el('label');
        lab.style.cssText = 'font-size:12px;padding:3px 8px;border-radius:999px;background:rgba(255,255,255,.85);color:#1f2937;display:inline-flex;gap:4px;align-items:center;cursor:pointer;';
        node = document.createElement('input'); node.type = 'checkbox';
        lab.appendChild(node); lab.appendChild(document.createTextNode(d[1]));
        ensureBar().appendChild(lab);
      }
      bindOption(d[0], node);
    });

    var stl = pick('stl', 'export-stl', 'btn-stl');
    if (!stl) {
      stl = el('button', '', 'Download STL');
      stl.type = 'button';
      stl.style.cssText = 'font-size:12px;padding:3px 10px;border-radius:999px;border:0;background:#1f2937;color:#fff;cursor:pointer;';
      ensureBar().appendChild(stl);
    }
    stl.onclick = function () {
      if (!plan) { msg.textContent = 'Generate a design first.'; return; }
      var r = View3D.exportSTL('house-' + slug(lastPrompt) + '.stl');
      msg.textContent = r.ok ? 'STL downloaded (units: mm, Z up).' : r.error;
    };

    var ex = $('explode');
    if (ex) ex.addEventListener('input', function () { View3D.setExplode(this.value / 100); });
  }

  // ---------- side panel info ----------
  function showParsed() {
    var p = plan.parsed, box_ = $('parsed'), as = p.assumed || [];
    box_.textContent = '';
    function add(label, value, key) { box_.appendChild(row(label, value + (as.indexOf(key) >= 0 ? ' (assumed)' : ''), as.indexOf(key) >= 0 ? 'assumed' : '')); }
    add('Plot', f1(p.plot_w) + ' x ' + f1(p.plot_l) + ' ft', 'plot size');
    add('Floors', String(p.floors), 'floors');
    add('Bedrooms', p.bhk + ' BHK', 'bedrooms');
    add('Facing', p.facing, 'facing');
    box_.appendChild(row('Parking', p.parking ? 'Ground floor' : 'No'));
    if (p.pooja) box_.appendChild(row('Pooja room', 'Yes'));
    if (p.study) box_.appendChild(row('Study', 'Yes'));
    if (p.solar) box_.appendChild(row('Solar', 'Yes'));
  }

  function showChecks() {
    var box_ = $('checks'), m = plan.metrics || {};
    box_.textContent = '';
    plan.checks.forEach(function (c) {
      var r = row(c.name, String(c.status || '').toUpperCase(), c.status);
      var tip = [c.detail, c.status === 'fail' ? c.tip : ''].filter(Boolean).join(' ');
      if (tip) r.title = tip;
      box_.appendChild(r);
    });
    if (m.built_up_sqft !== undefined) box_.appendChild(row('Built-up area', Math.round(m.built_up_sqft) + ' sq ft'));
    if (m.coverage_pct !== undefined) box_.appendChild(row('Ground coverage', m.coverage_pct + '%'));
    if (m.far !== undefined) box_.appendChild(row('FAR', String(m.far)));
    if (m.height_ft !== undefined) box_.appendChild(row('Height', m.height_ft + ' ft'));
    plan.autofix.forEach(function (t) { box_.appendChild(el('p', 'note', 'Auto-fixed: ' + t)); });
    var failed = plan.checks.filter(function (c) { return c.status === 'fail' && c.tip; });
    failed.forEach(function (c) { box_.appendChild(el('p', 'note', c.name + ': ' + c.tip)); });
  }

  // Vastu: { score, notes:[{room, zone, ideal, ok}], tips:[] }
  function showVastu() {
    var box_ = pick('vastu', 'vastu-box', 'vastu-card');
    if (!box_) return;
    box_.textContent = '';
    var v = plan.vastu;
    if (!v) { box_.appendChild(el('p', 'note', 'No Vastu result came back for this plan.')); return; }
    box_.appendChild(row('Score', v.score + ' / 100'));
    (v.notes || []).forEach(function (n) {
      var r = row(n.room + ' (' + n.zone + ')', n.ok ? 'OK' : 'REVIEW', n.ok ? 'pass' : 'fail');
      r.title = 'Traditional ideal: ' + n.ideal;
      box_.appendChild(r);
    });
    (v.tips || []).forEach(function (t) { box_.appendChild(el('p', 'note', t)); });
    box_.appendChild(el('p', 'note', 'Vastu results are a guide, not a substitute for a Vastu consultant.'));
  }

  // Cost: { built_up_sqft, rates:{grade: rate_per_sqft}, note, budget }
  function showCost() {
    var box_ = pick('cost', 'cost-box', 'cost-card');
    if (!box_) return;
    box_.textContent = '';
    var c = plan.cost;
    if (!c) { box_.appendChild(el('p', 'note', 'No cost estimate came back for this plan.')); return; }
    var sqft = c.built_up_sqft || (plan.metrics && plan.metrics.built_up_sqft) || 0;
    box_.appendChild(row('Built-up area', Math.round(sqft) + ' sq ft'));
    var rates = c.rates;
    if (typeof rates === 'number') {
      box_.appendChild(row('Estimate', inr(rates * sqft)));
    } else if (rates && typeof rates === 'object') {
      Object.keys(rates).forEach(function (k) {
        var v = rates[k];
        if (typeof v === 'number') box_.appendChild(row(pretty(k) + ' (' + inr(v) + '/sq ft)', inr(v * sqft)));
        else if (Array.isArray(v) && v.length === 2) box_.appendChild(row(pretty(k), inr(v[0] * sqft) + ' - ' + inr(v[1] * sqft)));
      });
    }
    if (c.budget) box_.appendChild(row('Your budget', inr(c.budget)));
    if (c.note) box_.appendChild(el('p', 'note', c.note));
  }

  // ---------- saved designs ----------
  var savedBox = pick('saved', 'saved-list', 'projects');

  async function refreshSaved() {
    if (!savedBox || typeof listProjects !== 'function') return;
    var r;
    try { r = await listProjects(); } catch (e) { return; }
    savedBox.textContent = '';
    if (!r || !r.ok) { savedBox.appendChild(el('p', 'note', (r && r.error) || 'Could not load saved designs.')); return; }
    var list = Array.isArray(r.data) ? r.data : ((r.data && (r.data.projects || r.data.items)) || []);
    if (!list.length) { savedBox.appendChild(el('p', 'note', 'No saved designs yet.')); return; }
    list.forEach(function (p) {
      var d = el('div', 'proj');
      var open = el('button', 'load', p.title || (p.prompt || 'Design').slice(0, 40));
      open.type = 'button';
      open.title = p.prompt || '';
      open.onclick = function () { prompt_.value = p.prompt || ''; runGenerate(); };
      var del = el('button', 'del', 'Delete');
      del.type = 'button';
      del.setAttribute('aria-label', 'Delete ' + (p.title || 'design'));
      del.onclick = async function () {
        if (!confirm('Delete this saved design?')) return;
        del.disabled = true;
        var dr = await deleteProject(p.id);
        if (!dr.ok) { msg.textContent = dr.error; del.disabled = false; return; }
        refreshSaved();
      };
      d.appendChild(open); d.appendChild(del);
      savedBox.appendChild(d);
    });
  }

  // ---------- generate flow, step by step ----------
  var btn = $('gen'), msg = $('msg'), prompt_ = $('prompt');
  var saveBtn = pick('save', 'save-btn', 'btn-save');
  if (!saveBtn && typeof saveProject === 'function') {
    saveBtn = el('button', 'chip', 'Save design');
    saveBtn.type = 'button';
    btn.parentNode.insertBefore(saveBtn, btn.nextSibling);
  }
  if (saveBtn) {
    saveBtn.disabled = true;
    saveBtn.onclick = async function () {
      if (!plan) return;
      saveBtn.disabled = true;
      var title = lastPrompt.length > 40 ? lastPrompt.slice(0, 40) + '...' : lastPrompt;
      var r = await saveProject(lastPrompt, title);
      msg.textContent = r.ok ? 'Design saved.' : r.error;
      saveBtn.disabled = false;
      if (r.ok) refreshSaved();
    };
  }

  document.querySelectorAll('#examples .chip').forEach(function (c) { c.onclick = function () { prompt_.value = c.textContent; prompt_.focus(); }; });
  prompt_.addEventListener('keydown', function (e) { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) btn.click(); });

  async function runGenerate() {
    var text = prompt_.value.trim();
    msg.textContent = '';
    if (!text) { msg.textContent = 'Please describe your house first.'; return; }
    btn.disabled = true; btn.textContent = 'Working';
    if (saveBtn) saveBtn.disabled = true;
    $('parsed').textContent = ''; $('checks').textContent = '';
    var vb = pick('vastu', 'vastu-box', 'vastu-card'), cb = pick('cost', 'cost-box', 'cost-card');
    if (vb) vb.textContent = '';
    if (cb) cb.textContent = '';
    setStep(1);

    try {
      var r = await generatePlan(text);
      if (!r.ok) { msg.textContent = r.error; setStep(0); btn.disabled = false; btn.textContent = 'Generate'; return; }
      plan = normalize(r.data, 0);
      lastPrompt = text;

      showParsed(); drawVariantTabs(); await sleep(600);
      setStep(2); draw2D(0); await sleep(900);
      setStep(3); build3D(); await sleep(plan.floors.length * 350 + 800);
      setStep(4); showChecks(); showVastu(); showCost(); await sleep(500);
      setStep(5);
      if (saveBtn) saveBtn.disabled = false;
    } catch (e) {
      msg.textContent = 'Draw error: ' + (e && e.message ? e.message : e);
      if (window.console) console.error(e);
    }
    btn.disabled = false; btn.textContent = 'Generate again';
  }

  btn.onclick = runGenerate;

  View3D.init($('gl3d'), $('view3d'));
  setupControls();
  refreshSaved();
})();
