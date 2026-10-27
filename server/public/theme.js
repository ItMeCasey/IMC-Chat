/* The themes, shared by the chat window and the player window. Order of each list: bg panel panel2 text muted accent accent2 danger line input on hover */
const THEMES = [
  { id: 'basic-dark', name: 'Basic Dark', g: 'Basic', flare: 0, v: ['#1e1f22', '#17181a', '#121315', '#e6e6e8', '#9a9da4', '#5b9cff', '#f5a742', '#ef5350', '#2e3035', '#1e1f22', '#17181a', '#2a2c30'] },
  { id: 'basic-light', name: 'Basic Light', g: 'Basic', flare: 0, v: ['#ffffff', '#f1f2f4', '#e6e8eb', '#1c1d20', '#62666e', '#2563eb', '#c2570c', '#c62828', '#d5d8dd', '#ffffff', '#ffffff', '#eceef1'] },
  { id: 'forge', name: 'Forge', g: 'Dark', v: ['#222A2A', '#1A2020', '#151b1b', '#E2DAC2', '#9aa39f', '#4FBBBC', '#F39120', '#EC4624', '#2f3938', '#222A2A', '#1A2020', '#2a3333'] },
  { id: 'midnight', name: 'Midnight', g: 'Dark', v: ['#0f1420', '#0a0e17', '#080b12', '#dfe6f5', '#8892a8', '#6aa8ff', '#ff9ecb', '#ff5c7a', '#1f2740', '#0f1420', '#0a0e17', '#18203a'] },
  { id: 'ember', name: 'Ember', g: 'Dark', v: ['#1c1210', '#140c0a', '#100907', '#f3e3d3', '#a8917f', '#ff7a3d', '#ffc857', '#e63946', '#35231d', '#1c1210', '#140c0a', '#2b1b16'] },
  { id: 'dusk', name: 'Dusk', g: 'Mid', v: ['#4a4560', '#3d3952', '#35314a', '#f2eefc', '#c0bad6', '#ffd37a', '#ff9cc2', '#ff6b6b', '#605a7c', '#3d3952', '#2f2b42', '#58526f'] },
  { id: 'slate', name: 'Slate', g: 'Mid', v: ['#5b6b73', '#4b5a62', '#41505a', '#f1f6f7', '#c3d0d4', '#9ee0d4', '#ffb26b', '#ff7a6b', '#72838c', '#4b5a62', '#34424a', '#687a83'] },
  { id: 'moss', name: 'Moss', g: 'Mid', v: ['#4d5a45', '#414d3a', '#384333', '#f1f2e2', '#c3c9b0', '#e6d38a', '#9bd1a6', '#f08a6a', '#66755c', '#414d3a', '#303a2b', '#5a684f'] },
  { id: 'cream', name: 'Cream', g: 'Light', v: ['#E2DAC2', '#d4cbb0', '#cbc2a6', '#222A2A', '#5d655f', '#17797a', '#b8620f', '#b13a22', '#b9b093', '#f1ebd8', '#f1ebd8', '#d8cfb5'] },
  { id: 'paper', name: 'Paper', g: 'Light', v: ['#fafafa', '#ececec', '#e2e2e2', '#1c1c1c', '#666666', '#2a5bd7', '#d4562a', '#c62828', '#d0d0d0', '#ffffff', '#ffffff', '#efefef'] },
  { id: 'sky', name: 'Sky', g: 'Light', v: ['#e3f0fa', '#d2e5f4', '#c6dcee', '#17314a', '#58738c', '#0a7bbd', '#c9651a', '#c0392b', '#aac7de', '#f3f9fd', '#f3f9fd', '#d9eaf6'] },
];
const themeFor = (id) => THEMES.find((x) => x.id === id) || THEMES.find((x) => x.id === 'forge');
const KEYS = ['--bg', '--panel', '--panel2', '--text', '--muted', '--accent', '--accent2', '--danger', '--line', '--input', '--on', '--hover'];

/** put a theme and font on the page; returns the theme */
function applyTheme(s) {
  const t = themeFor((s || {}).theme), r = document.documentElement.style; KEYS.forEach((k, i) => r.setProperty(k, t.v[i])); r.setProperty('--flare', t.flare === 0 ? 'none' : 'block');   // the colour stripe under the title bars; the basic themes have none
  const f = (s || {}).font || 'IMC Sans'; r.setProperty('--font', f === 'system' ? '"Segoe UI",system-ui,sans-serif' : '"' + f + '","Segoe UI",sans-serif'); return t;
}
/** follow the chat window's theme, now and whenever it changes */
function watchTheme(onTheme) {
  fetch('/api/status').then((r) => r.json()).then((st) => onTheme(applyTheme(st.settings))).catch(() => {});
  const es = new EventSource('/events'); es.addEventListener('status', (e) => { try { onTheme(applyTheme(JSON.parse(e.data).settings)); } catch (x) { /* ignore */ } });
}
