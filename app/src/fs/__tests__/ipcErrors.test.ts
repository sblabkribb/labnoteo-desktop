import { ERROR_KINDS, hasErrorKind } from '../errorKinds';
import { ERROR_KINDS_FIXTURE } from '../../__tests__/fixtures';
import { FsCommandError } from '../tauriLabnoteFs';
import { openVault } from '../../vault/useVault';

// 공유 픽스처. Rust 쪽 tests/ipc.rs 가 같은 파일을 읽어 `FsError` 직렬화가 이 값을 내는지 본다.
// 프런트가 분기하는 `kind` 값을 한쪽에서만 바꾸면 양쪽 테스트가 각자 통과하는 일을 막는다.
describe('IPC 오류 kind 계약', () => {
  it('프런트가 분기하는 kind 상수가 공유 픽스처와 정확히 같다', () => {
    expect({ ...ERROR_KINDS }).toEqual(ERROR_KINDS_FIXTURE);
  });

  it('픽스처의 kind 로 거부된 값을 알아본다', () => {
    for (const [name, wire] of Object.entries(ERROR_KINDS_FIXTURE)) {
      expect(hasErrorKind({ kind: wire, message: 'x' }, ERROR_KINDS[name as keyof typeof ERROR_KINDS])).toBe(true);
    }
    expect(hasErrorKind({ kind: ERROR_KINDS_FIXTURE.io }, ERROR_KINDS.notFound)).toBe(false);
    expect(hasErrorKind(null, ERROR_KINDS.notFound)).toBe(false);
  });

  it('notFound 는 ENOENT 가 되고 다른 kind 는 되지 않는다(코어가 이 코드로 없는 파일을 가린다)', () => {
    expect(new FsCommandError(ERROR_KINDS_FIXTURE.notFound, 'x').code).toBe('ENOENT');
    expect(new FsCommandError(ERROR_KINDS_FIXTURE.io, 'x').code).toBeUndefined();
  });

  it('없는 보관함·없는 폴더는 "찾을 수 없음" 문구를, 그 밖의 오류는 일반 문구를 준다', async () => {
    const reject = (kind: string) => (async () => Promise.reject({ kind, message: 'x' })) as never;
    const msg = async (kind: string) => {
      const s = await openVault(reject(kind), 'some-folder');
      return s.status === 'picker' ? s.error : undefined;
    };
    const missing = await msg(ERROR_KINDS_FIXTURE.vaultNotFound);
    expect(missing).toBeTruthy();
    expect(await msg(ERROR_KINDS_FIXTURE.notFound)).toBe(missing);
    expect(await msg(ERROR_KINDS_FIXTURE.io)).not.toBe(missing);
  });
});
