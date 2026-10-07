import React, { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { trackEvent } from './analytics';

/*
 * A 3D launch for the free-fold paper rocket. Blow (camera + mic, or the hold
 * button / Space) to throw it and keep it aloft; turn your head to steer.
 */

const RING_COUNT = 7;
const RING_GAP = 7;
const MAX_DISTANCE = 120;

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const damp = (current, target, lambda, dt) => target + (current - target) * Math.exp(-lambda * dt);

function canvasTexture(w, h, draw) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  draw(c.getContext('2d'), w, h);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// The same dart the player folded: two wings raised in a shallow V from the spine,
// notched wing tips, and a keel hanging under the spine. Nose points to -z.
function rocketGeometry() {
  const nose = [0, 0.07, -0.63];
  const tail = [0, 0.07, 0.5];
  const keelTail = [0, -0.04, 0.5];
  const keelMid = [0, 0.03, -0.3];
  const side = (m) => {
    const rootTail = [0.03 * m, 0.07, 0.5];
    const tipTrail = [0.37 * m, 0.16, 0.5];
    const tipLead = [0.32 * m, 0.16, 0.29];
    const layer = [0.1 * m, 0.08, 0.5];
    return [
      // wing
      nose, rootTail, tipTrail,
      nose, tipTrail, tipLead,
      // the folded edge layer lying along the spine
      nose, layer, rootTail,
      // keel
      nose, keelMid, keelTail,
      nose, keelTail, tail
    ];
  };
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute([...side(-1), ...side(1)].flat(), 3));
  g.computeVertexNormals();
  return g;
}

