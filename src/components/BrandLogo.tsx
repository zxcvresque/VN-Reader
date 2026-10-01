/** The original VN quill mark; monochrome keeps small navigation marks legible. */
export default function BrandLogo({ monochrome = false, width = 42 }: { monochrome?: boolean; width?: number }) {
  const teal = monochrome ? "currentColor" : "#307a73";
  return <svg className="brand-logo" xmlns="http://www.w3.org/2000/svg" width={width} height={width * 2 / 3} viewBox="0 0 180 120" fill="none" aria-hidden="true" focusable="false" style={{ display: "block", flexShrink: 0 }}>
    <path d="M10 41h13l16 48 16-48h13L44 105H33L10 41Zm65 0h12v9c5-7 12-11 21-11 16 0 24 10 24 27v39h-12V67c0-11-5-17-14-17-10 0-18 8-18 20v35H75V41Z" fill="currentColor" />
    <path d="M146 103c-1-24 4-47 14-68" stroke={teal} strokeWidth="5" strokeLinecap="round" />
    <g transform="rotate(18 160 30)">
      <ellipse cx="160" cy="30" rx="13" ry="22" fill={teal} />
      <ellipse cx="160" cy="28" rx="7" ry="11" fill={monochrome ? "currentColor" : "#b99048"} opacity={monochrome ? .55 : 1} />
      <ellipse cx="160" cy="27" rx="4" ry="7" fill={monochrome ? "var(--accent)" : "#373e72"} />
    </g>
  </svg>;
}
