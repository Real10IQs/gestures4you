/* ============================================================
   STATIC DATA
   ============================================================
   (Formerly a separate data.js — merged into this file so all the
   non-Firebase, non-UI static content lives in one place. Nothing
   below this block needs to change its own references to
   PROFILE_PIC_DIR/PROFILE_PICS/GESTURE_IMG_DIR now that they're
   local to this same file instead of imported implicitly via
   classic-script global scope — that sharing worked before the
   merge and still works the same way now.)

   Profile picture choices shown in the profile editor ("เลือกรูป
   โปรไฟล์"). Each entry is just a filename — app.js builds the full
   path as `assets/profiles/<filename>` (see PROFILE_PIC_DIR below),
   and that same filename is what gets stored on state.avatar /
   Firestore's users/{uid}.avatar (field name kept as "avatar" for
   backward compatibility with existing docs — it now holds a
   filename instead of an emoji character).

   PATH NOTE: `assets/` lives OUTSIDE the `html/` folder (a sibling of
   html/ and js/ at the project root), not inside it — index.html is
   at `html/index.html`, so every path below is prefixed with `../` to
   climb back out of html/ before reaching assets/. (An earlier
   handoff doc briefly had this wrong as `html/assets/...`; fixed
   here — if you moved index.html or the assets/ folder, update
   PROFILE_PIC_DIR / GESTURE_IMG_DIR below to match.)

   TODO (placeholder — replace before shipping): assets/profiles/ is
   currently filled with simple generated colored-circle silhouettes
   as stand-ins so the picker isn't full of broken images out of the
   box. Swap them out for real artwork whenever it's ready — just
   overwrite the same filenames (or edit this list to match whatever
   filenames you end up using; no other file needs to change, app.js
   just reads this array). 'default.png' is the one guests/new
   accounts start with, so make sure that one always exists.

   Note: the old LB_ALL static leaderboard sample data (fake names/XP
   used as a fallback when the real Firestore fetch failed) has been
   removed on purpose. renderLB() in app.js now leaves the gray
   shimmering skeleton (see .lb-skel-row/.lb-skel-bar in style.css) on
   screen instead whenever real data isn't available yet, rather than
   ever showing placeholder names/XP that could be mistaken for real
   players.
   ============================================================ */

// IMPORTANT: these must stay `var`, not `let`/`const` — same reason as
// `state` in app.js (see that file's header comment). firebase-init.js
// is a `type="module"` script, which does NOT share the top-level
// let/const lexical scope of classic scripts like this one; it only
// sees `var`s and other properties actually attached to `window`. A
// `const` here would make firebase-init.js's `PROFILE_PICS[0]` throw
// "PROFILE_PICS is not defined". (UNITS/QUESTIONS/LESSONS below stay
// `const` since only other classic scripts — app.js — ever read them,
// and classic scripts on the same page DO share top-level let/const,
// unlike modules.)

/* Folder (relative to index.html) that profile picture files live in */
var PROFILE_PIC_DIR = '../assets/profiles/';

/* Profile picture filenames available in "Edit Profile" — first entry
   is the default for guests/new accounts */
var PROFILE_PICS = [
  'default.png',
  'profile-1.png',
  'profile-2.png',
  'profile-3.png',
  'profile-4.png',
  'profile-5.png',
  'profile-6.png',
  'profile-7.png',
  'profile-8.png'
];

/* ------------------------------------------------------------
   Gesture reference images ("what letter is this hand-shape?")
   ------------------------------------------------------------
   Folder (relative to index.html, same `../` reasoning as
   PROFILE_PIC_DIR above) that per-letter ASL reference photos live
   in. Unlike PROFILE_PICS there's no fixed list here — app.js's
   gestureImageSrc(letter) just builds `<GESTURE_IMG_DIR><LETTER>.jpg`
   on the fly (e.g. letter 'A' -> 'assets/gestures/A.jpg') for:
     - the qa quiz's "ท่ามือนี้คือตัวอักษรใด?" question image, when a
       question's own `question_image` (below, in QUESTIONS) is left
       blank
     - the info-node preview cards shown before a lesson starts

   TODO (placeholder — replace before shipping): none of these files
   exist yet, so every one of these images will currently fail to
   load. That's handled gracefully — app.js's handleGestureImgError()
   swaps a failed <img> for the same hand-icon placeholder used
   before this change, so there's nothing broken-looking in the
   meantime. Once real photos are ready, just drop 26 files named
   A.jpg, B.jpg, ... Z.jpg into assets/gestures/ — no JS/lessons.js
   changes needed, they'll start showing automatically the next time
   each image is requested (no cache-busting needed either, since
   they don't exist yet to be cached).
   ------------------------------------------------------------ */
var GESTURE_IMG_DIR = '../assets/gestures/letters/';   // Session 36: letter pictures live in assets/gestures/letters/

/* Folder for emotion/word sign pictures (relative to index.html, same
   `../` reasoning as GESTURE_IMG_DIR). Files live at
   <SIGN_IMG_DIR><course>/<sign_id>_<frame>.jpg, e.g.
   '../assets/signs/emotions/happy_1.jpg'. A sign with frames:3 needs
   _1 (start), _2 (middle), _3 (end). Missing files fall back to the
   hand-icon placeholder, so the app works before the pictures exist. */
var SIGN_IMG_DIR = '../assets/signs/';

/* Recorded poses used by the real camera checks (js/gestures/sign-check.js).
   Made with the demo's Recorder; same `../` reasoning as SIGN_IMG_DIR. */
var SIGN_POSES_URL = '../assets/poses/all-signs.json?v=42';
/* Signs that would use the "skip" placeholder when FACE_LESSON_ON is false: they need
   the face model (chin / forehead zone, see FACE_SIGNS in face-tracker.js). Every other sign has a real camera check. */
var CAMERA_NEEDS_FACE = ['mother','father','know','sick'];
/* Session 34: the lessons now load the face model (lazily, only when a face-zone sign is shown), so mother / father /
   know are real camera checks too. Set to false to turn them back into "skip" placeholders (for example when the face
   model misbehaves on phones). The zones are never drawn in the lessons. */
var FACE_LESSON_ON = true;
/* Face-zone signs that already worked before the face model existed (shape and movement only): if the face model cannot
   load, these still run without the face rule instead of blocking the lesson. mother / father / know cannot (the face is the whole point). */
var FACE_OPTIONAL = ['boy','girl','home','sick'];   // sick without the face model: one hand clearly above the other (sign-check.js)
/* Session 35: two-hand signs (hands:2 in SIGNS) have real camera checks too (same recorded-pose check, both hands must match).
   Set to false to turn them back into "skip" placeholders (for example if two-hand checks misbehave on phones). */
var TWO_HAND_LESSON_ON = true;

/* PICTURES per emotion / word sign (Session 33). The owner's files do not follow the old
   <id>_<n>.jpg rule, so every sign lists its files by hand, in the order they are shown.
   Paths are relative to SIGN_PIC_DIR. The NUMBER of pictures is what the learner sees
   (qa quiz, info cards) and what the camera text counts steps with (q.pic_count); it is NOT
   the number of recorded poses (that is `frames` in SIGNS). Two signs repeat their first
   picture as the last one because the motion returns to the start: yes and bathroom
   (only 2 files exist, 3 pictures are shown). A sign with no entry (you: no picture yet)
   falls back to the old <id>_<n>.jpg names, which show the hand-icon placeholder. */
