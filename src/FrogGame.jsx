import React, { useEffect, useRef, useState, useCallback, lazy, Suspense } from 'react';
import confettiLib from 'canvas-confetti';
import { SnapDetector } from './SnapDetector';
import { BreathTracker } from './BreathTracker';
import { trackEvent } from './analytics';
import './FrogGame.css';

// three.js only loads when a rocket is launched.
const RocketFlight = lazy(() => import('./RocketFlight'));

const COLORS = [
  { name: 'Fern', rgb: [125, 161, 49], css: '#68814f' },
  { name: 'Matcha', rgb: [157, 175, 102], css: '#a6b77a' },
  { name: 'Terracotta', rgb: [189, 117, 87], css: '#c58466' }
];

// Motion helpers: easing curves and frame-rate independent damping.
const linear = (t) => t;
const easeOutCubic = (t) => 1 - Math.pow(1 - t, 3);
const easeInOutCubic = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
const damp = (current, target, lambda, dt) => target + (current - target) * Math.exp(-lambda * dt);
const lerp2 = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];

// A fold is a short timeline of stages; each stage tweens one value with its own easing.
// Step kinds: plain folds (fold, then optionally settle into an authored shape),
// `unfold` (crease and open again) and `morph` (reshape straight into the next state).
const buildFold = (step, index, start, reverse, reduced) => {
  const k = reduced ? 0.08 : 1;
  const lead = start > 0.05 ? easeOutCubic : easeInOutCubic;
  const settle = step.settle !== false;
  let stages;
  if (step.unfold) {
    stages = reverse
      ? [
          { kind: 'fold', from: 0, to: 0.4, dur: 0.26 * k, ease: easeOutCubic },
          { kind: 'fold', from: 0.4, to: 0, dur: 0.34 * k, ease: easeInOutCubic }
        ]
      : [
          { kind: 'fold', from: start, to: 0.92, dur: (0.28 + 0.42 * (1 - start)) * k, ease: lead },
          { kind: 'fold', from: 0.92, to: 0, dur: 0.62 * k, ease: easeInOutCubic }
        ];
  } else if (step.morph) {
    stages = reverse
      ? [{ kind: 'morph', from: 1, to: 0, dur: 0.75 * k, ease: easeInOutCubic }]
      : [{ kind: 'morph', from: start * MORPH_PREVIEW, to: 1, dur: (0.4 + 0.6 * (1 - start)) * k, ease: lead }];
  } else if (!reverse) {
    stages = [{ kind: 'fold', from: start, to: 1, dur: (0.3 + 0.5 * (1 - start)) * k, ease: lead }];
    if (settle) stages.push({ kind: 'settle', from: 0, to: 1, dur: 0.5 * k, ease: linear });
  } else {
    stages = [{ kind: 'fold', from: 1, to: 0, dur: 0.62 * k, ease: easeInOutCubic }];
    if (settle) stages.unshift({ kind: 'settle', from: 1, to: 0, dur: 0.42 * k, ease: linear });
  }
  return { index, stages, i: 0, t: 0, reverse };
};

// How far a drag on a morph step reshapes the paper before you let go.
const MORPH_PREVIEW = 0.5;

const foldStageValue = (fold) => {
  const st = fold.stages[fold.i];
  return { kind: st.kind, value: st.from + (st.to - st.from) * st.ease(fold.t) };
};

const P = (id, points, shade = 1) => ({
  id,
  points: points.map((p) => (p.length === 3 ? p : [...p, 0])),
  shade
});

const rect = (x1, y1, x2, y2) => [
  [x1, y1],
  [x2, y1],
  [x2, y2],
  [x1, y2]
];

const square = [P('paper', rect(-125, -125, 125, 125))];
const rectangle = [
  P('paper', rect(-63, -125, 63, 125)),
  P('fold', [[-63, -125], [63, -125], [63, 125], [-63, 125]], 1.04)
];
const base = [
  P('stem', rect(-63, -5, 63, 125), 0.92),
  P('left', [[-94, -4], [0, -116], [0, 7]], 1.08),
  P('right', [[0, -116], [94, -4], [0, 7]], 0.94)
];
const short = [
  P('stem', rect(-63, 6, 63, 71), 0.89),
  P('lip', rect(-63, 65, 63, 73), 0.77),
  ...base.slice(1)
];
const narrow = [
  P('stem', rect(-34, 7, 34, 73), 0.93),
  P('wingL', [[-63, 6], [-34, 6], [-34, 73], [-63, 65]], 0.8),
  P('wingR', [[34, 6], [63, 6], [63, 65], [34, 73]], 1.02),
  ...base.slice(1)
];
const legs = [
  P('stem', rect(-34, 7, 34, 73), 0.88),
  P('frontL', [[-94, -4], [-65, -40], [-12, 10], [-71, 20]], 1.12),
  P('frontR', [[94, -4], [65, -40], [12, 10], [71, 20]], 0.89),
  P('body', [[0, -116], [65, -40], [0, 30], [-65, -40]], 1.02)
];
const back = [
  P('rearL', [[-34, 30], [-98, 96], [-32, 90], [0, 49]], 0.82),
  P('rearR', [[34, 30], [98, 96], [32, 90], [0, 49]], 1.07),
  ...legs.slice(1)
];
const tucked = [
  ...back.slice(0, 2),
  P('spring', [[-41, 20], [41, 20], [26, 70], [-26, 70]], 0.7),
  ...legs.slice(1)
];
const frogModel = [
  P('spring', [[-38, 4, 3], [38, 4, 3], [45, 67, 4], [-45, 67, 4]], 0.66),
  P('rear-left', [[-30, 23, 8], [-86, 48, 5], [-85, 107, 1], [-37, 76, 9]], 0.88),
  P('rear-right', [[30, 23, 8], [86, 48, 5], [85, 107, 1], [37, 76, 9]], 0.93),
  P('rear-left-pleat', [[-86, 48, 5], [-85, 107, 1], [-66, 67, 13], [-37, 76, 9]], 1.02),
  P('rear-right-pleat', [[86, 48, 5], [85, 107, 1], [66, 67, 13], [37, 76, 9]], 1.06),
  P('front-left', [[-34, -49, 12], [-92, -65, 2], [-103, -9, 1], [-56, -17, 10]], 0.96),
  P('front-right', [[34, -49, 12], [92, -65, 2], [103, -9, 1], [56, -17, 10]], 0.99),
  P('front-left-fold', [[-92, -65, 2], [-80, -47, 14], [-103, -9, 1]], 1.1),
  P('front-right-fold', [[92, -65, 2], [80, -47, 14], [103, -9, 1]], 1.15),
  P('underbody', [[-41, -69, 17], [41, -69, 17], [73, 44, 20], [49, 64, 22], [-64, 61, 22]], 0.72),
  P('left-edge', [[-42, -72, 25], [-72, 52, 37], [-70, 56, 30], [-40, -69, 19]], 0.76),
  P('front-edge', [[-72, 52, 37], [49, 62, 35], [47, 66, 28], [-70, 56, 30]], 0.68),
  P('right-edge', [[42, -72, 25], [75, 40, 36], [49, 62, 35], [47, 66, 28], [72, 43, 29], [40, -69, 19]], 0.84),
  P('back', [[-42, -72, 25], [42, -72, 25], [75, 40, 36], [49, 62, 35], [-72, 52, 37]], 1.13)
];

const states = [
  square,
  rectangle,
  rectangle,
  rectangle,
  base,
  short,
  narrow,
  legs,
  back,
  tucked,
  frogModel
];

const rawSteps = [
  {
    title: 'Find the middle.',
    copy: 'Bring the left edge over to the right. A long, clean fold.',
    from: [-125, 0],
    to: [125, 0],
    crease: [[0, -125], [0, 125]],
    corners: [[-125, 0], [125, 0], [0, -125]],
    short: 'Fold the sheet in half'
  },
  {
    title: 'A corner, across.',
    copy: 'Bring the top-left corner to the opposite side. Release to crease and unfold.',
    from: [-63, -125],
    to: [63, 1],
    crease: [[-63, 1], [63, -125]],
    corners: [[-63, -125], [63, -125], [-63, 125]],
    short: 'Make the first diagonal crease'
  },
  {
    title: 'Meet in the middle.',
    copy: 'Repeat with the top-right corner. The two creases make an X.',
    from: [63, -125],
    to: [-63, 1],
    crease: [[-63, -125], [63, 1]],
    corners: [[63, -125], [-63, -125], [63, 125]],
    short: 'Make the second diagonal crease'
  },
  {
    title: 'Tuck a tiny roof.',
    copy: 'Push the left side of the X inward. The top folds into a triangle.',
    from: [-63, -62],
    to: [0, -62],
    crease: [[-63, 0], [63, 0]],
    corners: [[-63, -62], [0, -125], [63, 125]],
    short: 'Collapse the triangular base'
  },
  {
    title: 'Shorten the sheet.',
    copy: 'Lift the bottom edge up to the base of the triangle.',
    from: [0, 125],
    to: [0, 8],
    crease: [[-63, 67], [63, 67]],
    corners: [[0, 125], [-94, -4], [94, -4]],
    short: 'Bring the bottom edge up'
  },
  {
    title: 'A narrower body.',
    copy: 'Bring the side inward. Its partner follows to make a neat, narrow body.',
    from: [-63, 45],
    to: [-31, 45],
    crease: [[-47, 7], [-47, 73]],
    corners: [[-63, 45], [0, -116], [63, 45]],
    short: 'Fold the sides toward the center'
  },
  {
    title: 'Little front feet.',
    copy: 'Lift the left point outward. The other foot follows with it.',
    from: [-32, -37],
    to: [-94, 5],
    crease: [[-52, -63], [0, 10]],
    corners: [[-32, -37], [32, -37], [0, 73]],
    short: 'Open the front legs'
  },
  {
    title: 'Room for a leap.',
    copy: 'Pull the lower left corner outward to fan out the back feet.',
    from: [-34, 73],
    to: [-98, 96],
    crease: [[-34, 30], [0, 73]],
    corners: [[-34, 73], [0, -116], [34, 73]],
    short: 'Fan out the back legs'
  },
  {
    title: 'Make a spring.',
    copy: 'Fold the bottom up beneath the body. This is where the leap begins.',
    from: [0, 73],
    to: [0, 18],
    crease: [[-41, 45], [41, 45]],
    corners: [[0, 73], [-94, -4], [0, -116]],
    short: 'Fold the lower body up'
  },
  {
    title: 'One last little fold.',
    copy: 'Fold that edge back down into a pleat. Then turn your little frog over.',
    from: [0, 20],
    to: [0, 63],
    crease: [[-38, 41], [38, 41]],
    corners: [[0, 20], [0, -116], [65, -40]],
    short: 'Finish the spring and turn over'
  }
];

const steps = rawSteps.map((s, i) => {
  const n = (i + 1) % 3;
  return {
    ...s,
    unfold: i === 1 || i === 2,
    corners: [...s.corners.slice(n), ...s.corners.slice(0, n)]
  };
});

// ---------- Fold geometry (pure) ----------

const centroid = (p) => p.points.reduce((a, v) => a.map((q, i) => q + v[i] / p.points.length), [0, 0, 0]);

