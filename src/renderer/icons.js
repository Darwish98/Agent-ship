// Small reusable icon set: colored rounded-square badges with a white glyph,
// used on desk screens, room buttons, and toolbar/modal controls.
const Icons = (() => {
  const KIND_COLOR = {
    add: '#2f9e57',
    spawn: '#2f9e57',
    success: '#2f9e57',
    remove: '#c94b4b',
    error: '#c94b4b',
    conflict: '#d9a02c',
    idle: '#5865a0',
    working: '#3a5fc9',
    edit: '#8a6fd6',
    search: '#3a8fd6',
    talk: '#2f8f9e',
    merge: '#3a7bd5'
  };

  function glyph(kind) {
    switch (kind) {
      case 'add':
      case 'spawn':
        return '<path d="M0 -5 V5 M-5 0 H5" stroke="#fff" stroke-width="2.2" stroke-linecap="round" />';
      case 'remove':
        return '<path d="M-4 -4 L4 4 M4 -4 L-4 4" stroke="#fff" stroke-width="2.2" stroke-linecap="round" />';
      case 'error':
        return '<path d="M-4 -4 L4 4 M4 -4 L-4 4" stroke="#fff" stroke-width="2.4" stroke-linecap="round" />';
      case 'success':
        return '<path d="M-4.5 0 L-1 3.5 L5 -4" fill="none" stroke="#fff" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" />';
      case 'conflict':
        return '<path d="M0 -5 V1" stroke="#fff" stroke-width="2.2" stroke-linecap="round" /><circle cx="0" cy="4.3" r="1.3" fill="#fff" />';
      case 'idle':
        return '<text x="0" y="3.6" text-anchor="middle" font-size="9" font-weight="800" fill="#fff" font-family="ui-monospace, Consolas, monospace">z</text>';
      case 'working':
        return '<circle cx="-4" cy="0" r="1.5" fill="#fff" /><circle cx="0" cy="0" r="1.5" fill="#fff" /><circle cx="4" cy="0" r="1.5" fill="#fff" />';
      case 'edit':
        return '<path d="M-4.2 3.6 L2 -3.4 L4.4 -1 L-1.8 6 Z M2 -3.4 L4.4 -1" fill="#fff" stroke="#fff" stroke-width="0.6" stroke-linejoin="round" />';
      case 'search':
        return '<circle cx="-1.4" cy="-1.4" r="3.2" fill="none" stroke="#fff" stroke-width="2" /><path d="M1 1 L4.4 4.4" stroke="#fff" stroke-width="2" stroke-linecap="round" />';
      case 'talk':
        return '<rect x="-5" y="-4.4" width="10" height="7" rx="2" fill="none" stroke="#fff" stroke-width="1.7" /><path d="M-1.6 2.6 L-3 5.6 L0.4 2.6" fill="none" stroke="#fff" stroke-width="1.7" stroke-linejoin="round" />';
      case 'merge':
        return '<path d="M-3 -5 V0 Q-3 3.2 0 3.2 H2.6 M2.6 3.2 L0.4 1 M2.6 3.2 L0.4 5.4" fill="none" stroke="#fff" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" />';
      default:
        return '';
    }
  }

  function badge(kind, size, extraClass) {
    size = size || 20;
    const color = KIND_COLOR[kind] || '#3a4452';
    const r = size / 2;
    return `<g class="icon-badge${extraClass ? ' ' + extraClass : ''}" data-icon="${kind}">
      <rect x="${-r}" y="${-r}" width="${size}" height="${size}" rx="${(size * 0.28).toFixed(1)}" fill="${color}" />
      ${glyph(kind)}
    </g>`;
  }

  return { badge, glyph, KIND_COLOR };
})();
