// The DOM half of the widget registry. Its keys must match widget-specs.js
// exactly — test/framework/panel/registry.test.js proves they do.
import { makeNumeric } from "./numeric.js";
import { makeText } from "./text.js";
import { makeCheckbox } from "./checkbox.js";
import { makeSelect, makeRadio } from "./select.js";
import { makeFont } from "./font.js";
import { makeImage } from "./image.js";
import { makeVector } from "./vector.js";
import { makeCustom } from "./custom.js";
// Side-effect imports: font-picker.js / image-picker.js call setFontPicker() /
// setImagePicker() at module scope, so each widget's button finds a picker to
// open. They live HERE and not in font.js/image.js because the dependency has
// to run picker → widget and never back — those files must stay importable
// (and testable) without dragging the whole DOM-heavy picker in. See the note
// at the bottom of font.js.
import "../font-picker.js";
import "../image-picker.js";

export const WIDGET_FACTORIES = {
  slider: makeNumeric,
  number: makeNumeric,
  text: makeText,
  textarea: makeText,
  checkbox: makeCheckbox,
  select: makeSelect,
  radio: makeRadio,
  font: makeFont,
  image: makeImage,
  vector: makeVector,
  custom: makeCustom,
};