var SIGN_PIC_DIR = '../assets/gestures/';
var SIGN_PICS = {
  happy:['emotions/happy1.jpg'],
  sad:['emotions/sad-01.jpg','emotions/sad-02.jpg'],
  angry:['emotions/angry-01.jpg','emotions/angry-02.jpg','emotions/angry-03.jpg'],
  scared:['emotions/scared-01.jpg','emotions/scared-02.jpg','emotions/scared-03.jpg'],
  surprised:['emotions/surprise1.jpg','emotions/surprise2.jpg','emotions/surprise3.jpg'],
  tired:['emotions/tiredc1.jpg','emotions/tiredc2.jpg','emotions/tiredc3.jpg'],
  excited:['emotions/excited1.jpg','emotions/excited2.jpg','emotions/excited3.jpg'],
  bored:['emotions/bored1.jpg','emotions/bored2.jpg','emotions/bored3.jpg'],
  confused:['emotions/confused1.png','emotions/confused2.png','emotions/confused3.png'],
  worried:['emotions/worry1.jpg','emotions/worry2.jpg','emotions/worry3.jpg'],
  proud:['emotions/proud1.jpg','emotions/proud2.jpg','emotions/proud3.jpg'],
  lonely:['emotions/lonely1.jpg'],
  jealous:['emotions/jealousenvy1.jpg','emotions/jealousenvy2.jpg'],
  shy:['emotions/shy.ht15.jpg','emotions/shy.ht16.jpg','emotions/shy.ht17.jpg'],
  iloveyou:['emotions/i_love_you.jpg'],
  sick:['emotions/sick01.png'],
  hello:['words/hello1.png','words/hello2.png'],
  goodbye:['words/goodbye.png'],
  please:['words/please.jpg'],
  thankyou:['words/thank-you-01.jpg','words/thank-you-02.jpg'],
  sorry:['words/sorry.jpg'],
  yes:['words/yes1.jpg','words/yes2.jpg','words/yes1.jpg'],
  no:['words/no1.jpg','words/no2.jpg'],
  me:['words/me1.jpg'],
  you:['words/you_1.jpg'],
  friend:['words/friend-01.jpg','words/friend-02.jpg'],
  mother:['words/mother01.jpg'],
  father:['words/father01.jpg'],
  boy:['words/boy01.png','words/boy02.png'],
  girl:['words/girl-01.jpg','words/girl-02.jpg'],
  family:['words/family1.png','words/family2.png'],
  eat:['words/eat-01.jpg'],
  drink:['words/drink1.png','words/drink2.png'],
  water:['words/water.png'],
  hungry:['words/hungry1.png','words/hungry2.png','words/hungry3.png'],
  thirsty:['words/thirsty1.jpg','words/thirsty2.jpg','words/thirsty3.jpg'],
  sleep:['words/sleep1.jpg','words/sleep2.jpg','words/sleep3.jpg'],
  home:['words/home-01.jpg','words/home-02.jpg','words/home-03.jpg'],
  bathroom:['words/bathroom1.jpg','words/bathroom2.jpg','words/bathroom1.jpg'],
  need:['words/need1.jpg','words/need2.jpg'],
  want:['words/want.h1.jpg','words/want.h2.jpg'],
  where:['words/where1.png','words/where2.png'],
  who:['words/who1.png'],
  why:['words/why-01.jpg','words/why-02.jpg'],
  what:['words/what1.png'],
  how:['words/how-01.jpg','words/how-02.jpg','words/how-03.jpg'],
  like:['words/like-01-small.jpg','words/like-02.jpg','words/like-03.jpg'],
  good:['words/good-01.jpg','words/good-02.jpg'],
  bad:['words/bad-01.jpg','words/bad-02.jpg'],
  know:['words/know1.jpg','words/know2.jpg'],
  help:['words/help.png'],
  go:['words/go1.jpg','emotions/go2.jpg','emotions/go3.jpg'],
  come:['words/come-01.jpg','words/come-02.jpg','words/come-03.jpg'],
  finish:['emotions/finish1.jpg','emotions/finish2.jpg','emotions/finish3.jpg'],
  more:['emotions/more1.jpg','emotions/more2.jpg','emotions/more3.jpg']
};
/* The pictures of one sign: SIGN_PICS when listed, else the old <id>_<n>.jpg names. */
function signPicList(course,id,frames){
  if(SIGN_PICS[id])return SIGN_PICS[id].map(function(f){return SIGN_PIC_DIR+f;});
  var out=[];
  for(var i=1;i<=frames;i++)out.push(SIGN_IMG_DIR+course+'/'+id+'_'+i+'.jpg');
  return out;
}

/* ============================================================
   UNITS (section dividers)
   ============================================================
   u1-u6 each cover exactly 4 ASL alphabet letters. J and Z are
   pulled into their own dedicated section (u7) because they are
   motion/stroke letters rather than held poses — keeping them
   separate avoids mixing "hold still" and "draw a shape in the
   air" inside the same letter group.

   Each of u1-u6 follows a fixed 6-node shape:
     no 1  qa1 (normal)   — Q&A for letters 1-2 of the group
     no 2  qa2 (normal)   — Q&A for letters 3-4 of the group
     no 3  g1  (normal)   — gesture for letters 1-2
     no 4  g2  (normal)   — gesture for letters 3-4
     no 5  tqa (test)     — Q&A test covering all 4 letters
     no 6  tg  (test)     — gesture test covering all 4 letters

   u7 (J/Z) follows a shorter 4-node shape:
     no 1  qa  (normal)   — Q&A for both J and Z
     no 2  g   (normal)   — gesture for both J and Z
     no 3  tqa (test)     — Q&A test for J and Z
     no 4  tg  (test)     — gesture test for J and Z

   BONUS NODES are NOT defined here — they are generated at
   runtime by app.js (generateBonusNodes) so they can draw 2
   random questions from the cumulative pool of all previously
   completed sections' test questions. Each section except u1
   gets 1-3 bonus nodes (randomised). Bonus nodes are stored in
   state.bonusNodes and injected into LESSONS on each renderLessons
   call. They cannot be redone once completed.
   ============================================================ */

const UNITS=[
  {id:'u1',course:'alphabet',kicker:'หน่วยที่ 1',title:'ตัวอักษร A · B · C · D'},
  {id:'u2',course:'alphabet',kicker:'หน่วยที่ 2',title:'ตัวอักษร E · F · G · H'},
  {id:'u3',course:'alphabet',kicker:'หน่วยที่ 3',title:'ตัวอักษร I · K · L · M'},
  {id:'u4',course:'alphabet',kicker:'หน่วยที่ 4',title:'ตัวอักษร N · O · P · Q'},
  {id:'u5',course:'alphabet',kicker:'หน่วยที่ 5',title:'ตัวอักษร R · S · T · U'},
  {id:'u6',course:'alphabet',kicker:'หน่วยที่ 6',title:'ตัวอักษร V · W · X · Y'},
  {id:'u7',course:'alphabet',kicker:'หน่วยที่ 7',title:'ตัวอักษร J · Z (ท่าวาดมือ)'},
  {id:'e1',course:'emotions',kicker:'หน่วยที่ 8',title:'อารมณ์ 1'},
  {id:'e2',course:'emotions',kicker:'หน่วยที่ 9',title:'อารมณ์ 2'},
  {id:'e3',course:'emotions',kicker:'หน่วยที่ 10',title:'อารมณ์ 3'},
  {id:'e4',course:'emotions',kicker:'หน่วยที่ 11',title:'อารมณ์ 4'},
  {id:'w1',course:'words',kicker:'หน่วยที่ 12',title:'คำศัพท์ 1 · ทักทายและมารยาท'},
  {id:'w2',course:'words',kicker:'หน่วยที่ 13',title:'คำศัพท์ 2 · คำตอบและคน'},
  {id:'w3',course:'words',kicker:'หน่วยที่ 14',title:'คำศัพท์ 3 · ครอบครัว'},
  {id:'w4',course:'words',kicker:'หน่วยที่ 15',title:'คำศัพท์ 4 · กินและดื่ม'},
  {id:'w5',course:'words',kicker:'หน่วยที่ 16',title:'คำศัพท์ 5 · ความจำเป็นและสถานที่'},
  {id:'w6',course:'words',kicker:'หน่วยที่ 17',title:'คำศัพท์ 6 · คำถาม'},
  {id:'w7',course:'words',kicker:'หน่วยที่ 18',title:'คำศัพท์ 7 · ความชอบและการช่วยเหลือ'},
  {id:'w8',course:'words',kicker:'หน่วยที่ 19',title:'คำศัพท์ 8 · การกระทำ'},
];

/* ============================================================
   COURSES
   ============================================================
   Three courses share ONE continuous lesson path (UNITS order).
   Each unit carries a `course` id. A course starts at its first
   unit, which app.js uses for the top-right course card (jump +
   progress) and for the data-course tag on each unit banner.

   `bonusFrom` lists which OTHER courses' test questions may fill
   this course's bonus nodes, in addition to the course's own earlier
   units. So alphabet questions appear in the emotions/words bonus
   nodes (never in their regular lessons or tests — owner decision),
   and emotion questions appear in word bonus nodes. A bonus node can
   only draw from EARLIER units, and the alphabet course only draws
   from itself, exactly as before. Placeholder camera questions
   (q.placeholder) are never put in bonus pools.
   ============================================================ */
const COURSES=[
  {id:'alphabet',title:'ตัวอักษร A–Z',icon:'ti-abc',bonusFrom:[]},
  {id:'emotions',title:'อารมณ์',icon:'ti-mood-smile',bonusFrom:['alphabet']},
  {id:'words',title:'คำศัพท์',icon:'ti-message-circle',bonusFrom:['alphabet','emotions']},
];
function unitCourse(sectionId){
  const u=UNITS.find(u=>u.id===sectionId);
  return u?u.course:'alphabet';
}

/* ============================================================
   QUESTIONS
   ============================================================
   Flat lookup table, keyed by question_id.

   QUESTION SHAPE
   {
     question_id:    'q1',
     question_type:  'qa',                 // 'qa' | 'gesture'
     question_head:  'คำถาม?',
     question_image: 'images/a.jpg',       // ONLY for 'qa': image of the hand
                                            // gesture to identify. Leave '' for
                                            // a placeholder until real images
                                            // are added.
     correct_answer: 'c1',                 // for 'qa': a choice_id
                                            // for 'gesture': the letter, e.g. 'A'
     choices: [                            // ONLY for 'qa': ALWAYS 5 choices
       {choice_id:'c1', choice_value:'A'},
       ...
     ],
     xp: 15,
   }

   'gesture' questions show question_head and a live camera feed.
   The engine watches for the correct letter to be held still for
   GESTURE_FREEZE_MS (2000ms). J and Z are motion letters — they
   confirm as soon as the stroke completes; GESTURE_FREEZE_MS is
   reused as the engine's internal display freeze window.
   ============================================================ */


