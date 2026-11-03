/** Wave (FX1): sine ripple; "horizontal" waves travel along x and displace y. Mirrors fx1math.waveOffset. */
import { simplePass } from "./pass";
import { registerPost } from "./registry";

const SRC = `
uniform float u_amt; uniform float u_freq; uniform float u_phase; uniform float u_vert;
void main() {
  if (u_amt <= 0.0) { o = texture(u_src, uv); return; }
  vec2 suv = uv;
  if (u_vert > 0.5) suv.x += u_amt * 0.05 * sin(6.2831853 * (u_freq * uv.y) + u_phase);
  else suv.y += u_amt * 0.05 * sin(6.2831853 * (u_freq * uv.x) + u_phase);
  o = texture(u_src, suv);
}`;

registerPost({
  type: "wave",
  label: "Wave",
  kind: "pass",
  params: {
    amount: { kind: "number", label: "Amount", min: 0, max: 1, default: 0 },
    freq: { kind: "number", label: "Frequency", min: 1, max: 40, default: 8 },
    speed: { kind: "number", label: "Speed", min: 0, max: 8, default: 1 },
    dir: { kind: "enum", label: "Direction", options: ["horizontal", "vertical"], default: "horizontal" },
  },
  create(ctx) {
    return simplePass(ctx, SRC, (p, f) => {
      // Phase wrapped to one cycle so float precision holds on long timelines.
      const cycles = (f.params.speed as number) * (f.tMs / 1000);
      p.f1("u_amt", f.params.amount as number)
        .f1("u_freq", f.params.freq as number)
        .f1("u_phase", (cycles - Math.floor(cycles)) * Math.PI * 2)
        .f1("u_vert", f.params.dir === "vertical" ? 1 : 0);
    });
  },
});
