# 詳細設計書（層1同期 / プロトコル / DDL）— v1

rubber-duck検証を反映した確定版。plan.md の補足。

## 0. サーバーの基本モデル（重要前提）
- サーバーは**ファイルサーバーではない**。vaultを作業ディレクトリに展開しない
- 実ファイルツリーが存在するのは**クライアントのみ**。サーバーは正規状態を**DB行+blob**として保持
- op処理=DBトランザクション（clock比較→files行更新→note_content/MinIOにhash単位保存(dedup)→file_ops採番→配信）。**vaultへのファイル書込み工程は無い**
- 新端末の取得=manifest受信→hashで本文/blob取得→**クライアントが**実ファイルへ再構成
- 例外: 層2 Yjsのactive Y.Docのみサーバーメモリに常駐、更新はyjs_updates/snapshotsへDB永続化（実ファイルではない）
- 理由: スケール/並行性(トランザクション)/OS差異回避/hash dedup/履歴・衝突・ゴミ箱の自然実現。Self-hosted LiveSync(CouchDB)と同思想

## 1. ファイルのメタモデル（フィールド別クロック）
単一VVは破綻するためフィールドごとに因果クロックを分離する。

```
FileEntry {
  fileId: UUID            // 安定ID。pathは属性
  vaultId: UUID
  type: 'note' | 'attachment'
  path: string
  pathClock: {lamport:int, deviceId}   // LWW-register（リネーム決着用）
  contentVV: {deviceId: counter}       // 内容の因果（編集衝突判定）
  contentHash: string
  size: int
  blobRef: string|null                 // 添付/大きい内容のMinIOキー
  deleteVV: {deviceId: counter}|null   // tombstone（null=生存）
  deleted: bool
  epoch: int                           // VV圧縮の世代
  updatedAt
}
```
- rename×edit が衝突しないのは path と content が別フィールドだから。

## 2. 層1同期アルゴリズム
### op
```
file_op {
  opId: UUID                 // 冪等キー
  deviceId, deviceSeq: int   // per-device 厳格順序
  fileId, kind               // create|update|rename|delete
  // content系:
  baseContentVV, newContentVV, contentHash, size, payload(inlineText|blobRef)
  // rename系:
  newPath, pathClock
  // delete系:
  deleteClock
}
```
- baseVVとnewVVの両方を送る（編集元と適用後を区別）。

### サーバー処理（serializable トランザクション内）
1. opId重複 → 保存済み結果を返す（冪等）
2. deviceSeq順序強制（gapがあれば待機/保留）
3. blob参照あり → MinIOに存在・hash・size検証（受理前）
4. kind別判定:
   - content: newContentVV が stored.contentVV を支配 → 採用。concurrent → **衝突コピー**（サーバー生成・冪等: key=(fileId,敗者newContentVV,hash)）
   - rename: pathClock の大きい方が勝つ（tiebreak deviceId）。データ損失なし
   - delete: deleteVV を設定。content に因果的に後なら定着。concurrent edit は復活1回のみ。tombstone観測後の編集は新fileId
   - path衝突（別fileId→同一path）: 後着にサフィックス
5. seq採番 → manifest更新 → op_log追記 → commit → 配信
6. op_ack{opId, seq, resultingClocks, conflictFileId?}

### クライアント
- 「最後に見たseq」を保持。再接続で get_ops(sinceSeq)
- outbox（未ackローカルop）を永続化。オフラインopは再送
- **stale拒否時**: 不足opを先に適用 → ローカル投機状態をrebase（汚染VVから新opを作らない）

## 3. 層1↔層2 境界（flush）
- active中のYjsドキュメントはサーバーがY.Text→層1へ materialize
- 書き手は合成writer `collab:<fileId>`（単一writer）→ A/B両flushの偽衝突を回避
- dormant端末Cは通常のop配信で受信。Cがオフライン編集していたら真の衝突として正しく処理

## 4. 衝突解決マトリクス（確定・手動マージ方式）
原則: 自動マージ可能なものだけ自動。**自動マージ不可は必ず手動マージUIで解決**（サイレントな衝突コピーは作らない）。

