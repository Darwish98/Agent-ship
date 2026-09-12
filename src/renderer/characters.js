// Crew identity: a per-agent color, a role-derived hat/badge, and a small
// avatar icon used in the room roster list. Claude-inspired palette - warm,
// muted hues rather than saturated sci-fi colors.
const CrewArt = (() => {
  const COLORS = [
    { body: '#C15F3C', dark: '#8B4028' }, // terracotta
    { body: '#6B8F71', dark: '#47614C' }, // sage
    { body: '#5B7C99', dark: '#3E5871' }, // slate
    { body: '#8B6BA8', dark: '#5F4977' }, // plum
    { body: '#B08B5C', dark: '#7A5E3B' }, // sand
    { body: '#B5697A', dark: '#7D4553' } // rose
  ];

  const EYE = '#ffffff';

  // Short role codes + a fixed accent per role family, independent of the
  // crewmate's own color - reads as a badge/lanyard rather than a uniform.
  const ROLE_BADGES = {
    antenna: { code: 'DEV', color: '#6B5B95' },
    visor: { code: 'BE', color: '#5B7C99' },
    beret: { code: 'FE', color: '#47614C' },
    cap: { code: 'OPS', color: '#7D4553' },
    headset: { code: 'QA', color: '#8B6134' }
  };

  function hashStr(str) {
    let h = 0;
    for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) >>> 0;
    return h;
  }

  function colorFor(key) {
    return COLORS[hashStr(key) % COLORS.length];
  }

  function hatFor(role) {
    const r = (role || '').toLowerCase();
    if (r.includes('qa') || r.includes('test')) return 'headset';
    if (r.includes('devops') || r.includes('deploy') || r.includes('infra')) return 'cap';
    if (r.includes('design') || r.includes('frontend') || r.includes('ui')) return 'beret';
    if (r.includes('backend') || r.includes('api') || r.includes('server')) return 'visor';
    return 'antenna';
  }

  function badgeFor(role) {
    return ROLE_BADGES[hatFor(role)];
  }

  // Blocky, pixel-grid accessories - rectangles only, to match the body style.
  function accessoryMarkup(kind, dark) {
    switch (kind) {
      case 'headset':
        return `
          <rect x="-12" y="-6" width="24" height="3" fill="${dark}" />
          <rect x="-12" y="-3" width="3" height="7" fill="${dark}" />
          <rect x="9" y="-3" width="3" height="7" fill="${dark}" />
        `;
      case 'cap':
        return `
          <rect x="-9" y="-12" width="18" height="5" fill="${dark}" />
          <rect x="-13" y="-8" width="26" height="5" fill="${dark}" />
        `;
      case 'beret':
        return `
          <rect x="-10" y="-9" width="20" height="6" fill="${dark}" />
          <rect x="6" y="-13" width="4" height="4" fill="${dark}" />
        `;
      case 'visor':
        return `<rect x="-10" y="-1" width="20" height="4" fill="${dark}" opacity="0.85" />`;
      default:
        return `
          <rect x="-1" y="-12" width="2" height="8" fill="${dark}" />
          <rect x="-3" y="-17" width="6" height="5" fill="${EYE}" />
        `;
    }
  }

  // Body block modeled on Claude's own pixel mark: solid rect, two cutout
  // eyes, a side arm tab, and two foot tabs.
  function bodyMarkup(color) {
    return `
      <rect x="-12" y="-4" width="24" height="20" fill="${color.body}" />
      <rect x="-16" y="6" width="32" height="6" fill="${color.body}" />
      <rect x="-8" y="16" width="4" height="8" fill="${color.body}" />
      <rect x="4" y="16" width="4" height="8" fill="${color.body}" />
      <rect x="-9" y="0" width="4" height="8" fill="${EYE}" />
      <rect x="5" y="0" width="4" height="8" fill="${EYE}" />
    `;
  }

  // A small self-contained <svg> for the crew roster row.
  function avatarSvg(key, role) {
    const color = colorFor(key);
    const hat = hatFor(role);
    return `<svg class="crew-avatar" viewBox="-20 -22 40 50" width="40" height="46">${bodyMarkup(color)}${accessoryMarkup(hat, color.dark)}</svg>`;
  }

  function truncate(str, n) {
    return str.length > n ? `${str.slice(0, n - 1)}…` : str;
  }

  function escapeXml(str) {
    return String(str).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  }

  function cssEscape(str) {
    return String(str).replace(/[^a-zA-Z0-9_-]/g, '_');
  }

  return { colorFor, hatFor, badgeFor, avatarSvg, truncate, escapeXml, cssEscape };
})();
