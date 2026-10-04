import { existsSync } from "node:fs";
import path from "node:path";

export const dynamic = "force-dynamic";

// The Sketchfab model cannot be downloaded without an account, so the 3D view
// asks here whether it has been added and otherwise uses its built-in model.
const CANDIDATES = ["models/transformer.glb", "models/transformer/scene.gltf"];

export function GET() {
  const found = CANDIDATES.find((file) => existsSync(path.join(process.cwd(), "public", file)));
  return Response.json({ url: found ? `/${found}` : null });
}
