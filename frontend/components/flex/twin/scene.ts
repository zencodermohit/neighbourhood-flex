import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { CSS2DObject, CSS2DRenderer } from "three/addons/renderers/CSS2DRenderer.js";

import { buildProceduralTransformer } from "@/components/flex/twin/procedural-transformer";
import type { FlexState, LoadStatus, PhaseName } from "@/components/flex/types";

export type TwinTarget = { kind: "transformer" } | { kind: "house"; id: string } | null;
export type ModelSource = "loading" | "sketchfab" | "procedural";

type Callbacks = {
  onDoubleClick: (target: TwinTarget) => void;
  onHover: (target: TwinTarget) => void;
  onModelSource: (source: ModelSource) => void;
};

// Reports whether the Sketchfab "High voltage power transformer" model has been added.
const MODEL_ENDPOINT = "/api/twin-model";
const HOME_POSITION = new THREE.Vector3(7.4, 6.0, 10.4);
const HOME_TARGET = new THREE.Vector3(0, 0.7, 2.0);
const PHASES: PhaseName[] = ["L1", "L2", "L3"];
const PHASE_ANGLE: Record<PhaseName, number> = { L1: -0.72, L2: 0, L3: 0.72 };
const POLE_RADIUS = 3.1;
const HOUSE_RADIUS = 4.5;
const PARTICLES_PER_PHASE = 26;

const STATUS_COLOR: Record<LoadStatus, string> = {
  normal: "#3987e5",
  near_limit: "#fab219",
  overloaded: "#d03b3b",
};
const HALO_COLOR: Record<LoadStatus, string> = {
  normal: "#0ca30c",
  near_limit: "#fab219",
  overloaded: "#d03b3b",
};

type House = {
  id: string;
  group: THREE.Group;
  window: THREE.MeshStandardMaterial;
  bar: THREE.Mesh;
  barMaterial: THREE.MeshStandardMaterial;
  ring: THREE.Mesh;
  ringMaterial: THREE.MeshBasicMaterial;
  solar: THREE.Mesh;
  target: THREE.Vector3;
  phase: PhaseName | null;
};

type Feeder = {
  curve: THREE.CatmullRomCurve3;
  line: THREE.Mesh;
  pole: THREE.Group;
  label: HTMLDivElement;
  offsets: Float32Array;
  speed: number;
  color: THREE.Color;
};

function polar(angle: number, radius: number, y = 0) {
  return new THREE.Vector3(Math.sin(angle) * radius, y, Math.cos(angle) * radius);
}

function labelElement() {
  const element = document.createElement("div");
  Object.assign(element.style, {
    padding: "4px 8px",
    borderRadius: "999px",
    border: "1px solid rgba(255,255,255,0.14)",
    background: "rgba(0,0,0,0.72)",
    color: "#f4f4f5",
    font: "12px 'Segoe UI', Arial, sans-serif",
    whiteSpace: "nowrap",
    pointerEvents: "none",
    display: "flex",
    alignItems: "center",
    gap: "6px",
  } satisfies Partial<CSSStyleDeclaration>);
  return element;
}

function setLabel(element: HTMLDivElement, color: string, text: string) {
  element.innerHTML = "";
  const dot = document.createElement("span");
  Object.assign(dot.style, { width: "8px", height: "8px", borderRadius: "50%", background: color, display: "inline-block" });
  const span = document.createElement("span");
  span.textContent = text;
  element.append(dot, span);
}

export class TwinScene {
  private renderer: THREE.WebGLRenderer;
  private labels: CSS2DRenderer;
  private scene = new THREE.Scene();
  private camera: THREE.PerspectiveCamera;
  private controls: OrbitControls;
  private raycaster = new THREE.Raycaster();
  private pointer = new THREE.Vector2();
  private clock = new THREE.Clock();
  private frame = 0;
  private resizeObserver: ResizeObserver;
  private disposed = false;

  private transformer = new THREE.Group();
  private heatMaterials: THREE.MeshStandardMaterial[] = [];
  private terminals: THREE.Vector3[] = [];
  private transformerLabel = labelElement();
  private halo: THREE.Mesh;
  private haloMaterial: THREE.MeshBasicMaterial;
  private shockwave: THREE.Mesh;
  private shockwaveMaterial: THREE.MeshBasicMaterial;
  private shockwaveAge = Infinity;