| 同時操作 | 自動/手動 | 解決 |
|----------|-----------|------|
| edit × edit | **手動** | conflicted化→3-wayマージエディタ(base/ours/theirs) |
| rename × edit | 自動 | 衝突なし（別フィールド） |
| rename × rename | **手動** | 名前選択ダイアログ（データ損失なしだが人が選ぶ） |
| rename衝突(別file→同path) | 自動 | 後着サフィックス |
| create × create(同path) | 自動 | 両保持・一方サフィックス |
| edit × delete | **手動** | 「編集版を残す/削除を適用」選択+差分 |
| 添付 同path別hash | **手動** | 「ローカル/リモート/両方保持」選択(バイナリは内容マージ不能) |

層2(Yjs)でactive編集中のノートは文字単位で自動マージされ、本文衝突は発生しない。本表は層1のみで起きるケース。

## 4b. 衝突解決UX（手動マージ）
- 3-way必須のため**共通祖先(base)を保持**: note_content に content_hash 単位で保存し、解決までGCしない
- ライフサイクル:
  1. サーバーがconcurrent検出(自動不可) → 両版保持・files=conflicted・conflicts表にレコード → 該当fileの通常同期を一時停止(他fileは継続) → conflict通知(base/ours/theirs参照)
  2. クライアントは「未解決衝突」一覧(専用パネル/バッジ)に表示
  3. ユーザーがマージ画面で解決 → 結果を1内容に確定 → 解決op送信(newVV = ours/theirs VVのjoin + 自device bump = 両方を支配) → サーバー採用 → 全端末配信 → conflicted解除
- 二重解決防止: サーバーがclaimロック(最初の着手端末)。他端末は「解決中/解決済み」表示。同時でもVV joinで冪等収束
- マージUI: 本文=3-way分割エディタ(@codemirror/merge, GitHub風行単位採用)。edit×delete/添付/rename×rename=選択ダイアログ
- 専用「Conflicts」サイドパネルで未解決を集中管理

## 5. ワイヤープロトコル
WebSocket。層1制御はJSON、Yjsはy-websocketサブプロトコル（roomでfileId多重化）。

Client→Server:
- hello {token, deviceId, vaultId, lastSeq}
- file_op {…上記…}
- get_ops {sinceSeq}
- promote {fileId} / demote {fileId}
- blob_upload_init {fileId, hash, size} → presigned URL
- claim_conflict {conflictId}                         // 解決ロック取得
- resolve_conflict {conflictId, resolvedHash|payload, resolvedVV}
- release_conflict {conflictId}                        // 解決中断
- list_trash {vaultId}                                 // ゴミ箱一覧（保持期間内の削除済み）
- restore {fileId}                                     // ゴミ箱から復元

Server→Client:
- welcome {serverTime, currentSeq, capabilities}
- ops {ops:[…]}            // catchup/broadcast
- op_ack {opId, seq, resultingClocks, conflictId?}    // 衝突化したらconflictId
- conflict {conflictId, fileId, kind, baseRef, oursRef, theirsRef, oursVV, theirsVV}
- conflict_state {conflictId, status, claimedBy?, resolvedBy?}  // claimed/resolved通知
- room_state {fileId, yjsSnapshot, stateVector}   // promote応答
- error {code, msg}

