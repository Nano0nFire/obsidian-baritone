# Tier S コア設計書（実装前に固める基盤仕様）— v1

detailed-design.md の補足。rubber-duck検証で「誤ると大規模手戻り」とされた8項目を詳細化する。
全体方針: **DBログ(file_ops)が唯一の真実の源。WS配信は最適化に過ぎず、クライアントは常に vaultSeq から回復できる。**

---

## S1. 同期プロトコル状態機械（op ライフサイクル）

### 識別子と不変条件
- `vaultSeq`: vault毎に単調増加する受理済みop通し番号。サーバーが採番（per-vault sequence or 集計行の行ロック）。**ギャップ無し・単調増加**。
- `deviceSeq`: 端末がローカルで採番する単調増加番号。端末ごとに `(device_id, device_seq)` が一意。
- `opId`: UUID。冪等キー。`file_ops.op_id` UNIQUE。
- 不変条件: 1 vaultSeq = 1 受理op。op_idは一度だけ受理。device_seqは端末毎に欠番なく連続。

### opのローカルライフサイクル（クライアント）
```
draft → queued(outbox永続化) → inflight(送信済み未ACK) → acked(seq確定) | conflicted | rejected
```
- **outbox**はローカルDBに永続化。プロセスクラッシュ後も再送できる。
- inflight中に再接続したら、未ACK opを**同じopIdで再送**（冪等なので二重適用されない）。

### サーバー受理アルゴリズム（serializable Tx内）
```
1. op_id が file_ops に存在 → 保存済み result を返す（冪等・再送安全）
2. device_seq 検査:
   - expected = devices.last_device_seq + 1
   - op.device_seq == expected      → 続行
   - op.device_seq <  expected      → 既処理の重複 → 1 と同様 result 返却
   - op.device_seq >  expected      → ギャップ → reject{code: SEQ_GAP, expected} （クライアントが不足分を先送り）
3. blob参照あり → MinIO存在・hash・size検証（未検証なら reject{code: BLOB_MISSING}）
4. kind別 clock判定（detailed-design §2）→ 採用 or conflicted化
5. vaultSeq採番 → files更新 → file_ops追記 → outbox追記（同一Tx）→ devices.last_device_seq更新
6. COMMIT
7. op_ack{opId, vaultSeq, resultingClocks, conflictId?} を送信者へ。outboxワーカが他端末へ ops broadcast
```
> **ポイント**: device_seq厳格化により「順序逆転」「欠番」をサーバーが検出。ギャップは受理せず、クライアントに穴埋めを強制（投機状態の汚染を防ぐ）。

### Transactional Outbox（配信信頼性）
- 同一Txで `outbox(vault_id, vault_seq, payload, published bool)` に行追加。
- 別ワーカ（or LISTEN/NOTIFY）が未publish行を読み、WS配信→published=true。
- サーバークラッシュで配信が落ちても、クライアントは再接続時 `get_ops(sinceSeq)` で回復するので**最終的に整合**。

### クライアント受信・catch-up
- クライアントは `appliedSeq`（最後に適用したvaultSeq）を永続化。
- 再接続: `hello{lastSeq: appliedSeq}` → サーバーは `ops(>lastSeq)` を順送。
- broadcastで受けたopが `appliedSeq+1` でなければ（取りこぼし）、`get_ops(sinceSeq=appliedSeq)` で穴埋めしてから適用。

### クラッシュ整合シナリオ表
| シナリオ | 保証 |
|---|---|
| クライアントがファイル書込後・op enqueue前に落ちる | 起動時reconciliationスキャン(§S2)が差分を検出し再op化 |
| 送信後・ACK受領前に落ちる | outboxにinflight残存 → 再接続で同opId再送 → サーバー冪等で二重適用なし |
| サーバーがCOMMIT後・broadcast前に落ちる | outbox未publish → 復帰後配信、or クライアントのget_opsで回復 |
| サーバーがCOMMIT前に落ちる | Txロールバック → op未受理 → クライアント再送 |

---

## S2. ファイル同一性 & パス正規化

### fileId（安定ID）方式
- 採用: **ローカルインデックス方式（method C）**。`fileId` はクライアントが新規ファイル作成時に採番（UUID）し、ローカルDBに `path ↔ fileId` を永続化。
- 任意で frontmatter の `id:` を併用可（ユーザーが明示したい場合）。ただし正本はローカルインデックス。
- 新端末: manifestの各 `fileId` 行を、**再構成して書き込んだローカルパス**に対応付けてローカルインデックスに登録（サーバーが正本fileIdを配る）。

