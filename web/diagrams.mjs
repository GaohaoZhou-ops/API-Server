import dagre from './vendor/dagre.mjs';

// Accept the basic flowchart notation used in the snapshots. Unknown syntax is
// left as source text, never interpreted as HTML, links or Mermaid directives.
export function parseFlowchart(source) {
  if (source.length > 32000) throw new Error('图表过大');
  const lines = source.trim().split(/\r?\n/).map(s => s.trim()).filter(s => s && !s.startsWith('%% '));
  const header = lines.shift()?.match(/^(?:flowchart|graph)\s+(TD|TB|LR|RL|BT)\s*;?$/);
  if (!header) throw new Error('不支持的图表类型');
  const nodes = new Map(), edges = [];
  const nodePattern = String.raw`([A-Za-z_][\w-]*)(?:\["([^"\n]+)"\]|\[([^\]\n]+)\])?`;
  const edgePattern = new RegExp(`^${nodePattern}\\s*-->\\s*(?:\\|"([^"\\n]+)"\\||\\|([^|\\n]+)\\|)?\\s*${nodePattern}\\s*;?$`);
  const singlePattern = new RegExp(`^${nodePattern}\\s*;?$`);
  function node(id, label) {
    if (['__proto__', 'constructor', 'prototype', 'click', 'style', 'classDef', 'end', 'subgraph'].includes(id)) throw new Error('不支持的节点');
    if (!nodes.has(id)) nodes.set(id, {id, title: id});
    if (label) nodes.get(id).title = label.replace(/\\n/g, '\n');
    return id;
  }
  for (const line of lines) {
    const edge = line.match(edgePattern);
    if (edge) edges.push({from: node(edge[1], edge[2] || edge[3]), to: node(edge[6], edge[7] || edge[8]), label: edge[4] || edge[5] || ''});
    else {
      const single = line.match(singlePattern);
      if (!single) throw new Error('不支持的流程图语法');
      node(single[1], single[2] || single[3]);
    }
  }
  if (!nodes.size || nodes.size > 100 || edges.length > 200) throw new Error('不支持的图表大小');
  return {direction: header[1] === 'TD' ? 'TB' : header[1], nodes: [...nodes.values()], edges};
}

export function normalizeDiagram(data) {
  const nodes = data.nodes.map((n, i) => typeof n === 'string' ? {id: String(i), title: n} : {...n});
  if (!nodes.length || nodes.length > 100 || new Set(nodes.map(n => n.id)).size !== nodes.length) throw new Error('图表节点无效');
  const edges = data.edges || nodes.slice(1).map((n, i) => ({from: nodes[i].id, to: n.id}));
  if (edges.length > 200 || edges.some(e => !nodes.some(n => n.id === e.from) || !nodes.some(n => n.id === e.to))) throw new Error('图表连线无效');
  return {...data, nodes, edges};
}

const approximateWidth = (text, size) => [...text].reduce((n, c) => n + (c.codePointAt(0) > 255 ? size : size * .58), 0);
export function wrapLabel(text, width, size, measure = approximateWidth) {
  const lines = [];
  for (const paragraph of String(text || '').split('\n')) {
    let line = '';
    for (const token of paragraph.match(/[A-Za-z0-9_./{}-]+|[^\S\n]+|./gu) || ['']) {
      if (line && measure(line + token, size) > width) { lines.push(line.trim()); line = ''; }
      for (const char of token) {
        if (line && measure(line + char, size) > width) { lines.push(line.trim()); line = ''; }
        line += char;
      }
    }
    if (line.trim()) lines.push(line.trim());
  }
  return lines;
}

