/**
 * Headless checks for everything that would otherwise only be exercised by
 * hand against a live Discord connection: the schema, the plan endpoint and
 * the Connect Discord sign-in.
 *
 *   npm run selftest
 *
 * Runs against throwaway databases under the OS temp directory, with Discord
 * and its API replaced by stubs.
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { openDatabase } from '../src/db.ts';
import { MIGRATIONS } from '../src/migrations.ts';
import { startHttpServer } from '../src/http.ts';
import { Linker } from '../src/link.ts';

process.env.LOG_LEVEL = 'error';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tactics-bot-selftest-'));
const results = [];

async function check(name, fn) {
  try {
    await fn();
    results.push([true, name]);
  } catch (error) {
    results.push([false, name, error]);
  }
}

function freshDb(name) {
  return openDatabase(path.join(dir, `${name}.db`));
}

/** What config.ts would produce, with the HTTP server on a free port. */
const CONFIG = {
  token: 'x', appId: '999', clientSecret: 'client-secret', publicUrl: 'https://bot.example.com',
  dbPath: ':memory:', httpPort: 0, httpHost: '127.0.0.1',
};

await check('migrations bring a new database to the current version', () => {
  const db = freshDb('migrate');
  assert.equal(db.prepare('PRAGMA user_version').get().user_version, MIGRATIONS.length);
  assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE name = 'app_link'").get());
  db.close();
});

await check('re-opening an existing database applies nothing twice', () => {
  freshDb('reopen').close();
  const second = openDatabase(path.join(dir, 'reopen.db'));
  assert.equal(second.prepare('PRAGMA user_version').get().user_version, MIGRATIONS.length);
  second.close();
});

// ---- the plan endpoint ---------------------------------------------------

// A real 1x1 PNG, so the magic-number check sees something genuine.
const TINY_PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

const PLAN_TOKEN = 'selftest-token-long-enough-to-pass';

{
  // A Discord client that is connected but shares no server with anyone:
  // everything up to the permission check runs for real.
  const stubClient = { isReady: () => true, guilds: { cache: new Map() }, channels: { fetch: async () => null } };

  const planDb = freshDb('plan');
  // A token as /link/finish would have issued it: only its hash is stored.
  planDb
    .prepare('INSERT INTO app_link (token_hash, user_id, user_name, created_at, last_used_at) VALUES (?, ?, ?, 0, 0)')
    .run(createHash('sha256').update(PLAN_TOKEN).digest('base64url'), '111111111111111111', 'Sye');
  const server = startHttpServer(stubClient, CONFIG, planDb);

  if (!server.listening) await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;

  const post = (body, token = PLAN_TOKEN) =>
    fetch(`${base}/plan`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(token === null ? {} : { authorization: `Bearer ${token}` }),
      },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    });

  const validPlan = { channelId: '717071787099291742', title: 'Hotspot - Page 1', image: TINY_PNG };

  await check('the endpoint reports its health without a token', async () => {
    const response = await fetch(`${base}/health`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true, ready: true, linking: true });
  });

  await check('a plan without a token is refused', async () => {
    assert.equal((await post(validPlan, null)).status, 401);
  });

  await check('a plan with the wrong token is refused', async () => {
    assert.equal((await post(validPlan, 'not-the-token-but-same-length')).status, 401);
  });

  await check('a body that is not JSON is refused', async () => {
    const response = await post('<html>nope</html>');
    assert.equal(response.status, 400);
    assert.match((await response.json()).error, /JSON/);
  });

  await check('a plan without a channel is refused', async () => {
    const response = await post({ title: 'x', image: TINY_PNG });
    assert.equal(response.status, 400);
    assert.match((await response.json()).error, /channelId/);
  });

  await check('something that is not a PNG is refused', async () => {
    const response = await post({ ...validPlan, image: Buffer.from('MZ not an image').toString('base64') });
    assert.equal(response.status, 400);
    assert.match((await response.json()).error, /not a PNG/);
  });

  await check('a data: URL prefix is accepted, as a canvas produces it', async () => {
    const response = await post({ ...validPlan, image: `data:image/png;base64,${TINY_PNG}` });
    // 403 means it decoded, and got as far as asking whether they may post there.
    assert.equal(response.status, 403);
    assert.match((await response.json()).error, /cannot post/);
  });

  await check('an unknown path is not served', async () => {
    assert.equal((await fetch(`${base}/`)).status, 404);
  });

  await new Promise((resolve) => server.close(resolve));
  planDb.close();
}

// ---- linking the app to a Discord account ---------------------------------