const QUESTIONS={
  /* --- u1: A · B · C · D --- */
  q_u1qa1_a:{question_id:'q_u1qa1_a',question_type:'qa',question_head:'ท่ามือนี้คือตัวอักษรใด?',question_image:'',correct_answer:'c3',choices:[{choice_id:'c1',choice_value:'B'},{choice_id:'c2',choice_value:'Y'},{choice_id:'c3',choice_value:'A'},{choice_id:'c4',choice_value:'V'},{choice_id:'c5',choice_value:'E'}],xp:10},
  q_u1g1_a:{question_id:'q_u1g1_a',question_type:'gesture',question_head:'ทำท่ามือค้างไว้สำหรับตัวอักษร A',correct_answer:'A',choices:[],xp:15},
  q_u1qa1_b:{question_id:'q_u1qa1_b',question_type:'qa',question_head:'ท่ามือนี้คือตัวอักษรใด?',question_image:'',correct_answer:'c5',choices:[{choice_id:'c1',choice_value:'Y'},{choice_id:'c2',choice_value:'E'},{choice_id:'c3',choice_value:'S'},{choice_id:'c4',choice_value:'W'},{choice_id:'c5',choice_value:'B'}],xp:10},
  q_u1g1_b:{question_id:'q_u1g1_b',question_type:'gesture',question_head:'ทำท่ามือค้างไว้สำหรับตัวอักษร B',correct_answer:'B',choices:[],xp:15},
  q_u1qa2_c:{question_id:'q_u1qa2_c',question_type:'qa',question_head:'ท่ามือนี้คือตัวอักษรใด?',question_image:'',correct_answer:'c4',choices:[{choice_id:'c1',choice_value:'D'},{choice_id:'c2',choice_value:'I'},{choice_id:'c3',choice_value:'H'},{choice_id:'c4',choice_value:'C'},{choice_id:'c5',choice_value:'R'}],xp:10},
  q_u1g2_c:{question_id:'q_u1g2_c',question_type:'gesture',question_head:'ทำท่ามือค้างไว้สำหรับตัวอักษร C',correct_answer:'C',choices:[],xp:15},
  q_u1qa2_d:{question_id:'q_u1qa2_d',question_type:'qa',question_head:'ท่ามือนี้คือตัวอักษรใด?',question_image:'',correct_answer:'c1',choices:[{choice_id:'c1',choice_value:'D'},{choice_id:'c2',choice_value:'O'},{choice_id:'c3',choice_value:'V'},{choice_id:'c4',choice_value:'S'},{choice_id:'c5',choice_value:'X'}],xp:10},
  q_u1g2_d:{question_id:'q_u1g2_d',question_type:'gesture',question_head:'ทำท่ามือค้างไว้สำหรับตัวอักษร D',correct_answer:'D',choices:[],xp:15},
  q_u1tqa_a:{question_id:'q_u1tqa_a',question_type:'qa',question_head:'ท่ามือนี้คือตัวอักษรใด?',question_image:'',correct_answer:'c2',choices:[{choice_id:'c1',choice_value:'X'},{choice_id:'c2',choice_value:'A'},{choice_id:'c3',choice_value:'B'},{choice_id:'c4',choice_value:'Z'},{choice_id:'c5',choice_value:'G'}],xp:20},
  q_u1tg_a:{question_id:'q_u1tg_a',question_type:'gesture',question_head:'แบบทดสอบ: ทำท่ามือค้างไว้สำหรับตัวอักษร A',correct_answer:'A',choices:[],xp:25},
  q_u1tqa_b:{question_id:'q_u1tqa_b',question_type:'qa',question_head:'ท่ามือนี้คือตัวอักษรใด?',question_image:'',correct_answer:'c5',choices:[{choice_id:'c1',choice_value:'Z'},{choice_id:'c2',choice_value:'H'},{choice_id:'c3',choice_value:'E'},{choice_id:'c4',choice_value:'L'},{choice_id:'c5',choice_value:'B'}],xp:20},
  q_u1tg_b:{question_id:'q_u1tg_b',question_type:'gesture',question_head:'แบบทดสอบ: ทำท่ามือค้างไว้สำหรับตัวอักษร B',correct_answer:'B',choices:[],xp:25},
  q_u1tqa_c:{question_id:'q_u1tqa_c',question_type:'qa',question_head:'ท่ามือนี้คือตัวอักษรใด?',question_image:'',correct_answer:'c4',choices:[{choice_id:'c1',choice_value:'U'},{choice_id:'c2',choice_value:'B'},{choice_id:'c3',choice_value:'M'},{choice_id:'c4',choice_value:'C'},{choice_id:'c5',choice_value:'J'}],xp:20},
  q_u1tg_c:{question_id:'q_u1tg_c',question_type:'gesture',question_head:'แบบทดสอบ: ทำท่ามือค้างไว้สำหรับตัวอักษร C',correct_answer:'C',choices:[],xp:25},
  q_u1tqa_d:{question_id:'q_u1tqa_d',question_type:'qa',question_head:'ท่ามือนี้คือตัวอักษรใด?',question_image:'',correct_answer:'c2',choices:[{choice_id:'c1',choice_value:'V'},{choice_id:'c2',choice_value:'D'},{choice_id:'c3',choice_value:'U'},{choice_id:'c4',choice_value:'S'},{choice_id:'c5',choice_value:'K'}],xp:20},
  q_u1tg_d:{question_id:'q_u1tg_d',question_type:'gesture',question_head:'แบบทดสอบ: ทำท่ามือค้างไว้สำหรับตัวอักษร D',correct_answer:'D',choices:[],xp:25},
  /* --- u2: E · F · G · H --- */
  q_u2qa1_e:{question_id:'q_u2qa1_e',question_type:'qa',question_head:'ท่ามือนี้คือตัวอักษรใด?',question_image:'',correct_answer:'c4',choices:[{choice_id:'c1',choice_value:'B'},{choice_id:'c2',choice_value:'Z'},{choice_id:'c3',choice_value:'I'},{choice_id:'c4',choice_value:'E'},{choice_id:'c5',choice_value:'W'}],xp:10},
  q_u2g1_e:{question_id:'q_u2g1_e',question_type:'gesture',question_head:'ทำท่ามือค้างไว้สำหรับตัวอักษร E',correct_answer:'E',choices:[],xp:15},
  q_u2qa1_f:{question_id:'q_u2qa1_f',question_type:'qa',question_head:'ท่ามือนี้คือตัวอักษรใด?',question_image:'',correct_answer:'c1',choices:[{choice_id:'c1',choice_value:'F'},{choice_id:'c2',choice_value:'V'},{choice_id:'c3',choice_value:'P'},{choice_id:'c4',choice_value:'N'},{choice_id:'c5',choice_value:'J'}],xp:10},
  q_u2g1_f:{question_id:'q_u2g1_f',question_type:'gesture',question_head:'ทำท่ามือค้างไว้สำหรับตัวอักษร F',correct_answer:'F',choices:[],xp:15},
  q_u2qa2_g:{question_id:'q_u2qa2_g',question_type:'qa',question_head:'ท่ามือนี้คือตัวอักษรใด?',question_image:'',correct_answer:'c5',choices:[{choice_id:'c1',choice_value:'J'},{choice_id:'c2',choice_value:'X'},{choice_id:'c3',choice_value:'W'},{choice_id:'c4',choice_value:'H'},{choice_id:'c5',choice_value:'G'}],xp:10},
  q_u2g2_g:{question_id:'q_u2g2_g',question_type:'gesture',question_head:'ทำท่ามือค้างไว้สำหรับตัวอักษร G',correct_answer:'G',choices:[],xp:15},
  q_u2qa2_h:{question_id:'q_u2qa2_h',question_type:'qa',question_head:'ท่ามือนี้คือตัวอักษรใด?',question_image:'',correct_answer:'c1',choices:[{choice_id:'c1',choice_value:'H'},{choice_id:'c2',choice_value:'N'},{choice_id:'c3',choice_value:'P'},{choice_id:'c4',choice_value:'F'},{choice_id:'c5',choice_value:'J'}],xp:10},
  q_u2g2_h:{question_id:'q_u2g2_h',question_type:'gesture',question_head:'ทำท่ามือค้างไว้สำหรับตัวอักษร H',correct_answer:'H',choices:[],xp:15},
  q_u2tqa_e:{question_id:'q_u2tqa_e',question_type:'qa',question_head:'ท่ามือนี้คือตัวอักษรใด?',question_image:'',correct_answer:'c3',choices:[{choice_id:'c1',choice_value:'Z'},{choice_id:'c2',choice_value:'L'},{choice_id:'c3',choice_value:'E'},{choice_id:'c4',choice_value:'B'},{choice_id:'c5',choice_value:'I'}],xp:20},
  q_u2tg_e:{question_id:'q_u2tg_e',question_type:'gesture',question_head:'แบบทดสอบ: ทำท่ามือค้างไว้สำหรับตัวอักษร E',correct_answer:'E',choices:[],xp:25},
  q_u2tqa_f:{question_id:'q_u2tqa_f',question_type:'qa',question_head:'ท่ามือนี้คือตัวอักษรใด?',question_image:'',correct_answer:'c1',choices:[{choice_id:'c1',choice_value:'F'},{choice_id:'c2',choice_value:'T'},{choice_id:'c3',choice_value:'X'},{choice_id:'c4',choice_value:'H'},{choice_id:'c5',choice_value:'L'}],xp:20},
  q_u2tg_f:{question_id:'q_u2tg_f',question_type:'gesture',question_head:'แบบทดสอบ: ทำท่ามือค้างไว้สำหรับตัวอักษร F',correct_answer:'F',choices:[],xp:25},
  q_u2tqa_g:{question_id:'q_u2tqa_g',question_type:'qa',question_head:'ท่ามือนี้คือตัวอักษรใด?',question_image:'',correct_answer:'c1',choices:[{choice_id:'c1',choice_value:'G'},{choice_id:'c2',choice_value:'E'},{choice_id:'c3',choice_value:'I'},{choice_id:'c4',choice_value:'J'},{choice_id:'c5',choice_value:'Y'}],xp:20},
  q_u2tg_g:{question_id:'q_u2tg_g',question_type:'gesture',question_head:'แบบทดสอบ: ทำท่ามือค้างไว้สำหรับตัวอักษร G',correct_answer:'G',choices:[],xp:25},
  q_u2tqa_h:{question_id:'q_u2tqa_h',question_type:'qa',question_head:'ท่ามือนี้คือตัวอักษรใด?',question_image:'',correct_answer:'c3',choices:[{choice_id:'c1',choice_value:'I'},{choice_id:'c2',choice_value:'N'},{choice_id:'c3',choice_value:'H'},{choice_id:'c4',choice_value:'M'},{choice_id:'c5',choice_value:'T'}],xp:20},
  q_u2tg_h:{question_id:'q_u2tg_h',question_type:'gesture',question_head:'แบบทดสอบ: ทำท่ามือค้างไว้สำหรับตัวอักษร H',correct_answer:'H',choices:[],xp:25},
  /* --- u3: I · K · L · M --- */
  q_u3qa1_i:{question_id:'q_u3qa1_i',question_type:'qa',question_head:'ท่ามือนี้คือตัวอักษรใด?',question_image:'',correct_answer:'c4',choices:[{choice_id:'c1',choice_value:'F'},{choice_id:'c2',choice_value:'E'},{choice_id:'c3',choice_value:'D'},{choice_id:'c4',choice_value:'I'},{choice_id:'c5',choice_value:'V'}],xp:10},
  q_u3g1_i:{question_id:'q_u3g1_i',question_type:'gesture',question_head:'ทำท่ามือค้างไว้สำหรับตัวอักษร I',correct_answer:'I',choices:[],xp:15},
  q_u3qa1_k:{question_id:'q_u3qa1_k',question_type:'qa',question_head:'ท่ามือนี้คือตัวอักษรใด?',question_image:'',correct_answer:'c4',choices:[{choice_id:'c1',choice_value:'U'},{choice_id:'c2',choice_value:'R'},{choice_id:'c3',choice_value:'P'},{choice_id:'c4',choice_value:'K'},{choice_id:'c5',choice_value:'I'}],xp:10},
  q_u3g1_k:{question_id:'q_u3g1_k',question_type:'gesture',question_head:'ทำท่ามือค้างไว้สำหรับตัวอักษร K',correct_answer:'K',choices:[],xp:15},
  q_u3qa2_l:{question_id:'q_u3qa2_l',question_type:'qa',question_head:'ท่ามือนี้คือตัวอักษรใด?',question_image:'',correct_answer:'c4',choices:[{choice_id:'c1',choice_value:'Z'},{choice_id:'c2',choice_value:'I'},{choice_id:'c3',choice_value:'W'},{choice_id:'c4',choice_value:'L'},{choice_id:'c5',choice_value:'S'}],xp:10},
  q_u3g2_l:{question_id:'q_u3g2_l',question_type:'gesture',question_head:'ทำท่ามือค้างไว้สำหรับตัวอักษร L',correct_answer:'L',choices:[],xp:15},
  q_u3qa2_m:{question_id:'q_u3qa2_m',question_type:'qa',question_head:'ท่ามือนี้คือตัวอักษรใด?',question_image:'',correct_answer:'c2',choices:[{choice_id:'c1',choice_value:'A'},{choice_id:'c2',choice_value:'M'},{choice_id:'c3',choice_value:'Y'},{choice_id:'c4',choice_value:'F'},{choice_id:'c5',choice_value:'P'}],xp:10},
  q_u3g2_m:{question_id:'q_u3g2_m',question_type:'gesture',question_head:'ทำท่ามือค้างไว้สำหรับตัวอักษร M',correct_answer:'M',choices:[],xp:15},
  q_u3tqa_i:{question_id:'q_u3tqa_i',question_type:'qa',question_head:'ท่ามือนี้คือตัวอักษรใด?',question_image:'',correct_answer:'c2',choices:[{choice_id:'c1',choice_value:'K'},{choice_id:'c2',choice_value:'I'},{choice_id:'c3',choice_value:'R'},{choice_id:'c4',choice_value:'U'},{choice_id:'c5',choice_value:'V'}],xp:20},
  q_u3tg_i:{question_id:'q_u3tg_i',question_type:'gesture',question_head:'แบบทดสอบ: ทำท่ามือค้างไว้สำหรับตัวอักษร I',correct_answer:'I',choices:[],xp:25},
  q_u3tqa_k:{question_id:'q_u3tqa_k',question_type:'qa',question_head:'ท่ามือนี้คือตัวอักษรใด?',question_image:'',correct_answer:'c2',choices:[{choice_id:'c1',choice_value:'R'},{choice_id:'c2',choice_value:'K'},{choice_id:'c3',choice_value:'S'},{choice_id:'c4',choice_value:'Z'},{choice_id:'c5',choice_value:'A'}],xp:20},
  q_u3tg_k:{question_id:'q_u3tg_k',question_type:'gesture',question_head:'แบบทดสอบ: ทำท่ามือค้างไว้สำหรับตัวอักษร K',correct_answer:'K',choices:[],xp:25},
  q_u3tqa_l:{question_id:'q_u3tqa_l',question_type:'qa',question_head:'ท่ามือนี้คือตัวอักษรใด?',question_image:'',correct_answer:'c5',choices:[{choice_id:'c1',choice_value:'J'},{choice_id:'c2',choice_value:'H'},{choice_id:'c3',choice_value:'M'},{choice_id:'c4',choice_value:'D'},{choice_id:'c5',choice_value:'L'}],xp:20},
  q_u3tg_l:{question_id:'q_u3tg_l',question_type:'gesture',question_head:'แบบทดสอบ: ทำท่ามือค้างไว้สำหรับตัวอักษร L',correct_answer:'L',choices:[],xp:25},
  q_u3tqa_m:{question_id:'q_u3tqa_m',question_type:'qa',question_head:'ท่ามือนี้คือตัวอักษรใด?',question_image:'',correct_answer:'c3',choices:[{choice_id:'c1',choice_value:'Y'},{choice_id:'c2',choice_value:'Q'},{choice_id:'c3',choice_value:'M'},{choice_id:'c4',choice_value:'C'},{choice_id:'c5',choice_value:'Z'}],xp:20},
  q_u3tg_m:{question_id:'q_u3tg_m',question_type:'gesture',question_head:'แบบทดสอบ: ทำท่ามือค้างไว้สำหรับตัวอักษร M',correct_answer:'M',choices:[],xp:25},
  /* --- u4: N · O · P · Q --- */
  q_u4qa1_n:{question_id:'q_u4qa1_n',question_type:'qa',question_head:'ท่ามือนี้คือตัวอักษรใด?',question_image:'',correct_answer:'c3',choices:[{choice_id:'c1',choice_value:'S'},{choice_id:'c2',choice_value:'F'},{choice_id:'c3',choice_value:'N'},{choice_id:'c4',choice_value:'I'},{choice_id:'c5',choice_value:'R'}],xp:10},
  q_u4g1_n:{question_id:'q_u4g1_n',question_type:'gesture',question_head:'ทำท่ามือค้างไว้สำหรับตัวอักษร N',correct_answer:'N',choices:[],xp:15},
  q_u4qa1_o:{question_id:'q_u4qa1_o',question_type:'qa',question_head:'ท่ามือนี้คือตัวอักษรใด?',question_image:'',correct_answer:'c1',choices:[{choice_id:'c1',choice_value:'O'},{choice_id:'c2',choice_value:'X'},{choice_id:'c3',choice_value:'W'},{choice_id:'c4',choice_value:'M'},{choice_id:'c5',choice_value:'J'}],xp:10},
  q_u4g1_o:{question_id:'q_u4g1_o',question_type:'gesture',question_head:'ทำท่ามือค้างไว้สำหรับตัวอักษร O',correct_answer:'O',choices:[],xp:15},
  q_u4qa2_p:{question_id:'q_u4qa2_p',question_type:'qa',question_head:'ท่ามือนี้คือตัวอักษรใด?',question_image:'',correct_answer:'c5',choices:[{choice_id:'c1',choice_value:'C'},{choice_id:'c2',choice_value:'K'},{choice_id:'c3',choice_value:'H'},{choice_id:'c4',choice_value:'D'},{choice_id:'c5',choice_value:'P'}],xp:10},
  q_u4g2_p:{question_id:'q_u4g2_p',question_type:'gesture',question_head:'ทำท่ามือค้างไว้สำหรับตัวอักษร P',correct_answer:'P',choices:[],xp:15},
  q_u4qa2_q:{question_id:'q_u4qa2_q',question_type:'qa',question_head:'ท่ามือนี้คือตัวอักษรใด?',question_image:'',correct_answer:'c5',choices:[{choice_id:'c1',choice_value:'X'},{choice_id:'c2',choice_value:'C'},{choice_id:'c3',choice_value:'V'},{choice_id:'c4',choice_value:'A'},{choice_id:'c5',choice_value:'Q'}],xp:10},
  q_u4g2_q:{question_id:'q_u4g2_q',question_type:'gesture',question_head:'ทำท่ามือค้างไว้สำหรับตัวอักษร Q',correct_answer:'Q',choices:[],xp:15},
  q_u4tqa_n:{question_id:'q_u4tqa_n',question_type:'qa',question_head:'ท่ามือนี้คือตัวอักษรใด?',question_image:'',correct_answer:'c3',choices:[{choice_id:'c1',choice_value:'K'},{choice_id:'c2',choice_value:'H'},{choice_id:'c3',choice_value:'N'},{choice_id:'c4',choice_value:'R'},{choice_id:'c5',choice_value:'C'}],xp:20},
  q_u4tg_n:{question_id:'q_u4tg_n',question_type:'gesture',question_head:'แบบทดสอบ: ทำท่ามือค้างไว้สำหรับตัวอักษร N',correct_answer:'N',choices:[],xp:25},
  q_u4tqa_o:{question_id:'q_u4tqa_o',question_type:'qa',question_head:'ท่ามือนี้คือตัวอักษรใด?',question_image:'',correct_answer:'c3',choices:[{choice_id:'c1',choice_value:'Y'},{choice_id:'c2',choice_value:'T'},{choice_id:'c3',choice_value:'O'},{choice_id:'c4',choice_value:'H'},{choice_id:'c5',choice_value:'Q'}],xp:20},
  q_u4tg_o:{question_id:'q_u4tg_o',question_type:'gesture',question_head:'แบบทดสอบ: ทำท่ามือค้างไว้สำหรับตัวอักษร O',correct_answer:'O',choices:[],xp:25},
  q_u4tqa_p:{question_id:'q_u4tqa_p',question_type:'qa',question_head:'ท่ามือนี้คือตัวอักษรใด?',question_image:'',correct_answer:'c2',choices:[{choice_id:'c1',choice_value:'W'},{choice_id:'c2',choice_value:'P'},{choice_id:'c3',choice_value:'D'},{choice_id:'c4',choice_value:'L'},{choice_id:'c5',choice_value:'N'}],xp:20},
  q_u4tg_p:{question_id:'q_u4tg_p',question_type:'gesture',question_head:'แบบทดสอบ: ทำท่ามือค้างไว้สำหรับตัวอักษร P',correct_answer:'P',choices:[],xp:25},
  q_u4tqa_q:{question_id:'q_u4tqa_q',question_type:'qa',question_head:'ท่ามือนี้คือตัวอักษรใด?',question_image:'',correct_answer:'c3',choices:[{choice_id:'c1',choice_value:'W'},{choice_id:'c2',choice_value:'B'},{choice_id:'c3',choice_value:'Q'},{choice_id:'c4',choice_value:'V'},{choice_id:'c5',choice_value:'D'}],xp:20},
  q_u4tg_q:{question_id:'q_u4tg_q',question_type:'gesture',question_head:'แบบทดสอบ: ทำท่ามือค้างไว้สำหรับตัวอักษร Q',correct_answer:'Q',choices:[],xp:25},
  /* --- u5: R · S · T · U --- */
  q_u5qa1_r:{question_id:'q_u5qa1_r',question_type:'qa',question_head:'ท่ามือนี้คือตัวอักษรใด?',question_image:'',correct_answer:'c1',choices:[{choice_id:'c1',choice_value:'R'},{choice_id:'c2',choice_value:'S'},{choice_id:'c3',choice_value:'E'},{choice_id:'c4',choice_value:'G'},{choice_id:'c5',choice_value:'O'}],xp:10},
  q_u5g1_r:{question_id:'q_u5g1_r',question_type:'gesture',question_head:'ทำท่ามือค้างไว้สำหรับตัวอักษร R',correct_answer:'R',choices:[],xp:15},
  q_u5qa1_s:{question_id:'q_u5qa1_s',question_type:'qa',question_head:'ท่ามือนี้คือตัวอักษรใด?',question_image:'',correct_answer:'c5',choices:[{choice_id:'c1',choice_value:'H'},{choice_id:'c2',choice_value:'O'},{choice_id:'c3',choice_value:'C'},{choice_id:'c4',choice_value:'R'},{choice_id:'c5',choice_value:'S'}],xp:10},
  q_u5g1_s:{question_id:'q_u5g1_s',question_type:'gesture',question_head:'ทำท่ามือค้างไว้สำหรับตัวอักษร S',correct_answer:'S',choices:[],xp:15},
  q_u5qa2_t:{question_id:'q_u5qa2_t',question_type:'qa',question_head:'ท่ามือนี้คือตัวอักษรใด?',question_image:'',correct_answer:'c2',choices:[{choice_id:'c1',choice_value:'Z'},{choice_id:'c2',choice_value:'T'},{choice_id:'c3',choice_value:'C'},{choice_id:'c4',choice_value:'F'},{choice_id:'c5',choice_value:'H'}],xp:10},
  q_u5g2_t:{question_id:'q_u5g2_t',question_type:'gesture',question_head:'ทำท่ามือค้างไว้สำหรับตัวอักษร T',correct_answer:'T',choices:[],xp:15},
  q_u5qa2_u:{question_id:'q_u5qa2_u',question_type:'qa',question_head:'ท่ามือนี้คือตัวอักษรใด?',question_image:'',correct_answer:'c1',choices:[{choice_id:'c1',choice_value:'U'},{choice_id:'c2',choice_value:'A'},{choice_id:'c3',choice_value:'M'},{choice_id:'c4',choice_value:'B'},{choice_id:'c5',choice_value:'F'}],xp:10},
  q_u5g2_u:{question_id:'q_u5g2_u',question_type:'gesture',question_head:'ทำท่ามือค้างไว้สำหรับตัวอักษร U',correct_answer:'U',choices:[],xp:15},
  q_u5tqa_r:{question_id:'q_u5tqa_r',question_type:'qa',question_head:'ท่ามือนี้คือตัวอักษรใด?',question_image:'',correct_answer:'c3',choices:[{choice_id:'c1',choice_value:'X'},{choice_id:'c2',choice_value:'S'},{choice_id:'c3',choice_value:'R'},{choice_id:'c4',choice_value:'N'},{choice_id:'c5',choice_value:'Y'}],xp:20},
  q_u5tg_r:{question_id:'q_u5tg_r',question_type:'gesture',question_head:'แบบทดสอบ: ทำท่ามือค้างไว้สำหรับตัวอักษร R',correct_answer:'R',choices:[],xp:25},
  q_u5tqa_s:{question_id:'q_u5tqa_s',question_type:'qa',question_head:'ท่ามือนี้คือตัวอักษรใด?',question_image:'',correct_answer:'c4',choices:[{choice_id:'c1',choice_value:'T'},{choice_id:'c2',choice_value:'G'},{choice_id:'c3',choice_value:'B'},{choice_id:'c4',choice_value:'S'},{choice_id:'c5',choice_value:'Y'}],xp:20},
  q_u5tg_s:{question_id:'q_u5tg_s',question_type:'gesture',question_head:'แบบทดสอบ: ทำท่ามือค้างไว้สำหรับตัวอักษร S',correct_answer:'S',choices:[],xp:25},
  q_u5tqa_t:{question_id:'q_u5tqa_t',question_type:'qa',question_head:'ท่ามือนี้คือตัวอักษรใด?',question_image:'',correct_answer:'c3',choices:[{choice_id:'c1',choice_value:'P'},{choice_id:'c2',choice_value:'S'},{choice_id:'c3',choice_value:'T'},{choice_id:'c4',choice_value:'B'},{choice_id:'c5',choice_value:'Q'}],xp:20},
  q_u5tg_t:{question_id:'q_u5tg_t',question_type:'gesture',question_head:'แบบทดสอบ: ทำท่ามือค้างไว้สำหรับตัวอักษร T',correct_answer:'T',choices:[],xp:25},
  q_u5tqa_u:{question_id:'q_u5tqa_u',question_type:'qa',question_head:'ท่ามือนี้คือตัวอักษรใด?',question_image:'',correct_answer:'c3',choices:[{choice_id:'c1',choice_value:'W'},{choice_id:'c2',choice_value:'C'},{choice_id:'c3',choice_value:'U'},{choice_id:'c4',choice_value:'T'},{choice_id:'c5',choice_value:'F'}],xp:20},
  q_u5tg_u:{question_id:'q_u5tg_u',question_type:'gesture',question_head:'แบบทดสอบ: ทำท่ามือค้างไว้สำหรับตัวอักษร U',correct_answer:'U',choices:[],xp:25},
  /* --- u6: V · W · X · Y --- */
  q_u6qa1_v:{question_id:'q_u6qa1_v',question_type:'qa',question_head:'ท่ามือนี้คือตัวอักษรใด?',question_image:'',correct_answer:'c2',choices:[{choice_id:'c1',choice_value:'C'},{choice_id:'c2',choice_value:'V'},{choice_id:'c3',choice_value:'S'},{choice_id:'c4',choice_value:'T'},{choice_id:'c5',choice_value:'B'}],xp:10},
  q_u6g1_v:{question_id:'q_u6g1_v',question_type:'gesture',question_head:'ทำท่ามือค้างไว้สำหรับตัวอักษร V',correct_answer:'V',choices:[],xp:15},
  q_u6qa1_w:{question_id:'q_u6qa1_w',question_type:'qa',question_head:'ท่ามือนี้คือตัวอักษรใด?',question_image:'',correct_answer:'c3',choices:[{choice_id:'c1',choice_value:'H'},{choice_id:'c2',choice_value:'V'},{choice_id:'c3',choice_value:'W'},{choice_id:'c4',choice_value:'K'},{choice_id:'c5',choice_value:'X'}],xp:10},
  q_u6g1_w:{question_id:'q_u6g1_w',question_type:'gesture',question_head:'ทำท่ามือค้างไว้สำหรับตัวอักษร W',correct_answer:'W',choices:[],xp:15},
  q_u6qa2_x:{question_id:'q_u6qa2_x',question_type:'qa',question_head:'ท่ามือนี้คือตัวอักษรใด?',question_image:'',correct_answer:'c5',choices:[{choice_id:'c1',choice_value:'O'},{choice_id:'c2',choice_value:'C'},{choice_id:'c3',choice_value:'K'},{choice_id:'c4',choice_value:'Z'},{choice_id:'c5',choice_value:'X'}],xp:10},
  q_u6g2_x:{question_id:'q_u6g2_x',question_type:'gesture',question_head:'ทำท่ามือค้างไว้สำหรับตัวอักษร X',correct_answer:'X',choices:[],xp:15},
  q_u6qa2_y:{question_id:'q_u6qa2_y',question_type:'qa',question_head:'ท่ามือนี้คือตัวอักษรใด?',question_image:'',correct_answer:'c2',choices:[{choice_id:'c1',choice_value:'Q'},{choice_id:'c2',choice_value:'Y'},{choice_id:'c3',choice_value:'G'},{choice_id:'c4',choice_value:'C'},{choice_id:'c5',choice_value:'R'}],xp:10},
  q_u6g2_y:{question_id:'q_u6g2_y',question_type:'gesture',question_head:'ทำท่ามือค้างไว้สำหรับตัวอักษร Y',correct_answer:'Y',choices:[],xp:15},
  q_u6tqa_v:{question_id:'q_u6tqa_v',question_type:'qa',question_head:'ท่ามือนี้คือตัวอักษรใด?',question_image:'',correct_answer:'c2',choices:[{choice_id:'c1',choice_value:'H'},{choice_id:'c2',choice_value:'V'},{choice_id:'c3',choice_value:'F'},{choice_id:'c4',choice_value:'L'},{choice_id:'c5',choice_value:'J'}],xp:20},
  q_u6tg_v:{question_id:'q_u6tg_v',question_type:'gesture',question_head:'แบบทดสอบ: ทำท่ามือค้างไว้สำหรับตัวอักษร V',correct_answer:'V',choices:[],xp:25},
  q_u6tqa_w:{question_id:'q_u6tqa_w',question_type:'qa',question_head:'ท่ามือนี้คือตัวอักษรใด?',question_image:'',correct_answer:'c3',choices:[{choice_id:'c1',choice_value:'D'},{choice_id:'c2',choice_value:'J'},{choice_id:'c3',choice_value:'W'},{choice_id:'c4',choice_value:'R'},{choice_id:'c5',choice_value:'V'}],xp:20},
  q_u6tg_w:{question_id:'q_u6tg_w',question_type:'gesture',question_head:'แบบทดสอบ: ทำท่ามือค้างไว้สำหรับตัวอักษร W',correct_answer:'W',choices:[],xp:25},
  q_u6tqa_x:{question_id:'q_u6tqa_x',question_type:'qa',question_head:'ท่ามือนี้คือตัวอักษรใด?',question_image:'',correct_answer:'c1',choices:[{choice_id:'c1',choice_value:'X'},{choice_id:'c2',choice_value:'E'},{choice_id:'c3',choice_value:'I'},{choice_id:'c4',choice_value:'Y'},{choice_id:'c5',choice_value:'R'}],xp:20},
  q_u6tg_x:{question_id:'q_u6tg_x',question_type:'gesture',question_head:'แบบทดสอบ: ทำท่ามือค้างไว้สำหรับตัวอักษร X',correct_answer:'X',choices:[],xp:25},
  q_u6tqa_y:{question_id:'q_u6tqa_y',question_type:'qa',question_head:'ท่ามือนี้คือตัวอักษรใด?',question_image:'',correct_answer:'c2',choices:[{choice_id:'c1',choice_value:'V'},{choice_id:'c2',choice_value:'Y'},{choice_id:'c3',choice_value:'G'},{choice_id:'c4',choice_value:'U'},{choice_id:'c5',choice_value:'I'}],xp:20},
  q_u6tg_y:{question_id:'q_u6tg_y',question_type:'gesture',question_head:'แบบทดสอบ: ทำท่ามือค้างไว้สำหรับตัวอักษร Y',correct_answer:'Y',choices:[],xp:25},
  /* --- u7: J · Z --- */
  q_u7qa_j:{question_id:'q_u7qa_j',question_type:'qa',question_head:'ท่ามือนี้คือตัวอักษรใด?',question_image:'',correct_answer:'c5',choices:[{choice_id:'c1',choice_value:'V'},{choice_id:'c2',choice_value:'O'},{choice_id:'c3',choice_value:'C'},{choice_id:'c4',choice_value:'I'},{choice_id:'c5',choice_value:'J'}],xp:10},
  q_u7g_j:{question_id:'q_u7g_j',question_type:'gesture',question_head:'ทำท่าวาดมือสำหรับตัวอักษร J',correct_answer:'J',choices:[],xp:15},
  q_u7tqa_j:{question_id:'q_u7tqa_j',question_type:'qa',question_head:'ท่ามือนี้คือตัวอักษรใด?',question_image:'',correct_answer:'c2',choices:[{choice_id:'c1',choice_value:'V'},{choice_id:'c2',choice_value:'J'},{choice_id:'c3',choice_value:'I'},{choice_id:'c4',choice_value:'Y'},{choice_id:'c5',choice_value:'F'}],xp:20},
  q_u7tg_j:{question_id:'q_u7tg_j',question_type:'gesture',question_head:'แบบทดสอบ: ทำท่าวาดมือสำหรับตัวอักษร J',correct_answer:'J',choices:[],xp:25},
  q_u7qa_z:{question_id:'q_u7qa_z',question_type:'qa',question_head:'ท่ามือนี้คือตัวอักษรใด?',question_image:'',correct_answer:'c4',choices:[{choice_id:'c1',choice_value:'C'},{choice_id:'c2',choice_value:'W'},{choice_id:'c3',choice_value:'D'},{choice_id:'c4',choice_value:'Z'},{choice_id:'c5',choice_value:'E'}],xp:10},
  q_u7g_z:{question_id:'q_u7g_z',question_type:'gesture',question_head:'ทำท่าวาดมือสำหรับตัวอักษร Z',correct_answer:'Z',choices:[],xp:15},
  q_u7tqa_z:{question_id:'q_u7tqa_z',question_type:'qa',question_head:'ท่ามือนี้คือตัวอักษรใด?',question_image:'',correct_answer:'c4',choices:[{choice_id:'c1',choice_value:'J'},{choice_id:'c2',choice_value:'B'},{choice_id:'c3',choice_value:'N'},{choice_id:'c4',choice_value:'Z'},{choice_id:'c5',choice_value:'E'}],xp:20},
  q_u7tg_z:{question_id:'q_u7tg_z',question_type:'gesture',question_head:'แบบทดสอบ: ทำท่าวาดมือสำหรับตัวอักษร Z',correct_answer:'Z',choices:[],xp:25},
};


