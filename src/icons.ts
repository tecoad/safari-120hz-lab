// Original icons (24×24 viewBox), drawn as strokes.
// `fill` = filled version; `cut` = details cut out of the filled version.

export interface Icon {
  stroke: readonly string[]
  fill?: readonly string[]
  cut?: readonly string[]
}

export const ICONS = {
  home: {
    stroke: ['M4 10.4 12 4l8 6.4V19a1.5 1.5 0 0 1-1.5 1.5H15v-5.2H9v5.2H5.5A1.5 1.5 0 0 1 4 19z'],
    fill: ['M3.4 10.6 12 3.4l8.6 7.2V19a2.1 2.1 0 0 1-2.1 2.1h-3.9v-5.4H9.4v5.4H5.5A2.1 2.1 0 0 1 3.4 19z'],
  },
  bubble: {
    stroke: ['M12 4.6c4.4 0 8 2.9 8 6.5s-3.6 6.5-8 6.5c-.9 0-1.8-.1-2.6-.3L5 19.4l1.2-3.5C4.8 14.7 4 13 4 11.1c0-3.6 3.6-6.5 8-6.5z'],
    fill: ['M12 3.9c4.8 0 8.7 3.2 8.7 7.2s-3.9 7.2-8.7 7.2c-.9 0-1.8-.1-2.6-.3l-4.9 2.2 1.3-3.9c-1.5-1.3-2.5-3.1-2.5-5.2 0-4 3.9-7.2 8.7-7.2z'],
  },
  inbox: {
    stroke: [
      'M4 13.5 6.3 6.2A1.7 1.7 0 0 1 7.9 5h8.2a1.7 1.7 0 0 1 1.6 1.2L20 13.5V18a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 18z',
      'M4 13.5h4.6l1.2 2.2h4.4l1.2-2.2H20',
    ],
    fill: ['M3.3 13.4 5.7 6a2.4 2.4 0 0 1 2.2-1.7h8.2A2.4 2.4 0 0 1 18.3 6l2.4 7.4V18a2.2 2.2 0 0 1-2.2 2.2h-13A2.2 2.2 0 0 1 3.3 18z'],
    cut: ['M3.6 13.5h5l1.2 2.2h4.4l1.2-2.2h5'],
  },
  thread: {
    stroke: ['M7 4h10a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z', 'M9 9h6', 'M9 12.5h6', 'M9 16h3.6'],
    fill: ['M7 3.3h10A2.7 2.7 0 0 1 19.7 6v12a2.7 2.7 0 0 1-2.7 2.7H7A2.7 2.7 0 0 1 4.3 18V6A2.7 2.7 0 0 1 7 3.3z'],
    cut: ['M9 9h6', 'M9 12.5h6', 'M9 16h3.6'],
  },
  search: {
    stroke: ['M10.8 4.4a6.4 6.4 0 1 1 0 12.8 6.4 6.4 0 0 1 0-12.8z', 'M15.5 15.5 20 20'],
  },
  copy: {
    stroke: [
      'M9 9h9.5a1.5 1.5 0 0 1 1.5 1.5V19a1.5 1.5 0 0 1-1.5 1.5H9A1.5 1.5 0 0 1 7.5 19v-8.5A1.5 1.5 0 0 1 9 9z',
      'M16 9V5.5A1.5 1.5 0 0 0 14.5 4h-9A1.5 1.5 0 0 0 4 5.5v8.5a1.5 1.5 0 0 0 1.5 1.5h2',
    ],
  },
  external: {
    stroke: ['M10.5 4.6H6.6a2 2 0 0 0-2 2v10.8a2 2 0 0 0 2 2h10.8a2 2 0 0 0 2-2v-3.9', 'M13.9 4.6h5.5v5.5', 'M19.4 4.6l-8 8'],
  },
  check: {
    stroke: ['M5 12.8 9.6 17.4 19 7.2'],
  },
} satisfies Record<string, Icon>

export type IconName = keyof typeof ICONS