export default function RocketFlight({ color, tracker, reduced, onExit }) {
  const canvasRef = useRef(null);
  const bubbleRef = useRef(null);
  const [hud, setHud] = useState({
    phase: 'ready',
    distance: 0,
    rings: 0,
    air: 1,
    blow: 0,
    face: false,
    hasCamera: false,
    hasMic: false,
    status: tracker.state.status,
    message: ''
  });
  const [best, setBest] = useState(() => {
    try {
      return Number(localStorage.getItem('little-fold-best-flight')) || 0;
    } catch {
      return 0;
    }
  });
  const resetRef = useRef(() => {});

  // Show the live camera in the little mirror bubble.
  useEffect(() => {
    const bubble = bubbleRef.current;
    if (bubble && tracker.video) bubble.appendChild(tracker.video);
    return () => tracker.video?.remove();
  }, [tracker]);

  // Hold Space (or the button) to blow without a camera.
  useEffect(() => {
    const down = (e) => {
      if (e.key === ' ') {
        e.preventDefault();
        tracker.manual = 1;
      }
      if (e.key === 'Escape') onExit();
    };
    const up = (e) => {
      if (e.key === ' ') tracker.manual = 0;
    };
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
      tracker.manual = 0;
    };
  }, [tracker, onExit]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.05;

    const scene = new THREE.Scene();
    const disposables = [];
    const keep = (x) => (disposables.push(x), x);

    // Warm paper sky and soft haze toward the horizon.
    scene.background = keep(
      canvasTexture(4, 256, (ctx, w, h) => {
        const g = ctx.createLinearGradient(0, 0, 0, h);
        g.addColorStop(0, '#c9dce0');
        g.addColorStop(0.55, '#efe6d2');
        g.addColorStop(1, '#e8d8bb');
        ctx.fillStyle = g;
        ctx.fillRect(0, 0, w, h);
      })
    );
    scene.fog = new THREE.Fog(0xebdfc8, 14, 70);

    const camera = new THREE.PerspectiveCamera(55, 1, 0.05, 200);

    scene.add(new THREE.HemisphereLight(0xfff7e8, 0x8b7558, 1.5));
    const sun = new THREE.DirectionalLight(0xfff0d4, 2.2);
    sun.position.set(3, 7, 4);
    scene.add(sun);

    // The table stretches out ahead as the runway.
    const groundTex = keep(new THREE.TextureLoader().load('/tabletop.png'));
    groundTex.colorSpace = THREE.SRGBColorSpace;
    // Mirrored tiling hides the seams of a photo that was never meant to tile.
    groundTex.wrapS = groundTex.wrapT = THREE.MirroredRepeatWrapping;
    groundTex.repeat.set(3, 12);
    groundTex.anisotropy = renderer.capabilities.getMaxAnisotropy();
    const ground = new THREE.Mesh(
      keep(new THREE.PlaneGeometry(60, 240)),
      keep(new THREE.MeshStandardMaterial({ map: groundTex, roughness: 1, color: 0xf1e6d2 }))
    );
    ground.rotation.x = -Math.PI / 2;
    ground.position.z = -100;
    scene.add(ground);

    // Distance marks every 5 m, like chalk lines on the table.
    const markMat = keep(new THREE.MeshBasicMaterial({ color: 0xfff8e6, transparent: true, opacity: 0.55 }));
    const markGeo = keep(new THREE.PlaneGeometry(7, 0.035));
    for (let d = 5; d <= MAX_DISTANCE; d += 5) {
      const m = new THREE.Mesh(markGeo, markMat);
      m.rotation.x = -Math.PI / 2;
      m.position.set(0, 0.004, -d);
      scene.add(m);
      const label = keep(
        canvasTexture(128, 64, (ctx) => {
          ctx.font = '40px Gloock, Georgia, serif';
          ctx.fillStyle = '#5d4f3a';
          ctx.textAlign = 'center';
          ctx.fillText(`${d} m`, 64, 46);
        })
      );
      const sprite = new THREE.Sprite(keep(new THREE.SpriteMaterial({ map: label, transparent: true, opacity: 0.75 })));
      sprite.scale.set(0.8, 0.4, 1);
      sprite.position.set(3.9, 0.25, -d);
      scene.add(sprite);
    }

    // Floating paper flecks give a sense of speed.
    const fleckCount = 260;
    const fleckPos = new Float32Array(fleckCount * 3);
    for (let i = 0; i < fleckCount; i++) {
      fleckPos[i * 3] = (Math.random() - 0.5) * 16;
      fleckPos[i * 3 + 1] = 0.3 + Math.random() * 4;
      fleckPos[i * 3 + 2] = -Math.random() * MAX_DISTANCE;
    }
    const flecks = new THREE.Points(
      keep(new THREE.BufferGeometry().setAttribute('position', new THREE.BufferAttribute(fleckPos, 3))),
      keep(new THREE.PointsMaterial({ color: 0xfffaf0, size: 0.05, transparent: true, opacity: 0.8 }))
    );
    scene.add(flecks);

    // Rings to fly through.
    const ringGeo = keep(new THREE.TorusGeometry(0.62, 0.04, 12, 48));
    const rings = Array.from({ length: RING_COUNT }, (_, i) => {
      const mat = keep(
        new THREE.MeshStandardMaterial({ color: 0xe2a95f, emissive: 0x7a4a12, emissiveIntensity: 0.25, roughness: 0.6, transparent: true })
      );
      const mesh = new THREE.Mesh(ringGeo, mat);
      mesh.position.set(Math.sin(i * 1.9) * 1.7, 1.15 + ((i * 7) % 3) * 0.3, -6 - i * RING_GAP);
      scene.add(mesh);
      return { mesh, mat, hit: false, pop: 0 };
    });

    // The rocket itself, in the chosen paper colour.
    const paper = new THREE.Color(`rgb(${color.join(',')})`);
    const rocket = new THREE.Group();
    const body = new THREE.Mesh(
      keep(rocketGeometry()),
      keep(new THREE.MeshStandardMaterial({ color: paper, roughness: 0.85, side: THREE.DoubleSide, flatShading: true }))
    );
    const edges = new THREE.LineSegments(
      keep(new THREE.EdgesGeometry(body.geometry, 1)),
      keep(new THREE.LineBasicMaterial({ color: 0x3e3424, transparent: true, opacity: 0.35 }))
    );
    rocket.add(body, edges);
    rocket.scale.setScalar(1.35);
    scene.add(rocket);

    // Soft blob shadow under the rocket for depth.
    const shadow = new THREE.Mesh(
      keep(new THREE.PlaneGeometry(1, 1)),
      keep(
        new THREE.MeshBasicMaterial({
          map: keep(
            canvasTexture(128, 128, (ctx) => {
              const g = ctx.createRadialGradient(64, 64, 0, 64, 64, 64);
              g.addColorStop(0, 'rgba(50,36,18,0.55)');
              g.addColorStop(1, 'rgba(50,36,18,0)');
              ctx.fillStyle = g;
              ctx.fillRect(0, 0, 128, 128);
            })
          ),
          transparent: true,
          depthWrite: false
        })
      )
    );
    shadow.rotation.x = -Math.PI / 2;
    scene.add(shadow);

    // A fading air trail behind the tail.
    const TRAIL = 16;
    const trailPos = new Float32Array(TRAIL * 3);
    const trailGeo = keep(new THREE.BufferGeometry());
    trailGeo.setAttribute('position', new THREE.BufferAttribute(trailPos, 3));
    // Per-vertex alpha so the trail fades out behind the rocket.
    const trailColor = new Float32Array(TRAIL * 4);
    for (let i = 0; i < TRAIL; i++) trailColor.set([1, 0.99, 0.95, Math.pow(1 - i / TRAIL, 1.6)], i * 4);
    trailGeo.setAttribute('color', new THREE.BufferAttribute(trailColor, 4));
    const trail = new THREE.Line(
      trailGeo,
      keep(new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.7, depthWrite: false }))
    );
    trail.frustumCulled = false;
    scene.add(trail);

    // ---- Flight state ----
    const f = {
      phase: 'ready',
      pos: new THREE.Vector3(),
      speed: 0,
      vx: 0,
      vy: 0,
      pitch: 0,
      roll: 0,
      yaw: 0,
      hold: 0,
      air: 1,
      clock: 0,
      rings: 0,
      ground: 0
    };

    const reset = () => {
      f.phase = 'ready';
      f.pos.set(0, 1.05, 0);
      f.speed = f.vx = f.vy = f.pitch = f.roll = f.yaw = f.hold = f.ground = 0;
      f.air = 1;
      f.rings = 0;
      rings.forEach((r) => {
        r.hit = false;
        r.pop = 0;
        r.mesh.scale.setScalar(1);
        r.mat.opacity = 1;
        r.mat.emissiveIntensity = 0.25;
      });
      for (let i = 0; i < TRAIL; i++) trailPos.set([0, 1.05, 0.4], i * 3);
      trailGeo.attributes.position.needsUpdate = true;
      camera.position.set(0, 2.15, 2.9);
    };
    reset();
    resetRef.current = reset;

    const resize = () => {
      const w = canvas.clientWidth;
      const h = canvas.clientHeight;
      renderer.setSize(w, h, false);
      camera.aspect = w / h;
      camera.fov = w < h ? 68 : 55;
      camera.updateProjectionMatrix();
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(canvas);

    let raf = 0;
    let last = 0;
    let hudClock = 0;
    const lookTarget = new THREE.Vector3(0, 1, -4);
    const tmp = new THREE.Vector3();

    const finishFlight = () => {
      f.phase = 'landed';
      const distance = Math.max(0, -f.pos.z);
      trackEvent('rocket_flight_landed', {
        distance: Math.round(distance * 10) / 10,
        rings: f.rings,
      });
      setBest((b) => {
        const next = Math.max(b, Math.round(distance * 10) / 10);
        try {
          localStorage.setItem('little-fold-best-flight', String(next));
        } catch {}
        return next;
      });
    };

    const tick = (now) => {
      const dt = last ? Math.min((now - last) / 1000, 0.04) : 0;
      last = now;
      f.clock += dt;

      const t = tracker.state;
      const blow = Math.max(t.blow, tracker.manual);
      const steer = t.steer;

      if (f.phase === 'ready') {
        // Hover on the palm, nudged by your breath; a steady blow throws it.
        f.pos.y = 1.05 + (reduced ? 0 : Math.sin(f.clock * 2) * 0.025) + blow * 0.05;
        f.roll = damp(f.roll, -steer * 0.3, 6, dt);
        f.pitch = damp(f.pitch, blow * 0.15, 6, dt);
        f.hold = blow > 0.28 ? f.hold + dt : Math.max(0, f.hold - dt * 2);
        if (f.hold > 0.16) {
          f.phase = 'flying';
          trackEvent('rocket_flight_taken_off', {
            initialSpeed: 3 + blow * 4,
            hasCamera: t.hasCamera,
            hasMic: t.hasMic,
          });
          // Start the trail collapsed at the tail so it grows out as the rocket leaves.
          tmp.set(0, 0.04, 0.5 * 1.35).applyEuler(rocket.rotation).add(f.pos);
          for (let i = 0; i < TRAIL; i++) trailPos.set([tmp.x, tmp.y, tmp.z], i * 3);
          f.speed = 3 + blow * 4;
          f.vy = 0.7 + blow * 0.5;
        }
      } else if (f.phase === 'flying') {
        // Glide physics: blowing is a tail wind that adds speed and lift, but your
        // lungs run out after a few seconds, so well-timed puffs fly furthest.
        const push = blow * f.air;
        f.air = clamp(f.air - (blow * dt) / 3.2 + (blow < 0.15 ? 0.25 * dt : 0), 0, 1);
        f.speed = clamp(f.speed - (0.8 + f.speed * 0.06) * dt + push * 5.5 * dt, 0, 13);
        const lift = (f.speed > 4 ? 0.45 : 0) + push * 2.3;
        f.vy = clamp(f.vy + (lift - 1.9) * dt, -3, 2.2);
        f.vx = damp(f.vx, steer * (2 + f.speed * 0.35), 2.5, dt);
        f.pos.x = clamp(f.pos.x + f.vx * dt, -9, 9);
        f.pos.y = Math.min(4.2, f.pos.y + f.vy * dt);
        f.pos.z -= f.speed * dt;

        const wobble = reduced ? 0 : Math.sin(f.clock * 7.3) * 0.05 * (f.speed / 10);
        f.roll = damp(f.roll, -f.vx * 0.22 + wobble, 5, dt);
        f.pitch = damp(f.pitch, Math.atan2(f.vy, Math.max(1, f.speed)), 6, dt);
        f.yaw = damp(f.yaw, -Math.atan2(f.vx, Math.max(1, f.speed)), 6, dt);

        // Rings
        rings.forEach((r) => {
          if (r.hit) return;
          const p = r.mesh.position;
          if (Math.abs(f.pos.z - p.z) < 0.25 && Math.hypot(f.pos.x - p.x, f.pos.y - p.y) < 0.6) {
            r.hit = true;
            f.rings++;
            f.speed = Math.min(13, f.speed + 1.5); // a little boost for threading the ring
          }
        });

        if (f.pos.y <= 0.08 || -f.pos.z >= MAX_DISTANCE) {
          f.pos.y = 0.08;
          f.phase = 'sliding';
          f.vy = 0;
        }
      } else if (f.phase === 'sliding') {
        // Skid to a stop on the table.
        f.speed = damp(f.speed, 0, 3.2, dt);
        f.vx = damp(f.vx, 0, 4, dt);
        f.pos.z -= f.speed * dt;
        f.pos.x += f.vx * dt;
        f.pitch = damp(f.pitch, 0, 8, dt);
        f.roll = damp(f.roll, 0.08, 4, dt);
        if (f.speed < 0.12) finishFlight();
      }

      rocket.position.copy(f.pos);
      rocket.rotation.set(f.pitch, f.yaw, f.roll, 'YXZ');

      shadow.position.set(f.pos.x + 0.15, 0.006, f.pos.z + 0.1);
      const h = Math.max(0, f.pos.y);
      shadow.scale.set(0.9 + h * 0.4, 0.7 + h * 0.4, 1);
      shadow.material.opacity = clamp(1 - h / 5, 0.15, 1);

      // Trail follows the tail.
      if (f.phase !== 'ready') {
        trailPos.copyWithin(3, 0, (TRAIL - 1) * 3);
        tmp.set(0, 0.04, 0.5 * 1.35).applyEuler(rocket.rotation).add(f.pos);
        trailPos.set([tmp.x, tmp.y, tmp.z], 0);
        trailGeo.attributes.position.needsUpdate = true;
      }
      trail.material.opacity = f.phase === 'flying' ? 0.35 + blow * 0.5 : damp(trail.material.opacity, 0, 2, dt);

      rings.forEach((r, i) => {
        r.mesh.rotation.z = reduced ? 0 : f.clock * 0.4 + i;
        if (r.hit) {
          r.pop = Math.min(1, r.pop + dt * 2.2);
          r.mesh.scale.setScalar(1 + r.pop * 0.8);
          r.mat.opacity = 1 - r.pop;
          r.mat.emissiveIntensity = 1.2;
        }
      });

      // Chase camera: behind and above, easing so the motion feels floaty.
      const behind = f.phase === 'ready' ? 2.9 : 3.6;
      camera.position.x = damp(camera.position.x, f.pos.x * 0.7, 3, dt);
      camera.position.y = damp(camera.position.y, Math.max(1.1, f.pos.y + 1.1), 3, dt);
      camera.position.z = damp(camera.position.z, f.pos.z + behind, f.phase === 'ready' ? 4 : 2.6, dt);
      lookTarget.x = damp(lookTarget.x, f.pos.x, 5, dt);
      lookTarget.y = damp(lookTarget.y, f.pos.y - 0.05, 5, dt);
      lookTarget.z = damp(lookTarget.z, f.pos.z - 2.2, 5, dt);
      camera.lookAt(lookTarget);

      renderer.render(scene, camera);

      // Update the React HUD a few times a second, not every frame.
      hudClock += dt;
      if (hudClock > 0.08) {
        hudClock = 0;
        setHud({
          phase: f.phase,
          distance: Math.max(0, -f.pos.z),
          rings: f.rings,
          air: f.air,
          blow,
          face: t.face,
          hasCamera: t.hasCamera,
          hasMic: t.hasMic,
          status: t.status,
          message: t.message
        });
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      disposables.forEach((d) => d.dispose?.());
      renderer.dispose();
    };
  }, [color, tracker, reduced]);

  const usingCamera = hud.status !== 'idle';
  const hint = (() => {
    if (hud.status === 'starting') return 'Waiting for camera permission…';
    if (hud.status === 'loading') return hud.message || 'Waking up face tracking…';
    if (hud.phase !== 'ready') return null;
    if (hud.status === 'ready' && hud.hasCamera && !hud.face) return 'Look into the camera so I can see you.';
    if (hud.status === 'ready' && (hud.hasMic || hud.face)) return 'Purse your lips and blow. Turn your head to steer.';
    return 'Hold the blow button (or Space) to launch.';
  })();

  const holdProps = {
    onPointerDown: (e) => {
      e.currentTarget.setPointerCapture?.(e.pointerId);
      tracker.manual = 1;
    },
    onPointerUp: () => (tracker.manual = 0),
    onPointerCancel: () => (tracker.manual = 0),
    onLostPointerCapture: () => (tracker.manual = 0)
  };

  return (
    <div className="flight" role="dialog" aria-label="Rocket flight">
      <canvas ref={canvasRef} className="flight-canvas" />

      <div className="flight-hud" aria-live="polite">
        <span className="flight-distance">{hud.distance.toFixed(1)} m</span>
        <span className="flight-air" title="Breath left" style={{ '--air': hud.air }} aria-label="Breath left" />
        <span className="flight-rings">
          ◎ {hud.rings}/{RING_COUNT}
        </span>
        {best > 0 && <span className="flight-best">Best {best.toFixed(1)} m</span>}
      </div>

      <button className="flight-close" aria-label="Back to folding" onClick={onExit}>
        ×
      </button>

      {hint && <p className="flight-hint">{hint}</p>}
      {hud.status === 'error' && <p className="flight-hint flight-note">{hud.message}</p>}

      {usingCamera && (
        <div className={`breath-bubble ${hud.face ? 'has-face' : ''}`} style={{ '--blow': hud.blow }}>
          <div className="breath-mirror" ref={bubbleRef} />
          <span className="breath-meter" aria-hidden="true" />
          <span className="breath-state">
            {hud.hasCamera ? (hud.face ? 'Face found' : 'Finding face') : 'No camera'}
            {' · '}
            {hud.hasMic ? 'mic on' : 'no mic'}
          </span>
        </div>
      )}

      <button className="blow-button" style={{ '--blow': hud.blow }} {...holdProps}>
        <span>Hold to blow</span>
      </button>

      {hud.phase === 'landed' && (
        <div className="flight-result">
          <h2>{hud.distance.toFixed(1)} m</h2>
          <p>
            {hud.rings ? `Through ${hud.rings} ring${hud.rings > 1 ? 's' : ''}. ` : ''}
            {hud.distance >= best - 0.05 ? 'Your best flight yet.' : `Best ${best.toFixed(1)} m.`}
          </p>
          <div>
            <button className="primary" onClick={() => resetRef.current()}>
              Fly again
            </button>
            <button className="text-button" onClick={onExit}>
              Back to folding
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
