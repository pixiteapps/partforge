// readout: a read-only display of one derive() output, named by `derivedKey`.
// A display node, not a control — it has no key, never writes params, and gets
// its value pushed via panel.refresh({ derived }), not pulled from params.
import { attachInfo } from "../info.js";
import { convertsUnit, formatLength } from "../../units.js";

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

// Same float-noise trim the numeric widgets use (4 dp max).
const numStr = (v) => String(Math.round(v * 1e4) / 1e4);

export function makeReadout(node, { info, units }) {
  const wrap = el("div", "slider readout");
  const row = el("div", "row");
  const label = el("label", "", node.label);
  attachInfo(label, node.description, info);
  const val = el("div", "val", "—");
  row.append(label, val);
  wrap.append(row);
  // Display units: a "mm" readout shows inches while the shared units state says
  // so; any other unit, or no units state, renders exactly as before.
  const inches = () => !!units && convertsUnit(node.unit) && units.get() === "in";
  let last;
  const render = () => {
    const v = last?.[node.derivedKey];
    val.textContent = v == null ? "—"
      : typeof v !== "number" ? String(v)
      : inches() ? `${formatLength(v, "in")} in`
      : numStr(v) + (node.unit ? ` ${node.unit}` : "");
  };
  const update = (derived) => { last = derived; render(); };
  // sync(): re-render the last value in the current unit (a units switch).
  return { el: wrap, update, sync: render };
}
