import { Facet } from '@codemirror/state';
import { WidgetType, type EditorView } from '@codemirror/view';
import { t } from '../../i18n/t';
import type { ImageRef } from './imagePath';
import type { VaultImages } from './vaultImages';

/**
 * 보관함 이미지 위젯(계획 Task 21). `![alt](경로)` 와 `![[x.png|200]]` 자리에 그린다(inline.ts).
 * - 바이트는 확인된 IPC(vault_read_image)로 읽어 blob: URL 로 보인다: CSP 는 img-src 에 blob: 만 더 열었다.
 * - 크기는 CSSOM(`style.setProperty`)으로만 건다: style 속성을 쓰지 않는다(CSP style-src 'self').
 * - 찾지 못했거나 읽지 못했으면 span.lno-image-missing. 바깥 주소(http:)는 읽지 않고 대체 글을 그린다.
 * - 위젯 DOM 은 `span` 하나로 감싼다: 늦게 실패해도 감싼 것 안에서 img 를 글로 바꿀 수 있다(CodeMirror 가 쥔 바깥 DOM 은 그대로).
 */

export interface ImageLoaderConfig {
  notePath: string;
  images: VaultImages;
}

/** 편집기의 노트 경로와 이미지 묶음. Editor.tsx 가 vaultImages 로 채운다. 없으면 이미지는 모두 "찾을 수 없음" 이다. */
export const imageLoader = Facet.define<ImageLoaderConfig, ImageLoaderConfig | undefined>({ combine: (v) => v[0] });

type Size = { width: number; height?: number } | null;

const sameRef = (a: ImageRef, b: ImageRef) =>
  a.kind === 'name' ? b.kind === 'name' && a.name === b.name : b.kind === 'paths' && a.candidates.join('\n') === b.candidates.join('\n');

/** DOM 마다의 상태: 쥔 캐시 경로, 부서졌는가, 바뀜 구독 해제. */
interface Live {
  held: string | null;
  destroyed: boolean;
  generation: number;
  unsubscribe?: () => void;
  images?: VaultImages;
}

const lives = new WeakMap<HTMLElement, Live>();

export class ImageWidget extends WidgetType {
  constructor(
    readonly ref: ImageRef,
    readonly alt: string,
    readonly size: Size,
  ) {
    super();
  }

  eq(o: ImageWidget): boolean {
    return sameRef(this.ref, o.ref) && this.alt === o.alt && this.size?.width === o.size?.width && this.size?.height === o.size?.height;
  }

  /** 찾지 못했을 때 보일 글. 바깥 주소·거른 경로(후보 없음)는 대체 글을 그대로 보인다. */
  private missingText(): string {
    const label = this.ref.kind === 'name' ? this.ref.name : this.ref.candidates[this.ref.candidates.length - 1];
    return label === undefined ? this.alt : t('live.image.missing', label);
  }

  private missing(wrap: HTMLElement) {
    const span = document.createElement('span');
    span.className = 'lno-image-missing';
    span.textContent = this.missingText();
    span.title = span.textContent;
    wrap.replaceChildren(span);
  }

  toDOM(view: EditorView): HTMLElement {
    const wrap = document.createElement('span');
    wrap.className = 'lno-image-wrap';
    const config = view.state.facet(imageLoader);
    const nothing = this.ref.kind === 'paths' && this.ref.candidates.length === 0;
    if (!config || nothing) {
      this.missing(wrap);
      return wrap;
    }
    const img = document.createElement('img');
    img.className = 'lno-image';
    img.alt = this.alt;
    img.decoding = 'async';
    if (this.size) {
      img.style.setProperty('width', `${this.size.width}px`);
      if (this.size.height !== undefined) img.style.setProperty('height', `${this.size.height}px`);
    }
    img.onload = () => view.requestMeasure();
    img.onerror = () => {
      if (wrap.contains(img)) this.missing(wrap);
    };
    wrap.appendChild(img);
    const live: Live = { held: null, destroyed: false, generation: 0, images: config.images };
    lives.set(wrap, live);
    const load = () => void this.load(config, wrap, img, live);
    live.unsubscribe = config.images.subscribe?.(load);
    load();
    return wrap;
  }

  /** 경로를 찾고(이름이면 색인, 아니면 후보 차례로) 캐시에서 URL 을 얻어 건다. 바뀜 알림마다 다시 돈다. */
  private async load(config: ImageLoaderConfig, wrap: HTMLElement, img: HTMLImageElement, live: Live) {
    const gen = ++live.generation;
    const { cache, index } = config.images;
    const stale = () => live.destroyed || gen !== live.generation;
    const candidates = this.ref.kind === 'name' ? [await index.find(config.notePath, this.ref.name).catch(() => null)] : this.ref.candidates;
    for (const path of candidates) {
      if (stale()) return;
      if (path === null) break;
      let url: string;
      try {
        url = await cache.url(path);
      } catch {
        continue;
      }
      if (stale()) {
        cache.release(path);
        return;
      }
      const prev = live.held;
      live.held = path;
      if (prev !== null) cache.release(prev);
      if (!wrap.contains(img)) wrap.replaceChildren(img);
      if (img.getAttribute('src') !== url) img.src = url;
      return;
    }
    if (stale()) return;
    if (live.held !== null) cache.release(live.held);
    live.held = null;
    this.missing(wrap);
  }

  destroy(dom: HTMLElement): void {
    const live = lives.get(dom);
    if (!live) return;
    live.destroyed = true;
    live.unsubscribe?.();
    if (live.held !== null) live.images?.cache.release(live.held);
    live.held = null;
    lives.delete(dom);
  }
}
