/* PoseMatch: compares live hands with RECORDED poses (dev tool, used by gesture-demo.html's
   Emotions tab for now; not used by the learner app yet).

   Input on both sides is the `features` object made by HandFeatures.compute() (gesture-detection.js),
   so a recorded pose and a live frame are described by exactly the same numbers.

   A pose is compared in four parts, each turned into a 0..100 similarity:
     shape       mean difference of the 15 finger-joint bend angles (degrees)
     orientation palm-normal angle + in-plane roll (degrees)
     layout      where hand B is relative to hand A, in hand sizes (two-hand poses only)
     position    where the hands sit in the picture, as a fraction of the frame
   Hands are paired by best fit (never by tracker id or the model's Left/Right label, both unreliable:
   see HANDOFF.md). Overall = weighted sum. Scales and weights below are first guesses, to be tuned
   on real recordings. */
(function (root) {
  'use strict';
  const FINGERS = ['thumb', 'index', 'middle', 'ring', 'pinky'];
  const SCALE = { shape: 40, orient: 80, layout: 2.0, position: 0.4 };   // distance at which similarity hits 0
  const WEIGHT_2 = { shape: 0.45, orient: 0.30, layout: 0.15, position: 0.10 };
  const WEIGHT_1 = { shape: 0.55, orient: 0.35, layout: 0, position: 0.10 };

  const sim = (d, max) => Math.max(0, 1 - d / max);
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const len = (a) => Math.sqrt(dot(a, a)) || 1e-9;
  const angDeg = (a, b) => Math.acos(Math.max(-1, Math.min(1, dot(a, b) / (len(a) * len(b))))) * 180 / Math.PI;
  const rollDiff = (a, b) => { let d = Math.abs(a - b) % 360; return d > 180 ? 360 - d : d; };

  /** Distance parts between two single hands (features objects). */
  function handParts(T, L) {
    let s = 0, n = 0;
    FINGERS.forEach((f) => {
      const a = T.fingers[f].bendDeg, b = L.fingers[f].bendDeg;
      for (let i = 0; i < 3; i++) { s += Math.abs(a[i] - b[i]); n++; }
    });
    const shape = s / n;
    const normal = angDeg(T.palmNormalCamera, L.palmNormalCamera);
    const roll = rollDiff(T.rollDeg, L.rollDeg);
    return { shape, orient: (normal + roll) / 2, normal, roll };
  }

  /** hands = [{features, vw, vh}] (1 or 2, live hands only). Returns the part distances for the best pairing. */
  function comparePose(tHands, lHands, tVideo, lVideo) {
    const nT = tHands.length;
    if (lHands.length < nT) return null;                       // not enough live hands
    if (nT === 1 && lHands.length > 1) {                       // one-hand pose: use whichever live hand fits best, ignore the other
      let top = null;
      lHands.forEach((h) => { const r = comparePose(tHands, [h], tVideo, lVideo); if (r && (!top || r.overall > top.overall)) top = r; });
      return top;
    }
    const L = lHands.slice(0, nT);
    const pairs = nT === 1 ? [[0]] : [[0, 1], [1, 0]];
    let best = null;
    pairs.forEach((p) => {
      const parts = tHands.map((t, i) => handParts(t, L[p[i]]));
      const cost = parts.reduce((a, x) => a + x.shape / SCALE.shape + x.orient / SCALE.orient, 0);
      if (!best || cost < best.cost) best = { cost, p, parts };
    });
    const shape = best.parts.reduce((a, x) => a + x.shape, 0) / nT;
    const orient = best.parts.reduce((a, x) => a + x.orient, 0) / nT;
    // layout: vector from the screen-left hand to the screen-right hand, in hand sizes (raw frame x)
    let layout = 0;
    if (nT === 2) {
      const vec = (hs, v) => {
        const [a, b] = hs[0].palmCentre2d[0] <= hs[1].palmCentre2d[0] ? [hs[0], hs[1]] : [hs[1], hs[0]];
        const sz = (a.size2d + b.size2d) / 2 || 1;
        return [(b.palmCentre2d[0] - a.palmCentre2d[0]) / sz, (b.palmCentre2d[1] - a.palmCentre2d[1]) / sz];
      };
      const vt = vec(tHands), vl = vec(L);
      layout = Math.hypot(vt[0] - vl[0], vt[1] - vl[1]);
    }
    const mid = (hs, v) => {
      let x = 0, y = 0; hs.forEach((h) => { x += h.palmCentre2d[0] / v[0]; y += h.palmCentre2d[1] / v[1]; });
      return [x / hs.length, y / hs.length];
    };
    const mt = mid(tHands, tVideo), ml = mid(L, lVideo);
    const position = Math.hypot(mt[0] - ml[0], mt[1] - ml[1]);
    const w = nT === 2 ? WEIGHT_2 : WEIGHT_1;
    const s = { shape: sim(shape, SCALE.shape), orient: sim(orient, SCALE.orient), layout: nT === 2 ? sim(layout, SCALE.layout) : 1, position: sim(position, SCALE.position) };
    const overall = w.shape * s.shape + w.orient * s.orient + w.layout * s.layout + w.position * s.position;
    const r = (x) => Math.round(x * 100);
    return {
      overall: r(overall), shape: r(s.shape), orient: r(s.orient), layout: nT === 2 ? r(s.layout) : null, position: r(s.position),
      raw: { shapeDeg: +shape.toFixed(1), orientDeg: +orient.toFixed(1), layoutSizes: +layout.toFixed(2), positionFrac: +position.toFixed(2) },
    };
  }

  /** Turns an exported pose record into {label, hands:[features], video:[w,h]} (live hands only). */
  function templateOf(rec) {
    // faceRel (hand landmarks in face units, from the recorder when the face was tracked) rides along on a copy of the features
    const hands = rec.hands.filter((h) => !h.coasting && h.features).map((h) => (h.faceRel ? Object.assign({}, h.features, { faceRel: h.faceRel }) : h.features));
    return { label: rec.label, take: rec.take, hands, video: rec.context && rec.context.videoSize || [640, 480], expectedHands: rec.expectedHands };
  }

  /* ------------------------------------------------------------------
     MOTION SIGNS (same idea as J / Z: "gesture initiate", then "motion track")
     For a sign whose handshape stays the same while the hands move (happy, sad, angry ...):
       1. INITIATE: hold the start pose (handshape + palm direction of frame 1) for HOLD_MS.
       2. TRACK:    the handshape must stay roughly the same while the palm centres move.
                    Passes when the hands got far enough from where they started (the farthest
                    distance, not the path length, so landmark jitter cannot add up) and, if the recording shows a
                    clear direction, went the right way, within MOVE_MS. Needed distance = EXTENT_FRAC of the
                    farthest the recorded frames got from frame 1, kept between EXTENT_LO and EXTENT_HI hand sizes.
     Which signs are motion signs is decided from the recording itself: the handshape differs by
     at most SAME_SHAPE_DEG between its frames. A clear direction is required when the recorded hands
     travelled at least DIRECTION_MIN sizes from frame 1 to the last frame.
     All thresholds are first guesses (one take per pose so far). */
  /* SMALL-HAND RELIEF: when the learner steps back (some signs need it) the hand is smaller in the picture, so
     landmarks are noisier and similarity drops. The pass level is lowered by up to RELIEF_MAX points as the live
     hand gets smaller than the recorded one: no relief at 85% of the recorded size or bigger, full relief at
     RELIEF_FULL (45%) of it. Uses the mean hand size (wrist to middle knuckle, pixels) of the live hands against the
     mean of the recorded hands, each in its own video size, so a different webcam resolution does not matter. */
  const RELIEF = { MAX: 12, START: 0.85, FULL: 0.45 };
  function smallHandRelief(liveHands, tHands, liveVideo, tVideo) {
    if (!liveHands.length || !tHands.length) return 0;
    const mean = (hs, v) => hs.reduce((a, h) => a + (h.size2d || 0), 0) / hs.length / (v ? v[0] : 1);
    const ratio = mean(liveHands, liveVideo) / (mean(tHands, tVideo) || 1);
    if (!(ratio < RELIEF.START)) return 0;
    const f = Math.min(1, (RELIEF.START - ratio) / (RELIEF.START - RELIEF.FULL));
    return Math.round(RELIEF.MAX * f);
  }

  const MOTION = { SAME_SHAPE_DEG: 15, DIRECTION_MIN: 1.0, EXTENT_FRAC: 0.6, EXTENT_LO: 0.3, EXTENT_HI: 1.0, HOLD_MS: 500, MOVE_MS: 2500,
                   GATE_SHAPE: 65, GATE_ORIENT: 40, KEEP_SHAPE: 50, DIR_COS: 0.6, DIR_PROGRESS: 0.5, DROP_MS: 300, DONE_SHOW_MS: 3000,
                   // Session 34 (position / direction fix): a recorded path of at least AXIS_MIN hand sizes must be followed along its
                   // main axis (within AXIS_COS = 45 degrees); a path shorter than that, where the palm clearly TURNS instead
                   // (at least ORIENT_MIN_DEG), is checked by the turn of the palm normal (needs ORIENT_FRAC of it, kept between ORIENT_LO and ORIENT_HI degrees).
                   END_PASS: 75, AXIS_MIN: 0.15, AXIS_EXTENT_LO: 0.2, AXIS_EXTENT_LO_2: 0.12, DROP_MS_2: 500, AXIS_COS: 0.707, TURN_COS: 0.5, ORIENT_MIN_DEG: 12, ORIENT_FRAC: 0.6, ORIENT_LO: 10, ORIENT_HI: 35 };

  const orderByX = (hs) => hs.slice().sort((a, b) => a.palmCentre2d[0] - b.palmCentre2d[0]);

  function handShapeDeg(a, b) {
    let s = 0, n = 0;
    FINGERS.forEach((f) => { for (let i = 0; i < 3; i++) { s += Math.abs(a.fingers[f].bendDeg[i] - b.fingers[f].bendDeg[i]); n++; } });
    return s / n;
  }
  function pairShapeDeg(A, B) {
    if (A.length === 1) return handShapeDeg(A[0], B[0]);
    return Math.min((handShapeDeg(A[0], B[0]) + handShapeDeg(A[1], B[1])) / 2, (handShapeDeg(A[0], B[1]) + handShapeDeg(A[1], B[0])) / 2);
  }

  /** Session 36c: the hands of every recorded frame, in the order of frame 1 (x order there). Each later frame is paired with the previous
      one by the smallest total distance, so hands that cross or land on each other (good) keep their identity (orderByX swapped them). */
  function alignStages(stages) {
    const out = [orderByX(stages[0].hands)];
    for (let k = 1; k < stages.length; k++) {
      const prev = out[k - 1], cur = stages[k].hands;
      if (cur.length !== 2 || prev.length !== 2) { out.push(orderByX(cur)); continue; }
      const d = (a, b) => Math.hypot(a.palmCentre2d[0] - b.palmCentre2d[0], a.palmCentre2d[1] - b.palmCentre2d[1]);
      out.push(d(prev[0], cur[0]) + d(prev[1], cur[1]) <= d(prev[0], cur[1]) + d(prev[1], cur[0]) ? [cur[0], cur[1]] : [cur[1], cur[0]]);
    }
    return out;
  }

  /** stages = recorded poses of ONE sign, frame order (templateOf results). */
  function analyseSign(stages) {
    let maxShape = 0;
    for (let i = 0; i < stages.length; i++) for (let j = i + 1; j < stages.length; j++) {
      if (stages[i].hands.length === stages[j].hands.length) maxShape = Math.max(maxShape, pairShapeDeg(stages[i].hands, stages[j].hands));
    }
    const mode = stages.length >= 2 && maxShape <= MOTION.SAME_SHAPE_DEG ? 'motion' : 'staged';
    let net = [], needDirection = false, minExtent = MOTION.EXTENT_LO, axes = [], axisMode = false, orientMode = false, needAngle = 0;
    if (mode === 'motion') {
      const AL = alignStages(stages);
      const a = AL[0], b = AL[stages.length - 1];
      net = a.map((h, i) => { const q = b[i], sz = (h.size2d + q.size2d) / 2 || 1; return [(q.palmCentre2d[0] - h.palmCentre2d[0]) / sz, (q.palmCentre2d[1] - h.palmCentre2d[1]) / sz]; });
      needDirection = net.reduce((m, v) => m + Math.hypot(v[0], v[1]), 0) / net.length >= MOTION.DIRECTION_MIN;
      let far = 0;                                   // farthest any recorded frame got from frame 1 (mean of the hands)
      for (let k = 1; k < stages.length; k++) {
        const c = AL[k];
        far = Math.max(far, a.reduce((m, h, i) => m + Math.hypot(c[i].palmCentre2d[0] - h.palmCentre2d[0], c[i].palmCentre2d[1] - h.palmCentre2d[1]) / (h.size2d || 1), 0) / a.length);
      }
      minExtent = Math.min(MOTION.EXTENT_HI, Math.max(MOTION.EXTENT_LO, MOTION.EXTENT_FRAC * far));
      // Session 34: main axis of the recorded path of every hand (frame 1 to its farthest frame), used when no full
      // direction is required. bi = the path turns back after the farthest frame (out-and-back, circle): both ways allowed.
      axes = a.map((h, i) => {
        let bestK = 0, bestD = -1, bestV = [0, 0];
        for (let k = 1; k < stages.length; k++) {
          const c = AL[k][i], sz = (h.size2d + c.size2d) / 2 || 1;
          const v = [(c.palmCentre2d[0] - h.palmCentre2d[0]) / sz, (c.palmCentre2d[1] - h.palmCentre2d[1]) / sz], dd = Math.hypot(v[0], v[1]);
          if (dd > bestD) { bestD = dd; bestK = k; bestV = v; }
        }
        let bi = false;
        if (bestK < stages.length - 1) {                 // there is a frame after the farthest one: does the path turn back?
          const f = AL[bestK][i], l = AL[stages.length - 1][i], sz = (h.size2d + f.size2d) / 2 || 1;
          const w = [(l.palmCentre2d[0] - f.palmCentre2d[0]) / sz, (l.palmCentre2d[1] - f.palmCentre2d[1]) / sz], wl = Math.hypot(w[0], w[1]);
          if (wl > 1e-6 && bestD > 1e-6) bi = (bestV[0] * w[0] + bestV[1] * w[1]) / (bestD * wl) < MOTION.TURN_COS;
        }
        return { v: bestV, len: bestD, bi };
      });
      const needAxis = !needDirection && axes.some((x) => x.len >= MOTION.AXIS_MIN);
      if (!needDirection && !needAxis) {                 // the hand centre hardly moves: does the palm turn instead?
        let maxN = 0;
        for (let k = 1; k < stages.length; k++) {
          const c = AL[k];
          maxN = Math.max(maxN, a.reduce((m, h, i) => m + angDeg(h.palmNormalCamera, c[i].palmNormalCamera), 0) / a.length);
        }
        if (maxN >= MOTION.ORIENT_MIN_DEG) { orientMode = true; needAngle = Math.min(MOTION.ORIENT_HI, Math.max(MOTION.ORIENT_LO, MOTION.ORIENT_FRAC * maxN)); }
      }
      axisMode = needAxis;
      if (needAxis) minExtent = Math.min(MOTION.EXTENT_HI, Math.max(stages[0].hands.length === 2 ? MOTION.AXIS_EXTENT_LO_2 : MOTION.AXIS_EXTENT_LO, MOTION.EXTENT_FRAC * far));   // Session 35: two-hand signs (surprised: hands move apart only 0.2 sizes) use a lower floor, both hands must still follow their own axis   // the axis check guards against jitter, so a small recorded path (need) may use a lower floor
    }
    return { mode, maxShapeDeg: +maxShape.toFixed(1), net, needDirection, minExtent: +minExtent.toFixed(2), axes, axisMode, orientMode, needAngle: +needAngle.toFixed(1) };
  }

  class MotionTrack {
    /** stages = templateOf results of one motion sign. */
    constructor(stages) { this.stages = stages; this.info = analyseSign(stages); this.reset(); }
    reset() { this.phase = 'hold'; this.holdSince = 0; this.lastOk = 0; this.start = null; this.extent = 0; this.moveSince = 0; this.doneAt = 0; this.endBest = 0; this.prevC = null; this.msg = ''; this.m = {}; this.angle = 0; }

    /** hands = live hands' features (any order); returns {phase, msg, holdMs, shape, orient, extent, extentNeed, dir[], needDirection, moveLeftMs}. */
    update(now, hands, vw, vh, relief, posOk) {
      relief = relief || 0;      // posOk (Session 36): false = the start pose is in the wrong place on the face, the hold timer does not run
      const st = this.stages, n = st[0].hands.length, M = Object.assign({}, MOTION, { DROP_MS: n === 2 ? MOTION.DROP_MS_2 : MOTION.DROP_MS, GATE_SHAPE: MOTION.GATE_SHAPE - relief, GATE_ORIENT: MOTION.GATE_ORIENT - relief, KEEP_SHAPE: MOTION.KEEP_SHAPE - relief });
      if (this.phase === 'done') {
        if (now - this.doneAt > M.DONE_SHOW_MS) this.reset(); else return this.out(now);
      }
      if (hands.length < n) {
        if (this.phase === 'move' && now - this.lastOk > M.DROP_MS) { this.reset(); this.msg = 'lost the hands, hold the start pose again'; }
        else if (this.phase === 'hold') this.holdSince = 0;
        this.m = { shape: null, orient: null };
        if (!this.msg || this.phase === 'hold') this.msg = 'show ' + n + ' hand' + (n === 1 ? '' : 's');
        return this.out(now);
      }
      const start = comparePose(st[0].hands, hands, st[0].video, [vw, vh]);
      let bestShape = start.shape;
      for (let i = 1; i < st.length; i++) { const r = comparePose(st[i].hands, hands, st[i].video, [vw, vh]); if (r && r.shape > bestShape) bestShape = r.shape; }
      this.m = { shape: bestShape, orient: start.orient };
      const live = orderByX(n === 1 ? [pickBest(st[0].hands[0], hands)] : hands.slice(0, 2).length === 2 ? hands.slice(0, 2) : hands);

      if (this.phase === 'hold') {
        const ok = start.shape >= M.GATE_SHAPE && start.orient >= M.GATE_ORIENT && posOk !== false;
        if (ok) { this.lastOk = now; if (!this.holdSince) this.holdSince = now; }
        else if (now - this.lastOk > 150) this.holdSince = 0;
        if (this.holdSince && now - this.holdSince >= M.HOLD_MS) {
          this.phase = 'move'; this.moveSince = now; this.lastOk = now; this.extent = 0; this.endBest = 0;
          this.start = live.map((h) => ({ c: h.palmCentre2d.slice(), sz: h.size2d || 1, n: h.palmNormalCamera.slice() })); this.prevC = live.map((h) => h.palmCentre2d.slice());
          this.msg = 'now do the movement';
        } else this.msg = ok ? 'hold the start pose…' : (posOk === false && start.shape >= M.GATE_SHAPE && start.orient >= M.GATE_ORIENT) ? 'start pose is in the wrong place' : 'make the start pose (frame 1) and hold it';
        return this.out(now);
      }

      // phase 'move'
      // Session 36c: two-hand signs where the hands cross or land on each other (good, ...) must keep each hand's identity: re-pair the
      // live hands with the START hands by the smallest total move since the last frame instead of by x order (which swaps when they cross).
      let liveM = live;
      if (n === 2 && live.length === 2 && this.prevC) {
        const d = (h, c) => Math.hypot(h.palmCentre2d[0] - c[0], h.palmCentre2d[1] - c[1]);
        liveM = (d(live[0], this.prevC[0]) + d(live[1], this.prevC[1]) <= d(live[1], this.prevC[0]) + d(live[0], this.prevC[1])) ? live : [live[1], live[0]];
      }
      this.prevC = liveM.map((h) => h.palmCentre2d.slice());
      // Session 36c (owner): the movement only counts when the hands also REACH one of the later recorded poses (frame 2 or later) at the
      // pass level (END_PASS, lowered by the same relief). Before, any movement of the right size passed even when the second pose
      // never turned green in the debug view (wrong direction, wrong place). Frame 1 is the start pose and does not count.
      for (let i = 1; i < st.length; i++) { const r = comparePose(st[i].hands, hands, st[i].video, [vw, vh]); if (r && r.overall > this.endBest) this.endBest = r.overall; }
      if (bestShape < M.KEEP_SHAPE) { if (now - this.lastOk > M.DROP_MS) { this.reset(); this.msg = 'handshape changed: start again'; } return this.out(now); }
      this.lastOk = now;
      const disp = liveM.map((h, i) => [(h.palmCentre2d[0] - this.start[i].c[0]) / this.start[i].sz, (h.palmCentre2d[1] - this.start[i].c[1]) / this.start[i].sz]);
      let dirOk = true; const dir = [];
      if (this.info.needDirection) {
        this.info.net.forEach((tv, i) => {
          const d = disp[i], dl = Math.hypot(d[0], d[1]), tl = Math.hypot(tv[0], tv[1]) || 1;
          if (tl < 0.3) { dir.push({ cos: null, progress: null, skipped: true }); return; }   // Session 36c: a hand that hardly moves in the recording (good: the receiving palm) has no direction to follow
          const cos = dl > 0.05 ? (d[0] * tv[0] + d[1] * tv[1]) / (dl * tl) : 0, prog = (d[0] * tv[0] + d[1] * tv[1]) / (tl * tl);
          dir.push({ cos: +cos.toFixed(2), progress: +prog.toFixed(2) });
          if (!(cos >= M.DIR_COS && prog >= M.DIR_PROGRESS)) dirOk = false;
        });
      }
      this.extent = Math.max(this.extent, disp.reduce((m, d) => m + Math.hypot(d[0], d[1]), 0) / disp.length);
      this.angle = Math.max(this.angle, liveM.reduce((m, h, i) => m + angDeg(this.start[i].n, h.palmNormalCamera), 0) / live.length);
      this.dir = dir;
      // Session 34: follow the recorded main axis (within 45 degrees). A one-hand sign also accepts the x-mirrored axis (left-handed learners).
      let axisOk = true;
      if (this.info.axisMode) {
        axisOk = this.info.axes.every((ax, i) => {
          if (ax.len < M.AXIS_MIN) return true;
          const d = disp[i], dl = Math.hypot(d[0], d[1]); if (dl < 0.05) return false;
          const c1 = (d[0] * ax.v[0] + d[1] * ax.v[1]) / (dl * ax.len), c2 = (d[0] * -ax.v[0] + d[1] * ax.v[1]) / (dl * ax.len);
          return c1 >= M.AXIS_COS || (ax.bi && -c1 >= M.AXIS_COS) || (n === 1 && (c2 >= M.AXIS_COS || (ax.bi && -c2 >= M.AXIS_COS)));
        });
      }
      const moved = (this.info.orientMode ? this.angle >= this.info.needAngle : this.extent >= this.info.minExtent) && this.endBest >= M.END_PASS - relief;
      if (moved && dirOk && axisOk) { this.phase = 'done'; this.doneAt = now; this.msg = 'passed'; }
      else if (now - this.moveSince > M.MOVE_MS) { this.reset(); this.msg = 'too slow or wrong direction: start again'; }
      else this.msg = (this.endBest < M.END_PASS - relief && (this.extent >= this.info.minExtent)) ? 'moved, but the hands did not reach the next pose' : (this.info.needDirection || this.info.axisMode) ? 'moving… follow the recorded direction' : this.info.orientMode ? 'moving… turn the hand like the recording' : 'moving…';
      return this.out(now);
    }
    out(now) {
      return { phase: this.phase, msg: this.msg, holdMs: this.holdSince ? Math.min(MOTION.HOLD_MS, now - this.holdSince) : 0, shape: this.m.shape, orient: this.m.orient,
               extent: this.info.orientMode ? +this.angle.toFixed(1) : +this.extent.toFixed(2), extentNeed: this.info.orientMode ? this.info.needAngle : this.info.minExtent, unit: this.info.orientMode ? 'deg' : 'size', dir: this.dir || [], needDirection: this.info.needDirection,
               endPct: this.endBest, moveLeftMs: this.phase === 'move' ? Math.max(0, MOTION.MOVE_MS - (now - this.moveSince)) : 0 };
    }
  }
  function pickBest(tHand, hands) {   // one-hand sign: the live hand whose shape fits best
    let b = hands[0], bd = 1e9; hands.forEach((h) => { const d = handShapeDeg(tHand, h); if (d < bd) { bd = d; b = h; } }); return b;
  }

  root.PoseMatch = { smallHandRelief, RELIEF, comparePose, templateOf, analyseSign, MotionTrack, MOTION, SCALE, WEIGHT_2, WEIGHT_1 };
})(typeof window !== 'undefined' ? window : globalThis);
