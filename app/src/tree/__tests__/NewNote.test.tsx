// @vitest-environment jsdom
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NewNoteForm } from '../NewNote';

type Invoke = (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;

function setup(over: { flush?: () => Promise<boolean>; invoke?: Invoke } = {}) {
  const onCreated = vi.fn();
  const onCancel = vi.fn();
  const invoke = vi.fn(over.invoke ?? (async (cmd: string) => (cmd === 'vault_exists' ? false : { kind: 'ok' })));
  const flush = over.flush ?? (async () => true);
  render(<NewNoteForm flush={flush} onCreated={onCreated} onCancel={onCancel} invoke={invoke as never} />);
  return { onCreated, onCancel, invoke };
}

const openForm = async () => undefined;
const nameBox = () => screen.getByRole('textbox', { name: '노트 이름' });

describe('새 노트 입력(새 노트 대화상자 안)', () => {
  it('열리면 입력창에 바로 커서가 가고, 안내문이 입력에 이어진다', async () => {
    setup();
    expect(document.activeElement).toBe(nameBox());
    expect(document.getElementById(nameBox().getAttribute('aria-describedby')!)!.textContent).toContain('.labnote.md');
  });

  it('이름을 쓰고 Enter 를 치면 만들고, 만든 경로로 알린다(대화상자는 그 값으로 닫힌다)', async () => {
    const { onCreated, invoke } = setup();
    await openForm();
    await userEvent.type(nameBox(), 'Day 1{Enter}');
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith('Day 1.labnote.md'));
    expect(invoke).toHaveBeenCalledWith('vault_modify', { path: 'Day 1.labnote.md', content: '', expectedBefore: '' });
  });

  it('빈 이름은 이유를 알려 주고 입력을 연 채로 둔다', async () => {
    const { onCreated, invoke } = setup();
    await openForm();
    await userEvent.click(screen.getByRole('button', { name: '만들기' }));
    expect((await screen.findByRole('alert')).textContent).toBe('노트 이름을 적어 주세요.');
    expect(nameBox()).toBeTruthy();
    expect(onCreated).not.toHaveBeenCalled();
    expect(invoke).not.toHaveBeenCalled();
  });

  it('이름이 겹치면 그 말을 하고 열려 있는 노트를 바꾸지 않는다', async () => {
    const { onCreated } = setup({ invoke: async (cmd) => cmd === 'vault_exists' });
    await openForm();
    await userEvent.type(nameBox(), 'a{Enter}');
    expect((await screen.findByRole('alert')).textContent).toBe('같은 이름의 노트가 이미 있습니다.');
    expect(onCreated).not.toHaveBeenCalled();
  });

  it('경로 구분자는 하위 폴더 대신 이유를 알려 준다', async () => {
    const { invoke } = setup();
    await openForm();
    await userEvent.type(nameBox(), 'a/b{Enter}');
    const text = (await screen.findByRole('alert')).textContent ?? '';
    expect(text).toContain('이름에는 / 나');
    expect(text).toContain(String.fromCharCode(92)); // 안내문에 역슬래시가 정말 글자로 나온다
    expect(invoke).not.toHaveBeenCalled();
  });

  it('Windows 가 금지한 이름은 알아듣는 말로 알려 준다', async () => {
    const { onCreated } = setup({
      invoke: async (cmd) => {
        if (cmd === 'vault_exists') throw { kind: 'escape', message: 'path escapes the vault' };
        return { kind: 'ok' };
      },
    });
    await openForm();
    await userEvent.type(nameBox(), 'CON{Enter}');
    const text = (await screen.findByRole('alert')).textContent ?? '';
    expect(text).toContain('이 이름은 쓸 수 없습니다');
    expect(text).not.toContain('escapes');
    expect(onCreated).not.toHaveBeenCalled();
  });

  it('저장하지 못한 편집이 남아 있으면 만들지 않는다: 편집이 사라지지 않게', async () => {
    const { onCreated, invoke } = setup({ flush: async () => false });
    await openForm();
    await userEvent.type(nameBox(), 'a{Enter}');
    expect((await screen.findByRole('alert')).textContent).toBe('저장하지 못한 편집이 있어 새 노트를 만들지 않았습니다.');
    expect(invoke).not.toHaveBeenCalled();
    expect(onCreated).not.toHaveBeenCalled();
  });

  it('취소하면 취소를 알리고 아무것도 만들지 않는다', async () => {
    const { invoke, onCancel } = setup();
    await openForm();
    await userEvent.type(nameBox(), 'a');
    await userEvent.click(screen.getByRole('button', { name: '취소' }));
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(invoke).not.toHaveBeenCalled();
  });
});
