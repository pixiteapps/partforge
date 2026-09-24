# Asset sources

All source assets are CC0 (public domain dedication — no attribution required). Each
source page was checked for "CC0" at download time (2026-09-24). Baked outputs are
produced by `scripts/bake-environments.mjs`.

Environments and ground/pattern textures are keyed by the file names `assets.js`
resolves — see that module for the name -> URL map, and `environments.js` for which
file each render environment uses.

## Environments (HDRIs -> UltraHDR gainmap JPEGs)

| File | Source asset | Source URL | Fetched | Processing |
| --- | --- | --- | --- | --- |
| `env-studio.jpg` | Poly Haven HDRI "Studio Small 09" | https://polyhaven.com/a/studio_small_09 | 2026-09-24 | 2K `.hdr` -> `node scripts/bake-environments.mjs studio_small_09_2k.hdr env-studio.jpg` |
| `env-workshop.jpg` | Poly Haven HDRI "Industrial Workshop Foundry" | https://polyhaven.com/a/industrial_workshop_foundry | 2026-09-24 | 2K `.hdr` -> `node scripts/bake-environments.mjs industrial_workshop_foundry_2k.hdr env-workshop.jpg` |
| `env-print-bed.jpg` | Poly Haven HDRI "Brown Photostudio 02" | https://polyhaven.com/a/brown_photostudio_02 | 2026-09-24 | 2K `.hdr` -> `node scripts/bake-environments.mjs brown_photostudio_02_2k.hdr env-print-bed.jpg`. Chosen for its cool, softly blurred studio backdrop (the "printer enclosure" cue is the blur, not a literal printer), as the brief allows. |
| `env-outdoor.jpg` | Poly Haven HDRI "Kloofendal Overcast" | https://polyhaven.com/a/kloofendal_overcast | 2026-09-24 | 2K `.hdr` -> `node scripts/bake-environments.mjs kloofendal_overcast_2k.hdr env-outdoor.jpg` |

Poly Haven publishes every asset under CC0 (https://polyhaven.com/license, checked
2026-09-24). Licence text at fetch time also confirmed per-asset via
`https://api.polyhaven.com/info/<slug>` (categories/metadata only — the site-wide
license statement is what governs).

### Environment baking detail

`ultrahdr_app` (libultrahdr 2.0.2, `brew install libultrahdr`) only writes the newer
ISO 21496-1 binary-box gainmap metadata, not the legacy Adobe XMP ("hdrgm"-prefixed)
block. The baker therefore: (1) decodes the `.hdr` with three's own `HDRLoader` (pure
JS) into a raw RGBA half-float buffer, (2) hands that to `ultrahdr_app -m 0` to derive
the SDR rendition and gain map (`-a 4 -t 0`, sdr/gainmap quality 80, gainmap
downsampled 2x), (3) splits the two embedded JPEG streams `ultrahdr_app` produced back
apart, and (4) re-merges them with `@monogrid/gainmap-js`'s `encodeJPEGMetadata` (pure
JS — no WebGL, only JPEG marker writing) using the boost/offset/gamma values read back
off `ultrahdr_app`'s own probe of its ISO output, so both metadata conventions agree.
A re-probe of each committed file (`ultrahdr_app -m 1 -j <file> -P`) round-trips the
same boost numbers back out, confirming the legacy block is self-consistent. See
`scripts/bake-environments.mjs`'s header comment for the fuller account, including why
`@monogrid/gainmap-js`'s WebGL-based `encode()`/`findTextureMinMax()` path (the one the
task brief originally sketched) is impractical in plain Node — no WebGL context is
available, and this tree has no headless-GL shim.

Before the re-merge, the baker also strips `ultrahdr_app`'s own APP2 MPF and ISO
21496-1 metadata segments out of both the SDR and gain-map halves
(`stripAppSegments` in the baker). Without this, `encodeJPEGMetadata` prepends its
own freshly-computed MPF/XMP but leaves `ultrahdr_app`'s originals sitting later in
the same file; three's `UltraHDRLoader` walks every top-level JPEG section across the
whole concatenated file and keeps whichever MPF/ISO segment it sees LAST, so the
stale one silently won — its offsets were computed for the old, smaller file, so the
primary/gain-map slices it produced didn't even end on a real EOI marker. Verified
fixed by driving three's actual `UltraHDRLoader.parse()` (via a `happy-dom` DOMParser
polyfill, short-circuiting before the GPU decode step) against each committed file:
the sliced primary and gain-map buffers now start with SOI (`FF D8`) and end with EOI
(`FF D9`), and there is exactly one MPF segment and no leftover ISO box in the file.

