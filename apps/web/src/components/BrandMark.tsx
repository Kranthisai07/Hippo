// The one Hippo mark: an arch with two eyes on the accent tile. Decorative; the name beside it is the label.
export function BrandMark() {
  return (
    <span className="brand-mark" aria-hidden="true">
      <svg width="20" height="20" viewBox="0 0 32 32" fill="none">
        <path d="M7 22c0-6 4-10 9-10s9 4 9 10" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
        <circle cx="12" cy="18" r="1.8" fill="currentColor" />
        <circle cx="20" cy="18" r="1.8" fill="currentColor" />
      </svg>
    </span>
  );
}