const LESSONS=[
  /* u1: A · B · C · D */
  {lesson_id:'u1qa1',section:'u1',no:1,type:'qa',mode:'normal',questions:['q_u1qa1_a', 'q_u1qa1_b']},
  {lesson_id:'u1qa2',section:'u1',no:3,type:'qa',mode:'normal',questions:['q_u1qa2_c', 'q_u1qa2_d']},
  {lesson_id:'u1g1',section:'u1',no:2,type:'gesture',mode:'normal',questions:['q_u1g1_a', 'q_u1g1_b']},
  {lesson_id:'u1g2',section:'u1',no:4,type:'gesture',mode:'normal',questions:['q_u1g2_c', 'q_u1g2_d']},
  {lesson_id:'u1tqa',section:'u1',no:5,type:'qa',mode:'test',questions:['q_u1tqa_a', 'q_u1tqa_b', 'q_u1tqa_c', 'q_u1tqa_d']},
  {lesson_id:'u1tg',section:'u1',no:6,type:'gesture',mode:'test',questions:['q_u1tg_a', 'q_u1tg_b', 'q_u1tg_c', 'q_u1tg_d']},
  /* u2: E · F · G · H */
  {lesson_id:'u2qa1',section:'u2',no:1,type:'qa',mode:'normal',questions:['q_u2qa1_e', 'q_u2qa1_f']},
  {lesson_id:'u2qa2',section:'u2',no:3,type:'qa',mode:'normal',questions:['q_u2qa2_g', 'q_u2qa2_h']},
  {lesson_id:'u2g1',section:'u2',no:2,type:'gesture',mode:'normal',questions:['q_u2g1_e', 'q_u2g1_f']},
  {lesson_id:'u2g2',section:'u2',no:4,type:'gesture',mode:'normal',questions:['q_u2g2_g', 'q_u2g2_h']},
  {lesson_id:'u2tqa',section:'u2',no:5,type:'qa',mode:'test',questions:['q_u2tqa_e', 'q_u2tqa_f', 'q_u2tqa_g', 'q_u2tqa_h']},
  {lesson_id:'u2tg',section:'u2',no:6,type:'gesture',mode:'test',questions:['q_u2tg_e', 'q_u2tg_f', 'q_u2tg_g', 'q_u2tg_h']},
  /* u3: I · K · L · M */
  {lesson_id:'u3qa1',section:'u3',no:1,type:'qa',mode:'normal',questions:['q_u3qa1_i', 'q_u3qa1_k']},
  {lesson_id:'u3qa2',section:'u3',no:3,type:'qa',mode:'normal',questions:['q_u3qa2_l', 'q_u3qa2_m']},
  {lesson_id:'u3g1',section:'u3',no:2,type:'gesture',mode:'normal',questions:['q_u3g1_i', 'q_u3g1_k']},
  {lesson_id:'u3g2',section:'u3',no:4,type:'gesture',mode:'normal',questions:['q_u3g2_l', 'q_u3g2_m']},
  {lesson_id:'u3tqa',section:'u3',no:5,type:'qa',mode:'test',questions:['q_u3tqa_i', 'q_u3tqa_k', 'q_u3tqa_l', 'q_u3tqa_m']},
  {lesson_id:'u3tg',section:'u3',no:6,type:'gesture',mode:'test',questions:['q_u3tg_i', 'q_u3tg_k', 'q_u3tg_l', 'q_u3tg_m']},
  /* u4: N · O · P · Q */
  {lesson_id:'u4qa1',section:'u4',no:1,type:'qa',mode:'normal',questions:['q_u4qa1_n', 'q_u4qa1_o']},
  {lesson_id:'u4qa2',section:'u4',no:3,type:'qa',mode:'normal',questions:['q_u4qa2_p', 'q_u4qa2_q']},
  {lesson_id:'u4g1',section:'u4',no:2,type:'gesture',mode:'normal',questions:['q_u4g1_n', 'q_u4g1_o']},
  {lesson_id:'u4g2',section:'u4',no:4,type:'gesture',mode:'normal',questions:['q_u4g2_p', 'q_u4g2_q']},
  {lesson_id:'u4tqa',section:'u4',no:5,type:'qa',mode:'test',questions:['q_u4tqa_n', 'q_u4tqa_o', 'q_u4tqa_p', 'q_u4tqa_q']},
  {lesson_id:'u4tg',section:'u4',no:6,type:'gesture',mode:'test',questions:['q_u4tg_n', 'q_u4tg_o', 'q_u4tg_p', 'q_u4tg_q']},
  /* u5: R · S · T · U */
  {lesson_id:'u5qa1',section:'u5',no:1,type:'qa',mode:'normal',questions:['q_u5qa1_r', 'q_u5qa1_s']},
  {lesson_id:'u5qa2',section:'u5',no:3,type:'qa',mode:'normal',questions:['q_u5qa2_t', 'q_u5qa2_u']},
  {lesson_id:'u5g1',section:'u5',no:2,type:'gesture',mode:'normal',questions:['q_u5g1_r', 'q_u5g1_s']},
  {lesson_id:'u5g2',section:'u5',no:4,type:'gesture',mode:'normal',questions:['q_u5g2_t', 'q_u5g2_u']},
  {lesson_id:'u5tqa',section:'u5',no:5,type:'qa',mode:'test',questions:['q_u5tqa_r', 'q_u5tqa_s', 'q_u5tqa_t', 'q_u5tqa_u']},
  {lesson_id:'u5tg',section:'u5',no:6,type:'gesture',mode:'test',questions:['q_u5tg_r', 'q_u5tg_s', 'q_u5tg_t', 'q_u5tg_u']},
  /* u6: V · W · X · Y */
  {lesson_id:'u6qa1',section:'u6',no:1,type:'qa',mode:'normal',questions:['q_u6qa1_v', 'q_u6qa1_w']},
  {lesson_id:'u6qa2',section:'u6',no:3,type:'qa',mode:'normal',questions:['q_u6qa2_x', 'q_u6qa2_y']},
  {lesson_id:'u6g1',section:'u6',no:2,type:'gesture',mode:'normal',questions:['q_u6g1_v', 'q_u6g1_w']},
  {lesson_id:'u6g2',section:'u6',no:4,type:'gesture',mode:'normal',questions:['q_u6g2_x', 'q_u6g2_y']},
  {lesson_id:'u6tqa',section:'u6',no:5,type:'qa',mode:'test',questions:['q_u6tqa_v', 'q_u6tqa_w', 'q_u6tqa_x', 'q_u6tqa_y']},
  {lesson_id:'u6tg',section:'u6',no:6,type:'gesture',mode:'test',questions:['q_u6tg_v', 'q_u6tg_w', 'q_u6tg_x', 'q_u6tg_y']},
  /* u7: J · Z */
  {lesson_id:'u7qa',section:'u7',no:1,type:'qa',mode:'normal',questions:['q_u7qa_j', 'q_u7qa_z']},
  {lesson_id:'u7g',section:'u7',no:2,type:'gesture',mode:'normal',questions:['q_u7g_j', 'q_u7g_z']},
  {lesson_id:'u7tqa',section:'u7',no:3,type:'qa',mode:'test',questions:['q_u7tqa_j', 'q_u7tqa_z']},
  {lesson_id:'u7tg',section:'u7',no:4,type:'gesture',mode:'test',questions:['q_u7tg_j', 'q_u7tg_z']},
];

