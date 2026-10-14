import { clamp, EASE, eo, reducedMotion, ss } from "./motion";

// The "how it works" stage: a terminal on the left, a canvas on the right, on
// an 18 second clock. Capture 0 to 3.6, extract 3.6 to 7.9, run 7.9 to 17.5,
// then the stage fades and the cycle restarts. The three step rails above it
// follow the same clock.

const NS = "http://www.w3.org/2000/svg";

type TraceRow = readonly [time: string, kind: string, body: string, nodeIndex?: number];

const TRACE: readonly TraceRow[] = [
  ["09:12:03", "start", "codex session in ~/work/api"],
  ["09:12:04", "user", '"patch the critical CVEs in our deps"'],
  ["09:12:06", "exec", "bun audit --json", 0],
  ["09:12:09", "read", "package.json"],
  ["09:12:11", "think", "1 critical: lodash 4.17.20"],
  ["09:12:12", "exec", "npm view lodash versions", 1],
  ["09:12:15", "note", "4.17.21 fixes CVE-2021-23337"],
  ["09:12:18", "edit", "package.json  lodash ^4.17.21", 2],
  ["09:12:19", "exec", "bun install"],
  ["09:12:31", "exec", "bun run check", 3],
  ["09:12:58", "out", "412 passed, 0 failed"],
  ["09:13:02", "user", '"diff looks right, push it"', 4],
  ["09:13:04", "exec", "git push -u origin fix/lodash"],
  ["09:13:07", "exec", "gh pr create --fill", 5],
  ["09:13:09", "end", "session saved"],
];

type Kind = "agent" | "shell" | "route" | "verify" | "approval";

type Node = { id: string; kind: Kind; name: string };

const NODES: readonly Node[] = [
  { id: "audit-deps", kind: "shell", name: "Audit dependencies" },
  { id: "patched", kind: "route", name: "Patched release?" },
  { id: "bump", kind: "agent", name: "Apply smallest bump" },
  { id: "checks", kind: "verify", name: "Run checks" },
  { id: "approve", kind: "approval", name: "Approve before push" },
  { id: "open-pr", kind: "shell", name: "Open pull request" },
];

const HUE: Record<Kind, string> = {
  agent: "var(--hue-agent)",
  shell: "var(--hue-shell)",
  route: "var(--hue-route)",
  verify: "var(--hue-verify)",
  approval: "var(--hue-approval)",
};

const KIND: Record<Kind, string> = {
  agent: "Agent",
  shell: "Shell",
  route: "Route",
  verify: "Verify",
  approval: "Approval",
};

const EDGE_LABEL = new Map([
  [1, "yes"],
  [3, "pass"],
]);

export const T = {
  line0: 1.2,
  lineStep: 0.11,
  fade0: 4.4,
  fade1: 5.0,
  E0: 4.5,
  STEP: 0.28,
  DUR: 0.6,
  EDGE0: 6.4,
  EDGESTEP: 0.12,
  RUN0: 7.9,
  CYCLE: 18,
  phases: [3.6, 7.9, 17.5] as const,
};

type Status = "pending" | "running" | "succeeded" | "failed" | "waiting";

type RunEvent = { t: number; n: number; s: Status; text: string; log?: [string, string] };

type Token = { e: number; t0: number; t1: number };

