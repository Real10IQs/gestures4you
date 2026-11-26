/* ============================================================
   APP LOGIC
   ============================================================
   Rendering, navigation, quiz flow (Q&A + camera gesture
   questions), profile editing, etc. Lesson/question content, static
   profile-pic/gesture-image config, etc. all live in lessons.js
   (UNITS / QUESTIONS / LESSONS / PROFILE_PICS / GESTURE_IMG_DIR —
   formerly split across lessons.js + a separate data.js, merged into
   one file). This file shouldn't need edits just to add content.

   QUIZ RULES (per lessons.js mode):
   - mode 'normal' : no hearts, no timer, any question type. Wrong
                      answers get redone (queued to the end) once the
                      question list runs out — same redo mechanic as
                      'test' mode, just without hearts.
   - mode 'bonus'  : no hearts, no timer, any question type, no redo —
                      a wrong answer just moves on, can only ever be
                      attempted once overall (see bonus node rules).
   - mode 'test'   : hearts + per-question timer ONLY when the
                      lesson's type is 'gesture'. A 'qa'-type test just
                      needs every question answered (no hearts/timer).
                      Wrong answers get redone the same way as 'normal'.
   ============================================================ */

// IMPORTANT: this must stay `var`, not `let`/`const`. firebase-init.js
// reaches into `window.state` directly (see that file's header comment
// on why). A top-level `let`/`const` in a classic (non-module) script
// creates a binding in the script's lexical scope but does NOT attach
// to `window` — so `window.state` would silently be `undefined` even
// though the bare `state` identifier works fine everywhere in THIS
// file. That was a real bug here: every `window.state.avatar` /
// `window.state.name` access in firebase-init.js was throwing
// "Cannot read properties of undefined", which silently aborted
// onAuthStateChanged/fbGoogleSignIn before they ever reached
// window.enterApp() — matching the "login/register/Google sign-in
// look successful but nothing happens" reports. `var` at top level of
// a classic script IS a property of `window`, and stays live: any
// later plain reassignment (`state={...}` on logout, below) updates
// `window.state` automatically since they're the same binding.
// profilePic holds a filename from lessons.js's PROFILE_PICS array (e.g.
// 'default.png'), resolved to a full path via PROFILE_PIC_DIR when
// rendering — see renderAll()/openEditProfile(). This replaces an
// older emoji-character 'avatar' field (and its AVATARS picker list,
// now removed) — guests always stay on 'default.png' since they never
// get access to the picture picker (handleProfileNav() routes guests
// straight to the auth page instead of the profile screen).
// score is a new (unused-for-now) stat separate from xp, plumbed
// through state/Firestore so a future feature can read/write it.
// milestones/wrongCounts back the achievements whose condition can't be
// re-derived from progress/xp alone (see ACHIEVEMENTS' kind:'no_info_all'/
// 'no_wrong_all'/'wrong_in_node') — a one-time disqualifying/qualifying
// event that has to be remembered forever, same reasoning as why
// state.achievements itself is stored rather than recomputed (see
// checkAchievements()'s comment). infoNodeOpened/wrongEver only ever flip
// false->true and never reset on their own (short of a full progress
// reset); wrongCounts is a per-lesson_id wrong-answer tally.
var state={name:'ผู้ใช้งาน',profilePic:'default.png',xp:0,score:0,scoreLetters:0,scoreSigns:0,progress:{},bonusNodes:{},achievements:{},milestones:{infoNodeOpened:false,wrongEver:false},wrongCounts:{},isGuest:true};

// Backs the 'drink_water' achievement's progress bar (see
// computeAchievementStatus()'s 'event' branch and the setTimeout near
// the bottom of this file that actually unlocks it). Stamped once at
// script load, same "armed fresh every page load, not persisted"
// session-only timing the achievement itself already used before it
// had a progress bar — this just gives renderAchievements() something
// to measure elapsed time against.
const DRINK_WATER_STARTED_AT=Date.now();
const DRINK_WATER_MS=60*60*1000;

/* ------------------------------------------------------------
   SFX
   ------------------------------------------------------------
   Central one-shot helper for every short sound effect in the app
   (see each call site below for what triggers which file). NOT the
   same machinery as the WARFRAME easter egg's dedicated
   AudioContext/analyser graph further down this file — these are
   plain, uncorrelated one-shot cues with nothing to visualize, so a
   bare `new Audio()` per call is simpler and needs no Web Audio graph
   at all. A fresh Audio() is created every call (never cached/reused)
   specifically so the same effect can overlap itself — e.g. two rapid
   button presses — without the second play cutting the first one off.
   Files live at assets/sfx/<name>.mp3 — assets/ is a sibling of
   html/ and js/, same '../assets/...' convention as
   PROFILE_PIC_DIR/GESTURE_IMG_DIR (lessons.js) and the WARFRAME sfx
   further down. `name` is always a literal authored at the call site
   (never user input), same trust assumption as showToast()'s icon
   param above.
   .catch(()=>{}) swallows autoplay-policy rejections (e.g. a sound
   fired before any user gesture has landed on the page yet) exactly
   like playWarframeSfx() already does elsewhere in this file — a
   blocked sound effect should never surface as a console error or
   break whatever feature it's attached to. */
const SFX_DIR='../assets/sfx/';
/* Cache one <audio> element per sound name instead of constructing a
   fresh `new Audio(...)` (and re-triggering a network fetch/decode)
   on every single play — that per-call fetch was the source of the
   audible delay on repeated sounds (corrct/wrong/pop, etc. firing
   dozens of times a session). The cached element's `load()` is kicked
   off once, up front (see SFX_PRELOAD_NAMES/preloadSfx() below), so by
   the time any of these actually plays the browser already has it
   fetched and ready to go instead of starting the fetch right as the
   sound is supposed to play.
   `cloneNode()` on play (rather than replaying the cached element
   directly) is still needed so two overlapping calls to the SAME sound
   (e.g. rapid-fire wrong answers) don't cut each other off by both
   fighting over one element's playhead — the clone shares the
   already-fetched network cache entry, so this doesn't reintroduce
   the fetch delay. */
const _sfxCache={};
function getSfxAudio(name){
  let a=_sfxCache[name];
  if(!a){
    a=new Audio(SFX_DIR+name+'.mp3');
    a.preload='auto';
    _sfxCache[name]=a;
  }
  return a;
}
function playSfx(name,opts){
  opts=opts||{};
  try{
    let a;
    if(opts.overlap===false){
      // Reuse (and restart) the one cached element instead of spawning
      // a new overlapping clone. Sounds tied to a counter that can
      // retrigger rapidly (the combo popup climbing 3→4→5→6... in
      // quick succession) were stacking a fresh clone on top of
      // whatever copy was still playing from the previous trigger —
      // that's what read as BOTH "too loud" (multiple copies summing
      // together) and "delayed" (each new pop's attack got buried
      // under the tail of the last one instead of landing cleanly on
      // the beat). Restarting the same element makes every retrigger
      // one clean, consistent-volume hit instead.
      // correct/wrong (checkAnswer()/gestureAnswered()) also pass this
      // now, for a different reason: they only ever fire once per
      // question (nothing to overlap), but cloneNode() isn't
      // guaranteed to inherit the cached element's already-loaded state
      // in every browser — the clone can end up quietly re-buffering
      // before play() actually produces sound, which is what read as
      // "correct/wrong lag behind the feedback text" even after
      // preloadSfx() had already warmed the cache.
      a=getSfxAudio(name);
      a.currentTime=0;
    }else{
      a=getSfxAudio(name).cloneNode(true);
    }
    if(opts.volume!=null)a.volume=opts.volume;
    a.play().catch(()=>{});
  }catch(e){
    // Extremely defensive: `new Audio()` throwing outright (rather
    // than just .play() rejecting) would mean no Audio support at
    // all — still shouldn't take the calling feature down with it.
  }
}

// Every sound name actually referenced anywhere in this file (see the
// playSfx()/playWarframeSfx() call sites) — warmed up front so the
// FIRST time each one plays is already loaded instead of paying the
// fetch delay on that first play too. Cheap: just primes the cache
// above, doesn't play anything audible.
const SFX_PRELOAD_NAMES=['achievement','correct','wrong','completed','lose','pop','fire-transition','warframe'];
function preloadSfx(){
  SFX_PRELOAD_NAMES.forEach(n=>{try{getSfxAudio(n).load();}catch(e){}});
}

// Total level shown on the profile tab, replacing the old daily-streak
// stat (streaks needed a server-side scheduled reset we don't have —
// see firebase-init.js's KNOWN LIMITATION note — so they were dropped
// entirely rather than kept as a half-working feature).
//
// LEVEL DESIGN
// ------------------------------------------------------------
// Levels 1-5 track lesson-path progress: level 1 ("just started") at
// 0 XP, level 5 ("finished tutorial") exactly at LESSON_XP_TOTAL — the
// sum of every question's xp across every real lesson PLUS every
// generated bonus node, i.e. what you have after 100% completing the
// whole current lesson path. That total is currently 2350 (1820 from
// the 104 main-path questions + 530 from the 24 bonus-node question
// picks across sections u2-u7 — see generateBonusNodes()/QUESTIONS'
// xp fields; recompute LESSON_XP_TOTAL below if lessons.js's xp
// values or unit/section count ever change). Levels 2-4 sit at even
// quarters of that total so the climb from 1->5 feels steady rather
// than front- or back-loaded.
//
// Levels 5-100 are NOT wired to anything yet — that range is meant to
// be earned through achievements and the card game (both TODO), whose
// max-100 card-game score is why 100 XP/level was picked for this
// stretch: a maxed-out card game round = exactly one level. Once
// those systems exist, whatever XP they award just needs to add into
// state.xp same as lesson XP does now, and this function handles the
// rest automatically.
var LESSON_XP_TOTAL=7255;
var LEVEL_1_TO_5_THRESHOLDS=[0,1,2,3,4].map(i=>Math.round(LESSON_XP_TOTAL*i/4)); // [0,1814,3628,5441,7255]
function calcLevel(xp){
  xp=xp||0;
  for(let lvl=1;lvl<5;lvl++){
    if(xp<LEVEL_1_TO_5_THRESHOLDS[lvl])return lvl;
  }
  // Level 5+ : 100 XP per level beyond the lesson-completion total,
  // capped at 100 — this is the range future achievement/card-game XP
  // will actually move you through.
  const extra=xp-LESSON_XP_TOTAL;
  return Math.min(100,5+Math.floor(extra/100));
}

// Tier name shown alongside the numeric level. A new name kicks in
// every 5 levels from level 5 onward (level 5, 10, 15 ... 100); level
// 1-4 all share the "just started" beginner name. Names ramp up along
// an ASL-learning-journey theme: student -> practiced signer ->
// interpreter -> master -> legend, ending at the level-100 cap.
var LEVEL_TIERS=[
  {at:1,name:'ผู้เริ่มต้น'},
  {at:5,name:'มือใหม่'},
  {at:10,name:'นักเรียน'},
  {at:15,name:'นักฝึกหัด'},
  {at:20,name:'ผู้ฝึกฝน'},
  {at:25,name:'นักสื่อสาร'},
  {at:30,name:'นักท่ามือฝีมือดี'},
  {at:35,name:'นักท่ามือคล่องแคล่ว'},
  {at:40,name:'นักท่ามือขั้นสูง'},
  {at:45,name:'ผู้เชี่ยวชาญ'},
  {at:50,name:'ล่ามฝึกหัด'},
  {at:55,name:'ล่ามมือทอง'},
  {at:60,name:'ปรมาจารย์ฝึกหัด'},
  {at:65,name:'ปรมาจารย์ท่ามือ'},
  {at:70,name:'ปราชญ์ท่ามือ'},
  {at:75,name:'เซียนท่ามือ'},
  {at:80,name:'จอมยุทธ์ท่ามือ'},
  {at:85,name:'ตำนานท่ามือ'},
  {at:90,name:'แชมป์ท่ามือ'},
  {at:95,name:'สุดยอดท่ามือ'},
  {at:100,name:'ตำนานอมตะ'},
];
function calcLevelTierName(level){
  let name=LEVEL_TIERS[0].name;
  for(let i=0;i<LEVEL_TIERS.length;i++){
    if(level>=LEVEL_TIERS[i].at)name=LEVEL_TIERS[i].name;else break;
  }
  return name;
}

/* Backs the small "XP to next level" progress bar on the profile tab.
   Mirrors calcLevel()'s own two brackets exactly (quarter-steps of
   LESSON_XP_TOTAL for levels 1-4, then flat 100XP/level from level 5
   up to the level-100 cap) so the bar can never drift out of sync with
   the level number shown next to it — if calcLevel()'s thresholds ever
   change, this reads the same constants and just follows along.
   Returns the current level's {lower,upper} XP bounds plus how far
   through that range `xp` sits (0-100). Level 100 has no "next" level
   to climb toward, so that case just reports a full, maxed-out bar
   instead of dividing by a non-existent range. */
function calcLevelProgress(xp){
  xp=xp||0;
  const lvl=calcLevel(xp);
  if(lvl>=100)return{lower:xp,upper:xp,pct:100,maxed:true};
  let lower,upper;
  if(lvl<5){
    lower=LEVEL_1_TO_5_THRESHOLDS[lvl-1];
    upper=LEVEL_1_TO_5_THRESHOLDS[lvl];
  }else{
    lower=LESSON_XP_TOTAL+(lvl-5)*100;
    upper=lower+100;
  }
  const pct=Math.max(0,Math.min(100,Math.round((xp-lower)/(upper-lower)*100)));
  return{lower,upper,pct,maxed:false};
}

/* Single place that updates every level-derived bit of the profile tab
   (number, tier name, XP total, and the small progress-to-next-level
   bar) — pulled out of renderAll() so the two other spots that change
   state.xp mid-session (finishLesson(), loseFlashcardGame()) can keep
   the bar honest immediately too, instead of it only refreshing on the
   next full page load/login. Safe to call any time; every element it
   touches is looked up fresh and guarded with a null-check the same
   way renderAll()'s p-level-tier lookup already was. */
function renderLevelStats(){
  const lvl=calcLevel(state.xp);
  const lvlEl=document.getElementById('p-level');
  if(lvlEl)lvlEl.textContent=lvl;
  // Sidebar/navbar "เลเวล N" line — was hardcoded markup with no id at
  // all, so it never updated past the page's initial "เลเวล 1" no matter
  // how much XP was earned. Kept in this same function (rather than a
  // separate call site) so it can never drift out of sync with p-level
  // again — anywhere the level number changes, this is the one place
  // that has to run.
  const navLvlEl=document.getElementById('s-ulv');
  if(navLvlEl)navLvlEl.textContent='เลเวล '+lvl;
  const tierEl=document.getElementById('p-level-tier');
  if(tierEl)tierEl.textContent=calcLevelTierName(lvl);
  const xpEl=document.getElementById('p-xp');
  if(xpEl)xpEl.textContent=state.xp;
  const prog=calcLevelProgress(state.xp);
  const fillEl=document.getElementById('p-level-progress-fill');
  if(fillEl)fillEl.style.width=prog.pct+'%';
  const labelEl=document.getElementById('p-level-progress-label');
  if(labelEl){
    labelEl.textContent=prog.maxed
      ?'เลเวลสูงสุดแล้ว'
      :`${state.xp-prog.lower} / ${prog.upper-prog.lower} XP ถึงเลเวลถัดไป`;
  }
}

/* bonusNodes: { [sectionId]: [{lesson_id,section,no,type,mode,questions},...] }
   Generated once per section when that section becomes reachable; stored so the
   same 2 random questions are shown every time a bonus node is opened. */
let activeQuiz=null;
let editSelectedPic='default.png';

const TEST_LIVES_DEFAULT=3;
const GESTURE_TIME_LIMIT_S=10;
/* How long (ms) a gesture must be held still ("frozen") before it counts
   as correct. Applies to held-pose letters via an app-side hold timer
   (see startGestureCamera), and to the motion letters J/Z via the
   detection engine's own motionFreezeMs (same constant, passed in). */
const GESTURE_FREEZE_MS=2000;
/* J/Z must be held in their resting starting shape (I for J, D for Z)
   continuously for this long before a stroke is even looked for — same
   value/purpose as the old translator's resting hold.
   Passed straight into GestureDetector's own motionRestingHoldMs gate
   (see gesture-detection.js), so detect() itself won't run for J/Z
   until this is satisfied — no separate app-side timer needed here. */
const GESTURE_MOTION_RESTING_HOLD_MS=500;

/* ------------------------------------------------------------
   FLASH CARD GAME — tune here.
   ------------------------------------------------------------
   Endless-mode: a random letter A-Z is shown, the player must form it
   before the round timer runs out (reusing the same hold/resting-hold
   feel as lesson gesture questions via GESTURE_FREEZE_MS /
   GESTURE_MOTION_RESTING_HOLD_MS above, so it doesn't feel like a
   different detector). One wrong/timeout round ends the game.

   Per-round timer RAMPS DOWN as the run goes on — starts generous at
   FLASHCARD_TIME_START_S, loses FLASHCARD_TIME_DECAY_PER_PASS_S every
   correctly-passed round, floored at FLASHCARD_TIME_MIN_S. J/Z get
   their own higher floor (FLASHCARD_TIME_MIN_S_MOTION) since a full
   stroke physically takes longer to trace than holding a static pose
   — without a separate floor, a long high-streak run would eventually
   make J/Z basically unanswerable while every other letter was still
   fair. See flashcardTimeForRound(). */
const FLASHCARD_LETTERS='ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('');
const FLASHCARD_TIME_START_S=15;
const FLASHCARD_TIME_DECAY_PER_PASS_S=0.5;
const FLASHCARD_TIME_MIN_S=5;
const FLASHCARD_TIME_MIN_S_MOTION=8;
function flashcardTimeForRound(passesSoFar,isMotionLetter){
  const floor=isMotionLetter?FLASHCARD_TIME_MIN_S_MOTION:FLASHCARD_TIME_MIN_S;
  const raw=FLASHCARD_TIME_START_S-FLASHCARD_TIME_DECAY_PER_PASS_S*passesSoFar;
  return Math.max(floor,raw);
}
/* Score/XP awarded per correct round scale up with the current streak
   (streak = correct rounds in a row THIS game, 1-indexed — the round
   that was just answered counts itself), so a longer run is worth
   more per-answer, not just more answers. Uncapped: the shrinking
   timer above is what keeps runs from going forever, not an
   artificial score ceiling. */
const FLASHCARD_BASE_SCORE=10;
const FLASHCARD_STREAK_SCORE_STEP=5;
const FLASHCARD_BASE_XP=2;
const FLASHCARD_STREAK_XP_STEP_EVERY=2; // +1 xp every N streak steps, not every single one — keeps xp climbing slower than score
function flashcardScoreForStreak(streak){return FLASHCARD_BASE_SCORE+(streak-1)*FLASHCARD_STREAK_SCORE_STEP;}
function flashcardXpForStreak(streak){return FLASHCARD_BASE_XP+Math.floor((streak-1)/FLASHCARD_STREAK_XP_STEP_EVERY);}
/* Streak "combo" tiers — purely decorative (badge color/label under the
   card, see updateFlashcardStreakBadge()), no effect on scoring. */
const FLASHCARD_STREAK_TIERS=[
  {at:10,cls:'fc-streak-gold',label:'สุดยอด!'},
  {at:5,cls:'fc-streak-silver',label:'ทำได้ดีมาก!'},
  {at:3,cls:'fc-streak-bronze',label:'ต่อเนื่อง!'},
];


/* Lesson path 3D scroll-perspective — tune here.
   As a row's center moves away from the vertical center of .main-area's
   visible viewport, it tilts (rotateX), shrinks (scale), and dims
   (opacity). Rows within PATH_FLAT_ZONE of center stay completely
   untouched (scale 1, no tilt, full opacity); past that zone the effect
   ramps 0→1 out to the viewport edge.
   The very first row (the start of the whole path) is exempt from all of
   this — there's nothing before it to "recede" from, so it's pinned flat
   (scale 1, no tilt, full opacity) no matter where it sits in the
   viewport.

   NOTE on PATH_Z_DEPTH / translateZ: earlier versions also applied
   translateZ(-z) here for a "receding into the screen" depth cue. That's
   been removed — not toned down, fully removed — because it was the
   direct cause of nodes overlapping and swallowing each other's clicks:
   under CSS perspective, translateZ doesn't just shrink an element in
   place, it visually pulls it toward perspective-origin (the viewport's
   own center), so as a row received it visibly slid toward its
   neighbors rather than shrinking around its own center. On top of
   that, true 3D depth-sorting between siblings (which would at least
   paint/hit-test the nearer one on top) doesn't reliably survive
   .main-area's overflow-y:auto ancestor across browsers — so wherever
   two rows ended up overlapping, whichever happened to be later in the
   DOM won every click there, regardless of which one was actually
   visible on top. PATH_Z_DEPTH is left defined below in case a future
   session wants to reintroduce *some* depth cue — just be aware
   reintroducing translateZ reintroduces this exact class of bug unless
   it's paired with a way to guarantee rows never overlap.

   NOTE on PATH_TILT_MAX_DEG / rotateX: also removed now, for the same
   root cause family as translateZ above. rotateX is a 3D transform, and
   like translateZ it only paints/hit-tests correctly under CSS
   perspective when the browser fully honors the 3D projection matrix —
   which, again, does NOT reliably survive .main-area's overflow-y:auto
   ancestor across browsers. In practice this showed up as the node's
   *clickable* hitbox landing visibly higher than its rendered position
   once a row was far enough into the shrink zone to tilt noticeably: the
   browser hit-tested against a flattened (non-perspective-corrected) box
   while painting the properly-projected, foreshortened one, and the two
   diverged more the steeper the tilt got. rotateX's foreshortening was
   also compounding text/icon blur on receded rows (fractional sub-pixel
   scaling from an already-shrunk, already-tilted glyph). Removing it
   fixes both. The effect is now scale()+opacity() only — no 3D rotation
   at all, so there's nothing left that depends on perspective projection
   surviving the scroll ancestor. PATH_TILT_MAX_DEG is left defined below
   in case a future session wants to reintroduce *some* tilt — same
   warning as PATH_Z_DEPTH applies. */
const PATH_TILT_MAX_DEG=12;   // currently unused — see NOTE above
const PATH_SCALE_CENTER=1.08; // scale for rows inside the flat zone (pop)
const PATH_SCALE_MIN=0.92;    // scale at the viewport edge
const PATH_Z_DEPTH=70;        // currently unused — see NOTE above
const PATH_OPACITY_MIN=0.7;   // opacity at the viewport edge
const PATH_FLAT_ZONE=0.45;    // 0..1 normalized distance from center that stays untouched

/* Scroll performance: row/banner positions are measured ONCE (in content
   coordinates, i.e. independent of scroll) and cached in _pathCache; a
   scroll frame then only does arithmetic on ma.scrollTop and writes
   transform/opacity. The old version cleared every row's transform and
   called getBoundingClientRect() on every row on every scroll frame
   (forced layout, plus .lesson-row's CSS transition made the measured
   boxes lag behind), which is what felt laggy. scale() is about the row's
   own centre and translateX doesn't move it vertically, so centres don't
   depend on the applied transforms. The cache is rebuilt when the row
   count or the path height changes (re-render, resize, fonts/images). */
var _pathCache=null;
function _buildPathCache(ma,wrap){
  const maTop=ma.getBoundingClientRect().top;
  const rows=[...wrap.querySelectorAll('.lesson-row')];
  const banners=[...wrap.querySelectorAll('.unit-banner[data-course]')];
  const at=el=>el.getBoundingClientRect().top-maTop+ma.scrollTop;
  _pathCache={
    n:rows.length,h:wrap.offsetHeight,vh:ma.clientHeight,
    rows:rows.map((row,i)=>({row,i,x:Number(row.dataset.xOffset)||0,cy:at(row)+row.offsetHeight/2,lastT:'',lastO:''})),
    banners:banners.map(b=>({course:b.dataset.course,top:at(b)})),
  };
}
function invalidatePathCache(){_pathCache=null;}
function updateLessonPathPerspective(){
  const ma=document.querySelector('.main-area');
  const wrap=document.getElementById('lesson-path');
  if(!ma||!wrap)return;
  const nRows=wrap.querySelectorAll('.lesson-row').length;
  if(!_pathCache||_pathCache.n!==nRows||_pathCache.h!==wrap.offsetHeight||_pathCache.vh!==ma.clientHeight)_buildPathCache(ma,wrap);
  const st=ma.scrollTop;
  const halfH=(ma.clientHeight/2)||1;
  const rampSpan=Math.max(1-PATH_FLAT_ZONE,0.0001); // guards div-by-zero if FLAT_ZONE=1
  _pathCache.rows.forEach(r=>{
    let t,o;
    if(r.i===0){ // start of the path — always flat, never shrinks
      t='translateX('+r.x+'px)';o='1';
    }else{
      const absDelta=Math.abs((r.cy-st-halfH)/halfH); // ~0..1 across the visible viewport
      const mag=absDelta<=PATH_FLAT_ZONE?0:Math.min(1,(absDelta-PATH_FLAT_ZONE)/rampSpan);
      const scale=PATH_SCALE_CENTER-mag*(PATH_SCALE_CENTER-PATH_SCALE_MIN);
      // scale()+opacity only (no rotateX/translateZ — see NOTEs above).
      t='translateX('+r.x+'px) scale('+scale.toFixed(3)+')';
      o=(1-mag*(1-PATH_OPACITY_MIN)).toFixed(3);
    }
    if(t!==r.lastT){r.row.style.transform=t;r.lastT=t;}
    if(o!==r.lastO){r.row.style.opacity=o;r.lastO=o;}
  });
}

let _perspectiveRAF=null;
function _onMainAreaScrollForPerspective(){
  if(_perspectiveRAF)return;
  _perspectiveRAF=requestAnimationFrame(()=>{
    _perspectiveRAF=null;
    if(_currentScreen==='learn'){updateLessonPathPerspective();updateCourseFromScroll();}
    // 'score' used to be its own screen; XP and score leaderboards now
    // share the single 'rank' screen (toggled via switchLBTab/_lbActiveTab
    // below), so the score-list is only actually visible/scrolling when
    // both conditions hold.
    if(_currentScreen==='rank'&&_lbActiveTab==='score')updateScoreLBPerspective();
  });
}
(function(){
  const ma=document.querySelector('.main-area');
  if(ma)ma.addEventListener('scroll',_onMainAreaScrollForPerspective);
  window.addEventListener('resize',_onMainAreaScrollForPerspective);
})();

/* Score-leaderboard rows get the same subtle "recede toward the
   viewport edge" scale+opacity motion as the lesson path
   (updateLessonPathPerspective above) — scale()+opacity only, no
   rotateX/translateZ, for the exact overlap/hit-testing reasons
   explained in that function's header comment. Toned down a bit
   (SCORE_SCALE_MIN/SCORE_OPACITY_MIN closer to 1) since these rows are
   plain list items, not path nodes people click precisely. */
const SCORE_SCALE_CENTER=1.0;
const SCORE_SCALE_MIN=0.94;
const SCORE_OPACITY_MIN=0.8;
const SCORE_FLAT_ZONE=0.4;
function updateScoreLBPerspective(){
  const ma=document.querySelector('.main-area');
  const list=document.getElementById('score-list');
  if(!ma||!list)return;
  const vpRect=ma.getBoundingClientRect();
  const vpCenterY=vpRect.top+vpRect.height/2;
  const halfH=vpRect.height/2||1;
  const rampSpan=Math.max(1-SCORE_FLAT_ZONE,0.0001);
  const rows=list.querySelectorAll('.lb-row');
  rows.forEach(row=>{row.style.transform='';});
  rows.forEach(row=>{
    const r=row.getBoundingClientRect();
    const rowCenterY=r.top+r.height/2;
    const rawDelta=(rowCenterY-vpCenterY)/halfH;
    const absDelta=Math.abs(rawDelta);
    const mag=absDelta<=SCORE_FLAT_ZONE?0:Math.min(1,(absDelta-SCORE_FLAT_ZONE)/rampSpan);
    const scale=SCORE_SCALE_CENTER-mag*(SCORE_SCALE_CENTER-SCORE_SCALE_MIN);
    const opacity=1-mag*(1-SCORE_OPACITY_MIN);
    row.style.transform='scale('+scale+')';
    row.style.opacity=opacity;
  });
}

