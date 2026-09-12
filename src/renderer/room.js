// Rooms render as adjoining cells inside one shared "building" (HTML/CSS),
// one room per registered project, filling the window's width and reflowing
// as it resizes - no fixed canvas, no scroll unless there are more rooms
// than fit vertically.

const roomsGrid = document.getElementById('rooms-grid');
const emptyState = document.getElementById('empty-state');

let projects = []; // registered rooms, persisted: [{id, name, path}]
let extraRooms = []; // ephemeral rooms for activity outside any registered project

const crewState = new Map(); // crewKey -> { event, roomId } - lets a re-render restore the full roster
const roomActivity = new Map(); // roomId -> icon kind shown on the room's status dot
const bubbleTimers = new Map(); // crewKey -> timeout hiding the transient status bubble
const positions = new Map(); // crewKey -> {x, y} within its room's stage
const roomOfKey = new Map(); // crewKey -> current roomId, so a wander loop knows where to stop
const wanderTimers = new Map(); // crewKey -> timeout for the next wander step

const SPRITE_MARGIN_X = 24;
const SPRITE_MARGIN_TOP = 30; // leaves room for the status bubble above
const SPRITE_MARGIN_BOTTOM = 30; // leaves room for the name tag below
const MIN_CREW_SEPARATION = 46;

function allRooms() {
  return [...projects, ...extraRooms];
}

// A subagent's tool-call hooks share their parent's session_id, so agentId
// (when present) is what keeps a subagent's crew member distinct from the
// main session's instead of the two collapsing into one roster row.
function crewKey(event) {
  return event.agentId ? `${event.sessionId}::${event.agentId}` : event.sessionId;
}

function pathsMatch(cwd, projectPath) {
  const a = cwd.toLowerCase();
  const b = projectPath.toLowerCase();
  return a === b || a.startsWith(b + '\\') || a.startsWith(b + '/');
}

// Finds the registered room whose project a hook event's cwd belongs to,
// falling back to an ephemeral room (added to the grid on the fly) for
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
    renderRooms();
  }
  return extra;
}

function statusText(event) {
  if (event.status) return event.status;
  if (event.hookEvent === 'UserPromptSubmit') return 'reading the prompt';
  if (event.hookEvent === 'Stop') return 'idle';
  if (event.toolName) return `using ${event.toolName}`;
  return event.hookEvent || 'working';
}

// Maps a hook event to one of the icon-set glyphs shown on a room's status
// dot - the closest read on activity the hook payload actually gives us (no
// real success/error signal exists upstream, so this reflects tool category
// rather than outcome).
function iconKindFor(event) {
  if (!event) return 'idle';
  if (event.hookEvent === 'Stop') return 'idle';
  if (event.hookEvent === 'UserPromptSubmit') return 'talk';
  const tool = (event.toolName || '').toLowerCase();
  if (tool === 'edit' || tool === 'write' || tool === 'multiedit' || tool === 'notebookedit') return 'edit';
  if (tool === 'read' || tool === 'grep' || tool === 'glob') return 'search';
  if (tool === 'task' || tool === 'agent') return 'merge';
  return 'working';
}

// --- rendering --------------------------------------------------------

function stageEl(roomId) {
  return document.querySelector(`[data-room-stage="${CrewArt.cssEscape(roomId)}"]`);
}

function stageBounds(roomId) {
  const el = stageEl(roomId);
  return { w: (el && el.clientWidth) || 260, h: (el && el.clientHeight) || 118 };
}

// Distance from a candidate spot to the nearest other crew member already
// standing in the same room (excluding the crew member being placed).
function minDistToOtherCrew(pos, roomId, avoidKey) {
  let min = Infinity;
  for (const [key, v] of crewState) {
    if (key === avoidKey || v.roomId !== roomId) continue;
    const p = positions.get(key);
    if (!p) continue;
    const d = Math.hypot(pos.x - p.x, pos.y - p.y);
    if (d < min) min = d;
  }
  return min;
}