## Ground and pattern textures

| File | Source asset | Source URL | Fetched | Processing |
| --- | --- | --- | --- | --- |
| `ground-paper.jpg` | ambientCG "Paper 001" (Color) | https://ambientcg.com/a/Paper001 | 2026-09-24 | 1K JPG -> `node scripts/bake-environments.mjs --texture Paper001_1K-JPG_Color.jpg ground-paper.jpg` |
| `pattern-oak-color.jpg` | Poly Haven "Oak Veneer 01" (colour; API key `Diffuse`) | https://polyhaven.com/a/oak_veneer_01 — file https://dl.polyhaven.org/file/ph-assets/Textures/jpg/1k/oak_veneer_01/oak_veneer_01_diff_1k.jpg | 2026-09-24 | 1K JPG, sRGB colour -> `node scripts/bake-environments.mjs --texture oak_veneer_01_diff_1k.jpg pattern-oak-color.jpg` (q82). Scanned tile 1830 mm (`api.polyhaven.com/info/oak_veneer_01` dimensions). |
| `pattern-oak-normal.jpg` | Poly Haven "Oak Veneer 01" (OpenGL normal map; API key `nor_gl`) | https://polyhaven.com/a/oak_veneer_01 — file https://dl.polyhaven.org/file/ph-assets/Textures/jpg/1k/oak_veneer_01/oak_veneer_01_nor_gl_1k.jpg | 2026-09-24 | 1K JPG, OpenGL (+Y up) tangent normals, kept as data -> `node scripts/bake-environments.mjs --texture oak_veneer_01_nor_gl_1k.jpg pattern-oak-normal.jpg --data --quality 95` (4:4:4 chroma, no grayscale/tint; q95 because the map is nearly flat and the viewer amplifies it, so q90's 8x8 blocks showed). |
| `pattern-oak-rough.jpg` | Poly Haven "Oak Veneer 01" (roughness; API key `Rough`) | https://polyhaven.com/a/oak_veneer_01 — file https://dl.polyhaven.org/file/ph-assets/Textures/jpg/1k/oak_veneer_01/oak_veneer_01_rough_1k.jpg | 2026-09-24 | 1K JPG, grayscale data -> `node scripts/bake-environments.mjs --texture oak_veneer_01_rough_1k.jpg pattern-oak-rough.jpg --gray` (source is neutral grey; channel means unchanged). |
| `pattern-walnut-color.jpg` | Poly Haven "Dark Wood" (colour; API key `Diffuse`) | https://polyhaven.com/a/dark_wood — file https://dl.polyhaven.org/file/ph-assets/Textures/jpg/1k/dark_wood/dark_wood_diff_1k.jpg | 2026-09-24 | 1K JPG, sRGB colour -> `node scripts/bake-environments.mjs --texture dark_wood_diff_1k.jpg pattern-walnut-color.jpg` (q82). Scanned tile 2000 mm (`api.polyhaven.com/info/dark_wood` dimensions). |
| `pattern-walnut-normal.jpg` | Poly Haven "Dark Wood" (OpenGL normal map; API key `nor_gl`) | https://polyhaven.com/a/dark_wood — file https://dl.polyhaven.org/file/ph-assets/Textures/jpg/1k/dark_wood/dark_wood_nor_gl_1k.jpg | 2026-09-24 | 1K JPG, OpenGL (+Y up) tangent normals, kept as data -> `node scripts/bake-environments.mjs --texture dark_wood_nor_gl_1k.jpg pattern-walnut-normal.jpg --data --quality 95` (4:4:4 chroma, no grayscale/tint; q95 because the map is nearly flat and the viewer amplifies it, so q90's 8x8 blocks showed). |
| `pattern-walnut-rough.jpg` | Poly Haven "Dark Wood" (roughness; API key `Rough`) | https://polyhaven.com/a/dark_wood — file https://dl.polyhaven.org/file/ph-assets/Textures/jpg/1k/dark_wood/dark_wood_rough_1k.jpg | 2026-09-24 | 1K JPG, grayscale data -> `node scripts/bake-environments.mjs --texture dark_wood_rough_1k.jpg pattern-walnut-rough.jpg --gray` (source is neutral grey; channel means unchanged). |
| `ground-maple-color.jpg` | Poly Haven "Oak Veneer 01" (colour; API key `Diffuse`) | https://polyhaven.com/a/oak_veneer_01 — file https://dl.polyhaven.org/file/ph-assets/Textures/jpg/1k/oak_veneer_01/oak_veneer_01_diff_1k.jpg | 2026-09-24 | Workshop floor, "unfinished maple": `node scripts/bake-environments.mjs --texture oak_veneer_01_diff_1k.jpg ground-maple-color.jpg --modulate 1.5,0.7 --quality 85` (lightened 1.5x, saturation 0.7). |
| `ground-maple-normal.jpg` | Poly Haven "Oak Veneer 01" (OpenGL normal map; API key `nor_gl`) | https://polyhaven.com/a/oak_veneer_01 — file https://dl.polyhaven.org/file/ph-assets/Textures/jpg/1k/oak_veneer_01/oak_veneer_01_nor_gl_1k.jpg | 2026-09-24 | Workshop floor relief: `node scripts/bake-environments.mjs --texture oak_veneer_01_nor_gl_1k.jpg ground-maple-normal.jpg --data --quality 92`. A separate file from `pattern-oak-normal.jpg` so the floor and the oak material never share (and dispose) one texture. |
| `ground-pei.jpg` | None — procedural | n/a | n/a | Gold-brown fine-grain speckle, no external source. First attempt tinted ambientCG "Plastic 010"'s colour map (near-uniform, stdev < 1/channel — visibly flat, no grain, when actually viewed) gold-brown; that colour map carries no usable grain at all (its roughness map does, which is why `ground-pei-rough.jpg` below is still Plastic010's roughness). Checked ambientCG alternatives (Metal049A — also flat; Granite006A — real speckle but reads as rock, not powder-coat) and found nothing closer. Generated in-baker instead, same procedural precedent as `pattern-carbon.jpg`: per-pixel triangular-distributed noise around a `196,154,82` gold-brown base (asymmetric per channel so flecks warm rather than grey), then a 0.5px blur to turn single-pixel noise into soft grains -> `node scripts/bake-environments.mjs --speckle ground-pei.jpg --tint 196,154,82`. |
| `ground-pei-rough.jpg` | ambientCG "Plastic 010" (Roughness) | https://ambientcg.com/a/Plastic010 | 2026-09-24 | 1K JPG, grayscale -> `node scripts/bake-environments.mjs --texture Plastic010_1K-JPG_Roughness.jpg ground-pei-rough.jpg --gray` |
| `ground-concrete.jpg` | ambientCG "Concrete 034" (Color) | https://ambientcg.com/a/Concrete034 | 2026-09-24 | 1K JPG -> `node scripts/bake-environments.mjs --texture Concrete034_1K-JPG_Color.jpg ground-concrete.jpg` |
| `ground-concrete-rough.jpg` | ambientCG "Concrete 034" (Roughness) | https://ambientcg.com/a/Concrete034 | 2026-09-24 | 1K JPG, grayscale -> `node scripts/bake-environments.mjs --texture Concrete034_1K-JPG_Roughness.jpg ground-concrete-rough.jpg --gray` |
| `pattern-carbon.jpg` | None — procedural | n/a | n/a | ambientCG has no CC0 carbon-fiber weave (searched "carbon"; only unrelated fabric hits). Generated in-baker: a 256x256 2x2 twill tile (32 threads/tile, alternating dark/light grey diagonal bands) -> `node scripts/bake-environments.mjs --carbon pattern-carbon.jpg`. No external source/licence to record. |

ambientCG publishes every asset under CC0 (https://ambientcg.com/, "CC0 Public Domain
license", checked 2026-09-24). The wood sets (`pattern-oak-*`, `pattern-walnut-*`,
`ground-maple-*`) are Poly Haven textures, CC0 like its HDRIs above
(https://polyhaven.com/license, checked 2026-09-24); the exact 1K JPG URLs came
from `https://api.polyhaven.com/files/<slug>` (keys `Diffuse`, `nor_gl`, `Rough`).
The presets tile them smaller than the scanned size — see the comment on `oak` in
`presets.js` and on `workshop` in `environments.js`.

## Budgets

Environments stay under 1.5 MB (largest: `env-workshop.jpg` at ~398 KB); ground/pattern
textures stay under 400 KB (largest: `pattern-oak-rough.jpg` at ~218 KB). All committed
outputs are well inside both ceilings — see `test/framework/materials-assets.test.js`.