/* ============================================================
   NEW COURSES: emotions + words (picture quizzes, Phase 1)
   ============================================================
   Generated from the SIGNS table below instead of hand-written like
   the alphabet questions. Per unit: 2 normal qa nodes (each half of
   the unit's signs, one question per sign), 2 normal camera nodes and
   1 test camera node — same 6-node layout as u1-u6. The camera nodes
   are REAL checks (sign-check.js, q.placeholder false) that use the recorded poses, one-hand and two-hand signs alike
   (Session 35). A node only becomes a "pass for now" PLACEHOLDER when FACE_LESSON_ON / TWO_HAND_LESSON_ON is switched off. XP values match the alphabet's camera nodes so the XP total
   stays valid once real checks replace them.
   Everything uses the same key == question_id rule as the alphabet.

   SIGNS: [id, Thai meaning, frames, hands]. `frames` = how many pictures the
   sign needs (1 for static signs; 2-3 for motion: start/middle/end).
   `hands` = 1 or 2: how many hands the sign needs (Session 13: happy, good,
   angry, confused are now two-handed). One-hand checks must accept either
   hand; two-hand checks need both tracked hands.
   RULE: every unit holds 4-5 signs (add a unit rather than overfill one).
   DRAFT: the sign list and frame counts are unverified ASL — confirm
   with a Deaf ASL signer, then edit this table only.
   ============================================================ */
