/**
 * Original vector icon set (authored for TMEP, MIT licensed with the project).
 * Icons are ASS drawing commands in a 100x100 box centred on (0,0), built from
 * primitives. libass fills with the non-zero rule: overlaps fill, reversed contours
 * (hole=true) cut holes.
 */
const K = 0.5523;
const f = (n: number) => String(Math.round(n * 10) / 10);

export function circle(cx: number, cy: number, r: number, hole = false): string {
  const k = r * K;
  if (!hole) {
    return `m ${f(cx + r)} ${f(cy)} b ${f(cx + r)} ${f(cy + k)} ${f(cx + k)} ${f(cy + r)} ${f(cx)} ${f(cy + r)} b ${f(cx - k)} ${f(cy + r)} ${f(cx - r)} ${f(cy + k)} ${f(cx - r)} ${f(cy)} b ${f(cx - r)} ${f(cy - k)} ${f(cx - k)} ${f(cy - r)} ${f(cx)} ${f(cy - r)} b ${f(cx + k)} ${f(cy - r)} ${f(cx + r)} ${f(cy - k)} ${f(cx + r)} ${f(cy)}`;
  }
  return `m ${f(cx + r)} ${f(cy)} b ${f(cx + r)} ${f(cy - k)} ${f(cx + k)} ${f(cy - r)} ${f(cx)} ${f(cy - r)} b ${f(cx - k)} ${f(cy - r)} ${f(cx - r)} ${f(cy - k)} ${f(cx - r)} ${f(cy)} b ${f(cx - r)} ${f(cy + k)} ${f(cx - k)} ${f(cy + r)} ${f(cx)} ${f(cy + r)} b ${f(cx + k)} ${f(cy + r)} ${f(cx + r)} ${f(cy + k)} ${f(cx + r)} ${f(cy)}`;
}

/** Signed area > 0 means "fill" orientation in ASS screen space; holes need < 0. */
export function signedArea(pts: [number, number][]): number {
  return pts.reduce((a, [x, y], i) => {
    const [x2, y2] = pts[(i + 1) % pts.length]!;
    return a + (x * y2 - x2 * y);
  }, 0);
}

export function poly(pts: [number, number][], hole = false): string {
  const area = signedArea(pts);
  const p = (hole ? area > 0 : area < 0) ? [...pts].reverse() : pts;
  return `m ${f(p[0]![0])} ${f(p[0]![1])} ${p
    .slice(1)
    .map(([x, y]) => `l ${f(x)} ${f(y)}`)
    .join(' ')}`;
}

export function rect(x0: number, y0: number, x1: number, y1: number, hole = false): string {
  return poly(
    [
      [x0, y0],
      [x1, y0],
      [x1, y1],
      [x0, y1],
    ],
    hole,
  );
}

export function rrect(x0: number, y0: number, x1: number, y1: number, r: number, hole = false): string {
  const k = r * (1 - K);
  const cw = `m ${f(x0 + r)} ${f(y0)} l ${f(x1 - r)} ${f(y0)} b ${f(x1 - k)} ${f(y0)} ${f(x1)} ${f(y0 + k)} ${f(x1)} ${f(y0 + r)} l ${f(x1)} ${f(y1 - r)} b ${f(x1)} ${f(y1 - k)} ${f(x1 - k)} ${f(y1)} ${f(x1 - r)} ${f(y1)} l ${f(x0 + r)} ${f(y1)} b ${f(x0 + k)} ${f(y1)} ${f(x0)} ${f(y1 - k)} ${f(x0)} ${f(y1 - r)} l ${f(x0)} ${f(y0 + r)} b ${f(x0)} ${f(y0 + k)} ${f(x0 + k)} ${f(y0)} ${f(x0 + r)} ${f(y0)}`;
  if (!hole) return cw;
  return `m ${f(x0 + r)} ${f(y0)} b ${f(x0 + k)} ${f(y0)} ${f(x0)} ${f(y0 + k)} ${f(x0)} ${f(y0 + r)} l ${f(x0)} ${f(y1 - r)} b ${f(x0)} ${f(y1 - k)} ${f(x0 + k)} ${f(y1)} ${f(x0 + r)} ${f(y1)} l ${f(x1 - r)} ${f(y1)} b ${f(x1 - k)} ${f(y1)} ${f(x1)} ${f(y1 - k)} ${f(x1)} ${f(y1 - r)} l ${f(x1)} ${f(y0 + r)} b ${f(x1)} ${f(y0 + k)} ${f(x1 - k)} ${f(y0)} ${f(x1 - r)} ${f(y0)} l ${f(x0 + r)} ${f(y0)}`;
}

/** Thick line segment as a filled quad. */
export function bar(x0: number, y0: number, x1: number, y1: number, w: number): string {
  const dx = x1 - x0;
  const dy = y1 - y0;
  const len = Math.hypot(dx, dy) || 1;
  const nx = (-dy / len) * (w / 2);
  const ny = (dx / len) * (w / 2);
  return poly([
    [x0 + nx, y0 + ny],
    [x1 + nx, y1 + ny],
    [x1 - nx, y1 - ny],
    [x0 - nx, y0 - ny],
  ]);
}

