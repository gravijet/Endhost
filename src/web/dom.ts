// The smallest DOM helper that keeps the rest readable.

type Attrs = Record<string, string | number | boolean | EventListener | undefined>;
type Child = Node | string | null | undefined | false;

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Attrs = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === false) continue;
    if (k === 'class') node.className = String(v);
    else if (k === 'html') node.innerHTML = String(v);
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2).toLowerCase(), v as EventListener);
    else if (v === true) node.setAttribute(k, '');
    else node.setAttribute(k, String(v));
  }
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return node;
}

export const $ = <T extends Element = HTMLElement>(sel: string, root: ParentNode = document): T | null =>
  root.querySelector<T>(sel);

export function clear(node: Element): void {
  while (node.firstChild) node.removeChild(node.firstChild);
}

export function toast(msg: string, kind: '' | 'err' = ''): void {
  let t = document.querySelector('.toast') as HTMLElement | null;
  if (!t) {
    t = el('div', { class: 'toast entry' });
    document.body.append(t);
  }
  t.className = `toast entry ${kind}`;
  t.textContent = msg;
  requestAnimationFrame(() => t!.classList.add('show'));
  clearTimeout((t as any)._h);
  (t as any)._h = setTimeout(() => t!.classList.remove('show'), 2600);
}