## 6. PostgreSQL DDL（概略・確定方針）
```sql
CREATE TABLE vaults(vault_id uuid PRIMARY KEY, name text, created_at timestamptz default now());
CREATE TABLE users(user_id uuid PRIMARY KEY, username text UNIQUE, pw_hash text, created_at timestamptz default now());
CREATE TABLE vault_members(vault_id uuid, user_id uuid, role text, PRIMARY KEY(vault_id,user_id));
CREATE TABLE devices(device_id uuid PRIMARY KEY, user_id uuid, vault_id uuid, name text, last_seq bigint default 0, last_seen timestamptz, revoked bool default false);
CREATE TABLE files(
  file_id uuid PRIMARY KEY, vault_id uuid NOT NULL, type text NOT NULL,
  path text NOT NULL, path_clock jsonb NOT NULL,
  content_vv jsonb NOT NULL DEFAULT '{}', content_hash text, size bigint,
  blob_ref text, delete_vv jsonb, deleted bool default false, deleted_at timestamptz,
  epoch int default 0, updated_at timestamptz default now()
);
CREATE UNIQUE INDEX files_live_path ON files(vault_id, path) WHERE deleted=false;
CREATE TABLE file_ops(
  vault_id uuid NOT NULL, seq bigint NOT NULL,
  op_id uuid NOT NULL, device_id uuid NOT NULL, device_seq bigint NOT NULL,
  file_id uuid, kind text, payload jsonb, result jsonb, created_at timestamptz default now(),
  PRIMARY KEY(vault_id, seq)
);
CREATE UNIQUE INDEX file_ops_opid ON file_ops(op_id);
CREATE UNIQUE INDEX file_ops_devseq ON file_ops(device_id, device_seq);
CREATE TABLE note_content(file_id uuid, content_hash text, text bytea, PRIMARY KEY(file_id, content_hash));
CREATE TABLE yjs_updates(file_id uuid, seq bigserial, update bytea, created_at timestamptz default now(), PRIMARY KEY(file_id, seq));
CREATE TABLE yjs_snapshots(file_id uuid PRIMARY KEY, snapshot bytea, state_vector bytea, up_to_seq bigint, created_at timestamptz default now());
CREATE TABLE attachments(file_id uuid PRIMARY KEY, hash text, size bigint, mime text, upload_status text, blob_ref text);
CREATE TABLE tokens(token_id uuid PRIMARY KEY, user_id uuid, device_id uuid, issued_at timestamptz, expires_at timestamptz, revoked bool default false);
CREATE TABLE conflicts(
  conflict_id uuid PRIMARY KEY, vault_id uuid NOT NULL, file_id uuid NOT NULL,
  kind text NOT NULL,                         -- content|delete|attachment|rename
  base_hash text, ours_hash text, theirs_hash text,
  ours_vv jsonb, theirs_vv jsonb,
  status text NOT NULL DEFAULT 'open',        -- open|claimed|resolved
  claimed_by uuid, claimed_at timestamptz,
  resolved_by uuid, resolved_hash text, resolved_vv jsonb, resolved_at timestamptz,
  created_at timestamptz default now()
);
CREATE INDEX conflicts_open ON conflicts(vault_id, status) WHERE status<>'resolved';
```
- note_content の base/ours/theirs 版は対応する conflict が resolved になるまで保持（その後GC）。
- vault毎のseqは採番をトランザクション内で（per-vaultシーケンス or 集計行ロック）。

## 7. monorepo構成
```
/packages/shared   … プロトコル型, op定義, clock(VV)ユーティリティ, hash
/packages/server   … Node.js(ws + y-websocket), Postgres adapter, MinIO, JWT
/apps/plugin       … Obsidianプラグイン(esbuild)
/docker-compose.yml … server + postgres + minio
```

## 8. 障害/回復・冪等
- opId冪等・結果永続化。outboxはack まで保持。op_logはcommit後に配信
- アップロードは再開可能・content-addressed。orphan blobはGC
- サーバークラッシュ: op_logが真実の源、manifestは再構築可能

## 8b. 削除の保持/サーバーゴミ箱/復元（方針B）
- 純粋削除(衝突なし): files.deleted=true, delete_vv記録, deleted_at=now() で **tombstone化**
- **サーバーゴミ箱**: 削除済みでも内容(note_content/blob)を **保持期間 trash_retention_days(設定可)** だけ保持
  - 期間内はどの端末からも `list_trash` / `restore` で復元可
  - `restore` = 同一fileIdで content_vv を delete_vv に支配させる復元op → deleted=false → 全端末へ配信
- **GC**: 保持期間経過 かつ 全既知端末がseq超えACK で tombstone+内容を物理削除
  - 期間内でも誤復活防止のため tombstone(メタ)は保持。GC後に長期オフライン端末が繋いだ場合は delta でなく **manifest全resync** にフォールバック（古いローカルファイルで復活させない）
- ローカル削除UX: リモート削除(サーバー命令)を受けた側は物理即時削除せず**ゴミ箱へ移動**。移動先は**設定で切替**:
  - 「システムゴミ箱」= app.vault.trash(file, true)
  - 「Obsidianゴミ箱(.trash)」= app.vault.trash(file, false)
  - 既定はObsidianゴミ箱(.trash)。設定はクライアント毎

## 9. 設定・プラグイン同期（Config Sync）
- 対象: .obsidian/ 配下。カテゴリ毎に各端末が common(共通) / local(端末固有) を選択（強制しない）
- カテゴリと既定:
  | カテゴリ | 対象 | 既定 |
  |---|---|---|
  | アプリ設定 | app.json/appearance.json/hotkeys.json | common |
  | コアプラグインON/OFF | core-plugins.json | common |
  | コミュニティプラグイン導入 | community-plugins.json + plugins/<id>/{manifest,main.js,styles.css} | common |
  | プラグイン設定 | plugins/<id>/data.json | common |
  | テーマ/スニペット | themes/ snippets/ | common |
  | ワークスペース配置 | workspace*.json | local |