// the run as a fixed schedule in seconds; the retry and the approval get real screen time
const RUN = (() => {
  const ev: RunEvent[] = [];
  const tok: Token[] = [];
  let t = 0;

  const push = (n: number, s: Status, text: string, log?: [string, string]) =>
    ev.push({ t, n, s, text, log });

  const edge = (e: number) => {
    tok.push({ e, t0: t, t1: t + 0.25 });
    t += 0.25;
  };

  push(0, "running", "Running");
  t += 0.45;
  push(0, "succeeded", "Succeeded", ["audit-deps", "1 critical, lodash 4.17.20"]);
  edge(0);
  push(1, "running", "Running");
  t += 0.4;
  push(1, "succeeded", "Succeeded", ["patched", "yes, 4.17.21"]);
  edge(1);
  push(2, "running", "Running");
  t += 0.6;
  push(2, "succeeded", "Succeeded", ["bump", "1 file changed"]);
  edge(2);
  push(3, "running", "Running");
  t += 0.5;
  const fail = t;
  push(3, "failed", "Failed", ["checks", "verify failed, attempt 1 of 3"]);
  t += 1.4;
  const retry = t;
  push(3, "running", "Running, attempt 2");
  t += 1.1;
  const pass = t;
  push(3, "succeeded", "Succeeded", ["checks", "verify succeeded, attempt 2"]);
  edge(3);
  push(4, "running", "Running");
  t += 0.25;
  const wait = t;
  push(4, "waiting", "Waiting for you", ["approve", "waiting for you"]);
  t += 2.5;
  const ok = t;
  push(4, "succeeded", "Approved", ["approve", "approval granted"]);
  t += 0.6;
  edge(4);
  push(5, "running", "Running");
  t += 0.4;
  push(5, "succeeded", "Succeeded", ["open-pr", "PR #433 opened"]);

  return { ev, tok, total: t, fail, retry, pass, wait, ok };
})();

function runState(u: number) {
  // SAFETY: every node starts pending, the literal is one member of the Status union
  const st = NODES.map((n) => ({ s: "pending" as Status, text: KIND[n.kind] }));

  for (const e of RUN.ev) {
    if (e.t <= u) {
      st[e.n] = { s: e.s, text: e.text };
    }
  }

  let token: { e: number; p: number } | null = null;

  for (const k of RUN.tok) {
    if (u >= k.t0 && u < k.t1) {
      token = { e: k.e, p: (u - k.t0) / (k.t1 - k.t0) };
    }
  }

  const lit = RUN.tok.map((k) => (u < k.t0 ? 0 : u >= k.t1 ? 1 : (u - k.t0) / (k.t1 - k.t0)));

  return { st, token, lit };
}

// 0..1 while the verify card is failed or retrying, and while the approval waits; focus is the card that stays bright
function holdOf(u: number) {
  const h1 = ss(RUN.fail, RUN.fail + 0.35, u) - ss(RUN.pass, RUN.pass + 0.35, u);
  const h2 = ss(RUN.wait, RUN.wait + 0.35, u) - ss(RUN.ok + 0.35, RUN.ok + 0.7, u);

  return { hold: clamp(h1 + h2), focus: h1 > h2 ? 3 : 4 };
}

type Attrs = Record<string, string | number>;

function el<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Attrs = {}, parent?: Element) {
  const e = document.createElementNS(NS, tag);

  for (const k in attrs) {
    e.setAttribute(k, String(attrs[k]));
  }

  if (parent) {
    parent.append(e);
  }

  return e;
}

function txt(parent: Element, x: number, y: number, s: string, cls = "", attrs: Attrs = {}) {
  const t = el("text", { x, y, class: cls, ...attrs }, parent);
  t.textContent = s;

  return t;
}

const tf = (n: Element, x: number, y: number) =>
  n.setAttribute("transform", `translate(${x} ${y})`);

type Pt = { x: number; y: number };

type Rect = Pt & { w: number; h: number };

const rectOf = (p: Pt, w: number, h: number): Rect => ({ x: p.x, y: p.y, w, h });

const captureK = (t: number, i: number) => eo(0, 0.35, t - (T.line0 + i * T.lineStep));

const quietFade = (t: number) => ss(T.fade0, T.fade1, t);

// trace log: all fifteen lines in one column
function traceLog(parent: Element, x: number, y: number, lh: number) {
  return TRACE.map((r, i) => {
    const ly = y + i * lh;

    const g = el(
      "g",
      { class: `ln${r[3] == null ? "" : " ev"}`, transform: `translate(${x} ${ly})` },
      parent,
    );

    txt(g, 0, 0, r[0], "ln-t");
    txt(g, 74, 0, r[1], "ln-k");
    txt(g, 128, 0, r[2], "ln-b");
    g.style.opacity = "0";

    return { g, x, y: ly, ev: r[3] };
  });
}

