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

const commands = [
  {
    name: 'list',
    description: '登録済み game サーバーの一覧を表示',
    type: 1, // CHAT_INPUT
  },
  {
    name: 'start',
    description: 'game サーバーを起動 (EBS snapshot から復元)',
    type: 1,
    options: [
      {
        name: 'game',
        description: '起動する game の ID (例: atm11)',
        type: 3, // STRING
        required: true,
        choices: [{ name: 'All The Mods 11 (atm11)', value: 'atm11' }],
      },
    ],
  },
  {
    name: 'stop',
    description: '起動中の game サーバーを停止 (snapshot 作成後 terminate)',
    type: 1,
    options: [
      {
        name: 'game',
        description: '停止する game の ID (省略時は atm11)',
        type: 3,
        required: false,
        choices: [{ name: 'All The Mods 11 (atm11)', value: 'atm11' }],
      },
    ],
  },
  {
    name: 'status',
    description: '現在 running な game サーバーの状態を表示',
    type: 1,
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