### リネーム検出（content hash併用）
- Obsidianの `rename` イベントを第一情報源とする。
- イベントを取りこぼした場合の保険: 起動時スキャンで「消えたpath」と「現れたpath」を**content hash一致**で突き合わせ → renameと判定（新規create+deleteにしない）。
- rename×edit同時: hashが変わっていても、ローカルインデックスのfileId継続で「同一fileのpath変更＋content変更」として別フィールドopを生成（衝突しない）。

### パス正規化（cross-platform 規則）— サーバーが正本ルール
- 保存正規化形: **Unicode NFC**、区切りは `/`、先頭 `/` 無し。
- **大文字小文字**: パスはcase-sensitiveに保持するが、`path_normalized = lower(NFC(path))` を別列に持ち、`UNIQUE(vault_id, path_normalized) WHERE deleted=false` で **case-only衝突を検出**。case-only renameはpathClock LWWで決着。
- **予約名/不正文字**（Windows: `CON,PRN,AUX,NUL,COM1..,LPT1..`、`<>:"/\|?*`、末尾の空白/ドット）: サーバーが受理時に検証。違反pathは reject{code: ILLEGAL_PATH}。クライアントは生成前にも検査。
- **最大長**: path ≤ 255 bytes/segment、合計 ≤ 1024（保守的）。超過は reject。
- **フォルダrename**: フォルダ自体はファイルでない。配下各fileの個別rename op群として表現（フォルダは暗黙）。サーバーは配下fileのpath prefixを一括更新するヘルパopも可（`rename_prefix`）だが、内部的には個別fileのpathClock更新に展開。
- **空フォルダ**: 同期対象外（fileが無いフォルダは表現しない）。必要なら `.gitkeep` 的プレースホルダ運用。
- **シンボリックリンク**: 同期対象外（辿らない・実体化しない）。検出したらignore。
- **隠しファイル/`.obsidian`**: §9 config syncで別管理。

### ローカルインデックス（クライアント永続DB）
```
file_index(fileId PK, path, path_normalized, contentHash, size, appliedContentVV, isDir bool, lastSeenMtime)
device_state(key PK, value)   -- appliedSeq, deviceId, nextDeviceSeq 等
```

---

## S3. 層1 ↔ 層2 権威境界（単一contentレーン）

### 大原則: ある時点で1ファイルのcontent権威は**ただ1つのレーン**
- ファイルが **active(層2)** の間: **Y.Docが唯一のcontent権威**。
- それ以外: **層1(file_op)が権威**。
- 二重権威を排除することで「自動マージ範囲」が曖昧にならない。

### promote（層1→層2）
- トリガ: ノートを**エディタで開く**（または共同編集に招待）。
- 手順:
  1. クライアントが `promote{fileId}` 送信。
  2. サーバーは当該fileに**promotion lease**（短命ロック）を付与。リース保持中は層1のcontent opを**reject{code: FILE_ACTIVE}**（クライアントは層2参加へ誘導）。
  3. Y.Docが未シードなら、サーバーが**現在の層1正本content（hash→note_content本文）を1回だけ**Y.Textへseed（**再シード禁止**＝CRDT分岐防止）。
  4. `room_state{fileId, yjsSnapshot, stateVector}` を返し、クライアントはy-websocket roomへ参加。
- 既にactiveなら lease参加者を追加するだけ（seedはしない）。

### active中
- content編集はYjs更新としてのみ流れる。`yjs_updates` に追記、定期的に `yjs_snapshots` へcompaction。
- **path/delete は層1のまま**（rename/deleteはactive中でも層1 opで処理。contentと別フィールドなので衝突しない）。

### demote（層2→層1）
- トリガ: 全participantが離脱 かつ idle timeout（既定: 最後の更新から N秒、設定可）。
- 手順:
  1. サーバーが最新Y.TextをmaterializeしてcontentHashをZ計算。
  2. **合成writer `collab:<fileId>`** 名義で層1 content opを1本生成（newContentVV = 関与した全deviceのVV join + collab bump）→ 全端末配信。これでdormant端末も最新化。A/B両者のflushを単一writerにすることで偽衝突を回避。
  3. Y.Doc自体は**永久保持**（snapshot）。再promote時は再シードせずsnapshotから復元。
  4. lease解放 → 層1 content op受理を再開。

### active中に届いた層1 content op
- reject{code: FILE_ACTIVE, hint: promote}。送信端末はpromoteして層2で再適用。
- ただしオフライン端末が後から持ち込む層1 content opは、demote後に通常の層1衝突判定にかかる（真の並行編集なら§4の手動マージへ）。

### dormant端末の準リアルタイム性
- active長時間継続でも、サーバーが定期的に(§demote手順2同様の)層1 flush opを配信し、開いていない端末も近い状態を保つ。

---

## S4. 認証・認可・信頼モデル

