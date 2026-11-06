import { MemFileSystem } from '@labnoteo/core';
it('core 의 런타임 export 를 쓸 수 있다', async () => {
  const fs = new MemFileSystem();
  await fs.write('a.md', 'hello');
  expect(await fs.read('a.md')).toBe('hello');
});
