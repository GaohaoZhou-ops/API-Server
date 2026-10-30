import MarkdownIt from './vendor/markdown-it.mjs';
import hljs from './vendor/highlight.mjs';

const md = new MarkdownIt({html: false, linkify: false, typographer: false});
const escape = md.utils.escapeHtml;
export const headingSlug = text => text.trim().toLowerCase().replace(/[^\p{L}\p{N}\p{M}_\-\s]/gu, '').replace(/\s/g, '-') || 'section';
export function highlightCode(text, language = '') {
  const lang = language.trim().split(/\s+/)[0].toLowerCase(), grammar = lang === 'curl' ? 'bash' : lang;
  if (grammar && hljs.getLanguage(grammar)) {
    try { return hljs.highlight(text, {language: grammar, ignoreIllegals: true}).value; } catch { /* Escaped fallback. */ }
  }
  return escape(text);
}
md.validateLink = href => !/[\x00-\x20\\]/.test(href) && !href.startsWith('//') && (!/^[a-z][a-z\d+.-]*:/i.test(href) || /^https?:\/\//i.test(href));
function codeBlock(text, language, env) {
  const lang = language.trim().split(/\s+/)[0].toLowerCase(), index = env.codeBlocks.push(text) - 1;
  const html = `<section class="code-panel markdown-code"><div class="code-heading"><span>${escape(lang || 'text')}</span><button type="button" class="copy-button" data-copy-code="${index}">复制</button></div><pre><code class="hljs">${highlightCode(text, lang)}</code></pre></section>`;
  return lang === 'mermaid' ? `<div data-diagram-index="${env.diagrams.push(text) - 1}">${html}</div>` : html;
}
md.renderer.rules.fence = (tokens, i, options, env) => codeBlock(tokens[i].content, tokens[i].info, env);
md.renderer.rules.code_block = (tokens, i, options, env) => codeBlock(tokens[i].content, '', env);
md.renderer.rules.table_open = () => '<div class="table-scroll"><table>';
md.renderer.rules.table_close = () => '</table></div>';
md.renderer.rules.image = (tokens, i) => `<span class="snapshot-image-placeholder">${escape(tokens[i].content || '图片')} · 不加载外部图片</span>`;
md.renderer.rules.link_open = (tokens, i, options, env) => {
  const href = tokens[i].attrGet('href') || '';
  if (/^https?:\/\//i.test(href)) { env.linkTags.push('a'); return `<a href="${escape(href)}" target="_blank" rel="noopener noreferrer">`; }
  if (href.startsWith('#')) {
    const id = href.slice(1);
    env.linkTags.push('a');
    if (env.guides.some(guide => guide.id === id)) return `<a href="${escape(href)}">`;
    return `<a href="#${escape(env.current)}" data-markdown-anchor="md-${escape(headingSlug(id))}">`;
  }
  const name = href.replace(/^\.\//, '');
  const guide = env.guides.find(item => item.file === name || item.file === 'guides/' + name);
  env.linkTags.push(guide ? 'a' : 'span');
  return guide ? `<a href="#${escape(guide.id)}">` : '<span title="链接未包含在公开文档包中">';
};
md.renderer.rules.link_close = (tokens, i, options, env) => '</' + env.linkTags.pop() + '>';
export function renderMarkdown(text, {guides = [], current = ''} = {}) {
  const env = {guides, current, codeBlocks: [], diagrams: [], linkTags: []}, tokens = md.parse(text, env), used = new Map(), headings = [];
  for (let i = 0; i < tokens.length; i++) if (tokens[i].type === 'heading_open') {
    const title = tokens[i + 1].content, slug = headingSlug(title), count = used.get(slug) || 0;
    used.set(slug, count + 1); const id = 'md-' + slug + (count ? '-' + count : '');
    const level = Math.max(2, Number(tokens[i].tag.slice(1)));
    tokens[i].tag = tokens[i + 2].tag = 'h' + level; tokens[i].attrSet('id', id); headings.push({id, title, level});
  }
  return {html: md.renderer.render(tokens, md.options, env), headings, codeBlocks: env.codeBlocks, diagrams: env.diagrams};
}
