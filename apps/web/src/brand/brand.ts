import markUrl from "./mark.svg";

/**
 * Everything that identifies the product, in one place. To change the logo, replace `mark.svg` in
 * this folder (and `public/favicon.svg` for the browser tab); every screen uses `BrandMark`, which
 * reads it from here. See docs/branding.md.
 */
export const BRAND = {
  name: "DASH AI",
  /** Wordmark parts: the second carries the gold accent. */
  wordmark: ["DASH", "AI"] as const,
  markUrl,
  /** True while the "D" placeholder is in use; set to false with the official asset. */
  temporaryMark: true,
} as const;