const clipPlane = (points, a, b, sign) => {
  const f = (p) => ((b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0])) * sign;
  const out = [];
  for (let i = 0; i < points.length; i++) {
    const cur = points[i];
    const prev = points[(i + points.length - 1) % points.length];
    const dc = f(cur);
    const dp = f(prev);
    if ((dc >= 0) !== (dp >= 0)) {
      const t = dp / (dp - dc);
      out.push(prev.map((v, k) => v + (cur[k] - v) * t));
    }
    if (dc >= 0) out.push(cur);
  }
  return out;
};

// Rotate everything on the `from` side of the crease up and over by `progress` (0 = flat, 1 = folded).
const foldPieces = (pieces, st, progress) => {
  const a = st.crease[0],
    b = st.crease[1];
  const dx = b[0] - a[0],
    dy = b[1] - a[1];
  const len = Math.hypot(dx, dy);
  const ux = dx / len,
    uy = dy / len;
  const side = Math.sign(dx * (st.from[1] - a[1]) - dy * (st.from[0] - a[0])) || 1;
  const angle = Math.PI * progress;
  const out = [];

  for (const piece of pieces) {
    const flat = clipPlane(piece.points, a, b, -side);
    const flap = clipPlane(piece.points, a, b, side);
    if (flat.length >= 3) out.push({ ...piece, id: piece.id + '-flat', points: flat });
    if (flap.length >= 3) {
      const pts = flap.map((p) => {
        const px = p[0] - a[0],
          py = p[1] - a[1];
        const along = px * ux + py * uy;
        const d = -px * uy + py * ux;
        return [
          a[0] + along * ux - uy * d * Math.cos(angle),
          a[1] + along * uy + ux * d * Math.cos(angle),
          Math.abs(d) * Math.sin(angle) + p[2] * Math.abs(Math.cos(angle))
        ];
      });
      out.push({ ...piece, id: piece.id + '-flap', points: pts });
    }
  }
  return out;
};

const samplePerimeter = (points, count) => {
  const lengths = points.map((p, i) => Math.hypot(...p.map((v, k) => v - points[(i + 1) % points.length][k])));
  const perimeter = lengths.reduce((a, b) => a + b, 0);
  return Array.from({ length: count }, (_, j) => {
    let d = (j / count) * perimeter;
    for (let i = 0; i < points.length; i++) {
      if (d <= lengths[i] || i === points.length - 1) {
        const t = lengths[i] ? d / lengths[i] : 0;
        return points[i].map((v, k) => v + (points[(i + 1) % points.length][k] - v) * t);
      }
      d -= lengths[i];
    }
  });
};

// Reshape `source` into `targets`: each target grows out of the nearest source piece.
const morphPieces = (source, targets, t) => {
  const ease = t * t * (3 - 2 * t);
  return targets.map((target) => {
    const c = centroid(target);
    const from = source.reduce((best, p) => {
      const d = centroid(p);
      const dist = Math.hypot(d[0] - c[0], d[1] - c[1]);
      return !best || dist < best.dist ? { piece: p, dist } : best;
    }, null).piece;
    const count = Math.max(from.points.length, target.points.length) * 2;
    const a = samplePerimeter(from.points, count);
    const b = samplePerimeter(target.points, count);
    return {
      ...target,
      points: a.map((p, i) => p.map((v, k) => v + (b[i][k] - v) * ease + (k === 2 ? Math.sin(t * Math.PI) * 7 : 0)))
    };
  });
};

// Fold a state flat, restacking the flap on top (a folded stack lands upside down).
const foldFlat = (pieces, st) => {
  const top = Math.max(...pieces.map((p) => Math.max(...p.points.map((q) => q[2]))));
  const folded = foldPieces(pieces, st, 1);
  const flaps = folded.filter((p) => p.id.endsWith('-flap'));
  const flapTop = Math.max(0, ...flaps.map((p) => Math.max(...p.points.map((q) => q[2]))));
  return folded.map((p) =>
    p.id.endsWith('-flap') ? { ...p, points: p.points.map((q) => [q[0], q[1], top + 1 + (flapTop - q[2])]) } : p
  );
};

// ---------- Paper rocket (classic dart) ----------
// A4-ish sheet, nose up. States are computed by actually folding the paper, so every
// fold ends exactly where the next begins; only the last step reshapes into the 3D dart.

const rocketSheet = [P('sheet', rect(-88, -125, 88, 125))];

const rocketModel = [
  P('keel-left', [[0, -125, 13], [-2, 100, 13], [-1, 100, 0], [0, -70, 4]], 0.7),
  P('keel-right', [[0, -125, 13], [0, -70, 4], [1, 100, 0], [2, 100, 13]], 0.78),
  P('wing-left', [[0, -125, 14], [-6, 100, 14], [-74, 100, 22], [-64, 58, 22]], 1.06),
  P('wing-right', [[6, 100, 14], [0, -125, 14], [64, 58, 22], [74, 100, 22]], 0.93),
  P('layer-left', [[0, -125, 14.6], [-3, 100, 14.6], [-20, 100, 14.8]], 1.12),
  P('layer-right', [[0, -125, 14.6], [20, 100, 14.8], [3, 100, 14.6]], 0.99)
];

const rocketSteps = [
  {
    title: 'Crease down the middle.',
    copy: 'Bring the left edge over to the right, then let it open. This line is the spine.',
    from: [-88, 0],
    to: [88, 0],
    crease: [[0, -125], [0, 125]],
    unfold: true,
    corners: [[0, -125], [-88, 0], [88, 125]]
  },
  {
    title: 'A corner to the spine.',
    copy: 'Fold the top-left corner down so its edge lies along the centre crease.',
    from: [-88, -125],
    to: [0, -37],
    crease: [[0, -125], [-88, -37]],
    corners: [[88, 125], [-88, 125], [-88, -125]]
  },
  {
    title: 'And the other.',
    copy: 'Same on the right. The top becomes a point: the nose.',
    from: [88, -125],
    to: [0, -37],
    crease: [[0, -125], [88, -37]],
    corners: [[88, -125], [-88, 125], [0, 125]]
  },
  {
    title: 'Sharpen the nose.',
    copy: 'Bring the new left edge in to the spine again.',
    from: [-88, -37],
    to: [0, -0.5],
    crease: [[0, -125], [-88, 87.4]],
    corners: [[0, 125], [-88, -37], [88, -37]]
  },
  {
    title: 'Both sides.',
    copy: 'Now the right edge to the spine. A long, sharp point.',
    from: [88, -37],
    to: [0, -0.5],
    crease: [[0, -125], [88, 87.4]],
    corners: [[-88, 125], [0, -125], [88, -37]]
  },
  {
    title: 'Fold it in half.',
    copy: 'Bring the left half over onto the right, along the spine.',
    from: [-88, 125],
    to: [88, 125],
    crease: [[0, -125], [0, 125]],
    corners: [[-88, 125], [88, 87.4], [0, -125]]
  },
  {
    title: 'Wings down.',
    copy: 'Fold the outer edge back past the spine. That is your wing.',
    from: [88, 125],
    to: [-38.8, 137.4],
    crease: [[0, -125], [24, 125]],
    corners: [[0, 125], [0, -125], [88, 125]]
  },
  {
    title: 'Open the wings.',
    copy: 'Pull a wing out flat. Your rocket is ready to fly.',
    from: [-38.8, 137.4],
    to: [-70, 80],
    morph: true,
    corners: [[24, 125], [-38.8, 137.4], [0, -125]]
  }
].map((st) => ({ ...st, settle: false }));

const rocketStates = rocketSteps.reduce(
  (all, st) => [...all, st.unfold ? all[all.length - 1] : st.morph ? rocketModel : foldFlat(all[all.length - 1], st)],
  [rocketSheet]
);

const PATTERNS = {
  frog: {
    name: 'frog',
    states,
    steps,
    // Earlier creases stay visible as faint lines while they still matter.
    guideLines: (step) => [
      ...(step >= 2 && step < 4 ? [[[-63, -125], [63, 1]]] : []),
      ...(step >= 3 && step < 4 ? [[[63, -125], [-63, 1]]] : [])
    ]
  },
  rocket: {
    name: 'rocket',
    states: rocketStates,
    steps: rocketSteps,
    guideLines: (step) => (step >= 1 && step <= 5 ? [[[0, -125], [0, 125]]] : [])
  }
};

const padLocations = [
  [0.5, 0.52],
  [0.28, 0.29],
  [0.72, 0.23],
  [0.79, 0.57],
  [0.52, 0.78],
  [0.2, 0.68]
];