// node card: icon tile, name, status line, status dot
function makeCard(parent: Element, node: Node, w: number, h: number) {
  const g = el("g", { class: "card", "data-s": "pending" }, parent);
  el("rect", { width: w, height: h, rx: 10, class: "card-bg" }, g);
  const ts = 28;
  const tx = 12;
  const ty = (h - ts) / 2;
  el(
    "rect",
    { x: tx, y: ty, width: ts, height: ts, rx: 6, fill: HUE[node.kind], "fill-opacity": 0.16 },
    g,
  );
  el(
    "use",
    {
      href: `#g-${node.kind}`,
      x: tx + ts / 2 - 7,
      y: ty + ts / 2 - 7,
      width: 14,
      height: 14,
      style: `color:${HUE[node.kind]}`,
    },
    g,
  );
  const nx = tx + ts + 10;
  txt(g, nx, h / 2 - 4, node.name, "card-name");
  const st = txt(g, nx, h / 2 + 13, KIND[node.kind], "card-st");
  const dx = w - 15;
  const dy = h - 15;
  el("circle", { cx: dx, cy: dy, r: 4.5, class: "dot" }, g);
  el("path", { d: `M${dx - 2.5} ${dy - 2.5}l5 5m0-5l-5 5`, class: "xx" }, g);
  g.style.opacity = "0";

  return {
    g,
    set(s: Status, text: string) {
      if (g.dataset.s !== s) {
        g.dataset.s = s;
      }

      if (st.textContent !== text) {
        st.textContent = text;
      }
    },
    move(x: number, y: number, o = 1) {
      tf(g, x, y);
      g.style.opacity = String(o);
    },
  };
}

type Card = ReturnType<typeof makeCard>;

// an edge draws itself (extract), lights up with the brand gradient (run) and can place the token along its length
function makeEdge(
  parent: Element,
  d: string,
  label?: string,
  lab: Partial<Pt> & { anchor?: string } = {},
) {
  const p = el("path", { d, class: "wire" }, parent);
  const len = p.getTotalLength();
  p.style.strokeDasharray = String(len);
  p.style.strokeDashoffset = String(len);
  const lit = el("path", { d, class: "wire lit" }, parent);
  lit.style.strokeDasharray = String(len);
  lit.style.strokeDashoffset = String(len);
  let lt: SVGTextElement | null = null;

  if (label) {
    lt = txt(
      parent,
      lab.x ?? 0,
      lab.y ?? 0,
      label,
      "elabel",
      lab.anchor ? { "text-anchor": lab.anchor } : {},
    );
    lt.style.opacity = "0";
  }

  return {
    len,
    draw(k: number) {
      p.style.strokeDashoffset = String(len * (1 - k));

      if (lt) {
        lt.style.opacity = String(k);
      }
    },
    light(k: number) {
      lit.style.strokeDashoffset = String(len * (1 - k));
    },
    at(t: number) {
      return p.getPointAtLength(len * clamp(t));
    },
  };
}

type Edge = ReturnType<typeof makeEdge>;

// edges for a snake of cards: straight hops, horizontal within a row, vertical between rows
function snakeEdges(parent: Element, pos: Pt[], cw: number, ch: number) {
  return [0, 1, 2, 3, 4].map((i) => {
    const A = pos[i];
    const B = pos[i + 1];

    if (!A || !B) {
      throw new Error("snake needs six positions");
    }

    let d: string;
    let lab: Pt & { anchor?: string };

    if (Math.abs(A.y - B.y) < 1) {
      const fwd = B.x > A.x;
      d = fwd
        ? `M${A.x + cw} ${A.y + ch / 2} L${B.x} ${B.y + ch / 2}`
        : `M${A.x} ${A.y + ch / 2} L${B.x + cw} ${B.y + ch / 2}`;
      lab = {
        x: fwd ? (A.x + cw + B.x) / 2 : (B.x + cw + A.x) / 2,
        y: A.y + ch / 2 - 7,
        anchor: "middle",
      };
    } else {
      d = `M${A.x + cw / 2} ${A.y + ch} L${B.x + cw / 2} ${B.y}`;
      lab = { x: A.x + cw / 2 + 10, y: (A.y + ch + B.y) / 2 + 4 };
    }

    return makeEdge(parent, d, EDGE_LABEL.get(i), lab);
  });
}

