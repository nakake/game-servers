# Phase 0 検証結果

計測日: 2026-05-17
測定者: ryota

## 環境

| 項目 | 値 |
|---|---|
| インスタンスタイプ | m7a.xlarge (4 vCPU / 16 GiB) |
| 購入方式 | Spot |
| AZ | ap-northeast-1a |
| AMI | Amazon Linux 2023 (resolve:ssm:/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-x86_64) |
| Java | Amazon Corretto 25.0.3 LTS |
| Docker | 25.0.14 (今回は未使用、直接 java 実行) |
| Minecraft | 1.21.x (ATM11) |
| NeoForge | 26.1.2.48-beta |
| JVM | -Xms10G -Xmx10G -XX:+UseZGC -XX:+AlwaysPreTouch -XX:+DisableExplicitGC ... |
| EBS | gp3 30 GiB, ext4, /opt/atm11 マウント |

## 計測結果

| 指標 | 値 | 目標 | 判定 |
|---|---|---|---|
| 起動時間 | **44.0 秒** (ModernFix 計測) | < 90 秒 | ✅ |
| TPS (last 5s) | 20.0 | 20.0 | ✅ |
| TPS (last 1m) | 20.0 | 20.0 | ✅ |
| TPS (last 5m) | 20.0 | 20.0 | ✅ |
| TPS (last 15m) | 17.18 | - | (起動時間込み) |
| mspt min (last 10s) | 3.8 ms | - | - |
| mspt 中央値 (last 10s) | **5.0 ms** | < 50 ms | ✅ |
| mspt 95%ile (last 10s) | 5.8 ms | < 50 ms | ✅ |
| mspt max (last 10s) | 6.9 ms | < 100 ms | ✅ |
| mspt 中央値 (last 1m) | 5.0 ms | < 50 ms | ✅ |
| mspt max (last 1m) | 7.8 ms | < 100 ms | ✅ |
| JVM プロセス RSS | **11.06 GB** | < 14 GB | ✅ |
| システム空きメモリ | 3.4 GiB | > 1 GiB | ✅ |
| CPU process (1m avg) | 3% | < 50 % | ✅ |
| CPU system (1m avg) | 1% | < 50 % | ✅ |
| Disk 使用量 | 2.3 GB / 29.4 GB | < 25 GB | ✅ |
| プレイヤー数 | 1 人 | - | - |
| Spot 中断 | なし | - | ✅ |
| Allocation stall (ZGC) | なし | - | ✅ |
| 接続成功 | ✅ | - | ✅ |

## spark プロファイル

- ファイル: `/opt/atm11/config/spark/profile-2026-05-17_07.20.10.sparkprofile`
- ビューワ URL: https://spark.lucko.me/SSPmTh79gs (bytebin にアップロード済み)
- ホットスポット: 標準 MC エンジン (Entity tick, Chunk handling, Pathfinding, EventBus dispatch)
- mod 起因の異常なし

## 判定: インスタンス確定

m7a.xlarge は **明らかに過剰**(CPU 使用率 3%)。Phase 1 では RAM 維持しつつ CPU を削る:

### Phase 1 推奨スペック

```yaml
instance_types:           # EC2 Fleet 優先順
  - r7a.large             # 第一候補 (2 vCPU, 16 GB, ¥6/h)
  - r6a.large             # フォールバック (同等, ¥5/h)
  - m7a.xlarge            # 確実に動く保険 (4 vCPU, ¥9/h)
ebs_size_gb: 30
spot_max_price_jpy_per_hour: 12
```

### games/atm11/registry.json への反映

```diff
- "instance_types": [
-   "m7a.xlarge",
-   "m7i.xlarge",
-   "m6a.xlarge"
- ],
+ "instance_types": [
+   "r7a.large",
+   "r6a.large",
+   "m7a.xlarge"
+ ],
```

## EBS snapshot 復元検証

実施日: 2026-05-17 (Step 6 完了)

### 手順実績

1. 計測終了後、元 EC2 を `stop` → unmount → EBS snapshot 作成 → 元 EC2 terminate → 元 EBS delete
2. snapshot から新 EBS volume を `ap-northeast-1a` に作成
3. `gs-phase0-lt` Launch Template から新 EC2 を spot で起動 (m7a.xlarge)
4. 新 EBS を `/dev/sdf` で attach
5. SSH ログイン → **`mkfs` 実行せず** mount

