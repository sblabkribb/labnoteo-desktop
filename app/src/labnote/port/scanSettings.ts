// Ported from app/vendor/labnoteo/src/scan/scanSettings.ts:22-364 sha256:43afc0f9e98a28f7
// labnoteO 0.140.2, Apache-2.0.
// Changes: the Setting rows become React rows in app/src/labnote/scan/ScanSettingsSection.tsx, and what is left here is
// their logic as functions over a Translator named `translate` (so the app's own t-key check does not read plugin keys
// as app keys). numberField's commit becomes commitRangedNumber(translate, {label, range, allowed, also, current, value}),
// which returns the value to keep and, when refused, the plugin's sentence, which the section shows inside the dialog
// instead of an 8 s Notice. The scan folder's state line becomes folderStateLine(translate, status): Rust's exists and
// insideVault replace fs.statSync and isInsideFolder, and the inside-vault sentence (which named Obsidian) becomes
// overrideOr('scan.insideVault') (B4, B11). The Slack status line becomes slackStatusLine. Connect becomes
// connectSlack(translate, slack, {tokenSet, mode, channelInput}): the token is no longer typed into this flow but stored
// in the keychain slot slackBot first (the section saves a typed one through KeyField's setSecret before calling it),
// so the xoxb- check becomes "is a token stored"; verify and beginLink no longer take the token, beginLink is awaited,
// and the notices are returned for the section to show in place instead of Notices; a failed check names Slack's code
// or the NetError's kind, never Rust's text. The path text field, the mode dropdown, Process now, Unmatched scans and
// Disconnect are wired in the section (scanFolderChoose / scanFolderClear / scanFolderSetMode, processFolderNow,
// openUnmatched, slack.disconnect plus the KeyField's Remove key).
import type { Translator } from '@labnoteo/core';
import { parseRangedNumber } from '../../../vendor/labnoteo/src/settings';
import { NetError } from '../../integrations/netIpc';
import { overrideOr } from '../i18n';
import type { ScanFolderStatus, SlackLink } from '../scan/scanIpc';
import { describeSlackError, slackChannelId, type SlackMode, type SlackVerification } from './slackInbox';

/**
 * A number typed into a field, kept when it is inside `range` or one of `also` (#321). Anything else is refused with
 * the plugin's notice, and the field goes back to `current`.
 */
export function commitRangedNumber(
  translate: Translator,
  opts: {
    label: string;
    range: { min: number; max: number };
    allowed: string;
    also?: number[];
    current: number;
    value: string;
  },
): { value: number; notice?: string } {
  const n = parseRangedNumber(opts.value, opts.range, opts.also);
  if (n === undefined) {
    return {
      value: opts.current,
      notice: translate('{0} takes {1}; the value was not saved and is back to {2}.', opts.label, opts.allowed, String(opts.current)),
    };
  }
  return { value: n };
}

/** The line under the scan folder: missing, inside the vault, or watched. Nothing when no folder is set. */
export function folderStateLine(translate: Translator, status: ScanFolderStatus): { text: string; warn: boolean } | undefined {
  if (!status.path) return undefined;
  if (!status.exists) return { text: translate('This folder does not exist on this PC.'), warn: true };
  // plugin: 'This folder is inside the vault, so the original photos also show up in Obsidian and in git. A folder outside the vault is better.'
  if (status.insideVault) return { text: overrideOr('scan.insideVault'), warn: true };
  return { text: translate('Watching this folder. Only files added from now on are read.'), warn: false };
}

/** The Slack connection row's text for an enabled link, with the last failed check after it. */
export function slackStatusLine(translate: Translator, cfg: SlackLink, lastError?: string): string {
  const statusDesc = cfg.userId
    ? translate(
        'Linked. Files you send to the bot ({0}) are filed every 90 seconds.',
        cfg.mode === 'dm' ? translate('direct message') : cfg.channelId,
      )
    : translate('Waiting for the link code. Send {0} to the bot as a direct message (or post it in the channel).', cfg.linkCode);
  return lastError ? `${statusDesc} ${translate('Last check failed: {0}', describeSlackError(translate, lastError))}` : statusDesc;
}

/** What Connect needs from the Slack inbox. */
export interface SlackConnectPort {
  verify(mode: SlackMode, channelId?: string): Promise<SlackVerification>;
  beginLink(mode: SlackMode, channelId?: string): Promise<string>;
  start(): void;
}

/**
 * Connect: check the stored token, its permissions and (for a channel) the invite before making a link code, so a
 * mistake shows up now rather than as a silent "waiting" state. `linked` is true when a link code was stored.
 */
export async function connectSlack(
  translate: Translator,
  slack: SlackConnectPort,
  input: { tokenSet: boolean; mode: SlackMode; channelInput: string },
): Promise<{ linked: boolean; notices: string[] }> {
  if (!input.tokenSet) return { linked: false, notices: [translate('Enter the bot token (it starts with xoxb-).')] };
  const { mode } = input;
  const channel = mode === 'channel' ? slackChannelId(input.channelInput) : undefined;
  if (mode === 'channel' && !channel) {
    const typed = input.channelInput.trim();
    return {
      linked: false,
      notices: [
        typed
          ? translate('No channel ID in "{0}". Paste the channel ID (it starts with C) or a link to the channel.', typed)
          : translate('Enter the channel ID (it starts with C).'),
      ],
    };
  }
  const notices: string[] = [];
  try {
    const check = await slack.verify(mode, channel);
    if (check.missingScopes.length) {
      return {
        linked: false,
        notices: [
          translate(
            'The Slack token is missing permissions: {0}. Add them under OAuth & Permissions and reinstall the app.',
            check.missingScopes.join(', '),
          ),
        ],
      };
    }
    if (check.notInChannel) {
      return {
        linked: false,
        notices: [translate('The bot is not in that channel. In the channel, run /invite @{0} and press Connect again.', check.botName)],
      };
    }
    if (check.missingRecommended) {
      notices.push(translate('Tip: the {0} permission lets the bot mark messages with 👀 so two PCs never file the same photo.', 'reactions:write'));
    }
    const code = await slack.beginLink(mode, channel);
    notices.push(translate('Connected to the bot {0}. Send {1} to it in Slack to link this PC.', check.botName, code));
    slack.start();
    return { linked: true, notices };
  } catch (err) {
    const code = err instanceof NetError ? err.kind : err instanceof Error ? err.message : String(err);
    return { linked: false, notices: [...notices, translate('Could not verify the Slack token: {0}', describeSlackError(translate, code))] };
  }
}