const drawEdges = (edges: Edge[], t: number) => {
  edges.forEach((e, i) => {
    e.draw(ss(T.EDGE0 + i * T.EDGESTEP, T.EDGE0 + 0.5 + i * T.EDGESTEP, t));
  });
};

// drift entrance: the card fades in with a small lift while its trace line fades out in place
const entM = (t: number, i: number) => EASE(clamp((t - (T.E0 + i * T.STEP)) / T.DUR));

function placeCard(i: number, t: number, to: Pt, card: Card, dim = 1) {
  const k = entM(t, i);
  card.move(to.x, to.y + (1 - k) * 12, k * dim);
}

function placeLine(l: { g: SVGGElement; x: number; y: number }, k: number, m: number) {
  l.g.style.opacity = String(k * (1 - ss(0, 0.45, m)));
  tf(l.g, l.x + (1 - k) * 6, l.y);
}

type Holds = { fail: Rect; failLabel: Pt; wait: Rect; okLabel: Pt };

// run layer: states, token, retry back-up, approval stop, hold outlines and labels
function makeRun(parent: Element, cards: Card[], edges: Edge[], holds: Holds) {
  const gH = el("g", {}, parent);
  const tok = el("circle", { r: 4.5, class: "tok" }, parent);
  tok.style.opacity = "0";

  const rect = (r: Rect, stroke: string, sw: number) => {
    const e = el(
      "rect",
      { x: r.x, y: r.y, width: r.w, height: r.h, rx: 10, fill: "none", stroke, "stroke-width": sw },
      gH,
    );

    e.style.opacity = "0";

    return e;
  };

  const failRect = rect(holds.fail, "var(--fail)", 1);
  const failT = txt(gH, holds.failLabel.x, holds.failLabel.y, "Failed, retrying 1 of 3", "tag");
  failT.style.fill = "var(--fail)";
  failT.style.opacity = "0";
  const waitRect = rect(holds.wait, "var(--wait)", 1.5);
  const okG = el("g", { transform: `translate(${holds.okLabel.x} ${holds.okLabel.y})` }, gH);
  okG.style.opacity = "0";

  const check = el(
    "path",
    {
      d: "M1 -4.5l3 3l6.5 -7",
      fill: "none",
      stroke: "var(--ok)",
      "stroke-width": 1.6,
      "stroke-linecap": "round",
      "stroke-linejoin": "round",
    },
    okG,
  );

  const CK = check.getTotalLength();
  check.style.strokeDasharray = String(CK);
  const okT = txt(okG, 17, 0, "Approved by you", "tag");
  okT.style.fill = "var(--ok)";
  const R = RUN;

  const place = (pt: DOMPoint) => {
    tok.setAttribute("cx", String(pt.x));
    tok.setAttribute("cy", String(pt.y));
    tok.style.opacity = "1";
  };

  const edgeAt = (i: number, p: number) => {
    const e = edges[i];

    if (e) {
      place(e.at(p));
    }
  };

  return function apply(u: number) {
    const S = runState(u);
    S.st.forEach((s, i) => {
      cards[i]?.set(s.s, s.text);
    });
    edges.forEach((e, i) => {
      e.light(S.lit[i] ?? 0);
    });

    if (S.token) {
      edgeAt(S.token.e, S.token.p);
    } else {
      tok.style.opacity = "0";
    }

    // retry: the token backs up a third of the way along the edge it came in on, then comes forward again
    const bk = ss(R.fail, R.fail + 0.5, u) - ss(R.retry, R.retry + 0.5, u);

    if (bk > 0) {
      edgeAt(2, 1 - 0.3 * bk);
      edges[2]?.light(1 - 0.3 * bk);
    }
    // approval: the token stops at the card until the approval lands
    else if (u >= R.wait && u < R.ok + 0.6) {
      edgeAt(3, 1);
    }

    failRect.style.opacity = String(ss(R.fail, R.fail + 0.3, u) - ss(R.retry, R.retry + 0.3, u));
    failT.style.opacity = String(
      ss(R.fail + 0.15, R.fail + 0.5, u) - ss(R.retry, R.retry + 0.3, u),
    );
    const br = ss(R.wait, R.wait + 0.4, u) - ss(R.ok, R.ok + 0.3, u);
    waitRect.style.opacity = String(
      br * (0.25 + 0.45 * (0.5 - 0.5 * Math.cos((2 * Math.PI * (u - R.wait)) / 1.8))),
    );
    okG.style.opacity = String(ss(R.ok, R.ok + 0.3, u));
    check.style.strokeDashoffset = String(CK * (1 - ss(R.ok + 0.1, R.ok + 0.45, u)));
  };
}