### 認証フロー
- **初期管理ユーザー**: setup.shの `create-user` でbcrypt/argon2 hash登録。
- **device登録**: ユーザー名+パスワードでログイン → サーバーが `device` 行発行 + **device-bound JWT(access, 短命)** と **refresh token(長命, 失効可)** を発行。
- **token refresh**: refreshでaccess再発行。refreshはローテーション（使用毎に新refresh発行、旧を失効）。
- **token保存**: デスクトップはOSキーチェーン/暗号化ファイル、モバイルはSecure Storage。平文保存しない。
- WS handshake `hello{token,...}` でaccess token検証。期限切れはrefresh誘導。

### 認可（role）— サーバーが**全opで強制**
| role | read | write(op) | conflict解決 | trash復元 | member管理 | vault削除 | プラグインバイナリ書込 |
|---|---|---|---|---|---|---|---|
| owner | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| editor | ✓ | ✓ | ✓ | ✓ | ✗ | ✗ | 設定により可/不可 |
| viewer | ✓ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ |
- サーバーは op 受理前に `vault_members(role)` を参照し権限検査。viewerのwrite opは reject{code: FORBIDDEN}。

### device失効
- `devices.revoked=true`。以降そのdeviceのtoken/op/refreshを全拒否。
- 失効deviceは**GCのACK quorumから除外**（§S6 / 潜在矛盾#4の解決）。
- 失効後に届くオフラインopは reject{code: DEVICE_REVOKED}（取り込まない）。

### 招待フロー
- ownerが招待トークン(期限付き, role指定)を発行 → 被招待者がログイン/登録時に消費 → `vault_members`追加。

### プラグインバイナリの信頼（重要・別ポリシードメイン）
- プラグインバイナリ(main.js等)同期は**コード配布**に等しい。共有vaultでは editor が他者端末で任意コード実行できてしまう。
- 規則:
  - 受信端末で**既定はバイナリ実行オフ**。導入/更新時に**信頼プロンプト**（誰がいつ変更したか表示）→ ユーザー承認で初めて有効化。
  - per-vault設定「プラグインバイナリ同期を許可」（既定: 単独ユーザーvaultは許可、共有vaultは要明示許可）。
  - プラグイン**設定(data.json)**とプラグイン**コード(main.js)**は同期カテゴリを分離（設定だけ同期も可）。
- 監査ログ: membership/device/security/プラグインバイナリ変更を `audit_log` に記録。

---

## S5. 初回同期 / manifest 一貫性

### 一貫スナップショットモデル
1. クライアント `get_manifest{vaultId, cursor?}` 。
2. サーバーは現在の `vaultSeq = S` を**ウォーターマーク**として固定し、`files`(deleted=false)を**ページング**で返す。
   - `manifest_page{watermarkSeq:S, items:[{fileId, path, type, contentHash, size, blobRef}], nextCursor}`
   - cursorは `(path_normalized, fileId)` キーセットページング（安定）。
3. クライアントは全ページ取得 → 各 contentHash/blob を**hash単位で取得**（既に持つhashはスキップ＝差分DL）。
   - 本文: `get_content{hash}` / blob: presigned GET。
4. 全contentを実ファイルへ再構成 → **各ファイルのhash再計算で検証**。
5. 取得完了後 `get_ops(sinceSeq=S)` で**ダウンロード中に発生したop**をcatch-up適用。
6. `appliedSeq=S` から通常運転へ。

### 整合・回復
- **途中blobのGC**: watermark S 時点でreferencedなblobは、その初回同期が「進行中」である間GC対象外にする（後述§S6のmin-retention + 進行中syncのソフトピン）。万一不足したら `get_content` が404→クライアントは最新manifestへフォールバック再取得。
- **再開可能**: ページcursorと取得済みhash集合をローカル永続化。中断後は続きから。
- **部分失敗**: ファイル単位でcommit。途中失敗しても取得済みは保持し再開。

### スケール（数万ファイル）
- manifestはページング（既定1000件/page）。
- contentは遅延取得オプション（将来の部分同期余地）: v1は全取得だが、protocolは「manifestとcontent取得を分離」しておき後付け可能に。

---

## S6. Blob ライフサイクル / 参照カウント / GC

### blob状態
```
pending(init済み未アップロード) → uploaded(本体到着) → verified(hash/size一致) → referenced(file/版/conflict/snapshotから参照) 
verified かつ 参照0 → unreferenced → (min-retention経過) → gc-eligible → deleted
```