/* Achievements-list cards pop in/out as they scroll in/out of view —
   unlike the lesson path/score leaderboard above, this is NOT a
   continuous scroll-linked transform (no shrinking/fading as a card
   nears the viewport edge); each card just toggles its pop
   transition, via the .ach-in-view class (see the matching CSS
   transition on .ach-card/.ach-card.ach-in-view in style.css) —
   .ach-in-view is added the moment a card enters view and removed
   the moment it leaves, in either scroll direction, so it can pop
   back in every time it re-enters rather than only once ever.
   Re-run from renderAchievements() every time the list's HTML is
   rebuilt, since that always creates fresh DOM nodes the old
   observer/elements no longer point at. */
let _achObserver=null;
function setupAchievementsScrollReveal(){
  const ma=document.querySelector('.main-area');
  const list=document.getElementById('achievements-list');
  if(!list)return;
  const cards=list.querySelectorAll('.ach-card');
  if(_achObserver)_achObserver.disconnect();
  // No IntersectionObserver support (very old browser) — just show
  // every card immediately rather than leaving them permanently
  // invisible at opacity:0.
  if(typeof IntersectionObserver==='undefined'){
    cards.forEach(c=>c.classList.add('ach-in-view'));
    return;
  }
  _achObserver=new IntersectionObserver((entries)=>{
    entries.forEach(entry=>{
      entry.target.classList.toggle('ach-in-view',entry.isIntersecting);
      // no unobserve() here — kept under watch permanently so it can
      // pop in/out again every time it crosses the viewport edge.
    });
  },{root:ma||null,threshold:0.01});
  // Two nested rAFs guarantee the browser has actually painted the
  // opacity:0/translateY starting state at least once before we start
  // observing. Without this, a card that's already on-screen the
  // instant the tab opens can have its .ach-in-view class added in the
  // very same frame as its first-ever paint — the browser then never
  // renders the "invisible" state at all, so the pop transition is
  // skipped and the card just appears fully visible with no animation.
  requestAnimationFrame(()=>requestAnimationFrame(()=>{
    cards.forEach(c=>_achObserver&&_achObserver.observe(c));
  }));
}

/* AUTH */
(function(){
  // Clears the red "invalid" highlight on any auth field the moment
  // the person starts typing in it again — applies to every required
  // field across both panels, not just reg-name.
  ['reg-name','reg-email','reg-pass','login-email','login-pass'].forEach(id=>{
    const el=document.getElementById(id);
    if(el)el.addEventListener('input',()=>el.classList.remove('invalid'));
  });
})();
// Highlights (and returns the first of) any empty field among the
// given ids — shared by doRegister()/doLogin() so every required
// field gets the same red-border treatment reg-name already had,
// not just the name field.
function validateRequiredFields(ids){
  let firstInvalid=null;
  ids.forEach(id=>{
    const el=document.getElementById(id);
    if(!el)return;
    if(!el.value.trim()){
      el.classList.add('invalid');
      if(!firstInvalid)firstInvalid=el;
    }else{
      el.classList.remove('invalid');
    }
  });
  return firstInvalid;
}
function switchAuthTab(tab,el){
  document.querySelectorAll('.auth-tab').forEach(t=>t.classList.remove('active'));
  el.classList.add('active');
  const reg=document.getElementById('auth-register'),log=document.getElementById('auth-login');
  reg.style.display=tab==='register'?'block':'none';
  log.style.display=tab==='login'?'block':'none';
  // Clear every field on both panels on every switch — not just the
  // panel being hidden, so leftover text can't reappear on either side
  // no matter which direction you switch. Also clears the red
  // "invalid" highlight so a half-filled, flagged form doesn't carry
  // that state over to the other tab.
  ['reg-name','reg-email','reg-pass','login-email','login-pass'].forEach(id=>{
    const field=document.getElementById(id);
    if(field){field.value='';field.classList.remove('invalid');}
  });
  // Re-trigger the slideUpFade entrance on the panel being shown.
  // A class that's already applied won't restart its animation, so
  // it's removed, forced to reflow, then re-added — same pattern the
  // rest of the app avoids needing because those panels get freshly
  // created/shown rather than toggled back and forth.
  const shown=tab==='register'?reg:log;
  shown.classList.remove('auth-anim');
  void shown.offsetWidth;
  shown.classList.add('auth-anim');
}
/* Leaderboard XP<->score toggle (screen-rank) — same swap pattern as
   switchAuthTab above, just without the form-field clearing (there's
   nothing to clear here). _lbActiveTab is read by the scroll-
   perspective listener and by renderScoreLB()'s post-render hook
   below to decide whether the score tab's subtle scroll motion should
   currently be running. */
let _lbActiveTab='xp';
/* leaderboard categories, ONLY for the best-score board (the XP board is one total, no categories).
   'letters' = flashcard best with letters, 'signs' = flashcard best with signs, 'all' = best of everything (state.score). */
let _lbCat='all';
const LB_SCORE_FIELD={letters:'scoreLetters',signs:'scoreSigns',all:'score'};
function switchLBCat(cat,el){
  _lbCat=cat;
  document.querySelectorAll('.lb-cat').forEach(t=>t.classList.remove('active'));
  if(el)el.classList.add('active');
  renderScoreLB();
}
/* Old accounts have no per-category best scores: the best flashcard score so far was a letters score, so scoreLetters = score,
   scoreSigns = 0. Runs once after login, then saves so the account appears on the category boards. */
function ensureSplitFields(){
  if(state.isGuest)return;
  if(state.scoreLetters!==undefined&&state.scoreSigns!==undefined)return;
  if(state.scoreLetters===undefined)state.scoreLetters=state.score||0;
  if(state.scoreSigns===undefined)state.scoreSigns=0;
  if(typeof window.fbSaveState==='function')window.fbSaveState();
}
window.ensureSplitFields=ensureSplitFields;
function switchLBTab(tab,el){
  _lbActiveTab=tab;
  document.querySelectorAll('.lb-tab').forEach(t=>t.classList.remove('active'));
  el.classList.add('active');
  document.getElementById('lb-panel-xp').style.display=tab==='xp'?'block':'none';
  document.getElementById('lb-panel-score').style.display=tab==='score'?'block':'none';
  const cats=document.querySelector('.lb-cats');if(cats)cats.style.display=tab==='score'?'flex':'none';   // categories only for the score board
  // Switching TO the score panel needs one perspective pass right
  // away — otherwise rows sit at whatever transform they were left at
  // (or none at all, if this is the first time the panel's been shown)
  // until the next scroll/resize event happens to fire.
  if(tab==='score')requestAnimationFrame(updateScoreLBPerspective);
}

// Thai toast text for the Firebase Auth error codes users can
// actually hit here (bad email format, weak password, wrong
// password, popup closed early, etc). Falls back to a generic
// message for anything not explicitly mapped.
function authErrorMessage(err){
  const code=err&&err.code;
  const map={
    'auth/email-already-in-use':'อีเมลนี้ถูกใช้สมัครแล้ว',
    'auth/invalid-email':'รูปแบบอีเมลไม่ถูกต้อง',
    'auth/weak-password':'รหัสผ่านสั้นเกินไป (อย่างน้อย 6 ตัวอักษร)',
    'auth/user-not-found':'ไม่พบบัญชีผู้ใช้นี้',
    'auth/wrong-password':'รหัสผ่านไม่ถูกต้อง',
    'auth/invalid-credential':'อีเมลหรือรหัสผ่านไม่ถูกต้อง',
    'auth/popup-closed-by-user':'ปิดหน้าต่างเข้าสู่ระบบก่อนเสร็จสิ้น',
    'auth/too-many-requests':'พยายามเข้าสู่ระบบบ่อยเกินไป ลองใหม่ภายหลัง',
    'auth/network-request-failed':'เชื่อมต่อเครือข่ายไม่สำเร็จ กรุณาลองใหม่',
    'auth/operation-not-allowed':'ผู้ให้บริการเข้าสู่ระบบนี้ยังไม่ได้เปิดใช้งานใน Firebase Console',
    'auth/unauthorized-domain':'โดเมนนี้ยังไม่ได้รับอนุญาตใน Firebase Console (Authentication → Settings → Authorized domains)',
    'permission-denied':'ไม่มีสิทธิ์เข้าถึงฐานข้อมูล ตรวจสอบ Firestore Rules',
    'unavailable':'เชื่อมต่อฐานข้อมูลไม่สำเร็จ กรุณาลองใหม่',
  };
  return map[code]||'เกิดข้อผิดพลาด กรุณาลองใหม่';
}
// Actual sign-up/sign-in now goes through Firebase (see
// js/firebase/firebase-init.js — window.fbRegister/fbLogin/
// fbGoogleSignIn). This function only validates the form and hands
// off; on success, firebase-init.js's onAuthStateChanged listener is
// what actually flips state.isGuest and calls enterApp(), since that
// listener is also what fires on a returning user's page reload —
// keeping ALL "just got signed in" handling in one place avoids
// doing it twice.
// Shared "is the Firebase module actually usable yet" guard for the
// three auth entry points below (doRegister/doLogin/signInWithGoogle).
// Two different failure modes land here, and they need different
// toasts because only one of them ever resolves on its own:
//   1. Still loading (slow connection) — window.fb* isn't defined
//      YET but will be any moment. "wait and try again" is correct.
//   2. Opened straight from disk (location.protocol === 'file:') —
//      firebase-init.js is a type="module" script, and browsers
//      refuse to load ES modules over file:// at all (a CORS-style
//      security restriction, not a bug in this app). window.fb* will
//      NEVER become defined no matter how long you wait, so this
//      case gets its own message telling you to serve the folder
//      over http:// instead (e.g. VS Code's "Live Server" extension,
//      or `npx serve` / `python -m http.server` from the project
//      folder) rather than double-clicking index.html.
function authSystemNotReady(){
  if(location.protocol==='file:'){
    showToast('เปิดไฟล์จากเครื่องโดยตรงใช้ระบบเข้าสู่ระบบไม่ได้ กรุณารันผ่านเว็บเซิร์ฟเวอร์ (เช่น Live Server) แล้วเปิดผ่าน http://');
  }else{
    showToast('ระบบเข้าสู่ระบบยังโหลดไม่เสร็จ กรุณารอสักครู่แล้วลองใหม่');
  }
}
async function doRegister(){
  const n=document.getElementById('reg-name').value.trim();
  const email=document.getElementById('reg-email').value.trim();
  const pass=document.getElementById('reg-pass').value;
  const firstInvalid=validateRequiredFields(['reg-name','reg-email','reg-pass']);
  if(firstInvalid){
    firstInvalid.focus();
    showToast('กรุณากรอกข้อมูลให้ครบทุกช่อง');
    return;
  }
  // firebase-init.js is a deferred module script — on a slow
  // connection it's possible (though rare) for someone to click
  // submit before it's finished loading/running. Guard instead of
  // letting it throw a raw "not a function" past the try/catch below.
  if(typeof window.fbRegister!=='function'){
    authSystemNotReady();
    return;
  }
  // BUG FIX: onAuthStateChanged (firebase-init.js) fires as soon as
  // createUserWithEmailAndPassword() resolves inside fbRegister() below
  // — which can happen BEFORE fbRegister's own later awaits
  // (updateProfile()'s displayName write, createUserDoc()'s Firestore
  // write) have finished. When that race goes the wrong way,
  // onAuthStateChanged finds no Firestore doc yet AND a still-empty
  // user.displayName, so its fallback
  // (`user.displayName || window.state.name || 'ผู้ใช้งาน'`) had
  // nothing usable to fall back to except the guest default — the
  // typed name was silently discarded and never re-applied once
  // updateProfile/createUserDoc did complete, since onAuthStateChanged
  // only runs once per sign-in. Pre-seeding window.state.name with the
  // typed name here means that fallback already has the right value
  // no matter which way the race goes.
  window.state.name=n;
  try{
    await window.fbRegister(n,email,pass);
    showToast('สมัครสมาชิกสำเร็จแล้ว');
    // Clear the form now that the account exists — otherwise the old
    // values just sit there behind the auth page, waiting to be seen
    // again (e.g. next time this browser hits the register tab, or if
    // logout ever routes back through here).
    document.getElementById('reg-name').value='';
    document.getElementById('reg-email').value='';
    document.getElementById('reg-pass').value='';
  }catch(err){
    showToast(authErrorMessage(err));
  }
}
async function doLogin(){
  const email=document.getElementById('login-email').value.trim();
  const pass=document.getElementById('login-pass').value;
  const firstInvalid=validateRequiredFields(['login-email','login-pass']);
  if(firstInvalid){
    firstInvalid.focus();
    showToast('กรุณากรอกข้อมูลให้ครบทุกช่อง');
    return;
  }
  if(typeof window.fbLogin!=='function'){
    authSystemNotReady();
    return;
  }
  try{
    await window.fbLogin(email,pass);
    showToast('เข้าสู่ระบบสำเร็จแล้ว');
    document.getElementById('login-email').value='';
    document.getElementById('login-pass').value='';
  }catch(err){
    showToast(authErrorMessage(err));
  }
}
// Bound to BOTH the register and login panels' Google buttons (same
// action either way — Firebase creates the account on first sign-in
// automatically, see fbGoogleSignIn in firebase-init.js).
async function signInWithGoogle(){
  if(typeof window.fbGoogleSignIn!=='function'){
    authSystemNotReady();
    return;
  }
  try{
    await window.fbGoogleSignIn();
    showToast('เข้าสู่ระบบด้วย Google สำเร็จแล้ว');
  }catch(err){
    showToast(authErrorMessage(err));
  }
}
function enterApp(){
  document.getElementById('page-auth').classList.remove('active');
  document.getElementById('page-main').classList.add('active');
  // Always land on the lesson path after a successful register/login —
  // previously this just revealed page-main "as-is", which happened to
  // still work when the guest's last screen was already 'learn', but
  // left them stranded wherever they'd navigated to before (e.g.
  // profile) instead of dropping them straight into lessons every time.
  showScreen('learn');
  renderAll();
}
// Reverse of enterApp() — used by the guest CTA popup and the
// profile-nav-as-login-button (handleProfileNav below). Unlike
// doLogout(), this never touches `state`: a guest's in-progress XP/
// lesson progress must survive the trip to the auth page and back
// (or through to a real doRegister()/doLogin() call), so nothing here
// resets it.
function goToAuthPage(){
  document.getElementById('page-main').classList.remove('active');
  document.getElementById('page-auth').classList.add('active');
}
// Auth card's close (X) button — dismisses the auth page and goes
// back to the lesson page as a guest, same no-reset rule as
// goToAuthPage(): nothing in `state` changes, so any progress made
// as a guest before opening the auth page is still there after
// closing it.
function closeAuthPage(){
  document.getElementById('page-auth').classList.remove('active');
  document.getElementById('page-main').classList.add('active');
}
// The sidebar/bottom-nav "profile" button now doubles as the way a
// guest gets to the auth page (renamed to "เข้าสู่ระบบ" for them by
// updateGuestUI()) — logged-in users still just see their profile.
function handleProfileNav(){
  if(state.isGuest){goToAuthPage();}
  else{showScreen('profile');}
}

/* NAV
   ------------------------------------------------------------
   All screens (learn/achievements/rank/profile) share a single scrollable
   .main-area — only the active .screen-inner is display:block, the
   rest are display:none — so there's only ONE scrollTop for however
   many screens exist. Switching screens without saving/restoring it
   meant the scroll position always got silently clobbered: e.g.
   scroll deep into 'learn', flip to the (shorter) 'achievements' screen —
   .main-area's scrollTop gets clamped down to achievements' shorter
   scrollHeight — then flip back to 'learn' and the clamped (now
   wrong) value is still sitting there instead of where you left off.
   _scrollPositions remembers each screen's last scrollTop by id so
   it can be restored on re-entry instead of left clamped/at 0. */
let _scrollPositions={};
let _currentScreen='learn';
function showScreen(sc){
  const ma=document.querySelector('.main-area');
  if(ma)_scrollPositions[_currentScreen]=ma.scrollTop;
  // Leaving the flashcard game mid-round must always release
  // the camera. exitFlashcardScreen() also resets the screen back to
  // its start view, so re-entering later never shows a stale mid-round
  // HUD/result from a previous visit.
  if(_currentScreen==='flashcard'&&sc!=='flashcard'&&typeof exitFlashcardScreen==='function')exitFlashcardScreen();

  document.querySelectorAll('.screen-inner').forEach(s=>s.classList.remove('active'));
  document.querySelectorAll('.nav-btn').forEach(b=>b.classList.remove('active'));
  document.querySelectorAll('.bnav-btn').forEach(b=>b.classList.remove('active'));
  document.getElementById('screen-'+sc).classList.add('active');
  const sb=document.querySelector('[data-sc="'+sc+'"]');
  if(sb)sb.classList.add('active');
  const bb=document.querySelector('[data-bsc="'+sc+'"]');
  if(bb)bb.classList.add('active');

  _currentScreen=sc;
  if(ma)ma.scrollTop=_scrollPositions[sc]||0;
  if(sc==='learn')requestAnimationFrame(updateLessonPathPerspective);
  // renderLB()/renderScoreLB() were previously only ever called from
  // renderAll() (page load / login / profile save) — switching TO the
  // rank/score tab itself never re-fetched, so it just showed whatever
  // was last fetched at one of those moments (stale, or still the
  // lessons.js fallback if that moment happened to be before Firebase had
  // loaded). Re-fetching on every visit to the tab is what "leaderboard
  // shows real Firestore data" actually needs in practice.
  // 'rank' now hosts BOTH leaderboards (XP + score, toggled via
  // switchLBTab/_lbActiveTab) — 'score' is no longer a separate
  // screen, so both fetches happen on every visit to 'rank' regardless
  // of which tab is currently showing, same as before the merge.
  if(sc==='rank'){
    renderLB();
    renderScoreLB();
    if(_lbActiveTab==='score')requestAnimationFrame(updateScoreLBPerspective);
  }
  if(sc==='flashcard'&&typeof renderFlashcardBest==='function')renderFlashcardBest();
  // Achievements are derived from state.progress/state.xp (see
  // ACHIEVEMENTS/renderAchievements() above) — no fetch involved,
  // just recomputed fresh on every visit to the tab so a lesson
  // finished elsewhere shows up unlocked immediately on next open.
  if(sc==='achievements'){trackAchievementVisit();renderAchievements();}
  updateGuestUI();
}

/* RENDER */
function renderAll(){
  // s-avatar/p-avatar are <img> tags (see index.html) pointing at one
  // of lessons.js's PROFILE_PICS filenames, not the old emoji character —
  // .src, not .textContent.
  document.getElementById('s-avatar').src=PROFILE_PIC_DIR+(state.profilePic||PROFILE_PICS[0]);
  document.getElementById('s-uname').textContent=state.name;
  document.getElementById('p-avatar').src=PROFILE_PIC_DIR+(state.profilePic||PROFILE_PICS[0]);
  document.getElementById('p-name').textContent=state.name;
  renderLevelStats();
  renderLessons();
  renderLB();
  renderScoreLB();
  renderAchievements();
  renderProfileAchievementPreview();
  if(typeof renderFlashcardBest==='function')renderFlashcardBest();
  updateGuestUI();
}
// Guests get the profile nav slot repurposed as a login/register
// shortcut (label swap, see handleProfileNav above), and see the
// guest-cta popup — but only on the learn screen, so it doesn't
// follow them into achievements/rank where it'd just be noise. Logged-in
// users never see either.
function updateGuestUI(){
  const label=state.isGuest?'เข้าสู่ระบบ':'โปรไฟล์';
  document.querySelectorAll('.nav-profile-label').forEach(el=>{el.textContent=label;});
  const cta=document.getElementById('guest-cta');
  if(cta)cta.style.display=(state.isGuest&&_currentScreen==='learn')?'flex':'none';
  // On phones the guest banner spans the top of the screen; this lets the course card sit below it (style.css .guest-cta-on).
  document.body.classList.toggle('guest-cta-on',!!(state.isGuest&&_currentScreen==='learn'));
}

/* ------------------------------------------------------------
   LESSON ORDERING
   ------------------------------------------------------------
   Render order = UNITS order, then ascending `no` within a
   section, with bonus lessons grouped beside the main lesson
   that shares their `no`. Returns a flat, ordered list of lesson
   objects annotated with `_isFirstOfUnit` (banner placement). */
function orderedLessons(){
  const out=[];
  const allLessons=allLessonsWithBonuses();
  UNITS.forEach(u=>{
    const inSection=allLessons.filter(l=>l.section===u.id);
    const nos=[...new Set(inSection.map(l=>l.no))].sort((a,b)=>a-b);
    nos.forEach((no,i)=>{
      const group=inSection.filter(l=>l.no===no);
      const mains=group.filter(l=>l.mode!=='bonus');
      const bonuses=group.filter(l=>l.mode==='bonus');
      mains.forEach((l,gi)=>out.push({...l,_isFirstOfUnit:i===0&&gi===0,_unit:u.id}));
      bonuses.forEach(l=>out.push({...l,_isFirstOfUnit:false,_unit:u.id,_bonus:true}));
    });
  });
  return out;
}

/* Only main (non-bonus, non-info) lessons gate progression. */
function mainOrder(){return orderedLessons().filter(l=>l.mode!=='bonus'&&l.mode!=='info');}
/* Note: orderedLessons() already merges runtime bonus nodes via allLessonsWithBonuses(). */

function prevGatingLesson(lessonId){
  const main=mainOrder();
  const idx=main.findIndex(l=>l.lesson_id===lessonId);
  return idx>0?main[idx-1]:null;
}

/* ============================================================
   BONUS NODE GENERATION
   ============================================================
   Called lazily from renderLessons(). For each section (except
   u1 which has no prior test pool), picks 1-3 bonus nodes,
   each containing exactly 2 random questions drawn from the
   combined test-question pool of ALL sections that come before
   this one in UNITS order. The random pick is fixed on first
   call (stored in state.bonusNodes) so the same 2 questions
   appear every time a bonus node is opened.

   Bonus nodes are placed beside existing normal lesson nodes
   using random `no` values from the section's normal nodes.
   They carry mode:'bonus' and can never be redone once done. */
function buildTestPool(upToSectionIndex){
  // Returns test-mode questions from earlier sections that this section's
  // bonus nodes may draw from: earlier units of the SAME course, plus any
  // course listed in this course's `bonusFrom` (lessons.js COURSES) — so
  // alphabet questions can appear in the emotions/words bonus nodes and
  // emotion questions in the word bonus nodes. Placeholder camera
  // questions (q.placeholder) are skipped: they have no real check yet.
  const pool=[];
  const target=UNITS[upToSectionIndex];
  const course=COURSES.find(c=>c.id===(target&&target.course));
  const allowed=new Set([target?target.course:'alphabet',...(course?course.bonusFrom:[])]);
  UNITS.slice(0,upToSectionIndex).filter(u=>allowed.has(u.course)).forEach(u=>{
    LESSONS.forEach(l=>{
      if(l.section===u.id&&l.mode==='test'){
        l.questions.forEach(qid=>{
          const q=QUESTIONS[qid];
          if(q&&!q.placeholder)pool.push(q);
        });
      }
    });
  });
  return pool;
}

function seededShuffle(arr,seed){
  // Deterministic Fisher-Yates using a simple LCG so the same seed
  // always produces the same order (reproducible bonus questions).
  const a=arr.slice();
  let s=seed>>>0;
  for(let i=a.length-1;i>0;i--){
    s=(s*1664525+1013904223)>>>0;
    const j=s%(i+1);
    [a[i],a[j]]=[a[j],a[i]];
  }
  return a;
}

function generateBonusNodes(){
  UNITS.forEach((u,uIdx)=>{
    if(uIdx===0)return; // u1: no prior test pool, no bonus nodes
    if(state.bonusNodes[u.id])return; // already generated for this section

    const pool=buildTestPool(uIdx);
    if(pool.length<2)return; // not enough questions to form a bonus node

    // How many bonus nodes for this section? Randomise 1-3.
    // We use the section index as a seed component for reproducibility
    // across re-renders within the same session (state.bonusNodes caches it).
    const seed=uIdx*31337;
    const shuffledPool=seededShuffle(pool,seed);

    const count=1+((seed*7)%3); // 1, 2, or 3
    // Get the no values of normal lessons in this section to attach bonuses beside
    const normalNos=[...new Set(
      LESSONS.filter(l=>l.section===u.id&&l.mode==='normal').map(l=>l.no)
    )].sort((a,b)=>a-b);
    if(!normalNos.length)return;

    const bonuses=[];
    for(let bi=0;bi<count;bi++){
      // Pick 2 questions for this bonus node, offset by bi*2 in the shuffled pool
      const q1=shuffledPool[(bi*2)%shuffledPool.length];
      const q2=shuffledPool[(bi*2+1)%shuffledPool.length];
      const qIds=[q1.question_id,q2.question_id];
      // Attach beside a normal node; cycle through normalNos
      const attachNo=normalNos[bi%normalNos.length];
      bonuses.push({
        lesson_id: u.id+'_bonus'+bi,
        section:   u.id,
        no:        attachNo,
        type:      'mixed',
        mode:      'bonus',
        questions: qIds,
      });
    }
    state.bonusNodes[u.id]=bonuses;
  });
}

/* Returns the flat LESSONS list merged with any generated bonus nodes
   for all sections. Called at the start of orderedLessons(). */
function allLessonsWithBonuses(){
  generateBonusNodes();
  const bonusFlat=Object.values(state.bonusNodes).flat();
  // Filter out any bonus lessons that are already in LESSONS (shouldn't happen,
  // but guards against double-injection if called multiple times).
  const existingIds=new Set(LESSONS.map(l=>l.lesson_id));
  const newBonuses=bonusFlat.filter(b=>!existingIds.has(b.lesson_id));
  return [...LESSONS,...newBonuses];
}

const ZIGZAG_PATTERN=[0,1,2,1,0,-1,-2,-1];
const ZIGZAG_STEP=42;

function lessonIcon(lesson,done,isCurrent){
  if(done)return 'ti-check';
  if(lesson.mode==='bonus')return 'ti-gift';
  if(!isCurrent)return 'ti-star-filled';
  if(lesson.type==='gesture')return 'ti-camera'; // all gesture nodes (normal + test) use the camera icon now
  return lesson.mode==='test'?'ti-shield-half-filled':'ti-hand-click';
}

/* Human-readable label for a lesson, used anywhere a raw lesson_id
   (e.g. 'u1qa1', 'u1tqa', 'u2_bonus0') used to be shown to the player.
   Derived entirely from the lesson object's existing section/no/mode
   fields — no new data added to lessons.js.
     - mode 'normal' (qa1/qa2/g1/g2, or u7's qa/g): "Unit {n} Question {no}"
       `no` already runs 1,2,3,4 across qa1/qa2/g1/g2 (or 1,2 for u7's
       qa/g) in LESSONS, so it's used as-is — this is the "continue
       numbering from qa into g" behavior asked for.
     - mode 'test' (tqa/tg): "Unit {n} Test {k}", where k restarts at 1
       for the first test node in that section (k = no minus however
       many normal-mode nodes precede the tests in that section — 4 for
       u1-u6, 2 for u7 — so tqa/tg become Test 1/Test 2 either way).
     - mode 'bonus': "Bonus Question {k}", where k does NOT reset per
       section — it counts up across the whole app (u2's bonus nodes
       first since u1 never has any, then u3's, then u4's, ...). Found
       by walking UNITS in order and, for each unit, that unit's
       state.bonusNodes[u.id] array in the order generateBonusNodes()
       built it (bi 0,1,2,...), counting every bonus node encountered
       until this exact one is reached. This only counts bonus nodes
       that have actually been generated so far (a later section's
       bonus nodes don't exist in state.bonusNodes until
       generateBonusNodes() reaches them), which is fine since
       generateBonusNodes() always runs section-by-section in the same
       UNITS order every time it's called, so a given bonus node's
       number never changes across calls.
   Info nodes (mode 'info') aren't player-facing lesson attempts (no
   quiz/result screen of their own), so they're left out of this —
   their tooltip is set to their paired lesson's label instead, right
   where node.title is assigned in renderLessons(). */