export function layoutDiagram(input, {direction, compact = false, measure} = {}) {
  const data = normalizeDiagram(input), graph = new dagre.graphlib.Graph({multigraph: true});
  graph.setGraph({rankdir: direction || data.direction || 'TB', nodesep: 32, ranksep: 36, edgesep: 20, marginx: 24, marginy: 22});
  const nodeWidth = compact ? 164 : 236;
  for (const node of data.nodes) {
    const titleLines = wrapLabel(node.title, nodeWidth - 32, 14, measure);
    const detailLines = wrapLabel(node.detail, nodeWidth - 32, 12, measure);
    const height = Math.max(64, 26 + titleLines.length * 21 + (detailLines.length ? 7 + detailLines.length * 18 : 0));
    graph.setNode(node.id, {...node, titleLines, detailLines, width: nodeWidth, height});
  }
  data.edges.forEach((edge, i) => {
    const lines = wrapLabel(edge.label, compact ? 140 : 192, 11, measure);
    const width = lines.length ? Math.max(...lines.map(line => (measure || approximateWidth)(line, 11))) + 16 : 0;
    graph.setEdge(edge.from, edge.to, {...edge, lines, width, height: lines.length ? lines.length * 17 + 8 : 0, labelpos: 'c'}, String(i));
  });
  dagre.layout(graph);
  return {...data, width: graph.graph().width, height: graph.graph().height,
    nodes: graph.nodes().map(id => graph.node(id)), edges: graph.edges().map(edge => graph.edge(edge))};
}

const NS = 'http://www.w3.org/2000/svg';
let diagramId = 0;
const cleanups = new Set();
export function disposeDiagrams() { for (const cleanup of cleanups) cleanup(); cleanups.clear(); }
function element(tag, text, className) {
  const el = document.createElement(tag); if (text !== undefined) el.textContent = text; if (className) el.className = className; return el;
}
function svgElement(tag, attrs = {}, text) {
  const el = document.createElementNS(NS, tag);
  for (const [name, value] of Object.entries(attrs)) el.setAttribute(name, value);
  if (text !== undefined) el.textContent = text;
  return el;
}
function draw(data, title) {
  const id = 'flow-' + ++diagramId;
  const svg = svgElement('svg', {viewBox: `0 0 ${data.width} ${data.height}`, role: 'img', 'aria-labelledby': id + '-title', class: 'diagram-svg'});
  svg.append(svgElement('title', {id: id + '-title'}, title));
  const defs = svgElement('defs'), marker = svgElement('marker', {id: id + '-arrow', viewBox: '0 0 10 10', refX: 9, refY: 5, markerWidth: 7, markerHeight: 7, orient: 'auto-start-reverse'});
  marker.append(svgElement('path', {d: 'M 0 0 L 10 5 L 0 10 z', class: 'diagram-arrow'})); defs.append(marker); svg.append(defs);
  for (const edge of data.edges) {
    const g = svgElement('g', {class: 'diagram-edge' + (edge.dashed ? ' diagram-feedback' : ''), 'data-from': edge.from, 'data-to': edge.to});
    const d = edge.points.map((p, i) => `${i ? 'L' : 'M'} ${p.x} ${p.y}`).join(' ');
    g.append(svgElement('path', {d, 'marker-end': `url(#${id}-arrow)`}));
    if (edge.lines.length) {
      g.append(svgElement('rect', {x: edge.x - edge.width / 2, y: edge.y - edge.height / 2, width: edge.width, height: edge.height, rx: 5}));
      edge.lines.forEach((line, i) => g.append(svgElement('text', {x: edge.x, y: edge.y - (edge.lines.length - 1) * 8.5 + i * 17, 'dominant-baseline': 'central'}, line)));
    }
    svg.append(g);
  }
  for (const node of data.nodes) {
    const kind = ['start', 'end', 'gate'].includes(node.kind) ? node.kind : 'step';
    const g = svgElement('g', {class: 'diagram-node diagram-' + kind, 'data-node': node.id, transform: `translate(${node.x - node.width / 2} ${node.y - node.height / 2})`});
    g.append(svgElement('title', {}, [node.title, node.detail].filter(Boolean).join(' · ')));
    g.append(svgElement('rect', {width: node.width, height: node.height, rx: 10}));
    const textHeight = node.titleLines.length * 21 + (node.detailLines.length ? 7 + node.detailLines.length * 18 : 0);
    const baseline = (node.height - textHeight) / 2 + 16;
    node.titleLines.forEach((line, i) => g.append(svgElement('text', {x: node.width / 2, y: baseline + i * 21, class: 'diagram-node-title'}, line)));
    node.detailLines.forEach((line, i) => g.append(svgElement('text', {x: node.width / 2, y: baseline + node.titleLines.length * 21 + i * 18 + 4, class: 'diagram-node-detail'}, line)));
    svg.append(g);
    g.addEventListener('pointerenter', () => {
      const connected = new Set([node.id]);
      for (const edge of data.edges) if (edge.from === node.id || edge.to === node.id) { connected.add(edge.from); connected.add(edge.to); }
      svg.querySelectorAll('.diagram-node').forEach(el => el.classList.toggle('is-related', connected.has(el.dataset.node)));
      svg.querySelectorAll('.diagram-edge').forEach(el => el.classList.toggle('is-related', el.dataset.from === node.id || el.dataset.to === node.id));
    });
    g.addEventListener('pointerleave', () => svg.querySelectorAll('.is-related').forEach(el => el.classList.remove('is-related')));
  }
  return svg;
}

