import { useEffect, useRef, useState } from "react";

/**
 * Panache du cran maximal : WebGL pour la flamme et canvas 2D pour les
 * étincelles. Le fallback garde le même mouvement quand WebGL est absent.
 */

const VERTEX_SHADER = `
attribute vec2 a_pos;
void main() { gl_Position = vec4(a_pos, 0.0, 1.0); }
`;

const FRAGMENT_SHADER = `
precision mediump float;
uniform vec2 u_res;
uniform float u_time;
uniform float u_power;

float hash(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
}

float noise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x),
    mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x),
    u.y
  );
}

float fbm(vec2 p) {
  float v = 0.0;
  float a = 0.5;
  for (int i = 0; i < 4; i++) {
    v += a * noise(p);
    p = p * 2.1 + vec2(37.4, 17.9);
    a *= 0.5;
  }
  return v;
}

void main() {
  vec2 uv = gl_FragCoord.xy / u_res;
  float d = 1.0 - uv.x;
  float y = (uv.y - 0.5) * 2.0;
  float turb = fbm(vec2(uv.x * 5.5 + u_time * 3.2, uv.y * 3.5 + u_time * 0.4)) - 0.5;
  float sway = (fbm(vec2(u_time * 1.6, uv.x * 2.0)) - 0.5) * 0.55;
  float width = mix(1.05, 0.12, smoothstep(0.0, 1.0, d)) * mix(0.35, 1.0, u_power);
  float reach = mix(0.18, 1.05, u_power);
  float shape = 1.0 - smoothstep(width * 0.35, width, abs(y + sway * d + turb * (0.35 + d * 0.9)));
  float len = 1.0 - smoothstep(0.15 * u_power, reach, d + turb * 0.45 * u_power);
  float flame = clamp(shape * len, 0.0, 1.0);
  float core = (1.0 - smoothstep(0.0, 0.38 * mix(0.5, 1.0, u_power), d + turb * 0.15)) * (1.0 - smoothstep(0.0, 0.55, abs(y)));
  flame = clamp(flame + core * 0.6, 0.0, 1.0) * mix(0.6, 1.0, u_power);
  float glow = (1.0 - smoothstep(0.0, 0.85, d)) * (1.0 - smoothstep(0.2, 1.15, abs(y))) * 0.4 * u_power;
  vec3 c600 = vec3(0.082, 0.365, 0.988);
  vec3 c400 = vec3(0.318, 0.635, 1.0);
  vec3 c200 = vec3(0.741, 0.867, 1.0);
  vec3 col = mix(c600, c400, smoothstep(0.2, 0.6, flame));
  col = mix(col, c200, smoothstep(0.62, 0.95, flame) * (1.0 - smoothstep(0.1, 0.75, d)));
  float hot = smoothstep(0.9, 1.0, flame) * (1.0 - smoothstep(0.02, 0.3, d));
  col = mix(col, vec3(1.0), hot);
  float alpha = smoothstep(0.04, 0.55, flame) * 0.96 + glow;
  gl_FragColor = vec4(col, clamp(alpha, 0.0, 1.0));
}
`;

function StarField() {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;

    const { width, height } = canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    canvas.width = width * dpr;
    canvas.height = height * dpr;
    ctx.scale(dpr, dpr);

    type Spark = { x: number; y: number; speed: number; size: number; alpha: number };
    const spawn = (seeded: boolean): Spark => {
      const intensity = Math.random();
      return {
        x: seeded ? Math.random() * width : width + 4,
        y: 1 + Math.random() * (height - 2),
        speed: 18 + 90 * intensity,
        size: 0.6 + intensity,
        alpha: 0.4 + 0.55 * intensity,
      };
    };

    const sparks = Array.from({ length: 40 }, () => spawn(true));
    let shooting: (Spark & { life: number }) | null = null;
    let frame = 0;
    let last = performance.now();

    const streak = (x: number, y: number, length: number, size: number, alpha: number, width = length + size) => {
      const gradient = ctx.createLinearGradient(x, y, x + length, y);
      gradient.addColorStop(0, `rgba(255,255,255,${alpha.toFixed(3)})`);
      gradient.addColorStop(1, "rgba(255,255,255,0)");
      ctx.fillStyle = gradient;
      ctx.fillRect(x, y - size / 2, width, size);
    };

    const draw = (now: number) => {
      const dt = Math.min((now - last) / 1000, 0.05);
      last = now;
      ctx.clearRect(0, 0, width, height);
      for (const spark of sparks) {
        spark.x -= spark.speed * dt;
        if (spark.x < -6) Object.assign(spark, spawn(false));
        streak(spark.x, spark.y, 0.05 * spark.speed, spark.size, spark.alpha);
      }
      if (!shooting && Math.random() < dt / 2.5) {
        shooting = { ...spawn(false), speed: 260 + 120 * Math.random(), size: 1.2, alpha: 0.9, life: 1 };
      }
      if (shooting) {
        shooting.x -= shooting.speed * dt;
        shooting.life -= 0.9 * dt;
        if (shooting.x < -40 || shooting.life <= 0) shooting = null;
        else streak(shooting.x, shooting.y, 26, 1.2, shooting.alpha * Math.max(shooting.life, 0), 26);
      }
      frame = requestAnimationFrame(draw);
    };

    frame = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(frame);
  }, []);

  return <canvas ref={ref} aria-hidden className="absolute inset-0 size-full" />;
}

