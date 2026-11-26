/* ==========================================================================
   sign-check.js — real camera checks for the emotion / word signs (lessons).
   Classic script. Needs (load before this file): gesture-detection.js (HandFeatures)
   and pose-match.js (PoseMatch). Exposes the global `SignCheck`.

   What it does: loads the recorded poses (assets/poses/all-signs.json, made with the
   demo's Recorder) and checks one sign at a time against the live hands, using the
   same rules the owner tested in gesture-demo.html "Testing poses":
     - frame-by-frame signs: frames in order, each held at or above PASS_LEVEL (75 %)
       for HOLD_MS, the sequence restarts after RESET_MS without progress;
     - motion signs (handshape stays the same between frames): PoseMatch.MotionTrack
       (hold the start pose 0.5 s, then do the movement).
   One-hand signs accept EITHER hand and ignore a second visible hand (PoseMatch picks the
   best fitting live hand). The pass level drops a little for small hands (PoseMatch.smallHandRelief).

   Face-zone signs (mother, father, know, boy, girl, home; FACE_SIGNS in face-tracker.js, Session 34):
   the caller passes the current face geometry (FaceTracker.current()) to update(); a frame only
   counts while its face rule holds (hand at the forehead / chin / cheek / mouth). The zones are
   NEVER drawn in the lessons (owner): the learner only gets a short text hint. A sign with a face
   rule and 2 or more frames is always checked frame by frame (same as the demo).
   Two-hand signs (Session 35): the same code handles them. `need` = 2, both hands must be visible (a drop shorter than DROP_GRACE_MS
   keeps the hold timer, hands that touch are lost by the model for a moment); hands are paired by best fit, so left / right does not matter.
   sick has a position rule (FACE_PAIR_SIGNS.sick): one hand at the forehead, the other below the chin (face model), or, when the face model
   is unavailable, simply one hand clearly above the other.
   ========================================================================== */
