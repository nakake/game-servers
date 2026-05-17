# ADR 0002: MC サーバーの停止フローを Docker + SSM Run Command で構成する

- **Status**: Accepted
- **Date**: 2026-05-17
- **Deciders**: ryota
- **Related**: `docs/design.md` §5.3, §7.2 / `docs/phase0-results.md` トラブル #4 / [ADR 0001](0001-cloudflare-workers-over-lambda.md)

## Context

Phase 1 で Worker から Minecraft (ATM11) サーバーを **graceful に停止する** 経路を確定する必要がある。Phase 0 の検証で 2 つの実装上の問題が浮上した。

### Phase 0 で見えた問題

1. **`startserver.sh` の auto-restart ループ**
   ATM11 同梱の `startserver.sh` は MC プロセス終了後に自身を再起動するラッパループ構造。tmux に `stop` を送っても、MC が落ちた瞬間に `startserver.sh` が次のループで再起動する (詳細は `phase0-results.md` トラブル #4)。Phase 0 では `tmux kill-session` で回避したが、Phase 1 以降では Worker から駆動できる安定した停止経路が必要。

   > **後で判明**: `startserver.sh` には `ATM11_RESTART=false` の環境変数スイッチが標準装備で、これを渡せば auto-restart は無効化できる (2026-05-17 ADR 起票後に発見)。したがって「auto-restart 排除」単体は Docker 化の必須理由ではなくなった。Docker 化を維持する根拠は **複数ゲーム抽象化 / 依存閉じ込め / stop interface 統一** の 3 点に集約される。詳細は Decision Log 末尾。

2. **`design.md` §7.2 の「Worker → RCON 直叩き」が成立しにくい**
   原案は Worker から RCON プロトコルを直接話す前提だったが、(a) Cloudflare Workers の `connect()` API で RCON のバイナリプロトコルを自前実装するコスト、(b) RCON ポート (25575) を 0.0.0.0 に開放するセキュリティ負担、の 2 点が見落とされていた。

### 制約

- Worker から EC2 への接続経路は **HTTPS / AWS API のみ** (Workers Runtime の制限)
- `registry.json` (ATM11) は既に Docker + RCON 前提で書かれている (`container_image`, `ENABLE_RCON=true`, `RCON_PASSWORD_FROM_SSM`)
- ATM11 (NeoForge 26.1.2) は **Java 25 必須**。`itzg/minecraft-server` の公式タグに Java 25 はまだ無い (2026-05 時点)
- Spot 中断時にも graceful stop が走る必要 (interruption notice 2 分以内)

### 候補

**graceful stop の実体**

| 候補 | 仕組み |
|---|---|
| α. Docker `SIGTERM` trap (`docker stop`) | container 内の trap が `rcon save-all && rcon stop` を投げる |
| β. RCON コマンド直送 | 制御側から `save-all` → `stop` を順に送る |
| γ. `systemctl stop` (java 直起動) | systemd unit の ExecStop で rcon stop を呼ぶ |

**Worker → EC2 制御経路**

| 候補 | 仕組み | RCON ポート公開 |
|---|---|---|
| A. Workers `connect()` で RCON 直叩き | TCP socket + RCON プロトコル自前実装 | **必要** |
| B. SSM Run Command 経由 | `aws4fetch` で SSM API、EC2 内で `docker stop` 実行 | 不要 (localhost のみ) |
| C. sidecar HTTPS エンドポイント経由 | sidecar が `/stop` を受けて docker/rcon 実行 | 不要 |

## Decision

**`docker stop --time=60` を SSM Run Command 経由で発火し、container 内の trap が rcon graceful stop を実行する** 構成を採用する。

すなわち **α + B** の組み合わせ。

### 実装方針

#### 1. ATM11 の Docker 化 (Phase 1 の成果物)

`launcher/images/atm11/` 配下に Dockerfile を作成し、`ghcr.io/game-servers/atm11-server:26.1.2` として publish する。

```
launcher/images/atm11/
├─ Dockerfile              # FROM eclipse-temurin:25-jre
├─ entrypoint.sh           # NeoForge installer 実行 + trap 設定 + java exec
├─ rcon-stop.sh            # trap から呼ばれる graceful stop
└─ mods/, config/          # ATM11 配布物 (build 時に取り込む or volume mount)
```

`entrypoint.sh` の骨子:

```bash
#!/bin/bash
set -euo pipefail

# graceful stop trap
graceful_stop() {
  echo "[entrypoint] SIGTERM received, running rcon save-all && stop"
  /opt/scripts/rcon-stop.sh
  wait "$MC_PID"
}
trap graceful_stop SIGTERM

# NeoForge 起動 (run.sh ではなく直接 java を exec し auto-restart 排除)
java @user_jvm_args.txt @libraries/net/neoforged/neoforge/.../unix_args.txt nogui &
MC_PID=$!
wait "$MC_PID"
```

ポイント:
- **`startserver.sh` / `run.sh` ラッパは使わず java を直接起動** → auto-restart ループを構造的に排除
- **`exec` でなく `&` + `wait`** にすることで bash の trap が動く (`exec` だと bash プロセスが置き換わり trap が効かない)
- `rcon-stop.sh` は `mcrcon -H localhost -P 25575 -p "$RCON_PASSWORD" "save-all flush" "stop"` の薄いラッパ

#### 2. Worker → EC2 の制御経路 (SSM Run Command)

```typescript
// workers/discord-handler/src/lib/aws.ts (Phase 1 で実装)
async function stopGameViaSSM(instanceId: string, env: Env) {
  return await awsFetch('ssm', 'SendCommand', {
    InstanceIds: [instanceId],
    DocumentName: 'AWS-RunShellScript',
    Parameters: {
      commands: ['docker stop --time=60 mc'],
    },
    TimeoutSeconds: 90,
  }, env);
}
```

- Worker は AWS API (`ssm:SendCommand`) を `aws4fetch` で叩く
- EC2 上の SSM agent が `docker stop --time=60 mc` を実行
- `--time=60` で 60 秒の SIGTERM grace period → container 内 trap が rcon stop → save 完了後 java が exit → docker が container 終了を確認
- 60 秒で終わらない場合は SIGKILL に昇格 (ATM11 の save-all flush 実測 10〜30 秒なので 60 秒で十分なはず、Phase 1 で実測)

#### 3. AMI / IAM 要件

- **AMI**: Amazon Linux 2023 には SSM agent がプリインストール済み (Phase 0 で使った AL2023 そのまま)
- **EC2 instance role**: `AmazonSSMManagedInstanceCore` policy をアタッチ (`gs-ec2-instance-role` に追加)
- **Worker IAM ユーザー**: `ssm:SendCommand` + `ssm:GetCommandInvocation` (status 確認) を許可
- **RCON ポート**: Security Group では公開せず、container 内 `localhost:25575` のみ。`rcon-stop.sh` も container 内で完結

#### 4. 停止シーケンス全体 (改訂版)

```
[トリガー] Discord /stop / sidecar idle / cron fallback
   ▼
[Worker]
   1. SERVER_STATE.current から instance_id 取得
   2. SSM SendCommand: docker stop --time=60 mc
   3. SSM GetCommandInvocation で status=Success 待ち (polling, max 90s)
   4. EC2 stop (terminate ではなく) → EBS detach
   5. EBS Snapshot 作成 (tag: game=<id>, Purpose=game-world)
   6. Snapshot completed 待ち
   7. EC2 Terminate
   8. SERVER_STATE.current = null
   9. Discord webhook で停止通知
   ▼
[EC2 (SSM agent) → docker]
   docker stop --time=60 mc
     ├─ docker daemon が container に SIGTERM
     ├─ entrypoint.sh の trap 起動
     │     mcrcon → save-all flush
     │     mcrcon → stop
     ├─ java が exit (通常 10〜30 秒)
     └─ docker が container を Stopped に
```

## Consequences

### Positive

#### 1. RCON ポートを公開しない

- インターネット側に開放するのは **ゲームポート (25565) のみ**
- RCON は container 内 `localhost:25575`、SSM agent と同じ EC2 上の docker socket 経由でのみアクセス
- パスワード漏洩リスクが大幅に下がる

#### 2. Worker のコードが簡潔

- TCP socket / RCON プロトコル実装が不要
- AWS API は HTTPS なので `aws4fetch` の既存パターンに乗る
- Phase 1 の Worker 実装スコープが小さく済む

#### 3. registry.json / design.md (§5.3) と整合

- 既に Docker + RCON + SSM 参照 (`RCON_PASSWORD_FROM_SSM`) で書かれていた registry スキーマがそのまま動く
- design.md の AMI 設計 (`Docker でゲーム本体`) ともずれない

#### 4. auto-restart 問題の構造的解決

- `startserver.sh` を使わず java を直接起動するため、ラッパループは存在しない
- ATM11 modpack 更新で `startserver.sh` が変わっても影響を受けない (mod 本体だけ取り込めばよい)

#### 5. ゲーム別差異の閉じ込めが容易

- 他カテゴリ (Terraria, Valheim) も「container を `docker stop`」で統一できる
- container 内の trap でゲーム別の graceful stop コマンドを差し替えるだけ

#### 6. Spot 中断にも同じ経路で対応可能

- IMDS で interruption notice を検知した sidecar が EC2 内から `docker stop --time=90` を直接実行可
- Worker を経由しないので 2 分制約に余裕

### Negative / Trade-off

#### 1. Docker image ビルド・配布の運用コスト

- ATM11 mod 配布物 (約 350 MB) を image に焼くため image サイズが膨らむ
- modpack 更新の度に再ビルド + ghcr push が必要
- **緩和策**: mod/config は volume mount にして image には Java + entrypoint だけ入れる代替案あり (Phase 1 末で再評価)。S3 から mod tarball を起動時に取得する形式も検討

#### 2. SSM agent への依存

- AL2023 にプリインストール済みではあるが、SSM 障害時に停止経路が断たれる
- **緩和策**:
  - sidecar が独立して IMDS 監視 + `docker stop` 実行 → Worker 経路と冗長
  - Workers cron で「停止指示を出したのに状態が `running` のままなら警告」の死活監視を Phase 3 で追加

#### 3. SSM Run Command の権限管理

- Worker IAM ユーザーに `ssm:SendCommand` を渡す
- 誤動作で関係ない EC2 にコマンド送信されるリスク
- **緩和策**: IAM policy で `Resource: arn:aws:ec2:ap-northeast-1:*:instance/*` に `Condition: aws:ResourceTag/Project=game-servers` を必須化

#### 4. graceful stop 失敗時のフォールバックが必要

- container 内 trap が走らないケース (mcrcon バイナリ欠落、rcon password ミス等) で 60 秒タイムアウト → SIGKILL → world 破損リスク
- **緩和策**: Phase 1 で「rcon-stop.sh が exit 0 を返したか」のログを CloudWatch に出し、container 起動時に rcon 疎通テストを 1 回走らせる

#### 5. Docker image レイヤーキャッシュ戦略

- 350MB の modpack 層が cache hit しないと毎回 ghcr push に時間がかかる
- **緩和策**: Dockerfile で mods/ レイヤーを切り出し、libraries (NeoForge 依存) を別レイヤーに

### 中立

- ログは CloudWatch Logs (EC2 側) と Workers Logs の両方に残る (どちらの経路でも同じ)
- 起動シーケンス (§7.1) は変更なし。今回の決定は **停止** に閉じる

## Alternatives Considered

### A. Workers `connect()` で RCON 直叩き

**却下理由**:
- RCON プロトコル (Source RCON) を Workers 上で自前実装するコスト
- RCON ポートを 0.0.0.0 開放 = パスワード総当たり / Mojang Minecraft 既知の RCON 脆弱性露出
- Workers TCP socket は egress 専用、Cloudflare network 経由で Public IP に出る必要があり、レイテンシも増える

**残った優位点**: AWS リソース追加なし (SSM agent 不要)

### C. sidecar HTTPS エンドポイント経由

**却下理由**:
- Phase 1 完了時点で sidecar 実装が前提化する (本来 Phase 3 の責務)
- sidecar に TLS 証明書管理 + HMAC 認証が必要 = 攻撃面が増える
- Worker → sidecar の経路だけのために sidecar を作るのは責務肥大

**残った優位点**: AWS API に依存しない、sidecar の責務統合は将来再評価可

### α 以外の graceful stop 案

#### β. RCON コマンド直送 (Worker または SSM から `mcrcon` 実行)

**却下理由**:
- 「rcon save-all → 完了確認 → rcon stop → プロセス終了確認」の各ステップを呼び出し側が制御する必要
- save-all の完了を rcon の response からは確実に取れない (非同期) → sleep ベース推定になる
- Docker trap で書けば bash 1 ファイルで済む

**残った優位点**: Docker 化しない場合の最後の手段として有効

#### γ. `systemctl stop` (java 直起動)

**却下理由**:
- Docker 化を捨てる構成 → registry.json / design.md と不整合
- systemd unit をゲーム別に管理する負担が増える (registry 駆動から外れる)

**残った優位点**: Docker のオーバーヘッドを完全排除できる (今回の規模では meaningful でない)

## Migration Path

### Phase 1

- `launcher/images/atm11/` Dockerfile + entrypoint.sh + rcon-stop.sh
- `workers/discord-handler/src/lib/aws.ts` に SSM SendCommand ラッパ
- `gs-ec2-instance-role` に `AmazonSSMManagedInstanceCore` を追加
- 手動で AWS Console から SSM Run Command を試して動作確認 → Worker から駆動

### Phase 3

- sidecar が IMDS interruption notice を購読 → 自力で `docker stop --time=90` 発火
- Worker cron が「停止指示後 5 分経過しても EC2 が running」なら force terminate (フォールバック)

### Phase 4

- Terraform で SSM Document `AWS-RunShellScript` 専用バージョンを管理 (Run Command の history を残す)
- `Resource: aws:ResourceTag/Project=game-servers` 制限を IAM policy に焼き込み

### 撤退戦略 (この決定が破綻したら)

- SSM Run Command が頻繁に失敗するようなら → sidecar HTTPS (C 案) に移行
- Docker のオーバーヘッドが致命的に効くなら → systemd unit (γ 案) に切替、ただし registry スキーマ修正が必要

## Decision Log

| 日付 | 出来事 |
|---|---|
| 2026-05-17 | Phase 0 完了時に `startserver.sh` の auto-restart 問題を発見 |
| 2026-05-17 | design.md §7.2 の「RCON 直叩き」を再評価 → Docker + SSM 構成に変更決定 |
| 2026-05-17 | Dockerfile 着手時に `ATM11_RESTART=false` で auto-restart を無効化できることが判明。Docker 化の根拠 #1 (auto-restart 排除) が弱まったが、ゲーム抽象化 / 依存閉じ込め / stop interface 統一の 3 点で Decision は維持。Phase 2 以降に新ゲーム追加コスト・docker メモリオーバーヘッドが想定外に大きければ再評価する。 |

## References

- AWS SSM Run Command: https://docs.aws.amazon.com/systems-manager/latest/userguide/run-command.html
- Docker stop signal handling: https://docs.docker.com/engine/reference/commandline/stop/
- mcrcon: https://github.com/Tiiffi/mcrcon
- NeoForge `unix_args.txt` 起動方式: https://docs.neoforged.net/docs/gettingstarted/server/
- itzg/minecraft-server entrypoint (参考実装): https://github.com/itzg/docker-minecraft-server/blob/master/scripts/start
