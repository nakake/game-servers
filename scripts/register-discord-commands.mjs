// Discord slash command 一括登録 (Phase 1)。
//
// 使い方:
//   # 開発 (特定 guild にだけ登録、即時反映):
//   DISCORD_BOT_TOKEN=xxx DISCORD_APPLICATION_ID=yyy DISCORD_GUILD_ID=zzz \
//     node scripts/register-discord-commands.mjs
//
//   # 本番 (global 登録、反映に最大 1 時間):
//   DISCORD_BOT_TOKEN=xxx DISCORD_APPLICATION_ID=yyy \
//     node scripts/register-discord-commands.mjs --global
//
// 環境変数:
//   DISCORD_BOT_TOKEN       Bot Token (Developer Portal の Bot → Reset Token)
//   DISCORD_APPLICATION_ID  Application ID (Developer Portal の General Information)
//   DISCORD_GUILD_ID        対象 Guild ID (右クリック → Copy Server ID)、--global 時は不要
//
// `PUT /applications/{app_id}/commands` (global) または
// `PUT /applications/{app_id}/guilds/{guild_id}/commands` (guild) で既存を全置換する.

const token = mustEnv('DISCORD_BOT_TOKEN');
const appId = mustEnv('DISCORD_APPLICATION_ID');
const guildId = process.env.DISCORD_GUILD_ID;
const isGlobal = process.argv.includes('--global');

if (!isGlobal && !guildId) {
  console.error(
    'Either set DISCORD_GUILD_ID for guild-scoped registration, or pass --global for global.',
  );
  process.exit(1);
}

// integration_types: [0] = Guild Install のみ。
// Developer Portal で User Install も有効だと default で [0, 1] になり、
// 同じ guild に user-app としても入れているユーザーには picker で 2 つずつ表示されてしまう。
// game サーバー制御は guild 内でしか意味がないので guild 限定で固定する。
const GUILD_INSTALL_ONLY = [0];

const commands = [
  {
    name: 'list',
    description: '登録済み game サーバーの一覧を表示',
    type: 1, // CHAT_INPUT
    integration_types: GUILD_INSTALL_ONLY,
  },
  {
    name: 'start',
    description: 'game サーバーを起動 (EBS snapshot から復元)',
    type: 1,
    integration_types: GUILD_INSTALL_ONLY,
    options: [
      {
        name: 'game',
        description: '起動する game の ID',
        type: 3, // STRING
        required: true,
        // 候補は静的 choices ではなく autocomplete で GAME_REGISTRY KV から動的に出す。
        // ゲーム追加でこのスクリプトの再実行が不要になる (Phase 2)。
        autocomplete: true,
      },
    ],
  },
  {
    name: 'stop',
    description: '起動中の game サーバーを停止 (snapshot 作成後 terminate)',
    type: 1,
    integration_types: GUILD_INSTALL_ONLY,
    options: [
      {
        name: 'game',
        description: '停止する game の ID',
        type: 3,
        required: true,
        autocomplete: true,
      },
    ],
  },
  {
    name: 'status',
    description: '現在 running な game サーバーの状態を表示',
    type: 1,
    integration_types: GUILD_INSTALL_ONLY,
  },
];

const url = isGlobal
  ? `https://discord.com/api/v10/applications/${appId}/commands`
  : `https://discord.com/api/v10/applications/${appId}/guilds/${guildId}/commands`;

console.log(`PUT ${url}`);
console.log(`Registering ${commands.length} commands (${isGlobal ? 'global' : `guild=${guildId}`})...`);

const response = await fetch(url, {
  method: 'PUT',
  headers: {
    'authorization': `Bot ${token}`,
    'content-type': 'application/json',
  },
  body: JSON.stringify(commands),
});

const text = await response.text();
if (!response.ok) {
  console.error(`FAIL (HTTP ${response.status}):`);
  console.error(text);
  process.exit(1);
}

const registered = JSON.parse(text);
console.log(`OK: registered ${registered.length} commands:`);
for (const cmd of registered) {
  console.log(`  /${cmd.name} (id=${cmd.id})`);
}

if (isGlobal) {
  console.log('\nNote: global commands take up to 1 hour to propagate.');
} else {
  console.log('\nNote: guild commands are visible immediately.');
}

function mustEnv(name) {
  const value = process.env[name];
  if (!value) {
    console.error(`Missing environment variable: ${name}`);
    process.exit(1);
  }
  return value;
}