function PixelDust() {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;

    const { width, height } = canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    canvas.width = width * dpr;
    canvas.height = height * dpr;
    ctx.scale(dpr, dpr);
    const cols = Math.ceil(width / 3);
    const rows = Math.ceil(height / 3);
    const palette = [[142, 197, 255], [81, 162, 255], [43, 127, 255], [21, 93, 252]];
    let frame = 0;
    let last = 0;

    const draw = (now: number) => {
      if (now - last > 70) {
        last = now;
        ctx.clearRect(0, 0, width, height);
        for (let x = 0; x < cols; x += 1) {
          const intensity = x / (cols - 1);
          const density = 0.78 * Math.pow(intensity, 1.6);
          for (let y = 0; y < rows; y += 1) {
            if (Math.random() >= density) continue;
            const color = palette[(Math.random() * palette.length) | 0]!;
            const alpha = (0.15 + 0.85 * Math.random()) * (0.35 + 0.65 * intensity);
            ctx.fillStyle = `rgba(${color[0]},${color[1]},${color[2]},${alpha.toFixed(3)})`;
            ctx.fillRect(3 * x, 3 * y, 2, 2);
          }
        }
      }
      frame = requestAnimationFrame(draw);
    };

    frame = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(frame);
  }, []);

  return (
    <>
      <div className="absolute inset-0 bg-gradient-to-l from-blue-300/90 via-blue-300/30 to-transparent" />
      <canvas ref={ref} aria-hidden className="absolute inset-0 size-full" />
    </>
  );
}

export function EffortFlame() {
  const ref = useRef<HTMLCanvasElement>(null);
  const [fallback, setFallback] = useState(false);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const gl = canvas.getContext("webgl", { alpha: true, premultipliedAlpha: false });
    if (!gl) {
      setFallback(true);
      return;
    }

    const { width, height } = canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    canvas.width = width * dpr;
    canvas.height = height * dpr;
    gl.viewport(0, 0, canvas.width, canvas.height);

    const compile = (type: number, source: string) => {
      const shader = gl.createShader(type)!;
      gl.shaderSource(shader, source);
      gl.compileShader(shader);
      return shader;
    };

    const program = gl.createProgram()!;
    gl.attachShader(program, compile(gl.VERTEX_SHADER, VERTEX_SHADER));
    gl.attachShader(program, compile(gl.FRAGMENT_SHADER, FRAGMENT_SHADER));
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      setFallback(true);
      return;
    }
    gl.useProgram(program);

    const buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const position = gl.getAttribLocation(program, "a_pos");
    gl.enableVertexAttribArray(position);
    gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);
    gl.uniform2f(gl.getUniformLocation(program, "u_res"), canvas.width, canvas.height);

    const time = gl.getUniformLocation(program, "u_time");
    const power = gl.getUniformLocation(program, "u_power");
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    let frame = 0;
    const start = performance.now();

    const draw = (now: number) => {
      const elapsed = (now - start) / 1000;
      gl.uniform1f(time, elapsed);
      const ramp = Math.min(elapsed / 1.4, 1);
      gl.uniform1f(power, 1 - Math.pow(1 - ramp, 3));
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      frame = requestAnimationFrame(draw);
    };

    frame = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(frame);
  }, []);

  if (fallback) return <PixelDust />;

  return (
    <>
      <div className="absolute inset-0 rounded-lg bg-[rgba(16,24,40,0.62)]" />
      <StarField />
      <canvas ref={ref} aria-hidden className="absolute inset-0 size-full" />
    </>
  );
}
