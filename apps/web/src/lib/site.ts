/**
 * Static product metadata.
 *
 * Kept out of components so copy and structure can be reviewed independently of
 * markup, and reused by metadata, structured data and tests.
 */
export const site = {
  name: 'Space',
  tagline: 'Your day, resolved.',
  description:
    'Space is a personal planning platform. Tasks, deadlines, calendar events and reminders live in one canonical timeline, continuously resolved by a deterministic scheduling engine.',
  /** Copyright year. Static: the landing page is prerendered, so a live clock would be misleading. */
  copyrightYear: 2026,
} as const;

export interface NavItem {
  readonly label: string;
  readonly href: string;
}

export const navigation: readonly NavItem[] = [
  { label: 'Overview', href: '#overview' },
  { label: 'Engine', href: '#engine' },
  { label: 'Roadmap', href: '#roadmap' },
] as const;
