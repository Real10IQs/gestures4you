(function () {
  if (typeof fp === 'undefined') {
    // Fingerpose (fp) not found — load fingerpose.min.js before this file. Skipping ASL gestures.
    return;
  }
  if (typeof CUSTOM_GESTURES === 'undefined' || typeof TIE_BREAKERS === 'undefined' || typeof MOTION_DETECTORS === 'undefined' || typeof gestureDist === 'undefined') {
    // gesture-detection.js globals not found — load it before this file. Skipping ASL gestures.
    return;
  }

  const { Finger, FingerCurl, FingerDirection } = fp;
  const NON_THUMB = [Finger.Index, Finger.Middle, Finger.Ring, Finger.Pinky];

  // Landmark indices (standard Handpose/MediaPipe layout):
  // 0 wrist | 1-4 thumb | 5-8 index | 9-12 middle | 13-16 ring | 17-20 pinky
  const THUMB_CMC = 1;
  const THUMB_TIP = 4;
  const INDEX_MCP = 5, INDEX_PIP = 6, INDEX_TIP = 8;
  const MIDDLE_MCP = 9, MIDDLE_PIP = 10, MIDDLE_TIP = 12;
  const RING_MCP = 13, RING_PIP = 14, RING_TIP = 16;
  const PINKY_MCP = 17, PINKY_TIP = 20;
  const WRIST = 0;

  // =============================================================
  // CURL / DIRECTION SHORTHAND HELPERS
  // =============================================================

  function curls(gesture, curlMap, weight = 1.0) {
    Object.entries(curlMap).forEach(([finger, curl]) => gesture.addCurl(Number(finger), curl, weight));
  }
  function directions(gesture, dirList, weight = 1.0) {
    dirList.forEach(([finger, dir]) => gesture.addDirection(finger, dir, weight));
  }

  // =============================================================
  // GEOMETRY HELPERS
  // =============================================================

  /** Wrist → middle-MCP distance, used to normalise all distance checks. */
  function palmSize(landmarks) {
    return gestureDist(landmarks[WRIST], landmarks[MIDDLE_MCP]) || 1e-6;
  }

  /**
   * Angle in degrees between the thumb's overall pointing direction
   * (CMC → tip) and the index finger's pointing direction (MCP → tip).
   * Captures the real geometric fact that separates L (≈ 90°) from G/Q
   * (roughly parallel) — Fingerpose's curl/direction rules cannot
   * measure an angle BETWEEN two fingers.
   */
  function thumbIndexAngleDeg(landmarks) {
    const thumbVec = [
      landmarks[THUMB_TIP][0] - landmarks[THUMB_CMC][0],
      landmarks[THUMB_TIP][1] - landmarks[THUMB_CMC][1],
      landmarks[THUMB_TIP][2] - landmarks[THUMB_CMC][2],
    ];
    const indexVec = [
      landmarks[INDEX_TIP][0] - landmarks[INDEX_MCP][0],
      landmarks[INDEX_TIP][1] - landmarks[INDEX_MCP][1],
      landmarks[INDEX_TIP][2] - landmarks[INDEX_MCP][2],
    ];
    const dot = thumbVec[0]*indexVec[0] + thumbVec[1]*indexVec[1] + thumbVec[2]*indexVec[2];
    const lenT = Math.sqrt(thumbVec[0]**2 + thumbVec[1]**2 + thumbVec[2]**2) || 1e-6;
    const lenI = Math.sqrt(indexVec[0]**2 + indexVec[1]**2 + indexVec[2]**2) || 1e-6;
    const cos = Math.max(-1, Math.min(1, dot / (lenT * lenI)));
    return Math.acos(cos) * (180 / Math.PI);
  }

  // ------------------------------------------------------------
  // ROTATION-ROBUST PALM-FRAME GEOMETRY
  //
  // Several letters (D, K, P, Q) were previously split by raw
  // camera-Y comparisons like landmarks[INDEX_TIP][1] > landmarks[INDEX_MCP][1].
  // That only means "points toward the bottom of the camera frame" —
  // it breaks the moment the hand or camera is rotated. The fix:
  // build a coordinate frame from the HAND ITSELF and measure
  // finger directions against that frame instead.
  // ------------------------------------------------------------

  function vSub(a, b) { return [a[0]-b[0], a[1]-b[1], a[2]-b[2]]; }
  function vCross(a, b) { return [a[1]*b[2]-a[2]*b[1], a[2]*b[0]-a[0]*b[2], a[0]*b[1]-a[1]*b[0]]; }
  function vDot(a, b) { return a[0]*b[0] + a[1]*b[1] + a[2]*b[2]; }
  function vLen(a) { return Math.sqrt(vDot(a, a)) || 1e-6; }
  function vNorm(a) { const l = vLen(a); return [a[0]/l, a[1]/l, a[2]/l]; }
  function vAngleDeg(a, b) {
    const cos = Math.max(-1, Math.min(1, vDot(vNorm(a), vNorm(b))));
    return Math.acos(cos) * (180 / Math.PI);
  }

  /**
   * A coordinate frame built from the hand's own landmarks.
   * `up` points from the wrist toward the middle knuckle, rotating with the hand,
   * making direction checks built on it rotation-robust.
   */
  function palmFrame(landmarks) {
    const up = vNorm(vSub(landmarks[MIDDLE_MCP], landmarks[WRIST]));
    const across = vSub(landmarks[PINKY_MCP], landmarks[INDEX_MCP]);
    const normal = vNorm(vCross(up, across));
    return { up, normal };
  }

  /**
   * True if the given fingertip points the same general way as the palm's own
   * "up" axis — rotation-robust replacement for a raw camera-Y up/down check.
   */
  function pointsPalmUp(landmarks, mcpIndex, tipIndex) {
    const frame = palmFrame(landmarks);
    const v = vSub(landmarks[tipIndex], landmarks[mcpIndex]);
    return vDot(vNorm(v), frame.up) > 0;
  }

  /**
   * How far a fingertip reaches from its base knuckle, as a fraction of palm
   * size. Looser than straightness below — a hooked finger (X) still has
   * meaningful reach even though it is bent.
   */
  function fingerReach(landmarks, mcpIndex, tipIndex) {
    return gestureDist(landmarks[mcpIndex], landmarks[tipIndex]) / palmSize(landmarks);
  }

  /**
   * How straight an already-extended finger is: 1.0 means the MCP→TIP
   * straight-line distance equals the actual MCP→PIP→TIP path length
   * (all three points collinear). Lower values indicate bending.
   */
  function fingerStraightness(landmarks, mcpIndex, pipIndex, tipIndex) {
    const mcpToTip = gestureDist(landmarks[mcpIndex], landmarks[tipIndex]);
    const mcpToPip = gestureDist(landmarks[mcpIndex], landmarks[pipIndex]);
    const pipToTip = gestureDist(landmarks[pipIndex], landmarks[tipIndex]);
    return mcpToTip / ((mcpToPip + pipToTip) || 1e-6);
  }

  /**
   * Angle in degrees between two fingers' own pointing directions (MCP → TIP
   * vectors) — the real geometric spread, independent of camera distance.
   */
  function fingerSpreadDeg(landmarks, mcpA, tipA, mcpB, tipB) {
    return vAngleDeg(vSub(landmarks[tipA], landmarks[mcpA]), vSub(landmarks[tipB], landmarks[mcpB]));
  }

  const letters = [];

  // =============================================================
  // GROUP 1: CLOSED FIST — A, E, M, N, S, T
  // =============================================================
  // All six share a fully-curled fist with the thumb somewhere in
  // front of or beside the fingers. The curl rules below are
  // necessarily ambiguous between them; resolved by the tie-breaker
  // using exact thumb-tip position relative to specific knuckles.
  // =============================================================

  /**
   * Base fist gesture shared by A, E, M, N, S, T.
   * Thumb accepts both FullCurl and HalfCurl to avoid score caps —
   * it is physically impossible to fully curl a real thumb the way
   * FullCurl technically describes, so a FullCurl-only rule scores
   * every real fist below a perfect 10.
   */
  function fistGesture(name) {
    const g = new fp.GestureDescription(name);
    curls(g, {
      [Finger.Index]:  FingerCurl.FullCurl,
      [Finger.Middle]: FingerCurl.FullCurl,
      [Finger.Ring]:   FingerCurl.FullCurl,
      [Finger.Pinky]:  FingerCurl.FullCurl,
    }, 1.0);
    g.addCurl(Finger.Thumb, FingerCurl.FullCurl, 1.0);
    g.addCurl(Finger.Thumb, FingerCurl.HalfCurl, 1.0);
    return g;
  }
  const A = fistGesture('asl_a'); letters.push(A);
  const E = fistGesture('asl_e'); letters.push(E);
  const M = fistGesture('asl_m'); letters.push(M);
  const N = fistGesture('asl_n'); letters.push(N);
  const S = fistGesture('asl_s'); letters.push(S);
  const T = fistGesture('asl_t'); letters.push(T);

  /* Tie-breaker: A / E / M / N / S / T
     Picks between the six fist letters using thumb-tip proximity
     to specific front knuckles/fingertips.

     Resolution order:
       E  — thumb tip is low, near the fingertip line (smallest toIndexTip).
       A vs T — both land nearest the index PIP, split by distance to the
                 index TIP: T's thumb pokes through near the tip; A's sits
                 back at the knuckle. Threshold 0.50.
       M  — nearest knuckle is ring, by a real margin (>0.05 over middle) —
             guards against frame jitter flipping M↔N.
       S vs N — both land nearest the middle knuckle. S wraps the thumb
                 broadly (small index-to-middle PIP gap); N wedges more
                 narrowly (bigger gap). Threshold 0.08.

     Verified against real captures + 2000-trial ±20% jitter testing. */
  TIE_BREAKERS.push({
    names: ['asl_a', 'asl_e', 'asl_m', 'asl_n', 'asl_s', 'asl_t'],
    resolve(landmarks) {
      const size = palmSize(landmarks);
      const thumbTip  = landmarks[THUMB_TIP];
      const indexPip  = landmarks[INDEX_PIP];
      const middlePip = landmarks[MIDDLE_PIP];
      const ringPip   = landmarks[RING_PIP];

      const toIndexPip  = gestureDist(thumbTip, indexPip)  / size;
      const toMiddlePip = gestureDist(thumbTip, middlePip) / size;
      const toRingPip   = gestureDist(thumbTip, ringPip)   / size;
      const toIndexTip  = gestureDist(thumbTip, landmarks[INDEX_TIP]) / size;

      // E: thumb near the fingertip line rather than the knuckle line.
      if (toIndexTip < 0.35 && toIndexTip < toIndexPip) return 'asl_e';

      const closestFrontKnuckle = Math.min(toIndexPip, toMiddlePip, toRingPip);

      // A vs T: index PIP clearly closest (by ≥0.05 margin over middle).
      // If the index lead is too narrow, fall through to S/N check.
      if (toIndexPip === closestFrontKnuckle && (toMiddlePip - toIndexPip) >= 0.05) {
        if (toIndexTip > 0.50) return 'asl_a';
        return 'asl_t';
      }

      // M: ring PIP clearly closest (by >0.05 over middle).
      if (toRingPip < toMiddlePip - 0.05) return 'asl_m';

      // S vs N: S wraps broadly (small gap), N wedges narrowly (large gap).
      const gap = toIndexPip - toMiddlePip;
      if (gap < 0.08) return 'asl_s';
      return 'asl_n';
    },
  });

  // =============================================================
  // GROUP 2: TWO FINGERS UP — R, U, V
  // =============================================================
  // All three: index + middle extended, ring + pinky curled.
  // Disambiguated by resolveExtendedFamily near the end of this file.
  // =============================================================

  /**
   * Base two-fingers-up gesture shared by R, U, V.
   * Thumb accepts both FullCurl and HalfCurl for the same reason as fistGesture.
   */
  function twoFingersUpGesture(name) {
    const g = new fp.GestureDescription(name);
    curls(g, {
      [Finger.Index]:  FingerCurl.NoCurl,
      [Finger.Middle]: FingerCurl.NoCurl,
      [Finger.Ring]:   FingerCurl.FullCurl,
      [Finger.Pinky]:  FingerCurl.FullCurl,
    }, 1.0);
    g.addCurl(Finger.Thumb, FingerCurl.FullCurl, 1.0);
    g.addCurl(Finger.Thumb, FingerCurl.HalfCurl, 1.0);
    directions(g, [
      [Finger.Index,  FingerDirection.VerticalUp],
      [Finger.Middle, FingerDirection.VerticalUp],
    ], 0.7);
    return g;
  }
  const R = twoFingersUpGesture('asl_r'); letters.push(R);
  const U = twoFingersUpGesture('asl_u'); letters.push(U);
  const V = twoFingersUpGesture('asl_v'); letters.push(V);

  // =============================================================
  // GROUP 3: SIDEWAYS POINTING — G, H
  // =============================================================
  // G: index points sideways, thumb alongside, others curled.
  // H: index + middle together pointing sideways, others curled.
  // Disambiguated by resolveExtendedFamily below.
  // =============================================================

  const G = new fp.GestureDescription('asl_g');
  curls(G, {
    [Finger.Thumb]:  FingerCurl.NoCurl,
    [Finger.Index]:  FingerCurl.NoCurl,
    [Finger.Middle]: FingerCurl.FullCurl,
    [Finger.Ring]:   FingerCurl.FullCurl,
    [Finger.Pinky]:  FingerCurl.FullCurl,
  }, 1.0);
  letters.push(G);

  const H = new fp.GestureDescription('asl_h');
  curls(H, {
    [Finger.Thumb]:  FingerCurl.HalfCurl,
    [Finger.Index]:  FingerCurl.NoCurl,
    [Finger.Middle]: FingerCurl.NoCurl,
    [Finger.Ring]:   FingerCurl.FullCurl,
    [Finger.Pinky]:  FingerCurl.FullCurl,
  }, 1.0);
  letters.push(H);

  // =============================================================
  // GROUP 4: D vs Z
  // =============================================================
  // D: index straight up, thumb touches middle finger, rest curled.
  // Z: NOT a static pose — it's a Z drawn in the air with the index
  //    finger. asl_z is defined with D's resting shape; the tie-breaker
  //    always resolves to D for any held pose. True Z detection happens
  //    via MOTION_DETECTORS below.
  // =============================================================

  // D's index has no direction constraint — Fingerpose's direction scoring
  // measures against fixed camera axes and penalises a real D held at any
  // rotation other than dead-on vertical (confirmed by user report: "D not
  // work — on side way"). The D/Q split is handled entirely by
  // resolveExtendedFamily using palm-relative geometry.
  const D = new fp.GestureDescription('asl_d');
  D.addCurl(Finger.Index, FingerCurl.NoCurl, 1.0);
  // Middle/ring/pinky form the rounded back of the D circle — they measure
  // as HalfCurl on real hands (fingers partially open, not tight fist).
  // FullCurl is the primary category; HalfCurl at 0.85 gives credit to
  // the real circle-curved D shape without penalising a tightly-held one.
  D.addCurl(Finger.Middle, FingerCurl.FullCurl, 1.0);
  D.addCurl(Finger.Middle, FingerCurl.HalfCurl, 0.85);
  D.addCurl(Finger.Ring,   FingerCurl.FullCurl, 1.0);
  D.addCurl(Finger.Ring,   FingerCurl.HalfCurl, 0.85);
  D.addCurl(Finger.Pinky,  FingerCurl.FullCurl, 1.0);
  D.addCurl(Finger.Pinky,  FingerCurl.HalfCurl, 0.85);
  // Thumb touches the middle finger in a real D; exact curl varies by
  // hand size and camera angle, so accept HalfCurl (primary) and NoCurl (fallback).
  D.addCurl(Finger.Thumb, FingerCurl.HalfCurl, 1.0);
  D.addCurl(Finger.Thumb, FingerCurl.NoCurl,   0.8);
  letters.push(D);

  const Z = new fp.GestureDescription('asl_z');
  curls(Z, {
    [Finger.Thumb]:  FingerCurl.HalfCurl,
    [Finger.Index]:  FingerCurl.NoCurl,
    [Finger.Middle]: FingerCurl.FullCurl,
    [Finger.Ring]:   FingerCurl.FullCurl,
    [Finger.Pinky]:  FingerCurl.FullCurl,
  }, 1.0);
  // Horizontal direction for the index finger scores well for the Z resting
  // (sideways hold) without conflicting with D/L/G/Q's upright rules.
  directions(Z, [[Finger.Index, FingerDirection.HorizontalLeft]],  0.9);
  directions(Z, [[Finger.Index, FingerDirection.HorizontalRight]], 0.9);
  // Z is motion-only — not pushed to CUSTOM_GESTURES so it never appears
  // in static Fingerpose scoring. The GestureDescription object is kept
  // because the motion detector's restingCheck uses its geometry.

  /* Tie-breaker: D / Z
     Z is motion-only and no longer in the static pipeline. Any residual
     asl_z score is always redirected to D. */
  TIE_BREAKERS.push({
    names: ['asl_d', 'asl_z'],
    resolve(landmarks) {
      return 'asl_d';
    },
  });

  // =============================================================
  // Z MOTION DETECTION — resting check
  // =============================================================
  // Z's resting shape is a relaxed pointing gesture (index clearly
  // more extended than the other fingers), with no specific thumb
  // requirement. The check is intentionally loose — it only needs to
  // rule out a flat open hand or a closed fist; the detect() function
  // below still has to confirm the actual zigzag path on top of this.
  //
  // Guards (in order of addition):
  //   • indexReach > 0.70      — blocks X's hooked index
  //   • gap(index−middle) > 0.25 — blocks D (gap ≈ 0.10)
  //   • gap(index−ring/pinky) > 0.07 — general isolation
  //   • thumbToMiddlePip < 0.5 — blocks L (thumb too far out)
  //   • thumbToIndexPip  > 0.35 — blocks G (thumb against index knuckle)
  //
  // A previous round of fixes added an "index tilt off the palm's own
  // 'up' axis" guard here, tuned first to 40°, then to 20°, on the
  // theory that a real Z-start lean is measurably more sideways than an
  // upright D. That theory doesn't hold up: a genuine captured Z-start
  // attempt still failed the check even at 20° (index reach 0.790,
  // every other guard above passing comfortably), because in practice
  // people start Z from close to the same near-vertical index position
  // as D — the two are legitimately indistinguishable from a single
  // still frame, at any threshold. That's why this guard kept getting
  // reported as "too strict" no matter how far it was loosened.
  //
  // Fix, part 1: stop trying to separate D from Z-start by index tilt —
  // that's genuinely not a reliable signal (see above). detect() below
  // still requires an actual two-reversal zigzag path before a Z ever
  // fires, so it was tempting to leave D/Z fully unseparated here and
  // rely on that. But real-world reports say otherwise: users can hold
  // a genuine static D long enough to spuriously arm "waiting for Z",
  // and the theory at the time was that the visual difference is in
  // thumb position: D's thumb tip touching the fingertips (short
  // thumb-to-tip distance) vs. Z-rest's thumb lying back over the
  // knuckles (longer thumb-to-tip distance). That led to a
  // `touchesAFingerTip()` guard (thumb-to-middle/ring/pinky-TIP
  // distance < 0.4) added to this function.
  //
  // REMOVED this round — real captured numbers contradict the theory
  // outright, not just the threshold. A genuine D sample had
  // thumb-to-middle-tip = 0.624; two separate genuine Z-rest samples
  // had 0.393 and 0.341 — Z's thumb was measurably CLOSER to the
  // fingertip than D's, the opposite of what the guard assumed. Both
  // Z-rest samples were failing `resting check` for no reason other
  // than this guard (< 0.4) firing on them. Meanwhile the D sample was
  // already correctly rejected by the pre-existing guards below on
  // their own (indexReach - middleReach was only 0.017, nowhere near
  // the required > 0.25) — this guard wasn't even doing the job it was
  // added for. Net effect: it only ever blocked genuine Z, never
  // caught a D the other guards didn't already catch. If a real D
  // still leaks through as Z-resting in the future, look for a
  // DIFFERENT geometric signal and validate it against captured
  // numbers from both letters (not just one) before adding a guard —
  // this is now the third D/Z shape guard (after index-tilt, then
  // fingertip-distance) that didn't survive contact with real data.
  // =============================================================

  function looksLikePointing(landmarks) {
    const indexReach  = fingerReach(landmarks, INDEX_MCP,  INDEX_TIP);
    const middleReach = fingerReach(landmarks, MIDDLE_MCP, MIDDLE_TIP);
    const ringReach   = fingerReach(landmarks, RING_MCP,   RING_TIP);
    const pinkyReach  = fingerReach(landmarks, PINKY_MCP,  PINKY_TIP);
    const thumbToMiddlePip = gestureDist(landmarks[THUMB_TIP], landmarks[MIDDLE_PIP]) / (gestureDist(landmarks[WRIST], landmarks[MIDDLE_MCP]) || 1e-6);
    const thumbToIndexPip  = gestureDist(landmarks[THUMB_TIP], landmarks[INDEX_PIP])  / (gestureDist(landmarks[WRIST], landmarks[MIDDLE_MCP]) || 1e-6);
    return indexReach > 0.70
      && indexReach - middleReach > 0.25
      && indexReach - ringReach   > 0.07
      && indexReach - pinkyReach  > 0.07
      && thumbToMiddlePip < 0.5
      && thumbToIndexPip  > 0.35;
  }

  // =============================================================
  // SHARED MOTION HELPER — findStrokeSegments
  // =============================================================
  /**
   * Finds direction-reversal segments in a fingertip path along one axis.
   *
   * @param {Array}  path       — array of [x,y,z] landmark positions, oldest first
   * @param {number} axis       — 0 for X (Z's horizontal zigzag), 1 for Y (J's hook)
   * @param {number} minVel     — minimum net axis displacement to establish a direction
   * @param {number} minSegMove — minimum net 3D displacement for a segment to count
   * @returns {Array} segments  — [{ start, end, delta }, ...], consecutive segments
   *                              always have opposite-sign deltas
   *
   * Uses a "running extreme" approach: a direction is established once the path
   * has moved minVel worth of net axis distance from the segment start (can
   * accumulate over many small frames). A reversal fires once the path pulls back
   * from that extreme by minVel, and the segment itself covers minSegMove of real
   * net 3D travel. This is robust to both fast jerky strokes and slow smooth ones.
   */
  function findStrokeSegments(path, axis, minVel, minSegMove) {
    const segments = [];
    let segStart   = 0;
    let segDir     = 0;      // 0 = direction not yet established
    let extremeIdx = 0;      // index of the furthest axis value reached since segStart

    for (let i = 1; i < path.length; i++) {
      if (segDir === 0) {
        const d = path[i][axis] - path[segStart][axis];
        if (Math.abs(d) >= minVel) {
          segDir     = Math.sign(d);
          extremeIdx = i;
        }
        continue;
      }

      const curVal     = path[i][axis];
      const extremeVal = path[extremeIdx][axis];
      const stillExtending = segDir > 0 ? curVal >= extremeVal : curVal <= extremeVal;

      if (stillExtending) {
        extremeIdx = i;
        continue;
      }

      // Pulled back from the extreme — only count as a real reversal once
      // the pullback itself clears minVel (otherwise it's just noise wobble).
      const pullback = Math.abs(curVal - extremeVal);
      if (pullback < minVel) continue;

      const netDist = gestureDist(path[extremeIdx], path[segStart]);
      if (netDist >= minSegMove) {
        segments.push({ start: segStart, end: extremeIdx, delta: path[extremeIdx][axis] - path[segStart][axis] });
        segStart   = extremeIdx;
        segDir     = Math.sign(curVal - path[segStart][axis]) || -segDir;
        extremeIdx = i;
      }
      // If netDist < minSegMove, the run-up was too small — leave state as-is
      // so a genuine stroke isn't derailed by one early wobble.
    }

    // Close the final open segment.
    const lastIdx = path.length - 1;
    if (segDir !== 0) {
      const finalNetDist = gestureDist(path[lastIdx], path[segStart]);
      if (finalNetDist >= minSegMove) {
        segments.push({ start: segStart, end: lastIdx, delta: path[lastIdx][axis] - path[segStart][axis] });
      }
    }

    return segments;
  }

  // =============================================================
  // Z MOTION DETECTOR
  // =============================================================
  // Z = index fingertip zigzags horizontally: right→left→right (or mirror).
  // Requires at least 3 segments with alternating horizontal directions and
  // sufficient horizontal extent per segment.
  // =============================================================

  MOTION_DETECTORS.push({
    name: 'asl_z',
    restingCheck: looksLikePointing,
    detect(history) {
      const size      = palmSize(history[history.length - 1].landmarks);
      const indexPath = history.map((h) => h.landmarks[INDEX_TIP]);

      // minVel: minimum net axis movement to establish a direction (≥ jitter floor).
      // minSegMove: minimum net 3D displacement per segment.
      const minVel     = size * 0.02;
      const minSegMove = size * 0.02;
      const segs       = findStrokeSegments(indexPath, 0, minVel, minSegMove);

      // Per-segment X-delta guard: ensures each segment has genuine horizontal
      // extent, not just general motion that happens to change direction once.
      const minXDelta = size * 0.06;
      const hasZigzag = segs.length >= 3
        && (segs[0].delta > 0) !== (segs[1].delta > 0)   // reversal 1
        && (segs[1].delta > 0) !== (segs[2].delta > 0)   // reversal 2
        && Math.abs(segs[0].delta) >= minXDelta
        && Math.abs(segs[1].delta) >= minXDelta
        && Math.abs(segs[2].delta) >= minXDelta;

      // Measure totalPath only over the three zigzag segments, not the full window.
      const segEnd   = hasZigzag ? segs[2].end   : indexPath.length - 1;
      const segStart = hasZigzag ? segs[0].start : 0;
      const totalPath = indexPath.slice(segStart + 1, segEnd + 1)
        .reduce((sum, p, i) => sum + gestureDist(p, indexPath[segStart + i]), 0) / size;

      // Gate movedEnough on hasZigzag so both conditions must be satisfied
      // in the same frame, preventing drift noise from pre-satisfying movedEnough.
      const movedEnough = hasZigzag && totalPath > 0.09;

      return {
        matched: hasZigzag && movedEnough,
        detail: {
          segCount:    segs.length,
          segs:        segs.map((s) => +s.delta.toFixed(3)),
          hasZigzag,
          totalPath:   +totalPath.toFixed(3),
          movedEnough,
          minSegMove:  +minSegMove.toFixed(4),
          minXDelta:   +minXDelta.toFixed(3),
        },
      };
    },
  });

  // =============================================================
  // REMAINING LETTERS — distinct curl/direction signatures
  // =============================================================

  // B — flat hand, four fingers up together, thumb folded in
  const B = new fp.GestureDescription('asl_b');
  curls(B, { [Finger.Thumb]: FingerCurl.FullCurl }, 0.7);
  NON_THUMB.forEach((f) => B.addCurl(f, FingerCurl.NoCurl, 1.0));
  directions(B, NON_THUMB.map((f) => [f, FingerDirection.VerticalUp]), 1.0);
  letters.push(B);

  /* Tie-breaker: B / W
     B and W constantly contend because both have index, middle, and ring
     fully extended. B adds the pinky; W curls it in.

     Signal: pinky reach. B's pinky is straight (high reach); W's is tucked (low).
     Real data: B=0.638, W=0.477–0.485. Threshold 0.56 at the midpoint.

     Note: W/F contention is handled by the B/F/W breaker below. */
  TIE_BREAKERS.push({
    names: ['asl_b', 'asl_w'],
    resolve(landmarks) {
      const pinkyReach = fingerReach(landmarks, PINKY_MCP, PINKY_TIP);
      return pinkyReach > 0.56 ? 'asl_b' : 'asl_w';
    },
  });

  /* Tie-breaker: B / F / W
     Three-way resolve using thumb proximity and pinky reach.
     Real data:
       F thumb-to-index-PIP=0.137 → caught at step 1
       B thumb-to-index-PIP=0.648, pinkyReach=0.638 → caught at step 2
       W thumb-to-index-PIP=0.659, pinkyReach=0.458 → falls through to W */
  TIE_BREAKERS.push({
    names: ['asl_b', 'asl_f', 'asl_w'],
    resolve(landmarks) {
      const size = palmSize(landmarks);
      const thumbToIndexPip = gestureDist(landmarks[THUMB_TIP], landmarks[INDEX_PIP]) / size;
      // F's thumb is pressed close to the index PIP (forming the circle).
      if (thumbToIndexPip < 0.4) return 'asl_f';
      // B's pinky is fully extended; W's pinky is curled.
      const pinkyReach = fingerReach(landmarks, PINKY_MCP, PINKY_TIP);
      return pinkyReach > 0.56 ? 'asl_b' : 'asl_w';
    },
  });

  // C — whole hand curved, every finger half-curled
  const C = new fp.GestureDescription('asl_c');
  curls(C, {
    [Finger.Thumb]:  FingerCurl.HalfCurl,
    [Finger.Index]:  FingerCurl.HalfCurl,
    [Finger.Middle]: FingerCurl.HalfCurl,
    [Finger.Ring]:   FingerCurl.HalfCurl,
    [Finger.Pinky]:  FingerCurl.HalfCurl,
  }, 1.0);
  letters.push(C);

  // F — thumb+index circle, middle/ring/pinky straight up.
  // Direction rules removed — VerticalUp measured against fixed camera Y axis
  // adds denominator drag on any tilted capture. Disambiguation handled by
  // the B/F/W tie-breaker above.
  // Thumb and index accept both HalfCurl (primary) and NoCurl (fallback) because
  // a looser, more-open circle reads as NoCurl on real captures.
  const F = new fp.GestureDescription('asl_f');
  curls(F, {
    [Finger.Middle]: FingerCurl.NoCurl,
    [Finger.Ring]:   FingerCurl.NoCurl,
    [Finger.Pinky]:  FingerCurl.NoCurl,
  }, 1.0);
  F.addCurl(Finger.Thumb, FingerCurl.HalfCurl, 1.0);
  F.addCurl(Finger.Thumb, FingerCurl.NoCurl,   0.8);
  F.addCurl(Finger.Index, FingerCurl.HalfCurl, 1.0);
  F.addCurl(Finger.Index, FingerCurl.NoCurl,   0.9);
  letters.push(F);

  // I — fist, only pinky up
  const I = new fp.GestureDescription('asl_i');
  curls(I, {
    [Finger.Thumb]:  FingerCurl.HalfCurl,
    [Finger.Index]:  FingerCurl.FullCurl,
    [Finger.Middle]: FingerCurl.FullCurl,
    [Finger.Ring]:   FingerCurl.FullCurl,
    [Finger.Pinky]:  FingerCurl.NoCurl,
  }, 1.0);
  directions(I, [[Finger.Pinky, FingerDirection.VerticalUp]], 1.0);
  letters.push(I);

  // J — same curl rules as I (both share the same resting handshape).
  // Diagonal pinky direction causes J to score higher than I when the hand
  // is angled, and lower when held upright — still needed for the static
  // tie-breaker even though J itself never fires from the static pipeline.
  const J = new fp.GestureDescription('asl_j');
  curls(J, {
    [Finger.Thumb]:  FingerCurl.HalfCurl,
    [Finger.Index]:  FingerCurl.FullCurl,
    [Finger.Middle]: FingerCurl.FullCurl,
    [Finger.Ring]:   FingerCurl.FullCurl,
    [Finger.Pinky]:  FingerCurl.NoCurl,
  }, 1.0);
  directions(J, [[Finger.Pinky, FingerDirection.DiagonalUpLeft]],  0.9);
  directions(J, [[Finger.Pinky, FingerDirection.DiagonalUpRight]], 0.9);
  // J is motion-only — not pushed to CUSTOM_GESTURES.

  /* Tie-breaker: I / J
     J is motion-only. A held J-resting pose always resolves to I.
     Kept so any residual asl_j score never sneaks through. */
  TIE_BREAKERS.push({
    names: ['asl_i', 'asl_j'],
    resolve(landmarks) {
      return 'asl_i';
    },
  });

  // =============================================================
  // J MOTION DETECTION
  // =============================================================
  // J's resting shape is the I handshape (pinky clearly extended and
  // dominant over index/middle, thumb tucked in) held with a diagonal
  // lean, not straight upright — see looksLikeRestingI below for why
  // the lean matters. The detect() function looks for a pinky hook:
  // two segments on the Y axis with a direction reversal, plus minimum
  // path length and wrist tilt that distinguishes a genuine J stroke
  // from I-hold jitter.
  // =============================================================

  /**
   * Returns true if the hand is in a plausible J-resting pose: the I
   * handshape (pinky clearly extended and dominant over index/middle,
   * thumb tucked in), PLUS a diagonal pinky lean — the same signal the
   * static gesture scoring above uses to tell I and J apart
   * (`FingerDirection.VerticalUp` for I vs `DiagonalUpLeft`/
   * `DiagonalUpRight` for J). Without this last guard, a plain upright I
   * satisfies every curl-based check just as well as an angled J-start,
   * which meant holding a completely ordinary I could get read as "J is
   * resting" — blocking I from being typed in anything that gates on
   * this.
   *
   * Guards:
   *   • pinkyReach > 0.50                    — pinky must be up
   *   • pinky−index and pinky−middle > 0.12  — pinky dominant
   *   • thumbExtension < 0.75                — thumb tucked (blocks Y)
   *   • pinky tilt off the palm's own "up" axis > PINKY_TILT_MIN_DEG —
   *     diagonal lean, not a straight-up I
   *
   * PINKY_TILT_MIN_DEG was 18 and was still letting ordinary I holds
   * (with a bit of natural wrist wobble/camera-angle lean, comfortably
   * more than 18° off vertical without the person doing anything like a
   * J) get read as "J is resting" and block I from being typed. Raised
   * to 28 for more headroom above normal I jitter while staying well
   * under a genuine J-start lean.
   */
  const PINKY_TILT_MIN_DEG = 28;

  function pinkyTiltFromUpDeg(landmarks) {
    const frame    = palmFrame(landmarks);
    const pinkyVec = vSub(landmarks[PINKY_TIP], landmarks[PINKY_MCP]);
    return vAngleDeg(pinkyVec, frame.up);
  }

  function looksLikeRestingI(landmarks) {
    const pinkyReach  = fingerReach(landmarks, PINKY_MCP, PINKY_TIP);
    const indexReach  = fingerReach(landmarks, INDEX_MCP, INDEX_TIP);
    const middleReach = fingerReach(landmarks, MIDDLE_MCP, MIDDLE_TIP);
    const thumbExtension = gestureDist(landmarks[PINKY_MCP], landmarks[THUMB_TIP])
      / (gestureDist(landmarks[WRIST], landmarks[MIDDLE_MCP]) || 1e-6);
    return pinkyReach > 0.50
      && pinkyReach - indexReach  > 0.12
      && pinkyReach - middleReach > 0.12
      && thumbExtension < 0.75
      && pinkyTiltFromUpDeg(landmarks) > PINKY_TILT_MIN_DEG;
  }

  MOTION_DETECTORS.push({
    name: 'asl_j',
    restingCheck: looksLikeRestingI,
    detect(history) {
      const size      = palmSize(history[history.length - 1].landmarks);
      const pinkyPath = history.map((h) => h.landmarks[PINKY_TIP]);

      // J = pinky traces a hook: one vertical reversal (two segments, opposite Y directions).
      const minVel     = size * 0.02;
      const minSegMove = size * 0.05;
      const segs       = findStrokeSegments(pinkyPath, 1, minVel, minSegMove);

      // Per-segment Y-delta guard: ensures genuine vertical extent in each hook segment.
      const minYDelta = size * 0.04;
      const hasHook   = segs.length >= 2
        && (segs[0].delta > 0) !== (segs[1].delta > 0)
        && Math.abs(segs[0].delta) >= minYDelta
        && Math.abs(segs[1].delta) >= minYDelta;

      // Measure totalPath only over the two hook segments, not the full window.
      const segEnd   = hasHook ? segs[1].end   : pinkyPath.length - 1;
      const segStart = hasHook ? segs[0].start : 0;
      const totalPath = pinkyPath.slice(segStart + 1, segEnd + 1)
        .reduce((sum, p, i) => sum + gestureDist(p, pinkyPath[segStart + i]), 0) / size;

      // Gate movedEnough on hasHook — prevents drift from pre-satisfying the condition.
      const movedEnough = hasHook && totalPath > 0.35;

      // Hand-tilt: a genuine J stroke naturally rotates the wrist as the pinky hooks.
      // Measured only across the detected hook segment, not the full window, to avoid
      // triggering on the approach motion before the resting pose is settled.
      const tiltStartIdx = hasHook ? segs[0].start : 0;
      const tiltEndIdx   = hasHook ? segs[1].end   : history.length - 1;
      const startUp      = palmFrame(history[tiltStartIdx].landmarks).up;
      const endUp        = palmFrame(history[tiltEndIdx].landmarks).up;
      const handTiltDeg  = vAngleDeg(startUp, endUp);
      const enoughTilt   = handTiltDeg >= 12;

      return {
        matched: hasHook && movedEnough && enoughTilt,
        detail: {
          segCount:     segs.length,
          segs:         segs.map((s) => +s.delta.toFixed(3)),
          hasHook,
          totalPath:    +totalPath.toFixed(3),
          movedEnough,
          handTiltDeg:  +handTiltDeg.toFixed(1),
          enoughTilt,
        },
      };
    },
  });

  // K — index straight up, middle finger BOWED (half-curled) because the
  // thumb rests between index and middle and pushes middle down. This bowed
  // middle finger is the real anatomical difference between K and H/V.
  // No direction constraints — disambiguation is handled by resolveExtendedFamily.
  const K = new fp.GestureDescription('asl_k');
  curls(K, {
    [Finger.Thumb]:  FingerCurl.HalfCurl,
    [Finger.Index]:  FingerCurl.NoCurl,
    [Finger.Middle]: FingerCurl.HalfCurl,
    [Finger.Ring]:   FingerCurl.FullCurl,
    [Finger.Pinky]:  FingerCurl.FullCurl,
  }, 1.0);
  letters.push(K);

  // L — thumb+index right angle, rest curled
  const L = new fp.GestureDescription('asl_l');
  curls(L, {
    [Finger.Thumb]:  FingerCurl.NoCurl,
    [Finger.Index]:  FingerCurl.NoCurl,
    [Finger.Middle]: FingerCurl.FullCurl,
    [Finger.Ring]:   FingerCurl.FullCurl,
    [Finger.Pinky]:  FingerCurl.FullCurl,
  }, 1.0);
  directions(L, [[Finger.Index, FingerDirection.VerticalUp]], 1.0);
  letters.push(L);

  // O — all fingers + thumb curl into a circle
  const O = new fp.GestureDescription('asl_o');
  curls(O, {
    [Finger.Thumb]:  FingerCurl.HalfCurl,
    [Finger.Index]:  FingerCurl.HalfCurl,
    [Finger.Middle]: FingerCurl.HalfCurl,
    [Finger.Ring]:   FingerCurl.HalfCurl,
    [Finger.Pinky]:  FingerCurl.HalfCurl,
  }, 1.0);
  letters.push(O);

  /* Tie-breaker: C / O
     C and O use identical HalfCurl on every finger — they tie every frame
     on curl rules alone. Resolved by the thumb-tip to index-tip gap:
     O closes the loop (small gap), C leaves it open (large gap).
     Threshold 0.83: midpoint of real captures C=0.967, O=0.692. */
  TIE_BREAKERS.push({
    names: ['asl_c', 'asl_o'],
    resolve(landmarks) {
      const size = palmSize(landmarks);
      const gap  = gestureDist(landmarks[THUMB_TIP], landmarks[INDEX_TIP]) / size;
      return gap < 0.83 ? 'asl_o' : 'asl_c';
    },
  });

  /* Tie-breaker: E / C
     E's hooked fingers tuck in tight (small fingertip-to-wrist distance);
     C's curved-but-open fingers stay further out (larger distance).
     Threshold 1.15: midpoint of real captures E=0.973, C=1.327. */
  TIE_BREAKERS.push({
    names: ['asl_e', 'asl_c'],
    resolve(landmarks) {
      const size             = palmSize(landmarks);
      const fingertipToPalm = gestureDist(landmarks[INDEX_TIP], landmarks[WRIST]) / size;
      return fingertipToPalm < 1.15 ? 'asl_e' : 'asl_c';
    },
  });

  /* Tie-breaker: E / O
     Same signal as E/C. Threshold 1.05: midpoint of real captures E=0.973, O=1.120. */
  TIE_BREAKERS.push({
    names: ['asl_e', 'asl_o'],
    resolve(landmarks) {
      const size             = palmSize(landmarks);
      const fingertipToPalm = gestureDist(landmarks[INDEX_TIP], landmarks[WRIST]) / size;
      return fingertipToPalm < 1.05 ? 'asl_e' : 'asl_o';
    },
  });

  // P — same base shape as K (index straight, middle bowed, thumb between),
  // hand tilted to point downward instead of up. No direction constraint —
  // the up/down split is handled by resolveExtendedFamily's palm-relative geometry.
  const P = new fp.GestureDescription('asl_p');
  curls(P, {
    [Finger.Thumb]:  FingerCurl.HalfCurl,
    [Finger.Index]:  FingerCurl.NoCurl,
    [Finger.Middle]: FingerCurl.HalfCurl,
    [Finger.Ring]:   FingerCurl.FullCurl,
    [Finger.Pinky]:  FingerCurl.FullCurl,
  }, 1.0);
  letters.push(P);

  // Q — same base shape as G (only index extended, thumb parallel),
  // hand tilted to point downward. No direction constraint — actual up/down
  // split is handled by resolveExtendedFamily, not Fingerpose direction scoring.
  const Q = new fp.GestureDescription('asl_q');
  curls(Q, {
    [Finger.Thumb]:  FingerCurl.NoCurl,
    [Finger.Index]:  FingerCurl.NoCurl,
    [Finger.Middle]: FingerCurl.FullCurl,
    [Finger.Ring]:   FingerCurl.FullCurl,
    [Finger.Pinky]:  FingerCurl.FullCurl,
  }, 1.0);
  letters.push(Q);

  // W — index+middle+ring up and spread, pinky+thumb folded.
  // Direction rules removed — camera-Y denominator drag tanks score on tilted captures.
  // Thumb accepts FullCurl, HalfCurl, and NoCurl (fallback at 0.9) because a
  // relaxed extended thumb reads as NoCurl on real captures.
  const W = new fp.GestureDescription('asl_w');
  curls(W, {
    [Finger.Index]:  FingerCurl.NoCurl,
    [Finger.Middle]: FingerCurl.NoCurl,
    [Finger.Ring]:   FingerCurl.NoCurl,
    [Finger.Pinky]:  FingerCurl.FullCurl,
  }, 1.0);
  W.addCurl(Finger.Thumb, FingerCurl.FullCurl, 1.0);
  W.addCurl(Finger.Thumb, FingerCurl.HalfCurl, 1.0);
  W.addCurl(Finger.Thumb, FingerCurl.NoCurl,   0.9);
  letters.push(W);

  // X — fist with index bent into a hook. Disambiguated from G by
  // resolveExtendedFamily below (thumb-to-ring-PIP proximity).
  const X = new fp.GestureDescription('asl_x');
  curls(X, {
    [Finger.Thumb]:  FingerCurl.HalfCurl,
    [Finger.Index]:  FingerCurl.HalfCurl,
    [Finger.Middle]: FingerCurl.FullCurl,
    [Finger.Ring]:   FingerCurl.FullCurl,
    [Finger.Pinky]:  FingerCurl.FullCurl,
  }, 1.0);
  letters.push(X);

  // =============================================================
  // UNIFIED RESOLVER — D, G, H, K, L, P, Q, R, T, U, V, W, X
  // =============================================================
  // One resolver covering all 13 members of the "extended family"
  // so _pickConfidentWinner's lookup always matches regardless of
  // which two letters happen to be top-scoring. Previous per-pair
  // breakers failed when the true rival wasn't the "assigned" partner.
  //
  // Decision tree:
  //   1. T escape: thumbToIndexPip < 0.22 AND index bent → T.
  //   2. Finger count via middle STRAIGHTNESS (not reach):
  //        middle straight AND ring reach ≈ index → W
  //        middle straight, ring curled → two-finger branch
  //        middle curled → one-finger branch
  //   3. Two-finger branch (R, U, V, H, K, P):
  //        a. Summed crossing margin < −0.05 → R
  //        b. thumbToIndexPip < 0.52 AND spread > 10° → K or P (split by indexCrossMargin sign)
  //        c. spread > 13° AND both cross margins positive → V
  //        d. Otherwise → H or U (split by thumbToPalm depth and indexCrossMargin)
  //   4. One-finger branch (D, G, L, Q, X):
  //        a. thumbToRingPip < 0.45 AND indexReach < 0.75 → X
  //        b. middleReach > 0.6 OR (thumbToMiddlePip < 0.3 AND thumbToIndexPip > 0.35) → D
  //        c. thumbToIndexPip > 0.75 → L
  //        d. thumbToIndexPip < 0.4 → G, else → Q
  // =============================================================
  TIE_BREAKERS.push({
    names: ['asl_d', 'asl_g', 'asl_h', 'asl_k', 'asl_l', 'asl_p', 'asl_q', 'asl_r', 'asl_t', 'asl_u', 'asl_v', 'asl_w', 'asl_x'],
    resolve(landmarks) {
      const size        = palmSize(landmarks);
      const indexReach  = fingerReach(landmarks, INDEX_MCP,  INDEX_TIP);
      const ringReach   = fingerReach(landmarks, RING_MCP,   RING_TIP);
      const middleReach = fingerReach(landmarks, MIDDLE_MCP, MIDDLE_TIP);
      const middleStraight = fingerStraightness(landmarks, MIDDLE_MCP, MIDDLE_PIP, MIDDLE_TIP);

      // T escape: thumb wedged under the index finger causes a close thumb-to-index-PIP
      // AND a bent index. Compound check guards against G (similar thumb distance but
      // fully straight index).
      const indexStraight       = fingerStraightness(landmarks, INDEX_MCP, INDEX_PIP, INDEX_TIP);
      const thumbToIndexPipEarly = gestureDist(landmarks[THUMB_TIP], landmarks[INDEX_PIP]) / size;
      if (thumbToIndexPipEarly < 0.22 && indexStraight < 0.87) return 'asl_t';

      // Finger-count gate via middle straightness.
      // Real data: 1-finger letters = 0.42–0.82, 2/3-finger letters = 0.94–1.0. Gap at 0.87.
      const middleOut = middleStraight > 0.87;
      // Ring-out only compared within the middleOut group (2-finger vs W data).
      // Real data: 2-finger = 0.61–0.85, W = 1.09. Threshold 0.95.
      const ringOut = middleOut && (ringReach / indexReach) > 0.95;

      if (middleOut && ringOut) return 'asl_w';

      if (middleOut) {
        // Two-finger branch: R, U, V, H, K, P
        const indexTip   = landmarks[INDEX_TIP];
        const middleTip  = landmarks[MIDDLE_TIP];
        const indexMcp   = landmarks[INDEX_MCP];
        const middleMcp  = landmarks[MIDDLE_MCP];

        // R: use the SUM of both fingers' lateral margins — a single finger tip can
        // drift slightly past the midline from pose noise without genuinely crossing.
        // Real data: R sum = −0.17; all non-R letters = +0.19 or higher.
        const midlineX       = (indexMcp[0] + middleMcp[0]) / 2;
        const indexSideSign  = Math.sign(indexMcp[0]  - midlineX) || -1;
        const middleSideSign = Math.sign(middleMcp[0] - midlineX) || 1;
        const indexCrossMargin  = (indexTip[0]  - midlineX) * indexSideSign  / size;
        const middleCrossMargin = (middleTip[0] - midlineX) * middleSideSign / size;
        if (indexCrossMargin + middleCrossMargin < -0.05) return 'asl_r';

        const spreadDeg = fingerSpreadDeg(landmarks, INDEX_MCP, INDEX_TIP, MIDDLE_MCP, MIDDLE_TIP);

        // K/P: thumb wedges in close to the index PIP AND fingers are spread.
        // Real data: K=11.5°, P=13.7° vs H/U=7.2–8.2°. Threshold spreadDeg > 10°.
        // K vs P split by indexCrossMargin sign (K positive, P negative — P is K rotated
        // to point downward, which flips the lateral position measurement).
        const thumbToIndexPip = gestureDist(landmarks[THUMB_TIP], landmarks[INDEX_PIP]) / size;
        if (thumbToIndexPip < 0.52 && spreadDeg > 10) {
          return indexCrossMargin > 0 ? 'asl_k' : 'asl_p';
        }

        // V: index and middle spread apart with both tips on their natural side of the midline.
        // Guard (indexCrossMargin > 0 && middleCrossMargin > 0) prevents H triggering the
        // lower spread threshold — H's lateral direction shifts the index tip past the midline.
        if (spreadDeg > 13 && indexCrossMargin > 0 && middleCrossMargin > 0) return 'asl_v';

        // H or U: fingers held together.
        // Real data: H=[0.569–0.645], U=[0.597–0.723] — ranges overlap.
        // Clear zones: thumbToPalm < 0.58 → H, > 0.66 → U.
        // Ambiguous zone: split by indexCrossMargin (H lateral direction shifts index
        // tip to the wrong side of the midline).
        const thumbToPalm = gestureDist(landmarks[THUMB_TIP], landmarks[PINKY_MCP]) / size;
        if (thumbToPalm < 0.58) return 'asl_h';
        if (thumbToPalm > 0.66) return 'asl_u';
        // Ambiguous zone threshold −0.3: midpoint of H=−0.508 and U=−0.149.
        return indexCrossMargin < -0.3 ? 'asl_h' : 'asl_u';
      }

      // One-finger branch: D, G, L, Q, X

      // X: thumb tip close to the ring PIP (hooked index curls the fist toward that side)
      // AND index under-reaches a fully extended pointing finger.
      // Guard indexReach < 0.75 distinguishes X from Z resting (both have similar thumbToRingPip).
      const thumbToRingPip = gestureDist(landmarks[THUMB_TIP], landmarks[RING_PIP]) / size;
      if (thumbToRingPip < 0.45 && indexReach < 0.75) return 'asl_x';

      // D: middle/ring fingers stay measurably more open than the rest of this branch
      // (D's circle shape doesn't tuck them into as tight a fist as L does), OR the
      // thumb tip is touching the middle finger (defining D's circle) while staying
      // away from the index knuckle.
      const thumbToMiddlePip     = gestureDist(landmarks[THUMB_TIP], landmarks[MIDDLE_PIP]) / size;
      const thumbToIndexPipForD  = gestureDist(landmarks[THUMB_TIP], landmarks[INDEX_PIP])  / size;
      if (middleReach > 0.6 || (thumbToMiddlePip < 0.3 && thumbToIndexPipForD > 0.35)) return 'asl_d';

      // L: thumb juts straight out away from the index knuckle (high thumbToIndexPip).
      // Real data ordering: G (0.24–0.26) < Q (0.42–0.61) < L (0.90–1.00) < D (already split).
      const thumbToIndexPip = gestureDist(landmarks[THUMB_TIP], landmarks[INDEX_PIP]) / size;
      if (thumbToIndexPip > 0.75) return 'asl_l';

      // G vs Q: G's thumb sits close beside the index knuckle; Q's sits farther out.
      // Real data: G=0.237–0.255, Q=0.416–0.609. Threshold 0.4.
      return thumbToIndexPip < 0.4 ? 'asl_g' : 'asl_q';
    },
  });

  // Y — thumb+pinky out ("hang loose"), middle three curled
  const Y = new fp.GestureDescription('asl_y');
  curls(Y, {
    [Finger.Thumb]:  FingerCurl.NoCurl,
    [Finger.Index]:  FingerCurl.FullCurl,
    [Finger.Middle]: FingerCurl.FullCurl,
    [Finger.Ring]:   FingerCurl.FullCurl,
    [Finger.Pinky]:  FingerCurl.NoCurl,
  }, 1.0);
  directions(Y, [[Finger.Pinky, FingerDirection.VerticalUp]], 0.8);
  letters.push(Y);

  /* Tie-breaker: I / Y
     Both have only the pinky extended; they differ by thumb extension.
     I tucks the thumb in (HalfCurl); Y sticks it out (NoCurl).
     Measured directly: thumb tip distance from palm, normalised.
     Real data: Y thumb far out, I tucked. Threshold 0.45. */
  TIE_BREAKERS.push({
    names: ['asl_i', 'asl_y'],
    resolve(landmarks) {
      const size           = palmSize(landmarks);
      const thumbExtension = gestureDist(landmarks[THUMB_TIP], landmarks[PINKY_MCP]) / size;
      return thumbExtension > 0.45 ? 'asl_y' : 'asl_i';
    },
  });

  // J/Y tie-breaker removed — J is no longer in the static pipeline,
  // so it can never be in a contention cluster with Y.

  // =============================================================
  // REGISTER ALL STATIC LETTERS
  // =============================================================
  CUSTOM_GESTURES.push(...letters);
})();
