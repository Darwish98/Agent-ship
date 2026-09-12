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
  // side arm tabs. Legs are split into their own groups (each with a
  // fill-box transform-origin pinned at the hip) so CSS can swing them like
  // a walk cycle without touching the rest of the sprite.
  function bodyMarkup(color) {
    return `
      <rect x="-12" y="-4" width="24" height="20" fill="${color.body}" />
      <rect x="-16" y="6" width="32" height="6" fill="${color.body}" />
      <g class="leg leg-l"><rect x="-8" y="16" width="4" height="8" fill="${color.body}" /></g>
      <g class="leg leg-r"><rect x="4" y="16" width="4" height="8" fill="${color.body}" /></g>
      <rect x="-9" y="0" width="4" height="8" fill="${EYE}" />
      <rect x="5" y="0" width="4" height="8" fill="${EYE}" />
    `;
  }

  function truncate(str, n) {
    return str.length > n ? `${str.slice(0, n - 1)}…` : str;
  }

  // Nameplate is a two-row badge: role on top (small colored pill so it
  // reads as a job title), agent name below in the larger bar. Both rows
  // get their own background so they stay legible over the floor tiles.
  function svgFor(event, key, x, y) {
    const color = colorFor(key);
    const hat = hatFor(event.role);
    const role = truncate(event.role || 'Agent', 16);
    const name = truncate(event.agentName || 'Agent', 14);
    const task = event.task
      ? `<text class="task-text" x="0" y="82" text-anchor="middle">${escapeXml(truncate(event.task, 26))}</text>`
      : '';
    return `
      <g class="crew" id="crew-${cssEscape(key)}" data-session-id="${escapeXml(event.sessionId)}" style="transform: translate(${x}px, ${y}px)">
        <ellipse class="crew-shadow" cx="0" cy="27" rx="15" ry="4" />
        <g class="sprite-flip">
          <g class="sprite">
            ${bodyMarkup(color)}
            ${accessoryMarkup(hat, color.dark)}
          </g>
        </g>
        <g class="tag" transform="translate(0, 33)">
          <rect class="role-bg" x="-32" y="0" width="64" height="13" rx="6" fill="${color.dark}" />
          <text class="role-text" x="0" y="9" text-anchor="middle">${escapeXml(role)}</text>
          <rect class="tag-bg" x="-36" y="15" width="72" height="16" rx="4" />
          <text class="tag-text" x="0" y="27" text-anchor="middle">${escapeXml(name)}</text>
        </g>
        ${task}
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
