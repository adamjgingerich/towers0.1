/**
 * Colour themes.
 *
 * Each theme is a set of CSS custom properties applied to the document root,
 * plus optional behaviour flags: `rgb` animates HUD text colour through the
 * spectrum, and `dynamic` recomputes the palette from the wall clock. Kept as
 * data so a new theme is one object and the dropdown builds itself from THEMES.
 */

const vars = (bg, panel, panel2, line, text, muted, amber, cyan, green, red) => ({
  '--bg': bg,
  '--panel': panel,
  '--panel-2': panel2,
  '--line': line,
  '--text': text,
  '--muted': muted,
  '--amber': amber,
  '--cyan': cyan,
  '--green': green,
  '--red': red,
});

/**
 * Typefaces loaded once, shared across themes. A theme references one by key
 * and falls back to a neutral stack when its font is missing.
 */
const FONTS = {
  jetbrains: '"JetBrains Mono", "Cascadia Code", Consolas, monospace',
  ibm: '"IBM Plex Mono", Consolas, monospace',
  fira: '"Fira Code", Consolas, monospace',
  vt323: '"VT323", "Courier New", monospace',
  pixel: '"Press Start 2P", "Courier New", monospace',
  silk: '"Silkscreen", Consolas, monospace',
  orbitron: '"Orbitron", "Segoe UI", sans-serif',
  audiowide: '"Audiowide", "Segoe UI", sans-serif',
  cinzel: '"Cinzel", Georgia, serif',
  elite: '"Special Elite", "Courier New", monospace',
  space: '"Space Grotesk", "Segoe UI", sans-serif',
  bebas: '"Bebas Neue", "Arial Narrow", sans-serif',
  monoton: '"Monoton", "Segoe UI", sans-serif',
  sharetech: '"Share Tech Mono", Consolas, monospace',
};

/** One theme: a palette, an optional typeface, an optional text effect. */
const make = (id, name, group, font, colors, options = {}) => ({
  id,
  name,
  group,
  font,
  size: options.size ?? 13,
  fx: options.fx ?? null,
  dynamic: Boolean(options.dynamic),
  vars: vars(...colors),
});