export function createDiagram(input, {title = '流程图', source = '', onCopy, expanded = false} = {}) {
  const data = normalizeDiagram(input), figure = element('figure', undefined, 'diagram-card');
  const header = element('div', undefined, 'diagram-header');
  header.append(element('strong', title), element('span', data.edges.some(e => e.dashed) ? '虚线为状态回传' : data.nodes.length + ' 个节点', 'diagram-meta'));
  const tools = element('div', undefined, 'diagram-tools'); tools.setAttribute('role', 'group'); tools.setAttribute('aria-label', '图表显示');
  const viewport = element('div', undefined, 'diagram-viewport'); viewport.tabIndex = 0; viewport.setAttribute('role', 'region'); viewport.setAttribute('aria-label', title + '，可滚动查看');
  const canvas = document.createElement('canvas').getContext('2d');
  const font = getComputedStyle(document.body).fontFamily;
  const measure = (text, size) => { canvas.font = `${size}px ${font}`; return canvas.measureText(text).width; };
  let layout, svg, scale = 1, fitting = false, lastWidth = 0;
  const percentage = element('output', '100%', 'diagram-scale'); percentage.setAttribute('aria-label', '图表缩放比例');
  function button(text, label, action) { const b = element('button', text); b.type = 'button'; b.setAttribute('aria-label', label); b.onclick = action; tools.append(b); return b; }
  function zoom(next) {
    const old = scale, centerX = viewport.scrollLeft + viewport.clientWidth / 2, centerY = viewport.scrollTop + viewport.clientHeight / 2;
    scale = Math.min(2.5, Math.max(.15, next));
    svg.setAttribute('width', Math.ceil(layout.width * scale)); svg.setAttribute('height', Math.ceil(layout.height * scale));
    percentage.textContent = Math.round(scale * 100) + '%';
    minus.disabled = scale <= .15; plus.disabled = scale >= 2.5;
    viewport.scrollLeft = centerX * scale / old - viewport.clientWidth / 2;
    viewport.scrollTop = centerY * scale / old - viewport.clientHeight / 2;
    hint.hidden = layout.width * scale <= viewport.clientWidth && layout.height * scale <= viewport.clientHeight;
  }
  const minus = button('−', '缩小图表', () => { fitting = false; zoom(scale / 1.25); });
  tools.append(percentage);
  const plus = button('＋', '放大图表', () => { fitting = false; zoom(scale * 1.25); });
  button('适应宽度', '适应图表宽度', () => { fitting = true; zoom(Math.min(1, (viewport.clientWidth - 24) / layout.width)); viewport.scrollLeft = viewport.scrollTop = 0; });
  button('100%', '按原始大小显示图表', () => { fitting = false; zoom(1); });
  if (!expanded) button('放大查看 ↗', '放大查看' + title, () => {
    const dialog = element('dialog', undefined, 'diagram-dialog'); dialog.setAttribute('aria-label', title + '大图');
    const top = element('div', undefined, 'diagram-dialog-heading'), close = element('button', '关闭 ×'); close.type = 'button'; close.setAttribute('aria-label', '关闭图表');
    top.append(element('strong', title), close); dialog.append(top);
    const large = createDiagram(data, {title, source, onCopy, expanded: true}); dialog.append(large); document.body.append(dialog);
    close.onclick = () => dialog.close(); dialog.onclose = () => { large.dispose(); dialog.remove(); };
    dialog.showModal(); close.focus();
  });
  figure.append(header, tools, viewport);
  const foot = element('figcaption');
  foot.append(element('span', data.caption || '沿箭头阅读节点关系；复杂图可放大查看。'));
  const hint = element('span', '拖动或滚动查看完整图表', 'diagram-scroll-hint'); foot.append(hint); figure.append(foot);
  const textView = element('details', undefined, 'diagram-text'); textView.append(element('summary', '文字说明'));
  const list = element('ul');
  for (const edge of data.edges) {
    const from = data.nodes.find(n => n.id === edge.from), to = data.nodes.find(n => n.id === edge.to);
    list.append(element('li', from.title + ' → ' + to.title + (edge.label ? '（' + edge.label + '）' : '')));
  }
  textView.append(list); figure.append(textView);
  if (source) {
    const raw = element('details', undefined, 'diagram-source'); raw.append(element('summary', '图表定义'));
    const panel = element('div', undefined, 'code-panel'), heading = element('div', undefined, 'code-heading'); heading.append(element('span', 'mermaid'));
    if (onCopy) { const b = element('button', '复制', 'copy-button'); b.type = 'button'; b.setAttribute('aria-label', '复制图表定义'); b.onclick = () => onCopy(source); heading.append(b); }
    const pre = element('pre'); pre.append(element('code', source)); panel.append(heading, pre); raw.append(panel); figure.append(raw);
  }
  function refresh() {
    if (!figure.isConnected || !viewport.clientWidth || lastWidth === viewport.clientWidth) return;
    lastWidth = viewport.clientWidth;
    const options = {measure};
    // Straight, short flows read left-to-right when every label fits at full size.
    if (!data.direction && data.nodes.length <= 5 && data.edges.length === data.nodes.length - 1) {
      const horizontal = layoutDiagram(data, {measure, direction: 'LR', compact: true});
      layout = horizontal.width <= viewport.clientWidth - 24 ? horizontal : layoutDiagram(data, options);
    } else layout = layoutDiagram(data, options);
    svg = draw(layout, title); viewport.replaceChildren(svg);
    const fit = Math.min(1, (viewport.clientWidth - 24) / layout.width);
    zoom(fitting ? fit : Math.max(.9, fit)); viewport.scrollLeft = viewport.scrollTop = 0;
    hint.hidden = layout.width * scale <= viewport.clientWidth && layout.height * scale <= viewport.clientHeight;
  }
  // Mouse dragging supplements native touch/trackpad scrolling and keyboard access.
  let drag;
  viewport.addEventListener('pointerdown', ev => {
    if (ev.pointerType !== 'mouse' || ev.button !== 0) return;
    drag = {x: ev.clientX, y: ev.clientY, left: viewport.scrollLeft, top: viewport.scrollTop}; viewport.setPointerCapture(ev.pointerId);
  });
  viewport.addEventListener('pointermove', ev => { if (drag) { viewport.scrollLeft = drag.left - ev.clientX + drag.x; viewport.scrollTop = drag.top - ev.clientY + drag.y; } });
  for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) viewport.addEventListener(type, () => { drag = null; });
  const observer = new ResizeObserver(refresh); observer.observe(viewport);
  const cleanup = () => { observer.disconnect(); cleanups.delete(cleanup); figure.closest('dialog')?.close(); };
  figure.dispose = cleanup; cleanups.add(cleanup);
  document.fonts.ready.then(() => { if (figure.isConnected) { lastWidth = 0; refresh(); } });
  return figure;
}