export function FrogGame() {
  const deskCanvasRef = useRef(null);
  const worldCanvasRef = useRef(null);
  const helpDialogRef = useRef(null);
  const micDialogRef = useRef(null);

  // Game state
  const [currentColor, setCurrentColor] = useState(0);
  const [patternName, setPatternName] = useState('frog');
  const [gameMode, setGameMode] = useState('guide'); // 'guide' | 'challenge'
  const [gamePhase, setGamePhase] = useState('idle'); // 'idle' | 'folding' | 'done' | 'free'
  const [currentStep, setCurrentStep] = useState(0);
  const [score, setScore] = useState(0);
  const [showHint, setShowHint] = useState(false);
  const [soundEnabled, setSoundEnabled] = useState(false);
  const [toastText, setToastText] = useState('');
  const [showToast, setShowToast] = useState(false);
  const [freeHistoryCount, setFreeHistoryCount] = useState(0);
  const [readyForSnap, setReadyForSnap] = useState(false);
  const [micActive, setMicActive] = useState(false);
  const [micNote, setMicNote] = useState(
    'Audio stays on your device. Nothing is recorded or uploaded. You can also tap the ghost hand.'
  );
  const [micPending, setMicPending] = useState(false);
  const [worldIndex, setWorldIndex] = useState(-1);
  const [bestScore, setBestScore] = useState(0);
  const [snapKey, setSnapKey] = useState(0);
  const [isSnapping, setIsSnapping] = useState(false);
  const snapAnimTimerRef = useRef(null);
  const [flight, setFlight] = useState(null); // { tracker } while the rocket is flying
  const launchDialogRef = useRef(null);
  const snapTimerRef = useRef(null);
  const magicRef = useRef(null);

  // References for mutable game loop state
  const stateRef = useRef({
    pattern: 'frog',
    color: 0,
    mode: 'guide',
    phase: 'idle',
    step: 0,
    score: 0,
    penalty: 0,
    hintUsed: false,
    showHint: false,
    selected: 0,
    busy: false,
    W: 0,
    H: 0,
    DPR: 1,
    scale: 1,
    cx: 0,
    cy: 0,
    last: 0,
    clock: 0,
    raf: 0,
    drag: null,
    fold: null,
    hover: false,
    frog: { x: 0, y: 0, z: 0, press: 0, charging: false, start: 0, jump: null, hops: 0 },
    particles: [],
    rings: [],
    guideEpoch: 0,
    dragReleaseProgress: 0,
    pondMode: false,
    padIndex: 0,
    padBounce: 0,
    frogAngle: 0,
    preview: { step: 0, value: 0 },
    view: { factor: 1, tilt: -0.11 },
    freePieces: [],
    freeHistory: [],
    freeDrag: null,
    freeSettle: null,
    freeRelease: null,
    freeUndo: null,
    audio: null,
    sound: false,
    reduced: false,
    texture: null,
    padImage: null,
    // World / WebGL state
    world: -1,
    worldVersion: 0,
    worldRenderer: null,
    worldInstance: null,
    ripples: [],
    lastRipple: 0,
    micStream: null,
    micAudioCtx: null,
    micAnalyser: null,
    micFrame: 0,
    micGeneration: 0
  });

  const toastTimerRef = useRef(null);

  const notify = useCallback((text) => {
    setToastText(text);
    setShowToast(true);
    clearTimeout(toastTimerRef.current);
    toastTimerRef.current = setTimeout(() => setShowToast(false), 2300);
  }, []);

  const playSound = useCallback((type) => {
    const s = stateRef.current;
    if (!s.sound) return;
    try {
      s.audio = s.audio || new (window.AudioContext || window.webkitAudioContext)();
      if (s.audio.state === 'suspended') s.audio.resume();
      const gain = s.audio.createGain();
      gain.connect(s.audio.destination);
      const t = s.audio.currentTime;
      gain.gain.setValueAtTime(0.0001, t);
      gain.gain.exponentialRampToValueAtTime(type === 'fold' ? 0.045 : 0.06, t + 0.015);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.16);

      if (type === 'fold') {
        const b = s.audio.createBuffer(1, s.audio.sampleRate * 0.18, s.audio.sampleRate);
        const data = b.getChannelData(0);
        for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
        const src = s.audio.createBufferSource();
        src.buffer = b;
        const f = s.audio.createBiquadFilter();
        f.type = 'bandpass';
        f.frequency.value = 2200;
        src.connect(f);
        f.connect(gain);
        src.start();
      } else {
        const o = s.audio.createOscillator();
        o.type = 'sine';
        o.frequency.setValueAtTime(type === 'jump' ? 320 : type === 'win' ? 660 : 160, t);
        o.frequency.exponentialRampToValueAtTime(type === 'jump' ? 650 : type === 'win' ? 990 : 90, t + 0.13);
        o.connect(gain);
        o.start();
        o.stop(t + 0.18);
      }
    } catch {}
  }, []);

  // Sync state helpers
  const syncReactState = useCallback(() => {
    const s = stateRef.current;
    setGamePhase(s.phase);
    setPatternName(s.pattern);
    setGameMode(s.mode);
    setCurrentStep(s.step);
    setScore(s.score);
    setShowHint(s.showHint);
    setFreeHistoryCount(s.freeHistory.length);
  }, []);

  // Geometry & 3D Projections
  const padCenter = (index) => {
    const s = stateRef.current;
    return [padLocations[index][0] * s.W, padLocations[index][1] * s.H];
  };

  const project = (p, offset = 0) => {
    const s = stateRef.current;
    // view.factor / view.tilt ease toward their phase targets every frame (see updateView).
    const factor = s.view.factor;
    const tilt = s.view.tilt + (s.phase === 'done' ? s.frogAngle : 0);
    const x = p[0] * factor;
    const y = p[1] * factor;
    const z = (p[2] || 0) * factor + offset / s.scale;
    const persp = 1 + z / 1100;
    return [
      s.cx + (x * Math.cos(tilt) - y * Math.sin(tilt)) * s.scale * persp + s.frog.x,
      s.cy +
        (x * Math.sin(tilt) + y * Math.cos(tilt)) * 0.86 * s.scale -
        z * 0.9 * s.scale +
        s.frog.y -
        s.frog.z +
        (s.pondMode && !s.frog.jump && !s.reduced
          ? Math.sin(s.clock * 1.1 + s.padIndex * 1.7) * 2 + Math.sin(s.padBounce * Math.PI) * 4
          : 0)
    ];
  };

  // Newell's method: robust even when a clipped polygon starts with collinear corners.
  const normal = (points) => {
    if (points.length < 3) return [0, 0, 1];
    const n = [0, 0, 0];
    for (let i = 0; i < points.length; i++) {
      const a = points[i];
      const b = points[(i + 1) % points.length];
      n[0] += (a[1] - b[1]) * (a[2] + b[2]);
      n[1] += (a[2] - b[2]) * (a[0] + b[0]);
      n[2] += (a[0] - b[0]) * (a[1] + b[1]);
    }
    const len = Math.hypot(...n) || 1;
    return n.map((x) => x / len);
  };

  // The active fold pattern (frog or rocket).
  const pattern = () => PATTERNS[stateRef.current.pattern];
  const foldedPieces = (index, progress) => foldPieces(pattern().states[index], pattern().steps[index], progress);
  const settledPieces = (index, t) => morphPieces(foldedPieces(index, 1), pattern().states[index + 1], t);
  const openPieces = (index, t) => morphPieces(pattern().states[index], pattern().states[index + 1], t);

  // Free fold mode calculations
  const freePoint = (q) => {
    const s = stateRef.current;
    return [(q[0] - s.cx) / s.scale, (q[1] - s.cy) / (0.86 * s.scale)];
  };

  const freeContains = (q, poly) => {
    let inside = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const a = poly[i],
        b = poly[j];
      if (
        a[1] > q[1] !== b[1] > q[1] &&
        q[0] < ((b[0] - a[0]) * (q[1] - a[1])) / (b[1] - a[1]) + a[0]
      ) {
        inside = !inside;
      }
    }
    return inside;
  };

  const freeGeometry = (pieces, from, to, t = 1) => {
    const dx = to[0] - from[0],
      dy = to[1] - from[1];
    const len = Math.hypot(dx, dy);
    if (len < 2) return pieces;
    const nx = dx / len,
      ny = dy / len;
    const m = [(from[0] + to[0]) / 2, (from[1] + to[1]) / 2];
    const a = [m[0] - ny, m[1] + nx],
      b = [m[0] + ny, m[1] - nx];
    const side = Math.sign((b[0] - a[0]) * (from[1] - a[1]) - (b[1] - a[1]) * (from[0] - a[0]));
    const result = [];
    for (const piece of pieces) {
      const flat = clipPlane(piece.points, a, b, -side);
      const flap = clipPlane(piece.points, a, b, side);
      if (flat.length > 2) result.push({ ...piece, points: flat });
      if (flap.length > 2) {
        result.push({
          ...piece,
          points: flap.map((p) => {
            const d = (p[0] - m[0]) * nx + (p[1] - m[1]) * ny;
            return [
              p[0] - d * nx * (1 - Math.cos(Math.PI * t)),
              p[1] - d * ny * (1 - Math.cos(Math.PI * t)),
              Math.abs(d) * Math.sin(Math.PI * t) + 0.5
            ];
          })
        });
      }
    }
    return result;
  };

  // How far a held flap lifts while dragging (1 would be fully flat on the other side).
  const FREE_HOLD = 0.86;

  const freeModel = () => {
    const s = stateRef.current;
    if (s.freeUndo) {
      const u = s.freeUndo;
      return freeGeometry(u.pieces, u.from, u.to, 1 - easeInOutCubic(u.t));
    }
    if (s.freeSettle) {
      const st = s.freeSettle;
      const e = easeInOutCubic(st.t);
      return freeGeometry(s.freePieces, st.from, lerp2(st.shown, st.to, e), st.start + (1 - st.start) * e);
    }
    if (s.freeDrag) return freeGeometry(s.freePieces, s.freeDrag.from, s.freeDrag.shown, FREE_HOLD * s.freeDrag.lift);
    if (s.freeRelease) return freeGeometry(s.freePieces, s.freeRelease.from, s.freeRelease.to, FREE_HOLD * s.freeRelease.lift);
    return s.freePieces;
  };

  const freeTick = (dt) => {
    const s = stateRef.current;

    // The held flap rises gradually and its crease trails the pointer slightly, like real paper.
    if (s.freeDrag) {
      const d = s.freeDrag;
      d.lift = s.reduced ? 1 : damp(d.lift, 1, 9, dt);
      d.shown = s.reduced ? d.to : [damp(d.shown[0], d.to[0], 22, dt), damp(d.shown[1], d.to[1], 22, dt)];
    }

    // A released-but-uncommitted flap eases back down instead of popping flat.
    if (s.freeRelease) {
      s.freeRelease.lift = damp(s.freeRelease.lift, 0, 12, dt);
      if (s.reduced || s.freeRelease.lift < 0.01) s.freeRelease = null;
    }

    if (s.freeSettle) {
      const st = s.freeSettle;
      st.t = Math.min(1, st.t + dt / st.dur);
      if (st.t === 1) {
        s.freeHistory.push({ pieces: s.freePieces, from: st.from, to: st.to });
        if (s.freeHistory.length > 40) s.freeHistory.shift();
        s.freePieces = freeGeometry(s.freePieces, st.from, st.to);
        s.freeSettle = null;
        syncReactState();
        playSound('fold');
      }
    }

    if (s.freeUndo) {
      const u = s.freeUndo;
      u.t = Math.min(1, u.t + dt / (s.reduced ? 0.08 : 0.46));
      if (u.t === 1) {
        s.freePieces = u.pieces;
        s.freeUndo = null;
        syncReactState();
      }
    }
  };

  // Returns true when the fold was accepted and will animate into place.
  const freeCommit = (from, to, start = 0, shown = to) => {
    const s = stateRef.current;
    if (Math.hypot(to[0] - from[0], to[1] - from[1]) < 12) return false;
    if (s.freePieces.length > 100) {
      notify('Try undoing a fold or start a fresh sheet.');
      return false;
    }
    s.freeRelease = null;
    s.freeSettle = {
      from,
      to,
      shown,
      start,
      t: 0,
      dur: s.reduced ? 0.08 : 0.22 + 0.4 * (1 - start)
    };
    trackEvent('free_fold_made', { count: s.freeHistory.length + 1 });
    syncReactState();
    return true;
  };

  const startFree = useCallback(() => {
    const s = stateRef.current;
    s.phase = 'free';
    s.freePieces = [P('free-sheet', rect(-125, -125, 125, 125))];
    s.freeHistory = [];
    s.freeDrag = s.freeSettle = s.freeRelease = s.freeUndo = null;
    s.busy = false;
    trackEvent('free_mode_started');
    syncReactState();
    deskCanvasRef.current?.focus({ preventScroll: true });
  }, [syncReactState]);

  const undoFree = useCallback(() => {
    const s = stateRef.current;
    if (s.freeSettle || s.freeUndo || !s.freeHistory.length) return;
    const last = s.freeHistory.pop();
    s.freeDrag = s.freeRelease = null;
    // Unfold the last crease back open, then restore the earlier sheet.
    s.freeUndo = { ...last, t: 0 };
    syncReactState();
    playSound('fold');
  }, [syncReactState, playSound]);

  // Game control methods
  const start = useCallback(
    (challenge = false, patternName) => {
      const s = stateRef.current;
      if (patternName) s.pattern = patternName;
      s.phase = 'folding';
      s.mode = challenge ? 'challenge' : 'guide';
      s.step = 0;
      s.score = 0;
      s.penalty = 0;
      s.showHint = false;
      s.hintUsed = false;
      s.selected = 0;
      s.busy = false;
      s.fold = s.drag = null;
      s.preview = { step: 0, value: 0 };
      s.particles = [];
      s.frog = { x: 0, y: 0, z: 0, press: 0, charging: false, start: 0, jump: null, hops: 0 };
      s.pondMode = false;
      s.frogAngle = 0;
      document.body.classList.remove('pond-on');
      trackEvent('game_started', {
        pattern: patternName || s.pattern,
        mode: challenge ? 'challenge' : 'guide'
      });
      syncReactState();
      playSound('fold');
      deskCanvasRef.current?.focus({ preventScroll: true });
    },
    [syncReactState, playSound]
  );

  const confetti = () => {
    const s = stateRef.current;
    if (s.reduced) {
      notify('Your frog is ready!');
      return;
    }
    try {
      confettiLib({
        particleCount: 70,
        spread: 65,
        origin: { y: 0.65 },
        colors: ['#92a579', '#c6bc8c', '#dba98c', '#e1dec6', '#617f54', '#ecd599']
      });
    } catch {}
    for (let i = 0; i < 60; i++) {
      s.particles.push({
        x: s.cx + (Math.random() - 0.5) * 80,
        y: s.cy - 60,
        vx: (Math.random() - 0.5) * 310,
        vy: -100 - Math.random() * 240,
        size: 4 + Math.random() * 5,
        rot: Math.random() * 6,
        spin: (Math.random() - 0.5) * 6,
        life: 2 + Math.random() * 1.5,
        c: ['#92a579', '#c6bc8c', '#dba98c', '#e1dec6', '#617f54'][i % 5]
      });
    }
  };

  const finish = useCallback(() => {
    const s = stateRef.current;
    s.phase = 'done';
    try {
      localStorage.setItem('little-fold-completed', 'yes');
      if (s.mode === 'challenge') {
        const nextBest = Math.max(bestScore, s.score);
        setBestScore(nextBest);
        localStorage.setItem(s.pattern === 'rocket' ? 'little-fold-best-rocket' : 'little-fold-best', String(nextBest));
      }
    } catch {}
    trackEvent('game_completed', {
      pattern: s.pattern,
      mode: s.mode,
      score: s.score,
      bestScore: s.mode === 'challenge' ? Math.max(bestScore, s.score) : undefined
    });
    confetti();
    playSound('win');
    syncReactState();
    // Enable snap prompt after 5 seconds
    setTimeout(() => {
      setReadyForSnap(true);
    }, 5000);
  }, [bestScore, syncReactState, playSound]);

  const attempt = useCallback(
    (correct) => {
      const s = stateRef.current;
      if (s.busy || s.phase !== 'folding') return;
      if (!correct) {
        s.penalty = Math.min(100, s.penalty + 15);
        trackEvent('fold_step_failed', {
          pattern: s.pattern,
          step: s.step,
          mode: s.mode,
          penalty: s.penalty
        });
        notify(s.mode === 'challenge' ? 'Not quite. Try another fold. −15 points' : 'Try the marked corner. You’ve got time.');
        playSound('miss');
        return;
      }
      if (s.mode === 'challenge') s.score += Math.max(0, 100 - s.penalty);
      trackEvent('fold_step_completed', {
        pattern: s.pattern,
        step: s.step,
        mode: s.mode,
        scoreAwarded: s.mode === 'challenge' ? Math.max(0, 100 - s.penalty) : 100
      });
      s.busy = true;
      // Continue from wherever the drag left the paper so there is no jump on release.
      s.fold = buildFold(pattern().steps[s.step], s.step, s.dragReleaseProgress, false, s.reduced);
      s.dragReleaseProgress = 0;
      s.preview.value = 0;
      syncReactState();
      playSound('fold');
    },
    [notify, playSound, syncReactState]
  );

  const jump = useCallback(() => {
    const s = stateRef.current;
    if (s.frog.jump) return;
    trackEvent('frog_jumped', {
      hops: s.frog.hops + 1,
      pondMode: s.pondMode,
      power: s.frog.press
    });
    if (s.pondMode) {
      const next = (s.padIndex + 1) % padLocations.length;
      const p = padCenter(next);
      const dx = p[0] - s.cx - s.frog.x;
      const dy = p[1] - s.cy - s.frog.y;
      let angle = Math.atan2(dy, dx) + Math.PI / 2 - s.frogAngle;
      angle = Math.atan2(Math.sin(angle), Math.cos(angle));
      s.frog.jump = {
        x: s.frog.x,
        y: s.frog.y,
        dx,
        dy,
        t: 0,
        height: Math.min(115, Math.hypot(dx, dy) * 0.32),
        duration: s.reduced ? 0.15 : 0.8,
        pad: next,
        startAngle: s.frogAngle,
        angle
      };
      s.frog.hops++;
      playSound('jump');
      return;
    }
    const power = Math.max(0.15, s.frog.press);
    const hop = (65 + power * 115) * s.scale;
    const targetY = s.frog.y - hop;
    let targetX = s.frog.x + (Math.random() - 0.5) * 35 * s.scale;
    const minY = s.H * 0.23 - s.cy;
    const maxY = s.H * 0.64 - s.cy;
    const dy = targetY < minY ? Math.min(hop, maxY - s.frog.y) : -hop;
    targetX = Math.max(-s.cx + 150 * s.scale, Math.min(s.W - s.cx - 150 * s.scale, targetX));
    s.frog.jump = {
      x: s.frog.x,
      y: s.frog.y,
      dx: targetX - s.frog.x,
      dy,
      t: 0,
      height: 38 + power * 90,
      duration: s.reduced ? 0.12 : 0.48 + power * 0.2
    };
    s.frog.hops++;
    playSound('jump');
  }, [playSound]);

  // WebGL Fallback Shader for World Backgrounds
  const initFallbackShader = useCallback((canvas, scene) => {
    const gl = canvas.getContext('webgl', { alpha: false, antialias: false });
    if (!gl) {
      canvas.style.background = ['#4aa7a2', '#263d67', '#b37285'][scene];
      return { stop() {} };
    }
    const vs = 'attribute vec2 p;void main(){gl_Position=vec4(p,0.,1.);}';
    const fs = `precision mediump float;uniform vec2 res;uniform float t;uniform float scene;uniform sampler2D pond;uniform float hasPond;uniform vec4 hits[10];void main(){vec2 uv=gl_FragCoord.xy/res;vec2 p=uv*vec2(res.x/res.y,1.);float wave=0.;for(int i=0;i<10;i++){float age=t-hits[i].z;float d=length((uv-hits[i].xy)*vec2(res.x/res.y,1.));wave+=sin(d*58.-age*8.)*exp(-pow((d-age*.2)*8.,2.))*exp(-age*1.4)*step(0.,age)*hits[i].w;}p+=wave*.025;vec3 col;if(scene<.5){float a=sin(p.x*16.+sin(p.y*12.+t*.4)*2.)+sin(p.y*17.+sin(p.x*13.-t*.3)*2.);float caustic=pow(max(0.,1.-abs(a)*.38),13.);col=mix(vec3(.07,.36,.39),vec3(.28,.69,.63),uv.y)+caustic*vec3(.23,.29,.19);col+=wave*.13;if(hasPond>.5){vec2 q=uv+vec2(sin(uv.y*15.+t*.3),cos(uv.x*13.-t*.2))*.002+wave*.007;col=texture2D(pond,vec2(q.x,1.-q.y)).rgb+wave*.065;}}else if(scene<1.5){float f=sin(p.x*5.+sin(p.y*4.+t*.3))+sin(p.x*8.-p.y*3.+t*.2);float curtain=pow(max(0.,1.-abs(f)*.4),3.);col=mix(vec3(.04,.08,.17),vec3(.15,.28,.41),uv.y)+curtain*vec3(.09,.42,.24)*(1.-uv.y*.5)+wave*.08;}else{float f=.5+.25*sin(p.x*4.+sin(p.y*4.+t*.3))+ .25*sin(p.y*5.-t*.25);col=mix(vec3(.37,.17,.37),vec3(.99,.65,.39),f)+wave*.13;}gl_FragColor=vec4(col,1.);}`;

    function sh(type, src) {
      const s = gl.createShader(type);
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw Error('Fallback shader error');
      return s;
    }

    let prog;
    try {
      prog = gl.createProgram();
      gl.attachShader(prog, sh(gl.VERTEX_SHADER, vs));
      gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, fs));
      gl.linkProgram(prog);
      if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw Error('Link error');
    } catch {
      canvas.style.background = '#4aa7a2';
      return { stop() {} };
    }

    const b = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, b);
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]),
      gl.STATIC_DRAW
    );
    const loc = gl.getAttribLocation(prog, 'p');
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);

    gl.useProgram(prog);
    const u = {};
    ['res', 't', 'scene', 'hits[0]'].forEach((k) => (u[k] = gl.getUniformLocation(prog, k)));

    let dead = false;
    let animId = 0;
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.RGBA,
      1,
      1,
      0,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      new Uint8Array([40, 125, 124, 255])
    );
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    const pondLoc = gl.getUniformLocation(prog, 'pond');
    const hasPond = gl.getUniformLocation(prog, 'hasPond');
    gl.uniform1i(pondLoc, 0);

    const im = new Image();
    im.onload = () => {
      if (dead) return;
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, im);
      gl.uniform1f(hasPond, 1);
    };
    im.src = '/pond-painted.png';

    function draw(now) {
      if (dead) return;
      const renderTime = now / 1000;
      const r = canvas.getBoundingClientRect();
      const d = Math.min(window.devicePixelRatio || 1, 1.3);
      if (canvas.width !== Math.round(r.width * d) || canvas.height !== Math.round(r.height * d)) {
        canvas.width = Math.round(r.width * d);
        canvas.height = Math.round(r.height * d);
        gl.viewport(0, 0, canvas.width, canvas.height);
      }
      if (!document.hidden) {
        gl.uniform2f(u.res, canvas.width, canvas.height);
        gl.uniform1f(u.t, stateRef.current.reduced ? 0 : renderTime);
        gl.uniform1f(u.scene, scene);
        const data = Array.from({ length: 10 }, (_, i) => stateRef.current.ripples[i] || [0, 0, -100, 0]);
        gl.uniform4fv(u['hits[0]'], new Float32Array(data.flat()));
        gl.drawArrays(gl.TRIANGLES, 0, 6);
      }
      animId = requestAnimationFrame(draw);
    }
    animId = requestAnimationFrame(draw);

    return {
      stop() {
        dead = true;
        cancelAnimationFrame(animId);
        gl.deleteBuffer(b);
        gl.deleteTexture(tex);
        gl.deleteProgram(prog);
      }
    };
  }, []);

  const changeWorld = useCallback(() => {
    const s = stateRef.current;
    const nextWorld = (s.world + 1) % 3;
    s.world = nextWorld;
    setWorldIndex(nextWorld);
    document.body.classList.add('world-on');

    s.pondMode = nextWorld === 0;
    document.body.classList.toggle('pond-on', s.pondMode);
    s.frog.jump = null;
    s.frog.z = 0;
    s.frogAngle = 0;
    s.padIndex = 0;
    if (s.pondMode) {
      const p = padCenter(0);
      s.frog.x = p[0] - s.cx;
      s.frog.y = p[1] - s.cy;
    } else {
      s.frog.x = s.frog.y = 0;
    }

    if (s.worldRenderer) {
      s.worldRenderer.stop();
      s.worldRenderer = null;
    }

    if (worldCanvasRef.current) {
      worldCanvasRef.current.classList.add('active');
      s.worldRenderer = initFallbackShader(worldCanvasRef.current, nextWorld);
    }
  }, [initFallbackShader]);

  const splash = useCallback((x, y) => {
    const s = stateRef.current;
    if (s.world < 0 || s.reduced) return;
    s.ripples.unshift([x, 1 - y, performance.now() / 1000, 1]);
    s.ripples = s.ripples.slice(0, 10);
  }, []);

  // Snap gesture: change the scene and send a ripple out from the snap button.
  const snapWorld = useCallback(() => {
    changeWorld();
    trackEvent('scene_swapped', { worldIndex: stateRef.current.world });
    const r = magicRef.current?.getBoundingClientRect();
    if (r) splash((r.left + r.width / 2) / window.innerWidth, (r.top + r.height / 2) / window.innerHeight);
  }, [changeWorld, splash]);

  // Replays the hand animation and resets back to idle after snap completes
  const playSnap = useCallback(() => {
    setSnapKey((k) => k + 1);
    setIsSnapping(true);
    clearTimeout(snapAnimTimerRef.current);
    snapAnimTimerRef.current = setTimeout(() => {
      setIsSnapping(false);
    }, 750);
  }, []);

  // When clicked, open the microphone popup to enable mic listening;
  // Scene change and hand snap ONLY trigger when an actual snap sound is heard by the microphone!
  const handleSnapTap = useCallback(() => {
    trackEvent('snap_button_clicked', { micActive });
    micDialogRef.current?.showModal();
  }, [micActive]);

  useEffect(() => () => {
    clearTimeout(snapTimerRef.current);
    clearTimeout(snapAnimTimerRef.current);
  }, []);

  // Microphone snap listener
  const stopMic = useCallback(() => {
    const s = stateRef.current;
    s.micGeneration++;
    s.micPending = false;
    cancelAnimationFrame(s.micFrame);
    s.micStream?.getTracks().forEach((t) => t.stop());
    s.micStream = null;
    s.micAudioCtx?.close().catch(() => {});
    s.micAudioCtx = null;
    s.micAnalyser = null;
    setMicActive(false);
    setMicPending(false);
    setMicNote('Microphone off. Sound stays on your device.');
    trackEvent('mic_toggled', { enabled: false });
  }, []);

  const startMic = useCallback(async () => {
    const s = stateRef.current;
    if (s.micStream || s.micPending) return;
    if (!navigator.mediaDevices?.getUserMedia) {
      setMicNote('Microphone unavailable here. Tap for magic instead.');
      return;
    }
    const ticket = ++s.micGeneration;
    s.micPending = true;
    setMicPending(true);
    setMicNote('Waiting for permission…');

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
        video: false
      });
      if (ticket !== s.micGeneration) {
        stream.getTracks().forEach((t) => t.stop());
        return;
      }
      s.micStream = stream;
      s.micAudioCtx = new AudioContext();
      await s.micAudioCtx.resume();
      if (ticket !== s.micGeneration) {
        stream.getTracks().forEach((t) => t.stop());
        return;
      }
      s.micAnalyser = s.micAudioCtx.createAnalyser();
      s.micAnalyser.fftSize = 1024;
      s.micAudioCtx.createMediaStreamSource(stream).connect(s.micAnalyser);

      const data = new Float32Array(s.micAnalyser.fftSize);
      const freq = new Uint8Array(s.micAnalyser.frequencyBinCount);
      const detector = new SnapDetector();

      setMicActive(true);
      trackEvent('mic_toggled', { enabled: true });
      micDialogRef.current?.close();
      setMicNote('Listening · snap near your microphone');

      function listen(now) {
        if (!s.micAnalyser) return;
        s.micAnalyser.getFloatTimeDomainData(data);
        s.micAnalyser.getByteFrequencyData(freq);
        let sum = 0,
          peak = 0,
          hi = 0,
          total = 0;
        for (const v of data) {
          sum += v * v;
          peak = Math.max(peak, Math.abs(v));
        }
        freq.forEach((v, i) => {
          total += v;
          if (i > freq.length * 0.13) hi += v;
        });
        if (detector.sample(Math.sqrt(sum / data.length), peak, hi / Math.max(1, total), now)) {
          // The real snap already happened; echo it on the hand and change the world immediately.
          playSnap();
          snapWorld();
        }
        s.micFrame = requestAnimationFrame(listen);
      }
      s.micFrame = requestAnimationFrame(listen);
    } catch {
      if (ticket === s.micGeneration) {
        stopMic();
        setMicNote('Microphone not enabled. Tap for magic still works.');
      }
    } finally {
      if (ticket === s.micGeneration) {
        s.micPending = false;
        setMicPending(false);
      }
    }
  }, [playSnap, snapWorld, stopMic]);

  // Main Canvas Rendering and Game Loop
  useEffect(() => {
    const canvas = deskCanvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const s = stateRef.current;

    s.reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    // Grain texture setup
    const grain = document.createElement('canvas');
    grain.width = grain.height = 256;
    const gc = grain.getContext('2d');
    const g = gc.createImageData(256, 256);
    let rng = 731;
    function rand() {
      rng = (rng * 1664525 + 1013904223) >>> 0;
      return rng / 4294967296;
    }
    for (let i = 0; i < g.data.length; i += 4) {
      const v = rand() * 255;
      g.data[i] = g.data[i + 1] = g.data[i + 2] = v;
      g.data[i + 3] = 23 + rand() * 28;
    }
    gc.putImageData(g, 0, 0);
    s.texture = ctx.createPattern(grain, 'repeat');

    // Lily pad image
    const padImg = new Image();
    padImg.src = '/lily-pad.png';
    s.padImage = padImg;

    function resize() {
      const r = canvas.getBoundingClientRect();
      s.W = r.width;
      s.H = r.height;
      s.DPR = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = s.W * s.DPR;
      canvas.height = s.H * s.DPR;
      ctx.setTransform(s.DPR, 0, 0, s.DPR, 0, 0);
      s.scale = Math.min(s.W / 440, s.H / 500, 2.1);
      s.cx = s.W * 0.5;
      s.cy = s.H * 0.47;
      if (s.pondMode && !s.frog.jump) {
        const p = padCenter(s.padIndex);
        s.frog.x = p[0] - s.cx;
        s.frog.y = p[1] - s.cy;
      }
    }
    resize();

    const resizeObserver = new ResizeObserver(resize);
    resizeObserver.observe(canvas);

    function path(points, offset = 0) {
      ctx.beginPath();
      points.forEach((p, i) => {
        const q = project(p, offset);
        i ? ctx.lineTo(...q) : ctx.moveTo(...q);
      });
      ctx.closePath();
    }

    function drawPiece(piece, alpha = 1, offset = 0) {
      if (piece.points.length < 3) return;
      ctx.save();
      ctx.globalAlpha = alpha;
      const n = normal(piece.points);
      const backFace = n[2] < -0.05;
      const light = 0.69 + 0.31 * Math.abs(n[2]) + 0.18 * n[0] + 0.15 * n[1];
      const rgb = COLORS[s.color].rgb.map((v) => (backFace ? v * 0.64 + 91 : v));
      const shade = piece.shade * light;

      path(piece.points, offset);
      const gradient = ctx.createLinearGradient(
        s.cx - 130 * s.scale,
        s.cy - 170 * s.scale,
        s.cx + 120 * s.scale,
        s.cy + 150 * s.scale
      );
      gradient.addColorStop(0, `rgb(${rgb.map((v) => Math.min(255, v * shade * 1.1 + 4)).join(',')})`);
      gradient.addColorStop(1, `rgb(${rgb.map((v) => v * shade * 0.91).join(',')})`);
      ctx.fillStyle = gradient;
      ctx.fill();
      ctx.clip();
      ctx.globalCompositeOperation = 'soft-light';
      ctx.fillStyle = s.texture;
      ctx.fillRect(0, 0, s.W, s.H);
      ctx.globalCompositeOperation = 'source-over';
      ctx.restore();

      ctx.save();
      path(piece.points, offset);
      ctx.strokeStyle = backFace ? '#f2ecdba8' : '#dae8c67a';
      ctx.lineWidth = 0.65;
      ctx.stroke();
      ctx.translate(0.3, 1);
      path(piece.points, offset);
      ctx.strokeStyle = '#36472833';
      ctx.lineWidth = 0.55;
      ctx.stroke();
      ctx.restore();
    }

    function pieceShadow(piece) {
      const height = Math.max(0, piece.points.reduce((v, p) => v + p[2], 0) / piece.points.length);
      ctx.save();
      ctx.beginPath();
      piece.points.forEach((p, i) => {
        const q = project([
          p[0] + p[2] * 0.3 + (s.frog.z / s.scale) * 0.2,
          p[1] + p[2] * 0.38 + (s.frog.z / s.scale) * 0.25,
          0
        ]);
        q[1] += s.frog.z;
        i ? ctx.lineTo(...q) : ctx.moveTo(...q);
      });
      ctx.closePath();
      ctx.shadowColor = `rgba(37,28,12,${Math.max(0.06, 0.21 - height / 1300)})`;
      ctx.shadowBlur = (3 + height * 0.27 + s.frog.z * 0.18) * s.scale;
      ctx.shadowOffsetX = 5 * s.scale;
      ctx.shadowOffsetY = 8 * s.scale;
      ctx.fillStyle = `rgba(48,37,18,${Math.max(0.018, 0.11 - height / 1600 - s.frog.z / 2000)})`;
      ctx.fill();
      ctx.restore();
    }

    function line(a, b, alpha = 0.22) {
      ctx.save();
      ctx.beginPath();
      ctx.moveTo(...project(a));
      ctx.lineTo(...project(b));
      ctx.strokeStyle = `rgba(32,58,25,${alpha})`;
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.translate(0, 1);
      ctx.strokeStyle = `rgba(245,255,219,${alpha})`;
      ctx.stroke();
      ctx.restore();
    }

    function circle(p, r, fill, stroke) {
      ctx.beginPath();
      ctx.arc(p[0], p[1], r, 0, Math.PI * 2);
      if (fill) {
        ctx.fillStyle = fill;
        ctx.fill();
      }
      if (stroke) {
        ctx.strokeStyle = stroke;
        ctx.lineWidth = 1.2;
        ctx.stroke();
      }
    }

    function hand(q, alpha = 1) {
      ctx.save();
      ctx.translate(q[0], q[1]);
      ctx.scale(1.1, 1.1);
      ctx.globalAlpha = alpha;
      ctx.shadowColor = '#44351e40';
      ctx.shadowBlur = 5;
      ctx.shadowOffsetY = 3;
      ctx.fillStyle = '#fff8de';
      ctx.strokeStyle = '#665239';
      ctx.lineWidth = 1.3;
      const p = new Path2D(
        'M 0 17 L -8 5 Q -11 0 -7 -2 Q -4 -3 -1 2 L 0 4 L 0 -16 Q 0 -22 5 -22 Q 10 -22 10 -16 L 10 -4 Q 14 -8 18 -4 Q 22 -7 26 -2 Q 32 -3 32 3 L 31 19 Q 30 26 23 29 L 9 29 Q 3 24 0 17 Z'
      );
      ctx.fill(p);
      ctx.stroke(p);
      ctx.restore();
    }

    function drawPads() {
      if (!s.pondMode) return;
      const radius = Math.min(s.W * 0.125, s.H * 0.125, 92);
      padLocations.forEach((p, i) => {
        const q = padCenter(i);
        const bob = s.reduced ? 0 : Math.sin(s.clock * 1.1 + i * 1.7) * 2;
        const compression = i === s.padIndex ? Math.sin(s.padBounce * Math.PI) * 4 : 0;
        ctx.save();
        ctx.translate(q[0], q[1] + bob + compression);
        ctx.rotate([ -0.3, 1.2, 0.6, 2.5, -0.8, 1.8 ][i]);
        ctx.shadowColor = '#073b3860';
        ctx.shadowBlur = 14;
        ctx.shadowOffsetY = 7;
        if (s.padImage && s.padImage.complete && s.padImage.naturalWidth) {
          ctx.drawImage(s.padImage, -radius, -radius, radius * 2, radius * 2);
        } else {
          ctx.beginPath();
          ctx.arc(0, 0, radius * 0.9, 0.25, Math.PI * 2 - 0.25);
          ctx.lineTo(0, 0);
          ctx.fillStyle = '#72a15b';
          ctx.fill();
        }
        ctx.restore();
      });
    }

    function drawModel() {
      let model;
      let fading = null; // the old shape, cross-fading out under a morph
      const previewing = s.phase === 'folding' && !s.fold && s.preview.value > 0;
      if (s.phase === 'free') {
        model = freeModel();
      } else if (s.fold) {
        const { kind, value } = foldStageValue(s.fold);
        if (kind === 'morph') {
          fading = { pieces: pattern().states[s.fold.index], alpha: 1 - Math.min(1, value / 0.45) };
          model = openPieces(s.fold.index, value);
        } else {
          model = kind === 'settle' ? settledPieces(s.fold.index, value) : foldedPieces(s.fold.index, value);
        }
      } else if (previewing) {
        const st = pattern().steps[s.step];
        if (st.morph) {
          const value = s.preview.value * MORPH_PREVIEW;
          fading = { pieces: pattern().states[s.step], alpha: 1 - Math.min(1, value / 0.45) };
          model = openPieces(s.step, value);
        } else {
          model = foldedPieces(s.step, s.preview.value);
        }
      } else {
        const p = pattern();
        model = p.states[s.phase === 'idle' ? 0 : s.phase === 'done' ? p.steps.length : s.step];
      }

      model = model.map((p) =>
        s.phase === 'done' && s.frog.press > 0
          ? {
              ...p,
              points: p.points.map((q) => [
                q[0] * (1 + s.frog.press * 0.04),
                q[1],
                q[2] * (1 - s.frog.press * 0.7)
              ])
            }
          : p
      );

      model.forEach(pieceShadow);
      if (fading && fading.alpha > 0) {
        [...fading.pieces].sort((a, b) => centroid(a)[2] - centroid(b)[2]).forEach((p) => drawPiece(p, fading.alpha));
      }
      model.sort((a, b) => centroid(a)[2] - centroid(b)[2]);
      model.forEach((p) => drawPiece(p));

      if (s.phase === 'folding' && !s.fold && !previewing) {
        pattern().guideLines(s.step).forEach(([a, b]) => line(a, b, 0.23));
      }
      if (s.phase === 'folding' && (s.fold || previewing)) {
        const st = pattern().steps[s.fold ? s.fold.index : s.step];
        if (st.crease) line(st.crease[0], st.crease[1], 0.33);
      }
    }

    function guides() {
      if (s.phase === 'idle') {
        const q = project([25, 40]);
        hand([q[0], q[1] + (s.reduced ? 0 : Math.sin(s.clock * 2) * 6)], 0.85);
        return;
      }
      if (s.phase !== 'folding' || s.busy) return;
      const st = pattern().steps[s.step];
      const visible = s.mode === 'guide' || s.showHint;
      if (visible) {
        const a = project(st.from),
          b = project(st.to);
        const dx = b[0] - a[0],
          dy = b[1] - a[1];
        const length = Math.max(1, Math.hypot(dx, dy));
        const ux = dx / length,
          uy = dy / length;
        const radius = Math.min(21, length * 0.21);
        const end = [b[0] - ux * (radius + 5), b[1] - uy * (radius + 5)];

        ctx.save();
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        for (const [width, ink] of [
          [6, '#29432180'],
          [3, '#fffce8']
        ]) {
          ctx.setLineDash([1, 10]);
          ctx.lineWidth = width;
          ctx.strokeStyle = ink;
          ctx.beginPath();
          ctx.moveTo(a[0] + ux * (radius + 5), a[1] + uy * (radius + 5));
          ctx.lineTo(...end);
          ctx.stroke();
        }
        ctx.setLineDash([]);
        ctx.strokeStyle = '#fffce8';
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.moveTo(end[0] - ux * 10 - uy * 6, end[1] - uy * 10 + ux * 6);
        ctx.lineTo(...end);
        ctx.lineTo(end[0] - ux * 10 + uy * 6, end[1] - uy * 10 - ux * 6);
        ctx.stroke();

        circle(b, radius, '#30462833', '#fffce8');
        circle(b, 4, '#fffce8');
        const pulse = s.reduced ? 0 : Math.sin((s.clock - s.guideEpoch) * 3) * 2;
        circle(a, radius + pulse, '#fffce83d', '#fffce8');
        circle(a, 8, '#fffce8');

        if (!s.drag) {
          const cycle = Math.max(0, s.clock - s.guideEpoch) % 3.6;
          const f = s.reduced ? 0 : Math.max(0, Math.min(1, (cycle - 0.65) / 1.65));
          const eased = f * f * (3 - 2 * f);
          const opacity = cycle > 2.65 ? Math.max(0, 1 - (cycle - 2.65) / 0.5) : 0.94;
          hand([a[0] + dx * eased - 5, a[1] + dy * eased + 20], s.reduced ? 0.94 : opacity);
        }
        ctx.restore();
      } else {
        st.corners.forEach((p, i) => {
          const q = project(p);
          const active = s.selected === i;
          circle(q, active ? 23 : 17, '#fff7cb55', active ? '#fffde5' : '#edf6d799');
          circle(q, 6, '#fffce4');
          ctx.fillStyle = '#526343';
          ctx.font = '13px "Jost Variable", Arial, sans-serif';
          ctx.fillText(String(i + 1), q[0] + 24, q[1] + 4);
        });
      }

      const total = pattern().steps.length;
      for (let i = 0; i < total; i++) {
        circle([s.W / 2 + (i - (total - 1) / 2) * 15, s.H * 0.88], i === s.step ? 4 : 2.5, i < s.step ? '#668142' : i === s.step ? '#fff6d3' : '#66533b44');
      }
    }

    function frame(now) {
      const dt = s.last ? Math.min((now - s.last) / 1000, 0.04) : 0;
      s.last = now;
      s.clock += dt;

      if (s.phase === 'free') freeTick(dt);

      if (s.fold) {
        const f = s.fold;
        f.t = Math.min(1, f.t + dt / Math.max(0.001, f.stages[f.i].dur));
        if (f.t === 1 && f.i < f.stages.length - 1) {
          f.i++;
          f.t = 0;
        } else if (f.t === 1 && f.reverse) {
          s.fold = null;
          s.busy = false;
          syncReactState();
        } else if (f.t === 1) {
          s.fold = null;
          s.busy = false;
          s.step++;
          s.penalty = 0;
          s.hintUsed = false;
          s.showHint = false;
          s.selected = 0;
          try {
            navigator.vibrate?.(8);
          } catch {}
          if (s.step === pattern().steps.length) finish();
          else syncReactState();
        }
      }

      // The drag preview follows the pointer with a little weight, and springs back when let go.
      const pv = s.preview;
      if (pv.step !== s.step) {
        pv.step = s.step;
        pv.value = 0;
      }
      const previewTarget =
        s.phase === 'folding' && !s.fold && s.drag && s.drag.correct ? Math.min(0.94, s.drag.progress) : 0;
      pv.value = s.reduced ? previewTarget : damp(pv.value, previewTarget, previewTarget > pv.value ? 18 : 10, dt);
      if (pv.value < 0.002) pv.value = 0;

      // Ease the overall paper scale/tilt between phases instead of snapping (e.g. when the frog finishes).
      const rocketDone = s.phase === 'done' && s.pattern === 'rocket';
      const viewFactor = s.phase === 'done' ? (s.pondMode ? 0.46 : rocketDone ? 0.92 : 0.7) : 1;
      // A finished rocket swings round to a launch angle, nose up and to the right.
      const viewTilt = s.phase === 'folding' || s.phase === 'idle' ? -0.11 : rocketDone ? 0.55 : 0;
      s.view.factor = s.reduced ? viewFactor : damp(s.view.factor, viewFactor, 5, dt);
      s.view.tilt = s.reduced ? viewTilt : damp(s.view.tilt, viewTilt, 5, dt);

      if (s.frog.charging) {
        s.frog.press = Math.min(1, (now - s.frog.start) / 900);
      } else {
        s.frog.press = Math.max(0, s.frog.press - dt * 5);
      }

      s.padBounce = Math.max(0, s.padBounce - dt * 2.8);

      if (s.frog.jump) {
        const j = s.frog.jump;
        j.t += dt;
        const t = Math.min(1, j.t / j.duration);
        const eased = t * t * (3 - 2 * t);
        s.frog.x = j.x + j.dx * eased;
        s.frog.y = j.y + j.dy * eased;
        s.frog.z = s.reduced ? 0 : Math.sin(t * Math.PI) * j.height;
        if (j.angle !== undefined) {
          s.frogAngle = j.startAngle + j.angle * Math.min(1, t * 2);
        }
        if (t === 1) {
          if (j.pad !== undefined) {
            s.padIndex = j.pad;
            s.padBounce = 1;
          }
          s.frog.jump = null;
          s.frog.z = 0;
          s.rings.push({ x: s.cx + s.frog.x, y: s.cy + s.frog.y, t: 0 });
          playSound('land');
          splash((s.cx + s.frog.x) / s.W, (s.cy + s.frog.y) / s.H);
        }
      }

      ctx.clearRect(0, 0, s.W, s.H);

      s.rings = s.rings.filter((r) => r.t < 0.7);
      s.rings.forEach((r) => {
        r.t += dt;
        ctx.save();
        ctx.globalAlpha = (1 - r.t / 0.7) * 0.25;
        ctx.strokeStyle = '#7e8f63';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.ellipse(r.x, r.y, 40 + r.t * 95, 15 + r.t * 35, 0, 0, Math.PI * 2);
        ctx.stroke();
        ctx.restore();
      });

      drawPads();
      drawModel();
      guides();

      if (s.frog.charging) {
        const q = project([0, 95]);
        ctx.beginPath();
        ctx.arc(q[0], q[1] + 27, 13, -Math.PI / 2, -Math.PI / 2 + s.frog.press * Math.PI * 2);
        ctx.strokeStyle = '#7b9061';
        ctx.lineWidth = 2;
        ctx.stroke();
      }

      s.particles = s.particles.filter((p) => p.life > 0);
      s.particles.forEach((p) => {
        p.life -= dt;
        p.x += p.vx * dt;
        p.y += p.vy * dt;
        p.vy += 135 * dt;
        p.rot += p.spin * dt;
        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.rotate(p.rot);
        ctx.globalAlpha = Math.min(1, p.life);
        ctx.fillStyle = p.c;
        ctx.fillRect(-p.size / 2, -p.size / 2, p.size, p.size * 0.45);
        ctx.restore();
      });

      s.raf = requestAnimationFrame(frame);
    }

    s.raf = requestAnimationFrame(frame);

    return () => {
      cancelAnimationFrame(s.raf);
      resizeObserver.disconnect();
    };
  }, [finish, playSound, splash, syncReactState]);

  // Pointer & Touch Events
  const local = (e) => {
    const r = deskCanvasRef.current.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  };

  const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);

  const hitPaper = (q) => {
    const s = stateRef.current;
    return (
      dist(q, [s.cx + s.frog.x, s.cy + s.frog.y]) <
      (s.phase === 'done' ? (s.pondMode ? 58 : 110) : 155) * s.scale
    );
  };

  const handlePointerDown = (e) => {
    const s = stateRef.current;
    const q = local(e);

    if (s.phase === 'free') {
      if (s.freeSettle || s.freeUndo) return;
      const fq = freePoint(q);
      if (!s.freePieces.some((p) => freeContains(fq, p.points))) return;
      s.freeRelease = null;
      s.freeDrag = { from: fq, to: fq, shown: fq, lift: 0 };
      deskCanvasRef.current?.focus({ preventScroll: true });
      deskCanvasRef.current?.setPointerCapture(e.pointerId);
      return;
    }

    if (s.phase === 'idle') {
      if (hitPaper(q)) start(false);
      return;
    }
    if (s.busy) return;
    deskCanvasRef.current?.focus({ preventScroll: true });

    if (s.phase === 'done' && s.pattern === 'rocket') {
      if (hitPaper(q)) launchDialogRef.current?.showModal();
      return;
    }
    if (s.phase === 'done') {
      if (!s.frog.jump && hitPaper(q)) {
        s.frog.charging = true;
        s.frog.start = performance.now();
        deskCanvasRef.current?.setPointerCapture(e.pointerId);
      }
      return;
    }

    const st = pattern().steps[s.step];
    const choices = s.mode === 'guide' || s.showHint ? [st.from] : st.corners;
    const index = choices.findIndex((p) => dist(project(p), q) < Math.max(48, 35 * s.scale));
    if (index < 0) {
      notify(s.mode === 'guide' ? 'Start at the white ring.' : 'Pick one of the three corners.');
      return;
    }
    const from = choices[index];
    s.drag = {
      x: q[0],
      y: q[1],
      from,
      correct: dist(from, st.from) < 1,
      progress: 0,
      startX: q[0],
      startY: q[1]
    };
    deskCanvasRef.current?.setPointerCapture(e.pointerId);
  };

  const handlePointerMove = (e) => {
    const s = stateRef.current;
    const q = local(e);

    if (s.world >= 0 && performance.now() - s.lastRipple > 65) {
      splash(e.clientX / window.innerWidth, e.clientY / window.innerHeight);
      s.lastRipple = performance.now();
    }

    if (s.phase === 'free') {
      if (s.freeDrag) {
        const fq = freePoint(q);
        s.freeDrag.to = [Math.max(-170, Math.min(170, fq[0])), Math.max(-170, Math.min(170, fq[1]))];
      }
      return;
    }

    s.hover = hitPaper(q);
    if (deskCanvasRef.current) {
      deskCanvasRef.current.style.cursor =
        s.drag || s.frog.charging ? 'grabbing' : s.hover ? 'grab' : 'default';
    }
    if (s.drag) {
      s.drag.x = q[0];
      s.drag.y = q[1];
      const a = project(s.drag.from);
      const b = project(pattern().steps[s.step].to);
      const length = Math.max(1, dist(a, b));
      s.drag.progress = Math.max(
        0,
        Math.min(
          1,
          ((q[0] - a[0]) * (b[0] - a[0]) + (q[1] - a[1]) * (b[1] - a[1])) / (length * length)
        )
      );
    }
  };

  const pointerEnd = (e, cancel = false) => {
    const s = stateRef.current;

    if (s.phase === 'free') {
      if (!s.freeDrag) return;
      const d = s.freeDrag;
      s.freeDrag = null;
      const committed = !cancel && e.type === 'pointerup' && freeCommit(d.from, d.to, FREE_HOLD * d.lift, d.shown);
      if (!committed) s.freeRelease = { from: d.from, to: d.shown, lift: d.lift };
      return;
    }

    if (s.frog.charging) {
      s.frog.charging = false;
      if (!cancel) jump();
      return;
    }
    if (!s.drag) return;
    const d = s.drag;
    s.drag = null;
    if (cancel) return;

    const q = local(e);
    const tapped = dist(q, [d.startX, d.startY]) < 14;
    const assisted = s.mode === 'guide' || s.showHint;
    // Carrying the corner most of the way is enough; the fold finishes itself from there.
    const correct =
      d.correct &&
      ((assisted && tapped) ||
        d.progress > 0.6 ||
        (dist(q, project(pattern().steps[s.step].to)) < Math.max(60, 40 * s.scale) && d.progress > 0.35));
    if (d.correct && !correct) {
      // Right corner, just not far enough: let the paper ease back down, no penalty.
      notify(tapped ? 'Drag the corner to fold it.' : 'Almost — carry it a little further.');
      return;
    }
    s.dragReleaseProgress = correct ? Math.min(0.94, s.preview.value) : 0;
    attempt(correct);
  };

  const handleKeyDown = (e) => {
    const s = stateRef.current;
    if (['ArrowLeft', 'ArrowRight', 'Enter', ' '].includes(e.key)) e.preventDefault();
    if (e.repeat && e.key === ' ') return;

    if (s.phase === 'free') {
      if (e.key === 'Escape' && s.freeDrag) {
        s.freeRelease = { from: s.freeDrag.from, to: s.freeDrag.shown, lift: s.freeDrag.lift };
        s.freeDrag = null;
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        undoFree();
      }
      return;
    }

    if (s.phase === 'idle' && e.key === 'Enter') {
      start(false);
      return;
    }
    if (s.phase === 'done' && s.pattern === 'rocket') {
      if (e.key === 'Enter' || e.key === ' ') launchDialogRef.current?.showModal();
      return;
    }
    if (s.phase === 'done' && e.key === ' ' && !s.frog.jump) {
      s.frog.charging = true;
      s.frog.start = performance.now();
      return;
    }
    if (s.phase !== 'folding' || s.busy) return;
    if (e.key === 'ArrowRight') s.selected = (s.selected + 1) % 3;
    if (e.key === 'ArrowLeft') s.selected = (s.selected + 2) % 3;
    if (e.key === 'Enter') {
      attempt(
        s.mode === 'guide' ||
          s.showHint ||
          dist(pattern().steps[s.step].corners[s.selected], pattern().steps[s.step].from) < 1
      );
    }
  };

  const handleKeyUp = (e) => {
    const s = stateRef.current;
    if (e.key === ' ' && s.frog.charging) {
      e.preventDefault();
      s.frog.charging = false;
      jump();
    }
  };

  const handleColorChange = (idx) => {
    setCurrentColor(idx);
    stateRef.current.color = idx;
    trackEvent('paper_color_changed', { color: COLORS[idx]?.name });
  };

  const handleSoundToggle = () => {
    const next = !soundEnabled;
    setSoundEnabled(next);
    stateRef.current.sound = next;
    trackEvent('sound_toggled', { enabled: next });
    notify(next ? 'Paper sounds on' : 'Paper sounds off');
    if (next) playSound('fold');
  };

  const handleUndo = () => {
    const s = stateRef.current;
    trackEvent('fold_undone', { phase: s.phase, step: s.step });
    if (s.phase === 'free') {
      undoFree();
      return;
    }
    if (s.step > 0 && s.mode === 'guide' && !s.busy) {
      s.step--;
      s.penalty = 0;
      s.showHint = false;
      s.selected = 0;
      s.drag = null;
      // Play the previous fold backwards rather than jumping to the old shape.
      s.busy = true;
      s.fold = buildFold(pattern().steps[s.step], s.step, 0, true, s.reduced);
      syncReactState();
      playSound('fold');
    }
  };

  const handleRestart = () => {
    trackEvent('game_restarted', { phase: stateRef.current.phase });
    if (stateRef.current.phase === 'free') startFree();
    else start(false);
  };

  const handleRecenter = () => {
    trackEvent('frog_recentered');
    const s = stateRef.current;
    s.frog.x = s.frog.y = s.frog.z = 0;
    s.frog.jump = null;
    s.frog.charging = false;
  };

  const handleFoldInHalf = () => {
    const s = stateRef.current;
    if (!s.freeSettle && !s.freeUndo) {
      s.freeDrag = s.freeRelease = null;
      const xs = s.freePieces.flatMap((p) => p.points.map((q) => q[0]));
      const ys = s.freePieces.flatMap((p) => p.points.map((q) => q[1]));
      const left = Math.min(...xs),
        right = Math.max(...xs),
        y = (Math.min(...ys) + Math.max(...ys)) / 2;
      freeCommit([left, y], [right, y]);
    }
  };

  // Rocket launch: camera + mic (blow to fly, turn your head to steer) or a hold-to-blow button.
  const launchRocket = (useCamera) => {
    trackEvent('rocket_launch_started', { useCamera });
    launchDialogRef.current?.close();
    const tracker = new BreathTracker();
    if (useCamera) tracker.start(); // started inside the click so audio is allowed to play
    setFlight({ tracker });
  };

  const endFlight = useCallback(() => {
    setFlight(null);
    deskCanvasRef.current?.focus({ preventScroll: true });
  }, []);

  // Whenever a flight ends (or the page unmounts), release the camera and mic.
  useEffect(() => () => flight?.tracker.stop(), [flight]);

  const revealHint = () => {
    const s = stateRef.current;
    if (s.phase !== 'folding' || s.mode !== 'challenge' || s.showHint || s.busy) return;
    trackEvent('hint_requested', { pattern: s.pattern, step: s.step, penalty: s.penalty + 25 });
    s.showHint = true;
    s.hintUsed = true;
    s.penalty = Math.min(100, s.penalty + 25);
    syncReactState();
  };

  return (
    <main>
      <section id="table" className="table" aria-label="Origami worktable">
        <canvas id="world" ref={worldCanvasRef} aria-hidden="true"></canvas>
        <canvas
          id="desk"
          ref={deskCanvasRef}
          tabIndex={0}
          aria-label="Paper. Click to begin. Drag the marked corner to its destination to fold. Arrow keys choose a corner; Enter completes the fold. Hold Space and release to jump the finished frog."
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={(e) => pointerEnd(e)}
          onPointerCancel={(e) => pointerEnd(e, true)}
          onLostPointerCapture={() => {
            stateRef.current.drag = null;
            if (stateRef.current.frog.charging) {
              stateRef.current.frog.charging = false;
              stateRef.current.frog.press = 0;
            }
          }}
          onKeyDown={handleKeyDown}
          onKeyUp={handleKeyUp}
          onBlur={() => {
            stateRef.current.frog.charging = false;
            stateRef.current.frog.press = 0;
            stateRef.current.drag = null;
            stateRef.current.freeDrag = null;
          }}
        ></canvas>

        {/* Caption */}
        {gamePhase === 'idle' && (
          <div id="paperCaption" className="paper-caption"></div>
        )}

        {/* Mode bar */}
        {gamePhase === 'folding' && (
          <div id="modebar" className="modebar">
            <span id="modeLabel">{gameMode === 'guide' ? 'GUIDED FOLD' : 'FROM MEMORY'}</span>
            <span id="stepCount">
              {String(currentStep + 1).padStart(2, '0')} / {String(PATTERNS[patternName].steps.length).padStart(2, '0')}
            </span>
            {gameMode === 'challenge' && <span id="score">{score} pts</span>}
          </div>
        )}

        {/* Instruction */}
        {gamePhase === 'folding' && (
          <div id="instruction" className="instruction">
            <span id="stepKicker" key={currentStep} className="step-kicker">
              FOLD {String(currentStep + 1).padStart(2, '0')}
            </span>
            <h2 id="stepTitle">
              {gameMode === 'guide' || showHint ? PATTERNS[patternName].steps[currentStep]?.title : 'What comes next?'}
            </h2>
            <p id="stepCopy">
              {gameMode === 'guide' || showHint
                ? PATTERNS[patternName].steps[currentStep]?.copy
                : 'Choose the right corner and fold it into place. Take your time.'}
            </p>
            <div className="instruction-bottom">
              {gameMode === 'challenge' && (
                <button
                  id="restoreGuide"
                  className="text-button"
                  onClick={() => {
                    if (stateRef.current.busy) return;
                    stateRef.current.mode = 'guide';
                    stateRef.current.showHint = false;
                    stateRef.current.selected = 0;
                    stateRef.current.drag = null;
                    syncReactState();
                    deskCanvasRef.current?.focus({ preventScroll: true });
                  }}
                >
                  Follow the hand
                </button>
              )}
              {gameMode === 'challenge' && (
                <button
                  id="hint"
                  className="text-button"
                  onClick={revealHint}
                  disabled={showHint}
                >
                  {showHint ? 'Hint shown · −25 pts' : 'Show a hint · −25 pts'}
                </button>
              )}
            </div>
          </div>
        )}

        {/* Success */}
        {gamePhase === 'done' && (
          <div id="success" className="success">
            <p id="result">
              {gameMode === 'challenge'
                ? `${score} / ${PATTERNS[patternName].steps.length * 100} points · Best ${bestScore}`
                : 'Made by you.'}
            </p>
            {patternName === 'rocket' ? (
              <button className="primary launch" onClick={() => launchDialogRef.current?.showModal()}>
                Launch it ↗
              </button>
            ) : (
              <p className="jump-help">Press. Hold. Let go.</p>
            )}
            <div className="success-actions">
              <button id="challenge" className="text-button" onClick={() => start(true)}>
                Fold from memory
              </button>
              <button id="again" className="text-button" onClick={() => start(false)}>
                With a little help
              </button>
            </div>
          </div>
        )}

        {/* Snap prompt */}
        {readyForSnap && (
          <div id="snapPrompt" className="snap-prompt">
            <span id="snapTitle" className="sr-only">
              Snap to change the scene
            </span>
            <button
              id="magic"
              ref={magicRef}
              className={`ghost-snap ${isSnapping ? 'is-snapping' : 'is-idle'} ${micActive ? 'is-listening' : ''}`}
              aria-label="Snap gesture: change the scene"
              onClick={handleSnapTap}
            >
              <div className="snap-wrapper" key={snapKey}>
                <img
                  src="/snap-ready.png"
                  alt="Snap gesture"
                  className="snap-img snap-img-ready"
                  draggable={false}
                />
                <img
                  src="/snap-active.png"
                  alt=""
                  className="snap-img snap-img-active"
                  draggable={false}
                />
                <div className="snap-ripple-fx" />
              </div>
              <span className="snap-label" aria-hidden="true">
                {micActive ? 'Listening · snap fingers' : 'Enable mic to snap'}
              </span>
            </button>
          </div>
        )}

        {/* Recenter */}
        {gamePhase === 'done' && (
          <button id="recenter" className="recenter" onClick={handleRecenter}>
            Bring it back
          </button>
        )}

        {/* Free bar */}
        {gamePhase === 'free' && (
          <div className="free-bar" id="freeBar">
            <span>Drag the paper. Make any fold.</span>
            <div>
              <button id="freshPaper" onClick={startFree}>
                Fresh sheet
              </button>
              <button id="freeHalf" onClick={handleFoldInHalf}>
                Fold in half
              </button>
              <button id="rocketPaper" onClick={() => start(false, 'rocket')}>
                Fold a rocket
              </button>
              <span id="freeCount" aria-live="polite">
                {freeHistoryCount > 0 ? `↳ ${freeHistoryCount}` : ''}
              </span>
            </div>
          </div>
        )}

        {/* Table tools */}
        <div className="table-tools">
          <div className="mode-switches" role="group" aria-label="What to fold">
            {[
              ['frog', 'Frog', () => start(false, 'frog')],
              ['rocket', 'Rocket', () => start(false, 'rocket')],
              ['free', 'Free fold', startFree]
            ].map(([id, label, go]) => {
              const active = id === 'free' ? gamePhase === 'free' : gamePhase !== 'free' && patternName === id;
              return (
                <button
                  key={id}
                  id={id === 'free' ? 'freeMode' : `${id}Mode`}
                  className="mode-switch"
                  aria-pressed={active}
                  onClick={go}
                >
                  {label}
                </button>
              );
            })}
          </div>

          <div className="paper-colors" aria-label="Paper color">
            {COLORS.map((c, i) => (
              <button
                key={c.name}
                data-color={i}
                className={`color ${currentColor === i ? 'active' : ''}`}
                style={{ '--color': c.css }}
                aria-label={`${c.name} paper`}
                aria-pressed={currentColor === i}
                onClick={() => handleColorChange(i)}
              />
            ))}
            <span id="colorName" hidden>
              {COLORS[currentColor].name}
            </span>
          </div>

          <div className="footer-actions">
            <button
              id="undo"
              className="tool"
              disabled={
                gamePhase === 'free'
                  ? freeHistoryCount === 0 || !!stateRef.current.freeSettle
                  : gamePhase !== 'folding' || currentStep === 0 || stateRef.current.busy || gameMode === 'challenge'
              }
              aria-label="Undo fold"
              title="Undo fold"
              onClick={handleUndo}
            >
              ↶
            </button>
            <button id="restart" className="tool" aria-label="Start over" title="Start over" onClick={handleRestart}>
              ↻
            </button>
            <button
              id="sound"
              className="tool"
              aria-label={soundEnabled ? 'Disable paper sounds' : 'Enable paper sounds'}
              aria-pressed={soundEnabled}
              title="Paper sounds"
              style={{ background: soundEnabled ? '#ffffff44' : '' }}
              onClick={handleSoundToggle}
            >
              <svg viewBox="0 0 24 24" width="18" fill="none" stroke="currentColor" strokeWidth="1.4">
                <path d="M4 9v6h4l5 4V5L8 9H4m12 0 4 6m0-6-4 6" />
              </svg>
            </button>
            <button
              id="settings"
              className={`tool ${micActive ? 'mic-on' : ''}`}
              aria-label="Microphone settings"
              title="Microphone settings"
              onClick={() => micDialogRef.current?.showModal()}
            >
              <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7">
                <rect x="9" y="2" width="6" height="12" rx="3" />
                <path d="M6 10v2a6 6 0 0 0 12 0v-2M12 18v4M8 22h8" />
              </svg>
            </button>
            <button
              id="help"
              className="tool help"
              aria-label="How to play"
              onClick={() => helpDialogRef.current?.showModal()}
            >
              ?
            </button>
          </div>
        </div>

        {/* Signature */}
        <div className="table-signature" aria-label="Crafted by Thiru Sharma">
          by Thiru Sharma
        </div>

        {/* Toast */}
        <div id="toast" role="status" aria-live="polite" className={showToast ? 'show' : ''}>
          {toastText}
        </div>

        {/* Mic Dialog */}
        <dialog
          id="micDialog"
          ref={micDialogRef}
          onClick={(e) => {
            if (e.target === micDialogRef.current) {
              const r = micDialogRef.current.getBoundingClientRect();
              if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) {
                micDialogRef.current.close();
              }
            }
          }}
        >
          <button id="closeMic" className="close" aria-label="Close microphone settings" onClick={() => micDialogRef.current?.close()}>
            ×
          </button>
          <h2>Finger-snap magic</h2>
          <p>Enable the microphone, then snap near your device to change the scene.</p>
          {!micActive ? (
            <button id="enableMic" className="primary" onClick={startMic} disabled={micPending}>
              {micPending ? 'Waiting for permission…' : 'Enable microphone'}
            </button>
          ) : (
            <button id="stopMic" className="text-button" onClick={stopMic}>
              Turn microphone off
            </button>
          )}
          <p id="micNote" className="small" role="status">
            {micNote}
          </p>
        </dialog>

        {/* Rocket launch dialog */}
        <dialog id="launchDialog" ref={launchDialogRef}>
          <button className="close" aria-label="Close" onClick={() => launchDialogRef.current?.close()}>
            ×
          </button>
          <h2>Blow it into the sky.</h2>
          <p>
            Open your camera and microphone, purse your lips like you're blowing out a candle, and blow. The harder you
            blow, the further it flies. Turn your head to steer through the rings.
          </p>
          <button className="primary" onClick={() => launchRocket(true)}>
            Open camera
          </button>{' '}
          <button className="text-button launch-alt" onClick={() => launchRocket(false)}>
            Play without camera
          </button>
          <p className="small">
            Your face and breath are read on this device only. Nothing is recorded or uploaded, and the camera turns off
            when you land back on the table.
          </p>
        </dialog>

        {flight && (
          <Suspense fallback={<div className="flight flight-loading">Unfolding the sky…</div>}>
            <RocketFlight
              color={COLORS[currentColor].rgb}
              tracker={flight.tracker}
              reduced={stateRef.current.reduced}
              onExit={endFlight}
            />
          </Suspense>
        )}

        {/* Help Dialog */}
        <dialog
          id="helpDialog"
          ref={helpDialogRef}
          onClick={(e) => {
            if (e.target === helpDialogRef.current) {
              const r = helpDialogRef.current.getBoundingClientRect();
              if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) {
                helpDialogRef.current.close();
              }
            }
          }}
        >
          <button id="closeHelp" className="close" aria-label="Close help" onClick={() => helpDialogRef.current?.close()}>
            ×
          </button>
          <h2>A little paper break.</h2>
          <p>Lift the marked edge and bring it to the small dot. Watch the fold rise, turn, and settle.</p>
          <p>
            First, follow the guide. Later, fold from memory: up to 100 points per fold, minus 15 for a miss or 25 for a hint.
          </p>
          <p>When your frog is ready, press and hold, then let it jump.</p>
          <button
            className="primary"
            id="guideFromHelp"
            onClick={() => {
              helpDialogRef.current?.close();
              start(false);
            }}
          >
            Start with a guide
          </button>
          <p className="small">
            Keyboard: focus the paper. ← → choose a corner, Enter folds. Hold Space and release to jump. Digital origami with
            simplified paired folds; not a physical-paper tutorial. Your progress stays in this browser.
          </p>
        </dialog>
      </section>
    </main>
  );
}

export default FrogGame;
