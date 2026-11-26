(function (global) {

  // =============================================================
  // TIE_BREAKERS
  // =============================================================
  // Fingerpose scores finger curl + direction only, which cannot
  // distinguish some gesture pairs no matter how rules are tuned.
  // A tie-breaker is a direct geometry check on the raw 21 landmarks
  // that runs ONLY when two specific gestures are the top-scoring
  // candidates and too close to call.
  //
  // Register one:
  //
  //   TIE_BREAKERS.push({
  //     names: ['asl_m', 'asl_n'],
  //     resolve(landmarks) {
  //       // landmarks[i] = [x, y, z]
  //       return distanceIsCloserToRing ? 'asl_m' : 'asl_n';
  //     },
  //   });
  // =============================================================
  const TIE_BREAKERS = [];

  function dist(a, b) {
    const dx = a[0] - b[0], dy = a[1] - b[1], dz = (a[2] || 0) - (b[2] || 0);
    return Math.sqrt(dx * dx + dy * dy + dz * dz);
  }

  // =============================================================
  // MOTION_DETECTORS
  // =============================================================
  // Some ASL letters (J, Z) are strokes traced through the air, not
  // held poses. A motion detector looks at a short rolling history of
  // recent landmark snapshots and checks whether the relevant
  // fingertip's path matches the expected shape.
  //
  // Register one:
  //
  //   MOTION_DETECTORS.push({
  //     name: 'asl_j',
  //     restingCheck(landmarks) {
  //       // Direct geometric check on the FIRST frame of the history —
  //       // no dependency on the static pipeline's confirmation state.
  //       return looksRoughlyLikeI(landmarks);
  //     },
  //     detect(history) {
  //       // history = array of { landmarks, t }, oldest first.
  //       // Return true or { matched, detail } where detail is surfaced
  //       // via onDebugMotion for tracing failures.
  //       return tracedAJShape;
  //     },
  //   });
  //
  // restingCheck is a real gate: detect() is skipped entirely if it
  // returns false. Omit the field to run ungated.
  //
  // Motion detectors fire onGesture directly, bypassing the
  // consecutive-frame requirement (motion completes once, it is not a
  // pose to hold). Debounced per gesture so the same stroke in the
  // history buffer doesn't fire repeatedly.
  // =============================================================
  const MOTION_DETECTORS = [];

  // =============================================================
  // CUSTOM_GESTURES
  // =============================================================
  // Push fp.GestureDescription objects here. ASL alphabet gestures
  // live in js/gestures/asl-alphabet.js and push themselves in automatically.
  // =============================================================
  const CUSTOM_GESTURES = [];

  function buildDefaultGestures() {
    if (typeof fp === 'undefined') {
      return [];
    }

    const gestures = [];

    /* --------------------------------------------------------
       Add built-in gestures here if you want some always
       available regardless of which add-on files are loaded.
       Example:

       const openPalm = new fp.GestureDescription('open_palm');
       [fp.Finger.Thumb, ...].forEach((f) =>
         openPalm.addCurl(f, fp.FingerCurl.NoCurl, 1.0));
       gestures.push(openPalm);
       -------------------------------------------------------- */

    return gestures;
  }

  // Hand landmark connections — used only for drawing the skeleton on the
  // optional canvas overlay. Indices follow the 21-point MediaPipe layout
  // (0 = wrist, 4/8/12/16/20 = fingertips).
  const FINGER_CONNECTIONS = [
    [0, 1], [1, 2], [2, 3], [3, 4],        // thumb
    [0, 5], [5, 6], [6, 7], [7, 8],        // index
    [0, 9], [9, 10], [10, 11], [11, 12],   // middle
    [0, 13], [13, 14], [14, 15], [15, 16], // ring
    [0, 17], [17, 18], [18, 19], [19, 20], // pinky
  ];

  // =============================================================
  // HandTracker — keeps each hand's identity (id 1, 2, ...) from frame to
  // frame, so two hands can be followed even when they get close, cross or
  // one drops out for a moment. Used by GestureDetector when opts.onHands is
  // set; completely separate from the single-hand letter pipeline.
  //
  // How it works (all distances are measured in "hand sizes", where one hand
  // size = wrist to middle-finger knuckle in pixels, so it scales with how
  // far the person is from the camera):
  //   1. Duplicate rejection: two detections with almost the same palm centre
  //      are the model drawing two skeletons on ONE hand → keep the stronger.
  //   2. Each track predicts where its hand should be now (last position +
  //      velocity, with a short horizon).
  //   3. Assignment: a detection may only take over a track if it lies inside
  //      that track's movement cap (grows with elapsed time). Among the valid
  //      pairings the tracker maximises matches, then minimises total distance
  //      (+ a handedness penalty used as a tie-breaker; stronger while the two
  //      hands overlap, because position is ambiguous then).
  //   4. A track with no detection is held ("coasting") for holdMs, then freed.
  // =============================================================
  const HT_WRIST = 0, HT_MIDDLE_MCP = 9;
  const HT_PALM_POINTS = [0, 5, 9, 13, 17];

  class HandTracker {
    constructor(opts = {}) {
      this.maxHands      = opts.maxHands      ?? 2;
      this.holdMs        = opts.holdMs        ?? 600;  // keep a lost hand's identity this long
      this.capBase       = opts.capBase       ?? 1.6;  // movement cap (hand sizes) for a same-frame match
      this.capPerSec     = opts.capPerSec     ?? 6.0;  // extra cap per second since the hand was last seen
      this.dupDist       = opts.dupDist       ?? 0.35; // palm centres closer than this (hand sizes) = same hand
      this.overlapDist   = opts.overlapDist   ?? 1.0;  // tracks closer than this (hand sizes) count as overlapping
      this.predictHorizonS = opts.predictHorizonS ?? 0.12;
      this.reset();
    }

    reset() {
      this.tracks = [];
      this.stats = { frames: 0, overlapFrames: 0, duplicatesRejected: 0, strayRejected: 0, created: 0, replaced: 0, expired: 0 };
    }

    static _palmCentre(kps) {
      let x = 0, y = 0;
      for (const i of HT_PALM_POINTS) { x += kps[i].x; y += kps[i].y; }
      return { x: x / HT_PALM_POINTS.length, y: y / HT_PALM_POINTS.length };
    }
    static _size(kps) {
      return Math.max(8, Math.hypot(kps[HT_WRIST].x - kps[HT_MIDDLE_MCP].x, kps[HT_WRIST].y - kps[HT_MIDDLE_MCP].y));
    }
    static _hsign(handedness) { return handedness === 'Left' ? 1 : handedness === 'Right' ? -1 : 0; }

    /**
     * @param {Array} hands - raw estimateHands() output ({keypoints, keypoints3D, handedness, score})
     * @param {number} t    - timestamp in ms (performance.now())
     * @returns {{hands:Array, overlap:boolean, rawCount:number}}
     *   hands[i] = { id, handedness, score, keypoints, keypoints3D, centre, size, coasting, ageMs }
     */
    update(hands, t) {
      this.stats.frames++;
      const rawCount = hands.length;

      // 1. Build detections, drop incomplete ones, reject duplicate skeletons.
      let dets = hands
        .filter((h) => h.keypoints && h.keypoints.length >= 21)
        .map((h) => ({ h, c: HandTracker._palmCentre(h.keypoints), size: HandTracker._size(h.keypoints), score: h.score ?? 1 }))
        .sort((a, b) => b.score - a.score);
      const kept = [];
      for (const d of dets) {
        const dup = kept.some((k) => Math.hypot(k.c.x - d.c.x, k.c.y - d.c.y) < this.dupDist * Math.min(k.size, d.size));
        if (dup) this.stats.duplicatesRejected++; else kept.push(d);
      }
      dets = kept;

      // 2. Predict where each track's hand should be now.
      for (const tr of this.tracks) {
        const dt = Math.max(0, (t - tr.lastSeen) / 1000);
        const h  = Math.min(dt, this.predictHorizonS);
        tr.pred = { x: tr.c.x + tr.v.x * h, y: tr.c.y + tr.v.y * h };
        tr.cap  = tr.size * (this.capBase + this.capPerSec * Math.min(dt, 0.6));
      }

      // Overlap = any two tracks whose predicted centres are within overlapDist hand sizes.
      let overlap = false;
      for (let i = 0; i < this.tracks.length; i++) for (let j = i + 1; j < this.tracks.length; j++) {
        const a = this.tracks[i], b = this.tracks[j];
        if (Math.hypot(a.pred.x - b.pred.x, a.pred.y - b.pred.y) < this.overlapDist * Math.min(a.size, b.size)) overlap = true;
      }
      if (overlap) this.stats.overlapFrames++;
      const hsW = overlap ? 0.35 : 0.1; // handedness tie-break weight, in hand sizes (scaled by how consistent the track's label has been)

      // 3. Best assignment (tiny problem: ≤ maxHands tracks × ≤ maxHands detections → brute force).
      const nT = this.tracks.length, nD = dets.length;
      const pairCost = (ti, di) => {
        const tr = this.tracks[ti], d = dets[di];
        const dist = Math.hypot(tr.pred.x - d.c.x, tr.pred.y - d.c.y);
        if (dist > tr.cap) return Infinity;
        const sign = HandTracker._hsign(d.h.handedness);
        // Penalty only when the track's smoothed label is consistent (|hsign| near 1) and this detection disagrees.
        // A label that flips frame to frame (typical while hands cross) averages out to ~0 and is ignored.
        const mismatch = (sign !== 0 && Math.sign(tr.hsign) !== sign) ? Math.abs(tr.hsign) : 0;
        return dist / tr.size + hsW * mismatch;
      };
      let best = { matches: -1, cost: Infinity, map: [] };
      const used = new Array(nD).fill(false);
      const cur = new Array(nT).fill(-1);
      const recurse = (ti, matches, cost) => {
        if (ti === nT) {
          if (matches > best.matches || (matches === best.matches && cost < best.cost)) best = { matches, cost, map: cur.slice() };
          return;
        }
        for (let di = 0; di < nD; di++) {
          if (used[di]) continue;
          const c = pairCost(ti, di);
          if (!isFinite(c)) continue;
          used[di] = true; cur[ti] = di;
          recurse(ti + 1, matches + 1, cost + c);
          used[di] = false; cur[ti] = -1;
        }
        cur[ti] = -1;
        recurse(ti + 1, matches, cost);
      };
      recurse(0, 0, 0);

      // 4. Apply matches; hold or expire unmatched tracks; start/replace tracks for leftover detections.
      const matchedDet = new Set();
      this.tracks.forEach((tr, ti) => {
        const di = best.map[ti];
        if (di >= 0) {
          const d = dets[di]; matchedDet.add(di);
          const dt = (t - tr.lastSeen) / 1000;
          if (dt > 0.001) {
            const vx = (d.c.x - tr.c.x) / dt, vy = (d.c.y - tr.c.y) / dt;
            tr.v = { x: tr.v.x * 0.6 + vx * 0.4, y: tr.v.y * 0.6 + vy * 0.4 };
          }
          tr.c = d.c; tr.size = tr.size * 0.7 + d.size * 0.3;
          tr.hsign = tr.hsign * 0.8 + HandTracker._hsign(d.h.handedness) * 0.2;
          tr.lastSeen = t; tr.hand = d.h; tr.coasting = false;
        } else {
          tr.coasting = true;
        }
      });
      const before = this.tracks.length;
      this.tracks = this.tracks.filter((tr) => (t - tr.lastSeen) <= this.holdMs);
      this.stats.expired += before - this.tracks.length;

      dets.forEach((d, di) => {
        if (matchedDet.has(di)) return;
        const fresh = () => ({
          id: this._freeId(), c: d.c, size: d.size, v: { x: 0, y: 0 }, hsign: HandTracker._hsign(d.h.handedness),
          lastSeen: t, born: t, hand: d.h, coasting: false, pred: d.c, cap: d.size * this.capBase,
        });
        if (this.tracks.length < this.maxHands) {
          this.tracks.push(fresh()); this.stats.created++;
        } else {
          // All identities in use. If one is coasting (hand lost), the new detection is most likely
          // that hand reappearing somewhere unexpected → give it the longest-coasting identity.
          const coasters = this.tracks.filter((tr) => tr.coasting).sort((a, b) => a.lastSeen - b.lastSeen);
          if (coasters.length) {
            const idx = this.tracks.indexOf(coasters[0]);
            const old = this.tracks[idx];
            const nt = fresh(); nt.id = old.id; nt.born = old.born;
            this.tracks[idx] = nt; this.stats.replaced++;
          } else {
            this.stats.strayRejected++;
          }
        }
      });

      this.tracks.sort((a, b) => a.id - b.id);
      return {
        rawCount, overlap,
        hands: this.tracks.map((tr) => ({
          id: tr.id, handedness: tr.hand.handedness, score: tr.hand.score,
          keypoints: tr.hand.keypoints, keypoints3D: tr.hand.keypoints3D,
          centre: tr.c, size: tr.size, coasting: tr.coasting, ageMs: t - tr.born,
        })),
      };
    }

    _freeId() {
      for (let id = 1; id <= this.maxHands + 1; id++) if (!this.tracks.some((tr) => tr.id === id)) return id;
      return this.maxHands + 1;
    }
  }

  // =============================================================
  // GuideZones — fixed on-screen regions the learner has to put a hand in
  // (for position-dependent signs such as "sick": one hand at the forehead,
  // the other on the chest). No face/body model: the regions are drawn on
  // the camera view with a head-shaped guide, and the learner lines
  // themselves up with it.
  //
  // Coordinates are normalised (0..1) in DISPLAY space = what the learner
  // sees on the mirrored camera view, origin top-left. Raw landmark x is
  // converted with x_display = 1 - x_raw / videoWidth when `mirrored` is true.
  //
  // Zone: { id, label, x, y, w, h, shape?: 'rect'|'ellipse', anchor?: <landmark index> (default 12 = middle fingertip) }
  // Preset: { id, label, hint, requiredMs, requireDistinctHands, zones[], guides[] }
  //   guides[] are purely visual outlines: { shape:'ellipse', x, y, w, h, label }
  //
  // update(trackedHands, videoW, videoH, t) → { zones:[{id,label,occupants[],dwellMs,met}], satisfied, passedAt }
  //   - a zone is occupied while a live (not coasting) hand's anchor point is inside it
  //   - dwell counts continuous occupation; a gap shorter than graceMs does not reset it
  //   - satisfied = every zone has met requiredMs (and, if requireDistinctHands, by different hand ids)
  // =============================================================
  const GZ_PRESETS = {
    sick: {
      id: 'sick', label: 'sick (forehead + chest)',
      hint: 'One middle fingertip on your forehead (top box), the other hand\'s middle fingertip on your chest (lower box). Line your head up with the dashed oval.',
      requiredMs: 800, requireDistinctHands: true,
      guides: [{ shape: 'ellipse', x: 0.40, y: 0.14, w: 0.20, h: 0.36, label: 'head' }],
      zones: [
        { id: 'forehead', label: 'forehead', x: 0.36, y: 0.12, w: 0.28, h: 0.14, anchor: 12 },
        { id: 'chest',    label: 'chest',    x: 0.30, y: 0.62, w: 0.40, h: 0.22, anchor: 12 },
      ],
    },
    center: {
      id: 'center', label: 'single centre box (test)',
      hint: 'Hold a fingertip inside the box.',
      requiredMs: 800, requireDistinctHands: false, guides: [],
      zones: [{ id: 'box', label: 'box', x: 0.30, y: 0.28, w: 0.40, h: 0.44, anchor: 12 }],
    },
    halves: {
      id: 'halves', label: 'screen-left box + screen-right box (test)',
      hint: 'One fingertip in the box on the LEFT of the screen, the other hand in the box on the RIGHT of the screen.',
      requiredMs: 800, requireDistinctHands: true, guides: [],
      zones: [
        { id: 'left',  label: 'screen left',  x: 0.03, y: 0.20, w: 0.45, h: 0.58, anchor: 12 },
        { id: 'right', label: 'screen right', x: 0.52, y: 0.20, w: 0.45, h: 0.58, anchor: 12 },
      ],
    },
  };

  class GuideZones {
    constructor(opts = {}) {
      this.mirrored = opts.mirrored ?? true;
      this.graceMs  = opts.graceMs  ?? 150;
      this.preset   = null;
      this.state    = [];
      this.satisfied = false;
      this.passedAt  = null;
      if (opts.preset) this.setPreset(opts.preset);
    }

    static get PRESETS() { return GZ_PRESETS; }

    /** @param {string|Object|null} preset - a key of GuideZones.PRESETS, a preset object, or null to switch off */
    setPreset(preset) {
      this.preset = typeof preset === 'string' ? (GZ_PRESETS[preset] || null) : (preset || null);
      this.reset();
    }

    reset() {
      this.satisfied = false; this.passedAt = null;
      this.state = (this.preset ? this.preset.zones : []).map((z) => ({
        id: z.id, label: z.label, occupants: [], dwellMs: 0, met: false, metBy: null, _since: null, _lastIn: -Infinity,
      }));
    }

    static inside(z, px, py) {
      if (z.shape === 'ellipse') {
        const cx = z.x + z.w / 2, cy = z.y + z.h / 2;
        const nx = (px - cx) / (z.w / 2), ny = (py - cy) / (z.h / 2);
        return nx * nx + ny * ny <= 1;
      }
      return px >= z.x && px <= z.x + z.w && py >= z.y && py <= z.y + z.h;
    }

    /** Display-space (0..1) position of a landmark of a tracked hand. */
    toDisplay(kp, videoW, videoH) {
      const nx = kp.x / videoW, ny = kp.y / videoH;
      return { x: this.mirrored ? 1 - nx : nx, y: ny };
    }

    update(trackedHands, videoW, videoH, t) {
      if (!this.preset) return { zones: [], satisfied: false, passedAt: null };
      const live = (trackedHands || []).filter((h) => !h.coasting && h.keypoints && h.keypoints.length >= 21);
      const pz = this.preset.zones;

      pz.forEach((z, i) => {
        const st = this.state[i];
        const anchor = z.anchor ?? 12;
        st.occupants = live.filter((h) => {
          const p = this.toDisplay(h.keypoints[anchor], videoW, videoH);
          return GuideZones.inside(z, p.x, p.y);
        }).map((h) => h.id);

        if (st.occupants.length) {
          if (st._since == null) st._since = t;
          st._lastIn = t;
          st.dwellMs = t - st._since;
        } else if (t - st._lastIn > this.graceMs) {
          st._since = null; st.dwellMs = 0;
        } else if (st._since != null) {
          st.dwellMs = (st._lastIn - st._since); // inside the grace gap: frozen, not reset
        }
        st.met = st.dwellMs >= this.preset.requiredMs;
        st.metBy = st.met ? st.occupants.slice() : null;
      });

      let ok = this.state.length > 0 && this.state.every((s) => s.met);
      if (ok && this.preset.requireDistinctHands) {
        // need one different hand id per zone (small problem: try all assignments)
        const pools = this.state.map((s) => s.occupants);
        const used = new Set();
        const pick = (i) => {
          if (i === pools.length) return true;
          for (const id of pools[i]) {
            if (used.has(id)) continue;
            used.add(id);
            if (pick(i + 1)) return true;
            used.delete(id);
          }
          return false;
        };
        ok = pick(0);
      }
      if (ok && !this.satisfied) this.passedAt = t;
      if (!ok) this.passedAt = this.satisfied ? null : this.passedAt;
      this.satisfied = ok;
      return { zones: this.state.map((s) => ({ id: s.id, label: s.label, occupants: s.occupants.slice(), dwellMs: s.dwellMs, met: s.met })), satisfied: ok, passedAt: this.passedAt };
    }

    /** Draws guides and zones onto the (CSS-mirrored) overlay canvas. */
    draw(ctx, W, H, mirroredCanvas = true) {
      if (!this.preset) return;
      const toRaw = (z) => ({
        x: (this.mirrored ? 1 - z.x - z.w : z.x) * W, y: z.y * H, w: z.w * W, h: z.h * H,
      });
      const label = (txt, r, color) => {
        ctx.save();
        ctx.translate(r.x + r.w / 2, r.y + r.h + 16);
        if (mirroredCanvas) ctx.scale(-1, 1);
        ctx.font = 'bold 14px system-ui, sans-serif'; ctx.textAlign = 'center';
        ctx.lineWidth = 4; ctx.strokeStyle = 'rgba(0,0,0,.7)'; ctx.strokeText(txt, 0, 0);
        ctx.fillStyle = color; ctx.fillText(txt, 0, 0);
        ctx.restore();
      };
      const path = (shape, r) => {
        ctx.beginPath();
        if (shape === 'ellipse') ctx.ellipse(r.x + r.w / 2, r.y + r.h / 2, r.w / 2, r.h / 2, 0, 0, Math.PI * 2);
        else ctx.rect(r.x, r.y, r.w, r.h);
      };

      ctx.save();
      (this.preset.guides || []).forEach((g) => {
        const r = toRaw(g);
        ctx.setLineDash([8, 6]); ctx.lineWidth = 2; ctx.strokeStyle = 'rgba(255,255,255,.55)';
        path(g.shape, r); ctx.stroke();
        ctx.setLineDash([]);
        if (g.label) label(g.label, r, 'rgba(255,255,255,.75)');
      });
      this.preset.zones.forEach((z, i) => {
        const st = this.state[i]; const r = toRaw(z);
        const col = st && st.met ? '#58CC02' : (st && st.occupants.length ? '#FFD54A' : '#1CB0F6');
        path(z.shape, r);
        ctx.fillStyle = col + '33'; ctx.fill();
        ctx.lineWidth = 3; ctx.strokeStyle = col; ctx.stroke();
        // dwell progress bar along the bottom edge of the zone
        if (st && st.occupants.length && !st.met) {
          const frac = Math.min(1, st.dwellMs / this.preset.requiredMs);
          ctx.fillStyle = col; ctx.fillRect(r.x, r.y + r.h - 4, r.w * frac, 4);
        }
        label(z.label + (st && st.met ? ' ✓' : ''), r, col);
      });
      ctx.restore();
    }
  }

  // =============================================================
  // HandFeatures — turns one tracked hand (21 landmarks) into the numbers a
  // pose check would be built from, and describes how two hands relate. Pure
  // functions, no DOM, no model: used by the demo's pose recorder.
  //
  // Coordinate notes (important when reading recorded data):
  //  - landmarks2d: pixels of the RAW (not mirrored) video frame, origin top-left.
  //  - landmarks3d: MediaPipe keypoints3D. Metric, x/y like the image (x right, y down in
  //    the raw frame), z = depth relative to the hand's own centre. Each hand has its OWN
  //    origin, so 3D points of two different hands cannot be compared; across hands only
  //    2D is used.
  //  - palmFrame: landmarks in a hand-centred frame, divided by hand size: origin = wrist,
  //    y axis = wrist -> middle knuckle, z axis = palm normal, x = y cross z. Independent of
  //    where the hand is, how far it is, and how it is rotated in the image.
  //  - hand size = 3D distance wrist -> middle knuckle (size3d) / 2D pixels (size2d).
  //  - angles in degrees; a bend angle of 0 = straight finger.
  // =============================================================
  const HF_NAMES = [
    'WRIST',
    'THUMB_CMC', 'THUMB_MCP', 'THUMB_IP', 'THUMB_TIP',
    'INDEX_MCP', 'INDEX_PIP', 'INDEX_DIP', 'INDEX_TIP',
    'MIDDLE_MCP', 'MIDDLE_PIP', 'MIDDLE_DIP', 'MIDDLE_TIP',
    'RING_MCP', 'RING_PIP', 'RING_DIP', 'RING_TIP',
    'PINKY_MCP', 'PINKY_PIP', 'PINKY_DIP', 'PINKY_TIP',
  ];
  const HF_FINGERS = [
    { name: 'thumb',  idx: [1, 2, 3, 4] },
    { name: 'index',  idx: [5, 6, 7, 8] },
    { name: 'middle', idx: [9, 10, 11, 12] },
    { name: 'ring',   idx: [13, 14, 15, 16] },
    { name: 'pinky',  idx: [17, 18, 19, 20] },
  ];
  const HF_TIPS = [4, 8, 12, 16, 20];

  const hfRound = (n, d) => { const k = Math.pow(10, d); return Math.round(n * k) / k; };
  const hfSub   = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  const hfDot   = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const hfLen   = (a) => Math.sqrt(hfDot(a, a));
  const hfCross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const hfUnit  = (a) => { const l = hfLen(a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
  const hfAngle = (a, b) => {
    const l = (hfLen(a) * hfLen(b)) || 1;
    return Math.acos(Math.max(-1, Math.min(1, hfDot(a, b) / l))) * 180 / Math.PI;
  };
  const hfR3 = (a, d) => a.map((v) => hfRound(v, d));

  class HandFeatures {
    static get LANDMARK_NAMES() { return HF_NAMES.slice(); }

    /**
     * @param {Array<{x,y}>} kp2d  - 21 pixel keypoints
     * @param {Array<{x,y,z}>} kp3d - 21 metric keypoints (may be missing → 3D parts are null)
     * @returns {Object} features (see field names; all numbers rounded)
     */
    static compute(kp2d, kp3d) {
      const out = { landmarks2d: kp2d.map((k) => [hfRound(k.x, 1), hfRound(k.y, 1)]) };
      const xs = kp2d.map((k) => k.x), ys = kp2d.map((k) => k.y);
      const bbox = { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) };
      out.bbox2d = [hfRound(bbox.x0, 1), hfRound(bbox.y0, 1), hfRound(bbox.x1, 1), hfRound(bbox.y1, 1)];
      out.size2d = hfRound(Math.hypot(kp2d[9].x - kp2d[0].x, kp2d[9].y - kp2d[0].y), 1);
      out.palmCentre2d = [0, 5, 9, 13, 17].reduce((a, i) => [a[0] + kp2d[i].x / 5, a[1] + kp2d[i].y / 5], [0, 0]).map((v) => hfRound(v, 1));
      // Roll in the image: 0 = fingers point straight up, +90 = fingers point to the right of the raw frame.
      out.rollDeg = hfRound(Math.atan2(kp2d[9].x - kp2d[0].x, -(kp2d[9].y - kp2d[0].y)) * 180 / Math.PI, 1);

      if (!kp3d || kp3d.length < 21) { out.landmarks3d = null; return out; }
      const P = kp3d.map((k) => [k.x, k.y, k.z]);
      out.landmarks3d = P.map((v) => hfR3(v, 4));
      const size = hfLen(hfSub(P[9], P[0])) || 1e-6;
      out.size3d = hfRound(size, 4);

      // Palm frame
      const yAx = hfUnit(hfSub(P[9], P[0]));
      const nrm = hfUnit(hfCross(hfSub(P[5], P[0]), hfSub(P[17], P[0])));
      const xAx = hfUnit(hfCross(yAx, nrm));
      const zAx = hfCross(xAx, yAx);
      const toFrame = (v) => { const d = hfSub(v, P[0]); return [hfDot(d, xAx) / size, hfDot(d, yAx) / size, hfDot(d, zAx) / size]; };
      out.palmFrame = P.map((v) => hfR3(toFrame(v), 3));
      // Palm normal in the CAMERA frame. Its sign flips between left and right hands, so use together with the
      // handedness label (which itself may be swapped, see the left/right check): nz = how much the normal
      // points along the camera's depth axis.
      out.palmNormalCamera = hfR3(nrm, 3);

      // Fingers: bend per joint, reach, direction
      out.fingers = {};
      HF_FINGERS.forEach((f) => {
        const [a, b, c, d] = f.idx;
        const bones = [hfSub(P[a], P[0]), hfSub(P[b], P[a]), hfSub(P[c], P[b]), hfSub(P[d], P[c])];
        const bend = [hfAngle(bones[0], bones[1]), hfAngle(bones[1], bones[2]), hfAngle(bones[2], bones[3])];
        const dirCam = hfUnit(hfSub(P[d], P[a]));
        out.fingers[f.name] = {
          bendDeg: bend.map((v) => hfRound(v, 1)),            // [base joint, middle joint, tip joint]
          totalBendDeg: hfRound(bend[0] + bend[1] + bend[2], 1),
          reach: hfRound(hfLen(hfSub(P[d], P[0])) / size, 3), // wrist -> tip, in hand sizes
          straightGuess: f.name === 'thumb' ? (bend[1] < 25 && bend[2] < 25) : (bend[1] < 30 && bend[2] < 30),
          directionCamera: hfR3(dirCam, 3),                   // unit vector base-knuckle -> tip, camera frame
          directionPalm: hfR3([hfDot(dirCam, xAx), hfDot(dirCam, yAx), hfDot(dirCam, zAx)], 3),
        };
      });
      // Angle between neighbouring fingers (spread), degrees
      const dirs = HF_FINGERS.map((f) => hfSub(P[f.idx[3]], P[f.idx[0]]));
      out.spreadDeg = {
        thumb_index:  hfRound(hfAngle(dirs[0], dirs[1]), 1),
        index_middle: hfRound(hfAngle(dirs[1], dirs[2]), 1),
        middle_ring:  hfRound(hfAngle(dirs[2], dirs[3]), 1),
        ring_pinky:   hfRound(hfAngle(dirs[3], dirs[4]), 1),
      };
      // Fingertip distances in hand sizes: 5x5 tip-to-tip, and thumb tip to the other fingers' knuckles/palm
      out.tipDistances = HF_TIPS.map((i) => HF_TIPS.map((j) => hfRound(hfLen(hfSub(P[i], P[j])) / size, 3)));
      out.tipDistancesOrder = ['thumb', 'index', 'middle', 'ring', 'pinky'];
      const palm3 = [0, 5, 9, 13, 17].reduce((a, i) => [a[0] + P[i][0] / 5, a[1] + P[i][1] / 5, a[2] + P[i][2] / 5], [0, 0, 0]);
      out.tipToPalmCentre = HF_TIPS.map((i) => hfRound(hfLen(hfSub(P[i], palm3)) / size, 3));
      out.thumbTipTo = {
        index_mcp: hfRound(hfLen(hfSub(P[4], P[5])) / size, 3),
        middle_mcp: hfRound(hfLen(hfSub(P[4], P[9])) / size, 3),
        ring_mcp: hfRound(hfLen(hfSub(P[4], P[13])) / size, 3),
        pinky_mcp: hfRound(hfLen(hfSub(P[4], P[17])) / size, 3),
        index_pip: hfRound(hfLen(hfSub(P[4], P[6])) / size, 3),
        middle_pip: hfRound(hfLen(hfSub(P[4], P[10])) / size, 3),
      };
      return out;
    }

    /**
     * How two hands relate. Uses 2D pixels only (3D origins differ per hand) plus each hand's palm normal.
     * @param {Object} a - {id, features, handedness}   @param {Object} b - same
     * @param {number} videoW
     */
    static relation(a, b, videoW) {
      const fa = a.features, fb = b.features;
      const pa = fa.landmarks2d, pb = fb.landmarks2d;
      const avg = (fa.size2d + fb.size2d) / 2 || 1;
      const ca = fa.palmCentre2d, cb = fb.palmCentre2d;
      let best = { d: Infinity, ia: -1, ib: -1 };
      for (let i = 0; i < 21; i++) for (let j = 0; j < 21; j++) {
        const d = Math.hypot(pa[i][0] - pb[j][0], pa[i][1] - pb[j][1]);
        if (d < best.d) best = { d, ia: i, ib: j };
      }
      const tipTip = HF_TIPS.map((i) => HF_TIPS.map((j) => hfRound(Math.hypot(pa[i][0] - pb[j][0], pa[i][1] - pb[j][1]) / avg, 3)));
      const A = fa.bbox2d, B = fb.bbox2d;
      const iw = Math.max(0, Math.min(A[2], B[2]) - Math.max(A[0], B[0]));
      const ih = Math.max(0, Math.min(A[3], B[3]) - Math.max(A[1], B[1]));
      const inter = iw * ih;
      const areaA = (A[2] - A[0]) * (A[3] - A[1]), areaB = (B[2] - B[0]) * (B[3] - B[1]);
      const rel = {
        between: [a.id, b.id],
        palmCentreDistanceSizes: hfRound(Math.hypot(ca[0] - cb[0], ca[1] - cb[1]) / avg, 3),
        wristDistanceSizes: hfRound(Math.hypot(pa[0][0] - pb[0][0], pa[0][1] - pb[0][1]) / avg, 3),
        // vector from hand A to hand B in hand sizes, in the RAW frame (x right, y down). Raw x is the mirror of what
        // the learner sees: positive x = B is further to the learner's LEFT on a mirrored screen.
        vectorAtoB_sizes_rawFrame: [hfRound((cb[0] - ca[0]) / avg, 3), hfRound((cb[1] - ca[1]) / avg, 3)],
        closestLandmarkPair: { a: HF_NAMES[best.ia], b: HF_NAMES[best.ib], gapSizes: hfRound(best.d / avg, 3) },
        tipToTipSizes: tipTip,            // rows = hand A tips (thumb..pinky), columns = hand B tips
        bboxOverlapFracOfSmaller: hfRound(inter / (Math.min(areaA, areaB) || 1), 3),
        sizeRatioAoverB: hfRound(fa.size2d / (fb.size2d || 1), 3),
      };
      if (fa.palmNormalCamera && fb.palmNormalCamera) {
        rel.palmNormalsAngleDeg = hfRound(hfAngle(fa.palmNormalCamera, fb.palmNormalCamera), 1);
      }
      return rel;
    }
  }

  // =============================================================
  // GestureDetector
  // =============================================================
  class GestureDetector {
    /**
     * @param {Object} opts
     * @param {HTMLVideoElement}  opts.videoEl   - webcam video element (required)
     * @param {HTMLCanvasElement} [opts.canvasEl] - optional canvas for the hand skeleton overlay
     * @param {Array}  [opts.gestures]             - extra fp.GestureDescription objects (merged with CUSTOM_GESTURES + defaults)
     * @param {'lite'|'full'} [opts.modelType='full'] - MediaPipe Hands variant. 'full' is more accurate but slower.
     * @param {number} [opts.minConfidence=8.0]    - minimum Fingerpose score to consider a gesture a candidate
     * @param {number} [opts.minScoreGap=1.0]      - required lead over 2nd place to accept a match without a tie-breaker
     * @param {number} [opts.requiredConsecutiveFrames=10] - frames in a row a gesture must win before onGesture fires
     * @param {number} [opts.maxStreakMisses=2]    - off-frames tolerated mid-streak without resetting it
     * @param {number} [opts.motionHistoryFrames=30] - rolling history depth for motion gesture detection
     * @param {number} [opts.motionFreezeMs=1500]   - debounce/display window after a motion (J/Z) gesture fires
     * @param {number} [opts.detectionIntervalMs=0] - throttle between predictions; 0 = every animation frame
     * @param {function} [opts.onGesture]          - (gestureName, confidence) when a gesture is recognised
     * @param {function} [opts.onHandLost]         - called when no hand is detected in the current frame
     * @param {function} [opts.onLandmarks]        - (landmarks, handedness) every frame a hand is found
     * @param {function} [opts.onDebugScores]      - (sortedScores) every frame; every gesture's raw score before filtering
     * @param {function} [opts.onCandidate]        - ({name, score}|null) every frame, AFTER minConfidence/tie-breaker
     *                                                 resolution but BEFORE the requiredConsecutiveFrames streak gate —
     *                                                 use this (not onDebugScores) if you need to know what the engine
     *                                                 currently thinks the hand is showing, since onDebugScores is raw
     *                                                 Fingerpose curl/direction scoring and does NOT reflect TIE_BREAKERS
     *                                                 resolution for contested letter families (e.g. B/F/W).
     * @param {function} [opts.onDebugMotion]      - (motionDebugInfo) every frame motion gestures are checked
     * @param {number} [opts.motionRestingHoldMs=0] - if >0, the LIVE current-frame restingCheck must keep passing,
     *                                                 uninterrupted, for at least this many ms before detect() is
     *                                                 even attempted — closes the gap where a hand merely passing
     *                                                 through the resting shape mid-transition could let jitter over
     *                                                 the rest of the history buffer misread as a completed stroke.
     * @param {function} [opts.onMotionState]      - ({name, restingOk, motionMatched, restingHeldMs, restingReady})
     *                                                 every frame per motion detector. restingHeldMs/restingReady
     *                                                 reflect the LIVE continuous-hold gate above (restingReady is
     *                                                 always true when motionRestingHoldMs is 0, i.e. unset).
     * @param {number} [opts.maxHands=2]           - how many hands the model may return (passed explicitly to MediaPipe)
     * @param {function} [opts.onHands]            - (result) every frame when set: result = {hands, overlap, rawCount}; each hand =
     *                                                 {id, handedness, score, keypoints, keypoints3D, centre, size, coasting, ageMs,
     *                                                 gesture, gestureScore}. Ids stay with a hand across frames (see HandTracker).
     *                                                 Independent of onGesture/onCandidate, which still follow hands[0] only.
     * @param {GuideZones} [opts.guideZones]       - GuideZones instance: drawn on the overlay and updated every frame from the tracked hands
     *                                                 (turns on tracking even without onHands). Result is passed to onZones.
     * @param {function} [opts.onZones]            - (zoneResult) every frame when guideZones is set: {zones, satisfied, passedAt}
     * @param {boolean} [opts.drawLabels=false]    - draw the tracked id next to each hand (only when onHands is set)
     * @param {boolean} [opts.canvasMirrored=true] - the canvas is flipped with CSS scaleX(-1): un-flip label text so it reads correctly
     * @param {function} [opts.onError]            - (error) if model loading or webcam access fails
     */
    constructor(opts = {}) {
      if (!opts.videoEl) throw new Error('[GestureDetector] opts.videoEl is required');

      this.videoEl  = opts.videoEl;
      this.canvasEl = opts.canvasEl || null;
      this.ctx      = this.canvasEl ? this.canvasEl.getContext('2d') : null;

      this.minConfidence            = opts.minConfidence            ?? 8.0;
      this.minScoreGap              = opts.minScoreGap              ?? 1.0;
      this.detectionIntervalMs      = opts.detectionIntervalMs      ?? 0;
      this.requiredConsecutiveFrames = opts.requiredConsecutiveFrames ?? 10;
      this.maxStreakMisses          = opts.maxStreakMisses           ?? 2;
      this.motionHistoryFrames      = opts.motionHistoryFrames       ?? 30;
      this.enableMotionGestures     = opts.enableMotionGestures      ?? false;
      // Minimum continuous time (ms) the CURRENT frame must keep passing a motion
      // detector's restingCheck before detect() is even allowed to run for it.
      // 0 (default) preserves the old behaviour: any single frame in the oldest
      // third of the history buffer satisfies the gate, which is loose enough
      // that a hand merely passing through the resting shape mid-transition can
      // let ordinary jitter over the rest of the buffer misread as a stroke.
      // Set this (e.g. 500) to require a genuinely held, continuous resting pose
      // — checked frame-by-frame on the live hand, not the history buffer —
      // before a stroke can be recognised at all.
      this.motionRestingHoldMs      = opts.motionRestingHoldMs       ?? 0;

      this.onGesture      = opts.onGesture      || (() => {});
      this.onHandLost     = opts.onHandLost     || (() => {});
      this.onLandmarks    = opts.onLandmarks    || (() => {});
      this.onDebugScores  = opts.onDebugScores  || (() => {});
      this.onCandidate    = opts.onCandidate    || (() => {});
      this.onDebugMotion  = opts.onDebugMotion  || (() => {});
      this.onMotionState  = opts.onMotionState  || (() => {});
      this.onError        = opts.onError        || (() => {});
      this.onHands        = opts.onHands        || null;
      this.maxHands       = opts.maxHands       ?? 2;
      this.drawLabels     = opts.drawLabels     ?? false;
      this.canvasMirrored = opts.canvasMirrored ?? true;
      // The model assumes a selfie-mirrored picture; we feed it the raw frame, so its Left / Right label comes out swapped
      // (a left hand is labelled Right). flipHandedness: true swaps the label back (the demo uses it; the learner app does not use the label).
      this.flipHandedness = !!opts.flipHandedness;
      this.guideZones     = opts.guideZones     || null;
      this.onZones        = opts.onZones        || (() => {});
      this.tracker        = (this.onHands || this.guideZones) ? new HandTracker({ maxHands: this.maxHands }) : null;

      this.extraGestures = opts.gestures || [];
      this.modelType     = opts.modelType || 'full';

      this.detector          = null;
      this.estimator         = null;
      this.stream            = null;
      this.running           = false;
      this._rafId            = null;
      this._lastRunTime      = 0;
      this._frameInFlight    = false;
      this._lastGestureName  = null;
      this._candidateName    = null;
      this._candidateStreak  = 0;
      this._candidateMisses  = 0;
      this._missName         = null;

      this._landmarkHistory   = [];
      this._motionLastFired   = {};
      this._motionMatchedAt   = {};
      this._motionFiredAt     = 0;
      this._motionGestureName = null;

      // Tracks, per motion detector name, the performance.now() timestamp since
      // which the LIVE (current-frame) restingCheck has been passing without a
      // break, plus the last computed {restingHeldMs, restingReady} snapshot.
      // Separate from the history-buffer-based restingCheck sampling used inside
      // _checkMotionGestures/detect() below — this one gates whether a stroke is
      // allowed to be looked for at all.
      this._motionRestingSince = {};
      this._motionRestingInfo  = {};

      // Single freeze constant controls both the display hold and the
      // debounce window after a motion gesture fires. Configurable so the
      // app can align it with its own "freeze the pose" confirmation time
      // (e.g. 2000ms) for J/Z.
      this._motionFreezeMs   = opts.motionFreezeMs ?? 1500;
      this._motionDisplayMs  = this._motionFreezeMs;
    }

    /** Loads TF/MediaPipe Hands, builds the Fingerpose estimator, starts the webcam, begins the detection loop. */
    async start() {
      if (this.running) return;

      if (typeof tf === 'undefined' || typeof handPoseDetection === 'undefined') {
        const err = new Error('TensorFlow.js / hand-pose-detection scripts not found. Make sure they are loaded before gesture-detection.js — see the usage notes at the top of this file for the exact script tags needed.');
        this.onError(err);
        throw err;
      }

      try {
        await tf.ready();

        const model  = handPoseDetection.SupportedModels.MediaPipeHands;
        this.detector = await handPoseDetection.createDetector(model, {
          runtime:     'mediapipe',
          solutionPath: 'https://cdn.jsdelivr.net/npm/@mediapipe/hands',
          modelType:   this.modelType,
          maxHands:    this.maxHands,
        });

        const allGestures = [...buildDefaultGestures(), ...CUSTOM_GESTURES, ...this.extraGestures];
        this.estimator    = (typeof fp !== 'undefined')
          ? new fp.GestureEstimator(allGestures)
          : null;

        if (!this.estimator) {
          // Fingerpose (fp) not found — landmarks will still be detected,
          // but gestures will not be classified.
        }

        await this._setupWebcam();

        this.running = true;
        this._loop();
      } catch (err) {
        this.onError(err);
        throw err;
      }
    }

    /** Stops the detection loop and releases the webcam. */
    stop() {
      this.running = false;
      if (this._rafId) cancelAnimationFrame(this._rafId);
      this._rafId = null;
      if (this.stream) {
        this.stream.getTracks().forEach((track) => track.stop());
        this.stream = null;
      }
      this._landmarkHistory = [];
      this._motionRestingSince = {};
      this._motionRestingInfo  = {};
    }

    /** Adds a gesture at runtime (e.g. one the user just recorded). */
    addGesture(gestureDescription) {
      this.extraGestures.push(gestureDescription);
      if (typeof fp !== 'undefined') {
        const allGestures = [...buildDefaultGestures(), ...CUSTOM_GESTURES, ...this.extraGestures];
        this.estimator    = new fp.GestureEstimator(allGestures);
      }
    }

    /**
     * Picks the top-scoring gesture, requiring it to clearly beat the runner-up
     * by at least `minScoreGap`. On a close call, checks whether a registered
     * tie-breaker can resolve the ambiguity using raw landmark geometry.
     *
     * Uses a CONTENTION SET rather than top-2-only: every gesture scoring within
     * minScoreGap of the top is treated as "in contention." The tie-breaker with
     * the most of its own members present in the contention set is chosen — the
     * strongest signal for which family is genuinely contending right now.
     *
     * Gate: the TOP contention score must clear minConfidence before any
     * tie-breaker or contention logic runs. The resolved member's own score does
     * NOT need to independently clear minConfidence.
     *
     * Returns null when there is no confident winner.
     */
    _pickConfidentWinner(allScores, landmarks) {
      if (allScores.length === 0) return null;

      const sorted = [...allScores].sort((a, b) => b.score - a.score);
      const [first, second] = sorted;

      if (first.score < this.minConfidence) return null;
      if (second == null) return first;

      const gap = first.score - second.score;
      if (gap >= this.minScoreGap) return first;

      const contenders     = sorted.filter((g) => first.score - g.score < this.minScoreGap);
      const contenderNames = new Set(contenders.map((g) => g.name));

      let bestBreaker = null;
      let bestOverlap = 0;
      for (const tb of TIE_BREAKERS) {
        const overlap = tb.names.reduce((count, name) => count + (contenderNames.has(name) ? 1 : 0), 0);
        if (overlap >= 2 && overlap > bestOverlap) {
          bestBreaker = tb;
          bestOverlap = overlap;
        }
      }

      if (bestBreaker) {
        const resolvedName = bestBreaker.resolve(landmarks);
        const resolved     = sorted.find((g) => g.name === resolvedName && bestBreaker.names.includes(g.name));
        if (resolved) return resolved;
      }

      return null;
    }

    async _setupWebcam() {
      this.stream = await navigator.mediaDevices.getUserMedia({
        video: { width: 640, height: 480, facingMode: 'user' },
        audio: false,
      });
      this.videoEl.srcObject = this.stream;

      await new Promise((resolve) => {
        this.videoEl.onloadedmetadata = () => {
          this.videoEl.play();
          resolve();
        };
      });

      if (this.canvasEl) {
        this.canvasEl.width  = this.videoEl.videoWidth  || 640;
        this.canvasEl.height = this.videoEl.videoHeight || 480;
      }
    }

    _loop() {
      if (!this.running) return;

      const now       = performance.now();
      const dueForRun = now - this._lastRunTime >= this.detectionIntervalMs;

      if (dueForRun && !this._frameInFlight) {
        this._lastRunTime   = now;
        this._frameInFlight = true;
        // _detectFrame() is async — we don't await it here to avoid blocking
        // requestAnimationFrame scheduling. The _frameInFlight gate prevents
        // new detection calls from stacking up faster than they resolve.
        this._detectFrame().finally(() => {
          this._frameInFlight = false;
        });
      }

      this._rafId = requestAnimationFrame(() => this._loop());
    }

    /**
     * Converts keypoints3D ([{x,y,z,name}, ...]) into plain [x, y, z] arrays.
     * Fingerpose accepts either shape, but converting here keeps every tie-breaker
     * in asl-alphabet.js unchanged regardless of which landmark format the active
     * model produces.
     */
    _toLandmarkArray(keypoints3D) {
      return keypoints3D.map((kp) => [kp.x, kp.y, kp.z]);
    }

    async _detectFrame() {
      try {
        let hands = await this.detector.estimateHands(this.videoEl, { flipHorizontal: false });
        if (this.flipHandedness) hands = hands.map((h) => Object.assign({}, h, { handedness: h.handedness === 'Left' ? 'Right' : h.handedness === 'Right' ? 'Left' : h.handedness }));

        // Multi-hand tracking (only when the caller asked for it with onHands).
        let tracked = null;
        if (this.tracker) {
          tracked = this.tracker.update(hands, performance.now());
          this._classifyTracked(tracked);
          if (this.onHands) { try { this.onHands(tracked); } catch (e) { this.onError(e); } }
          if (this.guideZones) {
            const zr = this.guideZones.update(tracked.hands, this.videoEl.videoWidth || 640, this.videoEl.videoHeight || 480, performance.now());
            try { this.onZones(zr); } catch (e) { this.onError(e); }
          }
        }

        if (this.ctx) this._drawFrame(hands, tracked);

        if (hands.length === 0) {
          // If a motion gesture just fired and the hand drops out of frame
          // (common after J — single-finger shapes lose tracking), hold the
          // result during the display window rather than clearing immediately.
          const motionJustFiredOnLost = this._motionFiredAt && (performance.now() - this._motionFiredAt < this._motionDisplayMs);
          if (motionJustFiredOnLost) {
            // Hold result — don't call onHandLost yet.
          } else if (this._lastGestureName === this._motionGestureName && this._motionGestureName !== null) {
            // Display window expired while hand was absent — silently retire
            // so the static pipeline can take over without a blank flash.
            this._lastGestureName   = null;
            this._motionGestureName = null;
          } else if (this._lastGestureName !== null) {
            this._lastGestureName = null;
            this.onHandLost();
          }
          return;
        }

        const hand = hands[0];
        this._lastHandedness = hand.handedness;
        // keypoints3D can be undefined on low-confidence frames — treat as a
        // missed frame rather than crashing into onError.
        if (!hand.keypoints3D || hand.keypoints3D.length < 21) return;
        const landmarks = this._toLandmarkArray(hand.keypoints3D);
        this.onLandmarks(landmarks, hand.handedness);

        // Maintain the rolling landmark history for motion gesture detection.
        // Runs BEFORE _pickConfidentWinner so restingCheck sees _candidateName
        // as it stood at the END of the previous frame.
        if (this.enableMotionGestures) {
          this._landmarkHistory.push({ landmarks, t: performance.now() });
          if (this._landmarkHistory.length > this.motionHistoryFrames) {
            this._landmarkHistory.shift();
          }
          this._checkMotionGestures();
        }

        if (!this.estimator) return;

        // Pass threshold 0 so every gesture's raw score is visible in
        // onDebugScores — minConfidence is applied inside _pickConfidentWinner.
        const allScored    = this.estimator.estimate(landmarks, 0);
        const sortedScores = [...allScored.gestures].sort((a, b) => b.score - a.score);
        this.onDebugScores(sortedScores);

        const winner = this._pickConfidentWinner(sortedScores, landmarks);
        this.onCandidate(winner ? { name: winner.name, score: winner.score } : null);

        if (winner) {
          // Require the same gesture to win N frames in a row before firing —
          // smooths out single-frame misreads during transitions.
          //
          // Tolerance: allow maxStreakMisses off-frames mid-streak without
          // resetting. A sustained switch to a different gesture (same alternate
          // seen twice in a row) is treated as a real change, not noise.
          if (winner.name === this._candidateName) {
            this._candidateStreak++;
            this._candidateMisses = 0;
            this._missName        = null;
          } else if (winner.name === this._missName && this._candidateMisses >= 1) {
            // Same alternate twice in a row → real switch, not noise.
            this._candidateName   = winner.name;
            this._candidateStreak = 1;
            this._candidateMisses = 0;
            this._missName        = null;
          } else if (this._candidateName !== null && this._candidateMisses < this.maxStreakMisses) {
            // Forgive this off-frame — remember it in case it repeats.
            this._candidateMisses++;
            this._missName = winner.name;
          } else {
            this._candidateName   = winner.name;
            this._candidateStreak = 1;
            this._candidateMisses = 0;
            this._missName        = null;
          }

          if (this._candidateStreak >= this.requiredConsecutiveFrames && this._candidateName !== this._lastGestureName) {
            // Block the static pipeline from overwriting a motion gesture during
            // its display window — the user needs time to read the result.
            const inMotionDisplayWindow = this._motionGestureName !== null
              && this._motionFiredAt
              && (performance.now() - this._motionFiredAt < this._motionDisplayMs);
            if (!inMotionDisplayWindow) {
              this._lastGestureName = this._candidateName;
              this.onGesture(this._candidateName, winner.score);
            }
          }
        } else {
          // No confident winner. Maintain streak tolerance for the internal state
          // but handle the user-facing "hand lost" feedback separately.
          if (this._candidateName !== null && this._candidateMisses < this.maxStreakMisses) {
            this._candidateMisses++;
            this._missName = null;
          } else {
            this._candidateName   = null;
            this._candidateStreak = 0;
            this._candidateMisses = 0;
            this._missName        = null;
          }

          // After a motion gesture fires, hold the result for _motionDisplayMs.
          // Once the window expires, silently clear _lastGestureName so the static
          // pipeline can fire onGesture for the next confirmed letter without a
          // blank "—" flash in between.
          const motionJustFired = this._motionFiredAt && (performance.now() - this._motionFiredAt < this._motionDisplayMs);
          if (motionJustFired) {
            // Still in display window — hold the result.
          } else if (this._lastGestureName === this._motionGestureName && this._motionGestureName !== null) {
            // Display window expired — silently retire so the static pipeline can take over.
            this._lastGestureName   = null;
            this._motionGestureName = null;
          } else if (this._lastGestureName !== null) {
            this._lastGestureName = null;
            this.onHandLost();
          }
        }
      } catch (err) {
        this.onError(err);
      }
    }

    /**
     * Runs every registered MOTION_DETECTORS entry against the current
     * rolling landmark history, firing onGesture directly when a shape
     * is traced. Debounced per gesture to prevent the same completed
     * stroke from firing repeatedly while it remains in the history buffer.
     */
    _checkMotionGestures() {
      // Check debounce FIRST, before the history-length gate, so it is
      // visible in onDebugMotion even while the history buffer is refilling.
      const now = performance.now();
      this._motionLastFired = this._motionLastFired || {};
      const debouncedInfo  = [];
      let anyNotDebounced  = false;

      // LIVE continuous resting-hold tracking — checked against the single most
      // recent landmark frame (not the history buffer), every frame, regardless
      // of debounce state. This is what motionRestingHoldMs gates against: the
      // hand must keep passing restingCheck without interruption for that long
      // before a stroke can be looked for at all.
      const latestLandmarks = this._landmarkHistory.length
        ? this._landmarkHistory[this._landmarkHistory.length - 1].landmarks
        : null;
      MOTION_DETECTORS.forEach((detector) => {
        let currentResting = false;
        if (detector.restingCheck && latestLandmarks) {
          try { currentResting = !!detector.restingCheck(latestLandmarks); } catch (e) { currentResting = false; }
        }
        if (currentResting) {
          if (this._motionRestingSince[detector.name] === undefined) {
            this._motionRestingSince[detector.name] = now;
          }
        } else {
          delete this._motionRestingSince[detector.name];
        }
        const since         = this._motionRestingSince[detector.name];
        const restingHeldMs = since !== undefined ? (now - since) : 0;
        this._motionRestingInfo[detector.name] = {
          currentResting,
          restingHeldMs,
          restingReady: this.motionRestingHoldMs === 0 || restingHeldMs >= this.motionRestingHoldMs,
        };
      });

      MOTION_DETECTORS.forEach((detector) => {
        const lastFired = this._motionLastFired[detector.name];
        if (lastFired !== undefined && now - lastFired < this._motionFreezeMs) {
          // Run the resting check even while debounced — if the hand has changed
          // shape, the green hold should clear immediately.
          let restingNow = true;
          if (detector.restingCheck && this._landmarkHistory.length > 0) {
            try {
              restingNow = false;
              const checkFrames = Math.max(1, Math.floor(this._landmarkHistory.length / 3));
              for (let ri = 0; ri < checkFrames; ri++) {
                if (detector.restingCheck(this._landmarkHistory[ri].landmarks)) {
                  restingNow = true;
                  break;
                }
              }
            } catch (e) { restingNow = false; }
          }
          const recentlyMatched = restingNow
            && this._motionMatchedAt[detector.name] !== undefined
            && (now - this._motionMatchedAt[detector.name] < this._motionFreezeMs);
          const liveInfo = this._motionRestingInfo[detector.name] || { restingHeldMs: 0, restingReady: true };
          debouncedInfo.push({ name: detector.name, restingOk: restingNow, matched: false, debounced: true });
          this.onMotionState({
            name: detector.name,
            restingOk: restingNow,
            motionMatched: recentlyMatched,
            restingHeldMs: liveInfo.restingHeldMs,
            restingReady: liveInfo.restingReady,
          });
        } else {
          anyNotDebounced = true;
        }
      });

      if (!anyNotDebounced) {
        this.onDebugMotion(debouncedInfo);
        return;
      }

      if (this._landmarkHistory.length < this.motionHistoryFrames) {
        if (debouncedInfo.length) this.onDebugMotion(debouncedInfo);
        return;
      }

      // Check the oldest third of the history window for the resting pose.
      // If the signer moves quickly, the pre-stroke resting shape may have
      // scrolled out of frame 0 before detect() even runs. Sampling the oldest
      // ~10 frames and accepting if ANY passes gives the resting check the best
      // chance of finding the calm pre-stroke pose.
      const restingCheckFrames = Math.max(1, Math.floor(this._landmarkHistory.length / 3));
      const debugInfo          = [...debouncedInfo];

      MOTION_DETECTORS.forEach((detector) => {
        if (debouncedInfo.some((d) => d.name === detector.name)) return;

        // RESTING-POSE GATE: only run detect() while the hand was actually
        // starting from a plausible resting shape for that letter. Checked
        // directly against raw geometry, not against _candidateName, so it
        // runs every frame regardless of the static-pose pipeline's state.
        let restingOk = true;
        if (detector.restingCheck) {
          try {
            restingOk = false;
            for (let ri = 0; ri < restingCheckFrames; ri++) {
              if (detector.restingCheck(this._landmarkHistory[ri].landmarks)) {
                restingOk = true;
                break;
              }
            }
          } catch (err) {
            this.onError(err);
            restingOk = false;
          }
        }

        if (!restingOk) {
          debugInfo.push({ name: detector.name, restingOk: false, matched: false });
          // Fire motionMatched:false immediately — the hand has changed shape,
          // so the tag should clear right away rather than staying green.
          this.onMotionState({ name: detector.name, restingOk: false, motionMatched: false, restingHeldMs: 0, restingReady: false });
          return;
        }

        // RESTING-HOLD GATE: only look for a stroke once the LIVE hand has kept
        // passing restingCheck continuously for motionRestingHoldMs. Reports
        // restingOk:true (the shape is right) but matched:false while still
        // warming up, so the UI can show "keep holding" progress distinct from
        // "wrong shape entirely".
        const liveInfo = this._motionRestingInfo[detector.name] || { restingHeldMs: 0, restingReady: true };
        if (!liveInfo.restingReady) {
          debugInfo.push({ name: detector.name, restingOk: true, matched: false, restingHeldMs: liveInfo.restingHeldMs, restingReady: false });
          this.onMotionState({ name: detector.name, restingOk: true, motionMatched: false, restingHeldMs: liveInfo.restingHeldMs, restingReady: false });
          return;
        }

        let matched;
        let detail;
        try {
          const result = detector.detect(this._landmarkHistory);
          if (result && typeof result === 'object') {
            matched = !!result.matched;
            detail  = result.detail;
          } else {
            matched = !!result;
          }
        } catch (err) {
          this.onError(err);
          return;
        }

        debugInfo.push({ name: detector.name, restingOk: true, matched, detail });

        // Fire onMotionState every frame so the UI can track resting-pose state
        // independently of whether this frame actually matched.
        // motionMatched stays true for the full freeze window after a match so
        // the green tag remains visible during the display hold.
        const recentlyMatched = this._motionMatchedAt[detector.name] !== undefined
          && (now - this._motionMatchedAt[detector.name] < this._motionFreezeMs);
        this.onMotionState({
          name: detector.name,
          restingOk,
          motionMatched: !!matched || recentlyMatched,
          restingHeldMs: liveInfo.restingHeldMs,
          restingReady: true,
        });

        if (matched) {
          this._motionLastFired[detector.name]  = now;
          this._motionMatchedAt[detector.name]  = now;
          this._landmarkHistory                 = []; // clear so the same stroke can't fire again immediately

          // Reset the static pose pipeline so it can't overwrite the motion result
          // before the user has a chance to read it.
          this._candidateName   = null;
          this._candidateStreak = 0;
          this._candidateMisses = 0;
          this._missName        = null;

          this._lastGestureName  = detector.name;
          this._motionGestureName = detector.name;
          this._motionFiredAt    = now;

          this.onGesture(detector.name, 10); // motion gestures report max confidence
        }
      });

      this.onDebugMotion(debugInfo);
    }

    /** Runs the letter classifier on every tracked hand (same rules as the single-hand pipeline, no streak gate). */
    _classifyTracked(tracked) {
      for (const h of tracked.hands) {
        h.gesture = null; h.gestureScore = 0; h.allScores = null; h.poseData = null;
        if (h.coasting || !this.estimator || !h.keypoints3D || h.keypoints3D.length < 21) continue;
        const lm = this._toLandmarkArray(h.keypoints3D);
        const est = this.estimator.estimate(lm, 0);
        const scores = [...est.gestures].sort((a, b) => b.score - a.score);
        h.allScores = scores.map((g) => ({ name: g.name, score: g.score })); // every candidate, best first
        h.poseData  = est.poseData || null;                                   // Fingerpose per-finger [finger, curl, direction]
        const w = this._pickConfidentWinner(scores, lm);
        if (w) { h.gesture = w.name; h.gestureScore = w.score; }
      }
    }

    _drawFrame(hands, tracked) {
      const { ctx, canvasEl } = this;
      ctx.clearRect(0, 0, canvasEl.width, canvasEl.height);

      if (this.guideZones) this.guideZones.draw(ctx, canvasEl.width, canvasEl.height, this.canvasMirrored);

      if (hands.length === 0 && !(tracked && tracked.hands.length)) return;

      // Skeletons use 2D pixel-space keypoints (not keypoints3D) — these are
      // what actually line up with the video element on screen.
      // Without tracking (the app's normal mode): only hand 0, green/blue, exactly as before.
      // With tracking (onHands set): every tracked hand, coloured by its stable id.
      const PALETTE = [
        { line: '#58CC02', dot: '#1CB0F6' },
        { line: '#FF9600', dot: '#FF4B8B' },
        { line: '#B07CFF', dot: '#FFD54A' },
      ];
      const items = tracked
        ? tracked.hands.map((h) => ({ kps: h.keypoints, color: PALETTE[(h.id - 1) % PALETTE.length], h }))
        : hands.slice(0, 1).map((h) => ({ kps: h.keypoints, color: PALETTE[0], h: null }));

      items.forEach(({ kps, color, h }) => {
        if (!kps) return;
        ctx.save();
        if (h && h.coasting) ctx.globalAlpha = 0.35; // lost this frame, held by the tracker

        ctx.strokeStyle = color.line;
        ctx.lineWidth   = 3;
        FINGER_CONNECTIONS.forEach(([startIdx, endIdx]) => {
          const p1 = kps[startIdx];
          const p2 = kps[endIdx];
          ctx.beginPath();
          ctx.moveTo(p1.x, p1.y);
          ctx.lineTo(p2.x, p2.y);
          ctx.stroke();
        });

        ctx.fillStyle = color.dot;
        kps.forEach((kp) => {
          ctx.beginPath();
          ctx.arc(kp.x, kp.y, 4, 0, 2 * Math.PI);
          ctx.fill();
        });

        if (h && this.drawLabels) {
          const label = `#${h.id}${h.handedness ? ' ' + h.handedness[0] : ''}${h.coasting ? ' (held)' : ''}`;
          const w = kps[0];
          ctx.translate(w.x, w.y + 22);
          if (this.canvasMirrored) ctx.scale(-1, 1);
          ctx.font = 'bold 16px system-ui, sans-serif';
          ctx.textAlign = 'center';
          ctx.lineWidth = 4;
          ctx.strokeStyle = 'rgba(0,0,0,.75)';
          ctx.strokeText(label, 0, 0);
          ctx.fillStyle = color.line;
          ctx.fillText(label, 0, 0);
        }
        ctx.restore();
      });
    }
  }

  // =============================================================
  // EXPOSE GLOBALS
  // =============================================================
  global.GestureDetector  = GestureDetector;
  global.HandFeatures     = HandFeatures;     // derived hand numbers + two-hand relations (pose recorder)
  global.GuideZones       = GuideZones;       // fixed on-screen regions (see class comment)
  global.HandTracker      = HandTracker;      // multi-hand identity tracker (see class comment)
  global.CUSTOM_GESTURES  = CUSTOM_GESTURES;  // other files can push() new gestures
  global.TIE_BREAKERS     = TIE_BREAKERS;     // other files can register tie-breakers
  global.MOTION_DETECTORS = MOTION_DETECTORS; // other files can register motion detectors
  global.gestureDist      = dist;             // landmark distance helper for tie-breaker authors

})(typeof window !== 'undefined' ? window : this);