const SIGNS={
  e1:[['happy','มีความสุข',3,2],['sad','เศร้า',3,2],['angry','โกรธ',3,2],['scared','กลัว',3,2]],
  e2:[['surprised','ประหลาดใจ',3,2],['tired','เหนื่อย',3,2],['excited','ตื่นเต้น',3,2],['bored','เบื่อ',3,1]],
  e3:[['confused','งง',3,2],['worried','กังวล',3,2],['proud','ภูมิใจ',3,1],['lonely','เหงา',3,1]],
  e4:[['jealous','อิจฉา',3,1],['shy','เขินอาย',3,1],['iloveyou','ฉันรักเธอ',1,1],['sick','ป่วย',1,2]],
  w1:[['hello','สวัสดี',3,1],['goodbye','ลาก่อน',3,1],['please','กรุณา',3,1],['thankyou','ขอบคุณ',3,1],['sorry','ขอโทษ',3,1]],
  w2:[['yes','ใช่',3,1],['no','ไม่ใช่',3,1],['you','คุณ',1,1],['me','ฉัน',1,1],['friend','เพื่อน',3,2]],
  w3:[['mother','แม่',1,1],['father','พ่อ',1,1],['boy','เด็กผู้ชาย',3,1],['girl','เด็กผู้หญิง',3,1],['family','ครอบครัว',3,2]],
  w4:[['eat','กิน',1,1],['drink','ดื่ม',3,1],['water','น้ำ',1,1],['hungry','หิว',3,1],['thirsty','กระหายน้ำ',3,1]],
  w5:[['sleep','นอน',3,1],['home','บ้าน',3,1],['bathroom','ห้องน้ำ',3,1],['need','จำเป็น',3,1],['want','อยาก',3,2]],
  w6:[['where','ที่ไหน',3,1],['who','ใคร',3,1],['why','ทำไม',3,1],['what','อะไร',1,2],['how','อย่างไร',3,2]],
  w7:[['like','ชอบ',3,1],['good','ดี',3,2],['bad','แย่',3,1],['know','รู้',3,1],['help','ช่วย',1,2]],
  w8:[['go','ไป',3,2],['come','มา',3,2],['finish','เสร็จ',3,2],['more','เพิ่ม',3,2]],
};

