import obsidianKo from '../../../../vendor/labnoteo/src/l10n.ko';
import { clearCommandsForTest, commandById, commands, registerCommand, type Command } from '../registry';
import { registerAllCommands } from '../registerAll';

const stub = (id: string, nameKey = 'Create workflow'): Command => ({ id, nameKey, run: async () => undefined });

afterEach(() => clearCommandsForTest());

describe('명령 목록', () => {
  it('registerCommand replaces an existing registration with the same id and keeps the order', () => {
    const first = stub('create-workflow');
    const second = stub('create-workflow');
    registerCommand(stub('create-experiment', 'Create experiment'));
    registerCommand(first);
    registerCommand(second);
    expect(commands().map((c) => c.id)).toEqual(['create-experiment', 'create-workflow']);
    expect(commandById('create-workflow')).toBe(second);
    expect(commandById('nope')).toBeUndefined();
    clearCommandsForTest();
    expect(commands()).toEqual([]);
  });

  it('registerAllCommands twice registers each id once', () => {
    registerAllCommands();
    const once = commands().map((c) => c.id);
    registerAllCommands();
    const twice = commands().map((c) => c.id);
    expect(twice).toEqual(once);
    expect(new Set(twice).size).toBe(twice.length);
  });

  it('every registered command has a nameKey that the Korean plugin catalog translates (the palette shows Korean)', () => {
    registerAllCommands();
    const missing = commands().filter((c) => !Object.hasOwn(obsidianKo, c.nameKey)).map((c) => `${c.id}: ${c.nameKey}`);
    expect(missing).toEqual([]);
  });
});
