/* ============================================================
   FIREBASE — init, auth actions, Firestore profile sync
   ============================================================
   Loaded as a <script type="module"> AFTER js/app/app.js (see
   html/index.html). Because module scripts are deferred, this file
   always runs after app.js has finished its initial synchronous
   pass (which defines `state`, `enterApp()`, etc. as globals and
   calls the very first renderAll()). That's why this file is free
   to reach into `window.state` / `window.enterApp` directly instead
   of importing anything from app.js — app.js was never converted to
   a module, so plain globals are the bridge in both directions:
   this file writes window.fbRegister/fbLogin/... for app.js to call,
   and reads window.state/window.enterApp to drive the UI.

   FIRESTORE SCHEMA
   ------------------------------------------------------------
   users/{uid}: {
     name, profilePic, xp, score,
     progress:    { [lesson_id]: {completed, score} },
     bonusNodes:  { [sectionId]: [...] },
     achievements:{ [achievement_id]: {unlockedAt} },
     createdAt, updatedAt
   }
   (`achievements` is new: which ACHIEVEMENTS entries (see app.js) a
   user has unlocked, written once each and never removed/recomputed
   from here on — see app.js's checkAchievements() for why unlocked
   status is stored instead of re-derived from xp/progress on every
   render. Existing accounts from before this field existed just load
   with achievements:{} — the very next thing that changes their
   xp/progress (or the login-time backfill call below) fills in
   anything they'd already earned.)
   (the old `avatar` field — an emoji character — has been removed
   entirely and replaced with `profilePic`, a filename from data.js's
   PROFILE_PICS array; see app.js's state comment for why. Existing
   Firestore docs from before this change may still have a leftover
   `avatar` field sitting on them; that's harmless dead data and safe
   to ignore, or delete manually in the Firebase console. Nothing
   reads or writes it anymore as of this change.
   `score` is a new field, separate from `xp`, added as plumbing for a
   future feature — nothing writes a nonzero value to it yet, it's
   just saved/loaded/defaulted to 0 alongside everything else below.)
   (streak was dropped from this schema — see app.js's comment next to
   the `state` definition for why. Existing Firestore docs from before
   this change may still have a leftover `streak` field sitting on
   them; that's harmless dead data and safe to ignore, or delete
   manually in the Firebase console if you want the docs to match the
   schema exactly. Nothing reads or writes it anymore as of this
   change.)
   One doc per signed-in user. Doubles as the source for both the
   XP "all-time" leaderboard tab (fbLoadLeaderboard) and the new score
   leaderboard tab (fbLoadScoreLeaderboard) — every user doc is
   readable so names/profilePics/xp/score can be listed, but a doc can
   only be WRITTEN by its own uid (set in the Firebase console).

   KNOWN LIMITATION — weekly leaderboard
   ------------------------------------------------------------
   There's no server-side weekly reset (that needs a scheduled Cloud
   Function, which needs the Blaze billing plan). So only the
   "all-time" tab is wired to Firestore for now; the "week" tab still
   shows data.js's local sample data. Flagged again in app.js at the
   renderLB() call site.
   ============================================================ */
import { initializeApp } from "https://www.gstatic.com/firebasejs/12.15.0/firebase-app.js";
import {
  getAuth, createUserWithEmailAndPassword, signInWithEmailAndPassword,
  GoogleAuthProvider, signInWithPopup, signOut, onAuthStateChanged,
  updateProfile, deleteUser
} from "https://www.gstatic.com/firebasejs/12.15.0/firebase-auth.js";
import {
  getFirestore, doc, setDoc, getDoc, deleteDoc, serverTimestamp,
  collection, query, orderBy, limit, getDocs
} from "https://www.gstatic.com/firebasejs/12.15.0/firebase-firestore.js";

const firebaseConfig = {
  apiKey: "AIzaSyAckvbYK36q9x5BkLte5kJhUyoCUFA2G7I",
  authDomain: "gestures4you.firebaseapp.com",
  projectId: "gestures4you",
  storageBucket: "gestures4you.firebasestorage.app",
  messagingSenderId: "293495828870",
  appId: "1:293495828870:web:cf075ad8af2d919b253c07"
};