- 仕組み: サーバーに共通プロファイルを保持(通常ファイル同期上の専用名前空間)。commonカテゴリ=読み書き両方適用、localカテゴリ=detach(共通を適用せず押し上げもしない)
- プラグイン本体バイナリも同期(plugins/<id>/一式)。バージョン完全一致・オフライン導入可
- 注意: モバイルは isDesktopOnly プラグインを適用しない。プラグイン有効化変更は app.plugins/リロードで反映。.obsidian配下はFileSystemAdapter(app.vault.adapter)で読み書き。バイナリ同期は自端末間ゆえ許容だがコード実行のセキュリティ注記
- 適用ゲート: 同期自体は行いつつ、ローカル適用をカテゴリmodeで制御

## 10. .ignore（同期スコープ制御）
- gitignore構文。2層: 共通ignore(同期される) + 端末ローカルignore
- 既定ignore: .obsidian/workspace*.json, .trash/, .git/, .DS_Store 等
- op生成前にパス評価 → ignore対象はmanifestに入れない(同期しない)
- 既存を後からignore: 同期セットから除外(凍結)。リモート削除はしない

## 11b. デプロイ / 対話型セットアップ（setup.sh）
- 目的: config/.env を手で触らずに Docker でサーバーを立てられるようにする。`files/deploy/` に成果物を配置。
- 構成ファイル:
  - `setup.sh`: 対話型。前提チェック→各種質問→`.env`生成→（任意で）`docker compose up -d`+migrate+初期ユーザー作成。
  - `docker-compose.yml`: `server` / `postgres`(profile=bundled-db) / `minio`+`minio-init`(profile=bundled-minio) / `caddy`(profile=tls-caddy)。
  - `.env.example`: 全環境変数のドキュメント。手動運用者向け。
- 同梱 vs 外部の切替: Docker Compose の `profiles` と `COMPOSE_PROFILES` で実現。
  - PostgreSQL: 同梱(コンテナを立てDATABASE_URLはホスト名`postgres`) / 外部(URL・認証・sslmodeを要求し`pg_isready`で接続検証)。
  - MinIO: 同梱(バケット自動作成) / 外部S3互換(endpoint/key/bucket/regionを要求)。
- 対話で取得する項目: 公開ポート(既定3000)/公開URL/ゴミ箱保持日数/TLS方式(none|caddy[domain,email])/DBモード+接続情報/オブジェクトストレージ+認証/初期管理ユーザー。
- 秘匿情報: `JWT_SECRET`は`openssl rand -hex 32`で自動生成。DB/MinIO/管理パスワードは空入力でランダム生成可。`.env`は`umask 077`で生成。
- 冪等性: 既存`.env`を検出したら再設定/再利用を選択。非対話実行は`SETUP_NONINTERACTIVE=1`+環境変数で対応。
- 注意: `server`イメージのビルド・`npm run migrate`・`create-user` CLI はサーバー実装後に有効。`.env`/compose 生成自体は実装前でも動作する。

## 11. 残タスク（後続）
- repo-structure 詳細, failure-recovery 詳細, test-matrix（エッジケース）
- config-sync の共通プロファイルとファイル同期層の統合詳細

## 12. Tier S コア設計（別冊: spec-core-protocol.md）
実装前に固める基盤8項目を `spec-core-protocol.md` に詳細化済み:
- S1 同期プロトコル状態機械（op ライフサイクル / device_seq厳格化 / transactional outbox / crash整合）
- S2 ファイル同一性 & パス正規化（fileId method C / rename検出 / NFC・case・予約名・cross-platform）
- S3 層1↔層2 権威境界（単一contentレーン / promote lease / demote flush / 再シード禁止）
- S4 認証・認可・信頼（device登録/JWT+refreshローテ/role強制/招待/失効/プラグインバイナリ信頼）
- S5 初回同期/manifest一貫性（watermark seq / keysetページング / hash差分DL / catch-up / 再開可能）
- S6 Blobライフサイクル/参照カウント/GC（pending→verified→referenced / サーバーhash検証 / blob_refs / min-retention）
- S7 衝突解決プロトコル（base保持 / claim-lock timeout / resolve op VV join / 凍結 / 権限）
- S8 バージョニング & capability negotiation（protocolVersion / min client / schemaVersion / N-1互換）
