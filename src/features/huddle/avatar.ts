// Shared avatar helpers for huddle surfaces (feed + clock-page composer).
import type { AvatarColor } from './types';

export function getUserInitials(name: string): string {
  const parts = name.trim().split(/\s+/);
  if (parts.length >= 2) {
    return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
  }
  return name.substring(0, 2).toUpperCase();
}

export function getUserColor(userId: string): AvatarColor {
  const colors: AvatarColor[] = ['indigo', 'teal', 'coral', 'amber', 'pink', 'green'];
  const hash = userId.split('').reduce((acc, char) => acc + char.charCodeAt(0), 0);
  return colors[hash % colors.length];
}

/** Tailwind palette tokens (mid tone) matching the tint families in HuddleAvatar's
 *  `COLOR_CLASSES`, for surfaces (e.g. SuperChat participants) that take a CSS
 *  color value rather than a className. */
const AVATAR_COLOR_CSS: Record<AvatarColor, string> = {
  indigo: 'var(--color-indigo-500, #6366f1)',
  teal: 'var(--color-teal-500, #14b8a6)',
  coral: 'var(--color-red-500, #ef4444)',
  amber: 'var(--color-amber-500, #f59e0b)',
  pink: 'var(--color-pink-500, #ec4899)',
  green: 'var(--color-green-500, #22c55e)',
};

export function avatarColorToCss(color: AvatarColor): string {
  return AVATAR_COLOR_CSS[color];
}