{
  const MEMBER = '111111111111111111';
  const STRANGER = '222222222222222222';

  // One server with three text channels: one the member can post in, one
  // they can only read, and one the bot itself is shut out of.
  const me = { bot: true };
  const channel = (id, name, position, memberCan, botCan, parent = null) => ({
    id, name, type: 0, rawPosition: position, parent,
    permissionsFor: (who) => ({ has: () => (who === me ? botCan : memberCan) }),
  });
  const briefing = { name: 'Clan battles', rawPosition: 2 };
  const guild = {
    id: '717071787099291742',
    name: 'Test Haven',
    members: {
      me,
      fetch: async ({ user }) => {
        if (user !== MEMBER) throw new Error('Unknown Member');
        return { id: user };
      },
    },
    channels: {
      cache: new Map([
        ['900030', channel('900030', 'tactics', 1, true, true, briefing)],
        ['900010', channel('900010', 'general', 5, true, true)],
        ['900020', channel('900020', 'announcements', 0, false, true)],
        ['900040', channel('900040', 'officers', 2, true, false, briefing)],
        ['900050', { id: '900050', name: 'Voice', type: 2, rawPosition: 0, parent: null, permissionsFor: () => ({ has: () => true }) }],
      ]),
    },
  };

  const sent = [];
  const linkClient = {
    isReady: () => true,
    guilds: { cache: new Map([[guild.id, guild]]) },
    channels: {
      fetch: async (id) => ({
        isTextBased: () => true,
        send: async (message) => {
          sent.push({ id, message });
          return { url: `https://discord.com/channels/${guild.id}/${id}/1` };
        },
      }),
    },
  };

  // Discord's side of the sign-in. The code decides who signed in.
  const discordCalls = [];
  const discord = async (url, init = {}) => {
    discordCalls.push({ url, body: String(init.body ?? ''), auth: init.headers?.authorization });
    const json = (status, body) => new Response(JSON.stringify(body), { status });
    if (url.endsWith('/oauth2/token')) {
      const code = new URLSearchParams(String(init.body)).get('code');
      return code === 'bad' ? json(400, { error: 'invalid_grant' }) : json(200, { access_token: `access-${code}` });
    }
    if (url.endsWith('/users/@me')) {
      return init.headers.authorization === 'Bearer access-member'
        ? json(200, { id: MEMBER, username: 'sye', global_name: 'Sye' })
        : json(200, { id: STRANGER, username: 'stranger', global_name: null });
    }
    return json(200, {});
  };

  const db = freshDb('link');
  const linker = new Linker(linkClient, db, '999', 'client-secret', 'https://bot.example.com/', discord);

  const verifier = 'a-verifier-only-the-app-knows';
  const challenge = createHash('sha256').update(verifier).digest('base64url');

  /** Runs a sign-in up to Discord sending the browser back. */
  const signIn = async (code, port = 50123) => {
    const authorize = new URL(linker.begin(port, challenge));
    const query = new URLSearchParams({ state: authorize.searchParams.get('state') });
    if (code !== null) query.set('code', code);
    return { authorize, outcome: await linker.complete(query) };
  };
  const answer = (outcome) => new URL(outcome.location).searchParams;

  await check('a sign-in is sent to Discord asking only who the person is', () => {
    const authorize = new URL(linker.begin(50123, challenge));
    assert.equal(authorize.origin + authorize.pathname, 'https://discord.com/oauth2/authorize');
    assert.equal(authorize.searchParams.get('client_id'), '999');
    assert.equal(authorize.searchParams.get('scope'), 'identify');
    assert.equal(authorize.searchParams.get('redirect_uri'), 'https://bot.example.com/link/callback');
  });

  await check('a sign-in that could not have come from the app is not started', () => {
    assert.equal(linker.begin(80, challenge), null);
    assert.equal(linker.begin(Number('nope'), challenge), null);
    assert.equal(linker.begin(50123, 'too-short'), null);
  });

  let token;

  await check('a member who approves is linked, and the answer goes to their own machine', async () => {
    const { outcome } = await signIn('member', 50999);
    assert.equal(outcome.kind, 'redirect');
    assert.ok(outcome.location.startsWith('http://127.0.0.1:50999/callback?'));

    const linked = linker.finish(answer(outcome).get('grant'), verifier);
    assert.deepEqual(linked.user, { id: MEMBER, name: 'Sye' });
    token = linked.token;
    assert.deepEqual(linker.userFor(token), { id: MEMBER, name: 'Sye' });
  });

  await check('the client secret goes to Discord and the access it buys is handed back', () => {
    const exchange = discordCalls.find((call) => call.url.endsWith('/oauth2/token'));
    assert.match(exchange.body, /client_secret=client-secret/);
    assert.match(exchange.body, /redirect_uri=https%3A%2F%2Fbot\.example\.com%2Flink%2Fcallback/);
    assert.ok(discordCalls.some((call) => call.url.endsWith('/oauth2/token/revoke') && /token=access-member/.test(call.body)));
  });

  await check('only a hash of the token is stored', () => {
    const rows = db.prepare('SELECT token_hash FROM app_link').all();
    assert.equal(rows.length, 1);
    assert.notEqual(rows[0].token_hash, token);
    assert.equal(rows[0].token_hash, createHash('sha256').update(token).digest('base64url'));
  });

  await check('a grant is no use without the verifier, and only works once', async () => {
    const first = answer((await signIn('member')).outcome).get('grant');
    assert.equal(linker.finish(first, 'somebody-elses-guess'), null);
    // Spent by the failed attempt, so the right verifier is too late.
    assert.equal(linker.finish(first, verifier), null);
  });

  await check('a callback cannot be replayed', async () => {
    const { authorize } = await signIn('member');
    const again = await linker.complete(new URLSearchParams({ state: authorize.searchParams.get('state'), code: 'member' }));
    assert.deepEqual(again, { kind: 'expired' });
  });

  await check('saying no, a refused code and a stranger each say why', async () => {
    assert.equal(answer((await signIn(null)).outcome).get('error'), 'denied');
    assert.equal(answer((await signIn('bad')).outcome).get('error'), 'discord');
    assert.equal(answer((await signIn('stranger')).outcome).get('error'), 'not_member');
  });

  await check('the channel list is what the member and the bot can both post in, in server order', async () => {
    assert.deepEqual(await linker.postable(MEMBER), [
      {
        id: guild.id,
        name: 'Test Haven',
        channels: [
          { id: '900010', name: 'general', category: null },
          { id: '900030', name: 'tactics', category: 'Clan battles' },
        ],
      },
    ]);
    assert.deepEqual(await linker.postable(STRANGER), []);
  });

  const server = startHttpServer(
    linkClient,
    CONFIG,
    db,
    linker,
  );
  if (!server.listening) await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const as = (bearer) => ({ 'content-type': 'application/json', authorization: `Bearer ${bearer}` });
  const share = (channelId, bearer = token) =>
    fetch(`${base}/plan`, {
      method: 'POST',
      headers: as(bearer),
      body: JSON.stringify({ channelId, title: 'Hotspot - Page 1', image: TINY_PNG }),
    });

  await check('the whole sign-in works over HTTP', async () => {
    const start = await fetch(`${base}/link/start?port=50123&challenge=${challenge}`, { redirect: 'manual' });
    assert.equal(start.status, 302);
    const state = new URL(start.headers.get('location')).searchParams.get('state');

    const callback = await fetch(`${base}/link/callback?code=member&state=${state}`, { redirect: 'manual' });
    assert.equal(callback.status, 302);
    const grant = new URL(callback.headers.get('location')).searchParams.get('grant');

    const finish = await fetch(`${base}/link/finish`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ grant, verifier }),
    });
    assert.equal(finish.status, 200);
    const linked = await finish.json();

    const mine = await fetch(`${base}/link/me`, { headers: as(linked.token) });
    assert.equal(mine.status, 200);
    const body = await mine.json();
    assert.deepEqual(body.user, { id: MEMBER, name: 'Sye' });
    assert.equal(body.guilds[0].channels.length, 2);

    assert.equal((await fetch(`${base}/link/revoke`, { method: 'POST', headers: as(linked.token) })).status, 200);
    assert.equal((await fetch(`${base}/link/me`, { headers: as(linked.token) })).status, 401);
  });

  await check('a stale callback gets a page, not a redirect', async () => {
    const response = await fetch(`${base}/link/callback?code=member&state=never-issued`, { redirect: 'manual' });
    assert.equal(response.status, 400);
    assert.match(await response.text(), /expired/);
  });

  await check('a linked app posts where its owner can, under their name', async () => {
    const response = await share('900030');
    assert.equal(response.status, 200);
    assert.match((await response.json()).url, /\/900030\/1$/);
    assert.equal(sent.at(-1).id, '900030');
    assert.match(sent.at(-1).message.embeds[0].toJSON().footer.text, /^Shared by Sye /);
  });

  await check('a linked app cannot post where its owner cannot', async () => {
    const before = sent.length;
    for (const id of ['900020', '900040', '12345678']) {
      const response = await share(id);
      assert.equal(response.status, 403, `channel ${id}`);
    }
    assert.equal(sent.length, before);
  });

  await check('a token that was never issued posts nothing', async () => {
    assert.equal((await share('900030', 'x'.repeat(43))).status, 401);
    assert.equal((await fetch(`${base}/link/me`, { headers: as('x'.repeat(43)) })).status, 401);
  });

  await new Promise((resolve) => server.close(resolve));
  db.close();
}


let failed = 0;
for (const [ok, name, error] of results) {
  if (ok) {
    console.log(`  ok    ${name}`);
  } else {
    failed += 1;
    console.log(`  FAIL  ${name}`);
    console.log(`        ${error?.message ?? error}`);
  }
}
console.log(`\n${results.length - failed}/${results.length} checks passed`);
// Windows can hold a handle on a just-closed SQLite file for a moment. The
// directory is in temp either way, so a failure to remove it is not a failure
// of the run.
try {
  fs.rmSync(dir, { recursive: true, force: true });
} catch {
  console.log(`  (left ${dir} behind)`);
}

process.exit(failed === 0 ? 0 : 1);
