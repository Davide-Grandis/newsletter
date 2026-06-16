// Authentication is performed by Cloudflare Access at the edge. This module
// only provides a thin hook that exposes the Access identity returned by
// `/api/me` (and a logout helper that ends the Access session).

import { useQuery } from '@tanstack/react-query';

export type Role = 'super_admin' | 'admin';
export type Capability = 'read_only' | 'edit';

export interface Identity {
  email: string | null;
  name: string | null;
  // Stored UI theme preference, or null when the admin has no saved row yet.
  theme: 'light' | 'dark' | null;
  // Authorization context (see the admin worker). `role` is null when the user
  // authenticated through Access but has not been provisioned in the console.
  role: Role | null;
  // Newsletters an admin is assigned to (empty for super_admins, who see all).
  // `capability` is the admin's read-only/edit access to that newsletter
  // (per-admin, so the value is the same across all their newsletters).
  newsletters: Array<{ id: string; name: string; capability: Capability }>;
  // True when Access let the user in but no console role exists for them.
  no_access: boolean;
  // Global permission toggle (mirrored from settings). Managing admins is no
  // longer global — it is governed per-admin by the read-only/edit capability.
  allow_admin_newsletter_crud: boolean;
  // Non-sensitive deployment values used by newsletter forms.
  base_domain: string;
  from_address: string;
  // Resolved global default footer (sanitized HTML + plain text). Used by the
  // newsletter footer editor to preview what an empty (inherited) footer sends.
  default_footer_html: string;
  default_footer_text: string;
  // Public base URL of the tracker worker (hosts the public subscribe page).
  tracking_base_url: string;
  protected_by_access: boolean;
  // Whether the Cloudflare Access login settings (account + list IDs) are set.
  access_configured: boolean;
}

export function useIdentity() {
  return useQuery({
    queryKey: ['me'],
    queryFn: () => fetch('/api/me').then((r) => r.json() as Promise<Identity>),
    staleTime: 5 * 60_000,
  });
}

// Whether the signed-in user may modify the given newsletter's content/admins.
// Super admins always can; regular admins need the 'edit' capability on it.
// Read-only admins (and unassigned users) get view-only access.
export function canEditNewsletter(me: Identity | undefined, newsletterId: string): boolean {
  if (!me) return false;
  if (me.role === 'super_admin') return true;
  return me.newsletters.find((n) => n.id === newsletterId)?.capability === 'edit';
}

export function logoutAccess() {
  // Ends the Cloudflare Access session and redirects back to the app login.
  window.location.href = '/cdn-cgi/access/logout';
}