const fbApp = initializeApp(firebaseConfig);
const auth = getAuth(fbApp);
const db = getFirestore(fbApp);

function userDocRef(uid){ return doc(db,'users',uid); }

/* Seeds a brand-new user doc from whatever the guest had already
   earned THIS session (state.xp/progress/bonusNodes) so in-progress
   guest work isn't thrown away just because they registered partway
   through a lesson path. */
async function createUserDoc(uid,name,profilePic){
  await setDoc(userDocRef(uid),{
    name, profilePic,
    xp: window.state.xp||0,
    score: window.state.score||0,
    scoreLetters: window.state.scoreLetters||0,
    scoreSigns: window.state.scoreSigns||0,
    progress: window.state.progress||{},
    bonusNodes: window.state.bonusNodes||{},
    achievements: window.state.achievements||{},
    milestones: window.state.milestones||{infoNodeOpened:false,wrongEver:false},
    wrongCounts: window.state.wrongCounts||{},
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp()
  });
}

async function loadUserDoc(uid){
  const snap = await getDoc(userDocRef(uid));
  return snap.exists() ? snap.data() : null;
}

/* Debounced write-back — called from app.js after anything that
   changes state (finishLesson's xp/progress bump, saveProfile's
   name/avatar edit). Debounced so rapid-fire changes (e.g. a redo
   pass finishing several questions in a row) don't fire one Firestore
   write per tick. No-ops for guests (nothing to save to). */
let _saveTimer=null;

/* Failure handling (replaces the old silent `.catch(()=>{})`, so a save that
   never reached the server no longer looks successful):
   - the write is retried up to 3 times (2 s, then 4 s apart); every retry
     re-reads window.state, so it always sends the latest progress, and it
     stops if the person logged out or switched account in the meantime
   - every failed attempt is console.warn'ed with the Firestore error code
   - if all attempts fail, ONE Thai toast tells the person (at most once per
     minute, so a long outage doesn't spam) and _saveFailed stays true
   - while _saveFailed is true, the browser coming back online, or any later
     successful write, clears/retries it: the next fbSaveState() catches up
     because every write sends the whole profile */
let _saveFailed=false;
const _lastSaveToast={}; // per message, so a reset failure is never hidden by an earlier save-failure toast
function _profileData(){
  return {
    name: window.state.name,
    profilePic: window.state.profilePic,
    xp: window.state.xp,
    score: window.state.score,
    scoreLetters: window.state.scoreLetters||0,
    scoreSigns: window.state.scoreSigns||0,
    progress: window.state.progress,
    bonusNodes: window.state.bonusNodes,
    achievements: window.state.achievements,
    milestones: window.state.milestones,
    wrongCounts: window.state.wrongCounts,
    updatedAt: serverTimestamp()
  };
}
function _reportSaveFailure(msg){
  _saveFailed=true;
  const now=Date.now();
  if(now-(_lastSaveToast[msg]||0)<60000) return;
  _lastSaveToast[msg]=now;
  if(typeof window.showToast==='function') window.showToast(msg,'cloud-off');
}
// merge=true  -> normal progress save; merge=false -> full overwrite used by reset
function _writeProfile(uid,merge,failMsg,attempt){
  if(!auth.currentUser||auth.currentUser.uid!==uid) return Promise.resolve(false); // logged out / switched account: drop it
  // dev mode changes progress only temporarily (app.js devModeSnapshot / devModeRestore): never save it. The restore saves again.
  if(merge && document.body.classList.contains('devmode-on')) return Promise.resolve(false);
  const ref=userDocRef(uid), data=_profileData();
  return (merge?setDoc(ref,data,{merge:true}):setDoc(ref,data)).then(()=>{
    _saveFailed=false; return true;
  }).catch(err=>{
    console.warn('[save] Firestore write failed (attempt '+attempt+'/3):',(err&&err.code)||err);
    if(attempt<3){
      return new Promise(res=>setTimeout(res,2000*attempt)).then(()=>_writeProfile(uid,merge,failMsg,attempt+1));
    }
    _reportSaveFailure(failMsg);
    return false;
  });
}
window.addEventListener('online',()=>{ if(_saveFailed) fbSaveState(); });