function lessonDisplayName(lesson){
  // Unit number = position in UNITS (u1..u7 -> 1..7, then e1 -> 8, ...), same
  // numbering as each unit's kicker ('หน่วยที่ N').
  const unitNum=UNITS.findIndex(u=>u.id===lesson.section)+1;
  if(lesson.mode==='bonus'){
    let k=0;
    for(const u of UNITS){
      const arr=state.bonusNodes[u.id];
      if(!arr)continue;
      for(const b of arr){
        k++;
        if(b.lesson_id===lesson.lesson_id)return `Bonus Question ${k}`;
      }
    }
    return `Bonus Question ${k||1}`; // fallback: shouldn't happen, lesson always comes from a generated array
  }
  if(lesson.mode==='test'){
    const normalCount=LESSONS.filter(l=>l.section===lesson.section&&l.mode==='normal').length;
    return `Unit ${unitNum} Test ${lesson.no-normalCount}`;
  }
  return `Unit ${unitNum} Question ${lesson.no}`;
}

/* ------------------------------------------------------------
   NODE STATE (compute + apply)
   ------------------------------------------------------------
   Split out from renderLessons() so the exact same status logic
   can be reused by refreshLessonStates() (see below) to patch an
   existing node in place, instead of tearing the whole path down
   and rebuilding it every time a quiz finishes. Every apply*
   function is safe to call on a node that already exists in the
   DOM — it only ever touches className / icon class / label,
   never structure, so calling it doesn't cause any layout
   flash/re-align of the rest of the path. */
function computeInfoNodeState(l){
  let locked=false;
  if(l.pairWith){
    const gate=prevGatingLesson(l.pairWith);
    locked=!!(gate&&!state.progress[gate.lesson_id]?.completed);
  }
  if(isDevMode())locked=false; // debug: every node unlocked regardless of progress
  return{locked};
}
function applyInfoNodeState(node,l){
  const{locked}=computeInfoNodeState(l);
  node.className='lesson-node info-node'+(locked?' locked':'');
  const ic=node.querySelector('i');
  if(ic)ic.className='ti '+(locked?'ti-lock':'ti-info-circle');
}

function computeBonusNodeState(l){
  const done=!!state.progress[l.lesson_id]?.completed;
  const allL=allLessonsWithBonuses();
  const pairedMain=allL.find(m=>m.section===l.section&&m.no===l.no&&m.mode!=='bonus'&&m.mode!=='info');
  const mainDone=pairedMain?!!state.progress[pairedMain.lesson_id]?.completed:true;
  const locked=isDevMode()?false:!mainDone; // debug: every node unlocked regardless of progress
  return{done,locked};
}
/* Maps a completed bonus node's stored score (always 0/50/100, since
   every bonus node is exactly 2 questions — see generateBonusNodes())
   to a 0-3 star count. Written generically off score rather than a
   {0,50,100}->{0,2,3} lookup table so it still degrades sensibly if a
   bonus node's question count ever changes later. */
function bonusStarCount(score){
  return Math.max(0,Math.min(3,Math.round(score/100*3)));
}
function applyBonusNodeState(node,l){
  const{done,locked}=computeBonusNodeState(l);
  let cls='lesson-node bonus-node bonus-right';
  if(done)cls+=' bonus-done';
  else if(locked)cls+=' bonus-locked';
  node.className=cls;
  const ic=node.querySelector('i');
  if(ic)ic.className='ti '+(done?'ti-check':locked?'ti-lock':'ti-gift');
  // Star badge to the node's right, only populated once done — see
  // bonusStarCount() above and .bonus-stars in style.css.
  const starsEl=node.querySelector('.bonus-stars');
  if(starsEl){
    if(done){
      const score=state.progress[l.lesson_id]?.score??0;
      const count=bonusStarCount(score);
      starsEl.innerHTML=[1,2,3].map(n=>
        `<i class="ti ti-star${n<=count?'-filled':''}${n<=count?' filled':''}"></i>`
      ).join('');
    }else{
      starsEl.innerHTML='';
    }
  }
}

function computeMainNodeState(l){
  const done=!!state.progress[l.lesson_id]?.completed;
  const gate=prevGatingLesson(l.lesson_id);
  const unlocked=isDevMode()?true:(!gate||!!state.progress[gate.lesson_id]?.completed); // debug: every node unlocked regardless of progress
  return{done,unlocked,isCurrent:!done&&unlocked};
}
function applyMainNodeState(node,l){
  const{done,isCurrent}=computeMainNodeState(l);
  node.className='lesson-node '+(done?'done':isCurrent?'current':'locked')+(l.mode==='test'?' test-node':'');
  let lbl=node.querySelector('.node-label');
  if(isCurrent){
    if(!lbl){lbl=document.createElement('div');lbl.className='node-label';lbl.textContent='เริ่มเลย!';node.insertBefore(lbl,node.firstChild);}
  }else if(lbl){
    lbl.remove();
  }
  const ic=node.querySelector('i');
  if(ic)ic.className='ti '+lessonIcon(l,done,isCurrent);
}

function renderLessons(){
  const wrap=document.getElementById('lesson-path');
  wrap.innerHTML='';
  let mainSlot=0;
  let currentRow=null;

  orderedLessons().forEach(l=>{
    if(l._isFirstOfUnit){
      const u=UNITS.find(u=>u.id===l._unit);
      if(u){
        const banner=document.createElement('div');
        banner.className='unit-banner';
        banner.dataset.course=u.course;
        banner.dataset.unit=u.id;
        if(UNITS.find(x=>x.course===u.course).id===u.id)banner.dataset.courseStart='1';
        banner.innerHTML=`<div class="ub-text"><h2>${u.title}</h2></div>`;
        wrap.appendChild(banner);
      }
    }

    if(l.mode==='info'){
      // Info node sits in its own row ABOVE the quiz node it introduces,
      // exactly like a normal node: it takes a zigzag slot and the usual
      // vertical gap (the quiz node follows in the next row).
      const node=document.createElement('div');
      node.dataset.lessonId=l.lesson_id;
      const pairedMain=l.pairWith?LESSONS.find(m=>m.lesson_id===l.pairWith):null;
      node.title=pairedMain?lessonDisplayName(pairedMain):l.lesson_id;
      node.appendChild(document.createElement('i'));
      applyInfoNodeState(node,l);
      node.addEventListener('click',()=>openInfoNode(l));
      const irow=document.createElement('div');
      irow.className='lesson-row info-row';
      irow.dataset.xOffset=ZIGZAG_PATTERN[mainSlot%ZIGZAG_PATTERN.length]*ZIGZAG_STEP;
      irow.style.transition='none';
      irow.appendChild(node);
      wrap.appendChild(irow);
      currentRow=irow;
      mainSlot++;
      return;
    }

    if(l.mode==='bonus'){
      // A bonus node is locked (greyed out, unclickable) when its paired
      // main node — the normal/test lesson sharing the same section+no —
      // hasn't been completed yet. Once the main node is done the bonus
      // becomes available, but can only ever be completed once (no redo).
      const node=document.createElement('div');
      node.dataset.lessonId=l.lesson_id;
      node.title=lessonDisplayName(l);
      node.appendChild(document.createElement('i'));
      const starsEl=document.createElement('div');
      starsEl.className='bonus-stars';
      node.appendChild(starsEl);
      applyBonusNodeState(node,l);
      // Recompute done/locked live at click time (not captured from this
      // closure) so the handler still works correctly after
      // refreshLessonStates() updates the node's visuals in place without
      // recreating it.
      node.addEventListener('click',()=>{
        const{done,locked}=computeBonusNodeState(l);
        if(done){
          showToast('โบนัสนี้ทำเสร็จแล้ว ไม่สามารถทำซ้ำได้','gift');
          return;
        }
        if(locked){
          showToast('ทำบทเรียนหลักให้เสร็จก่อนนะ','lock');
          return;
        }
        startQuiz(l);
      });
      (currentRow||wrap).appendChild(node);
      return;
    }

    const offset=ZIGZAG_PATTERN[mainSlot%ZIGZAG_PATTERN.length]*ZIGZAG_STEP;
    const row=document.createElement('div');
    row.className='lesson-row';
    row.dataset.xOffset=offset;
    row.style.transition='none'; // see note near renderLessons()'s closing rAF

    const node=document.createElement('div');
    node.dataset.lessonId=l.lesson_id;
    node.title=lessonDisplayName(l);
    node.appendChild(document.createElement('i'));
    applyMainNodeState(node,l);
    node.addEventListener('click',()=>{
      const{unlocked}=computeMainNodeState(l);
      if(!unlocked){
        showToast('ทำบทเรียนก่อนหน้าให้เสร็จก่อนนะ','lock');
        return;
      }
      startQuiz(l);
    });

    row.appendChild(node);
    wrap.appendChild(row);
    currentRow=row;
    mainSlot++;
  });

  wrap.dataset.built='1';
  invalidatePathCache();
  updateLessonPathPerspective();
  renderCourseCard();

  // Rows were created with transition:none (set inline above) so this
  // very first positioning pass — which sets transform/opacity on every
  // row — paints instantly instead of animating in from the browser's
  // default "no transform yet" state (the cause of the whole path
  // visibly sliding/fading into place on first load, even though
  // refreshLessonStates() already avoids this for post-quiz updates).
  // Restore the normal CSS transition one frame later so subsequent
  // scroll-driven perspective updates keep their smooth easing.
  requestAnimationFrame(()=>{
    wrap.querySelectorAll('.lesson-row').forEach(r=>{r.style.transition='';});
  });
}

/* ------------------------------------------------------------
   LIGHTWEIGHT STATUS REFRESH
   ------------------------------------------------------------
   Called after finishing/failing a quiz instead of renderLessons().
   The set of nodes, their order, and their positions never changes
   after the very first renderLessons() call (bonus nodes are all
   generated up front and cached in state.bonusNodes) — only which
   nodes are done/locked/current changes. So rather than wiping
   #lesson-path and rebuilding every row (which was causing the
   whole path to visibly flash/re-align on every quiz completion),
   this just walks the existing nodes and patches their class/icon/
   label in place. Positions/offsets are never touched, so
   updateLessonPathPerspective() doesn't even need to re-run. */
function refreshLessonStates(){
  const wrap=document.getElementById('lesson-path');
  if(!wrap||!wrap.dataset.built){renderLessons();return;}
  const all=allLessonsWithBonuses();
  wrap.querySelectorAll('.lesson-node[data-lesson-id]').forEach(node=>{
    const l=all.find(x=>x.lesson_id===node.dataset.lessonId);
    if(!l)return;
    if(l.mode==='info')applyInfoNodeState(node,l);
    else if(l.mode==='bonus')applyBonusNodeState(node,l);
    else applyMainNodeState(node,l);
  });
  renderCourseCard();
}

/* ------------------------------------------------------------
   COURSE CARD (top-right of the lesson path)
   ------------------------------------------------------------
   Small pill (current course + % done) that opens a list of the
   COURSES (lessons.js) with progress bars; picking one smooth-scrolls
   #lesson-path to that course's first .unit-banner (tagged with
   data-course-start in renderLessons()). The highlighted course
   follows the scroll position (updateCourseFromScroll()). Progress
   counts main lessons only (no bonus/info), like the achievements. */
var _courseCardOpen=false;
var _currentCourse='alphabet';
function courseProgress(courseId){
  const ids=new Set(UNITS.filter(u=>u.course===courseId).map(u=>u.id));
  const lessons=mainOrder().filter(l=>ids.has(l.section));
  const done=lessons.filter(l=>state.progress[l.lesson_id]?.completed).length;
  return{done,total:lessons.length,pct:lessons.length?Math.round(done/lessons.length*100):0};
}
function renderCourseCard(){
  const el=document.getElementById('course-card');
  if(!el)return;
  const cur=COURSES.find(c=>c.id===_currentCourse)||COURSES[0];
  const cp=courseProgress(cur.id);
  el.className='course-card'+(_courseCardOpen?' open':'');
  el.innerHTML=`
    <button class="cc-pill" type="button" onclick="toggleCourseCard()" aria-expanded="${_courseCardOpen}">
      <i class="ti ${cur.icon}"></i><span class="cc-pill-title">${cur.title}</span><span class="cc-pill-pct">${cp.pct}%</span>
    </button>
    <div class="cc-list">
      ${COURSES.map(c=>{const p=courseProgress(c.id);return `
        <button class="cc-item${c.id===_currentCourse?' current':''}" type="button" onclick="goToCourse('${c.id}')">
          <i class="ti ${c.icon}"></i>
          <span class="cc-item-main"><span class="cc-item-title">${c.title}</span>
            <span class="cc-bar"><span class="cc-bar-fill" style="width:${p.pct}%"></span></span></span>
          <span class="cc-item-pct">${p.done}/${p.total}</span>
        </button>`;}).join('')}
    </div>`;
}
function toggleCourseCard(){_courseCardOpen=!_courseCardOpen;renderCourseCard();}
function goToCourse(courseId){
  const ma=document.querySelector('.main-area');
  const banner=document.querySelector('#lesson-path .unit-banner[data-course-start="1"][data-course="'+courseId+'"]');
  _courseCardOpen=false;
  _currentCourse=courseId;
  renderCourseCard();
  if(!ma||!banner)return;
  const top=ma.scrollTop+(banner.getBoundingClientRect().top-ma.getBoundingClientRect().top)-70;
  ma.scrollTo({top:Math.max(0,top),behavior:'smooth'});
}
// Course = the last unit banner that has scrolled up past ~40% of the viewport.
function updateCourseFromScroll(){
  const ma=document.querySelector('.main-area');
  if(!ma||!_pathCache)return;
  const line=ma.scrollTop+ma.clientHeight*0.4;
  let found=COURSES[0].id;
  _pathCache.banners.forEach(b=>{if(b.top<=line)found=b.course;});
  if(found!==_currentCourse){_currentCourse=found;renderCourseCard();}
}

// Leaderboard is all-time only, real Firestore data (every
// signed-in user's xp, see fbLoadLeaderboard in
// js/firebase/firebase-init.js). For now this only shows name + XP
// (name + profile picture + XP; no medal styling yet). There is no static sample-data
// fallback (lessons.js's old LB_ALL list was removed) — if the fetch
// fails or isn't ready yet, renderLB() keeps the gray shimmering
// skeleton on screen (YouTube-style placeholder) rather than ever
// showing fake names/XP, and retries a few times automatically as
// firebase-init.js finishes loading. Check devtools console if it's
// stuck on the skeleton longer than that — every attempt logs exactly
// what happened (see the [leaderboard] console lines).
function renderLBSkeleton(rowCount=6){
  const list=document.getElementById('lb-list');
  if(!list)return;
  // Fixed widths (not Math.random()) — renderLBSkeleton() re-runs on
  // every retry and every rank-tab visit, so a random width here made
  // the bars visibly resize each time instead of looking like a
  // single steady loading state. Still varied row-to-row like
  // YouTube's skeleton rows, just no longer changing between renders.
  const nameWidths=[132,98,150,110,142,120];
  let html='';
  for(let i=0;i<rowCount;i++){
    html+=`
      <div class="lb-skel-row">
        <div class="lb-skel-bar lb-skel-rank"></div>
        <div class="lb-skel-bar lb-skel-avatar"></div>
        <div class="lb-skel-bar lb-skel-name" style="max-width:${nameWidths[i%nameWidths.length]}px;"></div>
        <div class="lb-skel-bar lb-skel-xp"></div>
      </div>`;
  }
  list.innerHTML=html;
}
// _lbRetries: how many times THIS renderLB() call chain has retried
// after finding fbLoadLeaderboard undefined (module script still
// loading). Capped so a genuinely broken/missing firebase-init.js
// doesn't retry forever — it just settles on the skeleton and the
// console warning explains why.
async function renderLB(_lbRetries=0){
  const list=document.getElementById('lb-list');
  if(!list)return;
  // Skeleton first, synchronously, before the (possibly slow) Firestore
  // round-trip even starts — this is what makes it show on every rank-
  // tab visit instead of just leaving last render's rows sitting there
  // (or worse, a blank list) while the fetch is in flight. Also covers
  // the retry path below so the shimmer keeps animating instead of
  // sitting static while we wait.
  renderLBSkeleton();
  let data;
  try{
    if(typeof window.fbLoadLeaderboard!=='function'){
      if(_lbRetries<5){
        console.warn('[leaderboard] window.fbLoadLeaderboard is not defined yet — firebase-init.js (a deferred module script) probably hasn\'t finished loading/running yet. Retrying in 400ms (attempt '+(_lbRetries+1)+'/5) — keeping the skeleton up in the meantime.');
        setTimeout(()=>renderLB(_lbRetries+1),400);
      }else{
        console.error('[leaderboard] window.fbLoadLeaderboard still not defined after 5 retries — firebase-init.js likely failed to load (check the Network tab / any red errors above). Leaving the skeleton up rather than showing fake data.');
      }
      return;
    }
    data=await window.fbLoadLeaderboard();
    if(data.length===0){
      console.warn('[leaderboard] Firestore query succeeded but returned ZERO docs. Either the "users" collection is genuinely empty (no one has a synced profile doc yet — a fresh guest session doesn\'t create one until fbSaveState()/createUserDoc() runs), or the query is silently excluded by rules/an index requirement without throwing. Showing just me below either way — an empty real leaderboard is still real data, just you + nobody else yet.');
    }
  }catch(err){
    // Logged with the actual Firebase error code/message so "why is
    // this stuck on the skeleton" is answerable from devtools instead
    // of a silent guess — the most likely causes are: Firestore
    // database not created yet in the Firebase console, or
    // firestore.rules not published/too restrictive to let a signed-in
    // user read the whole users collection (needed for an all-time
    // leaderboard), or (if this fires even while signed OUT) rules that
    // require auth for a read that's being attempted before sign-in.
    // No sample-data fallback anymore — leave the skeleton up so a
    // real (if temporarily broken) state is never disguised as fake
    // placeholder names/XP.
    console.warn('[leaderboard] fbLoadLeaderboard failed, keeping skeleton up (no sample-data fallback) — code:',err&&err.code,'message:',err&&err.message,err);
    return;
  }
  // If I'm signed in and already in the fetched list (I'm a real
  // Firestore row), drop that row so "me" below doesn't duplicate it —
  // `state.xp` is the freshest value anyway (Firestore write is
  // debounced, so the cloud copy can lag a few hundred ms behind).
  const myUid=typeof window.fbCurrentUid==='function'?window.fbCurrentUid():null;
  const rows=myUid?data.filter(r=>r.uid!==myUid):data.slice();
  // Guests never get a "me" row — they have no Firestore profile to
  // rank (no account = no persistent XP), so pretending they have a
  // rank would be showing a number that isn't really tracked anywhere.
  if(!state.isGuest)rows.push({name:state.name,xp:state.xp,profilePic:state.profilePic,isMe:true});
  rows.sort((a,b)=>b.xp-a.xp);
  // #1 on ties too (sort is stable, "me" was pushed last among equal-xp
  // rows, so this only fires when nobody else's xp is strictly higher).
  if(rows[0]&&rows[0].isMe)unlockAchievement('top_rank');
  const rowsHtml=rows.map((r,i)=>`
    <div class="lb-row${r.isMe?' me':''}" style="animation-delay:${Math.min(i*35,350)}ms;">
      <div class="lb-rank">#${i+1}</div>
      <img class="lb-avatar" src="${PROFILE_PIC_DIR+(r.profilePic||PROFILE_PICS[0])}" alt="" onerror="this.src='${PROFILE_PIC_DIR+PROFILE_PICS[0]}';">
      <div class="lb-name">${r.name}${r.isMe?' (คุณ)':''}</div>
      <div class="lb-xp"><span>${r.xp}</span> XP</div>
    </div>`).join('')
    // Guest-only note under the list, pointing them at sign-up — makes
    // it clear why they don't see themselves above instead of just
    // silently omitting them.
    +(state.isGuest?'<div class="lb-guest-note">สมัครสมาชิกเพื่อเก็บ XP และขึ้นกระดานผู้นำ</div>':'');
  // Cross-fade the skeleton out before swapping in the real rows,
  // which then stagger in one-by-one (via the animation-delay set
  // above + the lbRowIn keyframe on .lb-row in style.css) instead of
  // just popping in all at once.
  list.classList.add('lb-swap');
  setTimeout(()=>{
    list.innerHTML=rowsHtml;
    list.classList.remove('lb-swap');
  },180);
}

/* ------------------------------------------------------------
   SCORE LEADERBOARD ("คะแนนสูงสุด" tab)
   ------------------------------------------------------------
   Same shape as the XP leaderboard above (renderLB/renderLBSkeleton),
   just ranked by the new state.score field instead of xp — see
   window.fbLoadScoreLeaderboard in firebase-init.js. */
function renderScoreLBSkeleton(rowCount=6){
  const list=document.getElementById('score-list');
  if(!list)return;
  const nameWidths=[132,98,150,110,142,120];
  let html='';
  for(let i=0;i<rowCount;i++){
    html+=`
      <div class="lb-skel-row">
        <div class="lb-skel-bar lb-skel-rank"></div>
        <div class="lb-skel-bar lb-skel-avatar"></div>
        <div class="lb-skel-bar lb-skel-name" style="max-width:${nameWidths[i%nameWidths.length]}px;"></div>
        <div class="lb-skel-bar lb-skel-xp"></div>
      </div>`;
  }
  list.innerHTML=html;
}
async function renderScoreLB(_lbRetries=0){
  const list=document.getElementById('score-list');
  if(!list)return;
  renderScoreLBSkeleton();
  const catAtFetch=_lbCat;
  let data;
  try{
    if(typeof window.fbLoadScoreLeaderboard!=='function'){
      if(_lbRetries<5){
        setTimeout(()=>renderScoreLB(_lbRetries+1),400);
      }else{
        console.error('[score-leaderboard] window.fbLoadScoreLeaderboard still not defined after 5 retries — firebase-init.js likely failed to load.');
      }
      return;
    }
    data=await window.fbLoadScoreLeaderboard(LB_SCORE_FIELD[catAtFetch]);
  }catch(err){
    console.warn('[score-leaderboard] fbLoadScoreLeaderboard failed, keeping skeleton up — code:',err&&err.code,'message:',err&&err.message,err);
    return;
  }
  const myUid=typeof window.fbCurrentUid==='function'?window.fbCurrentUid():null;
  const rows=myUid?data.filter(r=>r.uid!==myUid):data.slice();
  if(!state.isGuest)rows.push({name:state.name,score:state[LB_SCORE_FIELD[catAtFetch]]||0,profilePic:state.profilePic,isMe:true});
  rows.sort((a,b)=>b.score-a.score);
  // Same #1-on-ties reasoning as renderLB()'s XP-leaderboard check.
  if(rows[0]&&rows[0].isMe&&(catAtFetch==='all'||(rows[0].score||0)>0))unlockAchievement('top_rank');   // any board counts
  if(rows[0]&&rows[0].isMe&&(rows[0].score||0)>0)trackScoreTop(catAtFetch);   // top_of_top
  const rowsHtml=rows.map((r,i)=>`
    <div class="lb-row${r.isMe?' me':''}" style="animation-delay:${Math.min(i*35,350)}ms;">
      <div class="lb-rank">#${i+1}</div>
      <img class="lb-avatar" src="${PROFILE_PIC_DIR+(r.profilePic||PROFILE_PICS[0])}" alt="" onerror="this.src='${PROFILE_PIC_DIR+PROFILE_PICS[0]}';">
      <div class="lb-name">${r.name}${r.isMe?' (คุณ)':''}</div>
      <div class="lb-xp"><span>${r.score}</span> คะแนน</div>
    </div>`).join('')
    +(state.isGuest?'<div class="lb-guest-note">สมัครสมาชิกเพื่อเก็บคะแนนและขึ้นกระดานผู้นำ</div>':'');
  list.classList.add('lb-swap');
  setTimeout(()=>{
    list.innerHTML=rowsHtml;
    list.classList.remove('lb-swap');
    if(_currentScreen==='rank'&&_lbActiveTab==='score')requestAnimationFrame(updateScoreLBPerspective);
  },180);
}

/* ============================================================
   ACHIEVEMENTS ("ความสำเร็จ" tab)
   ------------------------------------------------------------
   Replaces the old daily/monthly "quest" tab (static hardcoded HTML,
   no JS behind it at all — see the removed #screen-quest markup).
   Achievements are a FIXED static list (defined once below, not
   generated/rotated) — each one's unlocked/locked state and progress
   fraction are derived live from `state` every time the tab is
   opened (same recompute-on-visit pattern as renderLB/renderScoreLB
   in showScreen()), so nothing extra needs to be written to
   state/Firestore to support this — no new schema field, this reads
   state.progress/state.xp that already exist.

   Kinds of achievement:
     - 'unit'          : unlocked once every main lesson (LESSONS
                         entries, NOT counting generated bonus nodes —
                         see allLessonsWithBonuses()) in a.section is
                         state.progress[id].completed.
     - 'flawless_lessons': unlocked once every lesson_id in a.lessonIds
                         is completed AND was completed with zero wrong
                         answers (state.progress[id].flawless — set by
                         finishLesson(), see there).
     - 'reach_section' : unlocked once the gating lesson before
                         a.gateLessonId is completed (or there isn't
                         one) — i.e. that section has become reachable,
                         whether or not anything in it has been done yet.
     - 'no_info_all'   : unlocked once every main lesson across every
                         unit is completed AND state.milestones.
                         infoNodeOpened has never been set (see
                         openInfoNode()).
     - 'no_wrong_all'  : same "every main lesson, every unit" condition
                         as above, but gated on state.milestones.
                         wrongEver instead (see recordQuestionResult()).
     - 'complete_main' : unlocked once every main lesson across every
                         unit is completed (bonus/info excluded).
     - 'complete_all'  : same as above but bonus nodes are also
                         required (info nodes still excluded — they
                         have no quiz/progress of their own).
     - 'wrong_in_node' : unlocked once any single lesson_id's tally in
                         state.wrongCounts reaches a.threshold.
     - 'event'         : has no live condition to recompute at all —
                         unlocked directly via unlockAchievement() at
                         the exact moment it happens (first wrong
                         answer, successful register/login, dev-mode
                         combo, 1-heart-left, profile pic change).
                         checkAchievements()'s sweep skips these
                         entirely; computeAchievementStatus() only ever
                         reports back whatever's already stored for them.
     - 'level'         : unlocked once calcLevel(state.xp) reaches
                         a.threshold.
     - 'all_achievements': unlocked once every OTHER achievement in this
                         array (any kind, including 'event' and hidden
                         ones) is unlocked — see unlockAchievement()'s
                         extra checkAchievements() call for how this
                         still gets caught right away even when the
                         last dependency to unlock is an 'event' kind.
   `hidden:true` keeps an achievement's title/description/icon replaced
   with "???" in renderAchievements() until it's unlocked (see there) —
   used for the secret dev-mode one so it isn't a walkthrough for how to
   find it.
   Add more by pushing another entry below — renderAchievements()
   doesn't need to change for any kind. */
