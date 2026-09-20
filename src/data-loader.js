/**
 * Browser-side data loading.
 *
 * The data files stay in data/ as plain JSON and a text map, shared verbatim
 * with the headless Node balance sweep -- one source of truth for balance.
 *
 * Note this uses fetch, which browsers block on file:// URLs. Serve the folder
 * over HTTP (`python serve.py`, or any static server). See README.md.
 */

import { buildConfig } from './sim/config.js';

const DATA_ROOT = new URL('../data/', import.meta.url);

async function getJson(name) {
  const response = await fetch(new URL(name, DATA_ROOT));
  if (!response.ok) {
    throw new Error(`failed to load data/${name}: HTTP ${response.status}`);
  }
  return response.json();
}

async function getText(name) {
  const response = await fetch(new URL(name, DATA_ROOT));
  if (!response.ok) {
    throw new Error(`failed to load data/${name}: HTTP ${response.status}`);
  }
  return response.text();
}

/**
 * Load every data file and build a validated config.
 * @param {string} mapName map file stem, e.g. "level_01"
 */
export async function loadConfig(mapName = 'level_01') {
  const [enemies, towers, damage, waves, atlas, specialisations, terrain, levels, barracks, weather, skills, map] =
    await Promise.all([
      getJson('enemies.json'),
      getJson('towers.json'),
      getJson('damage_matrix.json'),
      getJson('waves.json'),
      getJson('atlas.json'),
      getJson('specialisations.json'),
      getJson('terrain.json'),
      getJson('maps.json'),
      getJson('barracks.json'),
      getJson('weather.json'),
      getJson('skills.json'),
      getText(`maps/${mapName}.txt`),
    ]);

  // The level index carries the map's base colour, which the tile layer needs,
  // and the zoom the level was framed for.
  const entry = (levels.levels ?? []).find((level) => level.id === mapName) ?? null;

  return buildConfig({
    enemies,
    towers,
    damage,
    waves,
    atlas,
    specialisations,
    terrain,
    barracks,
    weather,
    skills,
    map,
    mapId: mapName,
    mapTint: entry?.tint ?? null,
    mapZoom: entry?.zoom ?? 1.0,
  });
}

/**
 * The list of playable levels, for the map picker.
 *
 * Kept as its own tiny file rather than a directory listing because the browser
 * cannot enumerate a folder over HTTP.
 */
export async function loadLevelIndex() {
  const index = await getJson('maps.json');
  return Array.isArray(index.levels) ? index.levels : [];
}
