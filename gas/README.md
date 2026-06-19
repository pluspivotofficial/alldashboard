# GAS 集計層（応募ダッシュボード）

設計書: [`../docs/dashboard-redesign.md`](../docs/dashboard-redesign.md)
構成: **案1（静的フロント + GAS は JSON API）**

```
各ソースのフォルダ(最新CSV) + マスタ2枚 ──(毎日トリガー)──▶ runDailyAggregation()
        │  突合・オフィス振り分け・集計
        ▼
   {month}_summary.json（Cache + Drive）
        ▲
   doGet() が返すだけ ──fetch──▶ dashboard/index.html（GitHub Pages）
```

## 実データの構成（CONFIG に設定済み）
| 用途 | 実体 | 文字コード | フォルダ/シートID |
|------|------|-----------|------------------|
| 総応募(①) | 「+ホップ 集客DB - 統合ツールデータ」CSV | UTF-8 | `1VvdyRw6Fd2ox-GWQXMhSsapROLNFNbEC` |
| MCG人選(⑤) | 「+ホップ 集客DB - シート4」CSV（接触/歩留/人選を含む） | UTF-8 | `12GI5yYIje9h8YOetRJs3R20olCn5fe2e` |
| MCG稼働(③) | 「【真子】集客項目出力…」CSV | Shift_JIS | `1CsO0ATFsQCKMZBmGSLP6lVdbxhH2ng3E`（現状未使用） |
| 対応表 | スプレッドシート（列: `都道府県`/`オフィス`） | – | `1quGDrLDXBkJ4iVO0dUhkGtbqAvs8_QRSaZHRXeAiJK4` |
| 目標 | スプレッドシート（列: `オフィス`/`目標`） | – | `1pd3HgF5zE8Njd7SLQZqTvbzyGMGtlIMhOAfUV7Sl7dY` |
| 出力 | `{month}_summary.json` | – | 親 `1B-WC1fRgXnYAhfAvxx3fGGXROqodB9vD` |

> 接触/歩留/人選は **⑤(UTF-8) 1ファイル** から集計（全列を含むため）。
> ③(Shift_JIS) は電話応募の取り込みが必要になった場合に使用（現状は未使用）。

