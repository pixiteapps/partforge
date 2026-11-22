// Pure serializer. No three.js, no DOM. Three styles for the same Selection:
//   token  — compact clipboard/CLI line
//   json   — the structured object (embedded tool-call transport)
//   prompt — one natural-language sentence an LLM ingests well
const AXIS_LABEL = { "1,0,0": "+X", "-1,0,0": "-X", "0,1,0": "+Y", "0,-1,0": "-Y", "0,0,1": "+Z", "0,0,-1": "-Z" };

const fmtNormal = (n) => AXIS_LABEL[n.join(",")] ?? n.join(",");
const fmtParams = (p) => Object.entries(p).map(([k, v]) => `${k}:${v}`).join(",");

// A pick on a reference comparison's Missing or Extra piece (the viewer's
// setCompare); a Matches pick reads as an ordinary pick of the part.
const COMPARE_TOKEN = { missing: "missing", excess: "extra" };

function tokenStyle(s) {
  const head = `@${s.subPart}`;
  const feat = s.feature ? ` · ${s.feature.label}` : "";
  const piece = COMPARE_TOKEN[s.compare] ? ` · ${COMPARE_TOKEN[s.compare]}` : "";
  const cut = s.onCutPlane ? " · section" : "";
  return `${head}${feat}${piece}${cut} · pt(${s.point.join(",")}) n(${fmtNormal(s.normal)}) · {${fmtParams(s.params)}}`;
}

function comparePhrase(s) {
  const label = s.subPartLabel ?? s.subPart;
  const what = s.compare === "missing" ? `material missing from **${label}**` : `extra material on **${label}**`;
  const cut = s.onCutPlane ? " on the cutaway section face" : "";
  return `${what}, near [${s.point.join(", ")}]${cut}`;
}

function promptStyle(s) {
  const params = Object.entries(s.params).map(([k, v]) => `${k}: ${v}`).join(", ");
  if (COMPARE_TOKEN[s.compare]) {
    return `On sub-part **${s.subPart}**, the user pointed at ${comparePhrase(s)}, `
      + `normal ${fmtNormal(s.normal)}, with params {${params}}.`;
  }
  const feat = s.feature ? ` **${s.feature.label}**,` : "";
  // The section wording is load-bearing: without it the point reads as a spot
  // on the part's surface, when it is a spot inside the material that the
  // cutaway happens to have opened up.
  const cut = s.onCutPlane ? " the cutaway section face at" : "";
  return `On sub-part **${s.subPart}**, the user pointed at${feat}${cut} local point (${s.point.join(", ")}), `
    + `normal ${fmtNormal(s.normal)}, with params {${params}}.`;
}

export function formatSelection(selection, { style = "token" } = {}) {
  if (style === "json") return selection;
  if (style === "prompt") return promptStyle(selection);
  return tokenStyle(selection);
}