### アップロードプロトコル
```
1. blob_upload_init{fileId?, hash, size} → サーバーが pending 登録 + presigned PUT URL返却
   - 既に verified で同hash存在 → skip指示（dedup, アップロード不要）
2. クライアントがMinIOへPUT（再開可能・content-addressed key = hash）
3. blob_upload_complete{hash} → サーバーが MinIO上のオブジェクトの hash/size を検証 → verified
   - 不一致 → reject{BLOB_HASH_MISMATCH}、pending破棄
4. 検証済hashを参照する file_op のみ受理可（§S1-3）
```
> hashは**サーバーが検証**（クライアント申告を信用しない）。共有vaultでの汚染防止。

### 参照カウント
- `blob_refs(hash, ref_type, ref_id)` で参照を明示管理。ref_type ∈ {file_live, file_version, conflict_base, conflict_side, yjs_snapshot, trash}。
- 参照追加/削除はop処理Tx内で更新。`refcount(hash)=COUNT(*)`。

### GC
- 対象: refcount=0 かつ **min-retention(既定: trash_retention_days と同等以上)** 経過 かつ 進行中初回syncのソフトピン無し。
- 放棄アップロード: pendingのまま T時間(既定24h)経過 → 削除。
- restore時にblobがGC済み → restore不可エラー（trash retention内なら必ず残す不変条件で回避）。

### 不変条件
- **live file 行は必ず verified blob/contentを参照**（dangling禁止）。op受理は blob verified 後のみ（pending状態はmanifestに出さない）。

---

## S7. 衝突解決プロトコル（protocol層・UXは detailed-design §4b）

### base(共通祖先)保持
- conflicted化時、`conflicts` 行に base_hash/ours_hash/theirs_hash を記録し、対応blob/contentを**resolvedまでGC禁止**（blob_refs: conflict_base/conflict_side）。
- base = 両者の**直近共通祖先**。サーバーは file_ops 履歴から両VVの共通先祖contentHashを特定（無ければ空文書をbaseに）。

### claim-lock（二重解決防止）
- `claim_conflict{conflictId}` → status `open→claimed`, claimed_by/claimed_at記録。
- **lease timeout**（既定5分）+ renewal（解決UI操作中はheartbeatで延長）。timeout経過で自動 `claimed→open`（解決者離脱の救済）。
- `release_conflict` で明示解放。

### 解決op
- `resolve_conflict{conflictId, resolvedHash|payload, resolvedVV}`。
- `resolvedVV = join(ours_vv, theirs_vv) + 自device bump` ＝ 両者を因果的に支配 → 再衝突しない。
- サーバー: claimed_by==解決者 を検証 → 採用 → files更新 → `conflicts.status=resolved` → 全端末へ通常content op配信 → file同期凍結解除。
- 同時に別端末が解決 → VV joinで冪等収束（後着は既resolvedをACK）。

### 権限・凍結
- 解決可能role: editor以上（§S4）。
- conflicted中は当該fileの**新規content opを凍結**（reject{CONFLICT_PENDING}）。path/deleteは継続可。
- バイナリ/config/プラグインfileの衝突: 3-wayマージ不可 → 選択ダイアログ（ours/theirs/both）。

---

## S8. プロトコル / スキーマ バージョニング & capability negotiation

### handshake
- device登録・WS `hello` に `protocolVersion:int`, `clientBuild:string`, `capabilities:[string]` を必須化（v1から）。
- サーバー `welcome{serverProtocol, minClientProtocol, capabilities}`。
- `clientProtocol < minClientProtocol` → reject{code: UPGRADE_REQUIRED}（UIで更新案内）。
- 機能差は capabilities フラグで分岐（例: `yjs-v2`, `partial-sync`, `e2ee`）。未対応機能は使わない。

### スキーマ移行
- サーバー: `npm run migrate`（前方移行のみ、番号付きmigration）。
- op payload は `schemaVersion` 付き。サーバーは旧版payloadを読めるようアダプタ層を維持（N-1互換）。
- 破壊的変更は protocolVersion bump + min client引き上げ + 移行期間。

---

## 解決済みの潜在矛盾（本書での決着）
- **config/プラグインバイナリ同期** → §S4で別ポリシードメイン化（既定実行オフ＋信頼プロンプト＋per-vault許可）。
- **層1/層2二重権威** → §S3で単一contentレーン（active時はY.Doc権威・層1 content opはreject）。
- **all-device ACK vs 失効端末** → §S4/§S6: ACK quorumは「失効除外・cutoff以降seenのactive端末」。
- **serializable Tx だけでは順序不足** → §S1で device_seq厳格化 + 明示的受理規則。
- **delete/restore** → restoreは新epoch扱い、旧epoch宛opは適用しない（detailed-design §1 epoch列を使用）。

## 次工程
- これらを反映した **packages/shared の型定義**（op/clock/protocol/error code）をコード化 → PoC-A(層1単一端末)着手。