/* Looks up one emotion/word sign by id -> {id,th,frames,course,images[]}
   (used by app.js's info-node preview cards). */
function findSign(id){
  for(const u of UNITS){
    if(!SIGNS[u.id])continue;
    const sg=SIGNS[u.id].find(x=>x[0]===id);
    if(sg){
      const images=signPicList(u.course,id,sg[2]);
      return {id,th:sg[1],frames:sg[2],course:u.course,images};
    }
  }
  return null;
}

(function buildSignCourses(){
  function signImages(course,id,frames){return signPicList(course,id,frames);}
  // Small deterministic shuffle so choice order is stable between loads.
  function shuf(arr,seed){
    const a=arr.slice();let st=seed>>>0;
    for(let i=a.length-1;i>0;i--){st=(st*1664525+1013904223)>>>0;const j=st%(i+1);[a[i],a[j]]=[a[j],a[i]];}
    return a;
  }
  function makeQ(qid,unit,sign,pool,xp,seed){
    const [id,th,frames]=sign;
    const imgs=signImages(unit.course,id,frames);
    // 4 distractors: same unit first, then rest of the same course.
    const others=pool.filter(p=>p[0]!==id);
    const near=others.filter(p=>p.unit===unit.id),far=others.filter(p=>p.unit!==unit.id);
    const dist=[...shuf(near,seed),...shuf(far,seed+7)].slice(0,4);
    const opts=shuf([{v:th,ok:true},...dist.map(d=>({v:d[1],ok:false}))],seed+13);
    const choices=opts.map((o,i)=>({choice_id:'c'+(i+1),choice_value:o.v}));
    return {question_id:qid,question_type:'qa',question_head:'ท่ามือนี้หมายถึงอะไร?',
      question_image:imgs[0],question_images:imgs,sign:id,
      correct_answer:'c'+(opts.findIndex(o=>o.ok)+1),choices,xp};
  }
  function makeCamQ(qid,unit,sign,test){
    const [id,th,frames,hands]=sign;
    const real=(hands===1||TWO_HAND_LESSON_ON)&&(FACE_LESSON_ON||CAMERA_NEEDS_FACE.indexOf(id)<0);   // real camera check (sign-check.js) vs "skip" placeholder
    // Camera nodes show NO pictures (owner, Session 33); pic_count = how many pictures the learner saw for this
    // sign in the quiz / info cards, so the text under the camera counts steps the same way.
    const pic_count=signPicList(unit.course,id,frames).length||frames;
    return {question_id:qid,question_type:'gesture',placeholder:!real,sign:id,pic_count,
      question_head:(test?'แบบทดสอบ: ':'')+'ทำท่ามือ "'+th+'" ให้กล้องตรวจ',
      correct_answer:id,choices:[],xp:test?25:15};
  }
  UNITS.forEach((u,uIdx)=>{
    if(!SIGNS[u.id])return;
    const signs=SIGNS[u.id];
    // Distractor pool = every sign in the same course (tagged with unit id).
    const pool=[];
    UNITS.filter(x=>x.course===u.course&&SIGNS[x.id]).forEach(x=>SIGNS[x.id].forEach(sg=>{const c=sg.slice();c.unit=x.id;pool.push(c);}));
    const half=Math.ceil(signs.length/2);
    const parts=[signs.slice(0,half),signs.slice(half)];
    const qaLessons=[];
    parts.forEach((part,pi)=>{
      const qids=part.map((sg,i)=>{
        const qid='q_'+u.id+'qa'+(pi+1)+'_'+sg[0];
        QUESTIONS[qid]=makeQ(qid,u,sg,pool,10,uIdx*1000+pi*100+i);
        return qid;
      });
      LESSONS.push({lesson_id:u.id+'qa'+(pi+1),section:u.id,no:pi*2+1,type:'qa',mode:'normal',questions:qids});
    });
    parts.forEach((part,pi)=>{
      const gids=part.map(sg=>{
        const qid='q_'+u.id+'g'+(pi+1)+'_'+sg[0];
        QUESTIONS[qid]=makeCamQ(qid,u,sg,false);
        return qid;
      });
      LESSONS.push({lesson_id:u.id+'g'+(pi+1),section:u.id,no:pi*2+2,type:'gesture',mode:'normal',questions:gids});
    });
    const tq=signs.map((sg,i)=>{
      const qid='q_'+u.id+'tqa_'+sg[0];
      QUESTIONS[qid]=makeQ(qid,u,sg,pool,20,uIdx*1000+500+i);
      return qid;
    });
    LESSONS.push({lesson_id:u.id+'tqa',section:u.id,no:5,type:'qa',mode:'test',questions:tq});
    const tg=signs.map(sg=>{
      const qid='q_'+u.id+'tg_'+sg[0];
      QUESTIONS[qid]=makeCamQ(qid,u,sg,true);
      return qid;
    });
    LESSONS.push({lesson_id:u.id+'tg',section:u.id,no:6,type:'gesture',mode:'test',questions:tg});
  });
})();

