// Layout constants for the ship. Rooms are laid out left-to-right, one per
// registered project, inside a hull whose width grows with the project
// count; the whole scene scrolls horizontally if it doesn't fit the window.
const ROOM_W = 260;
const ROOM_GAP = 18;
const HULL_PAD = 36;
const NOSE_W = 90;
const TAIL_W = 130;
const SPACE_MARGIN = 50;
const TOP_MARGIN = 96;
const ROOM_H = 460;
const BOTTOM_MARGIN = 70;

const sceneEl = document.getElementById('scene');
const spaceLayer = document.getElementById('space-layer');
const hullLayer = document.getElementById('hull-layer');
const roomLayer = document.getElementById('room-layer');
const crewLayer = document.getElementById('crew-layer');
const bubbleLayer = document.getElementById('bubble-layer');
const emptyState = document.getElementById('empty-state');

const positions = new Map();
const bubbleTimers = new Map();
const wanderTimers = new Map();
const roomOfKey = new Map(); // key -> current roomId, so wander loops know where to stop
let roomBounds = new Map(); // roomId -> {xMin, xMax, yMin, yMax}

const BUBBLE_HALF_W = 78;

let projects = []; // registered rooms, persisted: [{id, name, path}]
let extraRooms = []; // ephemeral rooms for activity outside any registered project

function allRooms() {
  return [...projects, ...extraRooms];
}

// A subagent's tool-call hooks share their parent's session_id, so agentId
// (when present) is what keeps a subagent's crew member distinct from the
// main session's instead of the two collapsing into one character.
function crewKey(event) {
  return event.agentId ? `${event.sessionId}::${event.agentId}` : event.sessionId;
}

function pathsMatch(cwd, projectPath) {
  const a = cwd.toLowerCase();
  const b = projectPath.toLowerCase();
  return a === b || a.startsWith(b + '\\') || a.startsWith(b + '/');
}

// Finds the registered room whose project a hook event's cwd belongs to,
// falling back to an ephemeral room (added to the ship on the fly) for
// activity in a project the user hasn't registered.
function roomForEvent(event) {
  const cwd = event.projectPath || '';
  let best = null;
  for (const room of projects) {
    if (cwd && pathsMatch(cwd, room.path) && (!best || room.path.length > best.path.length)) {
      best = room;
    }
  }
  if (best) return best;

  const key = `extra:${cwd || event.project || 'unknown'}`;
  let extra = extraRooms.find((r) => r.id === key);
  if (!extra) {
    extra = { id: key, name: event.project || 'unknown', path: cwd, ephemeral: true };
    extraRooms.push(extra);
    renderShip();
  }
  return extra;
}

const MIN_CREW_SEPARATION = 54;

// Distance from a candidate spot to the nearest other crew member already
// standing in the same room (excluding the crew member we're placing).
function minDistToOtherCrew(pos, roomId, avoidKey) {
  const suffix = `:${roomId}`;
  let min = Infinity;
  for (const [posKey, other] of positions) {
    if (!posKey.endsWith(suffix)) continue;
    if (posKey.slice(0, -suffix.length) === avoidKey) continue;
    const d = Math.hypot(pos.x - other.x, pos.y - other.y);
    if (d < min) min = d;
  }
  return min;
}

// Plain uniform placement would happily stack two crew members on the exact
// same spot (and their bubbles on top of each other). A few rejection-
// sampled attempts, keeping whichever candidate ends up furthest from
// everyone else, keeps the room looking populated instead of collapsed.
function randomPosIn(roomId, avoidKey) {
  const b = roomBounds.get(roomId);
  const w = b.xMax - b.xMin - 60;
  const h = b.yMax - b.yMin - 80;
  let best = null;
  let bestDist = -1;
  for (let i = 0; i < 6; i++) {
    const cand = {
      x: b.xMin + 30 + Math.random() * w,
      y: b.yMin + 40 + Math.random() * h
    };
    const dist = minDistToOtherCrew(cand, roomId, avoidKey);
    if (dist >= MIN_CREW_SEPARATION) return cand;
    if (dist > bestDist) {
      bestDist = dist;
      best = cand;
    }
  }
  return best;
}

function positionFor(key, roomId) {
  const posKey = `${key}:${roomId}`;
  if (positions.has(posKey)) return positions.get(posKey);
  const pos = randomPosIn(roomId, key);
  positions.set(posKey, pos);
  return pos;
}