export const THEMES = [
  // ------------------------------------------------------------ Terminals
  make('midnight', 'Midnight', 'Terminals', 'jetbrains', ['#0b0e13', '#131820', '#1a212c', '#26303e', '#dfe6f0', '#8494a8', '#ffd166', '#7fd6ff', '#6ee7a8', '#ff6b6b']),
  make('terminal', 'Phosphor Green', 'Terminals', 'ibm', ['#041007', '#071b0d', '#0b2813', '#165b29', '#5dff92', '#2f9e5a', '#d6ff73', '#6effd2', '#5dff92', '#ff6464'], { fx: 'glow' }),
  make('amber', 'Amber CRT', 'Terminals', 'ibm', ['#0e0800', '#1c1102', '#281804', '#4f3409', '#ffc875', '#c78c33', '#ffc875', '#ffdca6', '#d6b25c', '#ff8066'], { fx: 'glow' }),
  make('ice', 'Ice CRT', 'Terminals', 'ibm', ['#02090f', '#06131c', '#0a1e2b', '#144057', '#aee6ff', '#4f9cc4', '#ffe08a', '#8ae0ff', '#7be0c8', '#ff8a8a'], { fx: 'glow' }),
  make('vt100', 'VT100', 'Terminals', 'vt323', ['#000000', '#000800', '#001400', '#0f3d0f', '#7dff9a', '#3e9a4e', '#c8ff73', '#7dffd2', '#7dff9a', '#ff7d7d'], { size: 16, fx: 'pulse' }),
  make('tty', 'Linux TTY', 'Terminals', 'ibm', ['#000000', '#000000', '#080808', '#3a3a3a', '#e0e0e0', '#808080', '#e0c060', '#60c0e0', '#70d070', '#e06060']),
  make('msdos', 'MS-DOS', 'Terminals', 'ibm', ['#000000', '#0000aa', '#0000aa', '#3a3aff', '#c0c0c0', '#808080', '#ffff55', '#55ffff', '#55ff55', '#ff5555'], { fx: 'glow' }),

  // ------------------------------------------------------ Games & Consoles
  make('gameboy', 'Game Boy', 'Games & Consoles', 'silk', ['#0f380f', '#306230', '#306230', '#8bac0f', '#9bbc0f', '#8bac0f', '#9bbc0f', '#9bbc0f', '#9bbc0f', '#9bbc0f'], { fx: 'glow' }),
  make('gameboy-pocket', 'Game Boy Pocket', 'Games & Consoles', 'silk', ['#0a0a0a', '#1a1a1a', '#262626', '#4a4a4a', '#c8c8c8', '#8a8a8a', '#c8c8c8', '#c8c8c8', '#c8c8c8', '#c8c8c8']),
  make('gameboy-color', 'Game Boy Color', 'Games & Consoles', 'silk', ['#101820', '#203040', '#284860', '#4a6880', '#e0e8f0', '#8898a8', '#ffb040', '#58c8e0', '#58e080', '#ff6080'], { fx: 'pulse' }),
  make('pico8', 'PICO-8', 'Games & Consoles', 'silk', ['#000000', '#1d2b53', '#273561', '#5f574f', '#fff1e8', '#c2c3c7', '#ffa300', '#29adff', '#00e436', '#ff004d']),
  make('nes', 'NES', 'Games & Consoles', 'pixel', ['#2a2a2a', '#3a3a3a', '#484848', '#707070', '#f0f0f0', '#a0a0a0', '#e0c060', '#60c0e0', '#70d070', '#e06060'], { size: 10 }),
  make('snes', 'SNES', 'Games & Consoles', 'pixel', ['#1e1a2e', '#2c2844', '#3a3458', '#5a5478', '#e8e4f4', '#9890b8', '#f0c060', '#68c8e8', '#78d898', '#e87878'], { size: 10, fx: 'pulse' }),
  make('virtual-boy', 'Virtual Boy', 'Games & Consoles', 'silk', ['#0a0000', '#1a0000', '#260000', '#4a0000', '#ff5050', '#c04040', '#ff8060', '#ff7060', '#ff5050', '#ff3030'], { fx: 'glow' }),
  make('atari', 'Atari 2600', 'Games & Consoles', 'pixel', ['#101010', '#1c1c1c', '#282828', '#4a4a4a', '#ffa820', '#c08030', '#ffa820', '#ffb860', '#ffa820', '#ff6a40'], { size: 10, fx: 'glow' }),
  make('c64', 'Commodore 64', 'Games & Consoles', 'vt323', ['#4040c0', '#3434a0', '#2c2c8c', '#6060d0', '#c0c0f0', '#8888c0', '#e0d060', '#78d0e0', '#78d890', '#e07878'], { size: 15, fx: 'pulse' }),
  make('doom', 'DOOM', 'Games & Consoles', 'sharetech', ['#100804', '#1c0e06', '#281408', '#4a2410', '#ffb060', '#c08050', '#ff9040', '#ffc080', '#80c040', '#e04020'], { fx: 'glow' }),
  make('apple2', 'Apple II', 'Games & Consoles', 'vt323', ['#000000', '#0a0f0a', '#142014', '#1e3a1e', '#a0ffb0', '#58a068', '#e0ff80', '#78ffd0', '#a0ffb0', '#ff8070'], { size: 16, fx: 'glow' }),

  // ----------------------------------------------------------- Movies & TV
  make('tos', 'Star Trek: TOS', 'Movies & TV', 'orbitron', ['#0a1020', '#14203c', '#1e2c50', '#3c4a78', '#e8f0ff', '#88a0d0', '#f0c040', '#58b8e8', '#70d8a0', '#e05858'], { fx: 'glow' }),
  make('tng', 'Star Trek: TNG', 'Movies & TV', 'orbitron', ['#101010', '#1a1a1a', '#242424', '#3a3a3a', '#e0dcc8', '#908c78', '#40c0f0', '#58b8d8', '#70c898', '#d06858'], { fx: 'pulse' }),
  make('matrix', 'Matrix', 'Movies & TV', 'sharetech', ['#000000', '#031a03', '#062d06', '#0e4a0e', '#00ff41', '#3e9a4e', '#8dffa0', '#5effc9', '#00ff41', '#ff4040'], { fx: 'glow' }),
  make('bladerunner', 'Blade Runner', 'Movies & TV', 'orbitron', ['#0a0804', '#14100a', '#1e1810', '#3a2a18', '#ffb860', '#c09050', '#ffd080', '#58c8e0', '#80c8a0', '#e06040'], { fx: 'glow' }),
  make('alien', 'Alien', 'Movies & TV', 'elite', ['#080a06', '#10130a', '#161c0e', '#263018', '#c8e0a0', '#7a9860', '#d0b860', '#88c8c0', '#98d070', '#e06850'], { fx: 'pulse' }),
  make('who', 'Doctor Who', 'Movies & TV', 'orbitron', ['#050a18', '#0a1430', '#101e48', '#203c78', '#b8d8ff', '#6890c0', '#f0c060', '#68c0e8', '#70d8b0', '#e07070'], { fx: 'pulse' }),
  make('dune', 'Dune', 'Movies & TV', 'cinzel', ['#180c04', '#241408', '#301c0c', '#50301a', '#f0d8b0', '#b89060', '#ffc060', '#e0a060', '#c0a060', '#d07040'], { fx: 'glow' }),
  make('odyssey', '2001: A Space Odyssey', 'Movies & TV', 'space', ['#0a0a0e', '#141420', '#1e1e30', '#34344e', '#f0f0f8', '#9090b0', '#f0c060', '#78c8e8', '#80d8b0', '#e06050'], { fx: 'pulse' }),
  make('tron', 'TRON', 'Movies & TV', 'audiowide', ['#020408', '#06121c', '#0a1c2c', '#16384e', '#c8f0ff', '#5a9cc8', '#ffe080', '#40d8ff', '#50e0b8', '#ff6080'], { fx: 'glow' }),

  // ---------------------------------------------------- Music & Aesthetics
  make('whitestripes', 'The White Stripes', 'Music & Aesthetics', 'bebas', ['#100000', '#1c0000', '#260000', '#4a0000', '#f0e8e8', '#c08080', '#e04040', '#e05858', '#a02020', '#e04040'], { size: 14, fx: 'pulse' }),
  make('synthwave', 'Synthwave', 'Music & Aesthetics', 'audiowide', ['#0e0020', '#1a0033', '#260047', '#54239c', '#f0e3ff', '#a581d4', '#ffd166', '#4dd6ff', '#7dffc8', '#ff4d6d'], { fx: 'glow' }),
  make('vaporwave', 'Vaporwave', 'Music & Aesthetics', 'monoton', ['#0a0a1e', '#14142e', '#1e1e40', '#3a3a6a', '#ff9ad8', '#b06ad0', '#ffd166', '#66e0ff', '#7dffc8', '#ff6ab0'], { size: 14, fx: 'pulse' }),
  make('cyberpunk', 'Cyberpunk 2077', 'Music & Aesthetics', 'audiowide', ['#0a0a04', '#141408', '#1e1e0c', '#3a3a18', '#f0f0b0', '#a0a060', '#ffe020', '#20e0e0', '#20e080', '#e02040'], { fx: 'glow' }),
  make('rgb', 'RGB Rave', 'Music & Aesthetics', 'jetbrains', ['#08080f', '#10101c', '#171728', '#2c2c4a', '#ff4dd6', '#b39bff', '#ffd166', '#00f0ff', '#4dff88', '#ff3b5c'], { fx: 'rgb' }),

  // ---------------------------------------------------------- Color Schemes
  make('solarized', 'Solarized', 'Color Schemes', 'fira', ['#002b36', '#073642', '#08404e', '#586e75', '#eee8d5', '#93a1a1', '#b58900', '#2aa198', '#859900', '#dc322f']),
  make('dracula', 'Dracula', 'Color Schemes', 'fira', ['#282a36', '#343746', '#3f4356', '#5b6070', '#f8f8f2', '#8a8fa0', '#f1fa8c', '#8be9fd', '#50fa7b', '#ff5555'], { fx: 'glow' }),
  make('nord', 'Nord', 'Color Schemes', 'jetbrains', ['#2e3440', '#3b4252', '#434c5e', '#4c566a', '#eceff4', '#a0a8b8', '#ebcb8b', '#88c0d0', '#a3be8c', '#bf616a']),
  make('gruvbox', 'Gruvbox', 'Color Schemes', 'fira', ['#282828', '#32302f', '#3c3836', '#665c54', '#ebdbb2', '#a89984', '#fabd2f', '#83a598', '#b8bb26', '#fb4934'], { fx: 'glow' }),
  make('monokai', 'Monokai', 'Color Schemes', 'fira', ['#272822', '#34342e', '#3e3e36', '#555548', '#f8f8f2', '#a0a090', '#fd971f', '#66d9ef', '#a6e22e', '#f92672'], { fx: 'pulse' }),
  make('tokyo-night', 'Tokyo Night', 'Color Schemes', 'jetbrains', ['#1a1b26', '#24283b', '#2c3150', '#414868', '#c0caf5', '#7a88b8', '#e0af68', '#7dcfff', '#9ece6a', '#f7768e'], { fx: 'glow' }),
  make('catppuccin', 'Catppuccin', 'Color Schemes', 'space', ['#1e1e2e', '#27273a', '#313244', '#45475a', '#cdd6f4', '#7f849c', '#f9e2af', '#89dceb', '#a6e3a1', '#f38ba8']),
  make('high-contrast', 'High Contrast', 'Color Schemes', 'ibm', ['#000000', '#000000', '#0a0a0a', '#ffffff', '#ffffff', '#c0c0c0', '#ffff00', '#00ffff', '#00ff00', '#ff0000']),
  make('paper', 'Paper', 'Color Schemes', 'space', ['#f4f1ea', '#ffffff', '#eae6de', '#c8c2b8', '#2a2a28', '#6a6860', '#b08020', '#2070b0', '#309060', '#c03030']),

  // ---------------------------------------------------------- Nature & Time
  make('chrono', 'Time of Day', 'Nature & Time', 'jetbrains', ['#050816', '#0c1224', '#121b33', '#1f2a4a', '#c8d4f0', '#6a7aa8', '#ffd166', '#7fd6ff', '#6ee7a8', '#ff6b6b'], { dynamic: true }),
  make('aurora', 'Aurora', 'Nature & Time', 'space', ['#04081a', '#0a1230', '#101c48', '#203060', '#d8fff0', '#78c8c0', '#f0e060', '#78d8ff', '#78f0b8', '#ff70a0'], { fx: 'glow' }),
  make('ocean', 'Ocean', 'Nature & Time', 'space', ['#020814', '#061020', '#0a1830', '#183050', '#c8e8ff', '#6898c8', '#f0d060', '#68c8ff', '#70d8c8', '#ff7080'], { fx: 'pulse' }),
  make('desert', 'Desert', 'Nature & Time', 'cinzel', ['#180e04', '#241608', '#301e0a', '#50341a', '#f0d8b0', '#b89060', '#ffb060', '#e0c060', '#b0c060', '#d06840'], { fx: 'glow' }),
  make('sakura', 'Cherry Blossom', 'Nature & Time', 'space', ['#1a0a14', '#28101e', '#38162a', '#582a44', '#ffe8f0', '#c888a8', '#ffd080', '#88d8e8', '#a0e0b0', '#e07890'], { fx: 'pulse' }),
  make('forest', 'Forest', 'Nature & Time', 'sharetech', ['#060f08', '#0a1a0e', '#0e2614', '#1e4a2a', '#c8e8d0', '#70a080', '#d8c860', '#78c8c0', '#88d890', '#d07050'], { fx: 'glow' }),
  make('coffee', 'Coffee', 'Nature & Time', 'elite', ['#1a100a', '#241810', '#2e2012', '#503a24', '#f0d8c0', '#a08060', '#d8a860', '#c09070', '#b09070', '#c06040']),

  // -------------------------------------------------------- Systems & Brands
  make('win95', 'Windows 95', 'Systems & Brands', 'space', ['#008080', '#c0c0c0', '#c8c8c8', '#808080', '#000000', '#404040', '#800000', '#000080', '#008000', '#800000']),
  make('amiga', 'Amiga Workbench', 'Systems & Brands', 'sharetech', ['#0a0a20', '#141430', '#1e1e42', '#343468', '#e0e0f0', '#8888b0', '#e0a040', '#40b8e0', '#60d080', '#e06060'], { fx: 'pulse' }),
];

