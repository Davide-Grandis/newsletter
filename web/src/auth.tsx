// Authentication is performed by Cloudflare Access at the edge. This module
// only provides a thin hook that exposes the Access identity returned by
// `/api/me` (and a logout helper that ends the Access session).

import { useQuery } from '@tanstack/react-query';

export interface Identity {
  email: string | null;
  name: string | null;
  // Stored UI theme preference, or null when the admin has no saved row yet.
  theme: 'light' | 'dark' | null;
  protected_by_access: boolean;
}

export function useIdentity() {
  return useQuery({
    queryKey: ['me'],
    queryFn: () => fetch('/api/me').then((r) => r.json() as Promise<Identity>),
    staleTime: 5 * 60_000,
  });
}

export function logoutAccess() {
  // Ends the Cloudflare Access session and redirects back to the app login.
  window.location.href = '/cdn-cgi/access/logout';
}