// A speech bubble anchored straight above the crew member can drift outside
// its room (or, near the top of a room, above the hull into open space).
// Clamp its box to the room it belongs to and keep a tail pointing at the
// true crew position even when the box itself had to shift to stay inside.
function computeBubbleAnchor(pos, roomId) {
  const b = roomBounds.get(roomId);
  const xMin = b ? b.xMin + BUBBLE_HALF_W : pos.x - BUBBLE_HALF_W;
  const xMax = b ? b.xMax - BUBBLE_HALF_W : pos.x + BUBBLE_HALF_W;
  const bx = Math.min(Math.max(pos.x, xMin), Math.max(xMin, xMax));
  const minY = (b ? b.yMin : TOP_MARGIN) + 46;
  const by = Math.max(pos.y - 40, minY);
  return { bx, by, tailDx: pos.x - bx };
}

function tailPoints(tailDx) {
  return `${tailDx - 7},-5 ${tailDx + 7},-5 ${tailDx},9`;
}

function statusText(event) {
  if (event.status) return event.status;
  if (event.hookEvent === 'UserPromptSubmit') return 'reading the prompt';
  if (event.hookEvent === 'Stop') return 'idle';
  if (event.toolName) return `using ${event.toolName}`;
  return event.hookEvent || 'working';
}

function truncate(str, n) {
  return str.length > n ? `${str.slice(0, n - 1)}…` : str;
}

// --- Ship rendering -------------------------------------------------------

function buildRivets(x0, x1, y, spacing) {
  let out = '';
  for (let x = x0 + spacing / 2; x < x1; x += spacing) {
    out += `<circle cx="${x}" cy="${y}" r="1.6" fill="#0d1016" opacity="0.7" />`;
  }
  return out;
}