const CHEATER_ID='cheater';
// stay unlocked after dev mode is turned off (everything else unlocked in dev mode is undone)
const DEV_PERMANENT_ACHIEVEMENTS=['secret_unlock',CHEATER_ID];
function checkCheaterAchievement(){
  // all achievements except this one and the derived 'true_completionist' (all_achievements kind) are unlocked
  const need=ACHIEVEMENTS.filter(a=>a.id!==CHEATER_ID&&a.kind!=='all_achievements');
  if(need.every(a=>state.achievements&&state.achievements[a.id]))unlockAchievement(CHEATER_ID);
}
const ACHIEVEMENTS=[
  {id:'new_start',kind:'unit',section:'u1',icon:'ti-flag-filled',
    title:'จุดเริ่มต้น',desc:'ทำหน่วยที่ 1 ให้เสร็จ'},
  {id:'fast_learner',kind:'flawless_lessons',lessonIds:['u1tqa','u1tg'],icon:'ti-rocket',
    title:'หัวไว',desc:'ผ่านแบบทดสอบของหน่วยที่ 1 โดยไม่ตอบผิดเลยแม้แต่ข้อเดียว'},
  {id:'things_move',kind:'reach_section',gateLessonId:'u7qa',icon:'ti-arrows-shuffle',
    title:'มีแบบขยับด้วยเหรอ?',desc:'ไปถึงหน่วยตัวอักษร J และ Z'},
  {id:'veteran',kind:'no_info_all',icon:'ti-brain',
    title:'มือเก๋า',desc:'จบทุกหน่วยการเรียนโดยไม่เปิดดูท่ามือเลยสักครั้ง'},
  {id:'learn_from_mistake',kind:'event',icon:'ti-mood-sad',
    title:'เรียนรู้จากความผิดพลาด',desc:'ตอบคำถามผิดเป็นครั้งแรก'},
  {id:'check_info_nodes',kind:'wrong_in_node',threshold:10,icon:'ti-info-circle',
    title:'ได้กดดูท่ามือหรือป่าว?',desc:'ตอบผิดครบ 10 ครั้งในบทเรียนเดียวกัน'},
  {id:'first_hand',kind:'event',icon:'ti-hand-click',
    title:'มือหนึ่ง',desc:'สมัครสมาชิกหรือเข้าสู่ระบบสำเร็จเป็นครั้งแรก'},
  {id:'no_hit_gaming',kind:'no_wrong_all',icon:'ti-shield-check',
    title:'ไร้ที่ติ',desc:'จบทุกหน่วยการเรียนโดยไม่ตอบผิดแม้แต่ครั้งเดียว'},
  {id:'last_chance',kind:'event',icon:'ti-heart',
    title:'โอกาสสุดท้าย',desc:'เหลือหัวใจดวงสุดท้ายในบทเรียนแบบทดสอบ'},
  {id:'completionist',kind:'complete_all',icon:'ti-trophy',
    title:'เก็บหมด',desc:'ทำทุกบทเรียนให้เสร็จ รวมถึงบทเรียนโบนัสทั้งหมด'},
  {id:'tutorial_complete',kind:'complete_main',icon:'ti-checklist',
    title:'จบบทเรียนหลัก',desc:'จบบทเรียนหลักทั้งหมด (ไม่รวมบทเรียนโบนัส)'},
  {id:'secret_unlock',kind:'event',hidden:true,icon:'ti-terminal-2',
    title:'ปลดล็อกความลับ!',desc:'ปลดล็อกโหมดทดสอบระบบ'},
  {id:'new_look',kind:'event',icon:'ti-user-edit',
    title:'โฉมใหม่!',desc:'เปลี่ยนรูปโปรไฟล์'},
  {id:'reset_again',kind:'event',icon:'ti-refresh',
    title:'มาอีกแล้วเหรอ?',desc:'รีเซ็ตความคืบหน้าในหน้าตั้งค่า'},
  {id:'fc_first_session',kind:'event',icon:'ti-device-gamepad-2',
    title:'มีเกมด้วยเหรอ?',desc:'เล่นเกมทายท่ามือจนจบเกมสักครั้ง'},
  {id:'fc_streak_20',kind:'event',icon:'ti-flame',
    title:'รู้สึกร้อนๆ ไหม?',desc:'ทายท่ามือถูกต่อเนื่อง 20 ตัวโดยไม่พลาดในเกมทายท่ามือ'},
  {id:'top_rank',kind:'event',icon:'ti-crown',
    title:'ข้างบนนี้วิวดีจังเลย',desc:'ขึ้นอันดับ 1 ในกระดานผู้นำอันดับใดก็ได้'},
  {id:'true_completionist',kind:'all_achievements',icon:'ti-award',
    title:'เก็บหมดแบบของจริง 100%',desc:'ปลดล็อกความสำเร็จอื่นทั้งหมด รวมถึงความสำเร็จลับด้วย'},
  {id:'true_master',kind:'level',threshold:100,icon:'ti-medal',
    title:'เซียนตัวจริง',desc:'ไปถึงเลเวล 100'},
  {id:'halfway',kind:'level',threshold:50,icon:'ti-hourglass-low',
    title:'มาได้ครึ่งทางแล้ว',desc:'ไปถึงเลเวล 50'},
  {id:'rage_quit',kind:'event',icon:'ti-mood-angry',
    title:'หัวร้อนเหรอ?',desc:'กดปุ่มลบบัญชี'},
  {id:'lvl_67',kind:'level',threshold:67,icon:'ti-target-arrow',
    title:'เฮ้อ~ ซิกเซเว่น',desc:'ไปถึงเลเวล 67'},
  {id:'lvl_69',kind:'level',threshold:69,icon:'ti-mood-wink',
    title:'มีมนี้เก่ายัง?',desc:'ไปถึงเลเวล 69'},
  {id:'drink_water',kind:'event',icon:'ti-droplet',
    title:'อย่าลืมดื่มน้ำด้วยนะ',desc:'อยู่ในเว็บไซต์ต่อเนื่อง 1 ชั่วโมงโดยไม่ปิดแท็บ'},
  {id:'ordis_secret',kind:'event',hidden:true,icon:'ti-robot',
    title:'Ordis!? ตามมาถึงนี้เลยเหรอ?',desc:'ได้ยินเสียงคุ้นเคยจากเกมอื่นดังขึ้นมาโดยไม่ทราบสาเหตุ'},
  {id:'fc_on_fire',kind:'event',icon:'ti-flame',
    title:'ไฟไหม้!~!',desc:'เล่นเกมทายท่ามือด้วยต่อเนื่องจนไฟไหม้'},
  {id:'mystery_person',kind:'complete_main_guest',icon:'ti-user-question',
    title:'บุคคลปริศนา',desc:'จบทุกหน่วยการเรียนโดยไม่สมัครสมาชิกหรือเข้าสู่ระบบ'},
  {id:'top_of_top',kind:'event',icon:'ti-crown',
    title:'ท็อปของท็อป',desc:'ขึ้นอันดับ 1 ในกระดานคะแนนสูงสุดทุกหมวด (ทั้งหมด ตัวอักษร ท่ามือ)'},
  {id:'basics_of_basics',kind:'course',course:'alphabet',icon:'ti-abc',
    title:'พื้นฐานของพื้นฐาน',desc:'จบหน่วยตัวอักษรทั้งหมด (A–Z)'},
  {id:'want_them_all',kind:'event',icon:'ti-eye-check',
    title:'อยากเก็บหมดหรอ',desc:'เปิดหน้าความสำเร็จ 10 ครั้งภายใน 10 นาที'},
  {id:'level_unlock',kind:'signs_unlocked',icon:'ti-lock-open',
    title:'ปลดล็อคระดับ',desc:'ปลดล็อกท่ามือในเกมทายท่ามือ'},
  {id:'fast_hands',kind:'event',icon:'ti-bolt',
    title:'เร็วไว ทะลุมือ',desc:'ทำท่ามือผ่านในโหนดทดสอบภายใน 5 วินาที'},
  {id:'cheater',kind:'event',hidden:true,icon:'ti-mood-puzzled',
    title:'อยากโกงขนาดนั้นเลยเหรอ?',desc:'ปลดล็อกความสำเร็จทั้งหมดด้วยโหมดทดสอบระบบ'},
  {id:'can_speak',kind:'course',course:'words',icon:'ti-message-circle',
    title:'พูดได้แล้ว!',desc:'จบคอร์สคำศัพท์ทั้งหมด'},
  {id:'so_this_feeling',kind:'course',course:'emotions',icon:'ti-mood-smile',
    title:'นี้สินะ ความรู้สึก',desc:'จบคอร์สอารมณ์ทั้งหมด'},
];

/* 'want_them_all': opening the achievements page 10 times within 10 minutes (kept in memory, this sitting only). */
const _achVisits=[];
function trackAchievementVisit(){
  const now=Date.now();
  _achVisits.push(now);
  while(_achVisits.length&&now-_achVisits[0]>600000)_achVisits.shift();
  if(_achVisits.length>=10)unlockAchievement('want_them_all');
}

/* 'top_of_top': #1 on the best-score board of EVERY category (all, letters, signs). Remembered in state.milestones.scoreTop. */
function trackScoreTop(cat){
  if(state.isGuest)return;
  if(!state.milestones)state.milestones={infoNodeOpened:false,wrongEver:false};
  const t=state.milestones.scoreTop||(state.milestones.scoreTop={});
  if(!t[cat]){
    t[cat]=true;
    if(typeof window.fbSaveState==='function')window.fbSaveState();
  }
  if(t.all&&t.letters&&t.signs)unlockAchievement('top_of_top');
}

/* Live current/target/met numbers for one achievement, given the
   CURRENT xp/progress/milestones — this part is cheap (at most a full
   scan of mainOrder()/allLessonsWithBonuses(), each well under a
   couple hundred entries) and still recomputed on every render, since
   it's just what feeds the progress bar/label for achievements NOT yet
   unlocked. `met` is the raw condition check; it is NOT the same as
   "unlocked" — see achievementProgress()/checkAchievements() below for
   why those are kept separate. */
function computeAchievementStatus(a){
  if(a.kind==='unit'){
    const lessons=LESSONS.filter(l=>l.section===a.section&&l.mode!=='info');
    const done=lessons.filter(l=>state.progress[l.lesson_id]?.completed).length;
    return {met:done>=lessons.length&&lessons.length>0,current:done,target:lessons.length,label:`${done}/${lessons.length} บทเรียน`};
  }
  if(a.kind==='flawless_lessons'){
    const done=a.lessonIds.filter(id=>state.progress[id]?.completed&&state.progress[id]?.flawless).length;
    return {met:done>=a.lessonIds.length,current:done,target:a.lessonIds.length,label:`${done}/${a.lessonIds.length} แบบทดสอบ`};
  }
  if(a.kind==='reach_section'){
    const gate=prevGatingLesson(a.gateLessonId);
    const met=!gate||!!state.progress[gate.lesson_id]?.completed;
    return {met,current:met?1:0,target:1,label:met?'ไปถึงแล้ว':'ยังไปไม่ถึง'};
  }
  if(a.kind==='no_info_all'){
    const lessons=mainOrder();
    const done=lessons.filter(l=>state.progress[l.lesson_id]?.completed).length;
    const disqualified=!!(state.milestones&&state.milestones.infoNodeOpened);
    const met=done>=lessons.length&&lessons.length>0&&!disqualified;
    return {met,disqualified,current:done,target:lessons.length,label:`${done}/${lessons.length} บทเรียน`};
  }
  if(a.kind==='no_wrong_all'){
    const lessons=mainOrder();
    const done=lessons.filter(l=>state.progress[l.lesson_id]?.completed).length;
    const disqualified=!!(state.milestones&&state.milestones.wrongEver);
    const met=done>=lessons.length&&lessons.length>0&&!disqualified;
    return {met,disqualified,current:done,target:lessons.length,label:`${done}/${lessons.length} บทเรียน`};
  }
  if(a.kind==='complete_main'){
    const lessons=mainOrder();
    const done=lessons.filter(l=>state.progress[l.lesson_id]?.completed).length;
    return {met:done>=lessons.length&&lessons.length>0,current:done,target:lessons.length,label:`${done}/${lessons.length} บทเรียน`};
  }
  if(a.kind==='complete_all'){
    const lessons=allLessonsWithBonuses().filter(l=>l.mode!=='info');
    const done=lessons.filter(l=>state.progress[l.lesson_id]?.completed).length;
    return {met:done>=lessons.length&&lessons.length>0,current:done,target:lessons.length,label:`${done}/${lessons.length} บทเรียน`};
  }
  if(a.kind==='course'){
    const lessons=LESSONS.filter(l=>l.mode!=='info'&&unitCourse(l.section)===a.course);
    const done=lessons.filter(l=>state.progress[l.lesson_id]?.completed).length;
    return {met:done>=lessons.length&&lessons.length>0,current:done,target:lessons.length,label:`${done}/${lessons.length} บทเรียน`};
  }
  if(a.kind==='complete_main_guest'){
    // Only counts while playing as a guest. Once unlocked it is carried into the account at login (firebase-init.js).
    const lessons=mainOrder();
    const done=lessons.filter(l=>state.progress[l.lesson_id]?.completed).length;
    const guest=!!state.isGuest;
    // logged in and not unlocked = gone for good (shown crossed out); logging out starts a fresh guest session
    return {met:guest&&done>=lessons.length&&lessons.length>0,disqualified:!guest,current:guest?done:0,target:lessons.length,
      label:guest?`${done}/${lessons.length} บทเรียน`:'ต้องทำตอนยังไม่เข้าสู่ระบบ'};
  }
  if(a.kind==='signs_unlocked'){
    const total=Object.keys(SIGNS).reduce((n,k)=>n+SIGNS[k].length,0);
    const n=flashcardSignPool(true).length;
    return {met:n>=total&&total>0,current:Math.min(n,total),target:total,label:`${Math.min(n,total)}/${total} ท่า`};
  }
  if(a.kind==='wrong_in_node'){
    const counts=state.wrongCounts||{};
    const max=Object.values(counts).reduce((m,v)=>Math.max(m,v),0);
    const cur=Math.min(max,a.threshold);
    return {met:max>=a.threshold,current:cur,target:a.threshold,label:`${cur}/${a.threshold} ครั้ง`};
  }
  if(a.kind==='event'){
    // No live condition — see the ACHIEVEMENTS kind-list comment above.
    const unlocked=!!(state.achievements&&state.achievements[a.id]);
    // 'drink_water' is the one 'event' achievement with something
    // actually worth showing progress toward while locked (minutes
    // spent in this sitting vs. DRINK_WATER_MS) — every other 'event'
    // kind stays a flat unlocked/not-yet with no bar (see
    // renderAchievements()'s noTrackableProgress).
    if(a.id==='drink_water'&&!unlocked){
      const targetMin=Math.round(DRINK_WATER_MS/60000);
      const curMin=Math.min(targetMin,Math.floor((Date.now()-DRINK_WATER_STARTED_AT)/60000));
      return {met:false,current:curMin,target:targetMin,label:`${curMin}/${targetMin} นาที`};
    }
    return {met:unlocked,current:unlocked?1:0,target:1,label:unlocked?'ปลดล็อกแล้ว':'ยังไม่ปลดล็อก'};
  }
  if(a.kind==='level'){
    const lvl=calcLevel(state.xp);
    const cur=Math.min(lvl,a.threshold);
    return {met:lvl>=a.threshold,current:cur,target:a.threshold,label:`เลเวล ${cur}/${a.threshold}`};
  }
  if(a.kind==='all_achievements'){
    // Live-derived from every OTHER achievement's unlock state — this
    // is the one kind whose condition depends on state.achievements
    // itself rather than xp/progress, which is why checkAchievements()
    // sweeping it here isn't enough on its own: see unlockAchievement()'s
    // extra checkAchievements() call for why this still gets caught the
    // moment the last other achievement (including an 'event' one) unlocks.
    const others=ACHIEVEMENTS.filter(x=>x.id!==a.id);   // counts every other achievement, hidden ones and 'cheater' included
    const done=others.filter(x=>state.achievements&&state.achievements[x.id]).length;
    return {met:done>=others.length&&others.length>0,current:done,target:others.length,label:`${done}/${others.length} ความสำเร็จ`};
  }
  // kind==='xp' (legacy — kept in case a future entry wants a plain xp
  // threshold again; nothing in the current ACHIEVEMENTS list uses it).
  const cur=Math.min(state.xp||0,a.threshold);
  return {met:(state.xp||0)>=a.threshold,current:cur,target:a.threshold,label:`${cur}/${a.threshold} XP`};
}

/* THE point of state.achievements: once an id is in there, that
   achievement stays unlocked FOR GOOD — a fact we store (and sync to
   Firestore via fbSaveState, see there for schema) rather than a
   number we re-derive from xp/progress on every single render/tab
   switch. This matters more as more achievement kinds get added
   (per the "gonna add more achievement related function soon" plan)
   — a kind like "used the camera 10 times" or "logged in 3 days in a
   row" has no xp/progress field to recompute FROM at render time; it
   can only ever be known by recording the moment it happened. Doing
   that recording here now, even for the two kinds that technically
   COULD be re-derived (xp/unit), keeps all achievements — old and
   future — going through one unlock path.
   Call this whenever xp/progress actually changes (currently just
   finishLesson()) — NOT on every render; renderAchievements() itself
   only reads what's already stored, it doesn't call this. */
function checkAchievements(){
  if(!state.achievements)state.achievements={};
  const newlyUnlocked=[];
  ACHIEVEMENTS.forEach(a=>{
    if(a.kind==='event')return; // these only ever unlock directly via unlockAchievement() at their own trigger site — never swept here
    if(state.achievements[a.id])return; // already stored — nothing to recompute for this one
    if(computeAchievementStatus(a).met&&unlockAchievement(a.id))newlyUnlocked.push(a);
  });
  return newlyUnlocked;
}
// Exposed so firebase-init.js's onAuthStateChanged can run one backfill
// pass right after loading a profile — covers accounts whose xp/progress
// already clears a threshold from before this feature existed, so they
// don't have to re-earn something they'd already done.
window.checkAchievements=checkAchievements;

/* Single unlock path for EVERY achievement, no matter which kind —
   checkAchievements()'s sweep calls this once it finds a non-'event'
   condition newly met, and every 'event' kind's trigger site (first
   wrong answer, successful login, the DEVMODE combo, 1-heart-left,
   changing your profile pic — see each call site) calls this directly
   instead of going through a live condition check at all. Idempotent:
   returns false with no side effects if `id` is unknown or already
   unlocked, so call sites don't need their own "already have this?"
   guard (useful for things like onAuthStateChanged firing again on
   every page reload for an already-logged-in account). */
function unlockAchievement(id,force){
  // while dev mode is on NO achievement can be earned by playing. Only the debug button (force=true) can unlock one
  // (temporary: devModeRestore puts the old list back), plus the two dev-mode achievements below (permanent).
  if(isDevMode()&&!force&&DEV_PERMANENT_ACHIEVEMENTS.indexOf(id)<0)return false;
  if(!state.achievements)state.achievements={};
  if(state.achievements[id])return false;
  const a=ACHIEVEMENTS.find(x=>x.id===id);
  if(!a)return false;
  state.achievements[id]={unlockedAt:Date.now()};
  if(isDevMode()&&force)checkCheaterAchievement();   // every other achievement force-unlocked in dev mode -> 'cheater'
  // Catches 'all_achievements'-kind achievements (currently just
  // 'true_completionist') the moment THIS unlock happens to be the
  // last dependency they needed — including when that dependency is
  // an 'event' kind, which checkAchievements()'s normal sweep never
  // reaches on its own. Safe to call unconditionally here: the
  // state.achievements[a.id] guard above means this only ever does
  // real work for the (at most one, in practice) newly-met kind, and
  // converges immediately rather than looping.
  checkAchievements();
  if(typeof window.fbSaveState==='function')window.fbSaveState(); // no-op for guests
  // Both are cheap (no-op via their own element-exists guard if the
  // relevant screen isn't even open right now) and idempotent, so it's
  // simplest to just always refresh both rather than tracking which
  // screen the person happens to be looking at.
  if(typeof renderAchievements==='function')renderAchievements();
  if(typeof renderProfileAchievementPreview==='function')renderProfileAchievementPreview();
  queueAchievementPopup(a);
  return true;
}
window.unlockAchievement=unlockAchievement;

/* DEBUG-ONLY: wired to the .ach-debug-btn rendered on every still-locked
   achievement card (see renderAchievements()) — hidden via CSS unless
   devmode-on, same pattern as debugCompleteQuestion()/
   debugSkipFlashcardRound() above. Deliberately does NOT bypass the
   isDevMode() check even though the button itself is only ever visible
   in dev mode: the onclick is plain markup string-interpolated into
   innerHTML, so this guard is the actual enforcement, not just belt-
   and-suspenders. Otherwise just calls the normal unlockAchievement()
   path — no separate state/Firestore write, so a force-given
   achievement behaves identically to a legitimately-earned one
   (including feeding 'all_achievements'-kind achievements). */
function forceUnlockAchievement(id){
  if(!isDevMode())return;
  unlockAchievement(id,true);
}
window.forceUnlockAchievement=forceUnlockAchievement;

/* ------------------------------------------------------------
   ACHIEVEMENT UNLOCK POPUP
   ------------------------------------------------------------
   Replaces the old plain showToast() call on unlock — a Steam-style
   toast (icon left, kicker/title/desc stacked right) pinned to the
   bottom-right corner, NOT a centered modal — it must never block or
   dim the rest of the page the way the confirm-… modals do (see .ach-toast-wrap/.ach-toast in style.css for the
   layout + the slide-in/slide-out motion, kept in the same "subtle"
   register as everywhere else in the app).
   Queued rather than shown immediately: checkAchievements() can unlock
   several achievements in the same tick (e.g. finishing the very last
   lesson of the last unit can complete 'tutorial_complete',
   'completionist', AND 'no_hit_gaming' all at once) — showing them one
   at a time (dismiss/timeout -> next) means every one of them actually
   gets seen instead of only the last write winning. */
let _achPopupQueue=[];
let _achPopupShowing=false;
function queueAchievementPopup(a){
  _achPopupQueue.push(a);
  if(!_achPopupShowing)showNextAchievementPopup();
}
function showNextAchievementPopup(){
  const a=_achPopupQueue.shift();
  const wrap=document.getElementById('achievement-popup');
  if(!a){_achPopupShowing=false;if(wrap)wrap.innerHTML='';return;}
  _achPopupShowing=true;
  playSfx('achievement');
  wrap.innerHTML=`
    <div class="ach-toast" onclick="dismissAchievementPopup()">
      <div class="ach-toast-icon"><i class="ti ${a.icon}"></i></div>
      <div class="ach-toast-body">
        <div class="ach-toast-kicker">ปลดล็อกความสำเร็จ</div>
        <div class="ach-toast-title">${a.title}</div>
        <div class="ach-toast-desc">${a.desc}</div>
      </div>
    </div>`;
  clearTimeout(wrap._t);
  wrap._t=setTimeout(dismissAchievementPopup,4500);
}
function dismissAchievementPopup(){
  const wrap=document.getElementById('achievement-popup');
  const card=wrap&&wrap.firstElementChild;
  clearTimeout(wrap&&wrap._t);
  if(!card){showNextAchievementPopup();return;}
  // Play the slide-out-and-fade before actually swapping content, same
  // "subtle" motion budget as the slide-in — an instant cut on dismiss
  // would read as a jump rather than a toast leaving.
  card.classList.add('ach-toast-leave');
  setTimeout(showNextAchievementPopup,200);
}
window.dismissAchievementPopup=dismissAchievementPopup;

/* Returns {unlocked, disqualified, current, target, label} for one
   achievement. `unlocked` comes from storage (state.achievements[a.id])
   rather than being recomputed from thresholds here — see
   checkAchievements() above for where that storage gets written.
   `disqualified` only ever comes from computeAchievementStatus() for
   the two "without ever X" kinds (no_info_all/no_wrong_all) — true
   once the disqualifying event has happened at all, meaning `met` can
   never become true again for that account short of a full progress
   reset (see renderAchievements()'s crossed-out treatment for these).
   current/target/label are still computed live since they're just
   display numbers for still-locked achievements. */
function achievementProgress(a){
  const stored=state.achievements&&state.achievements[a.id];
  const live=computeAchievementStatus(a);
  return {unlocked:!!stored,disqualified:!!live.disqualified,current:live.current,target:live.target,label:live.label};
}

function renderAchievements(){
  const list=document.getElementById('achievements-list');
  if(!list)return;
  const unlockedCount=ACHIEVEMENTS.filter(a=>achievementProgress(a).unlocked).length;
  const countEl=document.getElementById('achievements-count');
  if(countEl)countEl.textContent=`ปลดล็อกแล้ว ${unlockedCount}/${ACHIEVEMENTS.length}`;
  // Unlocked badges float to the top (most-recently-unlocked first, via
  // unlockedAt); still-possible locked ones come next; achievements
  // that can never be earned again without a full progress reset (see
  // the disqualified-crossed-out treatment below) sink to the very
  // bottom, since they're no longer something to work toward. sort()
  // is stable in every engine this runs on, so ties within a tier just
  // keep their original ACHIEVEMENTS order rather than needing to
  // track/re-apply indices.
  const sorted=[...ACHIEVEMENTS].sort((a,b)=>{
    const uA=state.achievements&&state.achievements[a.id];
    const uB=state.achievements&&state.achievements[b.id];
    if(!!uA!==!!uB)return uA?-1:1;
    if(uA&&uB)return (uB.unlockedAt||0)-(uA.unlockedAt||0);
    const dA=achievementProgress(a).disqualified;
    const dB=achievementProgress(b).disqualified;
    if(dA!==dB)return dA?1:-1;
    return 0;
  });
  list.innerHTML=sorted.map(a=>{
    const p=achievementProgress(a);
    const pct=p.target>0?Math.round(p.current/p.target*100):0;
    // Hidden achievements (currently just 'secret_unlock') show as an
    // unmarked "???" mystery card until unlocked, so the list itself
    // doesn't spoil how to find them — see the ACHIEVEMENTS comment.
    const isHiddenLocked=a.hidden&&!p.unlocked;
    // Disqualified: the achievement's condition can literally never be
    // met again without a full progress reset (state.milestones.
    // wrongEver/infoNodeOpened only ever flip false->true) — crossed
    // out with a "ban" icon instead of the normal progress bar, so it
    // reads as "gone" rather than merely "not done yet". Only ever
    // true while still locked (see achievementProgress()'s comment).
    const isDisqualified=!p.unlocked&&p.disqualified;
    // Some achievement kinds have nothing numeric worth tracking
    // toward while locked: 'event' ones (except 'drink_water', which
    // computeAchievementStatus() now gives a real elapsed-minutes
    // figure — see there) either fired at the moment something
    // happened or they didn't, no "3/10" in between; 'reach_section'
    // is the same story (you either have or haven't reached the gate
    // lesson yet — a 0%/100% bar for a single binary flip is just
    // visual noise, same as 'event'). Showing a permanently-empty
    // 0%-width bar for those while locked would just be visual noise,
    // so — same as the Steam achievement list, where achievements with
    // no real progress metric show no bar at all — skip the bar
    // entirely for this case. Still shown once unlocked (bar reads
    // full, matching every other unlocked card) since at that point
    // it's no longer "locked with nothing to show".
    const noTrackableProgress=(a.kind==='event'&&a.id!=='drink_water'||a.kind==='reach_section')&&!p.unlocked;
    return `
    <div class="ach-card${p.unlocked?' unlocked':' locked-ach'}${isHiddenLocked?' hidden-ach':''}${isDisqualified?' disqualified-ach':''}">
      ${p.unlocked?'':`<button class="ach-debug-btn" onclick="forceUnlockAchievement('${a.id}')" title="Debug: ปลดล็อกทันที"><i class="ti ti-bug"></i></button>`}
      <div class="ach-row">
        <div class="ach-icon" style="${p.unlocked?'background:var(--green-light);':(isDisqualified?'background:var(--bg);':'background:var(--bg);')}"><i class="ti ${p.unlocked?a.icon:(isDisqualified?'ti-ban':(isHiddenLocked?'ti-mood-confuzed':'ti-lock'))}" style="color:${p.unlocked?'var(--green-dark)':(isDisqualified?'var(--text-light)':'var(--text-light)')};"></i></div>
        <div class="ach-body">
          <h4>${isHiddenLocked?'???':a.title}</h4>
          <div class="ach-meta">${isHiddenLocked?'ยังไม่ถูกค้นพบ ปลดล็อกเพื่อดูว่ามันคืออะไร':a.desc}</div>
        </div>
        <div class="ach-side">${p.unlocked?'<div class="ach-status"><i class="ti ti-circle-check"></i> สำเร็จแล้ว</div>':(isDisqualified?'<div class="ach-disqualified-note"><i class="ti ti-alert-triangle"></i> ไม่สามารถทำปลดล็อคได้แล้ว</div>':(isHiddenLocked||noTrackableProgress?'':`<div class="ach-bar"><div class="ach-bar-fill" style="width:${pct}%;"></div></div><div class="ach-progress-label">${p.label}</div>`))}</div>
      </div>
    </div>`;
  }).join('');
  setupAchievementsScrollReveal();
}

