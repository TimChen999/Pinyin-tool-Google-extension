/**
 * Full-page area selection UI for OCR capture.
 *
 * When activated, displays a semi-transparent dark mask over the entire
 * viewport with a crosshair cursor. The user drags a rectangle over the
 * region of interest. On mouseup the rectangle coordinates are returned;
 * on Escape or too-small drag, null is returned.
 *
 * All DOM elements are appended directly to document.body (not the
 * Shadow DOM overlay host) because the selection mask must capture mouse
 * events across the entire viewport, including over the Shadow DOM host.
 *
 * See: OCR_SPEC.md Section 4 "Area Selection UI".
 */

const MIN_SELECTION_SIZE = 10;

export function startOCRSelection(): Promise<{
  x: number;
  y: number;
  width: number;
  height: number;
} | null> {
  return new Promise((resolve) => {
    let startX = 0;
    let startY = 0;
    let isDragging = false;
    let instructionDismissed = false;

    const mask = document.createElement("div");
    mask.className = "hg-ocr-mask";

    const instruction = document.createElement("div");
    instruction.className = "hg-ocr-instruction";
    instruction.textContent = "Drag to select area";

    const rect = document.createElement("div");
    rect.className = "hg-ocr-rect";
    rect.style.display = "none";

    document.body.appendChild(mask);
    document.body.appendChild(instruction);
    document.body.appendChild(rect);

    const instructionTimer = setTimeout(() => {
      if (!instructionDismissed) {
        instruction.remove();
        instructionDismissed = true;
      }
    }, 2000);

    function cleanup() {
      clearTimeout(instructionTimer);
      mask.remove();
      if (!instructionDismissed) instruction.remove();
      rect.remove();
      document.removeEventListener("mousedown", onMousedown, true);
      document.removeEventListener("mousemove", onMousemove, true);
      document.removeEventListener("mouseup", onMouseup, true);
      document.removeEventListener("keydown", onKeydown, true);
    }

    function onMousedown(e: MouseEvent) {
      e.preventDefault();
      e.stopPropagation();

      if (!instructionDismissed) {
        instruction.remove();
        instructionDismissed = true;
      }

      startX = e.clientX;
      startY = e.clientY;
      isDragging = true;

      rect.style.left = `${startX}px`;
      rect.style.top = `${startY}px`;
      rect.style.width = "0px";
      rect.style.height = "0px";
      rect.style.display = "block";
    }

    function onMousemove(e: MouseEvent) {
      if (!isDragging) return;
      e.preventDefault();
      e.stopPropagation();

      const x = Math.min(startX, e.clientX);
      const y = Math.min(startY, e.clientY);
      const w = Math.abs(e.clientX - startX);
      const h = Math.abs(e.clientY - startY);

      rect.style.left = `${x}px`;
      rect.style.top = `${y}px`;
      rect.style.width = `${w}px`;
      rect.style.height = `${h}px`;
    }

    function onMouseup(e: MouseEvent) {
      if (!isDragging) return;
      e.preventDefault();
      e.stopPropagation();
      isDragging = false;

      const x = Math.min(startX, e.clientX);
      const y = Math.min(startY, e.clientY);
      const w = Math.abs(e.clientX - startX);
      const h = Math.abs(e.clientY - startY);

      cleanup();

      if (w < MIN_SELECTION_SIZE || h < MIN_SELECTION_SIZE) {
        resolve(null);
        return;
      }

      resolve({ x, y, width: w, height: h });
    }

    function onKeydown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        isDragging = false;
        cleanup();
        resolve(null);
      }
    }

    document.addEventListener("mousedown", onMousedown, true);
    document.addEventListener("mousemove", onMousemove, true);
    document.addEventListener("mouseup", onMouseup, true);
    document.addEventListener("keydown", onKeydown, true);
  });
}