function renderShip() {
  positions.clear();

  const rooms = allRooms();
  const n = rooms.length;
  const slots = Math.max(n, 1);
  const contentW = slots * ROOM_W + (slots - 1) * ROOM_GAP;
  const hullX0 = SPACE_MARGIN + NOSE_W;
  const hullW = HULL_PAD * 2 + contentW;
  const hullX1 = hullX0 + hullW;
  const totalW = hullX1 + TAIL_W + SPACE_MARGIN;
  const totalH = TOP_MARGIN + ROOM_H + BOTTOM_MARGIN;
  const hullY0 = TOP_MARGIN - 26;
  const hullY1 = TOP_MARGIN + ROOM_H + 26;
  const midY = (hullY0 + hullY1) / 2;

  sceneEl.setAttribute('viewBox', `0 0 ${totalW} ${totalH}`);
  sceneEl.setAttribute('width', totalW);
  sceneEl.setAttribute('height', totalH);

  // --- deep space background ---
  spaceLayer.innerHTML = `
    <rect width="${totalW}" height="${totalH}" fill="url(#space-glow)" />
    <rect width="${totalW}" height="${totalH}" fill="url(#stars)" />
    <circle cx="${totalW - 130}" cy="120" r="46" fill="url(#planet-body)" />
    <ellipse cx="${totalW - 130}" cy="120" rx="78" ry="14" fill="none" stroke="#a894e0" stroke-width="3" opacity="0.5" transform="rotate(-18 ${totalW - 130} 120)" />
    <circle cx="120" cy="${totalH - 60}" r="16" fill="#3a4a63" opacity="0.6" />
  `;

  // --- hull: nose, body, tail ---
  const noseTipX = SPACE_MARGIN;
  hullLayer.innerHTML = `
    <polygon points="${noseTipX},${midY} ${hullX0},${hullY0} ${hullX0},${hullY1}" fill="url(#hull-armor)" stroke="#3a4452" stroke-width="2" stroke-linejoin="round" />
    <circle cx="${hullX0 - 34}" cy="${midY}" r="16" fill="url(#window-glow)" stroke="#4d5868" stroke-width="2" />
    <ellipse cx="${hullX0 - 38}" cy="${midY - 5}" rx="5" ry="3" fill="#ffffff" opacity="0.35" />

    <rect x="${hullX0}" y="${hullY0}" width="${hullW}" height="${hullY1 - hullY0}" fill="url(#hull-panel)" stroke="#3a4452" stroke-width="2" />
    <rect x="${hullX0}" y="${hullY0}" width="${hullW}" height="3" fill="#3d4757" opacity="0.7" />
    ${buildRivets(hullX0, hullX1, hullY0 + 6, 26)}
    ${buildRivets(hullX0, hullX1, hullY1 - 6, 26)}

    <polygon points="${hullX1},${hullY0 + 14} ${hullX1 + TAIL_W},${midY - 34} ${hullX1 + TAIL_W},${midY + 34} ${hullX1},${hullY1 - 14}" fill="url(#hull-armor)" stroke="#3a4452" stroke-width="2" stroke-linejoin="round" />
    <g class="engine-flame"><ellipse cx="${hullX1 + TAIL_W + 4}" cy="${midY - 20}" rx="16" ry="7" fill="url(#engine-glow)" /></g>
    <g class="engine-flame"><ellipse cx="${hullX1 + TAIL_W + 4}" cy="${midY}" rx="20" ry="8" fill="url(#engine-glow)" /></g>
    <g class="engine-flame"><ellipse cx="${hullX1 + TAIL_W + 4}" cy="${midY + 20}" rx="16" ry="7" fill="url(#engine-glow)" /></g>
  `;

  // --- rooms ---
  roomBounds = new Map();
  let roomsHtml = '';
  rooms.forEach((room, i) => {
    const x = hullX0 + HULL_PAD + i * (ROOM_W + ROOM_GAP);
    const y = TOP_MARGIN;
    roomBounds.set(room.id, { xMin: x, xMax: x + ROOM_W, yMin: y, yMax: y + ROOM_H });

    const idAttr = CrewArt.cssEscape(room.id);
    const label = truncate(room.name, 22);
    const subtitle = room.ephemeral ? 'not in shipyard' : truncate(room.path, 30);
    const accent = CrewArt.colorFor(room.id).body;

    roomsHtml += `
      <g class="room" data-room-id="${idAttr}">
        <rect x="${x}" y="${y}" width="${ROOM_W}" height="${ROOM_H}" rx="6" fill="url(#floor-tiles)" stroke="#37414f" stroke-width="1" />
        <rect x="${x}" y="${y}" width="${ROOM_W}" height="48" fill="#0d1016" opacity="0.42" />
        <rect x="${x}" y="${y}" width="${ROOM_W}" height="4" rx="2" class="room-header" fill="${accent}" />
        <circle cx="${x + ROOM_W / 2}" cy="${hullY0}" r="15" fill="url(#window-glow)" stroke="#4d5868" stroke-width="2" />
        <text class="room-label" x="${x + 14}" y="${y + 26}">${CrewArt.escapeXml(label)}</text>
        <text class="room-path" x="${x + 14}" y="${y + 42}">${CrewArt.escapeXml(subtitle)}</text>
        ${
          room.ephemeral
            ? ''
            : `<g class="room-remove" data-room-remove="${idAttr}" transform="translate(${x + ROOM_W - 20}, ${y + 18})">
                 <circle r="10" />
                 <text y="4">&#215;</text>
               </g>`
        }
        <g class="spawn-btn" data-room-spawn="${idAttr}" transform="translate(${x + ROOM_W / 2 - 42}, ${y + ROOM_H - 34})">
          <rect width="84" height="24" rx="5" />
          <text x="42" y="16">+ Spawn</text>
        </g>
        ${i > 0 ? `<rect x="${x - ROOM_GAP / 2 - 2}" y="${y - 10}" width="4" height="${ROOM_H + 20}" fill="#111419" />` : ''}
      </g>
    `;
  });
  roomLayer.innerHTML = roomsHtml;

  emptyState.classList.toggle('hidden', n > 0 || crewLayer.children.length > 0);
}

// --- crew rendering (mostly unchanged from the original design) ----------

function ensureCrew(event, key, roomId, pos) {
  const id = `crew-${CrewArt.cssEscape(key)}`;
  let el = document.getElementById(id);
  if (!el) {
    crewLayer.insertAdjacentHTML('beforeend', CrewArt.svgFor(event, key, pos.x, pos.y));
    el = document.getElementById(id);
    roomOfKey.set(key, roomId);
    startWandering(key, roomId);
  } else {
    el.style.transform = `translate(${pos.x}px, ${pos.y}px)`;
    const tag = el.querySelector('.tag-text');
    const role = el.querySelector('.role-text');
    if (tag) tag.textContent = truncate(event.agentName || 'Agent', 14);
    if (role) role.textContent = truncate(event.role || 'Agent', 16);
    if (roomOfKey.get(key) !== roomId) {
      roomOfKey.set(key, roomId);
      startWandering(key, roomId); // room changed under it - wander the new room instead
    }
  }
  return el;
}