// Plain uniform placement would happily stack two crew members on the exact
// same spot. A few rejection-sampled attempts, keeping whichever candidate
// ends up furthest from everyone else, keeps the stage looking populated.
function randomPosIn(roomId, avoidKey) {
  const { w, h } = stageBounds(roomId);
  const usableW = Math.max(w - SPRITE_MARGIN_X * 2, 10);
  const usableH = Math.max(h - SPRITE_MARGIN_TOP - SPRITE_MARGIN_BOTTOM, 10);
  let best = null;
  let bestDist = -1;
  for (let i = 0; i < 6; i++) {
    const cand = {
      x: SPRITE_MARGIN_X + Math.random() * usableW,
      y: SPRITE_MARGIN_TOP + Math.random() * usableH
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
  if (positions.has(key)) return positions.get(key);
  const pos = randomPosIn(roomId, key);
  positions.set(key, pos);
  return pos;
}

function spriteMarkup(key, event, pos) {
  const badge = CrewArt.badgeFor(event.role);
  const name = CrewArt.truncate(event.agentName || 'Agent', 14);
  return `
    <div class="crew-sprite" id="crew-${CrewArt.cssEscape(key)}" data-session-id="${CrewArt.escapeXml(event.sessionId)}" style="transform: translate(${pos.x}px, ${pos.y}px)">
      <div class="crew-flip"><div class="crew-bob">${CrewArt.avatarSvg(key, event.role)}</div></div>
      <div class="crew-tag">
        <span class="role-chip-mini" style="background:${badge.color}">${badge.code}</span>
        <span class="crew-name-mini">${CrewArt.escapeXml(name)}</span>
      </div>
      <div class="crew-bubble"></div>
    </div>
  `;
}

function roomCardMarkup(room) {
  const idAttr = CrewArt.cssEscape(room.id);
  const label = CrewArt.truncate(room.name, 28);
  const subtitle = room.ephemeral ? 'not registered' : CrewArt.truncate(room.path, 42);
  const accent = CrewArt.colorFor(room.id).body;
  const kind = roomActivity.get(room.id) || 'idle';

  return `
    <div class="room-card" data-room-id="${idAttr}" style="border-left-color:${accent}">
      <div class="room-card-header">
        <div class="room-card-title">
          <svg class="room-status-dot" data-room-status="${idAttr}" viewBox="-10 -10 20 20" width="18" height="18">${Icons.badge(kind, 20)}</svg>
          <div class="room-card-heading">
            <div class="room-name">${CrewArt.escapeXml(label)}</div>
            <div class="room-path">${CrewArt.escapeXml(subtitle)}</div>
          </div>
        </div>
        ${
          room.ephemeral
            ? ''
            : `<button class="icon-btn danger" data-room-remove="${idAttr}" title="Remove project" aria-label="Remove project">
                 <svg viewBox="-8 -8 16 16" width="14" height="14"><path d="M-4 -4 L4 4 M4 -4 L-4 4" stroke="currentColor" stroke-width="2" stroke-linecap="round" /></svg>
               </button>`
        }
      </div>
      <div class="room-stage" data-room-stage="${idAttr}">
        <div class="room-stage-empty">No active agents</div>
      </div>
      <button class="spawn-pill" data-room-spawn="${idAttr}">
        <svg viewBox="-8 -8 16 16" width="13" height="13"><path d="M0 -5 V5 M-5 0 H5" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" /></svg>
        Spawn agent
      </button>
    </div>
  `;
}

function renderRooms() {
  const rooms = allRooms();
  roomsGrid.innerHTML = rooms.map(roomCardMarkup).join('');
  emptyState.classList.toggle('hidden', rooms.length > 0);

  // The grid was fully rebuilt (new project registered/removed) - repopulate
  // each stage from the roster we already know about and get everyone
  // wandering again in their freshly-measured stage.
  for (const [key, v] of crewState) {
    if (!rooms.some((r) => r.id === v.roomId)) continue;
    positions.delete(key);
    const pos = positionFor(key, v.roomId);
    ensureSprite(v.event, key, v.roomId, pos, false);
  }
}

// Swaps a room's status-dot icon in place and gives it a brief pulse so a
// status change is noticeable even if you weren't looking at that room.
function updateRoomActivity(roomId, kind) {
  if (roomActivity.get(roomId) === kind) return;
  roomActivity.set(roomId, kind);
  const dot = document.querySelector(`[data-room-status="${CrewArt.cssEscape(roomId)}"]`);
  if (!dot) return;
  dot.innerHTML = Icons.badge(kind, 20);
  dot.classList.remove('pulse');
  void dot.offsetWidth; // restart the animation
  dot.classList.add('pulse');
}

function ensureSprite(event, key, roomId, pos, roomChanged) {
  const id = `crew-${CrewArt.cssEscape(key)}`;
  let el = document.getElementById(id);

  if (!el) {
    const stage = stageEl(roomId);
    if (!stage) return null;
    const hint = stage.querySelector('.room-stage-empty');
    if (hint) hint.remove();
    stage.insertAdjacentHTML('beforeend', spriteMarkup(key, event, pos));
    el = document.getElementById(id);
    roomOfKey.set(key, roomId);
    startWandering(key, roomId);
    return el;
  }

  const badge = CrewArt.badgeFor(event.role);
  const name = CrewArt.truncate(event.agentName || 'Agent', 14);
  const nameEl = el.querySelector('.crew-name-mini');
  const chipEl = el.querySelector('.role-chip-mini');
  if (nameEl) nameEl.textContent = name;
  if (chipEl) {
    chipEl.textContent = badge.code;
    chipEl.style.background = badge.color;
  }

  if (roomChanged) {
    const stage = stageEl(roomId);
    if (stage) {
      const hint = stage.querySelector('.room-stage-empty');
      if (hint) hint.remove();
      el.style.transitionDuration = '0s';
      el.style.transform = `translate(${pos.x}px, ${pos.y}px)`;
      stage.appendChild(el);
      void el.offsetWidth;
      el.style.transitionDuration = '';
    }
    roomOfKey.set(key, roomId);
    startWandering(key, roomId);
  }
  return el;
}

// Crew wander their room's stage on a loop so it feels like a live world
// between status updates, not just a static roster. Walking speed is
// roughly constant (duration scales with distance) and the sprite faces
// the direction it's moving.
function startWandering(key, roomId) {
  stopWandering(key);

  const tick = () => {
    const el = document.getElementById(`crew-${CrewArt.cssEscape(key)}`);
    if (!el || roomOfKey.get(key) !== roomId || !stageEl(roomId)) {
      wanderTimers.delete(key);
      return;
    }

    const oldPos = positions.get(key) || randomPosIn(roomId, key);
    const newPos = randomPosIn(roomId, key);
    positions.set(key, newPos);

    const dist = Math.hypot(newPos.x - oldPos.x, newPos.y - oldPos.y);
    const duration = Math.min(2000, Math.max(450, dist * 6));

    el.style.transitionDuration = `${duration}ms`;
    el.style.transform = `translate(${newPos.x}px, ${newPos.y}px)`;
    const flip = el.querySelector('.crew-flip');
    if (flip) flip.style.transform = newPos.x < oldPos.x ? 'scaleX(-1)' : '';
    el.classList.add('walking');
    clearTimeout(el._walkStopTimer);
    el._walkStopTimer = setTimeout(() => el.classList.remove('walking'), duration);

    wanderTimers.set(key, setTimeout(tick, duration + 1000 + Math.random() * 2200));
  };

  wanderTimers.set(key, setTimeout(tick, 600 + Math.random() * 1800));
}

function stopWandering(key) {
  clearTimeout(wanderTimers.get(key));
  wanderTimers.delete(key);
}

function showStatusBubble(el, key, text) {
  const bubble = el.querySelector('.crew-bubble');
  if (!bubble) return;
  bubble.textContent = text;
  bubble.classList.add('show');
  clearTimeout(bubbleTimers.get(key));
  bubbleTimers.set(key, setTimeout(() => bubble.classList.remove('show'), 5000));
}

function removeSprite(key) {
  const el = document.getElementById(`crew-${CrewArt.cssEscape(key)}`);
  const stage = el ? el.closest('.room-stage') : null;
  if (el) el.remove();
  crewState.delete(key);
  positions.delete(key);
  roomOfKey.delete(key);
  stopWandering(key);
  clearTimeout(bubbleTimers.get(key));
  bubbleTimers.delete(key);
  if (stage && !stage.querySelector('.crew-sprite')) {
    stage.innerHTML = '<div class="room-stage-empty">No active agents</div>';
  }
}

function handleEvent(event) {
  if (event.hookEvent === 'SessionEnd') {
    for (const [key, v] of [...crewState]) {
      if (v.event.sessionId === event.sessionId) removeSprite(key);
    }
    return;
  }

  if (event.subagentDoneId) {
    removeSprite(`${event.sessionId}::${event.subagentDoneId}`);
  }

  const room = roomForEvent(event);
  const key = crewKey(event);
  crewState.set(key, { event, roomId: room.id });
  updateRoomActivity(room.id, iconKindFor(event));

  const roomChanged = roomOfKey.get(key) !== room.id;
  if (roomChanged) positions.delete(key);
  const pos = positionFor(key, room.id);
  const el = ensureSprite(event, key, room.id, pos, roomChanged);
  if (el) showStatusBubble(el, key, statusText(event));
}

window.agentShip.onAgentEvent(handleEvent);

// --- shipyard UI: add / remove projects, spawn agents ---------------------

// Registering a project that already had an ephemeral "not in shipyard"
// room (from activity seen before it was added) would otherwise leave two
// rooms for the same folder side by side - drop the ephemeral one now that
// a real one covers its path. Crew rows tagged to the old room id simply
// re-tag themselves to the new one on their next event.
function applyProjects(list) {
  projects = list;
  extraRooms = extraRooms.filter((r) => !r.path || !projects.some((p) => pathsMatch(r.path, p.path)));
  renderRooms();
}

async function refreshProjects() {
  applyProjects(await window.agentShip.listProjects());
}

document.getElementById('add-project-btn').addEventListener('click', async () => {
  applyProjects(await window.agentShip.addProject());
});

roomsGrid.addEventListener('click', async (e) => {
  const removeBtn = e.target.closest('[data-room-remove]');
  if (removeBtn) {
    const id = removeBtn.getAttribute('data-room-remove');
    const room = projects.find((p) => CrewArt.cssEscape(p.id) === id);
    if (room && confirm(`Remove "${room.name}" from the building? Agents already running there keep running.`)) {
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
