/* view3d.js - 3D viewer for the generated plan (needs Three.js loaded first).
   Public API: window.View3D = { init, build, resize, setExplode, setOption, getOption, exportSTL, ready }
   build(plan) expects: plan.plot {w,l}, plan.margins {front,rear,left,right}, plan.buildable {x,y,w,l},
   plan.floors [{level, rooms, doors, windows}], plan.cars [{x,y}], plan.roof {tank, solar} */
(function (global) {
  'use strict';

  var S = 0.1;      // 1 ft = 0.1 scene units
  var FH = 10;      // floor-to-floor height (ft)
  var WH = 9;       // room volume / wall height (ft)
  var T = 0.5;      // wall thickness (ft)
  var RM = global.matchMedia && matchMedia('(prefers-reduced-motion:reduce)').matches;

  var ren = null, scene, cam, house, canvas, holder;
  var floors = [], plan = null;
  var az = 0.7, elev = 0.5, dist = 9, baseDist = 9, tgtY = 2, auto = true;
  var expl = 0.25, explCur = 0.25;
  var opts = { labels: true, furniture: true, openings: true, garden: true };
  var gardenGroup = null;

  var COL = { bath: 0x9aa7bd, kitchen: 0xb8c0d0, parking: 0xd5d9e2, passage: 0xd5d9e2, utility: 0xc7ccd8,
              living: 0xe6e9f0, bed: 0xe6e9f0, balcony: 0xd5d9e2, dining: 0xe6e9f0, study: 0xe6e9f0, pooja: 0xf0e6c8 };

  // ---------- small helpers ----------
  function mat(color, opacity) {
    var o = opacity === undefined ? 1 : opacity;
    return new THREE.MeshStandardMaterial({ color: color, roughness: 0.6, transparent: o < 1, opacity: o });
  }
  function bx(w, h, d, color, opacity) {
    return new THREE.Mesh(new THREE.BoxGeometry(w * S, h * S, d * S), mat(color, opacity));
  }
  function put(m, x, y, z) { m.position.set(x * S, y * S, z * S); return m; }
  function edges(m) {
    m.add(new THREE.LineSegments(new THREE.EdgesGeometry(m.geometry), new THREE.LineBasicMaterial({ color: 0x7d869b })));
    return m;
  }
  function disposeTree(o) {
    o.traverse(function (n) {
      if (n.geometry) n.geometry.dispose();
      if (n.material) {
        (Array.isArray(n.material) ? n.material : [n.material]).forEach(function (m) {
          if (m.map) m.map.dispose();
          m.dispose();
        });
      }
    });
  }
  function overlap(a0, a1, b0, b1) { return Math.min(a1, b1) - Math.max(a0, b0); }

  function roomKey(r) {
    var n = (r.name || '').toLowerCase();
    if (/dining/.test(n)) return 'dining';
    if (/study|office/.test(n)) return 'study';
    if (/pooja|puja|prayer/.test(n)) return 'pooja';
    if (/store/.test(n)) return 'utility';
    return r.type;
  }

  // ---------- init / camera ----------
  function init(canvasEl, holderEl) {
    if (ren) return true;
    if (!global.THREE) return false;
    canvas = canvasEl; holder = holderEl;
    try { ren = new THREE.WebGLRenderer({ canvas: canvas, antialias: true, alpha: true }); } catch (e) { ren = null; return false; }
    scene = new THREE.Scene();
    cam = new THREE.PerspectiveCamera(40, 1, 0.1, 200);
    scene.add(new THREE.HemisphereLight(0xffffff, 0x8892a6, 0.95));
    var sun = new THREE.DirectionalLight(0xffffff, 0.8); sun.position.set(6, 10, 5); scene.add(sun);
    house = new THREE.Group(); scene.add(house);

    var drag = false, lx = 0, ly = 0;
    canvas.addEventListener('pointerdown', function (e) { drag = true; auto = false; lx = e.clientX; ly = e.clientY; canvas.setPointerCapture(e.pointerId); canvas.style.cursor = 'grabbing'; });
    canvas.addEventListener('pointermove', function (e) {
      if (!drag) return;
      az -= (e.clientX - lx) * 0.008;
      elev = Math.min(1.4, Math.max(0.1, elev + (e.clientY - ly) * 0.006));
      lx = e.clientX; ly = e.clientY;
    });
    function end() { drag = false; canvas.style.cursor = 'grab'; }
    canvas.addEventListener('pointerup', end);
    canvas.addEventListener('pointercancel', end);
    canvas.addEventListener('wheel', function (e) {
      e.preventDefault();
      dist = Math.min(baseDist * 2.5, Math.max(baseDist * 0.4, dist * (1 + e.deltaY * 0.001)));
    }, { passive: false });
    if (global.ResizeObserver) new ResizeObserver(resize).observe(holder);
    requestAnimationFrame(frame);
    return true;
  }

  function resize() {
    if (!ren) return;
    var w = holder.clientWidth, h = holder.clientHeight;
    if (w < 2 || h < 2) return;
    ren.setPixelRatio(Math.min(global.devicePixelRatio || 1, 2));
    ren.setSize(w, h, false);
    cam.aspect = w / h; cam.updateProjectionMatrix();
  }

  // ---------- labels ----------
  function labelSprite(text, hFt) {
    var scratch = document.createElement('canvas').getContext('2d');
    scratch.font = '600 28px system-ui, sans-serif';
    var tw = Math.ceil(scratch.measureText(text).width);
    var c = document.createElement('canvas');
    c.width = tw + 40; c.height = 56;
    var x = c.getContext('2d');
    x.fillStyle = 'rgba(255,255,255,0.9)';
    var r = 14, w = c.width, h = c.height;
    x.beginPath();
    x.moveTo(r, 0); x.lineTo(w - r, 0); x.quadraticCurveTo(w, 0, w, r);
    x.lineTo(w, h - r); x.quadraticCurveTo(w, h, w - r, h);
    x.lineTo(r, h); x.quadraticCurveTo(0, h, 0, h - r);
    x.lineTo(0, r); x.quadraticCurveTo(0, 0, r, 0); x.closePath(); x.fill();
    x.font = '600 28px system-ui, sans-serif';
    x.fillStyle = '#1f2937'; x.textAlign = 'center'; x.textBaseline = 'middle';
    x.fillText(text, w / 2, h / 2 + 1);
    var tex = new THREE.CanvasTexture(c);
    var sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false }));
    sp.scale.set(hFt * S * (w / h), hFt * S, 1);
    sp.renderOrder = 10;
    return sp;
  }

  // ---------- furniture ----------
  function furniture(r, X, Z, grp) {
    var FL = 0.5, key = roomKey(r);
    function item(w, h, d, color, x, z, yoff) {
      var m = bx(w, h, d, color);
      put(m, X + x, FL + (yoff || 0) + h / 2, Z + z);
      grp.add(m);
      return m;
    }
    var w = r.w, l = r.l;
    if (key === 'bed') {
      var bw = Math.min(6, w - 2.5), bl = Math.min(6.7, l - 2);
      if (bw >= 3 && bl >= 4) {
        var zb = -l / 2 + bl / 2 + 0.5;
        item(bw, 1.4, bl, 0x8a6f58, 0, zb);
        item(bw - 0.3, 0.7, bl - 0.9, 0xf1ede6, 0, zb + 0.4, 1.4);
        item(bw / 2 - 0.3, 0.5, 1.2, 0xffffff, -bw / 4, zb - bl / 2 + 1, 2.1);
        item(bw / 2 - 0.3, 0.5, 1.2, 0xffffff, bw / 4, zb - bl / 2 + 1, 2.1);
      }
      if (w >= 10 && l >= 6) item(1.8, 6.5, Math.min(4.5, l - 3), 0xa88b6a, w / 2 - 1.1, 0);
    } else if (key === 'living') {
      item(Math.min(7, w - 2), 2.6, 2.6, 0x6b7f99, 0, l / 2 - 1.8);
      if (l >= 9) {
        item(3, 1.3, 1.8, 0x8a6f58, 0, l / 2 - 5);
        item(Math.min(5, w - 2), 2.2, 1, 0x2d3340, 0, -l / 2 + 0.9);
      }
    } else if (key === 'dining') {
      item(Math.min(5, w - 3), 2.5, Math.min(3, l - 3), 0x8a6f58, 0, 0);
      [[-1, -1], [1, -1], [-1, 1], [1, 1]].forEach(function (p) { item(1.3, 1.6, 1.3, 0xa88b6a, p[0] * 1.9, p[1] * 2.1); });
    } else if (key === 'kitchen') {
      item(Math.max(2, w - 1.5), 3, 2, 0x6b7280, 0, -l / 2 + 1.2);
      item(2, 0.1, 1.4, 0x1f2937, 0, -l / 2 + 1.2, 3);
      if (w >= 7) item(2.4, 6, 2.4, 0xe5e7eb, w / 2 - 1.5, l / 2 - 1.5);
    } else if (key === 'bath') {
      item(1.4, 1.5, 2, 0xffffff, -w / 2 + 1.2, -l / 2 + 1.3);
      item(1.6, 2.8, 1.2, 0xffffff, w / 2 - 1.3, -l / 2 + 0.9);
      if (w >= 5 && l >= 6) item(3, 0.2, 3, 0x9aa7bd, w / 2 - 2, l / 2 - 2);
    } else if (key === 'parking') {
      if (plan && plan.cars && plan.cars.length) return;   // cars come from the backend
      var dx, dz;
      if (l >= w) { dx = Math.min(6, w - 1.5); dz = Math.min(14, l - 1.5); }
      else { dx = Math.min(14, w - 1.5); dz = Math.min(6, l - 1.5); }
      if (dx >= 3 && dz >= 3) {
        item(dx, 2.2, dz, 0x4a6fa5, 0, 0, 0.5);
        if (dz >= dx) item(dx * 0.9, 1.6, dz * 0.45, 0x8fb3d9, 0, 0, 2.7);
        else item(dx * 0.45, 1.6, dz * 0.9, 0x8fb3d9, 0, 0, 2.7);
      }
    } else if (key === 'utility') {
      item(2, 3, 2, 0xe5e7eb, -w / 2 + 1.3, -l / 2 + 1.3);
    } else if (key === 'study') {
      item(Math.min(4.5, w - 2), 2.5, 2, 0x8a6f58, 0, -l / 2 + 1.3);
      item(1.5, 1.6, 1.5, 0x3b4252, 0, -l / 2 + 3.2);
    } else if (key === 'pooja') {
      item(Math.min(2.2, w - 1), 3.5, 1.6, 0xc9a24b, 0, -l / 2 + 1);
    }
  }

  // car from backend {x, y} (centre, in plot feet), parked nose-in (long side along y)
  function addCar(c, pk, cx, cz, grp) {
    var dx = 6, dz = Math.min(12, pk ? pk.l - 2 : 12);
    if (pk) dx = Math.min(6, pk.w / Math.max(1, plan.cars.length) - 1);
    if (dx < 3 || dz < 5) return;
    var body = bx(dx, 2.2, dz, 0x4a6fa5);
    put(body, c.x - cx, 0.5 + 0.5 + 1.1, cz - c.y); grp.add(body);
    var cab = bx(dx * 0.9, 1.6, dz * 0.45, 0x8fb3d9);
    put(cab, c.x - cx, 0.5 + 0.5 + 2.2 + 0.8, cz - c.y); grp.add(cab);
  }

  // ---------- doors and windows ----------
  // backend openings: {o:'v'|'h', x, y, len, main?}  (x,y = centre of the opening on the wall, plot feet)
  function placeOpening(grp, kind, d, cx, cz) {
    var len = Math.max(1.5, d.len || 3), h, yc, col, op = 1, th = T * 0.8, m;
    if (kind === 'main') { h = 7; yc = 0.5 + 3.5; col = 0x4b3621; len = Math.max(len, 3.5); }
    else if (kind === 'door') { h = 7; yc = 0.5 + 3.5; col = 0x7a5a3a; }
    else { h = 3.5; yc = 0.5 + 3 + 1.75; col = 0x8fc7ee; op = 0.85; }
    m = d.o === 'v' ? bx(th, h, len, col, op) : bx(len, h, th, col, op);
    put(m, d.x - cx, yc, cz - d.y);
    grp.add(m);
  }

  // fallback when a floor has no doors/windows from the backend: guess them from room neighbours
  function sidesOf(r, rooms, W, L, mg) {
    var tol = 0.6;
    var defs = [
      { s: 'L', ext: r.x <= mg.left + tol },
      { s: 'R', ext: r.x + r.w >= W - mg.right - tol },
      { s: 'F', ext: r.y <= mg.front + tol },
      { s: 'B', ext: r.y + r.l >= L - mg.rear - tol }
    ];
    defs.forEach(function (d) {
      d.nbs = [];
      rooms.forEach(function (q) {
        if (q === r) return;
        var ov, touch;
        if (d.s === 'L') { touch = Math.abs(q.x + q.w - r.x) < tol; ov = overlap(r.y, r.y + r.l, q.y, q.y + q.l); }
        if (d.s === 'R') { touch = Math.abs(q.x - (r.x + r.w)) < tol; ov = overlap(r.y, r.y + r.l, q.y, q.y + q.l); }
        if (d.s === 'F') { touch = Math.abs(q.y + q.l - r.y) < tol; ov = overlap(r.x, r.x + r.w, q.x, q.x + q.w); }
        if (d.s === 'B') { touch = Math.abs(q.y - (r.y + r.l)) < tol; ov = overlap(r.x, r.x + r.w, q.x, q.x + q.w); }
        if (touch && ov >= 2) {
          var lo, hi;
          if (d.s === 'L' || d.s === 'R') { lo = Math.max(r.y, q.y); hi = Math.min(r.y + r.l, q.y + q.l); }
          else { lo = Math.max(r.x, q.x); hi = Math.min(r.x + r.w, q.x + q.w); }
          d.nbs.push({ type: roomKey(q), mid: (lo + hi) / 2 });
        }
      });
    });
    return defs;
  }

  function guessOpening(grp, kind, side, r, along, cx, cz) {
    var vertical = side === 'L' || side === 'R';
    var d = { o: vertical ? 'v' : 'h', len: kind === 'window' ? 4 : 3 };
    var len = vertical ? r.l : r.w;
    if (kind === 'window') d.len = Math.min(4, Math.max(1.5, len - 2));
    if (vertical) { d.x = side === 'L' ? r.x : r.x + r.w; d.y = along === undefined ? r.y + r.l / 2 : along; }
    else { d.x = along === undefined ? r.x + r.w / 2 : along; d.y = side === 'F' ? r.y : r.y + r.l; }
    placeOpening(grp, kind, d, cx, cz);
  }

  function guessOpenings(fl, W, L, mg, cx, cz, grp, mainRoom) {
    var NO_DOOR = { living: 1, passage: 1, stair: 1, parking: 1 };
    var NO_WIN = { passage: 1, stair: 1, parking: 1 };
    fl.rooms.forEach(function (r) {
      if (r.type === 'stair') return;
      var sides = sidesOf(r, fl.rooms, W, L, mg);
      if (!NO_WIN[roomKey(r)]) {
        var n = 0;
        sides.forEach(function (d) { if (d.ext && n < 2) { guessOpening(grp, 'window', d.s, r, undefined, cx, cz); n++; } });
      }
      if (r === mainRoom) guessOpening(grp, 'main', 'F', r, undefined, cx, cz);
      if (!NO_DOOR[roomKey(r)]) {
        var pick = null, pickMid;
        sides.forEach(function (d) {
          if (pick) return;
          d.nbs.forEach(function (q) { if (!pick && (q.type === 'living' || q.type === 'passage')) { pick = d; pickMid = q.mid; } });
        });
        if (!pick) sides.forEach(function (d) { if (!pick && d.nbs.length) { pick = d; pickMid = d.nbs[0].mid; } });
        if (!pick) pick = sides[2];
        guessOpening(grp, 'door', pick.s, r, pickMid, cx, cz);
      }
    });
  }

  // ---------- garden ----------
  function buildGarden(W, L, mg) {
    var g = new THREE.Group();
    g.userData.skipSTL = true;
    var lawn = bx(W, 0.3, L, 0x9ccf94); put(lawn, 0, -0.17, 0); g.add(lawn);
    if (mg.front > 0.5) {
      var path = bx(4, 0.1, mg.front, 0xd8cfbc); put(path, 0, 0.0, L / 2 - mg.front / 2); g.add(path);
    }
    var wallH = 3.5, wallT = 0.6, wallC = 0xc9ccd4;
    var back = bx(W, wallH, wallT, wallC); put(back, 0, wallH / 2, -L / 2 + wallT / 2); g.add(back);
    var left = bx(wallT, wallH, L, wallC); put(left, -W / 2 + wallT / 2, wallH / 2, 0); g.add(left);
    var right = bx(wallT, wallH, L, wallC); put(right, W / 2 - wallT / 2, wallH / 2, 0); g.add(right);
    var gap = Math.min(8, W * 0.3), segW = (W - gap) / 2;
    var f1 = bx(segW, wallH, wallT, wallC); put(f1, -(gap / 2 + segW / 2), wallH / 2, L / 2 - wallT / 2); g.add(f1);
    var f2 = bx(segW, wallH, wallT, wallC); put(f2, (gap / 2 + segW / 2), wallH / 2, L / 2 - wallT / 2); g.add(f2);

    var R = Math.min(2.6, Math.min(mg.left, mg.right, mg.rear) * 0.45);
    if (R >= 0.8) {
      var xl = -(W / 2 - mg.left / 2), xr = W / 2 - mg.right / 2, zb = -(L / 2 - mg.rear / 2);
      [[xl, zb], [xr, zb], [xl, 0], [xr, 0], [xl, L / 4], [xr, L / 4]].forEach(function (p) {
        var trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.35 * S, 0.45 * S, 5 * S, 8), mat(0x7a5a3a));
        put(trunk, p[0], 2.5, p[1]); g.add(trunk);
        var top = new THREE.Mesh(new THREE.SphereGeometry(R * S, 14, 10), mat(0x5aa05a));
        put(top, p[0], 5 + R * 0.8, p[1]); g.add(top);
      });
    }
    g.visible = opts.garden;
    return g;
  }

  // ---------- build ----------
  function build(p) {
    if (!ren) return false;
    plan = p;
    while (house.children.length) { var c = house.children[0]; house.remove(c); disposeTree(c); }
    floors = [];

    var W = p.plot.w, L = p.plot.l, cx = W / 2, cz = L / 2;
    var mg = p.margins || { front: 3, rear: 3, left: 3, right: 3 };
    var B = p.buildable || { x: mg.left, y: mg.front, w: W - mg.left - mg.right, l: L - mg.front - mg.rear };
    gardenGroup = buildGarden(W, L, mg);
    house.add(gardenGroup);

    var top = p.floors.length - 1;
    var ground = p.floors[0].rooms;
    var parkingRoom = null;
    ground.forEach(function (r) { if (!parkingRoom && r.type === 'parking') parkingRoom = r; });

    // fallback main-entrance room (only used when the backend sends no doors)
    var mainRoom = null;
    ['living', 'passage'].forEach(function (t) {
      if (mainRoom) return;
      ground.forEach(function (r) { if (!mainRoom && r.type === t && r.y <= mg.front + 0.6) mainRoom = r; });
    });

    p.floors.forEach(function (fl) {
      var g = new THREE.Group();
      var slab = bx(B.w, 0.5, B.l, 0xdfe3ea);
      put(slab, B.x + B.w / 2 - cx, 0.25, cz - (B.y + B.l / 2)); g.add(edges(slab));

      var furn = new THREE.Group(), ops = new THREE.Group(), labs = new THREE.Group(), walls = new THREE.Group();
      walls.userData.stlOnly = true; walls.visible = false;

      fl.rooms.forEach(function (r) {
        var X = r.x + r.w / 2 - cx, Z = cz - (r.y + r.l / 2);
        if (r.type === 'stair') {
          for (var i = 0; i < 6; i++) {
            var h = 9 * (i + 1) / 6, d = r.l / 6;
            var st = bx(r.w * 0.96, h, d * 0.96, 0x8892a6);
            put(st, X, 0.5 + h / 2, cz - (r.y + d * (i + 0.5)));
            g.add(st);
          }
          return;
        }
        var op = (r.type === 'parking' || r.type === 'passage') ? 0.35 : 0.55;
        var vol = bx(r.w * 0.98, WH, r.l * 0.98, COL[r.type] || 0xe6e9f0, op);
        put(vol, X, 0.5 + WH / 2, Z);
        vol.userData.skipSTL = true;
        g.add(edges(vol));

        furniture(r, X, Z, furn);

        var sp = labelSprite(r.name || r.type, (r.w < 6 || r.l < 4) ? 1.2 : 1.7);
        put(sp, X, 0.5 + WH + 1.2, Z);
        labs.add(sp);

        if (r.type !== 'parking' && r.type !== 'passage') {
          var wy = 0.5 + WH / 2;
          var a = bx(r.w, WH, T, 0xe6e9f0); put(a, X, wy, cz - r.y); walls.add(a);
          var b = bx(r.w, WH, T, 0xe6e9f0); put(b, X, wy, cz - (r.y + r.l)); walls.add(b);
          var c1 = bx(T, WH, r.l, 0xe6e9f0); put(c1, r.x - cx, wy, Z); walls.add(c1);
          var c2 = bx(T, WH, r.l, 0xe6e9f0); put(c2, r.x + r.w - cx, wy, Z); walls.add(c2);
        }
      });

      // doors and windows: use the backend's exact positions when present
      if ((fl.doors && fl.doors.length) || (fl.windows && fl.windows.length)) {
        (fl.doors || []).forEach(function (d) { placeOpening(ops, d.main ? 'main' : 'door', d, cx, cz); });
        (fl.windows || []).forEach(function (d) { placeOpening(ops, 'window', d, cx, cz); });
      } else {
        guessOpenings(fl, W, L, mg, cx, cz, ops, fl.level === 0 ? mainRoom : null);
      }

      // cars on the ground floor
      if (fl.level === 0 && p.cars && p.cars.length) {
        p.cars.forEach(function (car) { addCar(car, parkingRoom, cx, cz, furn); });
      }

      if (fl.level === top) {
        var roof = bx(B.w + 1, 0.5, B.l + 1, 0xdfe3ea);
        put(roof, B.x + B.w / 2 - cx, 9.75, cz - (B.y + B.l / 2)); g.add(edges(roof));
        var rf = p.roof || {};
        if (rf.tank) {
          var tr = rf.tank.r || 2;
          var tank = new THREE.Mesh(new THREE.CylinderGeometry(tr * S, tr * S, 3 * S, 18), mat(0x2f3b52));
          put(tank, rf.tank.x - cx, 10 + 1.5, cz - rf.tank.y); g.add(tank);
        }
        if (rf.solar) {
          var sol = bx(rf.solar.w, 0.4, rf.solar.l, 0x1f3a6b);
          put(sol, rf.solar.x + rf.solar.w / 2 - cx, 10.2, cz - (rf.solar.y + rf.solar.l / 2)); g.add(edges(sol));
        }
      }

      furn.visible = opts.furniture; ops.visible = opts.openings; labs.visible = opts.labels;
      g.add(furn); g.add(ops); g.add(labs); g.add(walls);
      g.visible = false;
      house.add(g);
      floors.push({ g: g, level: fl.level, start: performance.now() + fl.level * 350, furn: furn, ops: ops, labs: labs });
    });

    baseDist = (Math.max(W, L) * S + p.floors.length * FH * S * 0.5) * 1.7;
    dist = baseDist; auto = true;
    resize();
    return true;
  }

  // ---------- render loop ----------
  function frame(now) {
    if (floors.length) {
      explCur += (expl - explCur) * 0.1;
      floors.forEach(function (o) {
        var t = Math.min(1, Math.max(0, (now - o.start) / 600));
        var e = 1 - Math.pow(1 - t, 3);
        o.g.visible = t > 0;
        o.g.scale.y = Math.max(e, 0.001);
        o.g.position.y = o.level * (FH + explCur * 8) * S;
      });
      if (auto && !RM) az += 0.0025;
      var n = floors.length;
      tgtY = (n * FH + (n - 1) * explCur * 8) * S * 0.5;
      cam.position.set(Math.sin(az) * Math.cos(elev) * dist, tgtY + Math.sin(elev) * dist, Math.cos(az) * Math.cos(elev) * dist);
      cam.lookAt(0, tgtY, 0);
      ren.render(scene, cam);
    }
    requestAnimationFrame(frame);
  }

  // ---------- options ----------
  function setOption(name, on) {
    if (!(name in opts)) return;
    opts[name] = !!on;
    if (name === 'garden' && gardenGroup) gardenGroup.visible = opts.garden;
    floors.forEach(function (o) {
      if (name === 'labels') o.labs.visible = opts.labels;
      if (name === 'furniture') o.furn.visible = opts.furniture;
      if (name === 'openings') o.ops.visible = opts.openings;
    });
  }
  function getOption(name) { return opts[name]; }
  function setExplode(v) { expl = Math.min(1, Math.max(0, v)); }

  // ---------- STL export (binary, millimetres, Z-up) ----------
  function included(o) {
    for (var p = o; p && p !== house; p = p.parent) {
      if (p.userData && p.userData.skipSTL) return false;
      if (p.visible === false && !(p.userData && p.userData.stlOnly)) return false;
    }
    return true;
  }

  function exportSTL(filename) {
    if (!floors.length) return { ok: false, error: 'Generate a design first.' };
    // freeze the pose: no explode, full height
    floors.forEach(function (o) { o.g.visible = true; o.g.scale.y = 1; o.g.position.y = o.level * FH * S; });
    house.updateMatrixWorld(true);

    var K = 3048;             // scene unit (10 ft) -> mm
    var tris = [], a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
    var e1 = new THREE.Vector3(), e2 = new THREE.Vector3(), nrm = new THREE.Vector3();
    function conv(v) { return [v.x * K, -v.z * K, v.y * K]; }   // Y-up -> Z-up

    house.traverse(function (o) {
      if (!o.isMesh || !included(o)) return;
      var geo = o.geometry, pos = geo.attributes.position, idx = geo.index;
      var count = idx ? idx.count : pos.count;
      for (var i = 0; i < count; i += 3) {
        var i0 = idx ? idx.getX(i) : i, i1 = idx ? idx.getX(i + 1) : i + 1, i2 = idx ? idx.getX(i + 2) : i + 2;
        a.fromBufferAttribute(pos, i0).applyMatrix4(o.matrixWorld);
        b.fromBufferAttribute(pos, i1).applyMatrix4(o.matrixWorld);
        c.fromBufferAttribute(pos, i2).applyMatrix4(o.matrixWorld);
        tris.push([conv(a), conv(b), conv(c)]);
      }
    });
    if (!tris.length) return { ok: false, error: 'Nothing to export.' };

    var buf = new ArrayBuffer(84 + tris.length * 50), dv = new DataView(buf);
    var hdr = 'View3D house model (mm)';
    for (var h = 0; h < hdr.length; h++) dv.setUint8(h, hdr.charCodeAt(h));
    dv.setUint32(80, tris.length, true);
    var off = 84;
    tris.forEach(function (t) {
      e1.set(t[1][0] - t[0][0], t[1][1] - t[0][1], t[1][2] - t[0][2]);
      e2.set(t[2][0] - t[0][0], t[2][1] - t[0][1], t[2][2] - t[0][2]);
      nrm.crossVectors(e1, e2).normalize();
      var vals = [nrm.x || 0, nrm.y || 0, nrm.z || 0].concat(t[0], t[1], t[2]);
      vals.forEach(function (v) { dv.setFloat32(off, v, true); off += 4; });
      dv.setUint16(off, 0, true); off += 2;
    });

    var url = URL.createObjectURL(new Blob([buf], { type: 'model/stl' }));
    var link = document.createElement('a');
    link.href = url; link.download = filename || 'house.stl';
    document.body.appendChild(link); link.click(); link.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
    return { ok: true, triangles: tris.length };
  }

  global.View3D = {
    init: init, build: build, resize: resize, setExplode: setExplode,
    setOption: setOption, getOption: getOption, exportSTL: exportSTL,
    ready: function () { return !!ren; }
  };
})(window);
