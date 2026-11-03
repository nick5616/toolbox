/** 3D swing (FX1): perspective rotation of the frame around its centre. Mirrors fx1math.swingMap. */
import { simplePass } from "./pass";
import { registerPost } from "./registry";

const SRC = `
uniform float u_rx; uniform float u_ry; uniform float u_persp; uniform float u_mirror;
void main() {
  if (u_rx == 0.0 && u_ry == 0.0) { o = texture(u_src, uv); return; }
  float s = min(u_res.x, u_res.y);
  vec2 p = (uv - 0.5) * u_res / s;
  float ca = cos(u_rx), sa = sin(u_rx), cb = cos(u_ry), sb = sin(u_ry);
  float invD = u_persp * 0.8;
  vec3 n = vec3(sb, -cb * sa, cb * ca);
  float np = n.x * p.x + n.y * p.y;
  float den = n.z - invD * np;
  if (den <= 1e-4) { o = vec4(0.0); return; }
  float t = n.z / den;
  vec3 X = vec3(t * p, -np / den);
  float vy = X.y * ca + X.z * sa;
  float vz = -X.y * sa + X.z * ca;
  vec2 q = vec2(X.x * cb - vz * sb, vy);
  vec2 suv = q * s / u_res + 0.5;
  if (u_mirror > 0.5) {
    suv = 1.0 - abs(1.0 - mod(suv, 2.0));
  } else if (suv.x < 0.0 || suv.x > 1.0 || suv.y < 0.0 || suv.y > 1.0) {
    o = vec4(0.0); return;
  }
  o = texture(u_src, suv);
}`;

registerPost({
  type: "swing",
  label: "3D swing",
  kind: "pass",
  params: {
    rotX: { kind: "number", label: "Rotate X", min: -70, max: 70, default: 0 },
    rotY: { kind: "number", label: "Rotate Y", min: -70, max: 70, default: 0 },
    persp: { kind: "number", label: "Perspective", min: 0, max: 1, default: 0.5 },
    mirror: { kind: "bool", label: "Mirror edges", default: true },
  },
  create(ctx) {
    return simplePass(ctx, SRC, (p, f) => {
      const d = Math.PI / 180;
      p.f1("u_rx", (f.params.rotX as number) * d)
        .f1("u_ry", (f.params.rotY as number) * d)
        .f1("u_persp", f.params.persp as number)
        .f1("u_mirror", f.params.mirror === false ? 0 : 1);
    });
  },
});
