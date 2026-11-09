// Ported from app/vendor/labnoteo/src/print/texHtml.ts:1-180 sha256:74728cf341aff888
// labnoteO 0.140.2, Apache-2.0.
// Changes: none.
/**
 * The TeX a lab note's inline math holds, as printable HTML (#434). A printed
 * worksheet has no math renderer, so `$3\,mL$` used to go to paper with its
 * backslashes showing. This covers what the notes actually write — units,
 * ratios, super/subscripts and Greek letters — and refuses anything else, so a
 * formula it cannot read is printed as written rather than printed wrong.
 */
import { escapeHtml } from './printPages';

/** Commands that stand for one character. */
const TEX_SYMBOLS: Readonly<Record<string, string>> = {
  times: '×',
  cdot: '·',
  div: '÷',
  pm: '±',
  mp: '∓',
  approx: '≈',
  sim: '~',
  neq: '≠',
  leq: '≤',
  le: '≤',
  geq: '≥',
  ge: '≥',
  ll: '≪',
  gg: '≫',
  circ: '°',
  percent: '%',
  infty: '∞',
  to: '→',
  rightarrow: '→',
  leftarrow: '←',
  leftrightarrow: '↔',
  ldots: '…',
  dots: '…',
  cdots: '⋯',
  alpha: 'α',
  beta: 'β',
  gamma: 'γ',
  delta: 'δ',
  epsilon: 'ε',
  varepsilon: 'ε',
  zeta: 'ζ',
  eta: 'η',
  theta: 'θ',
  iota: 'ι',
  kappa: 'κ',
  lambda: 'λ',
  mu: 'μ',
  nu: 'ν',
  xi: 'ξ',
  pi: 'π',
  rho: 'ρ',
  sigma: 'σ',
  tau: 'τ',
  upsilon: 'υ',
  phi: 'φ',
  varphi: 'φ',
  chi: 'χ',
  psi: 'ψ',
  omega: 'ω',
  Gamma: 'Γ',
  Delta: 'Δ',
  Theta: 'Θ',
  Lambda: 'Λ',
  Xi: 'Ξ',
  Pi: 'Π',
  Sigma: 'Σ',
  Phi: 'Φ',
  Psi: 'Ψ',
  Omega: 'Ω',
};

/** Commands whose one argument is printed as the plain text it is. */
const TEX_TEXT_COMMANDS = new Set(['text', 'textrm', 'mathrm', 'mathit', 'mathbf', 'operatorname']);

/**
 * The symbols written between two values rather than beside one. A command
 * swallows the space after it, which would leave `2 \times 10` lopsided, so
 * these get that space back.
 */
const TEX_INFIX = new Set(['×', '·', '÷', '±', '∓', '≈', '≠', '≤', '≥', '≪', '≫', '→', '←', '↔']);

/** A command name, or the one character a backslash makes literal or spacing. */
const TEX_COMMAND_RE = /^\\(?:([A-Za-z]+)|([,;:!~%&#_${}]))/;

/** Where a read stopped: the HTML it produced and the index after it. */
interface TexRead {
  html: string;
  next: number;
}

/** The text of the `{...}` group at `at`, and the index past its `}`. */
function texGroup(tex: string, at: number): { body: string; next: number } | undefined {
  if (tex[at] !== '{') return undefined;
  let depth = 1;
  let end = at + 1;
  while (end < tex.length && depth > 0) {
    if (tex[end] === '{') depth++;
    else if (tex[end] === '}') depth--;
    end++;
  }
  return depth === 0 ? { body: tex.slice(at + 1, end - 1), next: end } : undefined;
}

/** One group, command or character at `at`, or undefined for TeX we do not read. */
function texToken(tex: string, at: number): TexRead | undefined {
  const ch = tex[at];
  if (ch === undefined || ch === '}' || ch === '$' || ch === '&' || ch === '^' || ch === '_') return undefined;
  if (ch === '{') {
    const group = texGroup(tex, at);
    const html = group && texToHtml(group.body);
    return group && html !== undefined ? { html, next: group.next } : undefined;
  }
  if (ch !== '\\') return { html: escapeHtml(ch), next: at + 1 };

  const command = TEX_COMMAND_RE.exec(tex.slice(at));
  if (!command) return undefined;
  const next = at + command[0].length;
  const [, name, mark] = command;
  // `\,` `\;` `\:` `\~` are the spaces between a number and its unit; `\!`
  // closes one up; the rest are punctuation a backslash makes literal.
  if (mark !== undefined) {
    return { html: ',;:~'.includes(mark) ? ' ' : mark === '!' ? '' : escapeHtml(mark), next };
  }
  if (name === 'frac') {
    const numerator = texOperand(tex, next);
    const denominator = numerator && texOperand(tex, numerator.next);
    return denominator ? { html: `${numerator!.html}/${denominator.html}`, next: denominator.next } : undefined;
  }
  if (TEX_TEXT_COMMANDS.has(name)) {
    const group = texGroup(tex, texSkipSpace(tex, next));
    return group ? { html: escapeHtml(group.body), next: group.next } : undefined;
  }
  const symbol = TEX_SYMBOLS[name];
  if (symbol === undefined) return undefined;
  // A command name runs up to the next space, which belongs to the name rather
  // than to the line: `\mu L` is one unit, µL.
  const after = texSkipSpace(tex, next);
  const spaced = after > next && TEX_INFIX.has(symbol);
  return { html: spaced ? `${symbol} ` : symbol, next: after };
}

/** The first index from `at` that is not a space. */
function texSkipSpace(tex: string, at: number): number {
  let from = at;
  while (tex[from] === ' ') from++;
  return from;
}

/** A token read as an argument, where the space before it is TeX's own padding. */
function texOperand(tex: string, at: number): TexRead | undefined {
  return texToken(tex, texSkipSpace(tex, at));
}

/**
 * `tex` as HTML, or undefined when it holds anything beyond {@link TEX_SYMBOLS},
 * `\frac`, `\text`, super/subscripts and plain characters. The HTML is ready
 * to print: its text is escaped and only `<sup>`/`<sub>` are left as tags.
 */
export function texToHtml(tex: string): string | undefined {
  let at = 0;
  let html = '';
  while (at < tex.length) {
    const ch = tex[at];
    if (ch === '^' || ch === '_') {
      const body = texOperand(tex, at + 1);
      if (!body) return undefined;
      const tag = ch === '^' ? 'sup' : 'sub';
      // `25^\circ C` is read as 25 °C: a raised degree sign is the sign itself.
      html += body.html === '°' ? '°' : `<${tag}>${body.html}</${tag}>`;
      at = body.next;
      continue;
    }
    const token = texToken(tex, at);
    if (!token) return undefined;
    html += token.html;
    at = token.next;
  }
  return html;
}
