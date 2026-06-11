# アーキテクチャ図

最終更新: 2026-06-11 (Phase 7 E-2 時点、branch `phase7-webui`)

システムの全体像と主要フローを Mermaid で図示する。設計の背景・判断理由は
`docs/design.md` と `docs/adr/` を参照。

## 1. 全体構成

制御プレーン = Cloudflare Workers、実行プレーン = AWS EC2 Spot。
AWS への認証は OIDC (長期キーなし)、AWS/OIDC 秘密鍵は discord-handler のみが持ち、
admin-webui は Service Binding RPC で操作を委譲する。

```mermaid
flowchart TB
    admin["管理者"]
    players["プレイヤー"]

    subgraph discord["Discord"]
        slash["Slash Commands<br>/start /stop /status /list /backup /panel"]
        notify["通知チャンネル (webhook)"]
    end

    browser["ブラウザ (管理 SPA)"]
    cfapi["CurseForge API"]

    subgraph cloudflare["Cloudflare — 制御プレーン"]
        dh["Worker: discord-handler<br>orchestrator / OIDC issuer / InternalRpc"]
        aw["Worker: admin-webui<br>gs-admin.nakake.com<br>SPA 配信 + /admin/api"]
        kv[("Workers KV<br>GAME_REGISTRY / SERVER_STATE")]
        cron["Cron Triggers<br>idle fallback / snapshot retention<br>volume cleanup"]
        cfdns["Cloudflare DNS<br>ゲーム別サブドメイン A レコード"]
    end

    subgraph aws["AWS — 実行プレーン (ap-northeast-1)"]
        sts["STS<br>AssumeRoleWithWebIdentity"]
        ssm["SSM<br>Run Command / Parameter Store"]
        subgraph ec2["EC2 Spot Instance — 汎用 AMI 1 個"]
            launcher["cloud-init → universal-launcher"]
            game["game container<br>itzg/minecraft-server 等"]
            sidecar["sidecar container<br>idle 検知 / heartbeat"]
        end
        ebs[("EBS gp3<br>world データ")]
        snap[("EBS Snapshot<br>世代管理は registry 設定")]
        s3[("S3<br>configs / modpacks / backups")]
        sns["SNS gs-alerts"]
        src["EventBridge / AWS Budgets"]
    end

    %% Discord 経路
    admin --> slash
    slash -->|"POST /discord/interaction<br>(ed25519 署名検証)"| dh
    dh -->|"webhook 通知"| notify

    %% WebUI 経路
    admin -->|"/panel で magic link 取得"| browser
    browser -->|"session cookie"| aw
    aw -->|"Service Binding RPC<br>start / stop / status"| dh
    aw -->|"modpack 検索 proxy"| cfapi
    aw -->|"registry 読み書き"| kv
    aw -->|"新規 game の A レコード作成"| cfdns

    %% discord-handler の依存
    dh <--> kv
    cron --> dh
    dh -->|"起動時 A レコード更新"| cfdns
    dh -->|"OIDC JWT (RS256)"| sts
    sts -->|"15min 短期 credentials"| dh
    dh -->|"aws4fetch<br>CreateFleet / Terminate / CreateSnapshot"| ec2
    dh -->|"docker stop (graceful)"| ssm
    ssm --> game

    %% EC2 内部
    launcher --> game
    launcher --> sidecar
    launcher -->|"config sync"| s3
    game --- ebs
    snap -.->|"起動時: 最新世代から復元"| ebs
    dh -.->|"/stop 時: CreateSnapshot"| snap
    sidecar -->|"HMAC<br>heartbeat / idle-detected / registry"| dh

    %% 通知集約
    src --> sns
    sns -->|"POST /aws/notification"| dh

    %% プレイヤー接続
    players -->|"DNS 解決"| cfdns
    players -->|"ゲーム接続 (TCP/UDP) 直結"| game
```

補足:

- AWS IAM 側に OIDC provider を置き、discord-handler 自身が JWKS endpoint を公開する
  issuer を兼ねる (trust policy condition は `aud` + `sub`)。長期 Access Key は存在しない。
- ゲーム固有ロジックは Worker に置かず、KV の `GAME_REGISTRY` (source of truth は
  `games/<id>/registry.json`) と sidecar 内 adapter に閉じる。
- Elastic IP は使わず、起動のたびに public IP を取得して DNS A レコードを更新する。

## 2. 起動シーケンス (`/start <game>`)

