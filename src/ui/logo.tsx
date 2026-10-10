import { useEffect, useRef, useState, type CSSProperties, type MouseEvent, type PointerEvent } from "react";

/** What the editor is doing, as the logo shows it. */
export type LogoState = "idle" | "saving" | "saved" | "error";

/** Tile tones: violet, Lavender, Lilac and white (blank, the header colour). */
type Tone = "v" | "lv" | "li" | "w";
const SIZE = 4;
const TILE = 5;
/** The brand mosaic, row by row: violet stays a minority of the 16 tiles whatever the order. */
const BASE: Tone[] = ["v", "w", "lv", "w", "w", "li", "w", "v", "lv", "w", "v", "w", "w", "v", "w", "li"];

const SHUFFLE_MS = 280;
const RIPPLE_MS = 1000;
const BURST_MS = 1000;
const SHAKE_MS = 600;

const reducedMotion = () => matchMedia("(prefers-reduced-motion: reduce)").matches;
/** A permutation of `tones` different from it (same counts, so violet never grows). */
const shuffled = (tones: Tone[]): Tone[] => {
  const next = [...tones];
  for (let i = next.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [next[i], next[j]] = [next[j]!, next[i]!];
  }
  return next.every((t, i) => t === tones[i]) ? shuffled(tones) : next;
};

/**
 * The pixel mosaic next to the brand, as live tiles. CSS runs the ambient wave, the hover speed-up
 * and every keyframe; this component switches them on from the app state (saving scan + shuffle,
 * saved burst, error shake + desaturate) and reshuffles the tiles when clicked.
 */
export function Logo({ state }: { state: LogoState }) {
  const [tones, setTones] = useState(BASE);
  const [ripple, setRipple] = useState<{ n: number; x: number; y: number }>();
  const [fx, setFx] = useState<"burst" | "shake">();
  const rippleCount = useRef(0);
  const timers = useRef(new Set<ReturnType<typeof setTimeout>>());
  const later = (fn: () => void, ms: number) => {
    const id = setTimeout(() => {
      timers.current.delete(id);
      fn();
    }, ms);
    timers.current.add(id);
  };
  useEffect(() => {
    const pending = timers.current;
    return () => {
      for (const id of pending) clearTimeout(id);
      pending.clear();
    };
  }, []);

  // While saving the tiles keep trading places; afterwards they settle back into the mosaic.
  const previous = useRef(state);
  useEffect(() => {
    const from = previous.current;
    previous.current = state;
    if (state === "saving") {
      if (reducedMotion()) return;
      const id = setInterval(() => setTones(shuffled), SHUFFLE_MS);
      return () => clearInterval(id);
    }
    if (from !== "saving") return;
    setTones(BASE);
    if (reducedMotion()) return;
    if (state === "saved") {
      setFx("burst");
      later(() => setFx(undefined), BURST_MS);
    } else if (state === "error") {
      setFx("shake");
      later(() => setFx(undefined), SHAKE_MS);
    }
  }, [state]);

  /** Ripple spreading from the tile under the pointer (the centre for keyboard clicks). */
  const rippleFrom = (e: PointerEvent | MouseEvent) => {
    if (reducedMotion()) return;
    const box = e.currentTarget.getBoundingClientRect();
    const at = (client: number, start: number, length: number) =>
      e.detail === 0 && e.type === "click" ? 1.5 : Math.min(SIZE - 1, Math.max(0, Math.floor(((client - start) / length) * SIZE)));
    const x = at(e.clientX, box.left, box.width);
    const y = at(e.clientY, box.top, box.height);
    const n = ++rippleCount.current;
    setRipple({ n, x, y });
    later(() => setRipple((r) => (r?.n === n ? undefined : r)), RIPPLE_MS);
  };

  return (
    <button
      type="button"
      className="logo-btn"
      aria-label="Shuffle logo"
      title="Shuffle logo"
      onPointerEnter={rippleFrom}
      onClick={(e) => {
        setTones(shuffled);
        rippleFrom(e);
      }}
    >
      <svg
        className="logo"
        viewBox={`0 0 ${SIZE * TILE} ${SIZE * TILE}`}
        aria-hidden="true"
        focusable="false"
        data-state={state}
        data-fx={fx}
        data-ripple={ripple ? (ripple.n % 2 ? "a" : "b") : undefined}
      >
        {tones.map((tone, i) => {
          const x = i % SIZE;
          const y = Math.floor(i / SIZE);
          const style = {
            "--d": x + y,
            "--r": ripple ? Math.abs(x - ripple.x) + Math.abs(y - ripple.y) : 0,
          } as CSSProperties;
          return <rect key={i} x={x * TILE} y={y * TILE} width={TILE} height={TILE} data-tone={tone} style={style} />;
        })}
      </svg>
    </button>
  );
}