function star(n: number, ro: number, ri: number, rot = -90): string {
  const pts: [number, number][] = [];
  for (let i = 0; i < n * 2; i++) {
    const r = i % 2 ? ri : ro;
    const a = ((rot + (i * 180) / n) * Math.PI) / 180;
    pts.push([r * Math.cos(a), r * Math.sin(a)]);
  }
  return poly(pts);
}

function gear(): string {
  const pts: [number, number][] = [];
  const teeth = 8;
  for (let i = 0; i < teeth * 4; i++) {
    const a = ((i / (teeth * 4)) * 360 - 90) * (Math.PI / 180);
    const r = i % 4 < 2 ? 46 : 34;
    pts.push([r * Math.cos(a), r * Math.sin(a)]);
  }
  return `${poly(pts)} ${circle(0, 0, 15, true)}`;
}

export const ICONS: Record<string, string> = {
  image: [rrect(-46, -36, 46, 36, 8), rrect(-38, -28, 38, 28, 4, true), poly([[-36, 26], [-12, -4], [4, 12], [14, 2], [36, 26]]), circle(18, -12, 7)].join(' '),
  video: [rrect(-46, -28, 14, 28, 8), poly([[20, -8], [46, -24], [46, 24], [20, 8]])].join(' '),
  audio: [[-36, 10], [-24, 22], [-12, 34], [0, 18], [12, 28], [24, 14], [36, 8]].map(([x, h]) => rrect(x! - 4, -h!, x! + 4, h!, 4)).join(' '),
  code: [bar(-14, -22, -38, 0, 9), bar(-38, 0, -14, 22, 9), bar(14, -22, 38, 0, 9), bar(38, 0, 14, 22, 9), bar(8, -32, -8, 32, 8)].join(' '),
  text: [rrect(-32, -44, 32, 44, 6), rect(-20, -28, 20, -20, true), rect(-20, -10, 20, -2, true), rect(-20, 8, 12, 16, true), rect(-20, 26, 4, 34, true)].join(' '),
  chart: [rect(-42, 34, 42, 42), rrect(-36, 6, -16, 30, 3), rrect(-10, -14, 10, 30, 3), rrect(16, -36, 36, 30, 3)].join(' '),
  trend: [bar(-42, 28, -12, -2, 9), bar(-12, -2, 6, 14, 9), bar(6, 14, 34, -22, 9), poly([[40, -34], [40, -8], [20, -28]])].join(' '),
  bolt: poly([[8, -48], [-30, 6], [-4, 6], [-12, 48], [30, -10], [4, -10]]),
  check: [bar(-34, 2, -10, 26, 13), bar(-10, 26, 36, -24, 13)].join(' '),
  cross: [bar(-30, -30, 30, 30, 13), bar(30, -30, -30, 30, 13)].join(' '),
  star: star(5, 48, 20),
  sparkle: [star(4, 46, 11, -90), star(4, 16, 4, -90).replace(/(-?[\d.]+) (-?[\d.]+)/g, (_, x, y) => `${f(Number(x) + 30)} ${f(Number(y) - 30)}`)].join(' '),
  heart: 'm 0 40 b -30 18 -46 4 -46 -14 b -46 -30 -34 -40 -22 -40 b -12 -40 -4 -34 0 -26 b 4 -34 12 -40 22 -40 b 34 -40 46 -30 46 -14 b 46 4 30 18 0 40',
  user: [circle(0, -18, 18), 'm -38 42 b -38 18 -22 6 0 6 b 22 6 38 18 38 42 l -38 42'].join(' '),
  users: [circle(-14, -16, 14), circle(20, -10, 11), 'm -42 40 b -42 18 -30 6 -14 6 b 2 6 14 18 14 40 l -42 40', 'm 18 40 b 18 26 14 16 8 10 b 12 8 16 8 20 8 b 34 8 44 18 44 40 l 18 40'].join(' '),
  clock: [circle(0, 0, 46), circle(0, 0, 37, true), bar(0, 0, 0, -26, 8), bar(0, 0, 18, 10, 8)].join(' '),
  money: [rrect(-46, -28, 46, 28, 6), rrect(-38, -20, 38, 20, 3, true), circle(0, 0, 12)].join(' '),
  bulb: [circle(0, -10, 32), rrect(-14, 18, 14, 34, 3), rrect(-10, 36, 10, 44, 3)].join(' '),
  gear: gear(),
  lock: [circle(0, -18, 26), circle(0, -18, 17, true), rrect(-34, -6, 34, 44, 8), circle(0, 14, 7, true), rect(-3, 14, 3, 30, true)].join(' '),
  chat: [rrect(-46, -40, 46, 22, 14), poly([[-24, 18], [-30, 44], [2, 18]])].join(' '),
  play: [circle(0, 0, 46), poly([[-12, -22], [-12, 22], [24, 0]], true)].join(' '),
  mic: [rrect(-14, -46, 14, 12, 14), 'm -30 0 b -30 18 -16 30 0 30 b 16 30 30 18 30 0 l 22 0 b 22 13 12 22 0 22 b -12 22 -22 13 -22 0', rect(-4, 28, 4, 44), rect(-18, 40, 18, 46)].join(' '),
  cloud: [circle(-20, 8, 20), circle(4, -6, 26), circle(26, 10, 18), rrect(-40, 8, 44, 28, 10)].join(' '),
  search: [circle(-8, -8, 32), circle(-8, -8, 22, true), bar(14, 14, 40, 40, 13)].join(' '),
  phone: [rrect(-26, -46, 26, 46, 8), rrect(-19, -36, 19, 30, 2, true), circle(0, 38, 4, true)].join(' '),
  book: ['m -46 -34 b -32 -40 -14 -40 -3 -32 l -3 40 b -14 32 -32 32 -46 38 l -46 -34', 'm 3 -32 b 14 -40 32 -40 46 -34 l 46 38 b 32 32 14 32 3 40 l 3 -32'].join(' '),
  target: [circle(0, 0, 46), circle(0, 0, 36, true), circle(0, 0, 26), circle(0, 0, 16, true), circle(0, 0, 8)].join(' '),
  arrow: poly([[-44, -10], [8, -10], [8, -32], [46, 0], [8, 32], [8, 10], [-44, 10]]),
  globe: [circle(0, 0, 46), circle(0, 0, 38, true), 'm 0 -38 b 14 -24 14 24 0 38 b -14 24 -14 -24 0 -38', 'm 0 -30 b -8 -16 -8 16 0 30 b 8 16 8 -16 0 -30', rect(-38, -4, 38, 4)].join(' '),
  fire: 'm 0 46 b -26 46 -40 28 -36 6 b -32 -14 -14 -22 -10 -46 b 6 -34 18 -20 20 -6 b 24 -14 28 -18 30 -24 b 40 -10 42 8 36 22 b 30 38 16 46 0 46',
  rocket: ['m 0 -48 b 18 -32 22 -8 18 20 l -18 20 b -22 -8 -18 -32 0 -48', circle(0, -12, 8, true), poly([[-18, 4], [-34, 26], [-18, 22]]), poly([[18, 4], [18, 22], [34, 26]]), poly([[-10, 24], [10, 24], [0, 46]])].join(' '),
};