function fbSaveState(){
  if(!auth.currentUser) return;
  clearTimeout(_saveTimer);
  const uid=auth.currentUser.uid;
  _saveTimer=setTimeout(()=>{
    _writeProfile(uid,true,'บันทึกความคืบหน้าไม่สำเร็จ จะลองใหม่อีกครั้ง',1);
  },800);
}
window.fbSaveState = fbSaveState;

/* Immediate, NON-merged overwrite — used only by app.js's
   doResetProgress(). This is the fix for reset-progress not actually
   clearing achievements (and, latently, progress/bonusNodes/
   wrongCounts too): fbSaveState() above writes with {merge:true}, and
   Firestore's merge is recursive on nested map fields — when you pass
   a new `achievements` map under merge:true, Firestore merges its
   keys INTO whatever's already stored server-side rather than
   replacing the field outright. So clearing state.achievements to {}
   locally and calling fbSaveState() would send an empty map, Firestore
   would merge "nothing new" into the existing stored map, and every
   previously-unlocked achievement would silently survive server-side
   — then reappear on the very next login/reload via loadUserDoc().
   Plain setDoc() (no merge option = full-document overwrite) sidesteps
   that entirely: since doResetProgress() already holds the complete,
   correct post-reset state locally, writing the whole doc fresh is
   exactly what "reset" should mean. (createdAt is intentionally not
   re-sent here and is dropped from the doc as a result — it isn't
   read anywhere else in the app, so this has no functional effect.)
   Also clears any pending debounced fbSaveState() timer first — if an
   old merge-write from just before the reset were still pending, it
   could fire seconds later with pre-reset data and undo this. */
function fbSaveStateReset(){
  if(!auth.currentUser) return Promise.resolve();
  clearTimeout(_saveTimer);
  // Same retry/warn/toast policy as fbSaveState(), but a full overwrite. The
  // toast matters more here: if this fails, the old progress comes back from
  // the server at the next login even though the screen shows it reset.
  return _writeProfile(auth.currentUser.uid,false,'รีเซ็ตบนเซิร์ฟเวอร์ไม่สำเร็จ ความคืบหน้าเก่าอาจกลับมาตอนเข้าสู่ระบบครั้งหน้า',1);
}
window.fbSaveStateReset = fbSaveStateReset;

/* ---- Auth actions (called from app.js's doRegister/doLogin/etc) ----
   These only THROW on failure — app.js is responsible for catching
   and showing a Thai toast via authErrorMessage(). On success,
   onAuthStateChanged below does the rest (loads the profile, flips
   state.isGuest, calls enterApp()) so callers don't need to. */
window.fbRegister = async function(name,email,pass){
  const cred = await createUserWithEmailAndPassword(auth,email,pass);
  await updateProfile(cred.user,{displayName:name});
  try{
    await createUserDoc(cred.user.uid,name,window.state.profilePic||window.PROFILE_PICS[0]);
  }catch(err){
    // The Auth account already exists at this point — a Firestore
    // write failure here (rules not published yet, database not
    // created yet, etc) shouldn't surface as "registration failed"
    // when it actually succeeded. Swallowed intentionally; the doc
    // gets created lazily by fbSaveState()'s later merge writes
    // (finishLesson/saveProfile) instead.
  }
};

window.fbLogin = async function(email,pass){
  await signInWithEmailAndPassword(auth,email,pass);
};

