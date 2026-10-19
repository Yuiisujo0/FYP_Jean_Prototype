import { useCallback, useState } from 'react';
import { KEYS, readJSON, writeJSON } from '../lib/storage';
import type { AvatarColor, Profile } from '../types';

export const AVATAR_COLORS: AvatarColor[] = ['teal', 'blue', 'violet', 'amber', 'rose', 'slate'];

export const DEFAULT_PROFILE: Profile = { name: 'Jean', role: 'Final-year project', email: '', color: 'teal' };

export function normaliseProfile(raw: Partial<Profile> | null | undefined): Profile {
  const color = AVATAR_COLORS.includes(raw?.color as AvatarColor) ? (raw!.color as AvatarColor) : DEFAULT_PROFILE.color;
  return {
    name: typeof raw?.name === 'string' ? raw.name : DEFAULT_PROFILE.name,
    role: typeof raw?.role === 'string' ? raw.role : DEFAULT_PROFILE.role,
    email: typeof raw?.email === 'string' ? raw.email : '',
    color,
  };
}

/** The profile lives only in this browser; there is no account or server. */
export function useProfile() {
  const [profile, setProfileState] = useState<Profile>(() => normaliseProfile(readJSON<Partial<Profile>>(KEYS.profile, {})));

  const updateProfile = useCallback((patch: Partial<Profile>) => {
    setProfileState(prev => {
      const next = normaliseProfile({ ...prev, ...patch });
      writeJSON(KEYS.profile, next);
      return next;
    });
  }, []);

  return { profile, updateProfile };
}
