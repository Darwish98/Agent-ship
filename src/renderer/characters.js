const CrewArt = (() => {
  const COLORS = [
    { body: '#7f77dd', dark: '#534ab7' },
    { body: '#d85a30', dark: '#993c1d' },
    { body: '#1d9e75', dark: '#0f6e56' },
    { body: '#378add', dark: '#185fa5' },
    { body: '#d4537e', dark: '#993556' },
    { body: '#ba7517', dark: '#854f0b' }
  ];

  const EYE = '#f4f1ea';

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

  // Body block modeled on Claude's pixel mark: solid rect, two cutout eyes,
  // side arm tabs, and two leg tabs. Color and hat vary per agent/role.
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

  function svgFor(event, x, y) {
    const color = colorFor(event.sessionId);
    const hat = hatFor(event.role);
    return `
      <g class="crew" id="crew-${cssEscape(event.sessionId)}" style="transform: translate(${x}px, ${y}px)">
        ${bodyMarkup(color)}
        ${accessoryMarkup(hat, color.dark)}
        <rect class="tag-bg" x="-34" y="34" width="68" height="16" rx="4" fill="#1c222c" stroke="#3a4452" stroke-width="1" />
        <text class="tag-text" x="0" y="45" text-anchor="middle">${escapeXml(event.agentName)}</text>
        <text class="role-text" x="0" y="60" text-anchor="middle">${escapeXml(event.role)}</text>
      </g>
    `;
  }

  function cssEscape(str) {
    return String(str).replace(/[^a-zA-Z0-9_-]/g, '_');
  }

  function escapeXml(str) {
    return String(str).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  }

  return { colorFor, hatFor, svgFor, cssEscape, escapeXml };
})();