/* Latest-3-unlocked preview on the PROFILE screen's "ความสำเร็จล่าสุด"
   card grid (id="profile-ach-preview") — distinct from the full sorted
   list renderAchievements() draws on the achievements screen itself:
   this one only ever shows up to 3, newest-unlocked first, and drops
   locked achievements entirely rather than listing them dimmed.
   Deliberately does NOT reuse .ach-card/.ach-icon/etc (the flex-row
   layout used by #achievements-list, which happens to share those
   exact class names with an unrelated centered-grid card style) —
   this preview needs its
   own compact vertical icon-then-name layout, with the description
   hidden until hovered, so new .ap-* classes (see style.css) instead. */
function renderProfileAchievementPreview(){
  const grid=document.getElementById('profile-ach-preview');
  if(!grid)return;
  const unlocked=ACHIEVEMENTS
    .filter(a=>state.achievements&&state.achievements[a.id])
    .sort((a,b)=>(state.achievements[b.id].unlockedAt||0)-(state.achievements[a.id].unlockedAt||0))
    .slice(0,3);
  if(!unlocked.length){
    grid.innerHTML='<p style="grid-column:1/-1;font-size:13px;color:var(--text-soft);text-align:center;padding:6px 0;">ยังไม่มีความสำเร็จที่ปลดล็อก ไปเริ่มเรียนกันเลย!</p>';
    return;
  }
  // title="" is a plain-tooltip fallback for touch devices, which have
  // no real ":hover" — the CSS reveal (see .ap-card:hover .ap-desc in
  // style.css) is the primary way this shows on desktop.
  grid.innerHTML=unlocked.map(a=>`
    <div class="ap-card" title="${a.desc}">
      <div class="ap-icon"><i class="ti ${a.icon}"></i></div>
      <div class="ap-name">${a.title}</div>
      <div class="ap-desc">${a.desc}</div>
    </div>`).join('');
}

/* ============================================================
   QUIZ / LESSON RUNTIME
   ============================================================ */
/* Fisher–Yates — used to randomize question order for test-mode lessons. */
function shuffleArray(arr){
  const a=arr.slice();
  for(let i=a.length-1;i>0;i--){
    const j=Math.floor(Math.random()*(i+1));
    [a[i],a[j]]=[a[j],a[i]];
  }
  return a;
}

function resolveQuestions(lesson){
  const qs=lesson.questions.map(id=>QUESTIONS[id]).filter(Boolean);
  // Test nodes (mode:'test') cover ALL of a section's letters in one go —
  // randomize their order each attempt so it's not the same fixed
  // letter-by-letter sequence every time. 'normal' lessons keep their
  // authored order (they're meant to teach in a specific progression).
  // bonus questions are also shuffled so the order varies on first open
  return (lesson.mode==='test'||lesson.mode==='bonus') ? shuffleArray(qs) : qs;
}

/* ------------------------------------------------------------
   INFO NODES (optional preview, no quiz/progress involved)
   ------------------------------------------------------------
   Reuses the #lesson-fullscreen overlay but never touches
   activeQuiz — exitLesson() already no-ops safely when
   activeQuiz is null, so the existing close (X) button just works. */
function openInfoNode(lesson){
  // Info nodes are locked until the previous gating lesson is done —
  // same rule as the normal lesson they precede (same pairWith gate).
  if(lesson.pairWith&&!isDevMode()){ // dev mode: every node is openable
    const gate=prevGatingLesson(lesson.pairWith);
    if(gate&&!state.progress[gate.lesson_id]?.completed){
      showToast('ทำบทเรียนก่อนหน้าให้เสร็จก่อนนะ','lock');
      return;
    }
  }
  // Persisted forever once true — backs the 'no_info_all' achievement
  // kind ("Veteran": finish every unit having never opened an info
  // node). Set here (an actual successful open, past the lock check
  // above) rather than on click, so a blocked/locked click doesn't
  // count against it.
  if(!state.milestones)state.milestones={infoNodeOpened:false,wrongEver:false};
  state.milestones.infoNodeOpened=true;
  if(typeof window.fbSaveState==='function')window.fbSaveState(); // no-op for guests
  document.getElementById('lesson-fullscreen').style.display='flex';
  document.querySelector('.lf-hearts').style.display='none';
  document.getElementById('lf-progress-fill').style.width='100%';
  document.getElementById('lf-footer').style.display='none';
  // Same reset as startQuiz() — #lf-body may have been left in the
  // finishLesson()/failTest() result-screen state from a previous quiz.
  document.getElementById('lf-body').innerHTML='<div class="lf-body-inner" id="lf-body-inner"></div>';
  const inner=document.getElementById('lf-body-inner');
  inner.innerHTML=`
    <div class="lf-q-header"><div class="lf-title">${lesson.course&&lesson.course!=='alphabet'?'เรียนรู้ท่ามือในบทนี้':'เรียนรู้ตัวอักษรในบทนี้'}</div></div>
    <div class="lf-info-grid">
      ${lesson.course&&lesson.course!=='alphabet'?lesson.letters.map(id=>{
        const sg=findSign(id);if(!sg)return '';
        return `<div class="lf-info-card lf-info-sign">
          <div class="lf-seq">${sg.images.map((f,i)=>(i?'<i class="ti ti-chevron-right lf-seq-arrow"></i>':'')+`<img class="lf-q-image" src="${f}" alt="ท่ามือ ${sg.th}" onerror="handleGestureImgError(this)">`).join('')}</div>
          <div class="lf-info-letter">${sg.th}</div>
        </div>`;}).join(''):lesson.letters.map(letter=>`
        <div class="lf-info-card">
          <img class="lf-q-image" src="${gestureImageSrc(letter)}" alt="ท่ามือ ${letter}" onerror="handleGestureImgError(this)">
          <div class="lf-info-letter">${letter}</div>
        </div>`).join('')}
    </div>
    <div style="text-align:center;">
      <button class="btn-main" style="width:auto;padding:13px 32px;margin-top:20px;" onclick="exitLesson();">เข้าใจแล้ว</button>
    </div>
  `;
}

function startQuiz(lesson){
  const questions=resolveQuestions(lesson);
  // Hearts: ALWAYS on for test-mode lessons (qa or gesture), local to this
  // single attempt only — reset every time a test is started, and never
  // shared with any other lesson or with a global hearts pool.
  const livesActive=lesson.mode==='test';
  // Per-question countdown timer: only for gesture-type tests.
  const gestureTimerActive=lesson.mode==='test'&&lesson.type==='gesture';
  activeQuiz={
    lesson,questions,idx:0,correct:0,selected:null,answered:false,
    earnedXp:0,
    // Whether ANY question in this attempt has been answered wrong at
    // least once — read by finishLesson() to stamp state.progress[...]
    // .flawless, which backs the 'flawless_lessons' achievement kind
    // (e.g. "Fast Learner": finish unit 1's tests without a single
    // wrong answer). Reset fresh on every startQuiz() call, same as
    // everything else here — a later flawless attempt overwrites an
    // earlier non-flawless one, and vice versa.
    hadWrong:false,
    isTest:lesson.mode==='test',
    livesActive,
    gestureTimerActive,
    livesLeft:livesActive?(lesson.lives||TEST_LIVES_DEFAULT):null,
    gestureDetector:null,
    gestureTimerInterval:null,
    // Wrong-answer redo queue (test mode only — see requeueMissedOrFinish()).
    // origTotal is the question count BEFORE any redo questions get appended,
    // so the final score % always reflects "correct out of the original set",
    // not inflated/deflated by however many redo passes it took.
    origTotal:questions.length,
    missedMap:new Map(),   // question_id -> question object, still outstanding
    correctIds:new Set(),  // question_ids answered correctly at least once
    xpAwardedIds:new Set(),// question_ids XP has already been paid out for
    // question_ids that have been requeued after a wrong answer at least
    // once — used to show a "redo" pill on the question when it comes
    // back around, so it's visually distinguishable from a first attempt.
    redoIds:new Set(),
  };
  // finishLesson()/failTest() overwrite #lf-body's innerHTML with the
  // result screen, which destroys the #lf-body-inner div that renderQ()
  // writes into. Restore the original structure every time a quiz starts
  // so a lesson opened after a previous one finished doesn't render into
  // a missing node (which silently aborted and left the old result
  // screen on display, looking like "it sent me back to the last lesson").
  document.getElementById('lf-body').innerHTML='<div class="lf-body-inner" id="lf-body-inner"></div>';

  document.getElementById('lesson-fullscreen').style.display='flex';
  const heartsWrap=document.querySelector('.lf-hearts');
  heartsWrap.style.display=livesActive?'flex':'none';
  document.getElementById('lf-hearts-count').textContent=livesActive?activeQuiz.livesLeft:'';
  renderQ();
}

function teardownGesture(){
  if(activeQuiz&&activeQuiz.faceTracker){
    try{activeQuiz.faceTracker.stop();}catch(e){}
    activeQuiz.faceTracker=null;
  }
  if(activeQuiz&&activeQuiz.gestureDetector){
    try{activeQuiz.gestureDetector.stop();}catch(e){}
    activeQuiz.gestureDetector=null;
  }
  if(activeQuiz&&activeQuiz.gestureTimerInterval){
    clearInterval(activeQuiz.gestureTimerInterval);
    activeQuiz.gestureTimerInterval=null;
  }
}

function exitLesson(){
  teardownGesture();
  document.getElementById('lesson-fullscreen').style.display='none';
  activeQuiz=null;
}

/* ------------------------------------------------------------
   FLASH CARD GAME
   ------------------------------------------------------------
   Unlike the lesson gesture questions (one GestureDetector instance
   PER question, torn down and rebuilt every time — see
   renderQ()/startGestureCamera()), this game creates a single
   GestureDetector for the whole run when the player clicks "เริ่มกล้อง",
   and every round after that just swaps which letter fcState.expected
   points at. That's what keeps rounds feeling instant instead of
   re-asking for camera access every few seconds.
   fcState is null whenever no game is in progress (start view showing,
   or between visits to the tab) — every function below bails out early
   if it's null, same defensive pattern activeQuiz uses elsewhere. */
let fcState=null;

function renderFlashcardBest(){
  const el=document.getElementById('fc-best-num');
  if(el)el.textContent=state.score||0;
  if(typeof renderFlashcardPool==='function')renderFlashcardPool();
}

/* Always leaves the screen in its start view with the camera released —
   called both when navigating away (showScreen's guard) and from the
   result screen's "กลับ" button. Safe to call with no game in progress. */
function exitFlashcardScreen(){
  teardownFlashcardCamera();
  fcState=null;
  const startView=document.getElementById('fc-start-view');
  const playView=document.getElementById('fc-play-view');
  const resultView=document.getElementById('fc-result-view');
  if(startView)startView.style.display='block';
  if(playView)playView.style.display='none';
  if(resultView){resultView.style.display='none';resultView.innerHTML='';}
  updateFlashcardFireWall(0);
  updateFlashcardTint(0);
  renderFlashcardBest();
}

function teardownFlashcardCamera(){
  if(fcState&&fcState.detector){
    try{fcState.detector.stop();}catch(e){}
    fcState.detector=null;
  }
  if(fcState&&fcState.face){
    try{fcState.face.stop();}catch(e){}
    fcState.face=null;
  }
  if(fcState&&fcState.roundTimerInterval){
    clearInterval(fcState.roundTimerInterval);
    fcState.roundTimerInterval=null;
  }
}

/* ------------------------------------------------------------
   flashcard with SIGNS + the capture indicator
   ------------------------------------------------------------
   The player picks what to practise on the start view (fcPool): letters only (as before), signs only, or a mix.
   A sign card shows the Thai word; the player does the sign and SignCheck (sign-check.js) checks it with the same recorded
   poses and rules as the lessons. Signs only come up once the player has FINISHED the camera node that teaches them
   (flashcardSignPool; dev mode: all signs). Round time for a sign: 25 s, minus 0.5 s per correct round, never below 12 s.
   NO text hints in this game (gestureHintsOff('flashcard')): the status line only says what the system needs (show your hand,
   face in view, loading) and the capture bar (#fc-cap) fills while a pose is being held (gold = start pose seen, now move). */
const FLASHCARD_SIGN_TIME_START_S=25;
const FLASHCARD_SIGN_TIME_MIN_S=12;
function flashcardSignTime(passesSoFar){return Math.max(FLASHCARD_SIGN_TIME_MIN_S,FLASHCARD_SIGN_TIME_START_S-FLASHCARD_TIME_DECAY_PER_PASS_S*passesSoFar);}
let fcPool='letters';   // 'letters' | 'signs' | 'mix'
// face-zone signs that cannot be checked without the face model (mother, father, know): left out when the model fails to load
function flashcardStrictFaceSigns(){return (typeof CAMERA_NEEDS_FACE!=='undefined'?CAMERA_NEEDS_FACE:[]).filter(id=>(typeof FACE_OPTIONAL!=='undefined'?FACE_OPTIONAL:[]).indexOf(id)<0);}

// Signs the player has learned = signs of every emotion / word camera node (normal lessons g1, g2) that is completed.
function flashcardSignPool(realOnly){
  const dev=!realOnly&&isDevMode();   // realOnly: real progress only (achievement), ignores dev mode
  const out=[],seen=new Set();
  LESSONS.forEach(l=>{
    if(l.type!=='gesture'||l.mode!=='normal')return;
    const done=state.progress&&state.progress[l.lesson_id]&&state.progress[l.lesson_id].completed;
    if(!dev&&!done)return;
    l.questions.forEach(qid=>{
      const q=QUESTIONS[qid];
      if(!q||!q.sign||q.placeholder||seen.has(q.sign))return;
      seen.add(q.sign);
      const sg=findSign(q.sign);
      out.push({id:q.sign,th:sg?sg.th:q.sign});
    });
  });
  return out;
}

function renderFlashcardPool(){
  const el=document.getElementById('fc-pool');
  if(!el)return;
  const n=flashcardSignPool().length;
  const total=Object.keys(SIGNS).reduce((a,k)=>a+SIGNS[k].length,0);
  const allDone=n>=total;                                  // the signs tab opens only when every sign is learned (dev mode: always)
  if(n===0&&fcPool!=='letters')fcPool='letters';
  if(!allDone&&fcPool!=='letters')fcPool='letters';
  const opt=(key,label,ok)=>`<button class="fc-pool-btn${fcPool===key?' on':''}" ${ok?'':'disabled'} onclick="setFlashcardPool('${key}')">${label}</button>`;
  const lockIc=allDone?'':'<i class="ti ti-lock"></i> ';
  const signsLabel=lockIc+'ท่ามือ';
  const mixLabel=lockIc+'ผสม';
  el.innerHTML=
    `<div class="fc-pool-btns">${opt('letters','ตัวอักษร',true)}${opt('signs',signsLabel,allDone)}${opt('mix',mixLabel,allDone)}</div>`+
    (!allDone?'<div class="fc-pool-note">เรียนโหนดกล้องในคอร์สอารมณ์และคำศัพท์ให้ครบทุกท่า เพื่อปลดล็อกแท็บท่ามือและผสม</div>':'');
}
function setFlashcardPool(key){fcPool=key;renderFlashcardPool();}

function startFlashcardGame(){
  fcState={
    streak:0,score:0,xpEarned:0,pool:fcPool,
    kind:'letter',card:null,letter:null,expected:null,isMotionLetter:false,sign:null,checker:null,capMemo:{},
    resolved:false,holdStartTime:null,
    detector:null,face:null,faceFailed:false,posesLoaded:false,roundTimerInterval:null,roundRemainingMs:0,
  };
  document.getElementById('fc-start-view').style.display='none';
  document.getElementById('fc-result-view').style.display='none';
  document.getElementById('fc-play-view').style.display='block';
  document.getElementById('fc-hud-score').textContent='0';
  document.getElementById('fc-hud-streak').textContent='0';
  document.getElementById('fc-hud-xp').textContent='0';
  updateFlashcardStreakBadge(0);
  updateFlashcardFireWall(0);
  updateFlashcardTint(0);
  document.getElementById('fc-timer').style.display='none';
  document.getElementById('fc-status').textContent='';
  capShow('fc-cap',0);
  document.getElementById('fc-start-cam-btn').style.display='inline-block';
  document.getElementById('fc-start-cam-btn').disabled=false;
  document.getElementById('fc-start-cam-btn').textContent='เริ่มกล้อง';
  renderFlashcardCard(pickFlashcardCard(null));
}

const fcLetterCard=(letter)=>({kind:'letter',letter,key:'L'+letter});
// Random next card. letters = the 26 letters; signs = the learned signs; mix = a coin flip between the two kinds, so 26 letters
// are not drowned by 55 signs. Never the same card twice in a row.
function pickFlashcardCard(prev){
  let signs=fcPool!=='letters'?flashcardSignPool():[];
  if(fcState&&fcState.faceFailed){const strict=flashcardStrictFaceSigns();signs=signs.filter(s=>strict.indexOf(s.id)<0);}
  if(fcState&&fcState.posesLoaded&&typeof SignCheck!=='undefined')signs=signs.filter(s=>SignCheck.supports(s.id));
  const letters=FLASHCARD_LETTERS.map(fcLetterCard);
  const signCards=signs.map(s=>({kind:'sign',sign:s.id,th:s.th,key:'S'+s.id}));
  let pool;
  if(fcPool==='signs'&&signCards.length)pool=signCards;
  else if(fcPool==='mix'&&signCards.length)pool=Math.random()<0.5?letters:signCards;
  else pool=letters;
  let c,guard=0;
  do{c=pool[Math.floor(Math.random()*pool.length)];guard++;}
  while(prev&&c.key===prev.key&&pool.length>1&&guard<50);
  return c;
}

// Rebuilds #fc-card's inner content fresh each round so the popIn animation (CSS, always-on) replays on every new card —
// same trick renderQaQ()/renderGestureQ() rely on for .lf-question, no manual reflow/class-juggling needed.
function renderFlashcardCard(card){
  if(fcState){
    fcState.card=card;fcState.kind=card.kind;
    if(card.kind==='letter'){fcState.letter=card.letter;fcState.expected='asl_'+card.letter.toLowerCase();fcState.isMotionLetter=(card.letter==='J'||card.letter==='Z');fcState.sign=null;}
    else{fcState.sign=card.sign;fcState.isMotionLetter=false;fcState.letter=null;fcState.expected=null;}
  }
  const el=document.getElementById('fc-card');
  if(!el)return;
  el.innerHTML=card.kind==='letter'?'<div class="fc-letter">'+card.letter+'</div>':'<div class="fc-word">'+card.th+'</div>';
}

/* Capture indicator (all no-hint camera screens: test / bonus nodes in the lessons and the flashcard game).
   capShow(id, percent, 'ready'|'flash'|''). It never says how or where to do the sign. */
function capShow(id,pct,cls){
  const f=document.getElementById(id+'-fill');
  if(!f)return;
  f.style.width=Math.max(0,Math.min(100,pct||0))+'%';
  f.classList.toggle('ready',cls==='ready');
  f.classList.toggle('flash',cls==='flash');
  f.classList.toggle('done',cls==='done');
}
// Feeds the bar from a SignChecker state. memo = {idx, flashUntil} kept by the caller between frames.
function capFromSign(id,st,memo){
  const now=performance.now();
  if(st.seen<(st.need||1)){capShow(id,0);memo.idx=st.idx;return;}
  if(st.mode==='motion'){capShow(id,st.phase==='move'?100:st.holdPct,st.phase==='move'?'ready':'');}
  else if(memo.idx!=null&&st.idx>memo.idx){capShow(id,100,'done');memo.stepDone=true;memo.doneMin=now+500;}   // one STEP (pose) of the sign captured: dark green = move on to the next step
  else if(memo.stepDone&&!(st.holdPct>0&&now>memo.doneMin)){capShow(id,100,'done');}                                // stays dark until the next pose starts to fill
  else{memo.stepDone=false;capShow(id,st.holdPct);}
  memo.idx=st.idx;
}

function fcFaceReady(){
  const st=document.getElementById('fc-status');
  if(st)st.textContent='';
  return ensureFaceLibs().then(()=>{
    if(!fcState)return;
    const face=new FaceTracker();fcState.face=face;
    return face.start(document.getElementById('fc-video')).then(()=>{if(fcState&&face.status==='error')fcState.faceFailed=true;});
  }).catch(()=>{if(fcState)fcState.faceFailed=true;});
}

// Sign rounds: one call per camera frame with the tracked hands.
function fcOnHands(res){
  if(!fcState||fcState.resolved||fcState.kind!=='sign'||!fcState.checker)return;
  const vid=document.getElementById('fc-video');
  const live=[];
  (res.hands||[]).forEach(h=>{if(!h.coasting&&h.keypoints&&h.keypoints.length>=21)live.push(HandFeatures.compute(h.keypoints,h.keypoints3D));});
  const ck=fcState.checker;
  let geom;                                           // undefined = no face rule for this sign / model unavailable
  if(ck.needsFace&&typeof FaceTracker!=='undefined'){
    const f=fcState.face;
    if(f&&f.status==='error')fcState.faceFailed=true;
    if(fcState.faceFailed)geom=flashcardStrictFaceSigns().indexOf(fcState.sign)>=0?null:undefined;
    else geom=f&&f.status==='running'?f.current():null;
  }
  const st=ck.update(performance.now(),live,vid.videoWidth||640,vid.videoHeight||480,geom);
  if(st.passed){capShow('fc-cap',100,'');resolveFlashcardRound();return;}
  capFromSign('fc-cap',st,fcState.capMemo);
  // no text above the bar in the flashcard game
  const el=document.getElementById('fc-status');
  if(el)el.textContent='';
}

function startFlashcardCamera(){
  if(!fcState)return;
  const startBtn=document.getElementById('fc-start-cam-btn');
  const statusEl=document.getElementById('fc-status');
  startBtn.disabled=true;
  startBtn.textContent='กำลังโหลดกล้อง...';

  if(typeof GestureDetector==='undefined'){
    statusEl.textContent='ไม่สามารถโหลดระบบตรวจจับท่ามือได้ ตรวจสอบการเชื่อมต่ออินเทอร์เน็ต';
    startBtn.disabled=false;startBtn.textContent='ลองอีกครั้ง';
    return;
  }
  const useSigns=fcPool!=='letters'&&flashcardSignPool().length>0;
  if(useSigns&&(typeof SignCheck==='undefined'||typeof HandFeatures==='undefined'||typeof PoseMatch==='undefined')){
    statusEl.textContent='ไม่สามารถโหลดระบบตรวจจับท่ามือได้ ตรวจสอบการเชื่อมต่ออินเทอร์เน็ต';
    startBtn.disabled=false;startBtn.textContent='ลองอีกครั้ง';
    return;
  }

  const detector=new GestureDetector({
    videoEl:document.getElementById('fc-video'),
    canvasEl:document.getElementById('fc-canvas'),
    // Always on (not per-letter like startGestureCamera) — the card can change to a motion letter (J/Z) any round, and this
    // detector lives across every round in the game.
    enableMotionGestures:true,
    motionFreezeMs:GESTURE_FREEZE_MS,
    motionRestingHoldMs:GESTURE_MOTION_RESTING_HOLD_MS,
    maxHands:2,
    onHands:fcOnHands,
    onGesture:(name)=>{
      if(!fcState||fcState.resolved||fcState.kind!=='letter'||!fcState.isMotionLetter)return;
      if(name===fcState.expected){capShow('fc-cap',100,'');resolveFlashcardRound();}
    },
    // J / Z start pose (no text, bar only): green fill while the start pose is held, gold + pulse when the stroke can begin
    onMotionState:({name,restingOk,restingReady,restingHeldMs})=>{
      if(!fcState||fcState.resolved||fcState.kind!=='letter'||!fcState.isMotionLetter||name!==fcState.expected)return;
      if(!restingOk)capShow('fc-cap',0);
      else if(!restingReady)capShow('fc-cap',Math.round(100*restingHeldMs/GESTURE_MOTION_RESTING_HOLD_MS));
      else capShow('fc-cap',100,'ready');
    },
    onCandidate:(winner)=>{
      if(!fcState||fcState.resolved||fcState.kind!=='letter'||fcState.isMotionLetter)return;
      const holding=winner&&winner.name===fcState.expected;
      const now=performance.now();
      if(holding){
        if(fcState.holdStartTime===null)fcState.holdStartTime=now;
        const elapsed=now-fcState.holdStartTime;
        capShow('fc-cap',Math.round(100*elapsed/GESTURE_FREEZE_MS));
        if(elapsed>=GESTURE_FREEZE_MS){capShow('fc-cap',100,'');resolveFlashcardRound();}
      }else{
        fcState.holdStartTime=null;
        capShow('fc-cap',0);
      }
    },
    onError:(err)=>{},
  });
  fcState.detector=detector;

  const poses=useSigns?SignCheck.load(SIGN_POSES_URL).then(()=>{if(fcState)fcState.posesLoaded=true;}):Promise.resolve();
  poses.then(()=>detector.start()).then(()=>{
    markCameraOk();
    startBtn.style.display='none';
    return useSigns?fcFaceReady():null;                // the first round starts once the face model is ready (or failed)
  }).then(()=>{
    if(!fcState)return;                                 // left the screen while loading
    statusEl.textContent='';
    document.getElementById('fc-timer').style.display='block';
    beginFlashcardRound(fcState.card);
  }).catch(err=>{
    markCameraBad();
    statusEl.textContent=useSigns&&fcState&&!fcState.posesLoaded?'โหลดข้อมูลท่ามือไม่สำเร็จ ตรวจสอบการเชื่อมต่อแล้วลองอีกครั้ง':'เปิดกล้องไม่สำเร็จ กรุณาอนุญาตการใช้กล้อง';
    startBtn.style.display='inline-block';startBtn.disabled=false;startBtn.textContent='ลองอีกครั้ง';
  });
}

// Starts (or restarts, for round 2+) the per-round countdown for whatever card is currently showing. Called once camera is
// ready, and again after every correct answer for the next card. The time limit is recomputed every round from the current
// streak (see flashcardTimeForRound / flashcardSignTime) — it can land on a half-second (e.g. 14.5s), so the countdown runs
// in ms internally and only rounds for display.
function beginFlashcardRound(card){
  if(!fcState)return;
  fcState.resolved=false;
  fcState.holdStartTime=null;
  fcState.checker=null;fcState.capMemo={};
  // a face-zone sign cannot run when the face model failed: swap the card for another one
  if(card&&card.kind==='sign'&&fcState.faceFailed&&flashcardStrictFaceSigns().indexOf(card.sign)>=0)card=pickFlashcardCard(card);
  if(card)renderFlashcardCard(card);
  if(fcState.kind==='sign'){
    try{fcState.checker=SignCheck.create(fcState.sign);}
    catch(e){renderFlashcardCard(pickFlashcardCard(card));if(fcState.kind==='sign'){try{fcState.checker=SignCheck.create(fcState.sign);}catch(e2){renderFlashcardCard(fcLetterCard(FLASHCARD_LETTERS[Math.floor(Math.random()*26)]));}}}
  }
  capShow('fc-cap',0);
  if(fcState.roundTimerInterval)clearInterval(fcState.roundTimerInterval);
  const limitS=fcState.kind==='sign'?flashcardSignTime(fcState.streak):flashcardTimeForRound(fcState.streak,fcState.isMotionLetter);
  fcState.roundRemainingMs=Math.round(limitS*1000);
  const timerEl=document.getElementById('fc-timer');
  if(timerEl){timerEl.textContent=Math.ceil(fcState.roundRemainingMs/1000)+'s';timerEl.classList.remove('fc-timer-low');}
  fcState.roundTimerInterval=setInterval(()=>{
    if(!fcState)return;
    fcState.roundRemainingMs-=100;
    if(timerEl){
      timerEl.textContent=Math.max(0,Math.ceil(fcState.roundRemainingMs/1000))+'s';
      if(fcState.roundRemainingMs<=3000)timerEl.classList.add('fc-timer-low');
    }
    if(fcState.roundRemainingMs<=0){
      clearInterval(fcState.roundTimerInterval);
      fcState.roundTimerInterval=null;
      const st=document.getElementById('fc-status');
      if(st)st.textContent='';
      loseFlashcardGame();
    }
  },100);
}