```mermaid
sequenceDiagram
    autonumber
    actor U as ユーザー
    participant D as Discord
    participant W as discord-handler
    participant KV as Workers KV
    participant A as AWS API
    participant E as EC2 Spot
    participant S as sidecar
    participant DNS as Cloudflare DNS

    U->>D: /start atm11
    D->>W: POST /discord/interaction
    W->>W: ed25519 署名検証
    W->>KV: SERVER_STATE.current 確認 (排他)
    W-->>D: deferred response (3 秒以内必須)
    Note over W: 以降は ctx.waitUntil で非同期実行
    W->>KV: GAME_REGISTRY から GameDefinition 取得
    W->>A: OIDC JWT → STS AssumeRoleWithWebIdentity
    W->>A: 最新 EBS snapshot 検索 (Game タグ)
    W->>A: CreateFleet (Spot / LaunchTemplate)
    A->>E: instance 起動
    E->>E: cloud-init → universal-launcher<br>EBS mount / S3 config sync<br>docker compose up (game + sidecar)
    W->>A: running まで polling → public IP 取得
    W->>DNS: A レコード更新 (atm11 サブドメイン → IP)
    W->>KV: SERVER_STATE.current 更新
    W-->>D: webhook で起動完了通知
    S->>W: GET /sidecar/registry (HMAC)
    loop idle 監視 (1 分間隔)
        S->>S: RCON 等でプレイヤー数確認
        S->>W: POST /sidecar/heartbeat (HMAC)
    end
```

## 3. 停止シーケンス (4 トリガー共通の `runStopWorkflow`)

```mermaid
sequenceDiagram
    autonumber
    participant T as 停止トリガー
    participant W as discord-handler
    participant SSM as SSM Run Command
    participant G as game container
    participant A as AWS API
    participant KV as Workers KV
    participant D as Discord

    Note over T: 1. Discord /stop<br>2. sidecar idle 検知 (0 人 timeout_min 分)<br>3. Worker Cron フォールバック<br>4. WebUI (InternalRpc 経由)
    T->>W: runStopWorkflow
    W->>SSM: SendCommand: docker stop --time=60 mc
    SSM->>G: SIGTERM
    G->>G: entrypoint trap → rcon save-all / stop → exit
    W->>SSM: GetCommandInvocation (Success 待ち max 90s)
    W->>A: CreateSnapshot (data volume / Game タグ)
    W->>A: TerminateInstances
    W->>KV: SERVER_STATE.current = null
    W-->>D: 停止通知 (webhook)
    Note over W: 後続: Cron snapshot-retention が<br>registry の generations 超過分を削除
```

ゲーム別の graceful stop コマンドは container 内 `entrypoint.sh` の trap に閉じており、
Worker は常に `docker stop` を発行するだけでよい (ADR 0002)。

## 4. 管理 WebUI フロー (Phase 7)

認証は Discord `/panel` 起点の magic link (one-shot token、TTL 300s、ephemeral 応答)。
AWS 操作は admin-webui からは行わず、Service Binding 経由の InternalRpc で
discord-handler に委譲する (外部 URL からは到達不可)。

```mermaid
sequenceDiagram
    autonumber
    actor U as 管理者
    participant D as Discord
    participant W as discord-handler
    participant B as ブラウザ (SPA)
    participant AW as admin-webui
    participant CF as CurseForge API
    participant KV as Workers KV

    U->>D: /panel
    D->>W: interaction
    W->>KV: one-shot token 保存 (TTL 300s)
    W-->>D: ephemeral message + link button
    U->>B: link を開く
    B->>AW: GET /auth?t=token
    AW->>KV: token 検証 (one-shot 消費) + tier 判定
    AW-->>B: session cookie 発行 → SPA 表示
    B->>AW: GET /admin/api/modpacks/search
    AW->>CF: 検索 proxy (API key は Worker 内に隠蔽)
    B->>AW: POST /admin/api/games (新規ゲーム追加)
    AW->>KV: registry 投入 + DNS A レコード作成
    B->>AW: POST /admin/api/games/:id/start
    AW->>W: InternalRpc start (Service Binding)
    W-->>AW: 受付応答 (本体は waitUntil で fire-and-forget)
    loop 完了確認
        B->>AW: status polling
        AW->>W: InternalRpc status
    end
```

## 関連ドキュメント

- `docs/design.md` — 全体設計・コスト試算・フェーズ計画
- `docs/adr/0002-mc-stop-flow-docker-ssm.md` — 停止フローの Docker + SSM 化
- `docs/adr/0003`〜`0004` — WebUI 認証 / Worker 分離の判断
- `docs/runbook-phase5-oidc.md` — OIDC 運用手順
