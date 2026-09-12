// Persists the user's registered projects ("rooms" in the ship) across
// restarts - a JSON file in Electron's per-user app data directory.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function shipyardPath(userDataDir) {
  return path.join(userDataDir, 'shipyard.json');
}

function loadProjects(userDataDir) {
  const file = shipyardPath(userDataDir);
  if (!fs.existsSync(file)) return [];
  try {
    const list = JSON.parse(fs.readFileSync(file, 'utf8'));
    return Array.isArray(list) ? list : [];
  } catch (_e) {
    return [];
  }
}

function saveProjects(userDataDir, list) {
  fs.mkdirSync(userDataDir, { recursive: true });
  fs.writeFileSync(shipyardPath(userDataDir), JSON.stringify(list, null, 2));
}

function addProject(userDataDir, projectPath) {
  const list = loadProjects(userDataDir);
  const normalized = path.resolve(projectPath);
  if (list.some((p) => p.path.toLowerCase() === normalized.toLowerCase())) {
    return list;
  }
  list.push({
    id: crypto.createHash('sha1').update(normalized.toLowerCase()).digest('hex').slice(0, 12),
    name: path.basename(normalized) || normalized,
    path: normalized
  });
  saveProjects(userDataDir, list);
  return list;
}

function removeProject(userDataDir, id) {
  const list = loadProjects(userDataDir).filter((p) => p.id !== id);
  saveProjects(userDataDir, list);
  return list;
}

module.exports = { loadProjects, saveProjects, addProject, removeProject };
