/**
 * accountMenu — the Admin / Developers / Help groups of the account menu.
 *
 * Single source for these items, their access rules and TESTFLIGHT_URL.
 * UserDropdown renders them as dropdown sections; BottomNav renders them as
 * the More sheet's drill-down tiles. Keeping both on one definition is what
 * stops the avatar menu and the mobile sheet drifting apart again.
 */
import {
  BuildingIcon,
  ChartIcon,
  ExternalLinkIcon,
  FlagIcon,
  HelpCircleIcon,
  MessageIcon,
  ShieldCheckIcon,
  UsersIcon,
  WrenchIcon,
  type LucideIcon,
} from '@mieweb/ui';
import { useMemo } from 'react';

import type { TimecoreUser } from '../lib/api';
import {
  hasDefaultOrganizationAdminAccess,
  hasOrganizationAdminAccess,
  type OrganizationRole,
} from '../lib/organizationAccess';
import { useTeam } from '../lib/TeamContext';
import { useSession } from '../lib/useSession';
import { useAppFeedback } from './AppLayout';
import { useRouter } from './router';

// Update this URL once the TestFlight build is published in App Store Connect.
export const TESTFLIGHT_URL = 'https://testflight.apple.com/join/45w2knYf';

export type AccountMenuSectionId = 'admin' | 'developers' | 'help';

export interface AccountMenuItem {
  icon: LucideIcon;
  label: string;
  onSelect: () => void;
}

export interface AccountMenuSection {
  id: AccountMenuSectionId;
  label: string;
  icon: LucideIcon;
  items: AccountMenuItem[];
}

export interface AccountMenuAccess {
  user: TimecoreUser | null;
  enterpriseCount: number;
  organizations: ReadonlyArray<{ role: OrganizationRole | 'member' | null }>;
  isProduction: boolean;
}

export interface AccountMenuActions {
  navigate: (href: string) => void;
  openReportIssue: () => void;
  openFeedback: () => void;
  openTestFlight: () => void;
}

/** The sections this user may see, in display order. Empty sections are omitted. */
export function buildAccountMenuSections(
  { user, enterpriseCount, organizations, isProduction }: AccountMenuAccess,
  { navigate, openReportIssue, openFeedback, openTestFlight }: AccountMenuActions,
): AccountMenuSection[] {
  const isOrganizationAdmin = hasOrganizationAdminAccess(organizations);
  const showAdmin =
    hasDefaultOrganizationAdminAccess(user) || isOrganizationAdmin || enterpriseCount > 0;

  const sections: AccountMenuSection[] = [];

  if (showAdmin) {
    sections.push({
      id: 'admin',
      label: 'Admin',
      icon: ShieldCheckIcon,
      items: [
        ...(enterpriseCount > 0
          ? [
              {
                icon: BuildingIcon,
                label: 'Enterprise',
                onSelect: () => navigate('/app/enterprise'),
              },
            ]
          : []),
        { icon: UsersIcon, label: 'Members', onSelect: () => navigate('/app/org/members') },
        ...(isOrganizationAdmin
          ? [{ icon: ChartIcon, label: 'Usage', onSelect: () => navigate('/app/org/usage') }]
          : []),
      ],
    });
  }

  if (!isProduction) {
    sections.push({
      id: 'developers',
      label: 'Developers',
      icon: WrenchIcon,
      items: [{ icon: WrenchIcon, label: 'Seeder', onSelect: () => navigate('/app/seeder') }],
    });
  }

  sections.push({
    id: 'help',
    label: 'Help',
    icon: HelpCircleIcon,
    items: [
      { icon: FlagIcon, label: 'Report an Issue', onSelect: openReportIssue },
      { icon: MessageIcon, label: 'Share Your Feedback', onSelect: openFeedback },
      { icon: ExternalLinkIcon, label: 'TestFlight', onSelect: openTestFlight },
    ],
  });

  return sections;
}

const openTestFlight = () => window.open(TESTFLIGHT_URL, '_blank', 'noopener,noreferrer');

/** Account-menu sections for the signed-in user, wired to the app's router and feedback modals. */
export function useAccountMenuSections(): AccountMenuSection[] {
  const { user } = useSession();
  const { enterprises, organizations } = useTeam();
  const { navigate } = useRouter();
  const { openFeedback, openReportIssue } = useAppFeedback();

  return useMemo(
    () =>
      buildAccountMenuSections(
        {
          user,
          enterpriseCount: enterprises.length,
          organizations,
          isProduction: import.meta.env.MODE === 'production',
        },
        { navigate, openReportIssue, openFeedback, openTestFlight },
      ),
    [user, enterprises.length, organizations, navigate, openReportIssue, openFeedback],
  );
}
