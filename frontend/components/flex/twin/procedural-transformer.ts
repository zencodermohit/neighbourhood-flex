import * as THREE from "three";

export type TransformerModel = {
  group: THREE.Group;
  /** Materials that glow with thermal loading. */
  heatMaterials: THREE.MeshStandardMaterial[];
  /** World-space tops of the three LV bushings, L1/L2/L3. */
  lvTerminals: THREE.Vector3[];
  height: number;
};

function porcelainProfile(height: number, coreRadius: number, shedRadius: number, sheds: number) {
  const points: THREE.Vector2[] = [new THREE.Vector2(0, 0), new THREE.Vector2(coreRadius * 1.6, 0)];
  const pitch = height / (sheds + 1);
  for (let index = 0; index < sheds; index += 1) {
    const base = pitch * (index + 0.6);
    points.push(new THREE.Vector2(coreRadius, base));
    points.push(new THREE.Vector2(shedRadius, base + pitch * 0.18));
    points.push(new THREE.Vector2(shedRadius * 0.92, base + pitch * 0.32));
    points.push(new THREE.Vector2(coreRadius, base + pitch * 0.45));
  }
  points.push(new THREE.Vector2(coreRadius, height), new THREE.Vector2(0, height));
  return points;
}

function nameplateTexture() {
  const canvas = document.createElement("canvas");
  canvas.width = 512;
  canvas.height = 256;
  const context = canvas.getContext("2d")!;
  context.fillStyle = "#d9dcd6";
  context.fillRect(0, 0, 512, 256);
  context.strokeStyle = "#3a3f44";
  context.lineWidth = 10;
  context.strokeRect(8, 8, 496, 240);
  context.fillStyle = "#1f2428";
  context.font = "bold 56px Segoe UI, Arial";
  context.fillText("DT-07", 36, 86);
  context.font = "34px Segoe UI, Arial";
  context.fillText("50 kVA · 11 / 0.433 kV", 36, 146);
  context.fillText("ONAN · Dyn11", 36, 200);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

/** A pole-mounted style distribution transformer built from primitives. */
export function buildProceduralTransformer(): TransformerModel {
  const group = new THREE.Group();
  const body = new THREE.MeshStandardMaterial({ color: "#7c8884", metalness: 0.55, roughness: 0.42 });
  const fins = new THREE.MeshStandardMaterial({ color: "#6f7b77", metalness: 0.5, roughness: 0.5 });
  const dark = new THREE.MeshStandardMaterial({ color: "#23272b", metalness: 0.4, roughness: 0.7 });
  const porcelain = new THREE.MeshStandardMaterial({ color: "#7a3b1e", metalness: 0.05, roughness: 0.22 });
  const copper = new THREE.MeshStandardMaterial({ color: "#c58b4f", metalness: 0.9, roughness: 0.3 });

  const add = (geometry: THREE.BufferGeometry, material: THREE.Material, x: number, y: number, z: number) => {
    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.set(x, y, z);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    group.add(mesh);
    return mesh;
  };

  // Skid and tank.
  for (const z of [-0.5, 0.5]) add(new THREE.BoxGeometry(2.3, 0.12, 0.16), dark, 0, 0.06, z);
  const tankHeight = 1.4;
  const tankBase = 0.12;
  add(new THREE.BoxGeometry(1.8, tankHeight, 1.1), body, 0, tankBase + tankHeight / 2, 0);
  add(new THREE.BoxGeometry(1.92, 0.06, 1.22), body, 0, tankBase + tankHeight + 0.03, 0);
  for (const x of [-0.6, 0, 0.6]) {
    for (const z of [-0.56, 0.56]) add(new THREE.BoxGeometry(0.05, tankHeight * 0.9, 0.03), body, x, tankBase + tankHeight / 2, z);
  }

  // Radiator banks on both ends.
  for (const side of [-1, 1]) {
    for (let index = 0; index < 9; index += 1) {
      const z = -0.44 + index * 0.11;
      add(new THREE.BoxGeometry(0.34, 1.1, 0.025), fins, side * 1.12, tankBase + 0.7, z);
    }
    for (const y of [tankBase + 0.18, tankBase + 1.22]) {
      const header = add(new THREE.CylinderGeometry(0.04, 0.04, 1.0, 12), fins, side * 0.98, y, 0);
      header.rotation.x = Math.PI / 2;
    }
  }

  // Conservator tank on supports.
  const conservatorY = tankBase + tankHeight + 0.5;
  const conservator = add(new THREE.CylinderGeometry(0.2, 0.2, 1.3, 32), body, 0, conservatorY, -0.38);
  conservator.rotation.z = Math.PI / 2;
  for (const x of [-0.65, 0.65]) {
    const cap = add(new THREE.SphereGeometry(0.2, 24, 12, 0, Math.PI * 2, 0, Math.PI / 2), body, x, conservatorY, -0.38);
    cap.rotation.z = x > 0 ? -Math.PI / 2 : Math.PI / 2;
    add(new THREE.BoxGeometry(0.06, 0.42, 0.06), dark, x * 0.7, conservatorY - 0.3, -0.38);
  }
  const pipe = add(new THREE.CylinderGeometry(0.035, 0.035, 0.4, 10), dark, 0.25, conservatorY - 0.3, -0.38);
  pipe.rotation.z = 0.5;

  // HV bushings (three tall) along the top.
  const hvProfile = porcelainProfile(0.75, 0.05, 0.11, 6);
  for (const x of [-0.5, 0, 0.5]) {
    const insulator = add(new THREE.LatheGeometry(hvProfile, 24), porcelain, x, tankBase + tankHeight + 0.06, 0.05);
    insulator.castShadow = true;
    add(new THREE.CylinderGeometry(0.035, 0.035, 0.12, 12), copper, x, tankBase + tankHeight + 0.9, 0.05);
  }

  // LV bushings (L1, L2, L3, neutral) on the front edge.
  const lvProfile = porcelainProfile(0.35, 0.04, 0.075, 3);
  const lvTerminals: THREE.Vector3[] = [];
  [-0.55, -0.18, 0.18, 0.55].forEach((x, index) => {
    add(new THREE.LatheGeometry(lvProfile, 20), porcelain, x, tankBase + tankHeight + 0.06, 0.42);
    add(new THREE.CylinderGeometry(0.03, 0.03, 0.1, 12), copper, x, tankBase + tankHeight + 0.46, 0.42);
    if (index < 3) lvTerminals.push(new THREE.Vector3(x, tankBase + tankHeight + 0.52, 0.42));
  });

  // Nameplate and warning sign on the front face.
  const plate = new THREE.Mesh(
    new THREE.PlaneGeometry(0.5, 0.25),
    new THREE.MeshStandardMaterial({ map: nameplateTexture(), roughness: 0.6, metalness: 0.2 }),
  );
  plate.position.set(-0.45, tankBase + 0.85, 0.553);
  group.add(plate);
  const warning = new THREE.Mesh(
    new THREE.CircleGeometry(0.11, 3),
    new THREE.MeshStandardMaterial({ color: "#f2b705", roughness: 0.5 }),
  );
  warning.position.set(0.45, tankBase + 0.9, 0.553);
  warning.rotation.z = Math.PI / 2;
  group.add(warning);

  return { group, heatMaterials: [body, fins], lvTerminals, height: tankBase + tankHeight + 0.96 };
}
