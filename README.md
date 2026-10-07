# Little Fold 🐸

> An interactive 3D origami folding game with realistic paper physics, finger-snap microphone gestures, 3D breath-controlled rocket flight, and product analytics.

Crafted by **Thiru Sharma**.

---

## ✨ Features

- **Interactive Paper Folding**: Drag corners and creases to fold a classic jumping frog or supersonic paper rocket.
- **Realistic Paper Physics & Audio**: Dynamic paper creasing, tactile audio feedback, and smooth 60fps animations.
- **Finger-Snap Magic**: Enable the microphone and snap your fingers near your device to magically transform the scene (table, pond, night sky).
- **3D Rocket Launch**: Fold a rocket and launch it into 3D space with breath & head motion controls powered by MediaPipe Face Landmarker & Three.js.
- **Product Analytics & Session Replay**: Integrated with PostHog for telemetry, session recording, and gameplay metrics.
- **Free Fold Studio**: Experiment with dynamic creases, custom folds, and fresh sheets.

---

## 🚀 Getting Started

### Prerequisites

- [Node.js](https://nodejs.org/) (v18 or higher recommended)
- `npm` or `yarn`

### Installation

```bash
# Clone the repository
git clone https://github.com/sharma2-4/frog-game-react.git

# Enter project directory
cd frog-game-react

# Install dependencies
npm install

# Start local development server
npm run dev
```

### Environment Variables

Copy `.env.example` to `.env`:

```env
VITE_POSTHOG_KEY=your_posthog_project_token
VITE_POSTHOG_HOST=https://us.i.posthog.com
```

### Production Build

```bash
npm run build
npm run preview
```

---

## 🛠️ Tech Stack

- **Framework**: React 18 + Vite
- **3D Graphics**: Three.js + Custom WebGL Shaders
- **Vision & Audio**: MediaPipe Tasks Vision + Web Audio API / Transient Snap Detection
- **Analytics & Replay**: PostHog (`posthog-js`)
- **Visuals & FX**: Canvas Confetti + Custom 3D Asset Renders
- **Typography**: Gloock (Serif) & Jost (Sans)

---

## 📄 License

MIT © [Thiru Sharma](https://github.com/sharma2-4)