export const DEFAULT_THEME = 'snes';

const THEME_KEY = 'towers.theme';

/** A palette that follows the wall clock: night, dawn, day, dusk. */
function chronoVars(hour) {
  if (hour >= 5 && hour < 9) {
    return vars('#150a1e', '#24132f', '#311b42', '#4a2a5e', '#f2dcff', '#a88ac8', '#ffc96b', '#8fd4ff', '#7de8b0', '#ff7a88');
  }
  if (hour >= 9 && hour < 17) {
    return vars('#0b1420', '#13222f', '#1b2d3e', '#2a4458', '#e8f2ff', '#8aa8c0', '#ffd166', '#7fd6ff', '#6ee7a8', '#ff6b6b');
  }
  if (hour >= 17 && hour < 21) {
    return vars('#160d18', '#261722', '#34202e', '#4a2e42', '#ffe2ec', '#b08aa0', '#ffcf8a', '#9bd8ff', '#8ae8b8', '#ff7d88');
  }
  return vars('#050816', '#0c1224', '#121b33', '#1f2a4a', '#c8d4f0', '#6a7aa8', '#ffd166', '#7fd6ff', '#6ee7a8', '#ff6b6b');
}

/**
 * Apply a theme's palette to the document root and flip its behaviour classes.
 *
 * @returns {object} the resolved theme (with `id` and `name`).
 */