/* ============================================================
   INFO NODES (auto-generated)
   ============================================================
   An 'info' node is inserted before each normal lesson that
   introduces new letters, so the player can preview them before
   being tested.

   Rules per section type:
   - u1-u6 (6-node sections; path order info1, qa1, g1, info2, qa2, g2,
     then the tests): info nodes before qa1 and qa2
     (no:1 and no:3) only — g1/g2 cover the SAME two letter-halves
     the player already saw previewed, so repeating them is noise.
   - u7 (4-node J/Z section): info node before qa (no:1) only —
     there is only one "introduce both letters" normal lesson.

   Info nodes are locked until the PREVIOUS main lesson is done
   (same gate as the normal lesson they precede). App.js checks
   this in openInfoNode() via the `pairWith` field.

   Info nodes are never marked completed. They do not gate
   progression — only their paired normal lesson does.
   ============================================================ */
(function autoInsertInfoNodes(){
  function lettersForLesson(lesson){
    const seen=new Set();
    const out=[];
    lesson.questions.forEach(qid=>{
      const q=QUESTIONS[qid];
      if(!q)return;
      let letter=null;
      if(q.sign){letter=null;}
      else if(q.question_type==='gesture'){
        letter=q.correct_answer;
      }else{
        const c=q.choices.find(c=>c.choice_id===q.correct_answer);
        letter=c?c.choice_value:null;
      }
      if(q.sign){ // emotions/words question: preview by sign id, not letter
        if(!seen.has(q.sign)){seen.add(q.sign);out.push(q.sign);}
        return;
      }
      if(letter&&!seen.has(letter)){seen.add(letter);out.push(letter);}
    });
    return out;
  }

  // How many info nodes to generate per section based on section length.
  // u1-u6: 2 (one per letter-half, before qa1 and qa2).
  // u7: 1 (only one normal qa node introducing both J and Z).
  function infoCapForSection(sectionId){
    return sectionId==='u7'?1:2;
  }

  const withInfo=[];
  const infoCountBySection={};
  LESSONS.forEach(l=>{
    if(l.mode==='normal'&&l.type==='qa'){ // info nodes only precede quiz nodes
      const cap=infoCapForSection(l.section);
      const seenSoFar=infoCountBySection[l.section]||0;
      if(seenSoFar<cap){
        withInfo.push({
          lesson_id: l.lesson_id+'_info',
          section:   l.section,
          no:        l.no,
          type:      'info',
          mode:      'info',
          pairWith:  l.lesson_id,   // used by openInfoNode() to check gate
          letters:   lettersForLesson(l),   // letters for alphabet units, sign ids for emotions/words
          course:    unitCourse(l.section),
        });
        infoCountBySection[l.section]=(seenSoFar+1);
      }
    }
    withInfo.push(l);
  });
  LESSONS.length=0;
  LESSONS.push(...withInfo);
})();
