/** Three linked nodes: the shape of a workflow. */
export function LogoMark({ size = 32 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden>
      <rect width="32" height="32" rx="9" fill="var(--logo-bg, #0e7c72)" />
      <path d="M9.5 11.5h6.5a3 3 0 0 1 3 3v3a3 3 0 0 0 3 3h1" fill="none" stroke="#fff" strokeWidth="2" strokeLinecap="round" opacity=".55" />
      <circle cx="9.5" cy="11.5" r="3" fill="#fff" />
      <circle cx="22.5" cy="20.5" r="3" fill="#fff" />
      <circle cx="16" cy="11.5" r="1.6" fill="#fff" opacity=".7" />
    </svg>
  );
}
