// All placeholder branding lives here. Swap these values once the group
// confirms its real name, colours, logo and contacts.
export const brand = {
  name: 'Community Ledger',
  shortMark: 'CL',
  groupName: 'Placeholder community group',
  contactLabel: 'Group treasurer (placeholder)',
  contactHint: 'Contact details will be added once the group confirms them.',
  colors: {
    cobalt: '#0052FF',
    deepBlue: '#102AA8',
    coral: '#FF795A',
    apricot: '#FFD3B7',
    canvas: '#FFF9F5',
    ink: '#101B46',
    muted: '#4A5874',
    surface: '#FFFFFF',
  },
  demoNotice: 'Demo · Fictional records · No real payments',
} as const;

export type Brand = typeof brand;
