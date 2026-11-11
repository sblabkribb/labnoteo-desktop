// @vitest-environment jsdom
/** 설정 → 어시스턴트의 대화 기록 줄(plan Task 10): 기록이 있는 실험 수와 "모든 기록 지우기"(확인 후). */
import { act, cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { setLang } from '../../i18n/lang';
import { ExternalAssistantsRow, HistoryRow, SkinRow, WebSearchKeyRow, WebSearchRow, type WebSearchRowDeps } from '../settings/AssistantPage';
import { secretStatusOf } from '../../integrations/__tests__/fakeNet';
import type { SkinManifest } from '../../assistant/skins/types';
import { BUILTIN_SKIN } from '../../assistant/skins/builtin';

afterEach(() => {
  cleanup();
  setLang('ko');
});

const settle = () => act(async () => new Promise((r) => setTimeout(r, 0)));

function setup(opts: { confirm?: boolean; folders?: number } = {}) {
  let folders = opts.folders ?? 3;
  const deps = {
    stats: vi.fn(async () => ({ folders, bytes: 10 })),
    clearAll: vi.fn(async () => {
      const n = folders;
      folders = 0;
      return n;
    }),
    confirm: vi.fn(async () => opts.confirm ?? true),
    onCleared: vi.fn(),
    notify: vi.fn(),
  };
  render(<HistoryRow {...deps} />);
  return deps;
}

describe('Assistant pane: chat history row', () => {
  it('shows how many experiments have chat and that it stays out of the vault', async () => {
    setup();
    await settle();
    const row = screen.getByRole('group', { name: '대화 기록' });
    expect(row.textContent).toContain('기록이 있는 실험: 3개');
    expect(row.textContent).toContain('보관함에는 저장하지 않아요');
    // the count is its own line, not glued in front of the description (Visual QA: "…0개 실험마다 …")
    const lines = [...row.querySelectorAll('.setting-desc-line')].map((el) => el.textContent);
    expect(lines).toEqual(['실험마다 이 PC의 앱 폴더에 따로 저장해요. 보관함에는 저장하지 않아요.', '기록이 있는 실험: 3개']);
  });

  it('delete all asks first; refused leaves everything', async () => {
    const deps = setup({ confirm: false });
    await settle();
    await userEvent.click(screen.getByRole('button', { name: '모든 기록 지우기' }));
    expect(deps.confirm).toHaveBeenCalledWith('모든 실험의 대화 기록을 지울까요? 되돌릴 수 없어요.');
    expect(deps.clearAll).not.toHaveBeenCalled();
  });

  it('confirmed: clears all, resets the open chat and refreshes the count', async () => {
    const deps = setup();
    await settle();
    await userEvent.click(screen.getByRole('button', { name: '모든 기록 지우기' }));
    await settle();
    expect(deps.clearAll).toHaveBeenCalledTimes(1);
    expect(deps.onCleared).toHaveBeenCalledTimes(1);
    expect(deps.notify).toHaveBeenCalledWith('info', '대화 기록을 모두 지웠어요.');
    expect(screen.getByRole('group', { name: '대화 기록' }).textContent).toContain('기록이 있는 실험: 0개');
    expect(screen.getByRole('button', { name: '모든 기록 지우기' }).getAttribute('aria-disabled')).toBe('true');
  });

  it('the button keeps keyboard focus after clearing (aria-disabled, not disabled) and then does nothing (Task 22)', async () => {
    const deps = setup();
    await settle();
    const button = screen.getByRole('button', { name: '모든 기록 지우기' }) as HTMLButtonElement;
    button.focus();
    await userEvent.keyboard('{Enter}');
    await settle();
    expect(deps.clearAll).toHaveBeenCalledTimes(1);
    expect(button.disabled).toBe(false);
    expect(document.activeElement).toBe(button);
    await userEvent.keyboard('{Enter}');
    await settle();
    expect(deps.confirm).toHaveBeenCalledTimes(1);
  });

  it('follows the language', async () => {
    setLang('en');
    setup();
    await settle();
    expect(screen.getByRole('group', { name: 'Chat history' }).textContent).toContain('Experiments with chat: 3');
  });
});

describe('Assistant pane: web search address row (plan Task 12)', () => {
  async function setupSearch(opts: { stored?: string; probe?: () => Promise<unknown>; save?: (url: string) => Promise<unknown> } = {}) {
    const deps = {
      read: vi.fn(async () => (opts.stored ? { searxngUrl: opts.stored } : {})),
      save: vi.fn(opts.save ?? (async (url: string) => (url ? { searxngUrl: url.replace(/\/$/, '') } : {}))),
      probe: vi.fn(opts.probe ?? (async () => ({ hits: [{ title: 'a', url: 'https://a.example/', snippet: '', engine: 'e' }], enginesDown: false }))),
    };
    render(<WebSearchRow {...(deps as unknown as WebSearchRowDeps)} />);
    await settle();
    return { deps };
  }

  it('shows the stored address and says it stays on this PC', async () => {
    await setupSearch({ stored: 'https://search.example' });
    const row = screen.getByRole('group', { name: '웹 검색 주소' });
    expect(row.textContent).toContain('이 PC에만 저장해요');
    expect((screen.getByRole('textbox', { name: '웹 검색 주소' }) as HTMLInputElement).value).toBe('https://search.example');
  });

  it('Enter saves the trimmed address; the stored form comes back', async () => {
    const { deps } = await setupSearch();
    const box = screen.getByRole('textbox', { name: '웹 검색 주소' });
    await userEvent.type(box, '  https://s.example/  {Enter}');
    await settle();
    expect(deps.save).toHaveBeenCalledWith('https://s.example/');
    expect((box as HTMLInputElement).value).toBe('https://s.example');
    expect(screen.getByRole('status').textContent).toBe('저장했어요.');
  });

  it('a refused address shows the plain hint and keeps the typed text', async () => {
    const { AssistantHistoryError } = await import('../../assistant/history');
    const { deps } = await setupSearch({
      save: async () => {
        throw new AssistantHistoryError('badUrl', 'the web search address is not valid');
      },
    });
    const box = screen.getByRole('textbox', { name: '웹 검색 주소' });
    await userEvent.type(box, 'http://search.lab{Enter}');
    await settle();
    expect(deps.save).toHaveBeenCalledTimes(1);
    expect((box as HTMLInputElement).value).toBe('http://search.lab');
    expect(screen.getByRole('status').textContent).toContain('주소가 올바르지 않아요');
  });

  it('Check probes the typed (unsaved) address and shows how many results came back', async () => {
    const { deps } = await setupSearch();
    const check = screen.getByRole('button', { name: '확인' }) as HTMLButtonElement;
    expect(check.getAttribute('aria-disabled')).toBe('true');
    await userEvent.type(screen.getByRole('textbox', { name: '웹 검색 주소' }), 'https://s.example');
    await userEvent.click(check);
    await settle();
    expect(deps.probe).toHaveBeenCalledWith('https://s.example');
    expect(screen.getByRole('status').textContent).toBe('연결됐어요. 결과 1개');
  });

  it('Check keeps keyboard focus while it probes and ignores a second press (Task 22: a disabled button drops focus to the page)', async () => {
    let finish: (v: unknown) => void = () => undefined;
    const { deps } = await setupSearch({ probe: () => new Promise((r) => (finish = r)) });
    await userEvent.type(screen.getByRole('textbox', { name: '웹 검색 주소' }), 'https://s.example');
    const check = screen.getByRole('button', { name: '확인' }) as HTMLButtonElement;
    check.focus();
    await userEvent.keyboard('{Enter}');
    expect(check.disabled).toBe(false);
    expect(check.getAttribute('aria-disabled')).toBe('true');
    expect(document.activeElement).toBe(check);
    await userEvent.keyboard('{Enter}');
    expect(deps.probe).toHaveBeenCalledTimes(1);
    await act(async () => finish({ hits: [], enginesDown: false }));
    expect(check.getAttribute('aria-disabled')).toBeNull();
  });

  it('a 403 from the server (JSON turned off) shows the plain settings.yml hint', async () => {
    const { NetError } = await import('../../integrations/netIpc');
    await setupSearch({
      stored: 'http://127.0.0.1:8888',
      probe: async () => {
        throw new NetError('jsonDisabled', 'this SearXNG instance does not allow JSON results');
      },
    });
    await userEvent.click(screen.getByRole('button', { name: '확인' }));
    await settle();
    expect(screen.getByRole('status').textContent).toBe(
      '이 검색 주소는 JSON 결과를 막아 두었어요. SearXNG settings.yml의 search.formats에 json을 추가하세요.'
    );
  });

  it('an address with a user name or password is refused inline: not saved, not probed (Task 21)', async () => {
    const { deps } = await setupSearch();
    const box = screen.getByRole('textbox', { name: '웹 검색 주소' });
    await userEvent.type(box, 'https://me:secret@s.example{Enter}');
    await settle();
    expect(deps.save).not.toHaveBeenCalled();
    expect(screen.getByRole('status').textContent).toBe('주소에 아이디나 비밀번호를 넣을 수 없어요.');
    expect(box.getAttribute('aria-invalid')).toBe('true');
    await userEvent.click(screen.getByRole('button', { name: '확인' }));
    await settle();
    expect(deps.probe).not.toHaveBeenCalled();
    expect(screen.getByRole('status').textContent).toBe('주소에 아이디나 비밀번호를 넣을 수 없어요.');
    await userEvent.clear(box);
    await userEvent.type(box, 'https://me@s.example{Enter}');
    await settle();
    expect(deps.save).not.toHaveBeenCalled();
    await userEvent.clear(box);
    await userEvent.type(box, 'https://s.example{Enter}');
    await settle();
    expect(deps.save).toHaveBeenCalledWith('https://s.example');
    expect(box.getAttribute('aria-invalid')).toBeNull();
  });

  it('follows the language', async () => {
    setLang('en');
    await setupSearch();
    expect(screen.getByRole('group', { name: 'Web search address' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Check' })).toBeTruthy();
  });

  it('a gateway 401 (unauthorized) asks for the search key or the LLM key, not the settings.yml hint', async () => {
    const { NetError } = await import('../../integrations/netIpc');
    await setupSearch({
      stored: 'https://llm.example/v1',
      probe: async () => {
        throw new NetError('unauthorized', 'raw-rust-text');
      },
    });
    await userEvent.click(screen.getByRole('button', { name: '확인' }));
    await settle();
    const text = screen.getByRole('status').textContent ?? '';
    expect(text).toBe('검색 서버가 키를 거절했어요. 아래 검색 서버 키를 넣으세요. LLM과 같은 서버라면 LLM 키를 확인하세요.');
    expect(text).not.toContain('settings.yml');
    expect(text).not.toContain('raw-rust-text');
  });

  it('a saved address tells the pane (so the key row re-reads its state)', async () => {
    const onSaved = vi.fn();
    const deps = {
      read: vi.fn(async () => ({})),
      save: vi.fn(async (url: string) => ({ searxngUrl: url })),
      probe: vi.fn(),
      onSaved,
    };
    render(<WebSearchRow {...(deps as unknown as WebSearchRowDeps)} />);
    await settle();
    await userEvent.type(screen.getByRole('textbox', { name: '웹 검색 주소' }), 'https://llm.example/v1{Enter}');
    await settle();
    expect(onSaved).toHaveBeenCalledTimes(1);
  });
});

describe('Assistant pane: search server key row', () => {
  const KEY = 'test-search-key-123';

  async function setupKey(opts: { set?: boolean; setSecret?: (v: string) => Promise<void> } = {}) {
    let isSet = opts.set ?? false;
    const deps = {
      status: vi.fn(async () => secretStatusOf({ webSearch: isSet })),
      setSecret: vi.fn(
        opts.setSecret ??
          (async () => {
            isSet = true;
          })
      ),
      clearSecret: vi.fn(async () => {
        isSet = false;
      }),
    };
    render(<WebSearchKeyRow {...deps} />);
    await settle();
    return deps;
  }

  it('is a write-only password field with the same-host hint, and shows only whether a key is set', async () => {
    await setupKey();
    const row = screen.getByRole('group', { name: '검색 서버 키' });
    expect(row.textContent).toContain('LLM과 같은 서버면 LLM 키를 자동으로 써요');
    expect(row.textContent).toContain('설정 안 됨');
    const box = screen.getByLabelText('검색 서버 키', { selector: 'input' }) as HTMLInputElement;
    expect(box.type).toBe('password');
    expect(box.getAttribute('autocomplete')).toBe('off');
    expect(screen.queryByRole('button', { name: '키 지우기' })).toBeNull();
  });

  it('Enter saves the trimmed key to the webSearch slot, clears the field and never shows the key', async () => {
    const deps = await setupKey();
    const box = screen.getByLabelText('검색 서버 키', { selector: 'input' }) as HTMLInputElement;
    await userEvent.type(box, `  ${KEY}  {Enter}`);
    await settle();
    expect(deps.setSecret).toHaveBeenCalledWith(KEY);
    expect(box.value).toBe('');
    expect(document.body.innerHTML).not.toContain(KEY);
    const row = screen.getByRole('group', { name: '검색 서버 키' });
    expect(row.textContent).toContain('설정됨');
    expect(screen.getByRole('status').textContent).toBe('키를 저장했어요.');
  });

  it('Remove clears the key', async () => {
    const deps = await setupKey({ set: true });
    await userEvent.click(screen.getByRole('button', { name: '키 지우기' }));
    await settle();
    expect(deps.clearSecret).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('status').textContent).toBe('키를 지웠어요.');
    expect(screen.queryByRole('button', { name: '키 지우기' })).toBeNull();
  });

  it('without a saved address it asks for the address first; other failures say plainly that saving failed', async () => {
    const { NetError } = await import('../../integrations/netIpc');
    await setupKey({
      setSecret: async () => {
        throw new NetError('notConfigured', 'raw-rust-text');
      },
    });
    const box = screen.getByLabelText('검색 서버 키', { selector: 'input' }) as HTMLInputElement;
    await userEvent.type(box, `${KEY}{Enter}`);
    await settle();
    expect(screen.getByRole('status').textContent).toBe('먼저 웹 검색 주소를 저장하세요.');
    cleanup();
    await setupKey({
      setSecret: async () => {
        throw new NetError('keychain', 'raw-rust-text');
      },
    });
    await userEvent.click(screen.getByRole('button', { name: '키 저장' }));
    expect(screen.getByRole('status').textContent).toBe('');
    await userEvent.type(screen.getByLabelText('검색 서버 키', { selector: 'input' }), KEY);
    await userEvent.click(screen.getByRole('button', { name: '키 저장' }));
    await settle();
    expect(screen.getByRole('status').textContent).toBe('키를 저장하지 못했어요.');
    expect(document.body.textContent).not.toContain('raw-rust-text');
  });

  it('when the saved search address is on the LLM server, says the LLM key is used (no second entry needed)', async () => {
    const status = (set: boolean) => vi.fn(async () => secretStatusOf({ webSearch: set }));
    const same = { status: status(false), searchUrl: async () => 'https://LLM.example:443/v1', llmEndpoint: () => 'https://llm.example/v1' };
    render(<WebSearchKeyRow {...same} />);
    await settle();
    const row = () => screen.getByRole('group', { name: '검색 서버 키' });
    expect(row().textContent).toContain('검색 주소가 LLM과 같은 서버라 LLM 키를 써요. 따로 넣지 않아도 돼요.');
    cleanup();
    // Another origin (port, host or scheme): no such hint.
    for (const searchUrl of ['https://llm.example:8443/v1', 'https://search.example/v1', 'http://llm.example/v1']) {
      render(<WebSearchKeyRow status={status(false)} searchUrl={async () => searchUrl} llmEndpoint={() => 'https://llm.example/v1'} />);
      await settle();
      expect(row().textContent, searchUrl).not.toContain('따로 넣지 않아도 돼요');
      cleanup();
    }
    // No search address saved yet, or no LLM address: no hint.
    render(<WebSearchKeyRow status={status(false)} searchUrl={async () => undefined} llmEndpoint={() => 'https://llm.example/v1'} />);
    await settle();
    expect(row().textContent).not.toContain('따로 넣지 않아도 돼요');
    cleanup();
    render(<WebSearchKeyRow status={status(false)} searchUrl={async () => 'https://llm.example/v1'} llmEndpoint={() => ''} />);
    await settle();
    expect(row().textContent).not.toContain('따로 넣지 않아도 돼요');
    cleanup();
    // A search key of its own wins: the hint goes away.
    render(<WebSearchKeyRow status={status(true)} searchUrl={async () => 'https://llm.example/v1'} llmEndpoint={() => 'https://llm.example/v1'} />);
    await settle();
    expect(row().textContent).not.toContain('따로 넣지 않아도 돼요');
    cleanup();
    setLang('en');
    render(<WebSearchKeyRow {...same} />);
    await settle();
    expect(screen.getByRole('group', { name: 'Search server key' }).textContent).toContain('same server as the LLM');
  });

  it('follows the language', async () => {
    setLang('en');
    await setupKey();
    const row = screen.getByRole('group', { name: 'Search server key' });
    expect(row.textContent).toContain('the LLM key is used automatically');
    expect(screen.getByRole('button', { name: 'Save key' })).toBeTruthy();
  });
});

describe('Assistant pane: skin row (plan Task 16)', () => {
  const blue: SkinManifest = { ...BUILTIN_SKIN, id: 'flasko-blue', name: 'Flasko Blue', author: 'Hong', licence: 'CC-BY-4.0' };

  function skinSetup(opts: { active?: string; confirm?: boolean; removeFails?: boolean } = {}) {
    let installed: SkinManifest[] = [blue];
    let active = opts.active ?? 'flasko';
    const deps = {
      list: vi.fn(async () => installed),
      remove: vi.fn(async (id: string) => {
        if (opts.removeFails) throw { kind: 'io' };
        installed = installed.filter((m) => m.id !== id);
        if (active === id) active = 'flasko';
      }),
      confirm: vi.fn(async () => opts.confirm ?? true),
      notify: vi.fn(),
      setSkin: vi.fn((id: string) => {
        active = id;
      }),
    };
    const view = render(<SkinRow {...deps} active={active} />);
    const rerender = () => view.rerender(<SkinRow {...deps} active={active} />);
    return { deps, rerender };
  }

  it('lists the built-in skin first, then installed skins, with author and licence as plain text', async () => {
    skinSetup({ active: 'flasko-blue' });
    await settle();
    const select = screen.getByRole('combobox', { name: '스킨' }) as HTMLSelectElement;
    expect([...select.options].map((o) => [o.value, o.textContent])).toEqual([
      ['flasko', 'Flasko (기본)'],
      ['flasko-blue', 'Flasko Blue'],
    ]);
    expect(select.value).toBe('flasko-blue');
    expect(screen.getByRole('group', { name: '스킨' }).textContent).toContain('만든 사람: Hong · 라이선스: CC-BY-4.0');
  });

  it('switching saves the id for this PC', async () => {
    const { deps } = skinSetup();
    await settle();
    await userEvent.selectOptions(screen.getByRole('combobox', { name: '스킨' }), 'flasko-blue');
    expect(deps.setSkin).toHaveBeenCalledWith('flasko-blue');
  });

  it('an unknown active id shows the built-in skin; the built-in skin cannot be deleted', async () => {
    skinSetup({ active: 'gone-skin' });
    await settle();
    expect((screen.getByRole('combobox', { name: '스킨' }) as HTMLSelectElement).value).toBe('flasko');
    expect(screen.getByRole('button', { name: '삭제' }).getAttribute('aria-disabled')).toBe('true');
  });

  it('delete asks first; refused removes nothing', async () => {
    const { deps } = skinSetup({ active: 'flasko-blue', confirm: false });
    await settle();
    await userEvent.click(screen.getByRole('button', { name: '삭제' }));
    expect(deps.confirm).toHaveBeenCalledWith('Flasko Blue 스킨을 지울까요? 되돌릴 수 없어요.');
    expect(deps.remove).not.toHaveBeenCalled();
  });

  it('confirmed: removes the skin, says so, and refreshes the list', async () => {
    const { deps, rerender } = skinSetup({ active: 'flasko-blue' });
    await settle();
    await userEvent.click(screen.getByRole('button', { name: '삭제' }));
    await settle();
    expect(deps.remove).toHaveBeenCalledWith('flasko-blue');
    expect(deps.notify).toHaveBeenCalledWith('info', '스킨을 지웠어요.');
    rerender();
    await settle();
    const select = screen.getByRole('combobox', { name: '스킨' }) as HTMLSelectElement;
    expect([...select.options].map((o) => o.value)).toEqual(['flasko']);
  });

  it('a failed delete says so', async () => {
    const { deps } = skinSetup({ active: 'flasko-blue', removeFails: true });
    await settle();
    await userEvent.click(screen.getByRole('button', { name: '삭제' }));
    await settle();
    expect(deps.notify).toHaveBeenCalledWith('warn', '스킨을 지우지 못했어요.');
  });

  it('follows the language', async () => {
    setLang('en');
    skinSetup({ active: 'flasko-blue' });
    await settle();
    expect(screen.getByRole('combobox', { name: 'Skin' })).toBeTruthy();
    expect(screen.getByRole('group', { name: 'Skin' }).textContent).toContain('By Hong · Licence: CC-BY-4.0');
  });
});

describe('Assistant pane: skin import and export (Task 17)', () => {
  const blue: SkinManifest = { ...BUILTIN_SKIN, id: 'flasko-blue', name: 'Flasko Blue', author: 'Hong', licence: 'CC-BY-4.0' };

  it('export saves the chosen skin (the built-in one too); import leaves the settings window first', async () => {
    const exportSkin = vi.fn(async () => true);
    const importSkin = vi.fn(async () => undefined);
    const leave = vi.fn(async (after: () => Promise<void>) => after());
    const deps = { list: vi.fn(async () => [blue]), exportSkin, importSkin, leave, notify: vi.fn() };
    const view = render(<SkinRow {...deps} active="flasko-blue" />);
    await settle();
    await userEvent.click(screen.getByRole('button', { name: '내보내기' }));
    expect(exportSkin).toHaveBeenCalledWith('flasko-blue');
    view.rerender(<SkinRow {...deps} active="flasko" />);
    await userEvent.click(screen.getByRole('button', { name: '내보내기' }));
    expect(exportSkin).toHaveBeenLastCalledWith('flasko');
    await userEvent.click(screen.getByRole('button', { name: '가져오기' }));
    expect(leave).toHaveBeenCalledTimes(1);
    await settle();
    expect(importSkin).toHaveBeenCalledTimes(1);
  });

  it('without a settings window, import runs in place and the list is read again', async () => {
    const list = vi.fn(async () => [blue]);
    const importSkin = vi.fn(async () => undefined);
    render(<SkinRow list={list} importSkin={importSkin} active="flasko" />);
    await settle();
    await userEvent.click(screen.getByRole('button', { name: '가져오기' }));
    await settle();
    expect(importSkin).toHaveBeenCalledTimes(1);
    expect(list).toHaveBeenCalledTimes(2);
  });

  it('"내 스킨 만들기" leaves the settings window first, then opens the editor (Task 18)', async () => {
    const makeSkin = vi.fn(async () => undefined);
    const leave = vi.fn(async (after: () => Promise<void>) => after());
    render(<SkinRow list={vi.fn(async () => [])} makeSkin={makeSkin} leave={leave} active="flasko" />);
    await settle();
    await userEvent.click(screen.getByRole('button', { name: '내 스킨 만들기' }));
    expect(leave).toHaveBeenCalledTimes(1);
    await settle();
    expect(makeSkin).toHaveBeenCalledTimes(1);
  });
});

describe('Assistant pane: external assistants row (Task 21, spec §10.1)', () => {
  it('says how outside tools connect and opens the page with the MCP server switch', async () => {
    const showPage = vi.fn();
    render(<ExternalAssistantsRow showPage={showPage} />);
    const row = screen.getByRole('group', { name: '외부 도우미' });
    expect(row.textContent).toContain('MCP 서버');
    await userEvent.click(screen.getByRole('button', { name: 'MCP 서버 설정 열기' }));
    expect(showPage).toHaveBeenCalledWith('integrations');
  });

  it('is keyboard-operable (a native button) and follows the language', async () => {
    setLang('en');
    const showPage = vi.fn();
    render(<ExternalAssistantsRow showPage={showPage} />);
    expect(screen.getByRole('group', { name: 'External assistants' }).textContent).toContain('MCP server');
    const button = screen.getByRole('button', { name: 'Open MCP server settings' });
    button.focus();
    await userEvent.keyboard('{Enter}');
    expect(showPage).toHaveBeenCalledWith('integrations');
  });
});
