/**
 * The suite's patch notes, pulled rather than pushed.
 *
 * The suite writes its notes in PATCHNOTES.md and its release script
 * publishes the current version's section as patch-notes.json on the update
 * server, beside the manifests the app itself reads. `/release` fetches that
 * file and posts it where the command was used.
 *
 * The earlier arrangement had the release script post to an endpoint here with
 * a channel id in its own configuration. That put a Discord decision — which
 * channel, and when — in a build machine's .env. Now the suite only says what
 * changed, and someone in the server decides where that is said.
 */

export interface PatchSection {
  readonly title: string;
  readonly notes: readonly string[];
}

export interface PatchNotes {
  readonly version: string;
  /** Headed lists, in the order they are posted: a changelog, things in testing. */
  readonly sections: readonly PatchSection[];
}

/** The name the suite's release script publishes the notes under. */
const PUBLISHED_NAME = 'patch-notes.json';

const FETCH_TIMEOUT_MS = 10_000;

/** What a flat list of notes, with no headings of its own, is filed under. */
const DEFAULT_TITLE = 'Changelog';

const MAX_SECTIONS = 8;
const MAX_NOTES = 60;
const MAX_NOTE_LENGTH = 500;
const MAX_TITLE_LENGTH = 80;

/** Discord refuses a message over 2000 characters; this leaves room to spare. */
const MAX_MESSAGE = 1900;

function cleanNotes(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((line): line is string => typeof line === 'string')
    .map((line) => line.trim().slice(0, MAX_NOTE_LENGTH))
    .filter((line) => line.length > 0);
}

/** Validates what came back from the update server. A string is the reason it was refused. */
export function parsePatchNotes(raw: unknown): PatchNotes | string {
  if (typeof raw !== 'object' || raw === null) return 'the patch notes file is not an object';
  const body = raw as Record<string, unknown>;

  if (typeof body.version !== 'string' || !/^[\w.+-]{1,40}$/.test(body.version)) {
    return 'the patch notes file has no usable version';
  }

  let sections: PatchSection[];
  if (Array.isArray(body.sections)) {
    sections = body.sections
      .filter((entry): entry is Record<string, unknown> => typeof entry === 'object' && entry !== null)
      .map((entry) => ({
        title:
          typeof entry.title === 'string' && entry.title.trim().length > 0
            ? entry.title.trim().slice(0, MAX_TITLE_LENGTH)
            : DEFAULT_TITLE,
        notes: cleanNotes(entry.notes),
      }));
  } else if (Array.isArray(body.notes)) {
    // A file with one flat list, as the first version of the format had it.
    sections = [{ title: DEFAULT_TITLE, notes: cleanNotes(body.notes) }];
  } else {
    return 'the patch notes file has no list of notes';
  }

  // Capped across the whole post, so one long section cannot crowd out the rest unseen.
  let room = MAX_NOTES;
  const kept: PatchSection[] = [];
  for (const section of sections.slice(0, MAX_SECTIONS)) {
    const notes = section.notes.slice(0, room);
    room -= notes.length;
    if (notes.length > 0) kept.push({ title: section.title, notes });
  }

  return { version: body.version, sections: kept };
}

/**
 * The post, as plain message text. An embed draws its text small and has no
 * real headers, which made a release read like a footnote; a message gets the
 * full-size heading a release is announced with.
 *
 * Returned as several messages when the notes will not fit in one, split
 * between lines so a note is never cut in half.
 */
export function releaseMessages(release: PatchNotes, mention: string | null = null): string[] {
  const lines = [`# NEW VERSION ${release.version} RELEASE`];
  if (mention !== null) lines.push(mention);

  if (release.sections.length === 0) lines.push('', '_No notes for this one._');
  for (const section of release.sections) {
    lines.push('', `## ${section.title}:`, ...section.notes.map((note) => `- ${note}`));
  }

  lines.push('', '-# Installed copies will offer the update on next launch');

  const messages: string[] = [];
  let current = '';
  for (const line of lines) {
    const next = current.length === 0 ? line : `${current}\n${line}`;
    if (next.length > MAX_MESSAGE && current.length > 0) {
      messages.push(current);
      current = line;
    } else {
      current = next;
    }
  }
  messages.push(current);

  // A blank line means nothing at either end of a message.
  return messages.map((message) => message.replace(/^\n+|\n+$/g, '')).filter((message) => message.length > 0);
}

/**
 * Reads the published notes. Throws with a message fit to show the person who
 * ran the command: every way this fails is something they can act on or pass
 * on, and none of them includes the token.
 */
export async function fetchPatchNotes(
  updateUrl: string,
  updateToken: string,
  fetchImpl: typeof fetch = fetch,
): Promise<PatchNotes> {
  const url = `${updateUrl.replace(/\/+$/, '')}/${PUBLISHED_NAME}`;

  let response: Response;
  try {
    response = await fetchImpl(url, {
      headers: { authorization: `Bearer ${updateToken}` },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch {
    throw new Error('I could not reach the update server.');
  }

  if (response.status === 404) {
    throw new Error('No patch notes have been published yet.');
  }
  if (response.status === 401) throw new Error('The update server refused my token. UPDATE_TOKEN needs checking.');
  if (!response.ok) throw new Error(`The update server answered ${response.status}.`);

  const parsed = parsePatchNotes(await response.json().catch(() => null));
  if (typeof parsed === 'string') throw new Error(`I could not read the patch notes: ${parsed}.`);
  return parsed;
}

/**
 * The mention that goes under the heading, and the one mention the post is
 * allowed to make. The @everyone role shares its id with the guild and is
 * written differently from every other role.
 */
export function rolePing(
  roleId: string,
  guildId: string,
): { content: string; allowedMentions: { parse: 'everyone'[] } | { roles: string[] } } {
  if (roleId === guildId) return { content: '@everyone', allowedMentions: { parse: ['everyone'] } };
  return { content: `<@&${roleId}>`, allowedMentions: { roles: [roleId] } };
}
