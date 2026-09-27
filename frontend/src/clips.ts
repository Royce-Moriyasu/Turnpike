// Which clip (drive) to show. The bake writes each clip to /clips/<name>/demo.json and lists them in
// /clips/index.json (tools/clip.py). The choice lives in the URL's ?clip=, so it survives reloads and
// is shared by the demo, the labeling tool (#label) and the CV review page (#cv).

export interface ClipInfo {
  name: string;
  title: string;
  frames: number;
}

export interface ClipIndex {
  default: string;
  clips: ClipInfo[];
}

export const FALLBACK_CLIP = "sr70";

export async function loadClipIndex(): Promise<ClipIndex> {
  const r = await fetch("/clips/index.json");
  if (!r.ok) throw new Error(`/clips/index.json: HTTP ${r.status} (bake a clip: tools/build_clip.py <name>)`);
  return r.json();
}

/** The clip named in the URL, if any. */
export const clipFromUrl = (): string | null => new URLSearchParams(location.search).get("clip");

/** The clip to show: the URL's if it exists, else the index default, else the first clip. */
export function pickClip(index: ClipIndex): string {
  const wanted = clipFromUrl();
  const names = index.clips.map((c) => c.name);
  if (wanted && names.includes(wanted)) return wanted;
  return names.includes(index.default) ? index.default : (names[0] ?? FALLBACK_CLIP);
}

/** Switch clips: updates ?clip= (keeping the #page) and reloads, so every page starts clean. */
export function openClip(name: string): void {
  const url = new URL(location.href);
  url.searchParams.set("clip", name);
  location.assign(url.toString());
}

/** For the dev tools: the clip in the URL (they are opened from the demo, which sets it). */
export const currentClip = (): string => clipFromUrl() ?? FALLBACK_CLIP;

export const demoUrl = (clip: string) => `/clips/${clip}/demo.json`;
