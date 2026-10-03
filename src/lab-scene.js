import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { singlePBSIsometry } from './measurement.js';

const BLUE = 0x61c7ff;
const VIOLET = 0xad87ff;
const CYAN = 0x8de7ff;
const UP = new THREE.Vector3(0, 1, 0);
const v = (x, y, z) => new THREE.Vector3(x, y, z);
const clamp = THREE.MathUtils.clamp;

function glowTexture() {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 128;
  const ctx = canvas.getContext('2d');
  const gradient = ctx.createRadialGradient(64, 64, 0, 64, 64, 64);
  gradient.addColorStop(0, '#ffffff');
  gradient.addColorStop(0.09, '#ffffff');
  gradient.addColorStop(0.22, '#bce9ffb0');
  gradient.addColorStop(0.5, '#82caff32');
  gradient.addColorStop(1, '#82caff00');
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, 128, 128);
  return new THREE.CanvasTexture(canvas);
}

function captionTexture(title, subtitle = '', color = '#bdcfe6') {
  const canvas = document.createElement('canvas');
  canvas.width = 768;
  canvas.height = 192;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = color;
  ctx.font = '600 54px Inter, Segoe UI, sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText(title, 384, subtitle ? 77 : 110);
  if (subtitle) {
    ctx.font = '400 32px Inter, Segoe UI, sans-serif';
    ctx.fillStyle = '#88a0bc';
    ctx.fillText(subtitle, 384, 127);
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

function cylinderBetween(start, end, radius, material, segments = 16) {
  const delta = end.clone().sub(start);
  const mesh = new THREE.Mesh(new THREE.CylinderGeometry(radius, radius, delta.length(), segments), material);
  mesh.position.copy(start).add(end).multiplyScalar(0.5);
  mesh.quaternion.setFromUnitVectors(UP, delta.normalize());
  return mesh;
}

function pathLength(points) {
  let total = 0;
  for (let i = 1; i < points.length; i++) total += points[i].distanceTo(points[i - 1]);
  return total;
}

function pathPoint(points, distance) {
  for (let i = 1; i < points.length; i++) {
    const length = points[i].distanceTo(points[i - 1]);
    if (distance <= length) return points[i - 1].clone().lerp(points[i], clamp(distance / length, 0, 1));
    distance -= length;
  }
  return points[points.length - 1].clone();
}

function outcomeOf(record, arm) {
  return arm === 'a'
    ? (record.outcomeA ?? record.aOutcome ?? record.outcomes?.a)
    : (record.outcomeB ?? record.bOutcome ?? record.outcomes?.b);
}

function rightAnglePrism(size, sign, half) {
  const h = size / 2;
  const shape = new THREE.Shape();
  const points = half === 0 ? [[-h, -h], [h, -h], [-h, h]] : [[h, h], [-h, h], [h, -h]];
  shape.moveTo(points[0][0], points[0][1] * sign);
  for (let i = 1; i < points.length; i++) shape.lineTo(points[i][0], points[i][1] * sign);
  shape.closePath();
  const geometry = new THREE.ExtrudeGeometry(shape, { depth: size, bevelEnabled: false, curveSegments: 1 });
  geometry.rotateX(Math.PI / 2);
  geometry.translate(0, h, 0);
  return geometry;
}

/**
 * Rendering/playback only. A deferred record.measure() is invoked at detection;
 * all probabilities, random draws, timestamps, and statistics belong upstream.
 */
export class LabScene {
  constructor(container, { onInspect, onMeasurement, onPhase, onCameraOverride } = {}) {
    this.container = container;
    this.onInspect = onInspect ?? (() => {});
    this.onMeasurement = onMeasurement ?? (() => {});
    this.onPhase = onPhase ?? (() => {});
    this.onCameraOverride = onCameraOverride ?? (() => {});
    this.guidedCamera = true;
    this.cameraTransition = 1.4;
    this.timelineState = null;
    this._timelineMode = false;
    this._timelineStage = -1;
    this._pbsInspector = null;
    this.worldLabels = [];
    this.pairs = [];
    this.components = new Map();
    this.pickables = [];
    this.detectors = new Map();
    this.paused = false;
    this.speed = 1;
    this.presentation = false;
    this._reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
    this.elapsed = 0;
    this.lastTime = performance.now();
    this.lastInteraction = performance.now();
    this.maxPairs = 36;
    this._disposed = false;
    this._cameraFlight = null;
    this._selected = null;
    this._sourceMode = 'entangled';
    this._textures = [];
    this._ownedGeometries = new Set();

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x050c18);
    this.scene.fog = new THREE.FogExp2(0x050c18, 0.028);
    this.camera = new THREE.PerspectiveCamera(42, 1, 0.04, 120);
    this.camera.position.set(11.8, 11.0, 13.7);
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.75));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.2;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.domElement.className = 'lab-canvas';
    this.renderer.domElement.setAttribute('aria-label', 'Interactive optical laboratory. Drag to orbit, scroll to zoom, and click a component to inspect it.');
    this.renderer.domElement.style.touchAction = 'none';
    this.container.appendChild(this.renderer.domElement);
    const environment = new RoomEnvironment();
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    this._environmentTarget = pmrem.fromScene(environment, 0.035);
    this.scene.environment = this._environmentTarget.texture;
    this.scene.environmentIntensity = 0.8;
    environment.dispose();
    pmrem.dispose();
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.target.set(0, -0.1, 0);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.07;
    this.controls.minDistance = 0.12;
    this.controls.maxDistance = 50;
    this.controls.maxPolarAngle = Math.PI * 0.97;
    this.controls.zoomSpeed = 0.72;
    this.controls.rotateSpeed = 0.65;
    this.controls.addEventListener('start', () => {
      this._cameraFlight = null;
      this.lastInteraction = performance.now();
      this.guidedCamera = false;
      this.onCameraOverride({ guidedCamera: false, reason: 'manual-orbit' });
    });

    this.raycaster = new THREE.Raycaster();
    this.pointer = new THREE.Vector2();
    this._pointerStart = null;
    this._onPointerDown = (event) => {
      this._pointerStart = { x: event.clientX, y: event.clientY, time: performance.now() };
    };
    this._onPointerUp = (event) => this._pick(event);
    this.renderer.domElement.addEventListener('pointerdown', this._onPointerDown);
    this.renderer.domElement.addEventListener('pointerup', this._onPointerUp);

    this.materials = {
      black: new THREE.MeshStandardMaterial({ color: 0x1b2738, metalness: 0.65, roughness: 0.34 }),
      housing: new THREE.MeshStandardMaterial({ color: 0x2b3b4e, metalness: 0.75, roughness: 0.3 }),
      silver: new THREE.MeshStandardMaterial({ color: 0x9ba9b8, metalness: 0.85, roughness: 0.28 }),
      screws: new THREE.MeshStandardMaterial({ color: 0xa2acb5, metalness: 0.95, roughness: 0.2 }),
      brass: new THREE.MeshStandardMaterial({ color: 0xa48248, metalness: 0.83, roughness: 0.3 }),
      pcb: new THREE.MeshStandardMaterial({ color: 0x223848, metalness: 0.5, roughness: 0.35 }),
      glass: new THREE.MeshPhysicalMaterial({ color: 0xc2eaff, metalness: 0, roughness: 0.04, transmission: 0.88, thickness: 0.48, transparent: true, opacity: 0.36, ior: 1.48, depthWrite: false, side: THREE.DoubleSide }),
      crystal: new THREE.MeshPhysicalMaterial({ color: 0xa988ff, roughness: 0.09, metalness: 0, transmission: 0.75, thickness: 0.3, transparent: true, opacity: 0.72, ior: 1.6 }),
      plane: new THREE.MeshPhysicalMaterial({ color: 0xd8e9ff, metalness: 0.15, roughness: 0.14, transparent: true, opacity: 0.36, side: THREE.DoubleSide, depthWrite: false }),
      blue: new THREE.MeshStandardMaterial({ color: BLUE, emissive: BLUE, emissiveIntensity: 0.45, roughness: 0.3 }),
      violet: new THREE.MeshStandardMaterial({ color: VIOLET, emissive: VIOLET, emissiveIntensity: 0.45, roughness: 0.3 }),
      neutral: new THREE.MeshStandardMaterial({ color: CYAN, emissive: CYAN, emissiveIntensity: 2.8, toneMapped: false }),
      pathA: new THREE.MeshBasicMaterial({ color: BLUE, transparent: true, opacity: 0.28, depthWrite: false }),
      pathB: new THREE.MeshBasicMaterial({ color: VIOLET, transparent: true, opacity: 0.28, depthWrite: false }),
    };
    this.glowTexture = glowTexture();
    this._textures.push(this.glowTexture);
    this._buildLights();
    this._buildTable();
    this._buildExperiment();
    this._buildTimelineVisual();
    this.resize();
    this._resizeObserver = new ResizeObserver(() => this.resize());
    this._resizeObserver.observe(container);
    this._animate = () => {
      if (this._disposed) return;
      this._frame = requestAnimationFrame(this._animate);
      const now = performance.now();
      const delta = Math.min((now - this.lastTime) / 1000, 0.08);
      this.lastTime = now;
      this.update(delta);
    };
    this._frame = requestAnimationFrame(this._animate);
  }

  get activeCount() { return this.pairs.length; }
  get running() { return this.pairs.length > 0 && !this.paused; }
  get progress() { return this.pairs[0]?.progress ?? 0; }

  _buildLights() {
    this.scene.add(new THREE.HemisphereLight(0xc4dafa, 0x0b152a, 1.75));
    const key = new THREE.DirectionalLight(0xe0eaff, 3.1);
    key.position.set(-4, 11, 5);
    key.castShadow = true;
    key.shadow.mapSize.set(2048, 2048);
    Object.assign(key.shadow.camera, { left: -9, right: 9, top: 9, bottom: -9, near: 0.5, far: 30 });
    key.shadow.bias = -0.0003;
    key.shadow.normalBias = 0.025;
    this.scene.add(key);
    const blue = new THREE.PointLight(0x468dff, 45, 24, 2);
    blue.position.set(-5, 5, -4);
    this.scene.add(blue);
    const purple = new THREE.PointLight(0x855bff, 52, 25, 2);
    purple.position.set(3, 5, 6);
    this.scene.add(purple);
    const rim = new THREE.DirectionalLight(0x6d88ba, 1.9);
    rim.position.set(2, 3, -9);
    this.scene.add(rim);
  }

  _mesh(geometry, material, parent, position) {
    this._ownedGeometries.add(geometry);
    const mesh = new THREE.Mesh(geometry, material);
    if (position) mesh.position.copy(position);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    parent.add(mesh);
    return mesh;
  }

  _buildTable() {
    const table = new THREE.Group();
    this.scene.add(table);
    const material = new THREE.MeshStandardMaterial({ color: 0x223143, metalness: 0.85, roughness: 0.42 });
    this._mesh(new THREE.BoxGeometry(13.6, 0.4, 13), material, table, v(-0.3, 0.05, 0));
    this._mesh(new THREE.BoxGeometry(13.7, 0.08, 13.1), this.materials.black, table, v(-0.3, -0.17, 0));
    const holeGeo = new THREE.CylinderGeometry(0.032, 0.032, 0.007, 8);
    const holeMat = new THREE.MeshStandardMaterial({ color: 0x080f18, metalness: 0.4, roughness: 0.65 });
    const holes = new THREE.InstancedMesh(holeGeo, holeMat, 48 * 46);
    const transform = new THREE.Object3D();
    let index = 0;
    for (let x = 0; x < 48; x++) {
      for (let z = 0; z < 46; z++) {
        transform.position.set(-6.76 + x * 0.275, 0.253, -6.19 + z * 0.275);
        transform.updateMatrix();
        holes.setMatrixAt(index++, transform.matrix);
      }
    }
    this._ownedGeometries.add(holeGeo);
    table.add(holes);
    for (const z of [-6.37, 6.37]) {
      this._mesh(new THREE.BoxGeometry(13.25, 0.015, 0.019), this.materials.silver, table, v(-0.3, 0.26, z));
    }
    const ground = this._mesh(new THREE.PlaneGeometry(180, 180), new THREE.MeshStandardMaterial({ color: 0x050b15, roughness: 0.5, metalness: 0.3 }), this.scene, v(0, -0.9, 0));
    ground.rotation.x = -Math.PI / 2;
    const badge = this._caption('ENTANGLED / OPTICAL BENCH', 'REAL-TIME PAIR EXPERIMENT', v(-3.4, 0.275, 5.8), 3.6);
    badge.rotation.x = -Math.PI / 2;
    badge.rotation.z = Math.PI;
    badge.material.opacity = 0.7;
  }

  _register(id, group, title, description, target, cameraOffset = v(2.9, 2.1, 3.3)) {
    group.traverse((obj) => {
      if (obj.isMesh) {
        obj.userData.componentId = id;
        this.pickables.push(obj);
      }
    });
    this.components.set(id, { id, group, title, description, target: target.clone(), cameraOffset });
    return group;
  }

  _caption(title, subtitle, position, width = 1.9, color) {
    const texture = captionTexture(title, subtitle, color);
    this._textures.push(texture);
    const material = new THREE.SpriteMaterial({ map: texture, transparent: true, depthWrite: false, opacity: 0.9 });
    const sprite = new THREE.Sprite(material);
    sprite.position.copy(position);
    sprite.scale.set(width, width / 4, 1);
    this.scene.add(sprite);
    this.worldLabels?.push(sprite);
    return sprite;
  }

  _mount(parent, x, z, { height = 1.17, width = 0.8 } = {}) {
    this._mesh(new THREE.BoxGeometry(width, 0.13, 0.63), this.materials.black, parent, v(x, 0.33, z));
    this._mesh(new THREE.CylinderGeometry(0.075, 0.075, height, 16), this.materials.silver, parent, v(x, 0.38 + height / 2, z));
    this._mesh(new THREE.CylinderGeometry(0.13, 0.13, 0.18, 20), this.materials.black, parent, v(x, 0.49, z));
    for (const dx of [-width * 0.34, width * 0.34]) {
      this._mesh(new THREE.CylinderGeometry(0.052, 0.052, 0.038, 6), this.materials.screws, parent, v(x + dx, 0.417, z + 0.17));
    }
    this._mesh(new THREE.CylinderGeometry(0.055, 0.055, 0.18, 14), this.materials.brass, parent, v(x + 0.11, 0.62, z)).rotation.z = Math.PI / 2;
  }

  _buildExperiment() {
    this.sourcePosition = v(-4.5, 1.58, 0);
    this.armZ = 2.72;
    this.pbsX = 1.85;
    this.detectorX = 4.75;
    this.detectorOffset = 2.9;
    this.paths = {};
    const source = new THREE.Group();
    this.scene.add(source);
    this._mount(source, -5.75, 0, { height: 1.18, width: 1.2 });
    const barrel = this._mesh(new THREE.CylinderGeometry(0.34, 0.34, 1.27, 48), this.materials.housing, source, v(-5.55, 1.58, 0));
    barrel.rotation.z = -Math.PI / 2;
    for (const x of [-6.07, -5.85, -5.63, -5.41, -5.2]) {
      const ring = this._mesh(new THREE.TorusGeometry(0.344, 0.024, 8, 48), this.materials.black, source, v(x, 1.58, 0));
      ring.rotation.y = Math.PI / 2;
    }
    const aperture = this._mesh(new THREE.CylinderGeometry(0.12, 0.12, 0.04, 32), this.materials.blue, source, v(-4.9, 1.58, 0));
    aperture.rotation.z = Math.PI / 2;
    this._mount(source, -4.47, 0, { height: 1.13, width: 0.68 });
    const crystalHolder = this._mesh(new THREE.TorusGeometry(0.33, 0.045, 12, 48), this.materials.brass, source, this.sourcePosition);
    crystalHolder.rotation.y = Math.PI / 2;
    const crystal = this._mesh(new THREE.BoxGeometry(0.18, 0.43, 0.43), this.materials.crystal, source, this.sourcePosition);
    crystal.rotation.x = Math.PI / 4;
    this.sourceGlow = new THREE.Sprite(new THREE.SpriteMaterial({ map: this.glowTexture, color: VIOLET, transparent: true, opacity: 0.36, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false }));
    this.sourceGlow.position.copy(this.sourcePosition);
    this.sourceGlow.scale.set(1.0, 1.0, 1.0);
    source.add(this.sourceGlow);
    this._caption('PAIR SOURCE', 'schematic SPDC module', v(-5.28, 2.42, 0), 2.3);
    this._register('source', source, 'Entangled pair source', 'This labeled schematic source prepares the selected singlet state. Detailed SPDC source engineering is outside this model. Neither emitted photon carries a predetermined H/V result.', this.sourcePosition, v(2.2, 1.1, 2.5));

    this.analyzers = {};
    this.pbs = {};
    for (const arm of ['a', 'b']) {
      const sign = arm === 'a' ? -1 : 1;
      const z = sign * this.armZ;
      const color = arm === 'a' ? BLUE : VIOLET;
      const prefix = [this.sourcePosition.clone(), v(-2.47, 1.58, z), v(-0.63, 1.58, z), v(this.pbsX, 1.58, z)];
      const plus = [...prefix, v(this.detectorX, 1.58, z)];
      const minus = [...prefix, v(this.pbsX, 1.58, z + sign * this.detectorOffset)];
      this.paths[arm] = { prefix, plus, minus, prefixLength: pathLength(prefix), totalLength: pathLength(plus) };
      this._buildFoldMirror(arm, prefix[1], prefix[1].clone().sub(prefix[0]).normalize());
      this._buildAnalyzer(arm, z, color);
      this._buildPBS(arm, z, sign, color);
      this._buildDetector(arm, 1, v(this.detectorX, 1.58, z), v(-1, 0, 0), color);
      this._buildDetector(arm, -1, v(this.pbsX, 1.58, z + sign * this.detectorOffset), v(0, 0, -sign), color);
      this._buildPath(prefix, arm === 'a' ? this.materials.pathA : this.materials.pathB);
      this._buildPath([prefix[prefix.length - 1], plus[plus.length - 1]], arm === 'a' ? this.materials.pathA : this.materials.pathB);
      this._buildPath([prefix[prefix.length - 1], minus[minus.length - 1]], arm === 'a' ? this.materials.pathA : this.materials.pathB);
      this._caption(`ARM ${arm.toUpperCase()}`, 'LOCAL MEASUREMENT', v(-2.48, 0.64, z + sign * 0.55), 1.55, arm === 'a' ? '#77cbff' : '#b19aff');
    }
    this.splitProgress = this.paths.a.prefixLength / this.paths.a.totalLength;
    this.measurementProgress = 1;
    this.analyzerProgress = pathLength(this.paths.a.prefix.slice(0, 3)) / this.paths.a.totalLength;
    this.updateAngles(0, 0);
    this._buildCable('a');
    this._buildCable('b');
    this._buildElectronics();
    this._buildDetectorDetail();
    this._buildHWPDetail();
    this._buildSourceDetail();
    this._buildSelectionHalo();
  }

  _buildPath(points, material) {
    for (let i = 1; i < points.length; i++) {
      const tube = cylinderBetween(points[i - 1], points[i], 0.014, material, 8);
      tube.castShadow = false;
      tube.receiveShadow = false;
      this._ownedGeometries.add(tube.geometry);
      this.scene.add(tube);
    }
  }

  _buildAnalyzer(arm, z, color) {
    const group = new THREE.Group();
    const x = -0.63;
    const localHSign = arm === 'a' ? -1 : 1;
    this.scene.add(group);
    this._mount(group, x, z);
    const body = this._mesh(new THREE.TorusGeometry(0.53, 0.09, 16, 64), this.materials.housing, group, v(x, 1.58, z));
    body.rotation.y = Math.PI / 2;
    const outer = this._mesh(new THREE.TorusGeometry(0.595, 0.021, 8, 64), this.materials.silver, group, v(x, 1.58, z));
    outer.rotation.y = Math.PI / 2;
    for (let i = 0; i < 36; i++) {
      const angle = i / 36 * Math.PI * 2;
      const tick = this._mesh(new THREE.BoxGeometry(0.02, i % 3 === 0 ? 0.065 : 0.031, 0.014), this.materials.screws, group, v(x + 0.1, 1.58 + Math.cos(angle) * 0.568, z + Math.sin(angle) * 0.568));
      tick.rotation.x = angle;
    }
    const rotor = new THREE.Group();
    rotor.position.set(x, 1.58, z);
    group.add(rotor);
    const disk = this._mesh(new THREE.CylinderGeometry(0.43, 0.43, 0.024, 64), this.materials.glass, rotor, v(0, 0, 0));
    disk.rotation.z = Math.PI / 2;
    this._mesh(new THREE.BoxGeometry(0.046, 0.014, 0.75), new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.52 }), rotor, v(0.065, 0, 0));
    const axisTip = this._mesh(new THREE.ConeGeometry(0.05, 0.085, 3), new THREE.MeshBasicMaterial({ color }), rotor, v(0.07, 0, localHSign * 0.41));
    axisTip.rotation.x = localHSign * Math.PI / 2;
    const smallHandle = this._mesh(new THREE.CylinderGeometry(0.052, 0.052, 0.14, 16), this.materials.brass, rotor, v(0, 0.52, 0));
    smallHandle.rotation.z = Math.PI / 2;
    const label = this._caption(`BASIS ${arm.toUpperCase()} · 0°`, 'HWP fast axis 0°', v(x, 2.58, z), 2.1, arm === 'a' ? '#83cfff' : '#c2a7ff');
    this.analyzers[arm] = { group, rotor, label, angle: 0, desiredAngle: 0 };
    this._register(`analyzer-${arm}`, group, `Half-wave plate ${arm.toUpperCase()}`, 'The half-wave plate fast axis rotates by half the effective analyzer angle: HWP = θ/2. The fixed PBS remains H-transmitting and V-reflecting. At θ = 0° detector ± means incoming H/V; at θ = 45° it means incoming D/A.', v(x, 1.58, z), v(2.1, 1.2, 1.9));
  }

  _buildFoldMirror(arm, position, incoming) {
    const group = new THREE.Group();
    this.scene.add(group);
    this._mount(group, position.x, position.z, { height: 1.15, width: 0.74 });
    const normal = incoming.clone().sub(v(1, 0, 0)).normalize();
    const mirror = this._mesh(new THREE.CylinderGeometry(0.235, 0.235, 0.035, 48), new THREE.MeshStandardMaterial({ color: 0xbfd6e8, metalness: 1, roughness: 0.05 }), group, position);
    mirror.quaternion.setFromUnitVectors(UP, normal);
    const mount = this._mesh(new THREE.TorusGeometry(0.27, 0.042, 12, 48), this.materials.housing, group, position);
    mount.quaternion.setFromUnitVectors(v(0, 0, 1), normal);
    const back = this._mesh(new THREE.CylinderGeometry(0.27, 0.27, 0.10, 48), this.materials.black, group, position.clone().addScaledVector(normal, -0.045));
    back.quaternion.copy(mirror.quaternion);
    this._register(`mirror-${arm}`, group, `Arm ${arm.toUpperCase()} folding mirror`, 'The kinematic mirror steers this arm toward its half-wave plate and fixed PBS. The illustrated trajectories indicate optical alignment rather than an observed path of an undetected photon.', position, v(1.4, 1.0, 1.65));
  }

  _buildPBS(arm, z, sign, color) {
    const group = new THREE.Group();
    this.scene.add(group);
    this._mount(group, this.pbsX, z, { height: 1.01, width: 0.88 });
    this._mesh(new THREE.BoxGeometry(0.84, 0.1, 0.84), this.materials.black, group, v(this.pbsX, 1.14, z));
    const size = 0.76;
    const cube = this._mesh(new THREE.BoxGeometry(size, size, size), this.materials.glass.clone(), group, v(this.pbsX, 1.58, z));
    cube.castShadow = false;
    const edges = new THREE.LineSegments(new THREE.EdgesGeometry(cube.geometry), new THREE.LineBasicMaterial({ color: 0xb8dcf6, transparent: true, opacity: 0.46 }));
    edges.position.copy(cube.position);
    group.add(edges);
    this._ownedGeometries.add(edges.geometry);
    const diagonal = this._mesh(new THREE.PlaneGeometry(size * Math.SQRT2, size * 0.98), this.materials.plane, group, v(this.pbsX, 1.58, z));
    diagonal.rotation.y = sign * Math.PI / 4;
    diagonal.castShadow = false;
    const border = this._mesh(new THREE.BoxGeometry(0.016, size * 0.99, 0.016), new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.6 }), group, v(this.pbsX, 1.58, z));
    border.rotation.y = sign * Math.PI / 4;
    const interior = new THREE.Group();
    interior.position.copy(cube.position);
    interior.visible = false;
    group.add(interior);
    const normal = v(sign, 0, 1).normalize();
    const prisms = [];
    for (let half = 0; half < 2; half++) {
      const material = this.materials.glass.clone();
      material.opacity = 0.28;
      material.transmission = 0.55;
      material.roughness = 0.08;
      const prism = this._mesh(rightAnglePrism(size, sign, half), material, interior, v(0, 0, 0));
      prism.castShadow = false;
      prism.renderOrder = 2 + half;
      const wire = new THREE.LineSegments(new THREE.EdgesGeometry(prism.geometry), new THREE.LineBasicMaterial({ color: 0xc1e3ff, transparent: true, opacity: 0.66 }));
      prism.add(wire);
      this._ownedGeometries.add(wire.geometry);
      prisms.push(prism);
    }
    const coating = this._mesh(new THREE.PlaneGeometry(size * Math.SQRT2, size), new THREE.MeshBasicMaterial({ color: 0xb794ff, transparent: true, opacity: 0.44, side: THREE.DoubleSide, depthWrite: false }), interior, v(0, 0, 0));
    coating.rotation.y = sign * Math.PI / 4;
    coating.renderOrder = 6;
    const incidence = this._mesh(new THREE.PlaneGeometry(2.0, 1.65), new THREE.MeshBasicMaterial({ color: BLUE, transparent: true, opacity: 0.048, side: THREE.DoubleSide, depthWrite: false }), interior, v(0, 0, 0));
    incidence.rotation.x = Math.PI / 2;
    const layers = new THREE.Group();
    layers.position.set(0.05, 1.18, sign * 0.40);
    layers.visible = false;
    interior.add(layers);
    const layerMeshes = [];
    for (let i = 0; i < 7; i++) {
      const mesh = this._mesh(new THREE.BoxGeometry(1.12, 0.016, 0.56), new THREE.MeshStandardMaterial({ color: i % 2 ? 0x8e71b6 : 0x6aa9c8, transparent: true, opacity: 0.56, roughness: 0.32, metalness: 0.2, depthWrite: false }), layers, v(0, i * 0.085, 0));
      layerMeshes.push(mesh);
    }
    const interference = [];
    for (let index = 0; index < 3; index++) {
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(64 * 3), 3));
      const line = new THREE.Line(geometry, new THREE.LineBasicMaterial({ color: index === 2 ? VIOLET : BLUE, transparent: true, opacity: 0.72, depthWrite: false, toneMapped: false }));
      line.frustumCulled = false;
      layers.add(line);
      this._ownedGeometries.add(geometry);
      interference.push(line);
    }
    const pArrow = new THREE.ArrowHelper(v(0, 0, sign), v(-0.83, 0, 0), 0.48, BLUE, 0.08, 0.04);
    const sArrow = new THREE.ArrowHelper(v(0, 1, 0), v(-0.83, 0, 0), 0.48, VIOLET, 0.08, 0.04);
    const inputArrow = new THREE.ArrowHelper(v(1, 0, 0), v(-1.35, 0, 0), 0.7, CYAN, 0.08, 0.04);
    interior.add(pArrow, sArrow, inputArrow);
    this.pbs[arm] = { group, cube, edges, diagonal, border, interior, prisms, coating, normal, layers, layerMeshes, interference, pArrow, sArrow, inputArrow, explosion: 0 };
    this._caption(`PBS ${arm.toUpperCase()}`, 'polarizing beam splitter', v(this.pbsX, 2.41, z), 2.0);
    this._caption('+ · H', '', v(this.pbsX + 0.73, 1.83, z), 0.68, '#a0d8ff');
    this._caption('− · V', '', v(this.pbsX, 1.83, z + sign * 0.72), 0.68, '#b8a3ff');
    this._register(`pbs-${arm}`, group, `Transparent PBS cube ${arm.toUpperCase()}`, 'The fixed diagonal coating coherently transmits H and reflects V. Before absorption, the two outgoing strokes illustrate possible output amplitudes, not two photon copies or measured trajectories. A recorded projective outcome is produced only at a SPAD click.', v(this.pbsX, 1.58, z), v(1.8, 1.15, sign * 1.8));
  }

  _buildDetector(arm, outcome, position, facing, color) {
    const id = `detector-${arm}-${outcome === 1 ? 'plus' : 'minus'}`;
    const group = new THREE.Group();
    this.scene.add(group);
    const local = new THREE.Group();
    local.position.copy(position);
    local.quaternion.setFromUnitVectors(v(-1, 0, 0), facing);
    group.add(local);
    this._mount(group, position.x + (facing.x ? 0.36 : 0), position.z + (facing.z ? -facing.z * 0.36 : 0), { height: 1.17, width: 0.9 });
    const housingBody = this._mesh(new THREE.BoxGeometry(0.93, 0.73, 0.78), this.materials.housing, local, v(0.36, 0, 0));
    const housingFace = this._mesh(new THREE.BoxGeometry(0.14, 0.81, 0.84), this.materials.black, local, v(-0.08, 0, 0));
    const aperture = this._mesh(new THREE.CylinderGeometry(0.22, 0.22, 0.19, 48), this.materials.black, local, v(-0.22, 0, 0));
    aperture.rotation.z = Math.PI / 2;
    const sensor = this._mesh(new THREE.CylinderGeometry(0.13, 0.13, 0.022, 48), new THREE.MeshStandardMaterial({ color: 0x294058, metalness: 0.65, roughness: 0.16, emissive: color, emissiveIntensity: 0.2 }), local, v(-0.325, 0, 0));
    sensor.rotation.z = Math.PI / 2;
    const rim = this._mesh(new THREE.TorusGeometry(0.225, 0.022, 8, 48), this.materials.silver, local, v(-0.32, 0, 0));
    rim.rotation.y = Math.PI / 2;
    for (const y of [-0.28, 0.28]) {
      for (const z of [-0.31, 0.31]) {
        const screw = this._mesh(new THREE.CylinderGeometry(0.035, 0.035, 0.018, 6), this.materials.screws, local, v(-0.16, y, z));
        screw.rotation.z = Math.PI / 2;
      }
    }
    for (let x = 0.05; x < 0.74; x += 0.1) {
      this._mesh(new THREE.BoxGeometry(0.018, 0.022, 0.72), this.materials.silver, local, v(x, 0.37, 0));
    }
    const indicatorMaterial = new THREE.MeshBasicMaterial({ color: 0x1e4f67, toneMapped: false });
    this._mesh(new THREE.SphereGeometry(0.044, 12, 8), indicatorMaterial, local, v(0.06, 0.32, 0.397));
    const flash = new THREE.Sprite(new THREE.SpriteMaterial({ map: this.glowTexture, color, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false }));
    flash.position.copy(position).addScaledVector(facing, 0.34);
    flash.scale.set(1.15, 1.15, 1.15);
    group.add(flash);
    const traceMaterial = new THREE.MeshBasicMaterial({ color: outcome === 1 ? BLUE : VIOLET, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false });
    const trace = cylinderBetween(v(this.pbsX, 1.58, (arm === 'a' ? -1 : 1) * this.armZ), position, 0.019, traceMaterial, 8);
    trace.castShadow = false;
    trace.receiveShadow = false;
    group.add(trace);
    this._ownedGeometries.add(trace.geometry);
    this._caption(`${arm.toUpperCase()}${outcome === 1 ? '+' : '−'}`, 'SPAD', position.clone().add(v(0.1, 0.8, 0)), 1.2, arm === 'a' ? '#83cfff' : '#c2a7ff');
    const info = { group, flash, traceMaterial, sensor, indicatorMaterial, housing: [housingBody, housingFace], facing, pulse: 0, color, arm, outcome, position };
    this.detectors.set(id, info);
    const cameraOffset = facing.clone().multiplyScalar(4.0).add(v(0, 1.8, 0)).add(facing.x ? v(0, 0, 3.0) : v(3.0, 0, 0));
    this._register(id, group, `SPAD ${arm.toUpperCase()}${outcome === 1 ? '+' : '−'}`, 'A single-photon avalanche detector converts one photon arrival into a recorded click. Every visible flash is tied to this pair’s detector outcome and simulated timestamp in the event stream.', position.clone().add(v(0, 0.48, 0)), cameraOffset);
  }

  _buildCable(arm) {
    const sign = arm === 'a' ? -1 : 1;
    for (const outcome of [1, -1]) {
      const id = `detector-${arm}-${outcome === 1 ? 'plus' : 'minus'}`;
      const position = this.detectors.get(id).position;
      const taggerChannel = (arm === 'a' ? 0 : 2) + (outcome === 1 ? 0 : 1);
      const destination = v(-1.9 - 0.73 + taggerChannel * 0.47, 0.48, 5.36);
      const start = outcome === 1 ? position.clone().add(v(0.87, 0, 0)) : position.clone().add(v(0, 0, sign * 0.87));
      const edgeX = 6.08 - taggerChannel * 0.10;
      const edgeZ = sign * 6.12;
      const points = outcome === 1
        ? [start, v(edgeX, 0.85, start.z + 0.18), v(edgeX, 0.31, start.z + 0.7), v(edgeX, 0.31, 5.94 - taggerChannel * 0.1), v(0.2, 0.32, 6.05 - taggerChannel * 0.1), destination]
        : [start, v(start.x + 0.4, 0.77, edgeZ), v(start.x + 0.95, 0.31, edgeZ), v(edgeX, 0.32, edgeZ), v(edgeX, 0.32, 5.87 - taggerChannel * 0.07), v(-0.2, 0.33, 5.93 - taggerChannel * 0.08), destination];
      const curve = new THREE.CatmullRomCurve3(points);
      this._mesh(new THREE.TubeGeometry(curve, 72, 0.027, 8, false), this.materials.black, this.scene);
      if (!this.cables) this.cables = new Map();
      const pulseGeometry = new THREE.BufferGeometry();
      pulseGeometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(36 * 3), 3));
      const pulse = new THREE.Line(pulseGeometry, new THREE.LineBasicMaterial({ color: arm === 'a' ? BLUE : VIOLET, transparent: true, opacity: 0.8, depthWrite: false, toneMapped: false }));
      pulse.visible = false;
      pulse.frustumCulled = false;
      this.scene.add(pulse);
      this._ownedGeometries.add(pulseGeometry);
      this.cables.set(id, { curve, pulse, channel: taggerChannel });
    }
  }

  _buildSelectionHalo() {
    this.selectionHalo = new THREE.Mesh(new THREE.TorusGeometry(0.76, 0.013, 8, 72), new THREE.MeshBasicMaterial({ color: 0x79caff, transparent: true, opacity: 0.45, depthWrite: false }));
    this.selectionHalo.rotation.x = Math.PI / 2;
    this.selectionHalo.visible = false;
    this.scene.add(this.selectionHalo);
    this._ownedGeometries.add(this.selectionHalo.geometry);
  }

  _buildElectronics() {
    const group = new THREE.Group();
    this.scene.add(group);
    const center = v(-1.9, 0.59, 4.7);
    this._mesh(new THREE.BoxGeometry(2.1, 0.55, 1.22), this.materials.housing, group, center);
    this._mesh(new THREE.BoxGeometry(2.17, 0.04, 1.28), this.materials.silver, group, center.clone().add(v(0, 0.3, 0)));
    this._mesh(new THREE.BoxGeometry(1.26, 0.21, 0.026), this.materials.black, group, center.clone().add(v(0.19, 0.05, 0.63)));
    this.taggerLeds = [];
    for (let i = 0; i < 4; i++) {
      const port = this._mesh(new THREE.CylinderGeometry(0.063, 0.063, 0.1, 20), this.materials.brass, group, center.clone().add(v(-0.73 + i * 0.47, -0.09, 0.66)));
      port.rotation.x = Math.PI / 2;
      const ledMaterial = new THREE.MeshBasicMaterial({ color: i < 2 ? BLUE : VIOLET, toneMapped: false });
      this._mesh(new THREE.SphereGeometry(0.025, 10, 8), ledMaterial, group, center.clone().add(v(-0.73 + i * 0.47, 0.15, 0.626)));
      this.taggerLeds.push({ material: ledMaterial, pulse: 0, color: i < 2 ? BLUE : VIOLET });
    }
    for (let i = 0; i < 8; i++) {
      this._mesh(new THREE.BoxGeometry(0.43, 0.012, 0.026), this.materials.black, group, center.clone().add(v(-0.48, 0.325, -0.38 + i * 0.1)));
    }
    this._caption('TIME TAGGER', '4 channels · coincidence records', center.clone().add(v(0, 0.83, 0)), 2.5);
    const detail = new THREE.Group();
    detail.position.copy(center).add(v(0, 0.60, 0));
    detail.visible = false;
    group.add(detail);
    this._mesh(new THREE.BoxGeometry(1.82, 0.035, 1.1), this.materials.pcb, detail, v(0, 0, 0));
    const traces = [];
    for (let i = 0; i < 4; i++) {
      this._mesh(new THREE.BoxGeometry(0.23, 0.065, 0.16), this.materials.black, detail, v(-0.55, 0.05, -0.37 + i * 0.25));
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(64 * 3), 3));
      const trace = new THREE.Line(geometry, new THREE.LineBasicMaterial({ color: i < 2 ? BLUE : VIOLET, transparent: true, opacity: 0.80, toneMapped: false }));
      trace.frustumCulled = false;
      detail.add(trace);
      this._ownedGeometries.add(geometry);
      traces.push(trace);
    }
    this._mesh(new THREE.BoxGeometry(0.43, 0.06, 0.56), this.materials.black, detail, v(0.55, 0.06, 0));
    this.taggerDetail = { group: detail, traces };
    this._register('electronics', group, 'Coincidence electronics', 'Each avalanche produces an electrical pulse and a simulated timestamp. The time tagger stores four detector channels. Pair identifiers are educational truth labels; timestamp-only instrument coincidence matching is a separate model.', center, v(1.6, 1.4, 2.3));
  }

  _buildDetectorDetail() {
    const group = new THREE.Group();
    group.visible = false;
    this.scene.add(group);
    const layerMaterial = (color, opacity) => new THREE.MeshPhysicalMaterial({ color, transparent: true, opacity, roughness: 0.22, metalness: 0.12, side: THREE.DoubleSide, depthWrite: false });
    const layerData = [
      { y: 0.1, color: 0x5f84b7, opacity: 0.62 },
      { y: -0.02, color: 0x8a68b5, opacity: 0.5 },
      { y: -0.14, color: 0x4d83ac, opacity: 0.54 },
    ];
    const semiconductor = layerData.map(layer => this._mesh(new THREE.BoxGeometry(0.92, 0.085, 0.65), layerMaterial(layer.color, layer.opacity), group, v(0, layer.y, 0)));
    const window = this._mesh(new THREE.BoxGeometry(1.04, 0.025, 0.76), this.materials.glass.clone(), group, v(0, 0.38, 0));
    window.material.opacity = 0.38;
    const activeArea = this._mesh(new THREE.CylinderGeometry(0.19, 0.19, 0.018, 32), new THREE.MeshBasicMaterial({ color: 0x8bcdf0, transparent: true, opacity: 0.22, depthWrite: false }), group, v(0, 0.168, 0));
    const fieldMaterial = new THREE.MeshBasicMaterial({ color: 0xa0caff, transparent: true, opacity: 0.08, depthWrite: false });
    const highField = this._mesh(new THREE.BoxGeometry(0.75, 0.074, 0.54), fieldMaterial, group, v(0, -0.02, 0));
    const fieldArrows = [];
    for (let i = 0; i < 5; i++) {
      const arrow = new THREE.ArrowHelper(v(0, -1, 0), v(-0.32 + i * 0.16, 0.105, 0.25), 0.21, 0x9aceff, 0.035, 0.018);
      group.add(arrow);
      fieldArrows.push(arrow);
    }
    this._mesh(new THREE.BoxGeometry(1.0, 0.027, 0.72), this.materials.pcb, group, v(0, -0.22, 0));
    for (const x of [-0.39, 0.39]) {
      this._mesh(new THREE.BoxGeometry(0.07, 0.027, 0.58), this.materials.brass, group, v(x, 0.16, 0));
    }
    const circuit = new THREE.Group();
    circuit.position.set(0.92, -0.22, 0);
    group.add(circuit);
    this._mesh(new THREE.BoxGeometry(0.93, 0.032, 0.65), this.materials.pcb, circuit, v(0, 0, 0));
    const traceMaterial = new THREE.MeshBasicMaterial({ color: 0x9d8b5c });
    for (const z of [-0.20, 0.19]) this._mesh(new THREE.BoxGeometry(0.86, 0.012, 0.012), traceMaterial, circuit, v(-0.02, 0.03, z));
    const resistor = this._mesh(new THREE.CylinderGeometry(0.04, 0.04, 0.25, 12), new THREE.MeshStandardMaterial({ color: 0xb79672, roughness: 0.6 }), circuit, v(-0.2, 0.085, -0.2));
    resistor.rotation.z = Math.PI / 2;
    for (const x of [-0.07, 0, 0.07]) {
      const band = this._mesh(new THREE.TorusGeometry(0.042, 0.007, 6, 12), new THREE.MeshBasicMaterial({ color: x ? 0x624786 : 0x2b172b }), circuit, v(-0.2 + x, 0.085, -0.2));
      band.rotation.y = Math.PI / 2;
    }
    this._mesh(new THREE.BoxGeometry(0.26, 0.07, 0.20), this.materials.black, circuit, v(0.17, 0.065, 0.16));
    for (const x of [0.08, 0.16, 0.24]) for (const z of [0.02, 0.31]) this._mesh(new THREE.BoxGeometry(0.015, 0.026, 0.075), this.materials.silver, circuit, v(x, 0.04, z));
    const quench = this._mesh(new THREE.SphereGeometry(0.035, 12, 8), new THREE.MeshBasicMaterial({ color: 0x54706a, toneMapped: false }), circuit, v(0.30, 0.092, -0.22));
    const frameGeometry = new THREE.BoxGeometry(1.31, 0.87, 0.93);
    const frameEdges = new THREE.LineSegments(new THREE.EdgesGeometry(frameGeometry), new THREE.LineBasicMaterial({ color: 0x639cd2, transparent: true, opacity: 0.28 }));
    frameEdges.position.y = -0.05;
    group.add(frameEdges);
    frameGeometry.dispose();
    this._ownedGeometries.add(frameEdges.geometry);
    const absorbed = new THREE.Sprite(new THREE.SpriteMaterial({ map: this.glowTexture, color: CYAN, transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false }));
    absorbed.scale.set(0.35, 0.35, 0.35);
    absorbed.position.set(0, 0.18, 0);
    group.add(absorbed);
    const incidentGeometry = new THREE.BufferGeometry();
    incidentGeometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(48 * 3), 3));
    const incidentPacket = new THREE.Line(incidentGeometry, new THREE.LineBasicMaterial({ color: CYAN, transparent: true, opacity: 0.8, depthWrite: false, toneMapped: false }));
    incidentPacket.frustumCulled = false;
    group.add(incidentPacket);
    this._ownedGeometries.add(incidentGeometry);
    const electrons = [];
    for (let i = 0; i < 14; i++) {
      const electron = this._mesh(new THREE.SphereGeometry(0.021, 10, 6), new THREE.MeshBasicMaterial({ color: i % 2 ? BLUE : VIOLET, transparent: true, opacity: 0, depthWrite: false, toneMapped: false }), group, v(0, 0, 0));
      electron.castShadow = false;
      electrons.push(electron);
    }
    const signalGeometry = new THREE.BufferGeometry();
    signalGeometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(48 * 3), 3));
    const signal = new THREE.Line(signalGeometry, new THREE.LineBasicMaterial({ color: CYAN, transparent: true, opacity: 0, depthWrite: false, toneMapped: false }));
    signal.frustumCulled = false;
    group.add(signal);
    this._ownedGeometries.add(signalGeometry);
    const label = this._caption('SPAD CUTAWAY', 'explanatory illustration', v(0, 0, 0), 1.95, '#98c4e9');
    this.scene.remove(label);
    label.position.set(0, 0.76, 0);
    group.add(label);
    this.detectorDetail = { group, absorbed, incidentPacket, electrons, signal, signalGeometry, label, semiconductor, window, activeArea, highField, fieldArrows, circuit, resistor, quench, age: 100, selectedId: null };
  }

  _buildSourceDetail() {
    const group = new THREE.Group();
    group.position.copy(this.sourcePosition);
    group.visible = false;
    this.scene.add(group);
    const enclosure = this._mesh(new THREE.BoxGeometry(1.35, 0.92, 0.95), this.materials.glass.clone(), group, v(-0.28, 0.05, 0));
    enclosure.material.opacity = 0.15;
    this._mesh(new THREE.BoxGeometry(0.08, 0.63, 0.63), this.materials.crystal.clone(), group, v(-0.15, 0.1, 0));
    const pump = cylinderBetween(v(-1.25, 0.1, 0), v(-0.19, 0.1, 0), 0.02, new THREE.MeshBasicMaterial({ color: 0xa191ff, transparent: true, opacity: 0.52, toneMapped: false }));
    group.add(pump);
    this._ownedGeometries.add(pump.geometry);
    const alternatives = [];
    for (const offset of [-0.13, 0.13]) {
      const line = cylinderBetween(v(0.02, offset, 0), v(0.68, offset, 0), 0.018, new THREE.MeshBasicMaterial({ color: offset < 0 ? BLUE : VIOLET, transparent: true, opacity: 0.72, toneMapped: false }));
      group.add(line);
      alternatives.push(line);
      this._ownedGeometries.add(line.geometry);
    }
    this.sourceDetail = { group, pump, alternatives };
  }

  _buildHWPDetail() {
    const group = new THREE.Group();
    group.visible = false;
    this.scene.add(group);
    const axes = new THREE.Group();
    group.add(axes);
    const fastAxis = new THREE.ArrowHelper(v(0, 0, -1), v(0, 0, 0), 0.75, CYAN, 0.1, 0.05);
    const slowAxis = new THREE.ArrowHelper(v(0, 1, 0), v(0, 0, 0), 0.75, VIOLET, 0.1, 0.05);
    axes.add(fastAxis, slowAxis);
    const enlarged = this._mesh(new THREE.BoxGeometry(0.08, 1.18, 1.18), this.materials.glass.clone(), group, v(0.1, 0, 0));
    enlarged.material.opacity = 0.2;
    const waves = [];
    for (const color of [CYAN, VIOLET]) {
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(80 * 3), 3));
      const wave = new THREE.Line(geometry, new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.85, depthWrite: false, toneMapped: false }));
      wave.frustumCulled = false;
      group.add(wave);
      waves.push(wave);
      this._ownedGeometries.add(geometry);
    }
    this.hwpDetail = { group, axes, fastAxis, slowAxis, waves, enlarged, arm: 'a' };
  }

  _buildTimelineVisual() {
    const group = new THREE.Group();
    this.scene.add(group);
    const lines = {};
    for (const arm of ['a', 'b']) {
      lines[arm] = {};
      for (const channel of ['input', 'plus', 'minus']) {
        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(72 * 3), 3));
        const material = new THREE.LineBasicMaterial({ color: arm === 'a' ? BLUE : VIOLET, transparent: true, opacity: 0.76, depthWrite: false, toneMapped: false });
        const line = new THREE.Line(geometry, material);
        line.frustumCulled = false;
        line.visible = false;
        group.add(line);
        this._ownedGeometries.add(geometry);
        lines[arm][channel] = line;
      }
    }
    this.timelineVisual = { group, lines };
  }

  _updateDetectorDetail(dt) {
    const detail = this.detectorDetail;
    if (!detail?.group.visible) return;
    detail.age += dt;
    const progress = detail.age / 1.6;
    detail.absorbed.material.opacity = progress < 0.25 ? Math.sin(clamp(progress / 0.25, 0, 1) * Math.PI) * 0.9 : 0;
    for (let i = 0; i < detail.electrons.length; i++) {
      const electron = detail.electrons[i];
      const born = 0.1 + i * 0.019;
      const life = (progress - born) / 0.45;
      const active = life > 0 && life < 1;
      electron.material.opacity = active ? Math.sin(life * Math.PI) * 0.9 : 0;
      electron.position.set(
        Math.sin(i * 2.39) * 0.31 * clamp(life * 1.5, 0, 1),
        0.12 - clamp(life, 0, 1) * 0.31,
        Math.cos(i * 3.11) * 0.21 * clamp(life * 1.5, 0, 1),
      );
    }
    const pulseProgress = clamp((progress - 0.55) / 0.4, 0, 1);
    detail.signal.material.opacity = progress > 0.55 && progress < 1 ? 0.85 : 0;
    const position = detail.signalGeometry.attributes.position;
    for (let i = 0; i < 48; i++) {
      const t = i / 47;
      const pulse = Math.exp(-Math.pow((t - pulseProgress) / 0.043, 2)) * 0.24;
      position.setXYZ(i, 0.5 + t * 0.82, -0.19 + pulse, 0.22);
    }
    position.needsUpdate = true;
  }

  _pick(event) {
    const start = this._pointerStart;
    this._pointerStart = null;
    if (!start || Math.hypot(event.clientX - start.x, event.clientY - start.y) > 6 || performance.now() - start.time > 650) return;
    const rect = this.renderer.domElement.getBoundingClientRect();
    this.pointer.set((event.clientX - rect.left) / rect.width * 2 - 1, -(event.clientY - rect.top) / rect.height * 2 + 1);
    this.raycaster.setFromCamera(this.pointer, this.camera);
    const visible = this.pickables.filter(object => {
      let parent = object;
      while (parent) { if (!parent.visible) return false; parent = parent.parent; }
      return !object.material?.transparent || object.material.opacity > 0.03;
    });
    const hit = this.raycaster.intersectObjects(visible, false)[0];
    if (!hit) return;
    const component = this.components.get(hit.object.userData.componentId);
    if (!component) return;
    this._select(component);
    this._fly(component.target.clone().add(component.cameraOffset), component.target, this._reducedMotion ? 0.01 : 1.25);
    this.onInspect({ id: component.id, title: component.title, description: component.description, record: this.detectors.get(component.id)?.lastRecord });
  }

  _select(component) {
    this._selected = component.id;
    this.selectionHalo.position.set(component.target.x, 0.28, component.target.z);
    this.selectionHalo.visible = true;
    if (this.detectorDetail) {
      const detector = this.detectors.get(component.id);
      this.detectorDetail.group.visible = Boolean(detector);
      this.detectorDetail.selectedId = detector ? component.id : null;
      if (detector) {
        this.detectorDetail.group.position.copy(detector.position).add(v(-0.25, 1.0, 0.25));
      }
    }
    if (this._timelineMode) {
      if (component.id.startsWith('pbs-')) this.setCutaway('pbs', component.id.slice(-1), 1);
      else if (component.id.startsWith('analyzer-')) this.setCutaway('hwp', component.id.slice(-1), 1);
      else if (component.id.startsWith('detector-')) this.setCutaway('detector', component.id, 1);
      else if (component.id === 'source') this.setCutaway('source', 'a', 1);
      else this.setCutaway('none', 'a', 0);
    }
  }

  resize() {
    if (this._disposed) return;
    const width = Math.max(1, this.container.clientWidth);
    const height = Math.max(1, this.container.clientHeight);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(width, height, false);
  }

  projectComponent(id) {
    const aliases = { hwp: 'analyzer-a', pbs: 'pbs-a', 'inside-pbs': 'pbs-a', detector: 'detector-a-plus', alice: 'analyzer-a', bob: 'analyzer-b', 'time-tagger': 'electronics' };
    const component = this.components.get(aliases[id] ?? id);
    if (!component) return null;
    this.camera.updateMatrixWorld();
    const point = component.target.clone().project(this.camera);
    return {
      x: (point.x + 1) * this.container.clientWidth / 2,
      y: (1 - point.y) * this.container.clientHeight / 2,
      visible: point.z >= -1 && point.z <= 1 && Math.abs(point.x) <= 1 && Math.abs(point.y) <= 1,
    };
  }

  updateAngles(a, b) {
    if (!this.analyzers) return;
    for (const [arm, degrees] of [['a', a], ['b', b]]) {
      const analyzer = this.analyzers[arm];
      if (!analyzer || !Number.isFinite(degrees)) continue;
      if (analyzer.angle === degrees && analyzer.label.material.map) continue;
      // H/p is transverse ±z in each mirrored arm; V/s is +y.
      analyzer.desiredAngle = (arm === 'a' ? 1 : -1) * THREE.MathUtils.degToRad(degrees / 2);
      analyzer.angle = degrees;
      const texture = captionTexture(`BASIS ${arm.toUpperCase()} · ${degrees.toFixed(1)}°`, `HWP fast axis ${(degrees / 2).toFixed(1)}°`, arm === 'a' ? '#83cfff' : '#c2a7ff');
      const old = analyzer.label.material.map;
      analyzer.label.material.map = texture;
      analyzer.label.material.needsUpdate = true;
      old.dispose();
      const index = this._textures.indexOf(old);
      if (index >= 0) this._textures[index] = texture;
      else this._textures.push(texture);
    }
  }

  setMode(mode) { this.setSource(mode); }
  setSource(mode) {
    this._sourceMode = mode;
    const isMixture = ['classical', 'correlated', 'mixture'].includes(mode);
    this.sourceGlow.material.color.set(isMixture ? BLUE : VIOLET);
    const source = this.components.get('source');
    if (source) {
      source.title = isMixture ? 'Ordinary correlated source' : 'Entangled pair source';
      source.description = isMixture
        ? 'This separable correlated source is an equal HV/VH mixture. It anticorrelates in H/V, but gives four equally likely results when both effective bases rotate to 45°.'
        : 'This schematic SPDC module prepares the selected singlet state; detailed source engineering is outside the model. Neither emitted photon carries a predetermined H/V result.';
    }
  }

  setSpeed(speed) { this.speed = clamp(Number(speed) || 1, 0.05, 100); }
  setPaused(paused) { this.paused = Boolean(paused); }

  setAnalyzerAngles(a, b) {
    this.updateAngles(a, b);
    // An explicit setting update is a model snapshot, not a time-based rotor.
    for (const analyzer of Object.values(this.analyzers ?? {})) analyzer.rotor.rotation.x = analyzer.desiredAngle;
  }

  setCameraTransition(seconds) {
    this.cameraTransition = clamp(Number(seconds) || 0.01, 0.01, 12);
  }

  _releaseGuidedCamera(reason = 'manual-bookmark') {
    this.guidedCamera = false;
    this._cameraFlight = null;
    this.onCameraOverride?.({ guidedCamera: false, reason });
  }

  resumeGuidedCamera() {
    this.guidedCamera = true;
    this._cutawayOverride = null;
    this._cutawayDirty = true;
    if (this.timelineState) this._stageCamera(this.timelineState);
    this.onCameraOverride?.({ guidedCamera: true, reason: 'resume' });
  }

  _stageCamera(state) {
    const stage = state.stageIndex;
    const record = state.record ?? {};
    const detectorArm = stage === 7 ? 'b' : 'a';
    const outcome = outcomeOf(record, detectorArm) ?? 1;
    const detector = this.detectors.get(`detector-${detectorArm}-${outcome === 1 ? 'plus' : 'minus'}`);
    const positions = {
      0: [v(11.8, 11, 13.7), v(0, 0.5, 0)],
      1: [v(-1.9, 3.5, 3.8), this.sourcePosition.clone().add(v(-0.2, 0.25, 0))],
      2: [v(6.8, 7.9, 10.3), v(-1.6, 1.2, 0)],
      3: [v(2.4, 3.5, -0.1), v(-0.5, 1.75, -this.armZ)],
      4: [v(5.25, 4.3, 0.45), v(this.pbsX, 2.0, -this.armZ)],
      5: [v(9.4, 8.5, 10.4), v(1.8, 1.6, 0)],
      8: [v(1.4, 3.3, 8.3), v(-1.4, 0.85, 4.7)],
      9: [v(11.8, 11, 13.7), v(0, 0.5, 0)],
    };
    if ((stage === 6 || stage === 7) && detector) {
      const component = this.components.get(`detector-${detectorArm}-${outcome === 1 ? 'plus' : 'minus'}`);
      this._fly(component.target.clone().add(component.cameraOffset), component.target, this.cameraTransition);
      return;
    }
    const pose = positions[stage] ?? positions[0];
    this._fly(pose[0], pose[1], this.cameraTransition);
  }

  /** Render one authoritative seekable snapshot. Never sample, commit, or mutate it. */
  setTimelineState(state) {
    if (!state || this._disposed) return;
    this._timelineMode = true;
    this.timelineState = { ...state };
    this.paused = Boolean(state.paused);
    for (const label of this.worldLabels ?? []) label.visible = false;
    for (const pair of this.pairs) pair.group.visible = false;
    this.controls.autoRotate = false;
    if (this._pbsInspector) {
      this._renderPBSExample();
      return;
    }
    const changedStage = this._timelineStage !== state.stageIndex;
    this._timelineStage = state.stageIndex;
    if (changedStage) {
      this._cutawayOverride = null;
      if (this.guidedCamera) this._stageCamera(state);
    }
    const renderKey = [state.stageIndex, state.stageProgress, state.time, state.detectionsVisible,
      (state.detectedArms ?? []).join(','), state.microIndex, state.phase].join('|');
    if (renderKey !== this._timelineRenderKey || state.record !== this._lastRenderedRecord || this._cutawayDirty) {
      this._renderTimeline(this.timelineState);
      this._timelineRenderKey = renderKey;
      this._lastRenderedRecord = state.record;
      this._cutawayDirty = false;
    }
  }

  setCutaway(type, target = 'a', progress = 1) {
    const normalized = type === 'inside-pbs' ? 'pbs' : type === 'spad' ? 'detector' : type;
    this._cutawayOverride = { type: normalized, target, progress: clamp(Number(progress), 0, 1) };
    this._cutawayDirty = true;
    this._applyCutaway(normalized, target, clamp(Number(progress), 0, 1));
  }

  _applyCutaway(type, target = 'a', progress = 1) {
    for (const [arm, pbs] of Object.entries(this.pbs ?? {})) {
      const active = type === 'pbs' && (target === 'both' || target === arm || target === `pbs-${arm}`);
      pbs.interior.visible = active;
      pbs.cube.visible = !active || progress < 0.22;
      pbs.edges.visible = !active;
      pbs.diagonal.visible = !active;
      pbs.border.visible = !active;
      pbs.explosion = active ? progress : 0;
      pbs.prisms.forEach((prism, index) => prism.position.copy(pbs.normal).multiplyScalar((index ? -1 : 1) * progress * 0.46));
      pbs.layers.visible = active && progress > 0.46;
    }
    if (this.sourceDetail) this.sourceDetail.group.visible = type === 'source';
    if (this.taggerDetail) this.taggerDetail.group.visible = type === 'electronics';
    if (this.hwpDetail) {
      this.hwpDetail.group.visible = type === 'hwp';
      if (type === 'hwp') {
        const arm = String(target).includes('b') ? 'b' : 'a';
        this.hwpDetail.arm = arm;
        this.hwpDetail.group.position.copy(this.analyzers[arm].rotor.position).add(v(0.05, 0, 0));
        this.hwpDetail.axes.rotation.x = this.analyzers[arm].desiredAngle;
        this.hwpDetail.fastAxis.setDirection(v(0, 0, arm === 'a' ? -1 : 1));
      }
    }
    if (this.detectorDetail) {
      const record = this.timelineState?.record;
      const arm = String(target).includes('b') || target === 'partner' ? 'b' : 'a';
      const outcome = outcomeOf(record ?? {}, arm) ?? 1;
      const id = this.detectors.has(target) ? target : `detector-${arm}-${outcome === 1 ? 'plus' : 'minus'}`;
      const detector = this.detectors.get(id);
      this.detectorDetail.group.visible = type === 'detector' && Boolean(detector);
      this.detectorDetail.selectedId = type === 'detector' ? id : null;
      if (type === 'detector' && detector) this.detectorDetail.group.position.copy(detector.position).add(v(-0.25, 0.82, 0.05));
    }
    for (const detector of this.detectors.values()) {
      const showInterior = type === 'detector' && detector === this.detectors.get(this.detectorDetail?.selectedId);
      detector.housing?.forEach(mesh => {
        if (!mesh.userData.solidMaterial) mesh.userData.solidMaterial = mesh.material;
        if (showInterior) {
          if (!mesh.userData.cutawayMaterial) {
            mesh.userData.cutawayMaterial = mesh.material.clone();
            mesh.userData.cutawayMaterial.transparent = true;
            mesh.userData.cutawayMaterial.opacity = 0.17;
            mesh.userData.cutawayMaterial.depthWrite = false;
          }
          mesh.material = mesh.userData.cutawayMaterial;
        } else mesh.material = mesh.userData.solidMaterial;
      });
    }
  }

  _paintPacket(line, points, centerDistance, waveTime, amplitude = 1, width = 0.9, axis = 'y') {
    if (!line) return;
    const positions = line.geometry.attributes.position;
    const total = pathLength(points);
    for (let i = 0; i < positions.count; i++) {
      const t = i / (positions.count - 1);
      const point = pathPoint(points, clamp(centerDistance + (t - 0.5) * width, 0, total));
      const envelope = Math.sin(t * Math.PI);
      point[axis] += Math.sin(t * Math.PI * 7 - waveTime * 5) * 0.055 * amplitude * envelope;
      positions.setXYZ(i, point.x, point.y, point.z);
    }
    positions.needsUpdate = true;
    line.material.opacity = 0.76 * amplitude;
  }

  _renderTimeline(state) {
    if (!this.timelineVisual) return;
    const stage = clamp(Number(state.stageIndex) || 0, 0, 9);
    const progress = clamp(Number(state.stageProgress) || 0, 0, 1);
    const time = Number(state.time) || stage + progress;
    const record = state.record ?? {};
    const detected = Boolean(state.detectionsVisible);
    const detectedArms = state.detectedArms ?? (detected ? ['A', 'B'] : []);
    const automatic = stage === 1 ? ['source', 'a', progress]
      : stage === 3 ? ['hwp', 'a', progress]
      : stage === 4 ? ['pbs', 'a', Math.max(0.45, progress)]
      : stage === 5 ? ['pbs', 'both', 0.55]
      : stage === 6 ? ['detector', 'a', progress]
      : stage === 7 ? ['detector', 'b', progress]
      : stage === 8 ? ['electronics', 'a', progress] : ['none', 'a', 0];
    const cutaway = this._cutawayOverride;
    this._applyCutaway(...(cutaway ? [cutaway.type, cutaway.target, cutaway.progress] : automatic));
    for (const [arm, lines] of Object.entries(this.timelineVisual.lines)) {
      const path = this.paths[arm];
      const absorbed = detectedArms.includes(arm.toUpperCase());
      lines.input.visible = !absorbed && stage >= 1 && stage <= 4;
      let distance = stage === 1 ? progress * 0.42 : stage === 2 ? progress * pathLength(path.prefix.slice(0, 3))
        : stage === 3 ? pathLength(path.prefix.slice(0, 3)) : path.prefixLength - (1 - progress) * 1.2;
      this._paintPacket(lines.input, path.prefix, distance, time, 1, 0.95);
      const weights = record.polarizationPathState?.branchWeights?.[arm] ?? { transmitted: 0.5, reflected: 0.5 };
      for (const [channel, outcome] of [['plus', 1], ['minus', -1]]) {
        const line = lines[channel];
        line.visible = !absorbed && stage >= 4 && stage <= 6;
        const branch = outcome === 1 ? path.plus : path.minus;
        const points = branch.slice(-2);
        const weight = outcome === 1 ? (weights.transmitted ?? weights.T ?? weights.plus ?? 0.5) : (weights.reflected ?? weights.R ?? weights.minus ?? 0.5);
        const center = stage === 4 ? progress * 0.50 : stage === 5 ? 0.8 + progress * 1.3 : this.detectorOffset;
        this._paintPacket(line, points, center, time, Math.sqrt(Math.max(0, weight)), 1.35);
      }
    }
    for (const [id, detector] of this.detectors) {
      const chosen = detectedArms.includes(detector.arm.toUpperCase()) && outcomeOf(record, detector.arm) === detector.outcome;
      detector.pulse = chosen ? 0.65 : 0;
      detector.flash.material.opacity = chosen ? 0.28 : 0;
      detector.traceMaterial.opacity = chosen ? 0.26 : 0;
      detector.sensor.material.emissiveIntensity = chosen ? 1.15 : 0.2;
      detector.indicatorMaterial.color.set(chosen ? detector.color : 0x1e4f67);
      if (chosen) detector.lastRecord = record;
      else delete detector.lastRecord;
    }
    for (const [index, led] of this.taggerLeds.entries()) {
      const arm = index < 2 ? 'a' : 'b';
      const outcome = index % 2 ? -1 : 1;
      const active = stage >= 8 && detected && outcomeOf(record, arm) === outcome;
      led.pulse = active ? 1 : 0;
      led.material.color.set(active ? led.color : 0x193444);
    }
    this._renderElectronics(state, progress);
    this.sourceGlow.material.opacity = stage === 1 ? 0.22 + progress * 0.5 : 0.22;
    this.sourceGlow.scale.setScalar(0.9);
    if (this.sourceDetail) this.sourceDetail.pump.material.opacity = stage === 1 ? 0.3 + progress * 0.3 : 0.3;
    this._renderPBSInterference(time, progress);
    this._renderHWPDetail(time, progress);
    if (this.detectorDetail?.group.visible) this._renderDetectorMicro(state, stage === 7 ? progress : progress);
  }

  _renderPBSInterference(time, progress) {
    for (const pbs of Object.values(this.pbs ?? {})) {
      if (!pbs.interior.visible) continue;
      pbs.coating.material.opacity = 0.38 + progress * 0.08;
      for (const [index, line] of pbs.interference.entries()) {
        const positions = line.geometry.attributes.position;
        for (let i = 0; i < positions.count; i++) {
          const x = i / (positions.count - 1);
          const phase = index === 1 ? Math.PI : 0;
          const y = index * 0.10 + 0.28 + Math.sin(x * Math.PI * 8 - time * 2 + phase) * (index === 2 ? 0.035 : 0.058);
          positions.setXYZ(i, -0.53 + x * 1.06, y, index === 2 ? 0.31 : -0.31);
        }
        positions.needsUpdate = true;
      }
    }
  }

  _renderHWPDetail(time, progress) {
    const detail = this.hwpDetail;
    if (!detail?.group.visible) return;
    for (const [index, line] of detail.waves.entries()) {
      const positions = line.geometry.attributes.position;
      for (let i = 0; i < positions.count; i++) {
        const t = i / (positions.count - 1);
        const x = -1.08 + t * 2.2;
        const relativePhase = index === 1 && x > 0.1 ? Math.PI * clamp(progress * 1.8, 0, 1) : 0;
        const field = Math.sin(t * Math.PI * 10 - time * 2 + relativePhase) * 0.12;
        const sign = detail.arm === 'a' ? -1 : 1;
        const angle = this.analyzers[detail.arm].desiredAngle;
        const y = index === 1 ? field : -0.35;
        const z = index === 0 ? field * sign : 0.35;
        positions.setXYZ(i, x, y * Math.cos(angle) - z * Math.sin(angle), y * Math.sin(angle) + z * Math.cos(angle));
      }
      positions.needsUpdate = true;
    }
  }

  _renderDetectorMicro(state, progress) {
    const detail = this.detectorDetail;
    if (!detail) return;
    const phase = clamp(progress, 0, 1);
    const selectedDetector = this.detectors.get(detail.selectedId);
    const selectedArm = (selectedDetector?.arm ?? (state.stageIndex === 7 ? 'b' : 'a')).toUpperCase();
    const armDetected = Array.isArray(state.detectedArms) ? state.detectedArms.includes(selectedArm) : Boolean(state.detectionsVisible);
    const selectedPortDetected = !state.record || !selectedDetector || outcomeOf(state.record, selectedDetector.arm) === selectedDetector.outcome;
    const absorbed = armDetected && selectedPortDetected;
    const avalanche = absorbed && phase >= 0.28 && phase < 0.78;
    const quenching = absorbed && phase >= 0.80;
    detail.absorbed.material.opacity = absorbed && phase < 0.28 ? 0.75 * (1 - phase / 0.28) : 0;
    detail.incidentPacket.visible = !armDetected;
    this._paintPacket(detail.incidentPacket, [v(0, 0.73, 0), v(0, 0.16, 0)], clamp(phase / 0.12, 0, 1) * 0.55, Number(state.time) || 0, 1, 0.23, 'x');
    detail.highField.material.opacity = avalanche ? 0.24 : 0.075;
    detail.quench.material.color.set(quenching ? 0x8ee7c0 : 0x54706a);
    detail.fieldArrows.forEach(arrow => { arrow.visible = absorbed && !quenching; });
    for (const [i, electron] of detail.electrons.entries()) {
      const threshold = 0.12 + i * 0.025;
      const growth = clamp((phase - threshold) / 0.4, 0, 1);
      electron.material.opacity = absorbed && phase >= threshold && !quenching ? 0.85 : 0;
      electron.position.set(Math.sin(i * 2.39) * 0.34 * growth, 0.12 - growth * 0.29, Math.cos(i * 3.11) * 0.23 * growth);
    }
    const pulsePosition = clamp((phase - 0.54) / 0.28, 0, 1);
    detail.signal.material.opacity = absorbed && phase >= 0.54 ? (quenching ? 0.30 : 0.90) : 0;
    const positions = detail.signalGeometry.attributes.position;
    for (let i = 0; i < positions.count; i++) {
      const t = i / (positions.count - 1);
      const pulse = Math.exp(-Math.pow((t - pulsePosition) / 0.045, 2)) * (quenching ? 0.05 : 0.24);
      positions.setXYZ(i, 0.49 + t * 0.9, -0.19 + pulse, 0.22);
    }
    positions.needsUpdate = true;
  }

  _renderElectronics(state, progress) {
    const record = state.record ?? {};
    const showing = state.stageIndex === 8;
    for (const [id, cable] of this.cables ?? []) {
      const detector = this.detectors.get(id);
      const active = showing && state.detectionsVisible && outcomeOf(record, detector.arm) === detector.outcome;
      cable.pulse.visible = active;
      if (!active) continue;
      const positions = cable.pulse.geometry.attributes.position;
      const center = clamp(0.80 + progress * 0.30, 0, 1);
      for (let i = 0; i < positions.count; i++) {
        const t = i / (positions.count - 1);
        const point = cable.curve.getPoint(clamp(center + (t - 0.5) * 0.07, 0, 1));
        point.y += Math.sin(t * Math.PI) * 0.05;
        positions.setXYZ(i, point.x, point.y, point.z);
      }
      positions.needsUpdate = true;
    }
    if (!this.taggerDetail?.group.visible) return;
    for (const [index, trace] of this.taggerDetail.traces.entries()) {
      const arm = index < 2 ? 'a' : 'b';
      const active = state.detectionsVisible && outcomeOf(record, arm) === (index % 2 ? -1 : 1);
      trace.material.opacity = active ? 0.86 : 0.20;
      const positions = trace.geometry.attributes.position;
      const center = clamp((progress - 0.08) / 0.40, 0, 1);
      for (let i = 0; i < positions.count; i++) {
        const t = i / (positions.count - 1);
        const pulse = active ? Math.exp(-Math.pow((t - center) / 0.045, 2)) * 0.22 : 0;
        positions.setXYZ(i, -0.76 + t * 1.15, 0.10 + pulse, -0.37 + index * 0.25);
      }
      positions.needsUpdate = true;
    }
  }

  testPBS(input) {
    input = String(input).toUpperCase();
    if (!['H', 'V', 'D'].includes(input)) throw new RangeError('Prepared PBS input must be H, V, or D.');
    const prepared = input === 'H' ? [1, 0] : input === 'V' ? [0, 1] : [Math.SQRT1_2, Math.SQRT1_2];
    const amplitudes = singlePBSIsometry(prepared, 0);
    const transmitted = amplitudes[0].re ** 2 + amplitudes[0].im ** 2;
    const reflected = amplitudes[3].re ** 2 + amplitudes[3].im ** 2;
    if (!this._pbsInspector) {
      this._pbsInspector = {
        context: {
          state: this.timelineState ? { ...this.timelineState } : null,
          cameraPosition: this.camera.position.clone(), cameraTarget: this.controls.target.clone(),
          flight: this._cameraFlight, guidedCamera: this.guidedCamera, paused: this.paused,
          cutaway: this._cutawayOverride ? { ...this._cutawayOverride } : null,
          selected: this._selected,
        },
        input, amplitudes, transmitted, reflected,
      };
    } else Object.assign(this._pbsInspector, { input, amplitudes, transmitted, reflected });
    this.paused = true;
    this._releaseGuidedCamera('isolated-component-example');
    this._applyCutaway('pbs', 'a', 1);
    this._fly(v(5.25, 4.3, 0.45), v(this.pbsX, 2.0, -this.armZ));
    this._renderPBSExample();
    return { input, isolated: true, contributionToExperiment: 0, transmittedProbability: transmitted, reflectedProbability: reflected, amplitudes };
  }

  _renderPBSExample() {
    if (!this._pbsInspector || !this.timelineVisual) return;
    this._applyCutaway('pbs', 'a', 1);
    const input = this._pbsInspector.input;
    for (const [arm, lines] of Object.entries(this.timelineVisual.lines)) {
      for (const line of Object.values(lines)) line.visible = false;
      if (arm !== 'a') continue;
      const path = this.paths.a;
      const inputPoints = [v(this.pbsX - 1.35, 1.58, -this.armZ), v(this.pbsX, 1.58, -this.armZ)];
      lines.input.visible = true;
      this._paintPacket(lines.input, inputPoints, 0.75, 0, 1, 1.1, input === 'V' ? 'y' : 'z');
      if (input !== 'V') {
        const position = lines.input.geometry.attributes.position;
        for (let i = 0; i < position.count; i++) {
          const field = position.getZ(i) + this.armZ;
          position.setZ(i, -this.armZ - field * (input === 'D' ? Math.SQRT1_2 : 1));
          if (input === 'D') position.setY(i, 1.58 + field * Math.SQRT1_2);
        }
        position.needsUpdate = true;
      }
      for (const [channel, outcome] of [['plus', 1], ['minus', -1]]) {
        const weight = outcome === 1 ? this._pbsInspector.transmitted : this._pbsInspector.reflected;
        const visible = weight > 0;
        lines[channel].visible = visible;
        this._paintPacket(lines[channel], (outcome === 1 ? path.plus : path.minus).slice(-2), 0.92, 0, Math.sqrt(weight), 1.7, outcome === 1 ? 'z' : 'y');
        if (outcome === 1) {
          const position = lines[channel].geometry.attributes.position;
          for (let i = 0; i < position.count; i++) position.setZ(i, -this.armZ - (position.getZ(i) + this.armZ));
          position.needsUpdate = true;
        }
      }
    }
    // The prepared example never adds a detector click or alters the saved pair.
    for (const detector of this.detectors.values()) {
      detector.flash.material.opacity = 0;
      detector.traceMaterial.opacity = 0;
      detector.indicatorMaterial.color.set(0x1e4f67);
    }
    this._renderPBSInterference(0, 1);
  }

  closePBSInspector() {
    if (!this._pbsInspector) return false;
    const context = this._pbsInspector.context;
    this._pbsInspector = null;
    this.camera.position.copy(context.cameraPosition);
    this.controls.target.copy(context.cameraTarget);
    this._cameraFlight = context.flight;
    this.guidedCamera = context.guidedCamera;
    this.paused = context.paused;
    this._cutawayOverride = context.cutaway;
    this._selected = context.selected;
    if (context.state) {
      this.timelineState = context.state;
      this._timelineStage = context.state.stageIndex;
      this._renderTimeline(context.state);
    } else this._applyCutaway('none');
    this.controls.update(0);
    this.onCameraOverride?.({ guidedCamera: this.guidedCamera, reason: 'restore-component-context' });
    return true;
  }

  setSecondArmInset(container) {
    if (this.secondArmInset) {
      this.secondArmInset.observer.disconnect();
      this.secondArmInset.renderer.dispose();
      this.secondArmInset.environment.dispose();
      this.secondArmInset.renderer.domElement.remove();
      this.secondArmInset = null;
    }
    if (!container) return;
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
    renderer.setPixelRatio(1);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = this.renderer.toneMappingExposure;
    renderer.domElement.style.cssText = 'display:block;width:100%;height:100%;pointer-events:none';
    renderer.domElement.setAttribute('aria-label', 'Second station view of the same experiment timeline');
    container.appendChild(renderer.domElement);
    const camera = new THREE.PerspectiveCamera(42, 1, 0.04, 90);
    const room = new RoomEnvironment();
    const pmrem = new THREE.PMREMGenerator(renderer);
    const environment = pmrem.fromScene(room, 0.035);
    room.dispose();
    pmrem.dispose();
    const inset = { container, renderer, camera, environment, observer: null };
    const resize = () => {
      const width = Math.max(1, container.clientWidth);
      const height = Math.max(1, container.clientHeight);
      renderer.setSize(width, height, false);
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
    };
    inset.observer = new ResizeObserver(resize);
    inset.observer.observe(container);
    this.secondArmInset = inset;
    resize();
    this._renderSecondArmInset();
  }

  _renderSecondArmInset() {
    const inset = this.secondArmInset;
    if (!inset || !inset.container.clientWidth || !inset.container.clientHeight) return;
    inset.camera.position.set(8.2, 5.7, 9.3);
    inset.camera.lookAt(0.8, 1.35, this.armZ);
    const previousEnvironment = this.scene.environment;
    this.scene.environment = inset.environment.texture;
    inset.renderer.render(this.scene, inset.camera);
    this.scene.environment = previousEnvironment;
  }

  launchPair(record, { duration = 3, paused = false } = {}) {
    if (this.pairs.length >= this.maxPairs || !record || this._disposed) return false;
    if (typeof record.measure !== 'function' && (!([1, -1].includes(outcomeOf(record, 'a'))) || !([1, -1].includes(outcomeOf(record, 'b'))))) return false;
    const group = new THREE.Group();
    this.scene.add(group);
    const photons = {};
    for (const arm of ['a', 'b']) {
      const photon = new THREE.Group();
      const core = new THREE.Mesh(new THREE.SphereGeometry(0.039, 16, 12), this.materials.neutral);
      photon.add(core);
      const halo = new THREE.Sprite(new THREE.SpriteMaterial({ map: this.glowTexture, color: CYAN, blending: THREE.AdditiveBlending, transparent: true, opacity: 0.8, depthWrite: false, toneMapped: false }));
      halo.scale.set(0.52, 0.52, 0.52);
      photon.add(halo);
      const trailGeometry = new THREE.BufferGeometry();
      trailGeometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(12 * 3), 3));
      const trailMaterial = new THREE.LineBasicMaterial({ color: CYAN, transparent: true, opacity: 0.42, blending: THREE.AdditiveBlending, depthWrite: false });
      const trail = new THREE.Line(trailGeometry, trailMaterial);
      trail.frustumCulled = false;
      group.add(trail);
      group.add(photon);
      const amplitudes = [];
      for (const outcome of [1, -1]) {
        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(24 * 3), 3));
        const material = new THREE.LineBasicMaterial({ color: CYAN, transparent: true, opacity: 0.28, blending: THREE.AdditiveBlending, depthWrite: false });
        const line = new THREE.Line(geometry, material);
        line.frustumCulled = false;
        line.visible = false;
        group.add(line);
        amplitudes.push({ outcome, line, geometry, material });
      }
      photons[arm] = { photon, core, halo, trail, trailGeometry, trailMaterial, amplitudes };
    }
    const pair = {
      record: { ...record }, group, photons, progress: 0,
      duration: clamp(Number(duration) || 3, 0.25, 60),
      measured: false, notified: false, lastPhase: 'emission',
    };
    this.pairs.push(pair);
    if (paused) this.paused = true;
    this.sourceGlow.material.opacity = 0.9;
    this.onPhase({ phase: 'emission', pairId: record.id, progress: 0 });
    this._positionPair(pair);
    return true;
  }

  _measurePair(pair) {
    if (pair.measured) return;
    const result = typeof pair.record.measure === 'function' ? pair.record.measure() : pair.record;
    if (!result || ![1, -1].includes(outcomeOf(result, 'a')) || ![1, -1].includes(outcomeOf(result, 'b'))) {
      throw new Error('The physics engine must return +1/-1 outcomes for both arms at detection.');
    }
    pair.record = { ...pair.record, ...result };
    delete pair.record.measure;
    pair.measured = true;
    this.onPhase({ phase: 'measurement', pairId: pair.record.id, progress: pair.progress });
    pair.lastPhase = 'measurement';
  }

  _positionPair(pair) {
    for (const arm of ['a', 'b']) {
      const path = this.paths[arm];
      const outcome = pair.measured ? outcomeOf(pair.record, arm) : 1;
      const points = outcome === -1 ? path.minus : path.plus;
      const distance = pair.progress * path.totalLength;
      const photon = pair.photons[arm];
      const inOutputs = pair.progress >= this.splitProgress;
      photon.photon.visible = !inOutputs;
      photon.trail.visible = !inOutputs;
      photon.photon.position.copy(pathPoint(points, Math.min(distance, path.prefixLength)));
      // These low-intensity field strokes are possible output amplitudes.
      // No particle mesh chooses an output until the absorption record exists.
      for (const amplitude of photon.amplitudes) {
        amplitude.line.visible = inOutputs && !pair.notified;
        const branch = amplitude.outcome === 1 ? path.plus : path.minus;
        const start = branch[branch.length - 2];
        const endpoint = branch[branch.length - 1];
        const direction = endpoint.clone().sub(start).normalize();
        const waveCenter = clamp(distance - path.prefixLength, 0, this.detectorOffset);
        const positions = amplitude.geometry.attributes.position;
        for (let i = 0; i < 24; i++) {
          const fraction = i / 23;
          const longitudinal = clamp(waveCenter + (fraction - 0.5) * 0.7, 0, this.detectorOffset);
          const envelope = Math.sin(fraction * Math.PI);
          const point = start.clone().addScaledVector(direction, longitudinal);
          point.y += Math.sin(fraction * Math.PI * 5 - this.elapsed * 7) * 0.067 * envelope;
          positions.setXYZ(i, point.x, point.y, point.z);
        }
        positions.needsUpdate = true;
      }
      if (pair.measured) {
        const color = outcome === 1 ? BLUE : VIOLET;
        photon.halo.material.color.set(color);
        photon.trailMaterial.color.set(color);
      }
      const positions = photon.trailGeometry.attributes.position;
      for (let i = 0; i < 12; i++) {
        const point = pathPoint(points, Math.max(0, distance - (11 - i) * 0.034));
        positions.setXYZ(i, point.x, point.y, point.z);
      }
      positions.needsUpdate = true;
      photon.halo.material.opacity = 0.7 + Math.sin(this.elapsed * 13 + (arm === 'a' ? 0 : 0.7)) * 0.1;
    }
  }

  _advancePair(pair, amount) {
    const previous = pair.progress;
    pair.progress = Math.min(1, pair.progress + amount);
    if (previous < this.analyzerProgress && pair.progress >= this.analyzerProgress) {
      this.onPhase({ phase: 'analyzers', pairId: pair.record.id, progress: pair.progress });
      pair.lastPhase = 'analyzers';
    }
    if (previous < this.splitProgress && pair.progress >= this.splitProgress) {
      this.onPhase({ phase: 'amplitudes', pairId: pair.record.id, progress: pair.progress });
      pair.lastPhase = 'amplitudes';
    }
    if (!pair.measured && pair.progress >= this.measurementProgress) this._measurePair(pair);
    this._positionPair(pair);
    if (pair.progress >= 1 && !pair.notified) {
      pair.notified = true;
      for (const arm of ['a', 'b']) {
        const detector = this.detectors.get(`detector-${arm}-${outcomeOf(pair.record, arm) === 1 ? 'plus' : 'minus'}`);
        detector.pulse = 1;
        detector.lastRecord = pair.record;
        const channel = (arm === 'a' ? 0 : 2) + (outcomeOf(pair.record, arm) === 1 ? 0 : 1);
        this.taggerLeds[channel].pulse = 1;
        if (this.detectorDetail?.selectedId === `detector-${arm}-${outcomeOf(pair.record, arm) === 1 ? 'plus' : 'minus'}`) {
          this.detectorDetail.age = 0;
        }
      }
      this.onPhase({ phase: 'detection', pairId: pair.record.id, progress: 1 });
      this.onMeasurement(pair.record);
    }
  }

  step() {
    this.paused = true;
    for (const pair of [...this.pairs]) this._advancePair(pair, 0.12);
    this._removeCompleted();
    this.renderer.render(this.scene, this.camera);
    return this.progress;
  }

  _removeCompleted() {
    for (let i = this.pairs.length - 1; i >= 0; i--) {
      if (this.pairs[i].notified) {
        this._disposePair(this.pairs[i]);
        this.pairs.splice(i, 1);
      }
    }
  }

  _disposePair(pair) {
    this.scene.remove(pair.group);
    for (const photon of Object.values(pair.photons)) {
      photon.core.geometry.dispose();
      photon.halo.material.dispose();
      photon.trailGeometry.dispose();
      photon.trailMaterial.dispose();
      for (const amplitude of photon.amplitudes) {
        amplitude.geometry.dispose();
        amplitude.material.dispose();
      }
    }
  }

  reset() {
    for (const pair of this.pairs) this._disposePair(pair);
    this.pairs.length = 0;
    for (const detector of this.detectors.values()) {
      detector.pulse = 0;
      detector.flash.material.opacity = 0;
      detector.traceMaterial.opacity = 0;
      detector.sensor.material.emissiveIntensity = 0.2;
      delete detector.lastRecord;
    }
    this.sourceGlow.material.opacity = 0.36;
    for (const led of this.taggerLeds) led.pulse = 0;
    if (this.detectorDetail) {
      this.detectorDetail.age = 100;
      this._updateDetectorDetail(0);
    }
  }

  focus(id) {
    if (this._timelineMode) this._releaseGuidedCamera('component-inspection');
    const aliases = { crystal: 'source', pump: 'source', hwp: 'analyzer-a', pbs: 'pbs-a', 'inside-pbs': 'pbs-a', alice: 'analyzer-a', bob: 'analyzer-b', detector: 'detector-a-plus', partner: 'detector-b-plus', 'A+': 'detector-a-plus', 'A-': 'detector-a-minus', 'B+': 'detector-b-plus', 'B-': 'detector-b-minus' };
    const component = this.components.get(aliases[id] ?? id);
    if (!component) return false;
    this._select(component);
    this._fly(component.target.clone().add(component.cameraOffset), component.target);
    this.onInspect({ id: component.id, title: component.title, description: component.description, record: this.detectors.get(component.id)?.lastRecord });
    return true;
  }

  _fly(position, target, duration = this.cameraTransition ?? 1.5) {
    if (this._reducedMotion) duration = 0.01;
    this._cameraFlight = { startPosition: this.camera.position.clone(), startTarget: this.controls.target.clone(), position: position.clone(), target: target.clone(), elapsed: 0, duration };
    this.lastInteraction = performance.now();
  }

  setCameraPreset(name) {
    name = String(name).toLowerCase().replaceAll(' ', '-');
    if (this._timelineMode) this._releaseGuidedCamera('camera-bookmark');
    if (['pbs', 'inside-pbs'].includes(name)) {
      this.setCutaway('pbs', 'a', 1);
      this._fly(v(5.25, 4.3, 0.45), v(this.pbsX, 2.0, -this.armZ));
      return;
    }
    if (name === 'hwp') {
      this.setCutaway('hwp', 'a', 1);
      this._fly(v(2.4, 3.5, -0.1), v(-0.5, 1.75, -this.armZ));
      return;
    }
    if (name === 'time-tagger') name = 'electronics';
    if (name === 'arms') name = 'pair';
    if (name === 'branches') name = 'detectors';
    if (['alice', 'bob', 'detector', 'electronics'].includes(name)) {
      this.focus(name);
      return;
    }
    this.clearInspection();
    const presets = {
      overview: [v(11.8, 11.0, 13.7), v(0, -0.1, 0)],
      top: [v(0, 17, 0.01), v(0, 0.6, 0)],
      source: [v(-1.95, 3.4, 3.5), this.sourcePosition],
      pair: [v(-2.8, 5.6, 7.4), v(-1.7, 1.3, 0)],
      analyzers: [v(3.8, 5.0, 6.8), v(-0.7, 1.45, 0)],
      pbs: [v(5.9, 4.7, 7.8), v(1.9, 1.4, 0)],
      detectors: [v(8.2, 5.9, 9.1), v(3.2, 1.35, 0)],
      correlations: [v(10.1, 8.6, 12.3), v(0.7, 1.1, 0)],
      bell: [v(9.0, 10.7, 12.0), v(0.5, 0.75, 0)],
      'no-signalling': [v(10.6, 6.0, 10.8), v(1.7, 1.25, 0)],
      qkd: [v(10.4, 8.6, 11.8), v(0.7, 0.9, 0)],
    };
    const preset = presets[name === 'whole' ? 'overview' : name] ?? presets.overview;
    this._fly(preset[0], preset[1]);
  }

  clearInspection() {
    this._selected = null;
    this.selectionHalo.visible = false;
    if (this.detectorDetail) {
      this.detectorDetail.group.visible = false;
      this.detectorDetail.selectedId = null;
    }
    if (this._timelineMode) {
      this._cutawayOverride = null;
      this._applyCutaway('none');
    }
  }

  setPresentation(enabled) {
    this.presentation = Boolean(enabled);
    this.controls.autoRotate = false;
    this.controls.autoRotateSpeed = 0.13;
    if (!enabled) this.controls.autoRotate = false;
  }

  setReducedMotion(enabled) {
    this._reducedMotion = Boolean(enabled);
    this.controls.autoRotate = false;
    if (this._reducedMotion && this._cameraFlight) this._cameraFlight.duration = 0.01;
  }

  update(dt = 1 / 60) {
    if (this._disposed) return;
    dt = clamp(Number(dt) || 0, 0, 0.2);
    if (!this._timelineMode && !this.paused) this.elapsed += dt;
    if (this._cameraFlight) {
      const flight = this._cameraFlight;
      flight.elapsed += dt;
      const t = Math.min(1, flight.elapsed / flight.duration);
      const eased = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
      this.camera.position.copy(flight.startPosition).lerp(flight.position, eased);
      this.controls.target.copy(flight.startTarget).lerp(flight.target, eased);
      if (t >= 1) this._cameraFlight = null;
    }
    this.controls.update(dt);
    if (this._timelineMode) {
      this.renderer.render(this.scene, this.camera);
      this._renderSecondArmInset();
      return;
    }
    const experimentDt = this.paused ? 0 : dt;
    for (const analyzer of Object.values(this.analyzers)) {
      const difference = THREE.MathUtils.euclideanModulo(analyzer.desiredAngle - analyzer.rotor.rotation.x + Math.PI, Math.PI * 2) - Math.PI;
      analyzer.rotor.rotation.x += difference * Math.min(1, experimentDt * 8);
    }
    if (!this.paused) {
      for (const pair of [...this.pairs]) this._advancePair(pair, dt * this.speed / pair.duration);
      this._removeCompleted();
    } else {
      for (const pair of this.pairs) this._positionPair(pair);
    }
    for (const detector of this.detectors.values()) {
      detector.pulse = Math.max(0, detector.pulse - experimentDt * 2.2);
      detector.flash.material.opacity = detector.pulse * 0.8;
      detector.traceMaterial.opacity = detector.pulse * 0.48;
      detector.sensor.material.emissiveIntensity = 0.2 + detector.pulse * 3;
      detector.indicatorMaterial.color.set(detector.pulse > 0.02 ? detector.color : 0x1e4f67);
    }
    for (const led of this.taggerLeds) {
      led.pulse = Math.max(0, led.pulse - experimentDt * 2.1);
      led.material.color.set(led.pulse > 0 ? led.color : 0x193444);
    }
    this._updateDetectorDetail(experimentDt);
    this.sourceGlow.material.opacity += (0.28 + Math.sin(this.elapsed * 1.8) * 0.05 - this.sourceGlow.material.opacity) * experimentDt * 2.2;
    this.sourceGlow.scale.setScalar(0.9 + Math.sin(this.elapsed * 2.2) * 0.03);
    if (this.selectionHalo.visible) this.selectionHalo.material.opacity = 0.32 + Math.sin(this.elapsed * 2) * 0.08;
    this.renderer.render(this.scene, this.camera);
  }

  dispose() {
    if (this._disposed) return;
    this.reset();
    this.setSecondArmInset(null);
    this._disposed = true;
    cancelAnimationFrame(this._frame);
    this._resizeObserver?.disconnect();
    this.renderer.domElement.removeEventListener('pointerdown', this._onPointerDown);
    this.renderer.domElement.removeEventListener('pointerup', this._onPointerUp);
    this.controls.dispose();
    const materials = new Set();
    this.scene.traverse((object) => {
      if (object.geometry) this._ownedGeometries.add(object.geometry);
      if (object.material) {
        for (const material of Array.isArray(object.material) ? object.material : [object.material]) materials.add(material);
      }
      if (object.userData?.cutawayMaterial) materials.add(object.userData.cutawayMaterial);
    });
    for (const geometry of this._ownedGeometries) geometry.dispose();
    for (const material of materials) material.dispose();
    for (const texture of this._textures) texture.dispose();
    this._environmentTarget?.dispose();
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }
}

export default LabScene;