## セットアップ手順
1. [script.google.com](https://script.google.com) で新規プロジェクト → `Code.gs` / `appsscript.json` を貼り付け。
2. メニューで `runForMay2026` を実行（データのある 2026-05 で動作確認）→ 権限承認。
3. ログ（offices / dailyPoints）と、親フォルダに `2026-05_summary.json` ができることを確認。
4. **`markExistingCsvsProcessed` を一度だけ実行** → フォルダに今あるCSVを「追記済み」として記録（既にシートに入っている分の二重追記を防ぐ）。
5. `installDailyTrigger` を実行 → 毎朝7:30前後の自動集計を登録（CONFIG.DAILY_TRIGGER_HOUR / _MINUTE）。
6. 「デプロイ > 新しいデプロイ > ウェブアプリ」: アクセス=全員。発行URLを控える。
7. `dashboard/index.html` の `API_URL` にそのURLを設定（フロント接続）。

## 確定した集計ルール
1. **新規/再応募** … 総応募は累積スプレッドシート（`TOTAL_SHEET_ID`、全履歴）。応募日昇順で**電話番号の初出=新規 / 以降=再応募**（重複応募・有効応募列は不使用）。再応募は電話でユニーク化。**日次グラフの再応募も電話ユニーク**（各人を月内最初の再応募日に1計上）。
2. **電話応募** … MCG(⑤)にあり総応募に無い電話＝電話応募。新規に加算し `phoneApplications` に内訳化。
3. **接触/人選** … 当月応募分（応募日基準）で集計。
4. **歩留** … 各ステージの日付列が**当月**のものをカウント。コホートは初回応募日で判定（当月内 ⊂ 2ヶ月以内）。
5. **人選判定** … ⑤を**GASで4条件判定**（列インデックス参照）。有資格(福祉資格に「有資格」)／介護経験=有／勤務日数に「LT」／年齢60未満 の該当数で **4=A・3=B・2=C・0-1=その他**。

## 総応募シートへのCSV追記（自動フロー）
毎朝の流れ:
```
[〜7:00] 統合ツールが前日の応募データCSVを TOTAL_FOLDER_ID に出力
   ▼
[7:30前後] 毎日トリガー → runDailyAggregation()
   ├ appendNewTotalCsvs()  : フォルダ内の未処理CSVを古い順に TOTAL_SHEET_ID 末尾へ全追記
   └ 集計 → {month}_summary.json 更新
   ▼
ダッシュボード(GitHub Pages) が doGet 経由で最新を表示
```
- `appendNewTotalCsvs()` … `TOTAL_FOLDER_ID` 内の**まだ取り込んでいないCSVを全て**古い順に `TOTAL_SHEET_ID` 末尾へ追記。取込済みファイルIDは ScriptProperties (`appendedCsvIds`) に集合で記録するため、**二重追記なし・トリガーが1日飛んでも翌日まとめて取込**。
- 列名は CSV ヘッダー → シートヘッダーの順にマッピングするので、CSVの列順が違っても安全。
- **自動化を有効にする前に一度だけ `markExistingCsvsProcessed()` を実行**：現在フォルダにあるCSV（既にシート取込済み）を「追記済み」として記録し、二重追記を防ぐ。
- 前提: 統合ツールは**毎朝新しいCSVファイル**として `TOTAL_FOLDER_ID` に出力すること（同名で上書きせず別ファイルにする）。CSVは「前日分（増分）」を想定。
- ヘッダー名のゆらぎは `HEADER_ALIASES` で吸収（統合ツールの「応募日」→シートの「（応募内容）応募日」）。
- 追記後に `dedupeSheet_()` が**二重追記された行を除去**（署名＝応募日|電話|氏名|媒体。電話なし行は対象外）。連携ボタンの連打や同一CSVの再アップロードでも重複しない。
- 続いて `fillDerivedColumns_()` がシートの **「対応オフィス」「新規/再応募」** をGASで判定して書き込む（列が無ければ末尾に作成）。
  - 対応オフィス … マスタ(都道府県→オフィス)で判定。ダッシュボードと同基準なので表示が一致。
  - 新規/再応募 … 累積シート全体を応募日昇順で見て、電話番号の初出=新規 / 以降=再応募。毎回全行を再計算（自己修正）。

## 統合ツールからの直接連携（doPost）
obo-data-tool の「☁️ ダッシュボードへ連携」ボタンは、統合CSVをこのウェブアプリの `doPost` へ送る。
```
[ブラウザ] obo-data-tool で統合 → 「連携」ボタン
   ▼ POST (token + csv, フォームエンコード=CORSプリフライト回避)
[GAS] doPost(): token照合 → TOTAL_FOLDER_ID に新CSV保存 → runDailyAggregation() で追記＆当月集計
   ▼
ダッシュボードに即時反映
```
- `CONFIG.UPLOAD_TOKEN` と obo-data-tool 側の `UPLOAD_TOKEN` を一致させる（公開HTMLに載るため強固な秘密ではない＝社内用途の簡易ガード）。
- コード変更後は **デプロイを更新**（管理 > デプロイを編集 > バージョン=新バージョン）して `/exec` URL に反映する。URL自体は変わらない。
- このボタンを使えば 7:30 トリガーを待たずに即反映できる。トリガーは保険として併用（ボタン未操作の日も拾う）。

## 人選データの取り込み（当月人選シート）
人選CSVアップローダー `senbatsu.html`（GitHub Pages）→ doPost(`type=senbatsu`)。
```
[ブラウザ] senbatsu.html で人選CSVを選択 → 取り込み
   ▼ POST (token, type=senbatsu, csv)
[GAS] writeSenbatsuSheet_(): 先頭28列＋人選ｽﾃｰﾀｽ に整形し SENBATSU_SHEET_ID(1NsC65W) を丸ごと置換
        人選ｽﾃｰﾀｽ = 4条件で算出（有資格/介護経験/勤務日数LT/年齢60未満 → A/B/C/その他）
   → runDailyAggregation() … 接触/歩留/人選を当月人選シートから集計
   ▼
ダッシュボードの人選数(A/B/C)に反映
```
- ダッシュボードの人選・接触・歩留の読み取り元は **当月人選シート `SENBATSU_SHEET_ID`**（`readSenbatsuRows_()`）。列はMCGI(列インデックス)準拠。
- CSVに既存の人選ｽﾃｰﾀｽがあっても**GASが4条件で計算し直す**（一貫性のため）。
- シートは毎回**まるごと置換**（当月の最新CSVで上書き）。

## 媒体別パフォーマンス（summary.media）
集計時に媒体×オフィスでも積み上げ、`summary.media[]` を出力。
- 媒体の表記ゆれ統合（`normMedia_`）：「キューメイト」を含む表記→`キューメイト`、`indeed`系→`Indeed`、他は原文。
- 各媒体: `overview`(新規/電話/再応募/接触/newAB/reAB) ＋ `selection`(A/B/C/他/不明) ＋ `funnel` ＋ `offices[]`(オフィス別の同項目)。
- ダッシュボードのサイドバー「媒体別」で 媒体一覧→媒体クリックでオフィス別内訳を表示。

## 出力JSON
設計書セクション5のスキーマと同一。`dashboard/index.html` の `SAMPLE_DATA` が参照例。