function pulseHud(id){
  const el=document.getElementById(id);
  if(!el)return;
  const box=el.closest('.fc-hud-item');
  if(!box)return;
  box.classList.remove('fc-pulse');
  void box.offsetWidth; // force reflow so the animation can replay
  box.classList.add('fc-pulse');
}

// Floating "combo" popup — see .fc-streak-badge in style.css for why
// this is an absolutely-positioned overlay now rather than an in-flow
// pill (it used to visibly nudge the camera stage down/up every time
// it appeared). Lives inside the streak HUD item itself (see
// index.html — moved out of .fc-card-wrap per feedback so it visibly
// pops out of the streak number's own card instead of floating above
// the unrelated letter card) and is centered on it at rest, so the
// animation reads as erupting from that box before drifting upward.
// Rebuilds the badge's content each time (same replay-via-fresh-node
// trick as renderFlashcardLetter) and replays its pop-in/fade-out
// animation on every streak INCREASE once a tier is reached (3/5/10,
// see FLASHCARD_STREAK_TIERS), not just the first time it appears —
// the animation itself handles both the entrance and the fade back
// out, so nothing needs a matching "hide" call.
const FC_BADGE_FLAME_SVG='<svg class="fc-badge-flame" viewBox="0 0 24 24" aria-hidden="true"><path d="M10 2c0 -.88 1.056 -1.331 1.692 -.722c1.958 1.876 3.096 5.995 1.75 9.12l-.08 .174l.012 .003c.625 .133 1.203 -.43 2.303 -2.173l.14 -.224a1 1 0 0 1 1.582 -.153c1.334 1.435 2.601 4.377 2.601 6.27c0 4.265 -3.591 7.705 -8 7.705s-8 -3.44 -8 -7.706c0 -2.252 1.022 -4.716 2.632 -6.301l.605 -.589c.241 -.236 .434 -.43 .618 -.624c1.43 -1.512 2.145 -2.924 2.145 -4.78"/></svg>';
function updateFlashcardStreakBadge(streak){
  const badge=document.getElementById('fc-streak-badge');
  if(!badge)return;
  const tier=FLASHCARD_STREAK_TIERS.find(t=>streak>=t.at);
  if(!tier){badge.className='fc-streak-badge';badge.innerHTML='';return;}
  badge.innerHTML=FC_BADGE_FLAME_SVG+' คอมโบ x'+streak;
  badge.className='fc-streak-badge '+tier.cls; // drops any previous .fc-pop so the animation can replay
  void badge.offsetWidth; // force reflow
  badge.classList.add('fc-pop');
  playSfx('pop',{volume:0.5,overlap:false});
}

// "On fire" wall at the bottom of the page — see .fc-fire-wall in
// style.css. Fixed to the viewport (not just this screen), so leaving
// the flash card tab or ending the run must explicitly hide it again
// (see exitFlashcardScreen/startFlashcardGame/loseFlashcardGame below) —
// it won't just scroll out of view on its own like an in-page element
// would.
const FLASHCARD_FIRE_STREAK=35;
// Per feedback the wall shouldn't jump straight to full-size flames the
// instant it appears at FLASHCARD_FIRE_STREAK — it now grows from a
// small starting scale up to full size by the time streak reaches this.
// Drives --fc-fire-scale (see .fc-fire-wall in style.css), which both
// the flame icons (via fcFlameFlicker's calc(--fc-fs * --fc-fire-scale))
// and the warm glow bleeding off the wall's top (::before, scaleY) key
// off of — one number, two places it visibly grows.
// MIN_SCALE raised from .35 to .6 per feedback that the wall started
// off reading as "too small" at FLASHCARD_FIRE_STREAK — .6 still gives
// room to visibly grow up to MAX_STREAK, just from a bigger starting
// point.
const FLASHCARD_FIRE_MAX_STREAK=100;
const FLASHCARD_FIRE_MIN_SCALE=.6;
function updateFlashcardFireWall(streak){
  const wall=document.getElementById('fc-fire-wall');
  if(!wall)return;
  const wasShowing=wall.classList.contains('show');
  const nowShowing=streak>=FLASHCARD_FIRE_STREAK;
  wall.classList.toggle('show',nowShowing);
  if(nowShowing&&!wasShowing)playSfx('fire-transition'); // the actual "start" edge — every later call this run just keeps it showing/growing, not re-starting
  const progress=Math.max(0,Math.min(1,(streak-FLASHCARD_FIRE_STREAK)/(FLASHCARD_FIRE_MAX_STREAK-FLASHCARD_FIRE_STREAK)));
  const scale=FLASHCARD_FIRE_MIN_SCALE+(1-FLASHCARD_FIRE_MIN_SCALE)*progress;
  wall.style.setProperty('--fc-fire-scale',scale.toFixed(3));
}

// Ambient warm-tint escalation — see #fc-bg-tint in style.css. Stays
// fully transparent (cold, see #fc-bg-tint-cold) until streak passes
// FLASHCARD_TINT_START, then ramps in strength linearly up to full
// opacity by FLASHCARD_FIRE_STREAK — the same threshold the fire wall
// itself uses — so the page's overall "heat" escalates continuously
// right up to the moment the fire wall appears, rather than the two
// effects being on separate, disconnected cues. Called alongside
// updateFlashcardFireWall() everywhere streak changes or resets.
//
// Also toggles .fc-heated on #screen-flashcard at that same
// FLASHCARD_TINT_START threshold. That class is what switches the
// screen's other orange/warm accents (the big letter, the HUD item
// backgrounds, the drifting background decor) over to a cool blue —
// per feedback the background gradient going cold wasn't enough on
// its own, because those other elements are hardcoded orange in CSS
// and read as "still hot" regardless of what the two tint layers
// underneath were doing. Kept as a binary swap (not a third parallel
// ramp) since these are small accent surfaces, not a full-bleed wash —
// a hard swap reads cleanly at this scale and the `transition: ...
// .6s ease` on each of those rules still crossfades it, so it doesn't
// look like an abrupt flash.
const FLASHCARD_TINT_START=15;
function updateFlashcardTint(streak){
  const tint=document.getElementById('fc-bg-tint');
  const screen=document.getElementById('screen-flashcard');
  if(screen)screen.classList.toggle('fc-heated',streak>=FLASHCARD_TINT_START);
  if(!tint)return;
  // Explicit early-out rather than leaning on Math.max(0,...) to clamp
  // a negative ratio to 0 — same end result below FLASHCARD_TINT_START,
  // but this makes "flat-out cold, no hot layer at all" an unmissable
  // branch on its own instead of a side-effect of the math, per
  // feedback that the hot tint must read as strictly off before 15.
  if(streak<FLASHCARD_TINT_START){tint.style.opacity=0;return;}
  const progress=(streak-FLASHCARD_TINT_START)/(FLASHCARD_FIRE_STREAK-FLASHCARD_TINT_START);
  tint.style.opacity=Math.min(1,progress);
}

function resolveFlashcardRound(){
  if(!fcState||fcState.resolved)return;
  fcState.resolved=true;
  if(fcState.roundTimerInterval){clearInterval(fcState.roundTimerInterval);fcState.roundTimerInterval=null;}
  // Every other correct-answer path (checkAnswer()/gestureAnswered() in
  // the lesson flow) plays 'correct' the moment it resolves — flashcards
  // never did, since this game only ever had an end-of-run sfx
  // (loseFlashcardGame()'s win/lose) and nothing per-round. overlap:false
  // for the same reason as those two call sites: a round only ever
  // resolves once, so there's nothing to overlap, and cloneNode() is what
  // caused the earlier "correct/wrong lag" bug elsewhere in the file.
  playSfx('correct',{overlap:false});

  fcState.streak++;
  // Fires the moment the streak reaches 20 — mid-run, not only if the
  // run happens to end right there — since fcState itself isn't
  // persisted anywhere a later "best streak" could be recomputed from.
  if(fcState.streak>=20)unlockAchievement('fc_streak_20');
  // Same reasoning, timed to FLASHCARD_FIRE_STREAK instead of a fixed
  // 20 — i.e. the exact streak where updateFlashcardFireWall() below
  // makes the fire wall visible for the first time this run.
  if(fcState.streak>=FLASHCARD_FIRE_STREAK)unlockAchievement('fc_on_fire');
  const gainedScore=flashcardScoreForStreak(fcState.streak);
  const gainedXp=flashcardXpForStreak(fcState.streak);
  fcState.score+=gainedScore;
  fcState.xpEarned+=gainedXp;

  document.getElementById('fc-hud-score').textContent=fcState.score;
  document.getElementById('fc-hud-streak').textContent=fcState.streak;
  document.getElementById('fc-hud-xp').textContent=fcState.xpEarned;
  pulseHud('fc-hud-score');pulseHud('fc-hud-streak');pulseHud('fc-hud-xp');
  updateFlashcardStreakBadge(fcState.streak);
  updateFlashcardFireWall(fcState.streak);
  updateFlashcardTint(fcState.streak);
  const cardWrap=document.getElementById('fc-card');
  if(cardWrap){cardWrap.classList.remove('fc-card-correct');void cardWrap.offsetWidth;cardWrap.classList.add('fc-card-correct');}
  const st=document.getElementById('fc-status');
  if(st)st.textContent='';

  // Small pause so the "ถูกต้อง!" feedback (HUD pulse + card glow flash)
  // actually registers before the next letter/round timer starts —
  // mirrors the brief pause lesson gesture questions have via
  // gestureAnswered()'s "กำลังไปข้อต่อไป..." message before nextQ() fires.
  setTimeout(()=>{
    if(!fcState)return; // game may have been exited during the pause
    beginFlashcardRound(pickFlashcardCard(fcState.card));
  },700);
}

// Builds a burst of falling/spinning icon confetti as an HTML string
// (randomized left offset/delay/duration/rotation per piece via inline
// style) — used only on a new best score, so it stays a rare treat
// rather than firing on every single round. Pure CSS animation
// (fcConfettiFall, see style.css); the spans remove themselves from
// layout naturally when #fc-result-view is next replaced.
// Was emoji pieces (🎉✨⭐🎊💫) — replaced with tabler icons (same set
// used everywhere else on the site now) in randomized theme colors,
// since a plain icon glyph has no color of its own the way emoji did.
function flashcardConfettiHtml(){
  const iconNames=['confetti','sparkles','star-filled'];
  const colors=['var(--gold)','var(--orange)','var(--green)','var(--blue)','var(--purple)','var(--red)'];
  let out='';
  for(let i=0;i<24;i++){
    const iconName=iconNames[Math.floor(Math.random()*iconNames.length)];
    const color=colors[Math.floor(Math.random()*colors.length)];
    const left=Math.round(Math.random()*100);
    const delay=(Math.random()*0.6).toFixed(2);
    const dur=(2.2+Math.random()*1.2).toFixed(2);
    const drift=Math.round((Math.random()*80)-40);
    out+=`<span class="fc-confetti-piece" style="left:${left}%;color:${color};animation-delay:${delay}s;animation-duration:${dur}s;--fc-drift:${drift}px;"><i class="ti ti-${iconName}"></i></span>`;
  }
  return out;
}

function loseFlashcardGame(){
  if(!fcState)return;
  teardownFlashcardCamera();
  updateFlashcardFireWall(0);
  updateFlashcardTint(0);
  const{score,streak,xpEarned}=fcState;
  const prevBest=state.score||0;
  // best score per leaderboard category. letters pool -> scoreLetters, signs pool -> scoreSigns, a mixed run counts only for "all" (state.score).
  const poolKey=fcState.pool==='letters'?'scoreLetters':fcState.pool==='signs'?'scoreSigns':null;
  const isNewPoolBest=!!poolKey&&score>(state[poolKey]||0);
  const isNewBest=score>prevBest||isNewPoolBest;
  const celebrate=isNewBest&&!state.isGuest;
  // This run just ended — every other end-of-run path in the app
  // (failTest(), finishLesson()'s bonus-all-wrong case) plays a
  // lose/completed sfx; the flash card game's only "end" (a run always
  // ends by running out of time — see this function's single call
  // site) had no sfx at all until now. A genuinely new best score now
  // gets the same 'completed' cue lessons use for a finished run,
  // instead of 'lose' — matches the trophy/confetti result screen
  // below, which already treats `celebrate` as the "you won" case.
  playSfx(celebrate?'completed':'lose');
  // Guests can still play (same free-preview spirit as guest lesson
  // attempts — see finishLesson()) but nothing persists once the tab
  // closes, so their score/xp are shown for this run only, never
  // written into state/Firestore.
  if(!state.isGuest){
    if(score>prevBest)state.score=score;
    if(isNewPoolBest)state[poolKey]=score;
    state.xp+=xpEarned;
    if(typeof window.fbSaveState==='function')window.fbSaveState();
    // Was just a p-xp text update — now also refreshes p-level/tier and
    // the XP-to-next-level bar, since a flashcard run can push someone
    // across a level threshold same as a lesson can.
    renderLevelStats();
    // xp just moved, so re-sweep for any 'level' kind achievement it
    // might newly clear — same reasoning as the finishLesson() call.
    checkAchievements();
  }
  // A "session" is any run through to a loss (the only way a run ends
  // right now — see loseFlashcardGame()'s single call site) — fires
  // for guests too, same as other event achievements, even though it
  // won't persist past this tab for them.
  unlockAchievement('fc_first_session');

  document.getElementById('fc-play-view').style.display='none';
  document.getElementById('fc-result-view').style.display='block';
  document.getElementById('fc-result-view').innerHTML=`
    <div class="lf-result-wrap fc-result-wrap">
      ${celebrate?'<div class="fc-confetti">'+flashcardConfettiHtml()+'</div>':''}
      <div class="lf-result-emoji" style="color:${celebrate?'var(--gold)':'var(--red)'};"><i class="ti ti-${celebrate?'trophy-filled':'heart-broken'}"></i></div>
      <div class="lf-result-num" style="color:${celebrate?'var(--gold)':'var(--red)'};">${score}</div>
      <p>ตอบถูกต่อเนื่อง ${streak} ตัว${celebrate?' สถิติใหม่! <i class="ti ti-confetti"></i>':''}</p>
      ${state.isGuest
        ?`<div class="lf-guest-note">สมัครสมาชิกเพื่อเก็บคะแนนและ XP (+${xpEarned} XP รอคุณอยู่)</div>`
        :`<div class="lf-xp-badge"><i class="ti ti-bolt"></i> +${xpEarned} XP</div>`}
      <div style="display:flex;gap:10px;margin-top:22px;">
        <button class="btn-main" style="width:auto;padding:13px 28px;" onclick="startFlashcardGame()">เล่นอีกครั้ง</button>
        <button class="btn-logout" onclick="exitFlashcardScreen();refreshLessonStates();">กลับ</button>
      </div>
    </div>`;
}
/* DEBUG-ONLY: force the current question to be answered correctly
   without touching the camera/option UI. Wired to the (normally
   hidden — see the DEVMODE key-combo listener below) "ตอบถูกอัตโนมัติ
   (Debug)" button in index.html's lesson header. Safe to remove later;
   doesn't affect real scoring/XP logic at all, it just drives the exact
   same recordQuestionResult()/checkAnswer()/gestureAnswered() path a
   real correct answer would. */
function debugCompleteQuestion(){
  if(!activeQuiz||activeQuiz.answered)return;
  const q=activeQuiz.questions[activeQuiz.idx];
  if(!q)return;
  if(q.question_type==='gesture'){
    activeQuiz.gestureTimerStartedAt=null;   // the dev skip must not earn 'fast_hands'
    gestureAnswered(true);
  }else{
    activeQuiz.selected=q.correct_answer;
    checkAnswer();
  }
}

/* DEBUG-ONLY: skips the current flash card round as if answered
   correctly, without touching the camera. Same idea as
   debugCompleteQuestion() above, but deliberately does NOT run
   resolveFlashcardRound() itself — that function adds the round's
   score/XP to fcState.score/fcState.xpEarned, which loseFlashcardGame()
   later writes into the player's real state.score/state.xp (and
   Firestore) at the end of the run. Reusing it here would let dev-mode
   testing quietly inflate a real leaderboard score or XP total.
   Streak DOES still advance — that's the actual point of this button,
   letting streak-gated visuals (the tint ramp, the fire wall) get
   tested without needing dozens of real camera reps — it just carries
   no reward. Jumps by 10 per press (not 1) so reaching gated
   thresholds like FLASHCARD_FIRE_STREAK (35) or FLASHCARD_FIRE_MAX_STREAK
   (100) only takes a few taps instead of dozens. Wired to a button on
   the flash card HUD, hidden unless
   devmode-on (same DEVMODE key-combo as debugCompleteQuestion's
   button — see the listener below). */
function debugSkipFlashcardRound(){
  if(!fcState||fcState.resolved)return;
  fcState.resolved=true;
  if(fcState.roundTimerInterval){clearInterval(fcState.roundTimerInterval);fcState.roundTimerInterval=null;}

  fcState.streak+=10;
  // No score/xp added on purpose — see comment above. Streak-threshold
  // achievements ARE checked here though (previously missing) — unlike
  // score/xp, unlocking an achievement doesn't inflate anything a
  // leaderboard reads, and this is genuinely the same streak value
  // resolveFlashcardRound() would have checked had these 10 rounds
  // been played for real. Same two checks, same thresholds.
  if(fcState.streak>=20)unlockAchievement('fc_streak_20');
  if(fcState.streak>=FLASHCARD_FIRE_STREAK)unlockAchievement('fc_on_fire');

  document.getElementById('fc-hud-streak').textContent=fcState.streak;
  pulseHud('fc-hud-streak');
  updateFlashcardStreakBadge(fcState.streak);
  updateFlashcardFireWall(fcState.streak);
  updateFlashcardTint(fcState.streak);
  const st=document.getElementById('fc-status');
  if(st)st.textContent='';

  setTimeout(()=>{
    if(!fcState)return; // game may have been exited during the pause
    beginFlashcardRound(pickFlashcardCard(fcState.card));
  },700);
}

/* ------------------------------------------------------------
   SECRET DEVMODE KEY COMBO
   ------------------------------------------------------------
   Typing D-E-V-M-O-D-E anywhere (outside a text field, so it can't
   fire from normal typing in any input)
   toggles the `devmode-on` class on <body>, which is what actually
   shows/hides the debug button via CSS (see .lf-debug-btn in
   style.css) — this listener never touches the button directly, so
   it works regardless of which screen is showing. Buffer resets on
   any non-character key (arrows, Enter, Shift, etc.) or the moment
   focus is inside an editable element. */
(function(){
  const DEVMODE_CODE='DEVMODE';
  let buf='';
  document.addEventListener('keydown',(e)=>{
    const active=document.activeElement;
    const isEditable=active&&(active.tagName==='INPUT'||active.tagName==='TEXTAREA'||active.isContentEditable);
    if(isEditable){buf='';return;}
    if(e.key.length!==1){return;} // ignore Shift/Enter/arrows/etc.
    buf=(buf+e.key.toUpperCase()).slice(-DEVMODE_CODE.length);
    if(buf===DEVMODE_CODE){
      buf='';
      const turnedOn=document.body.classList.toggle('devmode-on');
      if(turnedOn)devModeSnapshot();else devModeRestore();
      // Debug mode unlocking every node (see computeMainNodeState/
      // computeBonusNodeState/computeInfoNodeState's isDevMode() checks)
      // needs the already-rendered lesson path to be repainted right
      // away — refreshLessonStates() patches every node in place
      // in-line with its normal per-node update, doesn't rebuild anything.
      if(typeof refreshLessonStates==='function')refreshLessonStates();
      // 'Secret Unlock!' (hidden achievement — see ACHIEVEMENTS) fires
      // the moment dev mode is actually switched ON, not on every
      // toggle (typing DEVMODE again to switch it back off shouldn't
      // re-fire anything — unlockAchievement() is a no-op past the
      // first time anyway, but the turnedOn guard keeps this from even
      // trying on the OFF toggle).
      if(turnedOn&&typeof unlockAchievement==='function')unlockAchievement('secret_unlock');
    }
  });
})();

/* ------------------------------------------------------------
   SECRET "WARFRAME" EASTER EGG
   ------------------------------------------------------------
   Same buffered key-combo pattern as the DEVMODE listener just above
   (typed anywhere outside a text field, buffer resets on non-character
   keys or focus landing in an editable element) — just a different
   code and a different payload. Typing W-A-R-F-R-A-M-E plays an Ordis
   voice line from assets/sfx/warframe.mp3 (assets/ is a sibling of
   html/ and js/ — see PROFILE_PIC_DIR/GESTURE_IMG_DIR in lessons.js
   for the same '../assets/...' path convention from inside html/),
   unlocks the hidden 'ordis_secret' achievement (see ACHIEVEMENTS —
   hidden so the list itself doesn't spoil the code, same treatment as
   'secret_unlock'), and drives a light-blue audio-reactive visualizer
   bar pinned to the bottom of the screen for as long as the clip
   plays. The canvas is created here at runtime (not in index.html/
   style.css) so this whole feature — including its one-time visual
   element — lives entirely in this one file and can be lifted out
   cleanly later if needed. */
(function(){
  const CODE='WARFRAME';
  let buf='';
  let audioCtx=null; // created lazily on first trigger — browsers can
                      // refuse AudioContext/autoplay before a genuine
                      // user gesture, and typing the code IS that
                      // gesture, so there's nothing to gain by
                      // creating it any earlier.
  let rafId=null;

  function ensureVisualizerCanvas(){
    let canvas=document.getElementById('warframe-visualizer');
    if(canvas)return canvas;
    canvas=document.createElement('canvas');
    canvas.id='warframe-visualizer';
    Object.assign(canvas.style,{
      position:'fixed',left:'0',bottom:'0',width:'100%',height:'110px',
      pointerEvents:'none',zIndex:'9999',opacity:'0',
      transition:'opacity .6s ease',
    });
    document.body.appendChild(canvas);
    return canvas;
  }

  // Backing pixel size follows devicePixelRatio (so it isn't blurry on
  // hi-DPI screens) while the drawing code below still works in plain
  // CSS-pixel coordinates via the ctx.setTransform scale. Always reads
  // window.innerWidth FRESH (never a value cached from an earlier
  // call) — see playWarframeSfx()'s resize listener below, which calls
  // this again mid-playback specifically so the strip keeps spanning
  // the full CURRENT viewport width if the window gets resized or
  // rotated while the clip is still playing, instead of staying
  // stretched/pinned to whatever width happened to be current the
  // moment WARFRAME was typed.
  function sizeCanvas(canvas){
    const dpr=window.devicePixelRatio||1;
    const cssH=110;
    const cssW=window.innerWidth;
    canvas.width=Math.round(cssW*dpr);
    canvas.height=Math.round(cssH*dpr);
    const ctx=canvas.getContext('2d');
    ctx.setTransform(dpr,0,0,dpr,0,0); // canvas.width/height writes above reset the drawing state, so the dpr scale has to be re-applied every time this runs, not just on first setup
    return {ctx,cssW,cssH};
  }

  // `dims` is a plain mutable {cssW,cssH} object (not two separate
  // params) specifically so playWarframeSfx()'s resize listener can
  // update it in place and have every already-in-flight
  // requestAnimationFrame recursion below pick up the new width on its
  // very next frame — passing cssW/cssH as ordinary params would freeze
  // them at whatever they were when this recursion chain started.
  function drawFrame(ctx,dims,analyser,data){
    rafId=requestAnimationFrame(()=>drawFrame(ctx,dims,analyser,data));
    analyser.getByteFrequencyData(data);
    const{cssW,cssH}=dims;
    ctx.clearRect(0,0,cssW,cssH);
    const barCount=data.length;
    const barW=cssW/barCount;
    // getByteFrequencyData() is ordered low->high frequency, and bass
    // (low indices, near data[0]) is almost always the loudest part of
    // a voice clip — reading it straight left-to-right piles all the
    // tall bars on the left and tapers off toward the right, which is
    // what read as "left-heavy". Mirroring distance-from-center onto
    // the frequency index instead puts the loud bass bins in the
    // middle bar and tapers symmetrically toward BOTH edges, so the
    // whole strip reads centered no matter which bin is loudest.
    const center=(barCount-1)/2;
    // A voice clip's actual energy sits almost entirely in the LOWER
    // half of the FFT bins (fftSize=128 → 64 bins spanning 0..Nyquist,
    // and speech barely reaches past a few kHz) — mapping distance
    // linearly across the FULL 0..63 bin range meant freqIdx blew past
    // that useful range within just the first few bars out from
    // center, so everything beyond that read as near-silent, flat
    // treble. The bars were technically still drawn all the way to
    // both edges (the canvas itself was already full viewport width —
    // see sizeCanvas() above), it just LOOKED like the voice "couldn't
    // reach" past the middle because there was nothing but silence out
    // there. Two changes fix that:
    // 1. usefulBins caps the mapped range to the lower half of the
    //    spectrum, where a voice clip actually has content, instead of
    //    wasting the outer half of every bar's mapping on bins that
    //    are essentially always silent.
    // 2. The `Math.pow(norm,EASE)` curve (EASE>1) makes freqIdx climb
    //    SLOWLY at first — i.e. bars near center stay in the loud low
    //    bins for longer as `dist` grows — stretching that same useful
    //    content across much more of the strip's width before finally
    //    tapering into the quiet high end right at the outer edges.
    const usefulBins=Math.max(4,Math.floor(data.length/2));
    const EASE=1.8;
    for(let i=0;i<barCount;i++){
      const dist=Math.abs(i-center);
      const norm=dist/center; // 0 at the center bar, 1 at either edge
      const freqIdx=Math.min(usefulBins-1,Math.round(Math.pow(norm,EASE)*(usefulBins-1)));
      // Gamma-boosts quieter bins (v<1) so bars further from center —
      // which, after the compression above, carry genuinely quieter
      // content — still show a visible sliver instead of rounding down
      // to nothing. Pure cosmetic scaling, doesn't touch the actual
      // audio.
      const v=Math.pow(data[freqIdx]/255,0.7);
      const barH=v*cssH;
      // Gradient rises FROM the bottom edge (opaque light blue) and
      // fades to transparent toward the bar's tip, per spec.
      const grad=ctx.createLinearGradient(0,cssH,0,cssH-barH);
      grad.addColorStop(0,'rgba(56,189,248,0.9)');
      grad.addColorStop(1,'rgba(56,189,248,0)');
      ctx.fillStyle=grad;
      ctx.fillRect(i*barW,cssH-barH,barW*0.7,barH);
    }
  }

  function playWarframeSfx(){
    if(rafId){cancelAnimationFrame(rafId);rafId=null;} // in case the code gets typed again mid-clip
    const canvas=ensureVisualizerCanvas();
    const{ctx,cssW,cssH}=sizeCanvas(canvas);
    const dims={cssW,cssH};
    // Re-runs sizeCanvas() (which re-reads window.innerWidth fresh —
    // see its comment) any time the window resizes/rotates while the
    // clip is playing, and writes the new width straight into `dims`
    // so drawFrame()'s already-running rAF loop picks it up next
    // frame — the whole reason drawFrame takes a mutable dims object
    // instead of plain cssW/cssH params. getContext('2d') always
    // returns the SAME context object for a given canvas, so `ctx`
    // itself never needs to change here, just its width/height/dpr
    // transform via sizeCanvas().
    function handleResize(){
      const s=sizeCanvas(canvas);
      dims.cssW=s.cssW;dims.cssH=s.cssH;
    }
    window.addEventListener('resize',handleResize);
    const audio=new Audio('../assets/sfx/warframe.mp3');
    try{
      audioCtx=audioCtx||new (window.AudioContext||window.webkitAudioContext)();
      if(audioCtx.state==='suspended')audioCtx.resume();
      const source=audioCtx.createMediaElementSource(audio);
      const analyser=audioCtx.createAnalyser();
      analyser.fftSize=128; // -> 64 frequency bins, a reasonable bar count for a full-width bottom strip
      source.connect(analyser);
      analyser.connect(audioCtx.destination);
      const data=new Uint8Array(analyser.frequencyBinCount);
      canvas.style.opacity='1';
      drawFrame(ctx,dims,analyser,data);
      audio.addEventListener('ended',()=>{
        canvas.style.opacity='0'; // CSS transition above fades it out
        if(rafId){cancelAnimationFrame(rafId);rafId=null;}
        window.removeEventListener('resize',handleResize);
      });
    }catch(e){
      // Web Audio graph failed (older browser, some autoplay-policy
      // edge case, etc.) — still let the voice line play plainly
      // rather than losing the easter egg over a missing visualizer.
      console.warn('[warframe-easter-egg] visualizer setup failed, playing sfx without it:',e);
      window.removeEventListener('resize',handleResize); // nothing left to keep in sync
    }
    audio.play().catch(err=>{
      console.warn('[warframe-easter-egg] audio.play() failed:',err);
    });
    if(typeof unlockAchievement==='function')unlockAchievement('ordis_secret');
  }

  document.addEventListener('keydown',(e)=>{
    const active=document.activeElement;
    const isEditable=active&&(active.tagName==='INPUT'||active.tagName==='TEXTAREA'||active.isContentEditable);
    if(isEditable){buf='';return;}
    if(e.key.length!==1)return; // ignore Shift/Enter/arrows/etc.
    buf=(buf+e.key.toUpperCase()).slice(-CODE.length);
    if(buf===CODE){
      buf='';
      playWarframeSfx();
    }
  });
})();

