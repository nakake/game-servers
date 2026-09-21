// runStartWorkflow — game サーバーを起動する Discord 非依存コア (Phase 7 E-1)。
//
// 元は handlers/discord/start.ts の executeStart に閉じていた処理を、Discord (follow-up /
// interaction / pending-ready) から切り離して抽出した。これにより同じ起動フローを
//   - Discord `/start` ハンドラ (handlers/discord/start.ts、進捗を follow-up edit に流す)
//   - admin-webui からの Service Binding RPC (internal-rpc.ts InternalRpc.start)
// の両方から呼べる (ADR 0004 / docs §6.1)。AWS/OIDC 鍵を使う実装は discord-handler 内に
// 閉じたまま — admin-webui には複製しない。
//
// 進捗は onProgress コールバックに流す (Discord 版は follow-up edit、RPC は省略)。
// 戻り値は discriminated union で、呼び出し側が状況別に整形 + 後処理 (pending-ready 等) する。
// 挙動は抽出前の executeStart を完全に保持する (テスト網が無いため構造保存で移植)。

import {
  AwsApiClient,
  describeInstancesByTag,
  getAwsCredentials,
  getLatestCompletedSnapshot,
  getLatestSnapshot,
  runInstances,
  waitForInstanceRunning,
  waitForSnapshotCompleted,
} from '../aws/index.js';
import { CloudflareDnsClient } from '../cloudflare/index.js';
import { base64EncodeUserData, buildUserData } from '../launcher/user-data.js';
import type { GameDefinition } from '../registry/types.js';
import type { Env } from '../../env.js';

export interface RunStartWorkflowOptions {
  // 進捗を呼び出し側に出すコールバック。Discord は follow-up edit、RPC は通常省略。
  // 失敗しても workflow を止めない (wrapProgress 内で catch)。
  onProgress?: (message: string) => Promise<void> | void;
}

export type StartWorkflowResult =
  | {
      status: 'started';
      instanceId: string;
      publicIp: string;
      fqdn: string;
      port: number;
    }
  | {
      // Game タグで既に running/pending な instance が居た (重複起動防止)。
      status: 'already-running';
      instanceId: string;
      state: string;
      publicIp?: string;
    }
  | { status: 'failed'; error: string };