type TermRow =
  | { t0: number; kind: "cmd"; text: string; dur: number }
  | { t0: number; kind: "out"; text: string }
  | { t0: number; kind: "log"; log: [string, string]; status: Status };

const STATUS_FILL: Record<Status, string> = {
  succeeded: "var(--ok)",
  failed: "var(--fail)",
  waiting: "var(--wait)",
  running: "var(--run)",
  pending: "var(--subtle)",
};

// terminal: the three commands and what they print
function terminal(parent: Element, x0: number, y0: number) {
  const R = RUN;
  const RUN0 = T.RUN0;

  const TL: TermRow[] = [
    { t0: 0.2, kind: "cmd", text: "loopy import --from codex", dur: 0.8 },
    { t0: 1.1, kind: "out", text: "Recording session in ~/work/api" },
    { t0: 3.2, kind: "out", text: "15 events, 66 seconds" },
    { t0: 3.4, kind: "out", text: "Saved trace imp_7f2c" },
    { t0: 3.7, kind: "cmd", text: "loopy extract imp_7f2c", dur: 0.6 },
    { t0: 6.6, kind: "out", text: "6 nodes, 5 edges" },
    { t0: 6.8, kind: "out", text: "Every node points at its events" },
    { t0: 7.0, kind: "out", text: "Saved graph cve-patch" },
    { t0: 7.2, kind: "cmd", text: "loopy run cve-patch", dur: 0.6 },
    ...R.ev.flatMap((e): TermRow[] =>
      e.log ? [{ t0: RUN0 + e.t, kind: "log", log: e.log, status: e.s }] : [],
    ),
    { t0: RUN0 + R.total + 0.15, kind: "out", text: "Run #41 succeeded" },
  ];

  const lh = 22;
  let y = y0;

  const rows = TL.map((r, i) => {
    if (r.kind === "cmd" && i) {
      y += lh;
    }

    const g = el("g", { transform: `translate(${x0} ${y})`, class: "mono" }, parent);
    g.style.opacity = "0";
    const a = txt(g, 0, 0, "", "mono");
    a.style.fontSize = "13px";

    if (r.kind === "cmd") {
      a.style.fill = "var(--text)";
    } else if (r.kind === "out") {
      a.style.fill = "var(--muted)";
    } else {
      a.style.fill = "var(--subtle)";
      const b = txt(g, 118, 0, r.log[1], "mono");
      b.style.fontSize = "13px";
      b.style.fill = STATUS_FILL[r.status];
    }

    y += lh;

    return { g, a, r };
  });

  const cursor = el("rect", { width: 7, height: 15, y: -12, fill: "var(--accent)" }, parent);
  cursor.style.opacity = "0";

  return (t: number) => {
    let curRow: (typeof rows)[number] | null = null;

    for (const row of rows) {
      const r = row.r;

      if (t < r.t0) {
        row.g.style.opacity = "0";
        continue;
      }

      row.g.style.opacity = "1";

      if (r.kind === "cmd") {
        const n = Math.floor(clamp((t - r.t0) / r.dur) * r.text.length);
        row.a.textContent = `$ ${r.text.slice(0, n)}`;

        if (t < r.t0 + r.dur + 0.3) {
          curRow = row;
        }
      } else if (r.kind === "out") {
        row.a.textContent = r.text;
      } else {
        row.a.textContent = r.log[0];
      }
    }

    if (curRow) {
      cursor.style.opacity = "1";
      cursor.setAttribute("transform", curRow.g.getAttribute("transform") ?? "");
      cursor.setAttribute("x", String(curRow.a.getComputedTextLength() + 2));
    } else {
      cursor.style.opacity = "0";
    }
  };
}

