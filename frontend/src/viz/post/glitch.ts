/** Glitch (SPEC.md §6.7): rare displaced blocks with an RGB split, only while a drop is hitting. Frozen to 30 steps/s and hashed, so every frame is reproducible. */
import { glitchStep, glitchStrength } from "./px1math";
import { simplePass } from "./pass";
import { registerPost } from "./registry";

const SRC = `
uniform float u_strength; uniform float u_step; uniform float u_seed;
void main() {
  vec4 base = texture(u_src, uv);
  if (u_strength <= 0.0) { o = base; return; }
  vec2 cell = floor(uv * vec2(24.0, 14.0));
  float h = hash21(cell + vec2(u_step * 1.37 + u_seed, u_step * 0.71));
  if (h < 1.0 - 0.18 * u_strength) { o = base; return; }
  vec2 h2 = hash22(cell * 3.1 + u_step + u_seed) - 0.5;
  vec2 shift = vec2(h2.x * 0.12, h2.y * 0.02) * u_strength;
  float split = (0.004 + 0.048 * h2.y * h2.y) * u_strength;
  float r = texture(u_src, uv + shift + vec2(split, 0.0)).r;
  vec4 g = texture(u_src, uv + shift);
  float b = texture(u_src, uv + shift - vec2(split, 0.0)).b;
  o = vec4(r, g.g, b, g.a);
}`;

registerPost({
  type: "glitch",
  label: "Glitch",
  kind: "pass",
  params: {
    amount: { kind: "number", label: "Amount", min: 0, max: 1, default: 0.7 },
  },
  create(ctx) {
    return simplePass(ctx, SRC, (p, f) => {
      const drop = f.signals.value("drop.pulse", f.tMs, 5, 200);
      p.f1("u_strength", glitchStrength(drop, f.params.amount as number))
        .f1("u_step", glitchStep(f.tMs))
        .f1("u_seed", (f.seed % 1000) * 0.137);
    });
  },
});
