const VIEWPORT_MARGIN = 8;
const ANCHOR_GAP = 8;

function throwCollected(errors, message) {
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) throw new AggregateError(errors, message);
}

export function createTooltipPresenter({ id = "pf-hover-tip" } = {}) {
  const element = document.createElement("div");
  if (id != null && id !== "") element.id = id;
  element.className = "pf-hover-tip";

  const title = document.createElement("b");
  const subtitle = document.createElement("span");
  subtitle.className = "pf-hover-sub";
  // A call-to-action line under the name ("Click to edit"); empty = hidden.
  const hint = document.createElement("div");
  hint.className = "pf-hover-hint";
  element.append(title, subtitle, hint);
  document.body.appendChild(element);
  let disposed = false;
  const claims = [];

  function setContent(content) {
    title.textContent = content.title;
    subtitle.textContent = content.subtitle ?? "";
    hint.textContent = content.hint ?? "";
  }

  function measureVisible(content, anchored) {
    setContent(content);
    element.style.left = `${VIEWPORT_MARGIN}px`;
    element.style.top = `${VIEWPORT_MARGIN}px`;
    element.classList.toggle("pf-tooltip-anchored", anchored);
    element.classList.add("show");
    const rect = element.getBoundingClientRect();
    return {
      width: Math.max(0, rect.width || 0),
      height: Math.max(0, rect.height || 0),
    };
  }

  function renderClaim(claim) {
    const viewportWidth = Math.max(0, globalThis.innerWidth || 0);
    const viewportHeight = Math.max(0, globalThis.innerHeight || 0);
    const { width, height } = measureVisible(claim.content, claim.kind === "anchor");
    const maxLeft = Math.max(
      VIEWPORT_MARGIN,
      viewportWidth - VIEWPORT_MARGIN - width,
    );

    if (claim.kind === "pointer") {
      const maxTop = Math.max(
        VIEWPORT_MARGIN,
        viewportHeight - VIEWPORT_MARGIN - height,
      );
      element.style.left = `${Math.min(Math.max(claim.x + 14, VIEWPORT_MARGIN), maxLeft)}px`;
      element.style.top = `${Math.min(Math.max(claim.y + 14, VIEWPORT_MARGIN), maxTop)}px`;
      return;
    }

    const rect = claim.anchor.getBoundingClientRect();
    const centeredLeft = (rect.left + rect.right - width) / 2;
    element.style.left = `${Math.min(Math.max(centeredLeft, VIEWPORT_MARGIN), maxLeft)}px`;
    const belowTop = rect.bottom + ANCHOR_GAP;
    const fitsBelow = belowTop + height <= viewportHeight - VIEWPORT_MARGIN;
    const top = fitsBelow
      ? Math.max(VIEWPORT_MARGIN, belowTop)
      : Math.max(VIEWPORT_MARGIN, rect.top - ANCHOR_GAP - height);
    element.style.top = `${top}px`;
  }

  function addClaim(claim) {
    const token = Symbol("tooltip presentation");
    claims.push({ ...claim, token });
    renderClaim(claims.at(-1));
    return token;
  }

  return {
    showPointer(content, x, y) {
      if (disposed) return;
      return addClaim({ kind: "pointer", content, x, y });
    },
    showAnchor(content, anchor) {
      if (disposed) return;
      return addClaim({ kind: "anchor", content, anchor });
    },
    hide(token) {
      if (disposed) return;
      const index = token === undefined
        ? claims.length - 1
        : claims.findIndex((claim) => claim.token === token);
      if (index < 0) return;
      const wasActive = index === claims.length - 1;
      claims.splice(index, 1);
      if (!wasActive) return;
      const next = claims.at(-1);
      if (next) renderClaim(next);
      else element.classList.remove("show");
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      claims.length = 0;
      element.remove();
    },
  };
}