// the layout. Wide: terminal panel on the left, canvas with a 3 by 2 snake on the right.
// Compact (phones): no terminal, the canvas alone with a 2 by 3 snake, so the cards stay legible.
function layout(svg: SVGSVGElement, compact: boolean) {
  const cw = 204;
  const ch = 56;
  let pos: Pt[];
  let LX: number;
  let term: ((t: number) => void) | null = null;

  if (compact) {
    svg.setAttribute("viewBox", "0 0 496 600");
    const xs = [24, 268];
    const ys = [116, 296, 476];
    pos = [
      [0, 0],
      [1, 0],
      [1, 1],
      [0, 1],
      [0, 2],
      [1, 2],
    ].map(([c, r]) => ({ x: xs[c ?? 0] ?? 0, y: ys[r ?? 0] ?? 0 }));
    LX = 48;
    el(
      "rect",
      { x: 0.5, y: 0.5, width: 495, height: 599, rx: 14, fill: "none", stroke: "var(--line)" },
      svg,
    );
  } else {
    svg.setAttribute("viewBox", "0 0 1200 600");
    const xs = [484, 722, 960];
    const ys = [150, 400];
    pos = [
      [0, 0],
      [1, 0],
      [2, 0],
      [2, 1],
      [1, 1],
      [0, 1],
    ].map(([c, r]) => ({ x: xs[c ?? 0] ?? 0, y: ys[r ?? 0] ?? 0 }));
    LX = 472;
    el(
      "rect",
      {
        x: 24,
        y: 24,
        width: 400,
        height: 552,
        rx: 14,
        fill: "var(--bg-raised)",
        stroke: "var(--line)",
      },
      svg,
    );
    el(
      "rect",
      { x: 448, y: 24, width: 728, height: 552, rx: 14, fill: "none", stroke: "var(--line)" },
      svg,
    );
  }

  const p3 = pos[3] ?? { x: 0, y: 0 };
  const p4 = pos[4] ?? { x: 0, y: 0 };

  const holds: Holds = {
    fail: rectOf(p3, cw, ch),
    failLabel: compact ? { x: p3.x, y: p3.y - 12 } : { x: p3.x, y: p3.y + ch + 20 },
    wait: rectOf(p4, cw, ch),
    okLabel: { x: p4.x, y: p4.y + ch + 20 },
  };

  const gLn = el("g", {}, svg);
  const gEd = el("g", {}, svg);
  const gCd = el("g", {}, svg);
  const gRun = el("g", {}, svg);

  const heads = ["Trace imp_7f2c", "Graph cve-patch", "Run #41"].map((s) => {
    const h = txt(svg, LX, 62, s, "tag");
    h.style.fontSize = "13px";
    h.style.fill = "var(--muted)";
    h.style.opacity = "0";

    return h;
  });

  const lines = traceLog(gLn, LX, 106, 24);
  const cards = NODES.map((n) => makeCard(gCd, n, cw, ch));
  const edges = snakeEdges(gEd, pos, cw, ch);
  const run = makeRun(gRun, cards, edges, holds);

  if (!compact) {
    term = terminal(el("g", {}, svg), 46, 66);
  }

  return function render(t: number) {
    if (term) {
      term(t);
    }

    const phase = t < 1.1 ? -1 : t < 4.4 ? 0 : t < T.RUN0 ? 1 : 2;
    heads.forEach((h, i) => {
      h.style.opacity = i === phase ? "1" : "0";
    });
    const u = t - T.RUN0;
    const { hold, focus } = holdOf(u);
    gEd.style.opacity = String(1 - 0.35 * hold);
    lines.forEach((l, i) => {
      const k = captureK(t, i);

      if (l.ev == null) {
        l.g.style.opacity = String(k * (1 - quietFade(t)));
        tf(l.g, l.x + (1 - k) * 6, l.y);
      } else {
        placeLine(l, k, entM(t, l.ev));
      }
    });
    cards.forEach((c, i) => {
      placeCard(i, t, pos[i] ?? { x: 0, y: 0 }, c, i === focus ? 1 : 1 - 0.4 * hold);
    });
    drawEdges(edges, t);
    run(u);
  };
}