### 検証結果

| 確認項目 | 結果 |
|---|---|
| FS タイプ保持 | `file -s /dev/nvme1n1` → ext4 filesystem ✅ |
| volume label 保持 | `atm11-world` ✅ |
| UUID 保持 | `adc417b1-fa94-4516-8d24-0c08ba561817` ✅ |
| ディスク使用量 | 843 MB / 30 GB (計測時と同一) ✅ |
| world/level.dat 残存 | 3134 bytes, mtime 計測時と一致 ✅ |
| ops.json / usercache.json | 保持 ✅ |
| mods / config / libraries | 全保持 ✅ |
| 全 dimension 読み込み | aether_holy_isles, the_beyond, DIM-1, the_other, mining, DIM1, spatial_storage 全成功 ✅ |
| 起動成功 | `Done (0.881s)! For help, type "help"` ✅ |
| ModernFix 起動時間 | **44.314 秒** (元計測 44.0 秒、誤差内) ✅ |
| Mod 初期化 | journeymap / Silent Gear / FTB Ranks 等すべて成功 ✅ |
| player backup task | 起動 (player data 読込成功) ✅ |

**判定**: snapshot 復元 → 別 EC2 で再起動 → world 正常読み込み まで完全成功。Phase 1 以降の「停止時 snapshot → 起動時 snapshot から復元」フローの実現性が確認できた。

### Phase 1 以降への注意点

- **startserver.sh は auto-restart ラッパで包まれている**: tmux に `stop` を送ると MC は停止するが、`startserver.sh` が次のループで再起動する。Phase 1 で graceful stop を Worker から駆動する設計では、以下のいずれかが必要:
  - tmux session ごと kill する (`tmux kill-session`)
  - startserver.sh を経由せず直接 `java @user_jvm_args.txt ...` を起動する
  - registry.json に「stop コマンド体系」を持たせ、ゲーム別にやり方を分岐
- **RCON を有効化**: 今回は tmux send-keys で stop を送ったが、Phase 1 では RCON 経由が標準。`server.properties` で `enable-rcon=true` と RCON パスワードを SSM から取得する設計に。
- Mount は **EBS attach 後の手動 mount** で運用、`fstab` には書かない方が安全 (snapshot 復元時の取り違え事故防止)。

## トラブル履歴

1. **Launch Template 作成時に "fail to request credential"**
   - 原因: 新規アカウント直後の伝搬遅延 (AMI カタログ取得失敗)
   - 対処: AMI ID 欄に `resolve:ssm:/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-x86_64` を直接入力

2. **起動後 SSH 接続できず (Connection timed out)**
   - 原因: Launch Template の Network settings 確認画面で default SG が紛れ込み、`gs-phase0-sg` が外れた
   - 対処: EC2 → Actions → Security → Change security groups で `gs-phase0-sg` のみに置換
   - 再発防止: Phase 4 で Terraform 化、Launch Template Network Interface を厳格指定

3. **`/spark` コマンドが権限エラー**
   - 原因: ops.json 空、誰も OP 未登録
   - 対処: サーバーコンソール (tmux) で `op <playername>` 実行

4. **Step 6 復元検証中: tmux に `stop` を送ったが startserver.sh が auto-restart**
   - 原因: `startserver.sh` が MC プロセス終了後に再起動するループ構造
   - 対処: `tmux kill-session -t mc` で session ごと終了
   - 注意: `pkill -f "java"` を SSH 経由で呼ぶとコマンド文字列に "java" を含む shell 自身も殺すので NG
   - Phase 1 反映: 上記「Phase 1 以降への注意点」参照

## 次フェーズへの引き継ぎ事項

- [x] `games/atm11/registry.json` の `instance_types` を Phase 1 候補に更新 (commit b4ebb3d)
- [x] Phase 0 で見えた問題 (#1, #2, #4) を runbook.md に追記
- [ ] Phase 1 着手時、r7a.large で同じ計測をやり直して比較
- [ ] `spark profiler --timeout 300 --upload` を試して URL を直接得る経路を確立
- [ ] 複数プレイヤー (3〜4 人) 時の mspt を Phase 1 末で計測
- [ ] Mob 農場稼働時の負荷増を計測 (高負荷シナリオ)
- [ ] Phase 1 で MC 停止フローを設計 (startserver.sh ラッパ問題への対処、RCON 経由 stop)
