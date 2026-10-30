// The LUXIA-IT logo, as published on luxia-it.com: two bars, the dark one in the brand blue (white on a dark
// background), the light one in light blue. Same geometry and colours as the site; do not redraw it.
const DARK_ON_LIGHT = "#1f5fbf";
const DARK_ON_DARK = "#ffffff";
const LIGHT = "#8db3e8";

export function LuxiaMark({ onDark = false, size = 32 }: { onDark?: boolean; size?: number }) {
  return (
    <svg viewBox="6.5 1 39 35" width={(size * 36) / 32} height={size} aria-hidden="true" focusable="false" className="lx-mark">
      <polygon points="23.6,8.4 32.2,8.4 44,34.6 34.6,34.6" fill={LIGHT} />
      <polygon points="22,2 32.2,2 18.2,34.6 8,34.6" fill={onDark ? DARK_ON_DARK : DARK_ON_LIGHT} />
    </svg>
  );
}

/** Mark, name and tagline, as in the site's header. `product` adds the product name under the lockup. */
export function LuxiaLogo({ onDark = false, product }: { onDark?: boolean; product?: string }) {
  return (
    <span className={`lx-logo${onDark ? " lx-logo--on-dark" : ""}`}>
      <LuxiaMark onDark={onDark} />
      <span className="lx-logo__text">
        <span className="lx-logo__name">LUXIA-IT</span>
        <span className="lx-logo__tagline">{product ?? "Identité & confiance"}</span>
      </span>
    </span>
  );
}