  private houses = new Map<string, House>();
  private feeders = new Map<PhaseName, Feeder>();
  private particles: THREE.Points;
  private serviceDrops: THREE.LineSegments;

  private heat = 0;
  private haloStatus: LoadStatus = "normal";
  private cameraGoal: { position: THREE.Vector3; target: THREE.Vector3 } | null = null;
  private hovered: TwinTarget = null;
  private lastState: FlexState | null = null;

  constructor(
    private container: HTMLElement,
    private callbacks: Callbacks,
  ) {
    const { clientWidth: width, clientHeight: height } = container;
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(width, height);
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    container.appendChild(this.renderer.domElement);

    this.labels = new CSS2DRenderer();
    this.labels.setSize(width, height);
    Object.assign(this.labels.domElement.style, { position: "absolute", inset: "0", pointerEvents: "none" });
    container.appendChild(this.labels.domElement);

    this.camera = new THREE.PerspectiveCamera(38, width / height, 0.1, 100);
    this.camera.position.copy(HOME_POSITION);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.target.copy(HOME_TARGET);
    this.controls.enableDamping = true;
    this.controls.enablePan = false;
    this.controls.minDistance = 2.5;
    this.controls.maxDistance = 18;
    this.controls.maxPolarAngle = 1.42;
    this.controls.autoRotate = true;
    this.controls.autoRotateSpeed = 0.5;
    this.controls.addEventListener("start", () => {
      this.controls.autoRotate = false;
      this.cameraGoal = null;
    });

    this.scene.fog = new THREE.Fog("#050608", 14, 30);
    this.buildEnvironment();

    this.haloMaterial = new THREE.MeshBasicMaterial({ color: HALO_COLOR.normal, transparent: true, opacity: 0.5, side: THREE.DoubleSide });
    this.halo = new THREE.Mesh(new THREE.RingGeometry(1.55, 1.68, 96), this.haloMaterial);
    this.halo.rotation.x = -Math.PI / 2;
    this.halo.position.y = 0.012;
    this.scene.add(this.halo);
    this.shockwaveMaterial = new THREE.MeshBasicMaterial({ color: "#3987e5", transparent: true, opacity: 0, side: THREE.DoubleSide });
    this.shockwave = new THREE.Mesh(new THREE.RingGeometry(0.96, 1, 96), this.shockwaveMaterial);
    this.shockwave.rotation.x = -Math.PI / 2;
    this.shockwave.position.y = 0.02;
    this.scene.add(this.shockwave);

    this.transformer.userData.kind = "transformer";
    this.scene.add(this.transformer);
    const transformerLabel = new CSS2DObject(this.transformerLabel);
    transformerLabel.position.set(0, 3.1, 0);
    this.scene.add(transformerLabel);

    const particleGeometry = new THREE.BufferGeometry();
    particleGeometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array(PHASES.length * PARTICLES_PER_PHASE * 3), 3));
    particleGeometry.setAttribute("color", new THREE.BufferAttribute(new Float32Array(PHASES.length * PARTICLES_PER_PHASE * 3), 3));
    this.particles = new THREE.Points(
      particleGeometry,
      new THREE.PointsMaterial({
        size: 0.11,
        vertexColors: true,
        transparent: true,
        opacity: 0.95,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      }),
    );
    this.scene.add(this.particles);
    this.serviceDrops = new THREE.LineSegments(
      new THREE.BufferGeometry(),
      new THREE.LineBasicMaterial({ color: "#5b6068", transparent: true, opacity: 0.7 }),
    );
    this.scene.add(this.serviceDrops);

    void this.loadTransformer();

    this.renderer.domElement.addEventListener("dblclick", this.handleDoubleClick);
    this.renderer.domElement.addEventListener("pointermove", this.handlePointerMove);
    this.renderer.domElement.addEventListener("pointerleave", this.handlePointerLeave);
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(container);
    this.animate();
  }

  // ------------------------------------------------------------ construction

  private buildEnvironment() {
    this.scene.add(new THREE.HemisphereLight("#cfd8e6", "#15181d", 0.9));
    const sun = new THREE.DirectionalLight("#fff3df", 2.2);
    sun.position.set(5, 9, 6);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    sun.shadow.camera.left = -7;
    sun.shadow.camera.right = 7;
    sun.shadow.camera.top = 7;
    sun.shadow.camera.bottom = -7;
    sun.shadow.bias = -0.0005;
    this.scene.add(sun);
    const rim = new THREE.DirectionalLight("#5b8cff", 0.8);
    rim.position.set(-6, 4, -6);
    this.scene.add(rim);

    const ground = new THREE.Mesh(
      new THREE.CircleGeometry(12, 96),
      new THREE.MeshStandardMaterial({ color: "#0d1014", roughness: 0.95, metalness: 0.0 }),
    );
    ground.rotation.x = -Math.PI / 2;
    ground.receiveShadow = true;
    this.scene.add(ground);
    const grid = new THREE.GridHelper(24, 48, "#1c222b", "#13171d");
    grid.position.y = 0.005;
    this.scene.add(grid);
    const pad = new THREE.Mesh(
      new THREE.BoxGeometry(3.0, 0.08, 2.0),
      new THREE.MeshStandardMaterial({ color: "#2a2e33", roughness: 0.9 }),
    );
    pad.position.y = 0.04;
    pad.receiveShadow = true;
    this.scene.add(pad);
  }

  private async loadTransformer() {
    try {
      const { url } = (await (await fetch(MODEL_ENDPOINT)).json()) as { url: string | null };
      if (url) {
        const gltf = await new GLTFLoader().loadAsync(url);
        if (this.disposed) return;
        this.useLoadedModel(gltf.scene);
        this.callbacks.onModelSource("sketchfab");
        return;
      }
    } catch {
      // Fall back to the procedural model.
    }
    if (this.disposed) return;
    const model = buildProceduralTransformer();
    model.group.position.y = 0.08;
    this.transformer.add(model.group);
    this.heatMaterials = model.heatMaterials;
    this.terminals = model.lvTerminals.map((point) => point.clone().add(new THREE.Vector3(0, 0.08, 0)));
    this.buildFeeders();
    this.callbacks.onModelSource("procedural");
  }

  private useLoadedModel(model: THREE.Object3D) {
    const box = new THREE.Box3().setFromObject(model);
    const size = box.getSize(new THREE.Vector3());
    const scale = 2.4 / Math.max(size.x, size.y, size.z);
    model.scale.setScalar(scale);
    box.setFromObject(model);
    const center = box.getCenter(new THREE.Vector3());
    model.position.x -= center.x;
    model.position.z -= center.z;
    model.position.y += 0.08 - box.min.y;
    model.traverse((child) => {
      const mesh = child as THREE.Mesh;
      if (!mesh.isMesh) return;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      const cloned = materials.map((material) => {
        const copy = material.clone();
        if (copy instanceof THREE.MeshStandardMaterial) this.heatMaterials.push(copy);
        return copy;
      });
      mesh.material = Array.isArray(mesh.material) ? cloned : cloned[0];
    });
    this.transformer.add(model);
    const fitted = new THREE.Box3().setFromObject(this.transformer);
    const top = fitted.max.y;
    this.terminals = [-0.45, 0, 0.45].map((x) => new THREE.Vector3(x * (fitted.max.x - fitted.min.x), top - 0.1, fitted.max.z * 0.6));
    this.buildFeeders();
  }

  private buildFeeders() {
    const cable = new THREE.MeshStandardMaterial({ color: "#3b4048", roughness: 0.6, metalness: 0.3 });
    const wood = new THREE.MeshStandardMaterial({ color: "#5b4636", roughness: 0.9 });
    PHASES.forEach((phase, index) => {
      const start = this.terminals[index];
      const poleTop = polar(PHASE_ANGLE[phase], POLE_RADIUS, 1.9);
      const middle = start.clone().lerp(poleTop, 0.5);
      middle.y = Math.min(start.y, poleTop.y) - 0.25;
      const curve = new THREE.CatmullRomCurve3([start, start.clone().add(new THREE.Vector3(0, 0.15, 0.25)), middle, poleTop]);
      const line = new THREE.Mesh(new THREE.TubeGeometry(curve, 48, 0.018, 6, false), cable);
      line.castShadow = true;
      this.scene.add(line);

      const pole = new THREE.Group();
      const post = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.07, 2.0, 10), wood);
      post.position.y = 1.0;
      post.castShadow = true;
      const arm = new THREE.Mesh(new THREE.BoxGeometry(0.6, 0.05, 0.05), wood);
      arm.position.y = 1.86;
      arm.rotation.y = PHASE_ANGLE[phase];
      pole.add(post, arm);
      pole.position.copy(polar(PHASE_ANGLE[phase], POLE_RADIUS));
      this.scene.add(pole);

      const label = labelElement();
      const labelObject = new CSS2DObject(label);
      labelObject.position.copy(polar(PHASE_ANGLE[phase], POLE_RADIUS, 2.35));
      this.scene.add(labelObject);

      const offsets = new Float32Array(PARTICLES_PER_PHASE);
      for (let k = 0; k < PARTICLES_PER_PHASE; k += 1) offsets[k] = k / PARTICLES_PER_PHASE;
      this.feeders.set(phase, { curve, line, pole, label, offsets, speed: 0.1, color: new THREE.Color(STATUS_COLOR.normal) });
    });
    if (this.lastState) this.update(this.lastState);
  }

  private createHouse(id: string, pv: boolean): House {
    const group = new THREE.Group();
    group.userData = { kind: "house", id };
    const walls = new THREE.Mesh(
      new THREE.BoxGeometry(0.34, 0.26, 0.3),
      new THREE.MeshStandardMaterial({ color: "#3a404a", roughness: 0.8 }),
    );
    walls.position.y = 0.13;
    walls.castShadow = true;
    walls.receiveShadow = true;
    const roof = new THREE.Mesh(
      new THREE.ConeGeometry(0.28, 0.18, 4),
      new THREE.MeshStandardMaterial({ color: "#5a3a32", roughness: 0.7 }),
    );
    roof.position.y = 0.35;
    roof.rotation.y = Math.PI / 4;
    roof.castShadow = true;
    const windowMaterial = new THREE.MeshStandardMaterial({ color: "#1b1f24", emissive: "#ffc46b", emissiveIntensity: 0.2 });
    const windowMesh = new THREE.Mesh(new THREE.PlaneGeometry(0.12, 0.09), windowMaterial);
    windowMesh.position.set(0, 0.15, 0.151);
    const solar = new THREE.Mesh(
      new THREE.BoxGeometry(0.2, 0.012, 0.14),
      new THREE.MeshStandardMaterial({ color: "#1d3c6e", metalness: 0.6, roughness: 0.25 }),
    );
    solar.position.set(0, 0.36, 0.08);
    solar.rotation.x = -0.55;
    solar.visible = pv;
    const barMaterial = new THREE.MeshStandardMaterial({ color: "#3987e5", emissive: "#3987e5", emissiveIntensity: 0.6 });
    const bar = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.025, 1, 8), barMaterial);
    bar.position.y = 0.5;
    const ringMaterial = new THREE.MeshBasicMaterial({ color: "#0ca30c", transparent: true, opacity: 0, side: THREE.DoubleSide });
    const ring = new THREE.Mesh(new THREE.RingGeometry(0.27, 0.32, 40), ringMaterial);
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = 0.012;
    group.add(walls, roof, windowMesh, solar, bar, ring);
    this.scene.add(group);
    return { id, group, window: windowMaterial, bar, barMaterial, ring, ringMaterial, solar, target: new THREE.Vector3(), phase: null };
  }

  // ------------------------------------------------------------------ update

  update(state: FlexState) {
    this.lastState = state;
    const limit = state.config.safe_limit_kw;
    const transformer = state.transformer;
    // Heat tint starts at 85% of the limit and saturates at 115%.
    this.heat = THREE.MathUtils.clamp((transformer.total_kw / limit - 0.85) / 0.3, 0, 1);
    this.haloStatus = transformer.status;
    this.haloMaterial.color.set(HALO_COLOR[transformer.status]);
    setLabel(
      this.transformerLabel,
      HALO_COLOR[transformer.status],
      `DT-07 · ${transformer.total_kw.toFixed(1)} kW of ${limit} kW`,
    );

    for (const phase of transformer.phases) {
      const feeder = this.feeders.get(phase.phase);
      if (!feeder) continue;
      feeder.speed = 0.05 + 0.35 * Math.min(phase.kw / phase.limit_kw, 1.4);
      feeder.color.set(STATUS_COLOR[phase.status]);
      setLabel(feeder.label, STATUS_COLOR[phase.status], `${phase.phase} · ${phase.kw.toFixed(1)} / ${phase.limit_kw} kW`);
    }

    // Arrange houses around the pole of their phase, in house-number order.
    const byPhase: Record<PhaseName, typeof state.meters> = { L1: [], L2: [], L3: [] };
    for (const meter of state.meters) byPhase[meter.phase].push(meter);
    const drops: number[] = [];
    for (const phase of PHASES) {
      const members = byPhase[phase].sort((a, b) => Number(a.house_id.slice(1)) - Number(b.house_id.slice(1)));
      members.forEach((meter, index) => {
        let house = this.houses.get(meter.house_id);
        if (!house) {
          house = this.createHouse(meter.house_id, meter.pv_kw > 0);
          this.houses.set(meter.house_id, house);
        }
        const spread = 0.1;
        const angle = PHASE_ANGLE[phase] + (index - (members.length - 1) / 2) * spread;
        const ring = index % 2 === 0 ? HOUSE_RADIUS : HOUSE_RADIUS + 0.7;
        house.target.copy(polar(angle, ring));
        if (house.phase === null) house.group.position.copy(house.target);
        house.phase = phase;
        house.group.lookAt(0, 0, 0);
        house.group.rotateY(Math.PI);

        const net = meter.net_kw;
        const height = THREE.MathUtils.clamp(Math.abs(net) * 0.18, 0.02, 1.4);
        house.bar.scale.y = height;
        house.bar.position.y = 0.48 + height / 2;
        const exporting = net < 0;
        house.barMaterial.color.set(exporting ? "#199e70" : "#3987e5");
        house.barMaterial.emissive.set(exporting ? "#199e70" : "#3987e5");
        house.window.emissiveIntensity = 0.15 + Math.min(meter.consumption_kw / 3, 1) * 1.6;
        const flagged = meter.flag !== "ok";
        house.ringMaterial.color.set(flagged ? "#fab219" : "#0ca30c");
        house.ringMaterial.opacity = flagged || meter.shifted ? 0.85 : 0;

        const pole = polar(PHASE_ANGLE[phase], POLE_RADIUS, 1.85);
        drops.push(pole.x, pole.y, pole.z, house.target.x, 0.3, house.target.z);
      });
    }
    this.serviceDrops.geometry.setAttribute("position", new THREE.Float32BufferAttribute(drops, 3));
  }

  // ------------------------------------------------------------- interaction

  private pick(event: MouseEvent): TwinTarget {
    const rect = this.renderer.domElement.getBoundingClientRect();
    this.pointer.set(((event.clientX - rect.left) / rect.width) * 2 - 1, -((event.clientY - rect.top) / rect.height) * 2 + 1);
    this.raycaster.setFromCamera(this.pointer, this.camera);
    const candidates = [this.transformer, ...[...this.houses.values()].map((house) => house.group)];
    const hit = this.raycaster.intersectObjects(candidates, true)[0];
    let object: THREE.Object3D | null = hit?.object ?? null;
    while (object) {
      if (object.userData.kind === "transformer") return { kind: "transformer" };
      if (object.userData.kind === "house") return { kind: "house", id: object.userData.id as string };
      object = object.parent;
    }
    return null;
  }

  private handleDoubleClick = (event: MouseEvent) => {
    const target = this.pick(event);
    this.focus(target);
    this.callbacks.onDoubleClick(target);
  };

  private handlePointerMove = (event: PointerEvent) => {
    const target = this.pick(event);
    const same =
      target?.kind === this.hovered?.kind &&
      (target?.kind !== "house" || (this.hovered?.kind === "house" && this.hovered.id === target.id));
    this.renderer.domElement.style.cursor = target ? "pointer" : "grab";
    if (!same) {
      this.hovered = target;
      this.callbacks.onHover(target);
    }
  };

  private handlePointerLeave = () => {
    this.hovered = null;
    this.callbacks.onHover(null);
  };

  /** Fly the camera to the transformer, a house, or back to the overview. */
  focus(target: TwinTarget) {
    this.controls.autoRotate = false;
    if (target?.kind === "transformer") {
      this.cameraGoal = { position: new THREE.Vector3(2.6, 2.4, 4.0), target: new THREE.Vector3(0, 1.2, 0.2) };
      this.shockwaveAge = 0;
      this.shockwaveMaterial.color.set(HALO_COLOR[this.haloStatus]);
    } else if (target?.kind === "house") {
      const house = this.houses.get(target.id);
      if (!house) return;
      const outward = house.target.clone().setY(0).normalize();
      this.cameraGoal = {
        position: house.target.clone().add(outward.multiplyScalar(2.8)).add(new THREE.Vector3(0.8, 2.2, 0)),
        target: house.target.clone().setY(0.3),
      };
    } else {
      this.cameraGoal = { position: HOME_POSITION.clone(), target: HOME_TARGET.clone() };
    }
  }

  // --------------------------------------------------------------- animation

  private animate = () => {
    this.frame = requestAnimationFrame(this.animate);
    const dt = Math.min(this.clock.getDelta(), 0.05);
    const time = this.clock.elapsedTime;

    if (this.cameraGoal) {
      const blend = 1 - Math.exp(-dt * 3.2);
      this.camera.position.lerp(this.cameraGoal.position, blend);
      this.controls.target.lerp(this.cameraGoal.target, blend);
      if (this.camera.position.distanceTo(this.cameraGoal.position) < 0.02) this.cameraGoal = null;
    }
    this.controls.update();

    // Thermal glow and status halo.
    const glow = this.heat * (0.75 + 0.25 * Math.sin(time * 3));
    for (const material of this.heatMaterials) {
      material.emissive.setRGB(0.32 * glow, 0.07 * glow, 0.02 * glow);
    }
    const pulse = this.haloStatus === "overloaded" ? 6 : this.haloStatus === "near_limit" ? 3.5 : 1.5;
    this.haloMaterial.opacity = 0.35 + 0.3 * Math.sin(time * pulse);

    if (this.shockwaveAge < 1.2) {
      this.shockwaveAge += dt;
      const progress = this.shockwaveAge / 1.2;
      this.shockwave.scale.setScalar(1.5 + progress * 4);
      this.shockwaveMaterial.opacity = 0.8 * (1 - progress);
    }

    // Energy flowing out along each phase feeder.
    const positions = this.particles.geometry.getAttribute("position") as THREE.BufferAttribute;
    const colors = this.particles.geometry.getAttribute("color") as THREE.BufferAttribute;
    const point = new THREE.Vector3();
    PHASES.forEach((phase, phaseIndex) => {
      const feeder = this.feeders.get(phase);
      for (let k = 0; k < PARTICLES_PER_PHASE; k += 1) {
        const slot = phaseIndex * PARTICLES_PER_PHASE + k;
        if (!feeder) {
          positions.setXYZ(slot, 0, -10, 0);
          continue;
        }
        feeder.offsets[k] = (feeder.offsets[k] + dt * feeder.speed) % 1;
        feeder.curve.getPointAt(feeder.offsets[k], point);
        positions.setXYZ(slot, point.x, point.y + 0.02, point.z);
        colors.setXYZ(slot, feeder.color.r, feeder.color.g, feeder.color.b);
      }
    });
    positions.needsUpdate = true;
    colors.needsUpdate = true;

    for (const house of this.houses.values()) {
      house.group.position.lerp(house.target, 1 - Math.exp(-dt * 2));
    }

    this.renderer.render(this.scene, this.camera);
    this.labels.render(this.scene, this.camera);
  };

  private resize() {
    const { clientWidth: width, clientHeight: height } = this.container;
    if (!width || !height) return;
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(width, height);
    this.labels.setSize(width, height);
  }

  dispose() {
    this.disposed = true;
    cancelAnimationFrame(this.frame);
    this.resizeObserver.disconnect();
    this.renderer.domElement.removeEventListener("dblclick", this.handleDoubleClick);
    this.renderer.domElement.removeEventListener("pointermove", this.handlePointerMove);
    this.renderer.domElement.removeEventListener("pointerleave", this.handlePointerLeave);
    this.controls.dispose();
    this.scene.traverse((object) => {
      const mesh = object as THREE.Mesh;
      mesh.geometry?.dispose();
      const materials = Array.isArray(mesh.material) ? mesh.material : mesh.material ? [mesh.material] : [];
      for (const material of materials) {
        for (const value of Object.values(material)) {
          if (value instanceof THREE.Texture) value.dispose();
        }
        material.dispose();
      }
    });
    this.renderer.dispose();
    this.renderer.domElement.remove();
    this.labels.domElement.remove();
  }
}
