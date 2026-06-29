---
bump: minor
---
add `css-purity-gate` (ck-css-purity-gate): "no inline values, always tokens" — a static, declaration-aware scanner that fails closed on raw dimensions (320px / 28px / 999px …) in layout properties, forcing every spacing/sizing/layout value through a coherent `var(--bs-*)` token scale. The shift-left counterpart to a runtime layout gate: it prevents the overflow/overlap class at the source rather than catching it at render. Generalises the colour-purity check to dimensions (opt-in `$PURITY_COLORS` still covers literal colours + token-membership).