/** Concept dictionary mapping spoken words to icons (lower-case, singular/plural). */
const CONCEPTS: Record<string, string> = {};
const add = (icon: string, words: string) => words.split(' ').forEach((w) => (CONCEPTS[w] = icon));
add('image', 'image images picture pictures photo photos photography art drawing drawings design designs graphic graphics');
add('video', 'video videos film films movie movies clip clips footage reel reels animation animations');
add('audio', 'audio sound sounds music song songs voice voices podcast podcasts speech');
add('code', 'code coding program programs programming software developer developers app apps api apis');
add('text', 'text texts writing article articles essay essays document documents blog blogs script scripts email emails copy');
add('chart', 'data chart charts analytics statistics stats metrics numbers report reports dashboard');
add('trend', 'growth grow grows growing increase revenue sales profit profits trend trends scale scaling');
add('bolt', 'fast faster fastest speed quick quickly instant instantly power powerful energy electricity');
add('check', 'yes correct right done success successful works win');
add('cross', 'no wrong mistake mistakes error errors fail fails failure bad');
add('star', 'quality best premium favorite top rating review reviews');
add('sparkle', 'ai magic generative intelligence smart automatic automation automate');
add('heart', 'love like likes health care heart');
add('user', 'person user customer client creator me you human');
add('users', 'people users customers team teams community audience followers');
add('clock', 'time hour hours minute minutes second seconds deadline schedule');
add('money', 'money cash dollar dollars rupee rupees price prices pricing cost costs budget pay paid free income');
add('bulb', 'idea ideas creative creativity insight insights tip tips learn');
add('gear', 'settings setting tool tools system systems process workflow workflows engine automation');
add('lock', 'security secure privacy private safe safety password');
add('chat', 'chat message messages conversation comment comments talk chatbot chatbots');
add('play', 'watch play youtube stream streaming');
add('mic', 'record recording microphone mic interview');
add('cloud', 'cloud online internet server servers storage');
add('search', 'search find google research discover');
add('phone', 'phone phones mobile smartphone iphone android');
add('book', 'book books course courses education study learning guide');
add('target', 'goal goals target focus strategy marketing');
add('globe', 'world global globally international website websites web');
add('fire', 'hot viral trending trend fire');
add('rocket', 'launch launches startup startups rocket boost');

export function iconFor(word: string): string | undefined {
  const w = word.toLowerCase().replace(/[^a-z0-9]/g, '');
  return CONCEPTS[w] ?? (w.endsWith('s') ? CONCEPTS[w.slice(0, -1)] : undefined);
}

export const ICON_NAMES = Object.keys(ICONS);