/* everything dev mode does to the player's progress is temporary. Turning dev mode ON takes a snapshot, turning it
   OFF puts it back (lessons completed before stay completed; lessons dev mode completed are undone). Saving to Firestore is paused
   while dev mode is on (firebase-init.js fbSaveState), and achievements cannot unlock (unlockAchievement). Achievements are not
   part of the snapshot (only 'secret_unlock' can change during dev mode). */
let _devSnapshot=null;
const DEV_SNAPSHOT_KEYS=['xp','score','scoreLetters','scoreSigns','progress','bonusNodes','milestones','wrongCounts'];
function devModeSnapshot(){
  _devSnapshot={};
  DEV_SNAPSHOT_KEYS.forEach(k=>{_devSnapshot[k]=state[k]===undefined?undefined:JSON.parse(JSON.stringify(state[k]));});
  _devSnapshot.achievements=JSON.parse(JSON.stringify(state.achievements||{}));
}
function devModeRestore(){
  if(!_devSnapshot)return;
  DEV_SNAPSHOT_KEYS.forEach(k=>{state[k]=_devSnapshot[k]===undefined?undefined:JSON.parse(JSON.stringify(_devSnapshot[k]));});
  // achievements: back to the list from before dev mode, plus the two dev-mode ones if they were earned meanwhile
  const keep={};
  DEV_PERMANENT_ACHIEVEMENTS.forEach(id=>{if(state.achievements&&state.achievements[id])keep[id]=state.achievements[id];});
  state.achievements=Object.assign({},_devSnapshot.achievements||{},keep);
  _devSnapshot=null;
  checkAchievements();   // real progress only (dev mode is off now)
  renderAll();
  if(typeof window.fbSaveState==='function')window.fbSaveState();   // catches up the save that was paused (e.g. 'secret_unlock')
}
function isDevMode(){
  return document.body.classList.contains('devmode-on');
}

function updateProgressBar(){
  const{lesson,questions,idx}=activeQuiz;
  const pct=Math.min(100,Math.round((idx/questions.length)*100));
  document.getElementById('lf-progress-fill').style.width=pct+'%';
}

function renderQ(){
  teardownGesture();
  const{lesson,questions,idx}=activeQuiz;
  const inner=document.getElementById('lf-body-inner');
  const footer=document.getElementById('lf-footer');
  updateProgressBar();

  if(idx>=questions.length){
    requeueMissedOrFinish();
    return;
  }

  activeQuiz.selected=null;
  activeQuiz.answered=false;
  const q=questions[idx];

  if(q.question_type==='gesture'){
    renderGestureQ(q);
  }else{
    renderQaQ(q);
  }

  footer.style.display='flex';
  footer.className='lf-footer';
  document.getElementById('lf-continue-btn').textContent='ตรวจคำตอบ';
  document.getElementById('lf-continue-btn').className='lf-continue-btn';
  document.getElementById('lf-continue-btn').disabled=q.question_type!=='gesture';
  document.getElementById('lf-continue-btn').onclick=checkAnswer;
  if(q.question_type==='gesture'){
    // gesture questions are self-checking (camera match / timeout), the
    // continue button just advances once an answer has been recorded
    document.getElementById('lf-continue-btn').style.display='none';
  }else{
    document.getElementById('lf-continue-btn').style.display='inline-block';
  }
}

// Builds a per-letter ASL reference photo path under lessons.js's
// GESTURE_IMG_DIR (e.g. 'A' -> '../assets/gestures/A.jpg'). Used both
// by renderQaQ() below (auto-derived from the correct answer when a
// question's own question_image is left blank) and by openInfoNode()'s
// per-letter preview cards.
function gestureImageSrc(letter){
  return GESTURE_IMG_DIR+String(letter).toUpperCase()+'.jpg';
}
// Shared onerror handler for gesture reference <img>s (quiz question
// image + info-node preview cards). Real files under assets/gestures/
// may not exist yet for every letter (see lessons.js's TODO next to
// GESTURE_IMG_DIR) — this swaps a broken <img> for the same hand-icon
// placeholder shown when there's no image at all, instead of leaving
// a broken-image glyph on screen.
function handleGestureImgError(imgEl){
  const ph=document.createElement('div');
  ph.className='lf-q-image lf-q-image-placeholder';
  ph.innerHTML='<i class="ti ti-hand-stop"></i>';
  imgEl.replaceWith(ph);
}

function renderQaQ(q){
  const inner=document.getElementById('lf-body-inner');
  // Prefer an explicit per-question question_image (lessons.js); if
  // that's left blank, derive one from the correct answer's letter
  // instead of falling straight to the placeholder — most qa
  // questions never got a hand-picked image, so this is what actually
  // makes real gesture photos show up once assets/gestures/ is filled
  // in, with no lessons.js edits needed.
  const correctChoice=q.choices.find(c=>c.choice_id===q.correct_answer);
  const imgSrc=q.question_image||(correctChoice&&!q.sign?gestureImageSrc(correctChoice.choice_value):'');
  // question_images[] (emotion/word signs): 1-3 frames (start/middle/end) shown as a strip.
  const frames=Array.isArray(q.question_images)?q.question_images:[];
  const img=frames.length>1
    ?`<div class="lf-seq">${frames.map((f,i)=>(i?'<i class="ti ti-chevron-right lf-seq-arrow"></i>':'')+`<img class="lf-q-image" src="${f}" alt="ท่ามือ ภาพที่ ${i+1}" onerror="handleGestureImgError(this)">`).join('')}</div>`
    :imgSrc
    ?`<img class="lf-q-image${q.sign?' lf-q-sign':''}" src="${imgSrc}" alt="ท่ามือ" onerror="handleGestureImgError(this)">`
    :`<div class="lf-q-image lf-q-image-placeholder"><i class="ti ti-hand-stop"></i></div>`;
  const redoPill=activeQuiz.redoIds.has(q.question_id)?`<div class="lf-redo-pill"><i class="ti ti-refresh"></i> ตอบผิดไปแล้ว ลองอีกครั้ง</div>`:'';
  inner.innerHTML=`
    <div class="lf-q-header">
      <div class="lf-title">${lessonDisplayName(activeQuiz.lesson)}</div>
      ${redoPill}
    </div>
    <div class="lf-question">${q.question_head}</div>
    ${img}
    <div class="lf-opts" id="lf-opts">
      ${q.choices.map(c=>`<button class="lf-opt" data-cid="${c.choice_id}" onclick="selectOpt('${c.choice_id}')">${c.choice_value}</button>`).join('')}
    </div>`;
}

function selectOpt(choiceId){
  if(activeQuiz.answered)return;
  activeQuiz.selected=choiceId;
  const opts=document.querySelectorAll('.lf-opt');
  opts.forEach(b=>{
    if(b.dataset.cid===choiceId){b.style.borderColor='var(--blue)';b.style.background='var(--blue-light)';}
    else{b.style.borderColor='';b.style.background='';}
  });
  const btn=document.getElementById('lf-continue-btn');
  btn.disabled=false;btn.classList.add('enabled');
}

/* ------------------------------------------------------------
   GESTURE QUESTIONS (camera)
   ------------------------------------------------------------ */
function renderGestureQ(q){
  if(q.placeholder)return renderPlaceholderGestureQ(q);
  const inner=document.getElementById('lf-body-inner');
  const timed=activeQuiz.gestureTimerActive;
  const redoPill=activeQuiz.redoIds.has(q.question_id)?`<div class="lf-redo-pill"><i class="ti ti-refresh"></i> ตอบผิดไปแล้ว ลองอีกครั้ง</div>`:'';
  // Camera nodes of emotion / word signs show NO sign pictures: the learner saw them in the
  // quiz and info cards. The text under the camera counts steps with q.pic_count instead (see startSignCamera).
  inner.innerHTML=`
    <div class="lf-q-header">
      <div class="lf-title">${lessonDisplayName(activeQuiz.lesson)}</div>
      ${redoPill}
    </div>
    <div class="lf-question">${q.question_head}</div>
    <div class="gq-stage">
      <video id="gq-video" autoplay playsinline muted></video>
      <canvas id="gq-canvas"></canvas>
      ${timed?'<div class="gq-timer" id="gq-timer">'+GESTURE_TIME_LIMIT_S+'s</div>':''}
    </div>
    <div class="gq-status${gestureHintsOff()?' nohint':''}" id="gq-status">${gestureHintsOff()?'':'กดเริ่มกล้องแล้วทำท่ามือให้ตรงกับโจทย์ ค้างท่าไว้นิ่งๆ จนกว่าจะผ่าน'}</div>
    ${gestureHintsOff()?'<div class="cap" id="gq-cap"><div class="cap-track"><div class="cap-fill" id="gq-cap-fill"></div></div></div>':''}
    ${q.sign&&!gestureHintsOff()?'<div class="gq-prog" id="gq-prog"></div>':''}
    <div style="text-align:center;">
      <button class="btn-main" id="gq-start-btn" style="width:auto;padding:12px 28px;margin-top:14px;" onclick="startGestureCamera()">เริ่มกล้อง</button>
    </div>
  `;
  cameraAutoStart(q);   // starts by itself when the camera permission is already granted
}

// PLACEHOLDER camera node (emotions/words units, lessons.js makeCamQ):
// camera detection for these signs isn't built yet (Phase 2+). Shows a notice
// (no pictures, like the real camera nodes) and a button that passes the question through the same
// gestureAnswered(true) path a real camera pass would use. Replace this
// by removing q.placeholder once a sign has a real check.
function renderPlaceholderGestureQ(q){
  const inner=document.getElementById('lf-body-inner');
  const redoPill=activeQuiz.redoIds.has(q.question_id)?`<div class="lf-redo-pill"><i class="ti ti-refresh"></i> ตอบผิดไปแล้ว ลองอีกครั้ง</div>`:'';
  inner.innerHTML=`
    <div class="lf-q-header">
      <div class="lf-title">${lessonDisplayName(activeQuiz.lesson)}</div>
      ${redoPill}
    </div>
    <div class="lf-question">${q.question_head}</div>
    <div class="gq-placeholder">
      <i class="ti ti-camera-off"></i>
      <div>การตรวจจับท่ามือด้วยกล้องสำหรับท่านี้ยังไม่เปิดให้ใช้งาน</div>
    </div>
    <div style="text-align:center;">
      <button class="btn-main" id="gq-skip-btn" style="width:auto;padding:12px 28px;margin-top:14px;" onclick="this.disabled=true;gestureAnswered(true)">ผ่านไปก่อน</button>
    </div>
  `;
}

/* hints and automatic camera start.
   gestureHintsOff(): true in TEST and BONUS nodes and in the flashcard game: no text on HOW or WHERE to do the sign and 
   no step text / dots either; the capture bar (capShow / capFromSign) is the only indicator there. The flashcard game uses the same rules.
   markCameraOk() / cameraAutoStart(): when the browser already has the camera permission the camera starts by itself. The
   Permissions API tells it (Chrome, Edge, Android); Safari and Firefox cannot be asked, so a flag in localStorage remembers that the
   camera worked once on this device (it is cleared when starting the camera fails). */
function gestureHintsOff(mode){
  const m=mode||(activeQuiz&&activeQuiz.lesson&&activeQuiz.lesson.mode);
  return m==='test'||m==='bonus'||m==='flashcard';
}
function markCameraOk(){try{localStorage.setItem('g4y_cam_ok','1');}catch(e){}}
function markCameraBad(){try{localStorage.removeItem('g4y_cam_ok');}catch(e){}}
function cameraAutoStart(q){
  const quiz=activeQuiz;
  const go=()=>{
    if(activeQuiz!==quiz||quiz.questions[quiz.idx]!==q)return;
    const b=document.getElementById('gq-start-btn');
    if(!b||b.disabled||b.style.display==='none')return;
    startGestureCamera();
  };
  let remembered=false;try{remembered=localStorage.getItem('g4y_cam_ok')==='1';}catch(e){}
  if(navigator.permissions&&navigator.permissions.query){
    navigator.permissions.query({name:'camera'}).then(r=>{
      if(r.state==='granted')go();
      else if(r.state==='denied')markCameraBad();
    }).catch(()=>{if(remembered)go();});     // 'camera' not supported by this browser: use the remembered flag
  }else if(remembered)go();
}

function startGestureCamera(){
  const q=activeQuiz.questions[activeQuiz.idx];
  if(q.sign)return startSignCamera(q);   // emotion / word sign: recorded-pose check (sign-check.js)
  const startBtn=document.getElementById('gq-start-btn');
  const statusEl=document.getElementById('gq-status');
  startBtn.disabled=true;
  startBtn.textContent='กำลังโหลดกล้อง...';

  if(typeof GestureDetector==='undefined'){
    statusEl.textContent='ไม่สามารถโหลดระบบตรวจจับท่ามือได้ ตรวจสอบการเชื่อมต่ออินเทอร์เน็ต';
    startBtn.disabled=false;startBtn.textContent='ลองอีกครั้ง';
    return;
  }

  const expected='asl_'+q.correct_answer.toLowerCase();
  const isMotionLetter=(expected==='asl_j'||expected==='asl_z');
  let resolved=false;
  let holdStartTime=null;

  const detector=new GestureDetector({
    videoEl:document.getElementById('gq-video'),
    canvasEl:document.getElementById('gq-canvas'),
    enableMotionGestures:isMotionLetter,
    // J/Z confirm the instant their stroke completes (a motion can't be
    // "frozen"), but we align the engine's own freeze/display window to
    // the same GESTURE_FREEZE_MS constant used for held poses below.
    motionFreezeMs:GESTURE_FREEZE_MS,
    // Require the resting starting shape (I for J, D for Z) to be held
    // continuously for GESTURE_MOTION_RESTING_HOLD_MS before the engine
    // will even look for a stroke — without this, detect() runs the
    // instant restingOk is true even once, so a stroke traced while just
    // passing through the resting shape (never truly held) could still
    // match.
    motionRestingHoldMs:GESTURE_MOTION_RESTING_HOLD_MS,
    onGesture:(name,confidence)=>{
      if(resolved||!isMotionLetter)return;
      if(name===expected){
        resolved=true;
        statusEl.textContent=gestureHintsOff()?'':'ถูกต้อง! กำลังไปข้อต่อไป...';
        if(gestureHintsOff())capShow('gq-cap',100,'');
        gestureAnswered(true);
      }
    },
    // J/Z resting-position indicator: reuses the same #gq-status line as
    // everything else (no separate indicator element). restingReady only
    // becomes true once the hold gate above is satisfied — until then we
    // show a "keep holding" progress message instead of implying the
    // stroke can start, so the on-screen instruction actually matches
    // what the engine will accept.
    onMotionState:({name,restingOk,restingReady,restingHeldMs})=>{
      if(resolved||!isMotionLetter||name!==expected)return;
      if(gestureHintsOff()){      // no text, only the capture bar (gold = start pose seen, now trace)
        statusEl.textContent='';
        if(!restingOk)capShow('gq-cap',0);
        else if(!restingReady)capShow('gq-cap',Math.round(100*restingHeldMs/GESTURE_MOTION_RESTING_HOLD_MS));
        else capShow('gq-cap',100,'ready');
        return;
      }
      if(!restingOk){
        statusEl.textContent='ทำท่าวาดมือให้ตรงกับโจทย์';
      }else if(!restingReady){
        const pct=Math.min(100,Math.round((restingHeldMs/GESTURE_MOTION_RESTING_HOLD_MS)*100));
        statusEl.textContent='ค้างท่าเริ่มต้นไว้นิ่งๆ... '+pct+'%';
      }else{
        statusEl.textContent='ตรวจพบท่าเริ่มต้นแล้ว เริ่มขีดเส้นต่อได้เลย';
      }
    },
    onCandidate:(winner)=>{
      // Held-pose letters: require the expected gesture to be the engine's
      // resolved candidate (AFTER tie-breaker resolution — see
      // gesture-detection.js's onCandidate doc) for GESTURE_FREEZE_MS
      // straight before passing. Using raw onDebugScores here used to
      // fail on any letter that needs a TIE_BREAKERS resolver to separate
      // it from a look-alike (e.g. B vs F/W) — Fingerpose's curl/direction
      // score alone often doesn't put the correct letter on top, only the
      // engine's tie-breaker geometry does, and that only ever showed up
      // through onCandidate/onGesture, never through onDebugScores.
      if(resolved||isMotionLetter)return;
      const holding=winner&&winner.name===expected;
      const now=performance.now();
      if(holding){
        if(holdStartTime===null)holdStartTime=now;
        const elapsed=now-holdStartTime;
        const remainS=Math.max(0,(GESTURE_FREEZE_MS-elapsed)/1000).toFixed(1);
        statusEl.textContent=gestureHintsOff()?'':'ค้างท่าไว้นิ่งๆ... '+remainS+'s';
        if(gestureHintsOff())capShow('gq-cap',Math.round(100*elapsed/GESTURE_FREEZE_MS));
        if(elapsed>=GESTURE_FREEZE_MS){
          resolved=true;
          statusEl.textContent=gestureHintsOff()?'':'ถูกต้อง! กำลังไปข้อต่อไป...';
          if(gestureHintsOff())capShow('gq-cap',100,'');
          gestureAnswered(true);
        }
      }else{
        holdStartTime=null;
        if(gestureHintsOff())capShow('gq-cap',0);
      }
    },
    onError:(err)=>{},
  });
  activeQuiz.gestureDetector=detector;

  detector.start().then(()=>{
    markCameraOk();
    startBtn.style.display='none';
    statusEl.textContent=gestureHintsOff()?'':isMotionLetter
      ?'ทำท่าวาดมือให้ตรงกับโจทย์'
      :'ทำท่ามือให้ตรงกับโจทย์แล้วค้างไว้นิ่งๆ';
    if(activeQuiz.gestureTimerActive)startGestureTimer();
  }).catch(err=>{
    statusEl.textContent='เปิดกล้องไม่สำเร็จ กรุณาอนุญาตการใช้กล้อง';
    startBtn.disabled=false;startBtn.textContent='ลองอีกครั้ง';
  });
}

/* Face model for the face-zone signs (FACE_SIGNS in face-tracker.js): the two CDN scripts are loaded only when such a
   sign is first shown, so the app itself starts as fast as before. The zones are NEVER drawn in the lessons. */
var _faceLibsPromise=null;
function ensureFaceLibs(){
  if(typeof faceLandmarksDetection!=='undefined')return Promise.resolve();
  if(_faceLibsPromise)return _faceLibsPromise;
  const load=(src)=>new Promise((res,rej)=>{const el=document.createElement('script');el.src=src;el.onload=res;el.onerror=()=>rej(new Error('load '+src));document.head.appendChild(el);});
  _faceLibsPromise=load('https://cdn.jsdelivr.net/npm/@mediapipe/face_mesh@0.4.1633559619/face_mesh.js')
    .then(()=>load('https://cdn.jsdelivr.net/npm/@tensorflow-models/face-landmarks-detection@1.0.5/dist/face-landmarks-detection.min.js'))
    .catch(e=>{_faceLibsPromise=null;throw e;});
  return _faceLibsPromise;
}

/* Real camera check for an emotion / word sign (one-hand and two-hand signs, see TWO_HAND_LESSON_ON /
   CAMERA_NEEDS_FACE in lessons.js). Same shell as startGestureCamera (one detector per question, torn
   down by teardownGesture), but the hands are checked against the recorded poses by
   SignCheck (js/gestures/sign-check.js): frames in order at 75 %, or the
   hold-then-move check for motion signs. Passing calls gestureAnswered(true). */
function startSignCamera(q){
  const startBtn=document.getElementById('gq-start-btn');
  const statusEl=document.getElementById('gq-status');
  const progEl=document.getElementById('gq-prog');
  const videoEl=document.getElementById('gq-video');
  startBtn.disabled=true;
  startBtn.textContent='กำลังโหลดกล้อง...';
  const fail=(msg)=>{statusEl.textContent=msg;startBtn.disabled=false;startBtn.textContent='ลองอีกครั้ง';};
  if(typeof GestureDetector==='undefined'||typeof SignCheck==='undefined'||typeof HandFeatures==='undefined'||typeof PoseMatch==='undefined'){
    fail('ไม่สามารถโหลดระบบตรวจจับท่ามือได้ ตรวจสอบการเชื่อมต่ออินเทอร์เน็ต');
    return;
  }
  const quiz=activeQuiz;
  const stillHere=()=>activeQuiz===quiz&&quiz.questions[quiz.idx]===q;
  let resolved=false,checker=null,lastIdx=-1;
  // Face-zone signs (mother, father, know, boy, girl, home): the face model runs next to the hand model and the checker
  // only counts a frame while the hand is at the right place on the face. Nothing is drawn for it.
  // needFace / faceOptional are set once the checker exists (checker.needsFace = a face rule, a pair rule or the generic
  // position-on-the-face check). Signs with the generic check go on WITHOUT it when the face model cannot load.
  let needFace=false,faceOptional=false;
  let face=null,faceSkip=false,faceFailed=false;
  const ZONE_TH={forehead:'หน้าผาก',chin:'คาง',cheek:'แก้ม',cheekHigh:'แก้ม',mouth:'ข้างปาก',lips:'ริมฝีปาก',chest:'หน้าอก'};
  // Called when the face model cannot load / stops: optional signs go on without the face rule, the others must stop.
  const faceUnavailable=()=>{
    if(faceFailed)return;faceFailed=true;
    if(faceOptional){faceSkip=true;return;}
    teardownGesture();
    startBtn.style.display='';
    fail('โหลดระบบตรวจใบหน้าไม่สำเร็จ ตรวจสอบการเชื่อมต่ออินเทอร์เน็ตแล้วลองอีกครั้ง');
  };
  // Steps are counted in PICTURES (q.pic_count, what the learner saw), not in recorded poses: n pictures show
  // "step k of n" and n dots; ONE picture shows no step text at all (just "do the sign, slowly if it fails").
  // Recorded poses T can be more or less than n (e.g. goodbye = 3 poses, 1 picture), so the pose index maps to a
  // picture step with the first pose = step 1 and the last = step n.
  const n=Math.max(1,q.pic_count||1);
  const stepOf=(idx,T)=>T<=1?0:Math.min(n-1,Math.round(idx*(n-1)/(T-1)));   // 0-based picture step
  const drawProgress=(st)=>{
    if(!progEl)return;
    if(st.mode==='motion'||n<2){if(progEl.innerHTML)progEl.innerHTML='';lastIdx=-1;return;}
    const cur=stepOf(st.idx,st.total);
    if(cur===lastIdx)return;
    lastIdx=cur;
    progEl.innerHTML=Array.from({length:n},(_,i)=>`<span class="gq-dot${i<cur?' done':i===cur?' cur':''}"></span>`).join('');
  };
  const SLOW=' — ถ้าตรวจไม่ผ่าน ให้ลองทำช้าลง';
  // in TEST nodes (and the future flashcard game) the learner gets NO hints on how to do the sign: only the
  // pose position "ท่าที่ k จาก n" for a sign with several pictures, plus the plain system states (no hand / no face / loading).
  const noHints=gestureHintsOff();
  const statusText=(st)=>{
    const need=st.need||1;
    if(noHints)return statusTextNoHints(st);
    if(st.seen<need){
      if(need<2)return 'ยกมือให้กล้องมองเห็น';
      return st.seen===1?'ท่านี้ใช้สองมือ — เห็นมือเพียงข้างเดียว ยกอีกข้างให้กล้องเห็นด้วย':'ท่านี้ใช้สองมือ — ยกมือทั้งสองข้างให้กล้องมองเห็น';
    }
    if(st.needFace&&!faceSkip){
      if(!face||face.status==='loading'||face.status==='idle')return 'กำลังโหลดระบบตรวจใบหน้า...';
      if(st.gate&&st.gate.state==='noface')return 'ให้ใบหน้าของคุณอยู่ในกล้อง';
      if(st.gate&&!st.gate.ok&&st.gate.pos)return 'ท่ามือถูกแล้ว — แต่ตำแหน่งมือเทียบกับใบหน้ายังไม่ตรง ขยับมือไปตำแหน่งเดียวกับที่เรียนมา (ให้กล้องเห็นใบหน้าด้วย)';
      if(st.gate&&!st.gate.ok&&st.gate.pair)return 'ท่ามือถูกแล้ว — มือหนึ่งแตะหน้าผาก อีกมือวางที่หน้าอก (ให้กล้องเห็นทั้งหน้าและมือ)';
      if(st.gate&&!st.gate.ok){
        const z=ZONE_TH[st.gate.zone]||'ใบหน้า';
        return st.gate.away?'ท่านี้ยังไม่ต้องแตะ'+z+' — ทำท่าให้ห่างจาก'+z+'ก่อน':'ท่ามือถูกแล้ว — ยกมือไปที่'+z+' ตามที่เรียนมา';
      }
    }
    if(st.mode==='motion'){
      if(st.phase==='move')return n>1?'ทำท่าต่อเนื่องไปจนถึงท่าที่ '+n:'ทำการเคลื่อนไหวต่อช้าๆ';
      if(st.holdPct>0)return 'ค้างท่าเริ่มต้นไว้นิ่งๆ... '+st.holdPct+'%';
      return n>1?'ทำท่าที่ 1 แล้วค้างไว้':'ทำท่าที่เรียนมา แล้วค้างท่าเริ่มต้นไว้';
    }
    if(n<2){
      if(st.total<2)return st.holdPct>0?'ค้างท่าไว้นิ่งๆ...':'ทำท่าที่เรียนมาแล้วค้างไว้นิ่งๆ';
      return 'ทำท่าที่เรียนมาให้กล้องเห็น'+SLOW;                 // several poses behind ONE picture (goodbye): no step text
    }
    const k=stepOf(st.idx,st.total)+1;
    return 'ท่าที่ '+k+' จาก '+n+(st.holdPct>0?' — ค้างไว้นิ่งๆ...':' — ทำท่าที่ '+k+' ตามที่เรียนมา');
  };
  // NO hints at all in test / bonus nodes (and the flashcard game): no step text ("ท่าที่ k จาก n"), no dots, nothing
  // about the shape, the place or the movement. Only what the system needs (show a hand, face in view, loading); the capture bar
  // (#gq-cap, capFromSign) is the indicator: it fills while a pose is held, gold = start pose seen, now move.
  const statusTextNoHints=(st)=>{
    return '';   // no text above the capture bar in test / bonus nodes at all (error messages with a retry button stay)
  };
  const capMemo={};
  const onHands=(res)=>{
    if(resolved||!checker||!stillHere())return;
    const live=[];
    (res.hands||[]).forEach(h=>{if(!h.coasting&&h.keypoints&&h.keypoints.length>=21)live.push(HandFeatures.compute(h.keypoints,h.keypoints3D));});
    let geom;                                           // undefined = no face rule for this sign / model unavailable
    if(needFace&&!faceSkip){
      if(face&&face.status==='error'){faceUnavailable();if(faceFailed&&!faceSkip)return;}   // stopped: keep the error message
      geom=face&&face.status==='running'?face.current():null;
      if(faceSkip)geom=undefined;
    }
    const st=checker.update(performance.now(),live,videoEl.videoWidth||640,videoEl.videoHeight||480,geom);
    if(st.passed){
      resolved=true;
      statusEl.textContent=noHints?'':'ถูกต้อง! กำลังไปข้อต่อไป...';
      if(noHints)capShow('gq-cap',100,'');
      else if(progEl&&st.mode!=='motion'&&n>1)progEl.innerHTML=Array.from({length:n},()=>'<span class="gq-dot done"></span>').join('');
      gestureAnswered(true);
      return;
    }
    if(noHints)capFromSign('gq-cap',st,capMemo);
    else drawProgress(st);
    statusEl.textContent=statusText(st);
  };

  SignCheck.load(SIGN_POSES_URL).then(()=>{
    if(!stillHere())return;
    if(!SignCheck.supports(q.sign))throw new Error('no poses for '+q.sign);
    checker=SignCheck.create(q.sign);
    needFace=!!checker.needsFace&&typeof FaceTracker!=='undefined';
    faceOptional=(typeof FACE_OPTIONAL!=='undefined'&&FACE_OPTIONAL.indexOf(q.sign)>=0)||!!checker.posOn||checker.faceStartOnly;
    const detector=new GestureDetector({
      videoEl,
      canvasEl:document.getElementById('gq-canvas'),
      maxHands:2,
      onHands,
      onError:()=>{},
    });
    quiz.gestureDetector=detector;
    return detector.start().then(()=>{
      if(!stillHere())return;
      startBtn.style.display='none';
      markCameraOk();
      statusEl.textContent=statusText({seen:0,need:checker.need,mode:checker.mode,total:checker.total,idx:0,holdPct:0});
      if(!noHints)drawProgress({mode:checker.mode,total:checker.total,idx:0});
      if(quiz.gestureTimerActive)startGestureTimer();
      if(needFace){                                   // the face model loads in the background; the hand check already runs
        ensureFaceLibs().then(()=>{
          if(!stillHere())return;
          face=new FaceTracker();quiz.faceTracker=face;
          return face.start(videoEl).then(()=>{if(face.status==='error'&&stillHere())faceUnavailable();});
        }).catch(()=>{if(stillHere())faceUnavailable();});
      }
    }).catch(()=>{markCameraBad();fail('เปิดกล้องไม่สำเร็จ กรุณาอนุญาตการใช้กล้อง');});
  }).catch(()=>fail('โหลดข้อมูลท่ามือไม่สำเร็จ ตรวจสอบการเชื่อมต่อแล้วลองอีกครั้ง'));
}