window.fbGoogleSignIn = async function(){
  const provider = new GoogleAuthProvider();
  // Split into two stages on purpose, logged separately:
  //   1. The actual sign-in (signInWithPopup). If THIS throws, it's a
  //      real auth failure (popup blocked/closed, unauthorized-domain,
  //      operation-not-allowed for Google in the Firebase console,
  //      etc) — the "something went wrong" toast is correct here, and
  //      the console log below will show exactly which error code.
  //   2. Firestore bookkeeping (existing-doc check + create). This is
  //      NOT the sign-in itself — signInWithPopup having already
  //      resolved means the user IS signed in and onAuthStateChanged
  //      below is already driving them into the app. A failure here
  //      must never surface as an error toast (that was the bug: it
  //      used to look like login failed even though it hadn't). Still
  //      logged, but as a warning, and still swallowed.
  let cred;
  try{
    cred = await signInWithPopup(auth,provider);
  }catch(err){
    console.error('[fbGoogleSignIn] signInWithPopup FAILED — code:',err&&err.code,'message:',err&&err.message,err);
    throw err; // real failure — let signInWithGoogle()'s catch show the toast
  }
  try{
    const existing = await loadUserDoc(cred.user.uid);
    if(!existing){
      // First time this Google account has signed in — create their doc.
      await createUserDoc(cred.user.uid,cred.user.displayName||'ผู้ใช้ใหม่',window.state.profilePic||window.PROFILE_PICS[0]);
    }
  }catch(err){
    // Swallowed intentionally — see comment above. The doc gets
    // created/caught-up lazily by fbSaveState()'s later merge writes.
    console.warn('[fbGoogleSignIn] Firestore bookkeeping failed (non-fatal, sign-in already succeeded) — code:',err&&err.code,'message:',err&&err.message,err);
  }
};

window.fbLogout = function(){
  return signOut(auth);
};

/* ---- Delete account (called from app.js's doDeleteAccount) ----
   Deletes the Firestore profile doc first, then the Auth account
   itself. Order matters: once deleteUser() succeeds, auth.currentUser
   is gone, so a Firestore doc delete after that would have no uid to
   target. The doc delete is best-effort (swallowed) — an orphaned
   Firestore doc with no matching Auth account is harmless dead data
   (same spirit as the leftover `avatar`/`streak` fields noted above),
   whereas failing the whole operation over it would leave the person
   stuck with an account they were trying to delete.
   THROWS on the deleteUser() call itself — most commonly
   'auth/requires-recent-login', which Firebase enforces so a
   long-since-opened tab can't be used to delete an account without
   the person re-proving who they are. app.js's doDeleteAccount() is
   responsible for catching that and showing a Thai toast; this
   function intentionally does not swallow it. */
window.fbDeleteAccount = async function(){
  const user = auth.currentUser;
  if(!user) return;
  try{
    await deleteDoc(userDocRef(user.uid));
  }catch(err){
    console.warn('[fbDeleteAccount] Firestore doc delete failed (non-fatal, continuing to delete the Auth account) — code:',err&&err.code,'message:',err&&err.message,err);
  }
  await deleteUser(user); // real failure — let doDeleteAccount()'s catch show the toast
};

/* ---- Leaderboard (all-time tab only — see KNOWN LIMITATION above) ---- */
window.fbLoadLeaderboard = async function(){
  const q = query(collection(db,'users'),orderBy('xp','desc'),limit(20));
  const snap = await getDocs(q);
  return snap.docs.map(d=>({uid:d.id,name:d.data().name,profilePic:d.data().profilePic,xp:d.data().xp||0}));
};

/* ---- Score leaderboard — same shape as the XP one above, ranked by
   the new `score` field instead. See app.js's renderScoreLB(). */
window.fbLoadScoreLeaderboard = async function(field){
  field = (field==='scoreLetters'||field==='scoreSigns') ? field : 'score';
  const q = query(collection(db,'users'),orderBy(field,'desc'),limit(20));
  const snap = await getDocs(q);
  return snap.docs.map(d=>({uid:d.id,name:d.data().name,profilePic:d.data().profilePic,score:d.data()[field]||0}));
};

window.fbCurrentUid = function(){
  return auth.currentUser ? auth.currentUser.uid : null;
};

/* ---- Drives the UI on login/logout/page-refresh-with-existing-session ----
   Firebase Auth persists the session in the browser by default, so this
   also fires on a normal page reload if the person was already logged
   in — that's what makes "stay logged in" work with no extra code.
   */
