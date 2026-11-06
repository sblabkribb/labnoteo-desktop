import { LabnoteFs } from '@labnoteo/core';
it('core 타입을 import 할 수 있다', () => {
  const fs: LabnoteFs | undefined = undefined;
  expect(fs).toBeUndefined();
});
