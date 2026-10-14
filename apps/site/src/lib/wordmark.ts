import { reducedMotion } from "./motion";

// Fit the wordmark to the page width, then cut the bottom of its ink off with the page edge.
export function mountWordmark(wm: HTMLElement, clip: HTMLElement, visible = 0.78) {
  if (reducedMotion()) {
    wm.querySelector(".bead")?.remove();
  }

  const canvas = document.createElement("canvas").getContext("2d");

  if (!canvas) {
    return () => {};
  }

  function fit() {
    if (!canvas) {
      return;
    }

    wm.style.fontSize = "";
    wm.style.marginTop = "";
    clip.style.height = "";
    const cs = getComputedStyle(clip);
    const avail = clip.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
    const base = parseFloat(getComputedStyle(wm).fontSize);
    const fs = (base * avail) / wm.scrollWidth;
    wm.style.fontSize = `${fs.toFixed(2)}px`;
    canvas.font = `600 ${fs}px ${getComputedStyle(wm).fontFamily}`;
    const m = canvas.measureText("lp'd");
    const fbA = m.fontBoundingBoxAscent ?? fs * 0.95;
    const fbD = m.fontBoundingBoxDescent ?? fs * 0.25;
    const baseline = (wm.offsetHeight - (fbA + fbD)) / 2 + fbA;
    const inkTop = baseline - m.actualBoundingBoxAscent;
    const inkBottom = baseline + m.actualBoundingBoxDescent;
    wm.style.marginTop = `${(-inkTop).toFixed(2)}px`;
    clip.style.height = `${((inkBottom - inkTop) * visible).toFixed(2)}px`;
  }

  let timer = 0;

  const onResize = () => {
    clearTimeout(timer);
    timer = window.setTimeout(fit, 120);
  };

  addEventListener("resize", onResize);
  fit();
  let alive = true;
  document.fonts?.ready.then(() => alive && fit());

  return () => {
    alive = false;
    clearTimeout(timer);
    removeEventListener("resize", onResize);
  };
}