export function applyTheme(id) {
  const theme = THEMES.find((t) => t.id === id) ?? THEMES.find((t) => t.id === DEFAULT_THEME);
  const palette = theme.dynamic ? chronoVars(new Date().getHours()) : theme.vars;

  const root = document.documentElement;
  for (const [key, value] of Object.entries(palette)) root.style.setProperty(key, value);
  root.style.setProperty('--font', FONTS[theme.font] ?? FONTS.jetbrains);
  root.style.setProperty('--font-size', `${theme.size ?? 13}px`);
  root.dataset.theme = theme.id;

  const fxClass = theme.fx ? `theme-${theme.fx}` : null;
  for (const cls of ['theme-glow', 'theme-pulse', 'theme-rgb']) {
    document.body.classList.toggle(cls, cls === fxClass);
  }

  startChronoClock();
  return theme;
}

export function readTheme() {
  try {
    const raw = window.localStorage.getItem(THEME_KEY);
    if (raw && THEMES.some((t) => t.id === raw)) return raw;
  } catch {
    // Private browsing.
  }
  return DEFAULT_THEME;
}

export function writeTheme(id) {
  try {
    window.localStorage.setItem(THEME_KEY, id);
  } catch {
    // Private browsing.
  }
}

let chronoTimer = null;
/** Keep the Time of Day theme fresh as the hour rolls over. */
function startChronoClock() {
  if (chronoTimer) return;
  chronoTimer = window.setInterval(() => {
    if (document.documentElement.dataset.theme === 'chrono') applyTheme('chrono');
  }, 60_000);
}