export async function runStartWorkflow(
  env: Env,
  ctx: ExecutionContext,
  game: GameDefinition,
  opts: RunStartWorkflowOptions = {},
): Promise<StartWorkflowResult> {
  const gameId = game.game_id;
  const progress = wrapProgress(opts.onProgress);

  const cf = new CloudflareDnsClient({ apiToken: env.CLOUDFLARE_DNS_API_TOKEN });

  try {
    // 認証取得も try の中に入れ、失敗時は throw ではなく status: 'failed' を返す
    // (Discord は follow-up をエラー文言に更新でき、RPC の waitUntil も reject しない)。
    const credentials = await getAwsCredentials(env, ctx);
    const ec2 = new AwsApiClient({
      region: env.AWS_REGION ?? 'ap-northeast-1',
      credentials,
    });

    // 1. 重複起動チェック (Game タグで running/pending を検索)
    const existing = await describeInstancesByTag(ec2, { Game: gameId });
    if (existing.length > 0 && existing[0] !== undefined) {
      const inst = existing[0];
      return {
        status: 'already-running',
        instanceId: inst.instanceId,
        state: inst.state,
        ...(inst.publicIp !== undefined ? { publicIp: inst.publicIp } : {}),
      };
    }

    // 2. 復元元 snapshot を決める。最新の game-world snapshot を state 問わず取得し:
    //      completed → そのまま使用
    //      pending   → completed まで待機 (/stop と /start が重なった時の保険。通常は
    //                  /stop 側が完成を見届けてから終わるのでここは通らない)
    //      その他    → 最新の completed snapshot にフォールバック
    //    snapshot が 1 つも無ければ env seed (= 初回起動時の Phase 0 snapshot)。
    const snapshotTags = { Game: gameId, Purpose: 'game-world' };
    const seedSnapshotId = game.seed_snapshot_id ?? undefined;
    const latest = await getLatestSnapshot(ec2, snapshotTags);
    let snapshotId: string | undefined;
    let snapshotNote: string;
    if (latest === undefined) {
      snapshotId = seedSnapshotId;
      snapshotNote = describeSeed(seedSnapshotId);
    } else if (latest.state === 'completed') {
      snapshotId = latest.snapshotId;
      snapshotNote = `latest \`${snapshotId}\` (${latest.startTime})`;
    } else if (latest.state === 'pending') {
      // 直近の /stop snapshot がまだ完成していない。一つ前に巻き戻さず完成を待つが、
      // Worker の実行時間制限があるので最大 120s で打ち切り、超えたら最新 completed に
      // フォールバックする (通常は /stop からしばらく経ってから /start するので待ちは発生しない)。
      await progress(
        `⏳ 直近の停止 snapshot \`${latest.snapshotId}\` を完成待ち中… (${latest.progress})`,
      );
      try {
        await waitForSnapshotCompleted(ec2, {
          snapshotId: latest.snapshotId,
          timeoutMs: 120_000,
          pollIntervalMs: 5000,
        });
        snapshotId = latest.snapshotId;
        snapshotNote = `latest \`${snapshotId}\` (完成待ち後)`;
      } catch (err) {
        console.error('waitForSnapshotCompleted failed, falling back:', err);
        const completed = await getLatestCompletedSnapshot(ec2, snapshotTags);
        snapshotId = completed?.snapshotId ?? seedSnapshotId;
        snapshotNote =
          completed !== undefined
            ? `fallback latest completed \`${completed.snapshotId}\``
            : describeSeed(seedSnapshotId);
      }
    } else {
      // error / recoverable / recovering — 最新の completed にフォールバック。
      const completed = await getLatestCompletedSnapshot(ec2, snapshotTags);
      snapshotId = completed?.snapshotId ?? seedSnapshotId;
      snapshotNote =
        completed !== undefined
          ? `latest completed \`${completed.snapshotId}\` (最新 snapshot は ${latest.state})`
          : describeSeed(seedSnapshotId);
    }
    await progress(`⏳ snapshot 確定: ${snapshotNote}、EC2 起動中…`);

    // user-data 生成 (EBS mount → image 準備 → SSM から RCON pw → docker run)。
    // ゲーム差 (build/pull、blank EBS の要否) は buildUserData が registry から判断する。
    const awsRegion = env.AWS_REGION ?? 'ap-northeast-1';
    const fqdn = `${game.subdomain}.${env.CLOUDFLARE_BASE_DOMAIN}`;
    const userData = base64EncodeUserData(
      buildUserData({
        game,
        awsRegion,
        formatBlankVolume: snapshotId === undefined,
        fqdn,
        workerPublicUrl: env.WORKER_PUBLIC_URL,
        ...(env.SIDECAR_IMAGE_REF !== undefined && env.SIDECAR_IMAGE_REF !== ''
          ? { sidecarImage: env.SIDECAR_IMAGE_REF }
          : {}),
        ...(env.SNS_ALLOWED_TOPIC_ARN !== undefined &&
        env.SNS_ALLOWED_TOPIC_ARN !== ''
          ? { readyNotifySnsTopicArn: env.SNS_ALLOWED_TOPIC_ARN }
          : {}),
      }),
    );

    // 4. RunInstances — Launch Template (gs-game-server) 経由で起動 (IaC 移行 Step 5)。
    //    AMI / Key / SG / IAM profile / Spot 設定 / EBS base / 静的タグは LT 側で定義済み。
    //    ここではゲーム別の値だけ override する:
    //      - instanceType : registry の instance_types[0]
    //      - subnetId     : LT には含めない (default VPC の subnet を Worker が指定)
    //      - userData     : LT は空、Worker が生成して渡す
    //      - blockDeviceMappings : /dev/sdf を全フィールド指定で渡す。snapshotId / volumeSize
    //        はゲーム別。volumeType / deleteOnTermination も明示する — LT に同名 device が
    //        あっても request 側の device 指定が優先されるため、deleteOnTermination=false
    //        (world データ保護) を LT 任せにせず必ずここで指定する。
    //      - instanceTags / volumeTags : LT の静的タグとマージされるが、Project は Worker 側でも
    //        必ず付ける — gs-worker-caller の ssm:SendCommand が aws:ResourceTag/Project に
    //        条件付けされており /stop が依存するため、マージ挙動に賭けない。
    const primaryInstanceType = game.instance_types[0] ?? 'r7a.large';
    const result = await runInstances(ec2, {
      launchTemplate: {
        launchTemplateId: env.EC2_LAUNCH_TEMPLATE_ID,
        version: '$Latest',
      },
      instanceType: primaryInstanceType,
      subnetId: env.EC2_SUBNET_ID,
      userData,
      instanceTags: {
        Project: 'game-servers',
        Game: gameId,
        Env: 'prod',
        Name: `gs-${gameId}`,
      },
      volumeTags: {
        Project: 'game-servers',
        Game: gameId,
        Env: 'prod',
        Purpose: 'game-world',
      },
      blockDeviceMappings: [
        {
          deviceName: '/dev/sdf',
          ebs: {
            // snapshotId 未指定 = blank volume (user-data が mkfs.ext4 する)
            ...(snapshotId !== undefined ? { snapshotId } : {}),
            volumeSize: game.ebs_size_gb,
            volumeType: 'gp3',
            deleteOnTermination: false,
          },
        },
      ],
    });
    const instanceId = result.instances[0]?.instanceId;
    if (instanceId === undefined) {
      return { status: 'failed', error: 'RunInstances returned no instance' };
    }

    await progress(`⏳ EC2 \`${instanceId}\` 起動中… (running + public IP 待ち)`);

    // 3. running + public IP 取得まで待機
    const inst = await waitForInstanceRunning(ec2, {
      instanceId,
      timeoutMs: 240_000,
      pollIntervalMs: 5000,
    });

    if (inst.publicIp === undefined) {
      return {
        status: 'failed',
        error: 'instance is running but no public IP assigned',
      };
    }

    // 4. Cloudflare DNS 更新
    await cf.updateRecord({
      zoneId: env.CLOUDFLARE_ZONE_ID,
      recordId: game.cf_record_id,
      type: 'A',
      name: fqdn,
      content: inst.publicIp,
      ttl: 60,
      proxied: false,
      comment: `gs-${gameId} ${new Date().toISOString()}`,
    });

    const port = game.ports[0]?.port ?? 25565;
    return {
      status: 'started',
      instanceId,
      publicIp: inst.publicIp,
      fqdn,
      port,
    };
  } catch (err) {
    return {
      status: 'failed',
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

// snapshot が 1 つも無いときの note 文言 (registry の seed を使うか blank EBS か)。
function describeSeed(seedSnapshotId: string | undefined): string {
  return seedSnapshotId !== undefined
    ? `registry seed \`${seedSnapshotId}\` (初回起動)`
    : 'blank EBS (初回起動、空ボリュームを mkfs)';
}

function wrapProgress(
  cb: RunStartWorkflowOptions['onProgress'],
): (message: string) => Promise<void> {
  return async (message: string): Promise<void> => {
    console.log(`[start-workflow] ${message}`);
    if (cb === undefined) return;
    try {
      await cb(message);
    } catch (err) {
      console.error('start-workflow onProgress callback failed:', err);
    }
  };
}
