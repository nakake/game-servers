# ADR 0003: 管理 WebUI の認証に Discord magic link 方式を採用する

- **Status**: Proposed
- **Date**: 2026-05-27
- **Deciders**: nakake
- **Related**: [phase7-modpack-webui.md](../phase7-modpack-webui.md) §4 / [design.md](../design.md) §9 (セキュリティ)

## Context

Phase 7 で modpack 管理 WebUI (admin SPA) を導入するにあたり、認証方式を決める必要がある。

### 要件

1. **Discord ユーザーに限定**: 既存の Discord bot で `/start` `/stop` を叩ける運用主体と同じ層が WebUI を使う。既存の信頼境界に揃えたい
2. **追加の secret 管理は最小化**: 個人プロジェクトのため、可能なら OAuth client_secret 等の新規 secret 増加を避ける
3. **実装規模を抑える**: Worker (Cloudflare Workers) 上で動かすため、ライブラリ依存と行数を抑えたい
4. **CSRF / XSS 等の web 共通リスクには対策を講じる**

### 制約

- 制御プレーンは Cloudflare Workers (Node.js 全機能は使えない、`crypto.subtle` 主体)
- ユーザーは 1〜2 人 (個人プロジェクト)
- AWS リソース操作権限を握る画面なので、認証突破 = 即被害

## Decision

**Discord ephemeral message 経由の magic link + JWT cookie session** を採用する。

### フロー

1. Discord で `/admin` スラッシュコマンドを実行
2. Worker が:
   - 32 bytes CSPRNG token を生成
   - KV `admin_token:<token>` = `{user_id, exp_ts, used:false}` を TTL 600s で put
   - **`flags: 64` (EPHEMERAL) 付き** の応答に **button component** (`style:5` link button) を載せる。URL は `https://<admin-host>/auth?t=<token>`
3. ユーザーがブラウザでボタンクリック → `/auth?t=<token>` にアクセス
4. Worker が:
   - KV `admin_token:<token>` を引き、`used=false && exp_ts > now` を確認
   - `used=true` にして KV put (replay 防止、race condition は許容 §Consequences)
   - `ADMIN_DISCORD_USER_IDS` (CSV env) に `user_id` が含まれることを確認 (allowlist)
   - JWT (HS256, exp=24h, `{sub:user_id, jti:<random>}`) を `gs_admin_session` cookie で発行 (`Secure; HttpOnly; SameSite=Strict; Path=/`)
   - KV `admin_session:<jti>` = `{user_id, ...}` を TTL 86400s で put (revoke 用)
   - HTML 応答内で `<script>history.replaceState(null,'','/');location.href='/'</script>` を実行し URL から `?t=` を消す
5. 以降の `/admin/api/*` アクセスは cookie 検証 + KV `admin_session:<jti>` 存在チェック + allowlist 再確認の middleware を通す
6. 状態変更 API (PUT/POST/DELETE) は `X-Requested-With: fetch` ヘッダ要求で CORS preflight を強制 (CSRF 軽減)
7. logout は cookie clear + KV `admin_session:<jti>` delete。Discord 側 `/admin logout` で自分の全 jti を巡回 delete 可能

### コードの責務分割

- `lib/auth/admin-session.ts` — token issue / verify / JWT 発行・検証 / allowlist check
- `handlers/discord/admin.ts` — `/admin` slash command (token 生成 + ephemeral button 応答)
- `handlers/admin/auth.ts` — `/auth` 受け / `/admin/api/auth/logout`
- middleware `withAdminAuth(handler)` を全 `/admin/api/*` handler に bolt-on

## Consequences

### Positive

1. **Discord OAuth app の登録・client_secret 管理が不要**。Workers Secret は JWT 署名鍵 1 個増えるのみ
2. **One-shot token のため URL 共有による奪取耐性がある**: token が漏れても 1 度しか使えない + 10 分で失効
3. **Discord bot 既存資産にタダ乗り**: Discord 側の認証 (パスワード + 2FA) と integration_types allowlist がそのまま admin への 1st-factor として効く
4. **鶏卵問題なし**: Discord bot は Phase 1 から本番稼働中
5. **実装規模が小さい**: ~100 行 (auth library) + handler 2 個 + Discord command 1 個。OAuth と比較して半分以下
6. **Cookie 認証なので XSS による token 漏洩耐性が高い** (HttpOnly により JS から読めない)
7. **session revoke が KV で 1 行**: デバイス紛失時に Discord 側 `/admin logout` で全 jti 失効可能

### Negative / Trade-off

