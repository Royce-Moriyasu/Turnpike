// Lane arrows drawn like US lane-use signs (MUTCD R3-5/R3-6): one stem with a curved branch per
// direction the lane allows, e.g. straight + right is a stem with a straight arrow and a branch
// curving off to the right.

type Branch = { path: string; end: [number, number]; angle: number }; // angle: degrees, 0 = right, -90 = up

const STEM_TOP = 13; // where branches leave the stem
const HEAD = 4; // arrowhead length
const HALF = 3.2; // arrowhead half-width

/** One branch for a right-hand (or straight) movement, leaving a stem at x = s. */
function rightBranch(kind: string, s: number): Branch {
  switch (kind) {
    case "slight right":
      return { path: `M${s} 16 C${s} 11.5 ${s + 1} 9.8 ${s + 4} 7.2`, end: [s + 4, 7.2], angle: -45 };
    case "right":
      return { path: `M${s} 17 C${s} 11.5 ${s + 1.8} 9.5 ${s + 6} 9.5`, end: [s + 6, 9.5], angle: 0 };
    case "sharp right":
      return { path: `M${s} 14 C${s} 8.5 ${s + 4} 8.5 ${s + 5.5} 12`, end: [s + 5.5, 12], angle: 60 };
    default: // straight
      return { path: `M${s} ${STEM_TOP + 1} L${s} 7`, end: [s, 7], angle: -90 };
  }
}

/** A branch and whether to draw it flipped about the stem (left-hand movements). */
function branch(kind: string, s: number): Branch & { flip: boolean } {
  if (kind === "uturn") {
    return { path: `M${s} 15 L${s} 9 A3.5 3.5 0 0 0 ${s - 7} 9 L${s - 7} 11`, end: [s - 7, 11], angle: 90, flip: false };
  }
  const left = kind.includes("left");
  return { ...rightBranch(left ? kind.replace("left", "right") : kind, s), flip: left };
}

function head([x, y]: [number, number], angle: number): string {
  const a = (angle * Math.PI) / 180;
  const [dx, dy] = [Math.cos(a), Math.sin(a)];
  const tip = [x + HEAD * dx, y + HEAD * dy];
  const left = [x - HALF * dy, y + HALF * dx];
  const right = [x + HALF * dy, y - HALF * dx];
  return [tip, left, right].map((p) => p.map((v) => v.toFixed(2)).join(",")).join(" ");
}

interface Props {
  indications: string[]; // Mapbox lane indications, e.g. ["straight", "right"]
  className?: string;
}

export default function LaneArrow({ indications, className = "h-6 w-6" }: Props) {
  const kinds = indications.length ? indications : ["straight"];
  const toRight = kinds.some((k) => k.includes("right"));
  const toLeft = kinds.some((k) => k.includes("left") || k === "uturn");
  // put the stem off-center so the branches fit: right branches need room on the right
  const s = toRight && toLeft ? 12 : toRight ? 7.5 : toLeft ? 16.5 : 12;
  const branches = kinds.map((k) => branch(k, s));
  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden="true">
      {branches.map((b, i) => (
        <g key={i} transform={b.flip ? `translate(${2 * s} 0) scale(-1 1)` : undefined}>
          {/* stem and branch as one line, so there's no seam where they meet */}
          <path d={b.path.replace(/^M/, `M${s} 22 L`)} fill="none" stroke="currentColor" strokeWidth={2.6} strokeLinejoin="round" />
          <polygon points={head(b.end, b.angle)} fill="currentColor" />
        </g>
      ))}
    </svg>
  );
}
