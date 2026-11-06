import { README, VAULT_ROOT } from '../paths';
import { normalizeVaultPath } from '../../fs/tauriLabnoteFs';

describe('labnote 경로 상수', () => {
  it("VAULT_ROOT 는 '.' 이다: 코어 로더는 falsy 루트에 아무것도 돌려주지 않는다", () => {
    expect(VAULT_ROOT).toBe('.');
    expect(VAULT_ROOT).toBeTruthy();
  });

  it('VAULT_ROOT 는 Rust 쪽에 보관함 루트(빈 문자열)로 간다', () => {
    expect(normalizeVaultPath(VAULT_ROOT)).toBe('');
  });

  it('README 는 실험 폴더의 README 파일 이름이다', () => {
    expect(README).toBe('README.labnote.md');
  });
});