| リスク | 緩和策 |
|---|---|
| **Token が URL に乗る** (履歴 / proxy log / referrer に漏れる可能性) | (a) `/auth` 応答で `history.replaceState` を即実行し URL から消す, (b) Discord 側で **link button UI** を採用し、URL を平文テキストでチャット履歴に残さない |
| **Discord 応答に EPHEMERAL flag を忘れると URL がチャンネル全員に見える** | unit test で `flags: 64` を assert |
| **KV の eventual consistency により 1-shot 保証が race condition で破れる** | 実害は「同一ユーザーの 2 セッション同時発行」に限られる (token は本人のみ可視のため別人による奪取シナリオは成立しない)。許容 |
| **`ADMIN_DISCORD_USER_IDS` の typo / 空文字列で fail-open になる** | Worker init で `allowlist.length > 0` を assert、fail-closed default |
| **wrangler tail のログに `?t=xxx` が出る** | `/auth` handler 内で token を redact、または log を query string 抜きで出す |
| **24h session が残ったままデバイス紛失** | Discord 側 `/admin logout` で全 jti 失効 |
| **session 切れで Discord に戻る必要 (UX)** | TTL 24h で大半のユースケースをカバー。sliding renewal は MVP では入れない |
| **自作認証 = 標準実装より監査者の信頼が薄い** | 個人プロジェクトのため監査要件なし。将来商用化する場合は ADR 改訂で OAuth に倒す |

### 自分では完全には防げない (どの方式でも残る) リスク

- Discord アカウント侵害 (admin 乗っ取りに直結) — 2FA 必須運用で軽減
- Cloudflare アカウント侵害 (Workers Secret + KV + DNS 全部読める) — 2FA + hardware key
- ブラウザ拡張による cookie 読み取り (HttpOnly でも extension の cookies 権限なら読める) — Web 共通の制約

これらは **OAuth を採用した場合も等価**であり、本 ADR の選択結果には影響しない。

## Alternatives Considered

### 案 A: Discord OAuth2 (Authorization Code flow)

Discord 公式の OAuth フロー。`/auth/discord` で Discord にリダイレクト → ユーザーが認可 → callback で code を受け取り、Discord token endpoint で access_token + user info を取得。

**Pros**:
- 標準実装 (RFC 6749 準拠) で監査者の信頼が高い
- URL に token が出ない (code は Discord 自身が握る)
- ライブラリ・教材が豊富

**Cons (採用しなかった理由)**:
- Discord Developer Portal で OAuth app を別途登録する必要 (現状の bot とは別の app として、redirect URI 等の設定が要る)
- Workers Secret に `DISCORD_OAUTH_CLIENT_SECRET` が追加で必要
- Discord access_token を session として保持するか、別途自前 JWT に変換するかでコード分量がさらに増える
- ユーザー側のフロー: ボタンクリック → Discord 認可画面 → callback で SPA に戻る、と 2 ホップ必要 (magic link は 1 ホップ)

→ **個人プロジェクトのため、標準度・監査性 vs 実装規模のトレードオフで magic link に軍配**。商用化する場合は本 ADR を改訂し OAuth に切替予定。

### 案 B: Cloudflare Access (Zero Trust)

Cloudflare Zero Trust dashboard で email allowlist or Google SSO を設定し、Worker は `Cf-Access-Jwt-Assertion` header を検証するだけ。

**Pros**:
- 実装が最薄 (Worker 側 ~30 行)
- Cloudflare 純正で運用負担が極めて低い
- 無料枠 50 user まで

**Cons (採用しなかった理由)**:
- **Discord ユーザー識別ができない**: Cloudflare Access のユーザー = email or Google アカウント = Discord user_id とは別 ID space。WebUI 操作主体を Discord 上の `<@user_id>` で監査ログに残したいが、Access の identity からは Discord user_id を直接取れない
- 「Discord で `/start` を叩けるユーザー」と「WebUI を使えるユーザー」が別 allowlist で管理されることになり、運用上の認知負荷が増す
- Cloudflare Zero Trust の dashboard 設定が増える (現状の wrangler.toml + Workers Secret に閉じない)

→ 認証強度は最も高いが、**Discord 識別子との接続が薄い**ため不採用。

### 案 C: 共有 password / static bearer token

WebUI で password 入力 → Worker secret と比較 → JWT 発行。

**Pros**:
- 最速実装 (Worker 側 ~50 行)
- Discord 不在でも動く (= Discord bot 障害時の fallback として有用)

**Cons (採用しなかった理由)**:
- ブラウザ上で password 入力する UI が要る (XSS / phishing 表面拡大)
- password 漏洩 = 即奪取、復旧手段が password rotation のみ
- Discord user_id との紐付けが切れる (誰が操作したか不明)
- Workers Secret に長期 password を保持する = Phase 5 で排除した長期 secret pattern の復活

→ MVP 速度以外の利点なし、長期保有を避ける方針 ([phase5-plan.md](../phase5-plan.md) §0 threat model) と相反するため不採用。

## References

- [RFC 6749 — The OAuth 2.0 Authorization Framework](https://datatracker.ietf.org/doc/html/rfc6749)
- [Discord Developer Docs — Interactions: Ephemeral messages](https://discord.com/developers/docs/interactions/receiving-and-responding)
- [Cloudflare Workers — KV consistency model](https://developers.cloudflare.com/kv/concepts/how-kv-works/)
- [OWASP — Session Management Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html)
- [phase5-plan.md](../phase5-plan.md) §0 — 既存 threat model