// Crew wander their room on a loop so the ship feels alive between status
// updates, not just when an event happens to reposition them. Walking speed
// is roughly constant (duration scales with distance) and the sprite faces
// the direction it's moving.
function startWandering(key, roomId) {
  stopWandering(key);

  const tick = () => {
    const el = document.getElementById(`crew-${CrewArt.cssEscape(key)}`);
    if (!el || !roomBounds.has(roomId) || roomOfKey.get(key) !== roomId) {
      wanderTimers.delete(key);
      return;
    }

    const posKey = `${key}:${roomId}`;
    const oldPos = positions.get(posKey) || randomPosIn(roomId, key);
    const newPos = randomPosIn(roomId, key);
    positions.set(posKey, newPos);

    const dist = Math.hypot(newPos.x - oldPos.x, newPos.y - oldPos.y);
    const duration = Math.min(2200, Math.max(500, dist * 7));

    el.style.transitionDuration = `${duration}ms`;
    el.style.transform = `translate(${newPos.x}px, ${newPos.y}px)`;
    const flip = el.querySelector('.sprite-flip');
    if (flip) flip.style.transform = newPos.x < oldPos.x ? 'scaleX(-1)' : '';
    el.classList.add('walking');
    clearTimeout(el._walkStopTimer);
    el._walkStopTimer = setTimeout(() => el.classList.remove('walking'), duration);

    moveBubbleIfShown(key, newPos, roomId);

    wanderTimers.set(key, setTimeout(tick, duration + 1600 + Math.random() * 3400));
  };

  wanderTimers.set(key, setTimeout(tick, 1200 + Math.random() * 3000));
}

function stopWandering(key) {
  clearTimeout(wanderTimers.get(key));
  wanderTimers.delete(key);
}

function ensureBubble(event, key, pos, text, roomId) {
  const id = `bubble-${CrewArt.cssEscape(key)}`;
  let el = document.getElementById(id);
  const { bx, by, tailDx } = computeBubbleAnchor(pos, roomId);

  if (!el) {
    bubbleLayer.insertAdjacentHTML(
      'beforeend',
      `<g class="bubble" id="${id}" data-session-id="${CrewArt.escapeXml(event.sessionId)}" style="transform: translate(${bx}px, ${by}px)">
        <foreignObject x="-${BUBBLE_HALF_W}" y="-56" width="${BUBBLE_HALF_W * 2}" height="52">
          <div xmlns="http://www.w3.org/1999/xhtml" class="bubble-box">${CrewArt.escapeXml(text)}</div>
        </foreignObject>
        <polygon class="bubble-tail" points="${tailPoints(tailDx)}" />
      </g>`
    );
    el = document.getElementById(id);
  } else {
    el.style.transform = `translate(${bx}px, ${by}px)`;
    const box = el.querySelector('.bubble-box');
    if (box) box.textContent = text;
    const tail = el.querySelector('.bubble-tail');
    if (tail) tail.setAttribute('points', tailPoints(tailDx));
  }
  return el;
}

// Keeps a currently-visible speech bubble glued above its crew member while
// that crew member wanders, instead of leaving the bubble stranded behind.
function moveBubbleIfShown(key, pos, roomId) {
  const bubbleEl = document.getElementById(`bubble-${CrewArt.cssEscape(key)}`);
  if (!bubbleEl || !bubbleEl.classList.contains('show')) return;
  const { bx, by, tailDx } = computeBubbleAnchor(pos, roomId);
  bubbleEl.style.transform = `translate(${bx}px, ${by}px)`;
  const tail = bubbleEl.querySelector('.bubble-tail');
  if (tail) tail.setAttribute('points', tailPoints(tailDx));
}

function removeCrew(key) {
  const crewEl = document.getElementById(`crew-${CrewArt.cssEscape(key)}`);
  const bubbleEl = document.getElementById(`bubble-${CrewArt.cssEscape(key)}`);
  if (crewEl) crewEl.remove();
  if (bubbleEl) bubbleEl.remove();
  clearTimeout(bubbleTimers.get(key));
  bubbleTimers.delete(key);
  stopWandering(key);
  roomOfKey.delete(key);
  emptyState.classList.toggle('hidden', allRooms().length > 0 || crewLayer.children.length > 0);
}

