/* FaceTracker + FaceMath + FaceGate (dev tool, used by gesture-demo.html; not used by the learner app yet).

   Why: some signs differ only by WHERE the hand is on the face (mother = thumb on the chin, father = thumb on
   the forehead). The hand model cannot see the face, so this adds a face model (MediaPipe FaceMesh through
   @tensorflow-models/face-landmarks-detection) and turns the face into a small coordinate system:

     origin = middle of the face (halfway between forehead landmark 10 and chin landmark 152)
     v axis = forehead to chin (so it follows head roll), u axis = across the face (raw frame x direction)
     unit   = face height (landmark 10 to 152), so it does not depend on how far the learner sits

   A hand point (for example the thumb tip, landmark 4) is converted to these face coordinates; a sign passes the
   face check when that point is inside the zone: a circle with a centre (u, v) and a radius, in face heights.
   The zone comes from the RECORDED pose when the record has `faceRel` (the recorder stores every hand landmark in
   face coordinates when the face was tracked), otherwise from the default zones below (first guesses).

   Everything works in the RAW (unmirrored) frame, like HandFeatures.landmarks2d. Mirror mode (see HANDOFF.md) must
   flip the u axis too. */
(function (root) {
  'use strict';

  const FACE_IDX = { top: 10, chin: 152, left: 234, right: 454, nose: 1 };
  const r3 = (n) => Math.round(n * 1000) / 1000;

  // Default zones (face units, centre [u, v], radius). v = -0.5 is the top of the forehead mesh, +0.5 the chin tip.
  const FACE_ZONES = {
    chin:     { c: [0, 0.44],  r: 0.22 },
    forehead: { c: [0, -0.42], r: 0.24 },
    // Session 34 (owner): cheek and mouth zones. They exist on BOTH sides of the face (u = +/-), so a left-handed learner is
    // fine: `cs` lists every centre and the hand counts when it is inside ANY of them. Values come from the owner's recording
    // (girl_1 thumb tip at u 0.39 v 0.36, home_1 at u 0.29 v 0.30); they are first guesses, tune them here.
    cheek:    { cs: [[-0.34, 0.20], [0.34, 0.20]], r: 0.18 },   // the cheek / below the cheek (start of girl and home)
    cheekHigh:{ cs: [[-0.34, 0.12], [0.34, 0.12]], r: 0.18 },   // Session 34d: home's cheek, a little higher than girl's (girl keeps `cheek`)
    mouth:    { cs: [[-0.14, 0.28], [0.14, 0.28]], r: 0.19 },   // beside the mouth, below the cheek (end of home)
    lips:     { c: [0, 0.27], r: 0.25 },   // r 0.25: the re-recorded lonely_1 index tip sits 0.15 from the centre
    // Session 36b (owner): CHEST zone, relative to the face (face units, so it follows the learner's distance and head roll). Chest centre about 1.5 face heights
    // below the face centre (recorded chest palms: sick 1.73, like 1.5, hungry 1.2 to 1.8); wide on purpose. First guess, tune here.
    chest:    { c: [0, 1.5], r: 0.95 },                          // radius 0.95 (widened from 0.75)
  };
  // Signs that also need a face check: which zone, and which hand landmark must be inside it (4 = thumb tip).
  const FACE_SIGNS = {
    mother: { zone: 'chin',     anchor: 4 },
    father: { zone: 'forehead', anchor: 4 },
    know:   { zone: 'forehead', anchor: 8, fixed: true, away: [1] },   // index fingertip (8) vs the real forehead zone (same zone as father; fixed = ignore the recorded hand position). Frame 1 must be AWAY from the zone (not touching yet), the later frames must be IN it (touching).
    // Session 33 (owner): the zone comes from the RECORDED pose, so boy must be RE-RECORDED with the real contact and the face tracked.
    boy:    { zone: 'forehead', anchor: 4 },                       // every frame: thumb tip touches the forehead point (owner: the zone sits on the eye in the demo but works because the thumb touches it; left as is)
    // Session 34 (owner): girl and home use FIXED zones per frame (the old recorded chin circle was off, the first girl pose is at the cheek).
    girl:   { zones: { 1: 'cheek', 3: 'chin' },  anchor: 4,      fixed: true, only: [1, 3] },   // start: thumb tip at the cheek, end: thumb tip on the chin; frame 2 has no face rule
    // Session 36 (owner): lonely starts with the index fingertip around the LIPS (frame 1 only; the rest is the upward motion check, which stays a motion sign).
    lonely: { zones: { 1: 'lips' }, anchor: 8, fixed: true, only: [1] },
    // Session 36b (owner): chest signs (no face data needed, fixed chest zone on frame 1; anchor 9 = middle knuckle, a stand-in for the palm). me points at the chest, happy / please / sorry / proud start on it.
    me:     { zones: { 1: 'chest' }, anchor: 9, fixed: true, only: [1] },
    happy:  { zones: { 1: 'chest' }, anchor: 9, fixed: true, only: [1] },
    please: { zones: { 1: 'chest' }, anchor: 9, fixed: true, only: [1] },
    sorry:  { zones: { 1: 'chest' }, anchor: 9, fixed: true, only: [1] },
    proud:  { zones: { 1: 'chest' }, anchor: 9, fixed: true, only: [1] },
    home:   { zones: { 1: 'mouth', 3: 'cheekHigh' }, anchor: [4, 8], fixed: true, only: [1, 3] },   // start: thumb + index tips beside the mouth, end: both at the cheek; frame 2 has no face rule
  };
  // Session 35 (two-hand lessons): two-hand position rules (FaceGate.checkPair). sick = one hand at the forehead, the OTHER hand on the chest (below the chin).
  const FACE_PAIR_SIGNS = { sick: { pair: 'forehead-chest' } };
  // Optional keys per sign: zones = { frame: zoneName } (a different zone per frame, replaces `zone` for those frames); anchor may be a number or a list (all of them must be inside their zone); only = [frame numbers]
  // that have a face rule (the other frames get no check); away = [frame numbers] that must NOT touch the zone.
  const FACE_PAIR = { forehead: 0.45, chestV: 0.75, gap: 2.0 };   // Session 35: sick (see FaceGate.checkPair); tune here. Session 36: forehead 0.30 -> 0.45 (the new sick_1 recording has the middle fingertip at u 0.21, v -0.61, i.e. 0.28 from the centre, right on the old limit)
  const FACE_RADIUS = 0.22; // radius around the RECORDED anchor position, in face heights

  const FaceMath = {
    /** keypoints = [{x, y}] (468 FaceMesh points, raw frame pixels). Returns null when the face is unusable. */
    geometry(kps) {
      if (!kps) return null;
      const t = kps[FACE_IDX.top], c = kps[FACE_IDX.chin];
      if (!t || !c) return null;
      const H = Math.hypot(c.x - t.x, c.y - t.y);
      if (!(H >= 20)) return null;                       // under 20 px: not a real face
      const v = [(c.x - t.x) / H, (c.y - t.y) / H];
      const u = [v[1], -v[0]];                           // (0,1) down -> (1,0): raw frame x
      const pt = (k) => (kps[FACE_IDX[k]] ? [kps[FACE_IDX[k]].x, kps[FACE_IDX[k]].y] : null);
      return { origin: [(t.x + c.x) / 2, (t.y + c.y) / 2], u, v, H, pts: { top: pt('top'), chin: pt('chin'), left: pt('left'), right: pt('right'), nose: pt('nose') } };
    },
    toFace(g, p) {
      const dx = p[0] - g.origin[0], dy = p[1] - g.origin[1];
      return [(dx * g.u[0] + dy * g.u[1]) / g.H, (dx * g.v[0] + dy * g.v[1]) / g.H];
    },
    fromFace(g, q) {
      return [g.origin[0] + (q[0] * g.u[0] + q[1] * g.v[0]) * g.H, g.origin[1] + (q[0] * g.u[1] + q[1] * g.v[1]) * g.H];
    },
    /** 21 hand landmarks (pixels) -> 21 [u, v] in face units, rounded for the record. */
    handToFace(g, landmarks2d) { return landmarks2d.map((p) => FaceMath.toFace(g, p).map(r3)); },
  };

  const FaceGate = {
    /** Zone for a sign: {c, r, zone, anchor, source}. tpl = a recorded template (PoseMatch.templateOf) or null. */
    zoneOf(signId, tpl) {
      const cfg = FACE_SIGNS[signId]; if (!cfg) return null;
      const rel = tpl && tpl.hands && tpl.hands[0] && tpl.hands[0].faceRel;
      const stage = parseInt(((tpl && tpl.label) || '').replace(/^.*_(\d+)$/, '$1'), 10);
      const zoneName = (cfg.zones && cfg.zones[stage]) || cfg.zone;
      if (!zoneName) return null;                         // a frame without a zone has no face rule
      const one = (a) => {
        if (rel && rel[a] && !cfg.fixed) return { c: rel[a], cs: [rel[a]], r: cfg.r || FACE_RADIUS, zone: zoneName, anchor: a, source: 'recorded' };
        const z = FACE_ZONES[zoneName], cs = z.cs || [z.c];
        return { c: cs[0], cs, r: cfg.r || z.r, zone: zoneName, anchor: a, source: 'default' };
      };
      const all = [].concat(cfg.anchor).map(one);
      return Object.assign({}, all[0], { all });          // the first anchor is what the demo draws; check() uses all of them
    },
    /** state: 'noface' | 'nohand' | 'in' | 'out'; ok: true only for 'in'. null when the sign has no face check. */
    check(signId, tpl, liveHands, geom) {
      const z = FaceGate.zoneOf(signId, tpl); if (!z) return null;
      const cfg = FACE_SIGNS[signId], stage = parseInt(((tpl && tpl.label) || '').replace(/^.*_(\d+)$/, '$1'), 10);
      if (cfg.only && cfg.only.indexOf(stage) < 0) return null;          // this frame has no face rule (null = nothing to check)
      if (!geom) return { state: 'noface', ok: false, zone: z };
      let worst = null;                                                  // the anchor that is furthest outside its zone (relative to its radius)
      for (const zn of z.all) {
        let best = null;
        (liveHands || []).forEach((h) => {
          const lm = h.landmarks2d && h.landmarks2d[zn.anchor]; if (!lm) return;
          const p = FaceMath.toFace(geom, lm), d = Math.min.apply(null, zn.cs.map((c) => Math.hypot(p[0] - c[0], p[1] - c[1])));   // nearest centre (cheek / mouth exist on both sides)
          if (!best || d < best.dist) best = { dist: d, p };
        });
        if (!best) return { state: 'nohand', ok: false, zone: z };
        const ratio = best.dist / zn.r;
        if (!worst || ratio > worst.ratio) worst = { dist: best.dist, p: best.p, ratio, zn };
      }
      const inside = worst.ratio <= 1;
      const away = !!(cfg.away && cfg.away.indexOf(stage) >= 0);      // this frame wants the hand NOT touching the zone
      return { state: inside ? 'in' : 'out', ok: away ? !inside : inside, away, dist: r3(worst.dist), livePt: worst.p, zone: worst.zn };
    },
    /** Two-hand position rule (sick): one hand's middle fingertip (12) near the forehead, the other hand's palm centre below the chin.
        Face units: the forehead zone is a circle (centre [0, -0.42], radius PAIR.forehead = 0.30), the chest hand needs v >= PAIR.chestV (0.75, the chin is at 0.44).
        Either hand may be the forehead hand (left-handed learners). Returns {state, ok, pair:true}. */
    checkPair(signId, liveHands, geom) {
      const cfg = FACE_PAIR_SIGNS[signId]; if (!cfg) return null;
      if (!geom) return { state: 'noface', ok: false, pair: true };
      const hs = (liveHands || []).filter((h) => h.landmarks2d && h.palmCentre2d);
      if (hs.length < 2) return { state: 'nohand', ok: false, pair: true };
      const P = FACE_PAIR, fc = FACE_ZONES.forehead.c;
      let best = null;
      [[0, 1], [1, 0]].forEach((o) => {
        const f = FaceMath.toFace(geom, hs[o[0]].landmarks2d[12]), c = FaceMath.toFace(geom, hs[o[1]].palmCentre2d);
        const dF = Math.hypot(f[0] - fc[0], f[1] - fc[1]), okF = dF <= P.forehead, okC = c[1] >= P.chestV;
        const score = (okF ? 0 : dF - P.forehead) + (okC ? 0 : P.chestV - c[1]);
        if (!best || score < best.score) best = { score, okF, okC, dF: r3(dF), chestV: r3(c[1]) };
      });
      return { state: best.okF && best.okC ? 'in' : 'out', ok: best.okF && best.okC, pair: true, forehead: best.okF, chest: best.okC, dist: best.dF, chestV: best.chestV };
    },
    /** Fallback for checkPair when the face model is not available (no face geometry): one hand clearly above the other
        (palm centres at least PAIR.gap hand sizes apart vertically) and the upper hand in the top half of the frame. */
    geometricPair(signId, liveHands, vh) {
      const cfg = FACE_PAIR_SIGNS[signId]; if (!cfg) return null;
      const hs = (liveHands || []).filter((h) => h.palmCentre2d);
      if (hs.length < 2) return { state: 'nohand', ok: false, pair: true };
      const a = hs[0].palmCentre2d[1] <= hs[1].palmCentre2d[1] ? [hs[0], hs[1]] : [hs[1], hs[0]];
      const sz = (a[0].size2d + a[1].size2d) / 2 || 1;
      const ok = (a[1].palmCentre2d[1] - a[0].palmCentre2d[1]) / sz >= FACE_PAIR.gap && a[0].palmCentre2d[1] < 0.55 * (vh || 480);
      return { state: ok ? 'in' : 'out', ok, pair: true };
    },
    text(g) {
      if (!g) return '';
      if (g.state === 'noface') return 'your face is not seen (is face tracking on, is your face in view?)';
      if (g.state === 'nohand') return 'no hand to check';
      const z = g.zone;
      if (g.away) return g.ok ? 'the hand is away from the ' + z.zone + ' (not touching yet)' : 'the hand is already touching the ' + z.zone + ' (this frame needs it away: ' + g.dist + ' face heights, needs more than ' + z.r + ')';
      return g.ok ? 'the hand is at the ' + z.zone : 'the hand is not at the ' + z.zone + ' (' + g.dist + ' face heights away, needs ' + z.r + ' or less)';
    },
  };


  /* ---- Session 36 (owner): generic POSITION-ON-THE-FACE check for every sign that has recorded face data ----
     Most signs used to ignore where the hand is relative to the face (only mother, father, know, boy, girl, home, sick had a rule).
     Now, when ALL recorded poses of a sign carry `faceRel` (the recorder stored the hand in face units with face tracking on), the
     live palm centre(s) must be within a tolerance of the recorded palm centre(s), in face heights (so distance to the camera does
     not matter). Signs with their own rule above (FACE_SIGNS / FACE_PAIR_SIGNS) keep that rule. Signs recorded WITHOUT face data
     (see HANDOFF Session 36 for the list) have no position check until they are re-recorded with face tracking ON.
     Left-handed learners: the recorded u is also tried mirrored (u -> -u), for two hands both together.
     Tolerance (face heights) = clamp(POS.base + POS.perDist * distance of the recorded palm from the face centre, POS.lo, POS.hi),
     averaged over the hands; override one sign in FACE_POS_R; switch one sign off with FACE_POS_OFF. */
  const FACE_POS = { base: 0.55, perDist: 0.15, lo: 0.6, hi: 0.95 };
  const FACE_POS_R = {};          // { signId: radius in face heights }
  const FACE_POS_OFF = ['goodbye'];        // sign ids that must NOT get the generic position check (Session 46: goodbye is a wave, its place is not part of the sign)
  const PALM_IDX = [0, 5, 9, 13, 17];
  function palmOfRel(rel) {
    if (!rel) return null;
    const pts = PALM_IDX.map((i) => rel[i]).filter((q) => q && q.length === 2);
    if (pts.length < 3) return null;
    return [pts.reduce((a, q) => a + q[0], 0) / pts.length, pts.reduce((a, q) => a + q[1], 0) / pts.length];
  }
  Object.assign(FaceGate, {
    /** The recorded palm centres of a template in face units, or null when any hand has no usable face data. */
    posTargets(tpl) {
      if (!tpl || !tpl.hands || !tpl.hands.length) return null;
      const out = tpl.hands.map((h) => palmOfRel(h.faceRel));
      return out.some((q) => !q) ? null : out;
    },
    /** True when every recorded frame of the sign has face data (stages = templates in frame order). */
    hasPos(signId, stages) {
      if (FACE_POS_OFF.indexOf(signId) >= 0 || !stages || !stages.length) return false;
      return stages.every((t) => !!FaceGate.posTargets(t));
    },
    /** state: 'noface' | 'nohand' | 'in' | 'out'. Compares the live palm centre(s) with the recorded ones in face units. */
    posCheck(signId, tpl, liveHands, geom) {
      const T = FaceGate.posTargets(tpl); if (!T) return null;
      if (!geom) return { state: 'noface', ok: false, pos: true };
      const hs = (liveHands || []).filter((h) => h.palmCentre2d);
      if (hs.length < T.length) return { state: 'nohand', ok: false, pos: true };
      const L = hs.map((h) => FaceMath.toFace(geom, h.palmCentre2d));
      const mean = T.reduce((a, q) => a + Math.hypot(q[0], q[1]), 0) / T.length;
      const R = FACE_POS_R[signId] != null ? FACE_POS_R[signId] : Math.min(FACE_POS.hi, Math.max(FACE_POS.lo, FACE_POS.base + FACE_POS.perDist * mean));
      let best = Infinity;
      [1, -1].forEach((sg) => {                                   // sg = -1: the recorded face u mirrored (left-handed learner)
        const Tm = T.map((q) => [q[0] * sg, q[1]]);
        if (T.length === 1) { L.forEach((p) => { best = Math.min(best, Math.hypot(p[0] - Tm[0][0], p[1] - Tm[0][1])); }); return; }
        [[0, 1], [1, 0]].forEach((o) => {
          const d = (Math.hypot(L[o[0]][0] - Tm[0][0], L[o[0]][1] - Tm[0][1]) + Math.hypot(L[o[1]][0] - Tm[1][0], L[o[1]][1] - Tm[1][1])) / 2;
          best = Math.min(best, d);
        });
      });
      return { state: best <= R ? 'in' : 'out', ok: best <= R, pos: true, dist: r3(best), radius: r3(R) };
    },
  });

  class FaceTracker {
    /** options: holdMs = how long the last good face is kept when the face is lost or covered by the hand (the head barely
        moves while signing; a hand on the face can hide it); intervalMs = pause between model runs. */
    constructor(o) {
      o = o || {};
      this.holdMs = o.holdMs != null ? o.holdMs : 1500;
      this.intervalMs = o.intervalMs != null ? o.intervalMs : 100;
      this.status = 'idle';          // idle | loading | running | error
      this.error = null; this.geom = null; this.geomAt = 0; this.frames = 0; this.hits = 0; this.fails = 0;
      this.running = false; this.detector = null; this._t = null;
    }
    async start(videoEl) {
      if (this.running) return;
      this.running = true; this.videoEl = videoEl; this.status = 'loading'; this.error = null;
      try {
        if (typeof faceLandmarksDetection === 'undefined') throw new Error('face library did not load (internet needed)');
        if (!this.detector) {
          if (typeof tf !== 'undefined' && tf.ready) await tf.ready();
          this.detector = await faceLandmarksDetection.createDetector(faceLandmarksDetection.SupportedModels.MediaPipeFaceMesh, {
            runtime: 'mediapipe', solutionPath: 'https://cdn.jsdelivr.net/npm/@mediapipe/face_mesh@0.4.1633559619', maxFaces: 1, refineLandmarks: false,
          });
        }
      } catch (e) { this.status = 'error'; this.error = (e && e.message) || String(e); this.running = false; return; }
      if (!this.running) { this.status = 'idle'; return; }   // stopped while the model was loading
      this.status = 'running'; this._loop();
    }
    stop() { this.running = false; clearTimeout(this._t); if (this.status !== 'error') this.status = 'idle'; }
    async _loop() {
      if (!this.running) return;
      const t0 = performance.now(), v = this.videoEl;
      try {
        if (v && v.readyState >= 2 && v.videoWidth) {
          const faces = await this.detector.estimateFaces(v, { flipHorizontal: false });
          this.frames++;
          const g = faces && faces[0] ? FaceMath.geometry(faces[0].keypoints) : null;
          if (g) { this.geom = g; this.geomAt = performance.now(); this.hits++; }
          this.fails = 0;
        }
      } catch (e) {
        if (++this.fails >= 5) { this.status = 'error'; this.error = (e && e.message) || String(e); this.running = false; return; }
      }
      this._t = setTimeout(() => this._loop(), Math.max(0, this.intervalMs - (performance.now() - t0)));
    }
    /** Latest face geometry, or null when none was seen within holdMs. `live` = seen in the last 400 ms. */
    current(now) {
      now = now != null ? now : performance.now();
      if (!this.geom) return null;
      const age = now - this.geomAt;
      if (age > this.holdMs) return null;
      return Object.assign({}, this.geom, { ageMs: Math.round(age), live: age < 400 });
    }
  }

  root.FaceMath = FaceMath; root.FaceGate = FaceGate; root.FaceTracker = FaceTracker;
  root.FACE_ZONES = FACE_ZONES; root.FACE_SIGNS = FACE_SIGNS; root.FACE_PAIR_SIGNS = FACE_PAIR_SIGNS; root.FACE_RADIUS = FACE_RADIUS; root.FACE_PAIR = FACE_PAIR; root.FACE_POS = FACE_POS; root.FACE_POS_R = FACE_POS_R; root.FACE_POS_OFF = FACE_POS_OFF;
})(typeof window !== 'undefined' ? window : globalThis);