(function (root) {
  'use strict';

  const PASS_LEVEL = 75;      // % similarity (owner: keep 75 everywhere)
  const HOLD_MS = 250;        // each frame must stay above the pass level this long (same as the demo)
  const DROP_GRACE_MS = 250;  // two-hand signs: the model often loses one hand for a moment when the hands touch; keep the hold timer this long
  // Session 47: a frame below the pass level does not restart the hold if the last good frame was at most this long ago.
  // The demo's Testing poses reads the hands every 120 ms, so it steps over one-frame dips; the lessons look at EVERY camera frame
  // (30 fps) and restarted the 250 ms hold on any single dip, so a pose that hovers around 75 % (a moving wave: goodbye) passed in the demo but not in the lesson.
  // Every accepted frame is still at or above the level; only a short dip is forgiven.
  const DIP_GRACE_MS = 150;
  const RESET_MS = 8000;      // restart the sequence after this long without progress (same as the demo)
  // Per-sign, per-frame pass level overrides (% similarity; frame numbers start at 1). Everything not listed uses PASS_LEVEL.
  // come: its first pose is a loose two-handed start, so frame 1 only needs about 65 % (owner, Session 33).
  // Live since Session 35 (come is a real two-hand check now).
  // Session 38 (owner): help lowered to 60 %, confused to 70 % (all 3 frames), what 65 % (one pose, new data). Session 36: help 65 % (its one pose, two hands touching); come 70 % for frames 2 and 3 (frame 1 stays at the lower 65 %).
  // Session 37 (owner): sick 65 % (its one pose); come 65 % for ALL its frames (was 65 / 70 / 70).
  const STAGE_PASS = { come: { 1: 65, 2: 65, 3: 65 }, sick: { 1: 65 }, help: { 1: 60 }, confused: { 1: 70, 2: 70, 3: 70 }, what: { 1: 65 } };

  let _bySign = null;         // { signId: [templates in frame order] }
  let _promise = null;

  const frameNo = (label) => parseInt(String(label).split('_').pop(), 10) || 0;
  const signOf = (label) => String(label).replace(/_\d+$/, '');

  /** Loads and groups the recorded poses once. Resolves to { signId: [templates] } (one-hand signs only). */
  function load(url) {
    if (_promise) return _promise;
    _promise = fetch(url).then((r) => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); }).then((d) => {
      const by = {};
      (d.poses || []).forEach((rec) => {
        if (!rec || !rec.label || String(rec.label).indexOf('neg_') === 0) return;
        const t = root.PoseMatch.templateOf(rec);
        if (!t.hands.length) return;
        (by[signOf(rec.label)] = by[signOf(rec.label)] || []).push(t);
      });
      Object.keys(by).forEach((k) => { by[k].sort((a, b) => frameNo(a.label) - frameNo(b.label) || (a.take || 1) - (b.take || 1)); });
      _bySign = by;
      return by;
    }).catch((e) => { _promise = null; throw e; });
    return _promise;
  }

  /** The poses of one sign, only the first take of every frame. null when unknown. */
  function stagesOf(id) {
    const all = _bySign && _bySign[id];
    if (!all || !all.length) return null;
    const seen = new Set(), out = [];
    all.forEach((t) => { const n = frameNo(t.label); if (!seen.has(n)) { seen.add(n); out.push(t); } });
    return out;
  }

  class SignChecker {
    constructor(id) {
      this.id = id;
      this.stages = stagesOf(id);
      if (!this.stages) throw new Error('no recorded poses for ' + id);
      this.need = this.stages[0].hands.length;
      this.info = root.PoseMatch.analyseSign(this.stages);
      this.mode = this.info.mode;                         // 'motion' | 'staged'
      this.faceCfg = (root.FACE_SIGNS && root.FACE_SIGNS[id]) || null;
      this.pairCfg = (root.FACE_PAIR_SIGNS && root.FACE_PAIR_SIGNS[id]) || null;   // two-hand position rule (sick)
      // Session 36: a face rule on frame 1 ONLY (lonely: index tip at the lips) is a start-pose gate, the sign stays a motion sign.
      this.faceStartOnly = !!(this.faceCfg && this.faceCfg.only && this.faceCfg.only.length === 1 && this.faceCfg.only[0] === 1);
      if (this.faceCfg && this.stages.length >= 2 && !(this.faceStartOnly && this.mode === 'motion')) this.mode = 'staged';   // each frame's face rule must be checked, motion mode ignores the face
      // Session 36: every other sign whose recorded poses all carry face data gets the generic position-on-the-face check.
      this.posOn = !this.faceCfg && !this.pairCfg && !!root.FaceGate && root.FaceGate.hasPos(id, this.stages);
      this.needsFace = !!(this.faceCfg || this.pairCfg || this.posOn);
      this.track = this.mode === 'motion' ? new root.PoseMatch.MotionTrack(this.stages) : null;
      this.reset();
    }
    reset() {
      this.idx = 0; this.since = 0; this.lastProgress = 0; this.passed = false; this.lastFull = 0; this.lastGood = 0;
      if (this.track) this.track.reset();
    }
    get total() { return this.stages.length; }

    /** hands = HandFeatures of the live hands (any order). geom = FaceTracker.current() for a face-zone sign
        (null = face not seen, undefined = skip the face rule, used when the face model could not load for a sign
        that worked before without it). Returns a state object for the UI:
        { mode, passed, idx, total, seen, need, similarity, holdPct, phase, extentPct, needFace, gate } */
    update(now, hands, vw, vh, geom) {
      const out = { mode: this.mode, passed: this.passed, idx: this.idx, total: this.total, seen: hands.length, need: this.need, similarity: null, holdPct: 0, phase: null, extentPct: 0, needFace: this.needsFace, gate: null };
      if (this.passed) return out;
      const PM = root.PoseMatch;
      const relief = hands.length ? PM.smallHandRelief(hands, this.stages[0].hands, [vw, vh], this.stages[0].video) : 0;
      const lv = (STAGE_PASS[this.id] || {})[this.idx + 1];                      // staged: this frame's own level
      const stageDrop = lv != null ? PASS_LEVEL - lv : 0;
      const startDrop = (STAGE_PASS[this.id] || {})[1] != null ? PASS_LEVEL - STAGE_PASS[this.id][1] : 0;   // motion: the start pose is frame 1
      if (this.mode === 'motion') {
        let posOk;                                          // start-pose position gate (lonely: lips; other signs: recorded place on the face)
        if (this.track.phase === 'hold' && hands.length >= this.need && (this.faceStartOnly || this.posOn) && geom !== undefined) {
          const g = this.posOn ? root.FaceGate.posCheck(this.id, this.stages[0], hands, geom) : root.FaceGate.check(this.id, this.stages[0], hands, geom);
          if (g) { posOk = g.ok; out.gate = { state: g.state, ok: g.ok, away: false, zone: g.zone && g.zone.zone, pos: !!g.pos }; }
        }
        const m = this.track.update(now, hands, vw, vh, relief + startDrop, posOk);
        out.phase = m.phase;
        out.holdPct = Math.round(100 * m.holdMs / PM.MOTION.HOLD_MS);
        out.extentPct = m.extentNeed ? Math.min(100, Math.round(100 * m.extent / m.extentNeed)) : 0;
        out.similarity = m.shape;
        out.needDirection = m.needDirection;
        if (m.phase === 'done') { this.passed = true; out.passed = true; }
        return out;
      }
      if (hands.length < this.need) {
        if (!(this.need > 1 && this.since && now - this.lastFull <= DROP_GRACE_MS)) this.since = 0;   // a short drop of one hand does not restart the hold
        return out;
      }
      this.lastFull = now;
      const thr = PASS_LEVEL - relief - stageDrop;
      const t = this.stages[this.idx];
      const r = PM.comparePose(t.hands, hands, t.video, [vw, vh]);
      out.similarity = r ? r.overall : null;
      let gate = null;
      if (this.pairCfg && r && r.overall >= thr) {      // two-hand position rule (sick)
        gate = geom !== undefined ? root.FaceGate.checkPair(this.id, hands, geom) : root.FaceGate.geometricPair(this.id, hands, vh);
        out.gate = gate ? { state: gate.state, ok: gate.ok, away: false, pair: true, zone: null } : null;
      } else if (this.posOn && geom !== undefined && r && r.overall >= thr) {      // Session 36: generic position on the face
        gate = root.FaceGate.posCheck(this.id, t, hands, geom);
        out.gate = gate ? { state: gate.state, ok: gate.ok, away: false, pos: true, zone: null } : null;
      } else if (this.faceCfg && geom !== undefined && r && r.overall >= thr) {    // the hand shape fits: now the position on the face
        gate = root.FaceGate.check(this.id, t, hands, geom);
        out.gate = gate ? { state: gate.state, ok: gate.ok, away: !!gate.away, zone: gate.zone && gate.zone.zone } : null;
      }
      if (r && r.overall >= thr && !(gate && !gate.ok)) {
        this.lastGood = now;
        if (!this.since) this.since = now;
        out.holdPct = Math.min(100, Math.round(100 * (now - this.since) / HOLD_MS));
        if (now - this.since >= HOLD_MS) {
          this.idx++; this.since = 0; this.lastProgress = now;
          if (this.idx >= this.total) { this.passed = true; out.passed = true; out.idx = this.total; }
          else out.idx = this.idx;
        }
      } else if (this.since && now - this.lastGood <= DIP_GRACE_MS) {
        out.holdPct = Math.min(100, Math.round(100 * (now - this.since) / HOLD_MS));   // short dip: keep the hold running
      } else this.since = 0;
      if (this.idx > 0 && !this.passed && this.lastProgress && now - this.lastProgress > RESET_MS) { this.idx = 0; this.since = 0; this.lastProgress = 0; out.idx = 0; }
      return out;
    }
  }

  /** True when the recordings are loaded and the sign has a set of poses (one or two hands) we can check. */
  function supports(id) {
    const st = stagesOf(id);
    return !!st && (st[0].hands.length === 1 || st[0].hands.length === 2);
  }

  root.SignCheck = { load, supports, create: (id) => new SignChecker(id), PASS_LEVEL, HOLD_MS, DIP_GRACE_MS, RESET_MS, STAGE_PASS, stagesOf, _debugSigns: () => _bySign && Object.keys(_bySign) };
})(typeof window !== 'undefined' ? window : globalThis);