function handleEvent(event) {
  if (event.hookEvent === 'SessionEnd') {
    document.querySelectorAll(`[data-session-id="${CSS.escape(event.sessionId)}"]`).forEach((el) => el.remove());
    emptyState.classList.toggle('hidden', allRooms().length > 0 || crewLayer.children.length > 0);
    return;
  }

  if (event.subagentDoneId) {
    removeCrew(`${event.sessionId}::${event.subagentDoneId}`);
  }

  const room = roomForEvent(event);
  const key = crewKey(event);
  const pos = positionFor(key, room.id);

  ensureCrew(event, key, room.id, pos);
  const bubbleEl = ensureBubble(event, key, pos, statusText(event), room.id);
  bubbleEl.classList.add('show');

  clearTimeout(bubbleTimers.get(key));
  bubbleTimers.set(
    key,
    setTimeout(() => bubbleEl.classList.remove('show'), 6000)
  );

  emptyState.classList.add('hidden');
}

window.agentShip.onAgentEvent(handleEvent);

// --- shipyard UI: add / remove projects, spawn agents ---------------------

// Registering a project that already had an ephemeral "not in shipyard"
// room (from activity seen before it was added) would otherwise leave two
// rooms for the same folder side by side - drop the ephemeral one now that
// a real one covers its path. Any crew still tagged to the old room self-
// corrects to the new one on its next event (position is recomputed then).
function applyProjects(list) {
  projects = list;
  extraRooms = extraRooms.filter((r) => !r.path || !projects.some((p) => pathsMatch(r.path, p.path)));
  renderShip();
}

async function refreshProjects() {
  applyProjects(await window.agentShip.listProjects());
}

document.getElementById('add-project-btn').addEventListener('click', async () => {
  applyProjects(await window.agentShip.addProject());
});

roomLayer.addEventListener('click', async (e) => {
  const removeBtn = e.target.closest('[data-room-remove]');
  if (removeBtn) {
    const id = removeBtn.getAttribute('data-room-remove');
    const room = projects.find((p) => CrewArt.cssEscape(p.id) === id);
    if (room && confirm(`Remove "${room.name}" from the ship? Agents already running there keep running.`)) {
      applyProjects(await window.agentShip.removeProject(room.id));
    }
    return;
  }

  const spawnBtn = e.target.closest('[data-room-spawn]');
  if (spawnBtn) {
    const id = spawnBtn.getAttribute('data-room-spawn');
    const room = allRooms().find((r) => CrewArt.cssEscape(r.id) === id);
    if (room) openSpawnModal(room);
  }
});

// --- spawn modal ---

const spawnModal = document.getElementById('spawn-modal');
const spawnProjectName = document.getElementById('spawn-project-name');
const spawnRoleInput = document.getElementById('spawn-role');
const spawnTaskInput = document.getElementById('spawn-task');
const spawnError = document.getElementById('spawn-error');
let spawnTargetRoom = null;

function openSpawnModal(room) {
  spawnTargetRoom = room;
  spawnProjectName.textContent = room.path ? `in ${room.name} (${room.path})` : `in ${room.name}`;
  spawnRoleInput.value = '';
  spawnTaskInput.value = '';
  spawnError.classList.add('hidden');
  spawnModal.classList.remove('hidden');
  spawnRoleInput.focus();
}

function closeSpawnModal() {
  spawnModal.classList.add('hidden');
  spawnTargetRoom = null;
}

document.getElementById('spawn-cancel').addEventListener('click', closeSpawnModal);
spawnModal.addEventListener('click', (e) => {
  if (e.target === spawnModal) closeSpawnModal();
});

document.getElementById('spawn-submit').addEventListener('click', async () => {
  const role = spawnRoleInput.value.trim();
  const task = spawnTaskInput.value.trim();
  if (!spawnTargetRoom || !spawnTargetRoom.path) {
    spawnError.textContent = 'This room has no known project folder yet.';
    spawnError.classList.remove('hidden');
    return;
  }
  if (!task) {
    spawnError.textContent = 'Give the agent a task.';
    spawnError.classList.remove('hidden');
    return;
  }
  const result = await window.agentShip.spawnAgent(spawnTargetRoom.path, role, task);
  if (!result.ok) {
    spawnError.textContent = result.error || 'Could not spawn agent.';
    spawnError.classList.remove('hidden');
    return;
  }
  closeSpawnModal();
});

refreshProjects();