export function attachButtonTooltips(tooltip, entries) {
  const attached = [];

  for (const entry of entries ?? []) {
    const element = entry?.element;
    if (!element) continue;

    const originalTitle = {
      present: element.hasAttribute("title"),
      value: element.getAttribute("title"),
    };
    const originalAriaLabel = {
      present: element.hasAttribute("aria-label"),
      value: element.getAttribute("aria-label"),
    };
    if (!originalAriaLabel.present && originalTitle.present) {
      element.setAttribute("aria-label", originalTitle.value);
    }
    element.removeAttribute("title");

    let hovered = false;
    let focused = false;
    let touchActivation = false;
    let dismissed = false;
    let presentationToken;
    let hasPresented = false;
    const isUnavailable = () => (
      element.disabled
      || element.getAttribute("aria-disabled")?.toLowerCase() === "true"
    );
    const showIfNeeded = () => {
      if (hasPresented || dismissed || touchActivation || isUnavailable() || (!hovered && !focused)) return;
      const label = entry.getLabel?.()
        ?? element.getAttribute("aria-label")
        ?? originalTitle.value
        ?? "";
      presentationToken = tooltip.showAnchor({ title: label }, element);
      hasPresented = true;
    };
    const onPointerEnter = (event) => {
      if (event.pointerType === "touch") return;
      hovered = true;
      dismissed = false;
      showIfNeeded();
    };
    const hidePresentation = () => {
      if (!hasPresented) return;
      const token = presentationToken;
      hasPresented = false;
      presentationToken = undefined;
      tooltip.hide(token);
    };
    const syncVisibility = () => {
      if (dismissed || isUnavailable() || (!hovered && !focused)) hidePresentation();
      else showIfNeeded();
    };
    const onPointerLeave = (event) => {
      if (event.pointerType === "touch") return;
      hovered = false;
      syncVisibility();
    };
    const onPointerDown = (event) => {
      if (event.pointerType !== "touch") return;
      touchActivation = true;
      dismissed = true;
      hidePresentation();
    };
    const onPointerCancel = (event) => {
      if (event.pointerType !== "touch") return;
      touchActivation = false;
      dismissed = true;
      hidePresentation();
    };
    const onFocus = () => {
      focused = true;
      if (touchActivation) return;
      dismissed = false;
      showIfNeeded();
    };
    const onBlur = () => {
      focused = false;
      touchActivation = false;
      syncVisibility();
    };
    const dismiss = () => {
      dismissed = true;
      touchActivation = false;
      hidePresentation();
    };
    element.addEventListener("pointerenter", onPointerEnter);
    element.addEventListener("pointerleave", onPointerLeave);
    element.addEventListener("pointerdown", onPointerDown);
    element.addEventListener("pointercancel", onPointerCancel);
    element.addEventListener("focus", onFocus);
    element.addEventListener("blur", onBlur);
    element.addEventListener("click", dismiss);
    attached.push({
      element,
      originalTitle,
      originalAriaLabel,
      onPointerEnter,
      onPointerLeave,
      onPointerDown,
      onPointerCancel,
      onFocus,
      onBlur,
      dismiss,
      syncVisibility,
    });
  }

  let detached = false;
  const runAll = (operation) => {
    const errors = [];
    for (const binding of attached) {
      try { operation(binding); } catch (error) { errors.push(error); }
    }
    return errors;
  };
  const hide = () => {
    if (detached) return;
    throwCollected(
      runAll((binding) => binding.dismiss()),
      "button tooltip hide failed",
    );
  };
  return {
    hide,
    sync() {
      if (detached) return;
      throwCollected(
        runAll((binding) => binding.syncVisibility()),
        "button tooltip sync failed",
      );
    },
    detach() {
      if (detached) return;
      detached = true;
      const errors = runAll((binding) => binding.dismiss());
      for (const binding of attached) {
        const {
          element,
          originalTitle,
          originalAriaLabel,
          onPointerEnter,
          onPointerLeave,
          onPointerDown,
          onPointerCancel,
          onFocus,
          onBlur,
          dismiss,
        } = binding;
        try {
          element.removeEventListener("pointerenter", onPointerEnter);
          element.removeEventListener("pointerleave", onPointerLeave);
          element.removeEventListener("pointerdown", onPointerDown);
          element.removeEventListener("pointercancel", onPointerCancel);
          element.removeEventListener("focus", onFocus);
          element.removeEventListener("blur", onBlur);
          element.removeEventListener("click", dismiss);
          if (originalTitle.present) element.setAttribute("title", originalTitle.value);
          else element.removeAttribute("title");
          if (originalAriaLabel.present) {
            element.setAttribute("aria-label", originalAriaLabel.value);
          } else {
            element.removeAttribute("aria-label");
          }
        } catch (error) {
          errors.push(error);
        }
      }
      throwCollected(errors, "button tooltip detach failed");
    },
  };
}
