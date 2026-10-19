import type { AvatarColor } from '../types';

const GRADIENTS: Record<AvatarColor, string> = {
  teal: 'linear-gradient(135deg, #1f8f84, #17586f)',
  blue: 'linear-gradient(135deg, #3b74e0, #2a3f9c)',
  violet: 'linear-gradient(135deg, #8b5cf0, #5a35b5)',
  amber: 'linear-gradient(135deg, #e69a2e, #b5561a)',
  rose: 'linear-gradient(135deg, #e5557a, #a12a55)',
  slate: 'linear-gradient(135deg, #64748b, #334155)',
};

export const initialsOf = (name: string) => {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '?';
  return (parts.length === 1 ? parts[0].slice(0, 2) : parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
};

export const gradientOf = (color: AvatarColor) => GRADIENTS[color];

export function Avatar({ name, color, size = 32 }: { name: string; color: AvatarColor; size?: number }) {
  return (
    <span
      className="avatar"
      aria-hidden
      style={{ width: size, height: size, background: GRADIENTS[color], fontSize: Math.max(11, Math.round(size * 0.38)) }}
    >
      {initialsOf(name)}
    </span>
  );
}
