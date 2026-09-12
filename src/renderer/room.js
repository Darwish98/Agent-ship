const STATIONS = {
  Bash: 'engine',
  Edit: 'lab',
  Write: 'lab',
  NotebookEdit: 'lab',
  Read: 'bridge',
  Grep: 'bridge',
  Glob: 'bridge'
};

const STATION_BOUNDS = {
  engine: { xMin: 90, xMax: 320, yMin: 150, yMax: 470 },
  lab: { xMin: 410, xMax: 630, yMin: 150, yMax: 470 },
  bridge: { xMin: 720, xMax: 930, yMin: 150, yMax: 470 }
};

const crewLayer = document.getElementById('crew-layer');
const bubbleLayer = document.getElementById('bubble-layer');
const emptyState = document.getElementById('empty-state');

const positions = new Map();
const bubbleTimers = new Map();

function stationFor(toolName) {
  return STATIONS[toolName] || 'bridge';
}

function positionFor(sessionId, station) {
  const key = `${sessionId}:${station}`;
  if (positions.has(key)) return positions.get(key);
  const b = STATION_BOUNDS[station];
  const pos = {
    x: b.xMin + 40 + Math.random() * (b.xMax - b.xMin - 80),
    y: b.yMin + 30 + Math.random() * (b.yMax - b.yMin - 60)
  };
  positions.set(key, pos);
  return pos;
}

function statusText(event) {
  if (event.status) return event.status;
  if (event.hookEvent === 'UserPromptSubmit') return 'reading the prompt';
  if (event.hookEvent === 'Stop') return 'idle';
  if (event.toolName) return `using ${event.toolName}`;
  return event.hookEvent || 'working';
}

function ensureCrew(event, pos) {
  const id = `crew-${CrewArt.cssEscape(event.sessionId)}`;
  let el = document.getElementById(id);
  if (!el) {
    crewLayer.insertAdjacentHTML('beforeend', CrewArt.svgFor(event, pos.x, pos.y));
    el = document.getElementById(id);
  } else {
    el.style.transform = `translate(${pos.x}px, ${pos.y}px)`;
    const tag = el.querySelector('.tag-text');
    const role = el.querySelector('.role-text');
    if (tag) tag.textContent = event.agentName;
    if (role) role.textContent = event.role;
  }
  return el;
}

function ensureBubble(event, pos, text) {
  const id = `bubble-${CrewArt.cssEscape(event.sessionId)}`;
  let el = document.getElementById(id);
  const bx = pos.x;
  const by = pos.y - 34;

  if (!el) {
    bubbleLayer.insertAdjacentHTML(
      'beforeend',
      `<g class="bubble" id="${id}" style="transform: translate(${bx}px, ${by}px)">
        <foreignObject x="-80" y="-56" width="160" height="52">
          <div xmlns="http://www.w3.org/1999/xhtml" class="bubble-box">${CrewArt.escapeXml(text)}</div>
        </foreignObject>
      </g>`
    );
    el = document.getElementById(id);
  } else {
    el.style.transform = `translate(${bx}px, ${by}px)`;
    const box = el.querySelector('.bubble-box');
    if (box) box.textContent = text;
  }
  return el;
}

function handleEvent(event) {
  if (event.hookEvent === 'SessionEnd') {
    const crewEl = document.getElementById(`crew-${CrewArt.cssEscape(event.sessionId)}`);
    const bubbleEl = document.getElementById(`bubble-${CrewArt.cssEscape(event.sessionId)}`);
    if (crewEl) crewEl.remove();
    if (bubbleEl) bubbleEl.remove();
    if (!crewLayer.children.length) emptyState.classList.remove('hidden');
    return;
  }

  const station = stationFor(event.toolName);
  const pos = positionFor(event.sessionId, station);

  ensureCrew(event, pos);
  const bubbleEl = ensureBubble(event, pos, statusText(event));
  bubbleEl.classList.add('show');

  clearTimeout(bubbleTimers.get(event.sessionId));
  bubbleTimers.set(
    event.sessionId,
    setTimeout(() => bubbleEl.classList.remove('show'), 6000)
  );

  emptyState.classList.add('hidden');
}

window.agentShip.onAgentEvent(handleEvent);