export type StageHandles = {
  stage: HTMLElement;
  svg: SVGSVGElement;
  steps: HTMLElement[];
  rails: HTMLElement[];
};

/** Builds the stage into the svg and drives it, the step highlight and the rails on one clock. */
export function mountStage({ stage, svg, steps, rails }: StageHandles) {
  const reduce = reducedMotion();
  const compactMQ = matchMedia("(max-width: 900px)");
  let render: (t: number) => void = () => {};

  const build = () => {
    svg.replaceChildren();
    stage.classList.toggle("compact", compactMQ.matches);
    render = layout(svg, compactMQ.matches);
  };

  build();

  function frame(t: number) {
    render(t);
    svg.style.opacity = String(Math.min(1, t / 0.25, (T.CYCLE - t) / 0.4));
    const cur = t < T.phases[0] ? 0 : t < T.phases[1] ? 1 : 2;
    steps.forEach((s, i) => {
      s.classList.toggle("on", i === cur);
    });
    // each rail fills over the first 1.2s of its phase, stays lit, then all three fade with the stage at the end of the cycle
    const starts = [0, T.phases[0], T.phases[1]];
    const out = 1 - ss(T.CYCLE - 0.5, T.CYCLE, t);
    rails.forEach((r, i) => {
      const s0 = starts[i] ?? 0;
      r.style.setProperty("--k", (ss(s0, s0 + 1.2, t) * out).toFixed(3));
    });
  }

  let t = 0;
  let raf = 0;
  let last = 0;
  const FINAL = T.CYCLE - 0.5;

  const onChange = () => {
    build();
    frame(reduce ? FINAL : t);
  };

  compactMQ.addEventListener("change", onChange);
  let io: IntersectionObserver | null = null;

  const stop = () => {
    cancelAnimationFrame(raf);
    raf = 0;
  };

  if (reduce) {
    frame(FINAL);
  } else {
    // plays while at least a quarter of the stage is on screen, and loops for as long as it is
    const tick = (now: number) => {
      t += Math.min(0.1, (now - last) / 1000);

      if (t >= T.CYCLE) {
        t -= T.CYCLE;
      }

      last = now;
      frame(t);
      raf = requestAnimationFrame(tick);
    };

    const play = () => {
      if (raf) {
        return;
      }

      last = performance.now();
      raf = requestAnimationFrame(tick);
    };

    frame(0);
    io = new IntersectionObserver(([e]) => (e?.isIntersecting ? play() : stop()), {
      threshold: 0.25,
    });
    io.observe(stage);
  }

  return () => {
    stop();
    io?.disconnect();
    compactMQ.removeEventListener("change", onChange);
    svg.replaceChildren();
  };
}