onAuthStateChanged(auth, async (user) => {
  if(user){
    let data=null;
    try{
      data = await loadUserDoc(user.uid);
    }catch(err){
      // Read failed (rules not published yet, database not created
      // yet, offline, etc) — swallowed intentionally so it doesn't
      // block login. The user still gets into the app with whatever
      // `state` currently holds; their real profile will just be
      // missing until this resolves.
      console.warn('[onAuthStateChanged] loadUserDoc FAILED (non-fatal) — code:',err&&err.code,'message:',err&&err.message,err);
    }
    // 'mystery_person' is earned as a guest; keep it when the guest then logs in / registers
    const guestMystery = window.state.isGuest && window.state.achievements && window.state.achievements.mystery_person;
    if(data){
      window.state.name = data.name || user.displayName || 'ผู้ใช้งาน';
      window.state.profilePic = data.profilePic || window.PROFILE_PICS[0];
      window.state.xp = data.xp || 0;
      window.state.score = data.score || 0;
      // best-score categories: undefined (not 0) when the doc has no such field, so app.js can backfill once
      window.state.scoreLetters = data.scoreLetters;
      window.state.scoreSigns = data.scoreSigns;
      window.state.progress = data.progress || {};
      window.state.bonusNodes = data.bonusNodes || {};
      window.state.achievements = data.achievements || {};
      window.state.milestones = data.milestones || {infoNodeOpened:false,wrongEver:false};
      window.state.wrongCounts = data.wrongCounts || {};
    }else{
      // No Firestore doc yet — brand-new account whose doc hasn't been
      // written (or lazily failed to write, e.g. rules not published),
      // OR the read itself failed above. Previously `state.name` was
      // left untouched in this branch, so it kept showing the guest
      // default ('ผู้ใช้งาน') instead of the real name — most visibly
      // for Google sign-in, where the display name IS already known
      // from `user` and shouldn't need Firestore at all to show up.
      // Everything else (xp/score/progress/etc) is left as-is on
      // purpose: this session's in-progress guest values (if any)
      // shouldn't be wiped out just because the profile doc hasn't
      // synced yet.
      window.state.name = user.displayName || window.state.name || 'ผู้ใช้งาน';
    }
    window.state.isGuest = false;
    if(guestMystery){
      if(!window.state.achievements)window.state.achievements = {};
      if(!window.state.achievements.mystery_person)window.state.achievements.mystery_person = guestMystery;
    }
    // old accounts get their letters / signs split once (also saves, so they appear on the category boards)
    if(typeof window.ensureSplitFields === 'function')window.ensureSplitFields();
    // One-time backfill: covers accounts whose xp/progress already
    // clears an achievement threshold from before achievements were
    // stored at all (or from the `else` branch above, whose xp/progress
    // could already satisfy something even with no doc yet). Cheap —
    // same ACHIEVEMENTS-length loop as any other check — and a no-op
    // if everything already earned is already in `data.achievements`.
    if(typeof window.checkAchievements === 'function')window.checkAchievements();
    // 'First Hand' (successfully register/login) fires here rather than
    // right after fbRegister()/fbLogin()/fbGoogleSignIn() resolve in
    // app.js — by this point window.state.achievements has already been
    // set to whatever this account actually has (the branch above, or
    // {} for a genuinely brand-new one), so unlockAchievement()'s
    // eventual fbSaveState() write can't clobber an existing account's
    // real achievement list with an incomplete in-memory one from
    // mid-sign-in. Also fires on a plain page-reload-with-existing-
    // session (onAuthStateChanged fires then too) — harmless, since
    // unlockAchievement() is a no-op once already unlocked.
    if(typeof window.unlockAchievement === 'function')window.unlockAchievement('first_hand');
    if(typeof window.enterApp === 'function'){
      window.enterApp();
    }else{
      console.error('[onAuthStateChanged] window.enterApp is not a function! app.js may not have loaded correctly.');
    }
  }
  // user === null: doLogout() in app.js already resets `state` itself
  // BEFORE calling fbLogout(), so there's nothing left to clean up here.
});