function startGestureTimer(){
  let remaining=GESTURE_TIME_LIMIT_S;
  activeQuiz.gestureTimerStartedAt=Date.now();   // 'fast_hands': pass within 5 s of this
  const timerEl=document.getElementById('gq-timer');
  if(timerEl)timerEl.textContent=remaining+'s';
  activeQuiz.gestureTimerInterval=setInterval(()=>{
    remaining--;
    if(timerEl)timerEl.textContent=Math.max(0,remaining)+'s';
    if(remaining<=0){
      clearInterval(activeQuiz.gestureTimerInterval);
      activeQuiz.gestureTimerInterval=null;
      const statusEl=document.getElementById('gq-status');
      if(statusEl&&!gestureHintsOff())statusEl.textContent='หมดเวลา!';
      gestureAnswered(false);
    }
  },1000);
}

/* Shared bookkeeping for both answer paths (QA + gesture). Keeps
   correctIds/missedMap/xpAwardedIds/activeQuiz.correct consistent no
   matter which path a question came through, and no matter whether
   it's a first attempt or a redo (see requeueMissedOrFinish()). XP is
   only ever paid out once per question_id, even if it's answered
   correctly again on a later redo pass after an earlier wrong attempt
   on a *different* pass — redos only happen for questions that were
   wrong, so by definition XP wasn't paid the first time either. */
function recordQuestionResult(q,correct){
  if(correct){
    if(!activeQuiz.correctIds.has(q.question_id))activeQuiz.correct++;
    activeQuiz.correctIds.add(q.question_id);
    activeQuiz.missedMap.delete(q.question_id);
    if(!activeQuiz.xpAwardedIds.has(q.question_id)){
      activeQuiz.xpAwardedIds.add(q.question_id);
      activeQuiz.earnedXp+=q.xp;
    }
  }else{
    if(activeQuiz.lesson.mode==='test'||activeQuiz.lesson.mode==='normal'){
      activeQuiz.missedMap.set(q.question_id,q);
    }
    activeQuiz.hadWrong=true;
    trackWrongAnswer(activeQuiz.lesson.lesson_id);
  }
}

/* Bookkeeping shared by every wrong answer, any lesson mode included
   (bonus wrong answers count too — a bonus node is still "the same
   node" for 'check_info_nodes', and still disqualifies 'no_hit_gaming'/
   unlocks 'learn_from_mistake' same as any other wrong answer would).
   Persisted (state.milestones.wrongEver, state.wrongCounts) since these
   feed achievements that can only be evaluated by remembering the wrong
   answer happened at all, not by anything re-derivable from
   progress/xp later — see the state var's comment. */
function trackWrongAnswer(lessonId){
  if(!state.milestones)state.milestones={infoNodeOpened:false,wrongEver:false};
  state.milestones.wrongEver=true;
  if(!state.wrongCounts)state.wrongCounts={};
  state.wrongCounts[lessonId]=(state.wrongCounts[lessonId]||0)+1;
  unlockAchievement('learn_from_mistake');
  checkAchievements(); // picks up 'check_info_nodes' the moment a tally crosses its threshold
  if(typeof window.fbSaveState==='function')window.fbSaveState(); // no-op for guests
}

/* Called once a gesture question resolves (match or timeout). Mirrors
   checkAnswer()'s correct/wrong handling for QA questions, but skips
   straight to feedback since there's no "selected option" step. */
function gestureAnswered(correct){
  teardownGesture();
  const{lesson,idx,livesActive}=activeQuiz;
  if(correct&&lesson.mode==='test'&&activeQuiz.gestureTimerStartedAt&&Date.now()-activeQuiz.gestureTimerStartedAt<=5000)unlockAchievement('fast_hands');
  activeQuiz.gestureTimerStartedAt=null;
  const q=activeQuiz.questions[idx];
  activeQuiz.answered=true;
  activeQuiz.selected=correct?q.correct_answer:null;
  recordQuestionResult(q,correct);

  const footer=document.getElementById('lf-footer');
  const fbText=document.getElementById('lf-feedback-text');
  const fbIcon=document.querySelector('#lf-feedback i');
  const btn=document.getElementById('lf-continue-btn');
  btn.style.display='inline-block';

  if(correct){
    footer.className='lf-footer fb-correct';
    fbText.textContent='ถูกต้อง! เก่งมาก';
    fbIcon.className='ti ti-circle-check';
    // overlap:false — reuse the one preloaded/cached element (see pop's
    // same option above) instead of cloneNode()'ing a fresh one every
    // time. A question is only ever answered once before the next one
    // loads, so there's nothing to overlap here, and cloning was the
    // actual source of the audible lag: a clone isn't guaranteed to
    // inherit the cached element's already-decoded/ready state in every
    // browser, so it can end up quietly re-buffering before play()
    // actually produces sound — same failure mode 'pop' used to have
    // before it got this same fix.
    playSfx('correct',{overlap:false});
  }else{
    footer.className='lf-footer fb-wrong';
    fbText.textContent='ไม่ถูกต้อง / หมดเวลา';
    fbIcon.className='ti ti-circle-x';
    playSfx('wrong',{overlap:false});
    if(livesActive){
      activeQuiz.livesLeft=Math.max(0,activeQuiz.livesLeft-1);
      document.getElementById('lf-hearts-count').textContent=activeQuiz.livesLeft;
      if(activeQuiz.livesLeft===1)unlockAchievement('last_chance');
    }
  }

  if(livesActive&&activeQuiz.livesLeft<=0&&!correct){
    btn.textContent='ดูผลลัพธ์';
    btn.className='lf-continue-btn enabled';
    btn.disabled=false;
    btn.onclick=failTest;
    return;
  }

  btn.textContent='ดำเนินการต่อ';
  btn.className='lf-continue-btn enabled';
  btn.disabled=false;
  btn.onclick=nextQ;
}

/* ------------------------------------------------------------
   ANSWER CHECKING (Q&A path)
   ------------------------------------------------------------ */
function checkAnswer(){
  const q=activeQuiz.questions[activeQuiz.idx];
  if(q.question_type==='gesture')return; // gesture questions self-resolve
  if(activeQuiz.selected===null||activeQuiz.answered)return;
  const{selected,livesActive}=activeQuiz;
  activeQuiz.answered=true;
  const opts=document.querySelectorAll('.lf-opt');
  // selectOpt() sets inline style.borderColor/background (blue) on the
  // selected button so it visibly highlights before checking. Inline
  // styles win over any class-based CSS regardless of specificity, so
  // if we only cleared the NON-selected buttons' inline styles here (as
  // this used to), the selected button's blue inline style would still
  // be sitting on top of the red .wrong class below, making a wrong
  // answer look like it was still just "selected" (blue) instead of
  // wrong (red). Clear inline overrides on every option so the
  // .correct/.wrong classes added below are free to actually show.
  opts.forEach(b=>{b.disabled=true;b.style.borderColor='';b.style.background='';});
  const footer=document.getElementById('lf-footer');
  const fbText=document.getElementById('lf-feedback-text');
  const fbIcon=document.querySelector('#lf-feedback i');
  const btn=document.getElementById('lf-continue-btn');
  const correctOpt=document.querySelector(`.lf-opt[data-cid="${q.correct_answer}"]`);
  const selectedOpt=document.querySelector(`.lf-opt[data-cid="${selected}"]`);

  if(selected===q.correct_answer){
    recordQuestionResult(q,true);
    selectedOpt.classList.add('correct');
    footer.className='lf-footer fb-correct';
    fbText.textContent='ถูกต้อง! เก่งมาก';
    fbIcon.className='ti ti-circle-check';
    // overlap:false — see gestureAnswered()'s identical fix above for why.
    playSfx('correct',{overlap:false});
  }else{
    recordQuestionResult(q,false);
    selectedOpt.classList.add('wrong');
    if(correctOpt)correctOpt.classList.add('correct');
    footer.className='lf-footer fb-wrong';
    fbText.textContent='ไม่ถูกต้อง';
    fbIcon.className='ti ti-circle-x';
    playSfx('wrong',{overlap:false});
    if(livesActive){
      activeQuiz.livesLeft=Math.max(0,activeQuiz.livesLeft-1);
      document.getElementById('lf-hearts-count').textContent=activeQuiz.livesLeft;
      if(activeQuiz.livesLeft===1)unlockAchievement('last_chance');
    }
  }

  if(livesActive&&activeQuiz.livesLeft<=0&&selected!==q.correct_answer){
    btn.textContent='ดูผลลัพธ์';
    btn.className='lf-continue-btn enabled';
    btn.disabled=false;
    btn.onclick=failTest;
    return;
  }

  btn.textContent='ดำเนินการต่อ';
  btn.className='lf-continue-btn enabled';
  btn.disabled=false;
  btn.onclick=nextQ;
}

/* ------------------------------------------------------------
   WRONG-ANSWER REDO (test AND normal mode — not bonus)
   ------------------------------------------------------------
   Reached whenever the question queue runs out. If some questions
   are still outstanding in missedMap (answered wrong and not yet
   redone correctly), append them to the end of the queue and keep
   going — this naturally keeps looping "redo the wrong ones" until
   every question has been answered correctly at least once
   (missedMap empties out).
   For test-mode lessons, hearts/lives are NOT reset, so a redo pass
   can still run out of hearts mid-pass (short-circuits straight to
   failTest() from checkAnswer()/gestureAnswered() before ever
   reaching here). Normal-mode lessons never have hearts
   (livesActive is only ever true for mode:'test' — see startQuiz()),
   so their redo loop just keeps going question-by-question with no
   fail condition until everything's been answered correctly once.
   Bonus lessons never populate missedMap (see recordQuestionResult()),
   so they always finish immediately — no redo, same as before. */
function requeueMissedOrFinish(){
  const{lesson,missedMap}=activeQuiz;
  if((lesson.mode==='test'||lesson.mode==='normal')&&missedMap.size>0){
    const requeued=Array.from(missedMap.values());
    requeued.forEach(q=>activeQuiz.redoIds.add(q.question_id));
    activeQuiz.questions=activeQuiz.questions.concat(requeued);
    missedMap.clear();
    renderQ();
    return;
  }
  finishLesson();
}

function finishLesson(){
  const{lesson}=activeQuiz;
  // Uses origTotal (question count before any wrong-answer redos were
  // appended) and correctIds (unique questions answered correctly at
  // least once) so a redo pass never inflates/deflates the score —
  // it's always "how many of the original questions did you get right".
  const score=Math.round(activeQuiz.correctIds.size/activeQuiz.origTotal*100);
  // flawless: true only if NOTHING in this attempt was ever answered
  // wrong (activeQuiz.hadWrong, set by recordQuestionResult()) — backs
  // the 'flawless_lessons' achievement kind. Overwritten fresh on every
  // completion, so a later flawless redo of a previously-messy lesson
  // still counts, and vice versa.
  state.progress[lesson.lesson_id]={completed:true,score,flawless:!activeQuiz.hadWrong};
  // Bonus lessons always land here (never in failTest() — no hearts,
  // see requeueMissedOrFinish()'s comment) even when every single
  // question was answered wrong, so "lose.mp3" needs its own check
  // here rather than only living in failTest(). Test/normal lessons
  // that make it this far always have at least one correct answer per
  // question (the redo loop guarantees it — see
  // requeueMissedOrFinish()), so this condition can only ever be true
  // for a bonus run.
  const isBonusAllWrong=lesson.mode==='bonus'&&activeQuiz.correctIds.size===0;
  playSfx(isBonusAllWrong?'lose':'completed');
  // Guests can still try lessons and unlock the next one (progress
  // above is tracked either way, so the lesson path keeps working as
  // a free preview) but don't accumulate XP — XP is what the
  // leaderboard ranks, and a guest has no account for that number to
  // persist on anyway once the tab closes.
  const earnedThisRun=state.isGuest?0:activeQuiz.earnedXp;
  state.xp+=earnedThisRun;
  checkAchievements(); // xp/progress just changed — see if any threshold was just crossed
  if(typeof window.fbSaveState==='function')window.fbSaveState(); // no-op for guests
  // Was just a p-xp text update — now also refreshes p-level/tier and
  // the XP-to-next-level bar, since finishing a lesson can push someone
  // across a level threshold.
  renderLevelStats();
  document.getElementById('lf-progress-fill').style.width='100%';
  document.getElementById('lf-footer').style.display='none';
  document.getElementById('lf-body-inner').innerHTML='';
  // 'normal'/'test' modes redo wrong answers until every question has
  // been answered correctly at least once, so `score` here is
  // essentially ALWAYS 100 for them — showing "100%" back at the
  // person read as a strange, unearned-looking stat rather than a
  // real score, hence "สำเร็จ" instead. Bonus lessons (no redo) always
  // show the real percentage instead — even a bonus 100% shows "100%"
  // rather than "สำเร็จ", since a star rating is shown right alongside
  // it (see bonusStarCount()) and having one of the two say "สำเร็จ"
  // while the other still counts stars read as inconsistent.
  const isBonus=lesson.mode==='bonus';
  const resultLabel=(!isBonus&&score>=100)?'สำเร็จ':`${score}%`;
  const starsHtml=isBonus?`<div class="lf-result-stars">${[1,2,3].map(n=>
    `<i class="ti ti-star${n<=bonusStarCount(score)?'-filled':''}${n<=bonusStarCount(score)?' filled':''}"></i>`
  ).join('')}</div>`:'';
  document.getElementById('lf-body').innerHTML=`
    <div class="lf-result-wrap">
      <div class="lf-result-emoji" style="color:var(--green);"><i class="ti ti-confetti"></i></div>
      <div class="lf-result-num">${resultLabel}</div>
      ${starsHtml}
      <p>ทำได้ยอดเยี่ยม! บทเรียน "${lessonDisplayName(lesson)}" เสร็จแล้ว</p>
      ${state.isGuest
        ?`<div class="lf-guest-note">สมัครสมาชิกเพื่อเก็บ XP (+${activeQuiz.earnedXp} XP รอคุณอยู่)</div>`
        :`<div class="lf-xp-badge"><i class="ti ti-bolt"></i> +${activeQuiz.earnedXp} XP</div>`}
      <button class="btn-main" style="width:auto;padding:13px 32px;margin-top:24px;" onclick="exitLesson();refreshLessonStates();">เสร็จสิ้น</button>
    </div>`;
}


function failTest(){
  teardownGesture();
  const{lesson}=activeQuiz;
  playSfx('lose');
  document.getElementById('lf-progress-fill').style.width='100%';
  document.getElementById('lf-footer').style.display='none';
  document.getElementById('lf-body-inner').innerHTML='';
  document.getElementById('lf-body').innerHTML=`
    <div class="lf-result-wrap">
      <div class="lf-result-emoji" style="color:var(--red);"><i class="ti ti-heart-broken"></i></div>
      <div class="lf-result-num" style="color:var(--red);">หมดหัวใจ</div>
      <p>ไม่ผ่านแบบทดสอบ "${lessonDisplayName(lesson)}" ลองใหม่อีกครั้งนะ</p>
      <button class="btn-main" style="width:auto;padding:13px 32px;margin-top:24px;" onclick="exitLesson();refreshLessonStates();">ลองอีกครั้ง</button>
    </div>`;
}
function nextQ(){
  activeQuiz.idx++;
  renderQ();
}

/* PROFILE EDIT */
function openEditProfile(){
  document.getElementById('profile-view').style.display='none';
  document.getElementById('profile-edit').style.display='block';
  document.getElementById('edit-name').value=state.name;
  editSelectedPic=state.profilePic||PROFILE_PICS[0];
  document.getElementById('edit-avatar-preview').src=PROFILE_PIC_DIR+editSelectedPic;
  // Picture thumbnails from lessons.js's PROFILE_PICS (filenames), not the
  // old AVATARS emoji list — this screen is unreachable for guests
  // (handleProfileNav() sends them to the auth page instead), so only
  // signed-in users ever pick a non-default picture here.
  const picker=document.getElementById('avatar-picker');picker.innerHTML='';
  PROFILE_PICS.forEach(pic=>{
    const btn=document.createElement('button');
    btn.className='av-opt'+(pic===editSelectedPic?' sel':'');
    btn.innerHTML='<img src="'+PROFILE_PIC_DIR+pic+'" alt="">';
    btn.onclick=()=>{
      editSelectedPic=pic;
      document.getElementById('edit-avatar-preview').src=PROFILE_PIC_DIR+pic;
      picker.querySelectorAll('.av-opt').forEach(b=>b.classList.remove('sel'));
      btn.classList.add('sel');
    };
    picker.appendChild(btn);
  });
}
function closeEditProfile(){
  document.getElementById('profile-view').style.display='block';
  document.getElementById('profile-edit').style.display='none';
}
function saveProfile(){
  const name=document.getElementById('edit-name').value.trim();
  if(!name){showToast('กรุณาใส่ชื่อก่อนบันทึก');return;}
  const picChanged=editSelectedPic!==state.profilePic;
  state.name=name;state.profilePic=editSelectedPic;
  if(typeof window.fbSaveState==='function')window.fbSaveState(); // no-op for guests
  // Checked BEFORE re-render below so the popup can layer over the
  // freshly-closed edit screen instead of the (about to be replaced)
  // old one. unlockAchievement() itself no-ops harmlessly if this
  // isn't actually the first time the pic's ever been changed.
  if(picChanged)unlockAchievement('new_look');
  closeEditProfile();renderAll();
  showToast('บันทึกโปรไฟล์เรียบร้อยแล้ว');
}

/* LOGOUT */
function openConfirmLogout(){document.getElementById('confirm-modal').style.display='flex';}
function closeConfirmLogout(){document.getElementById('confirm-modal').style.display='none';}
/* Shared by doLogout() and doDeleteAccount() — both end up putting the
   person back on the guest auth screen with a blank `state`, they just
   get there via a different Firebase call (signOut vs delete) and a
   different toast message. Pulled out so the two didn't drift apart. */
function resetToGuestAndShowAuth(toastMsg){
  state={name:'ผู้ใช้งาน',profilePic:'default.png',xp:0,score:0,scoreLetters:0,scoreSigns:0,progress:{},bonusNodes:{},achievements:{},milestones:{infoNodeOpened:false,wrongEver:false},wrongCounts:{},isGuest:true};
  // Reassigning `state` above only updates the in-memory object — it
  // doesn't touch anything already painted on screen (name/xp/level,
  // avatar, the lesson path's unlocked/completed nodes, both
  // leaderboards' "me" row, etc). Without re-rendering here, all of
  // that kept showing the just-logged-out user's data until something
  // else happened to call renderAll() — in practice, only a manual
  // page refresh (which reruns the initial renderAll() at the bottom
  // of this file) actually cleared it. renderAll() also resets
  // lesson-path scroll-perspective via its renderLessons() call, so
  // the fresh (all-locked-except-first) guest path renders correctly
  // even if 'learn' was already the active screen going into logout.
  renderAll();
  showScreen('learn');
  document.getElementById('page-main').classList.remove('active');
  document.getElementById('page-auth').classList.add('active');
  document.getElementById('reg-name').value='';
  document.getElementById('reg-name').classList.remove('invalid');
  document.getElementById('reg-email').value='';
  document.getElementById('reg-pass').value='';
  showToast(toastMsg);
}
function doLogout(){
  closeConfirmLogout();
  if(typeof window.fbLogout==='function')window.fbLogout(); // fire-and-forget — UI reset happens below regardless
  resetToGuestAndShowAuth('ออกจากระบบสำเร็จแล้ว');
}

/* PROFILE SETTINGS DROPDOWN — houses reset-progress/delete-account so
   they're not full-width buttons on the profile screen (see
   .profile-settings-wrap/.profile-settings-menu in style.css).
   Click-only (works the same on touch and pointer devices).
   toggleProfileSettings is wired to the settings button's onclick;
   the document-level listener closes it on any click outside the
   menu, and stopPropagation on the button click keeps that same
   listener from immediately closing what it just opened. */
function toggleProfileSettings(e){
  e.stopPropagation();
  document.getElementById('profile-settings-menu').classList.toggle('open');
}
function closeProfileSettings(){
  document.getElementById('profile-settings-menu').classList.remove('open');
}
document.addEventListener('click',(e)=>{
  const menu=document.getElementById('profile-settings-menu');
  if(menu&&menu.classList.contains('open')&&!menu.contains(e.target)){
    closeProfileSettings();
  }
});

/* RESET PROGRESS — clears XP/level/lesson completion/bonus-node picks
   but keeps the account itself (name, profilePic, login) untouched.
   Available to guests too (harmless no-op-ish for them since there's
   nothing server-side to wipe), but in practice the profile screen is
   only ever reachable by signed-in users — see handleProfileNav(). */
function openConfirmReset(){document.getElementById('confirm-reset-modal').style.display='flex';}
function closeConfirmReset(){document.getElementById('confirm-reset-modal').style.display='none';}
function doResetProgress(){
  closeConfirmReset();
  state.xp=0;
  state.score=0;state.scoreLetters=0;state.scoreSigns=0;
  state.progress={};
  state.bonusNodes={};
  state.achievements={}; // these were unlocked FROM the xp/progress above — clear them together so nothing's left in a state that could never be earned fresh
  state.milestones={infoNodeOpened:false,wrongEver:false}; // same reasoning — these back some of the achievements just cleared above
  state.wrongCounts={};
  // Unlocked AFTER the state.achievements={} wipe above (not before —
  // it'd just be cleared again), so this is deliberately the one
  // achievement that survives every reset: doing the reset IS what
  // earns it.
  unlockAchievement('reset_again');
  // NOTE: unlockAchievement() above already calls window.fbSaveState()
  // internally (the normal debounced merge-write) — that call is
  // harmless but insufficient here (see fbSaveStateReset()'s comment
  // in firebase-init.js for why merge:true can't actually clear
  // achievements/progress server-side). fbSaveStateReset() below is
  // the one that actually makes the reset stick in Firestore; it also
  // clears the pending debounced write from that fbSaveState() call so
  // it can't fire afterward with stale pre-reset data.
  if(typeof window.fbSaveStateReset==='function')window.fbSaveStateReset(); // no-op for guests
  renderAll();
  showToast('รีเซ็ตความคืบหน้าเรียบร้อยแล้ว');
}

/* DELETE ACCOUNT — permanently removes the Firestore profile doc AND
   the Firebase Auth account itself (irreversible), then drops the
   person back to the guest auth screen exactly like a logout would.
   fbDeleteAccount() can THROW (most commonly auth/requires-recent-login
   — Firebase requires a fresh sign-in before allowing account deletion
   as a safety measure), so unlike doLogout() this path is async and
   has to handle that failure without touching `state`/the screen. */
function openConfirmDeleteAccount(){
  document.getElementById('confirm-delete-modal').style.display='flex';
  // Fires on just OPENING the confirm dialog (the "try to remove
  // account" moment), not on doDeleteAccount() actually succeeding —
  // if the account really gets deleted, state/Firestore are wiped
  // (see doDeleteAccount()) so there'd be nothing left to have
  // unlocked it. Also means someone who backs out of the confirm
  // modal still gets it, which matches the "rage quit?" joke better
  // than requiring them to follow through.
  unlockAchievement('rage_quit');
}
function closeConfirmDeleteAccount(){document.getElementById('confirm-delete-modal').style.display='none';}
async function doDeleteAccount(){
  closeConfirmDeleteAccount();
  if(typeof window.fbDeleteAccount==='function'){
    try{
      await window.fbDeleteAccount();
    }catch(err){
      if(err&&err.code==='auth/requires-recent-login'){
        showToast('กรุณาออกจากระบบแล้วเข้าสู่ระบบใหม่ ก่อนลบบัญชี');
      }else{
        showToast('ลบบัญชีไม่สำเร็จ ลองใหม่อีกครั้ง');
      }
      return; // bail out — account (and current session) still intact
    }
  }
  resetToGuestAndShowAuth('ลบบัญชีเรียบร้อยแล้ว');
}

/* TOAST */
// `icon`, if given, is a tabler-icons name (without the "ti-" prefix)
// shown before the message — replaces what used to be an emoji
// stuffed into the message string itself. Switched from textContent to
// innerHTML to allow that icon markup; safe here since every call site
// passes a fixed string authored in this file, never user input.
function showToast(msg,icon){
  const t=document.getElementById('toast');
  t.innerHTML=icon?'<i class="ti ti-'+icon+'"></i> '+msg:msg;
  t.classList.add('show');
  clearTimeout(t._t);t._t=setTimeout(()=>t.classList.remove('show'),2500);
}

// 1-hour-in-one-sitting achievement: armed fresh on every page
// load/reload (no persisted start time), so it's genuinely "stayed
// this long without closing/reloading the tab", not cumulative time
// across visits. unlockAchievement() no-ops harmlessly if it's
// already unlocked or the tab gets closed before this ever fires.
setTimeout(()=>{if(typeof unlockAchievement==='function')unlockAchievement('drink_water');},DRINK_WATER_MS);

preloadSfx();
renderAll();
