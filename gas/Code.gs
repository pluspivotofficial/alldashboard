/**
 * 介護職応援ポイント 応募ダッシュボード — GAS 集計層
 * 設計書: docs/dashboard-redesign.md
 *
 * 役割:
 *   1) runDailyAggregation() : 毎日1回、各フォルダの最新CSV/マスタを突合して
 *      集計済みサマリーJSONを生成し、CacheService + Drive(summary.json) に保存。
 *   2) doGet()               : 保存済みサマリーJSONを返すだけの薄いAPI。
 *   3) installDailyTrigger() : 毎日トリガーを登録（最初に1回だけ実行）。
 *
 * 実データのフォルダ/ファイル構成（2026-06 時点）:
 *   総応募データ        … 「+ホップ 集客DB - 統合ツールデータ」CSV (UTF-8)
 *   MCG稼働データ(③)    … 「【真子】集客項目出力…」CSV (Shift_JIS)  ※現状は未使用
 *   MCG人選データ(⑤)    … 「+ホップ 集客DB - シート4」CSV (UTF-8)
 *       └ 接触ステータス・歩留（新規）列・人選ｽﾃｰﾀｽ・都道府県を全て含むため、
 *         接触/歩留/人選はこの1ファイルから集計する。
 *
 * ▼要確認（コード内 TODO）:
 *   - 新規/再応募は累積シート内で電話番号の初出判定（初出=新規 / 以降=再応募）
 *   - 電話応募 = MCG(⑤)にあり総応募に無い電話。新規に加算し phoneApplications に内訳化
 */

/* =========================================================================
 * 設定（フォルダ/シートのIDは実環境のもの）
 * ========================================================================= */
const CONFIG = {
  // 総応募データ（累積スプレッドシート。全履歴を保持し重複判定に使う）
  TOTAL_SHEET_ID: '1p4CA-RwYwmfA2JMflNMVK7SMVrXHC7AtW54XN2xIZT8',
  // 応募ツールが吐くCSVの置き場所（appendNewTotalCsvs で上記シート末尾へ追記）
  TOTAL_FOLDER_ID: '1VvdyRw6Fd2ox-GWQXMhSsapROLNFNbEC',
  SELECTION_FOLDER_ID: '12GI5yYIje9h8YOetRJs3R20olCn5fe2e',  // MCG人選データ(⑤) のフォルダ
  SENBATSU_SHEET_ID: '1NsC65WFpoSHU3t-1tNboOU1GyFinUeQdMLDf70dghmU', // 当月人選データ（整形先＆人選/接触/歩留の正データ）
  MCG_FOLDER_ID: '1CsO0ATFsQCKMZBmGSLP6lVdbxhH2ng3E',        // MCG稼働データ(③) ※予約

  // 出力（summary.json の置き場所。親フォルダに出力）
  OUTPUT_FOLDER_ID: '1B-WC1fRgXnYAhfAvxx3fGGXROqodB9vD',
  SUMMARY_FILENAME: 'summary.json',

  // マスタ（スプレッドシート）
  PREF_OFFICE_SHEET_ID: '1quGDrLDXBkJ4iVO0dUhkGtbqAvs8_QRSaZHRXeAiJK4', // 都道府県↔オフィス
  TARGET_SHEET_ID: '1pd3HgF5zE8Njd7SLQZqTvbzyGMGtlIMhOAfUV7Sl7dY',     // オフィス別目標

  // 文字コード（ソース別）
  CHARSET_TOTAL: 'UTF-8',
  CHARSET_SELECTION: 'UTF-8',
  CHARSET_MCG: 'Shift_JIS',

  CACHE_KEY: 'dashboard_summary_v1',
  CACHE_TTL_SEC: 21600, // 6時間
  TZ: 'Asia/Tokyo',

  // 毎日トリガーの実行時刻。統合ツールが朝7時までにCSVを出すので、その後の7:30前後に実行。
  // ※GASの時間トリガーは厳密な定刻ではなく前後に幅がある（nearMinureで7:30近辺に寄せる）。
  DAILY_TRIGGER_HOUR: 7,
  DAILY_TRIGGER_MINUTE: 30,

  // 統合ツール(obo-data-tool)からの doPost アップロードを認証する合言葉。
  // ※クライアント側(公開HTML)にも同じ値を置くため強固な秘密ではない（社内用途の簡易ガード）。
  UPLOAD_TOKEN: 'NMrci23nQlpFLFSpAQb3113A',
};

// CSV→シート追記時のヘッダー名ゆらぎ吸収（シート列名 → 許容するCSV列名の別名）。
// 統合ツールは「応募日」で出力するが、累積シートの列名は「（応募内容）応募日」のため対応づける。
const HEADER_ALIASES = { '（応募内容）応募日': ['応募日'] };

// 列名（実ヘッダーに準拠）
const COL = {
  total: {  // 総応募（統合ツールデータ）
    applyDate: '（応募内容）応募日',
    phone: '連絡先TEL',
    office: '拠点',
    pref: '都道府県名',
    media: '媒体',
    // 新規/再応募は重複応募列に頼らず、電話番号の初出で判定（累積シート内で重複判定）
  },
};

// MCG人選データ(⑤) は重複ヘッダーがあるため "列インデックス(0始まり)" で参照する。
// A=0,B=1,... の対応: E=4(年齢) S=18(福祉資格2=有資格) T=19(介護経験) W=22(勤務日数)
const MCGI = {
  applyDate: 0,    // A 応募日
  phone: 3,        // D 電話番号
  age: 4,          // E 年齢
  pref: 6,         // G 都道府県
  contactStatus: 9,// J 接触ステータス
  qual: 18,        // S 福祉資格(有資格判定)
  exp: 19,         // T 介護経験
  workdays: 22,    // W 勤務日数(LT判定)
  setNew: 24,      // Y 設定日（新規）
  doneNew: 25,     // Z 実施日（新規）
  decNew: 26,      // AA 決定日（新規）
  startNew: 27,    // AB 開始日（新規）
};

const CONTACT_PREFIX = '接触'; // 接触 (電話)/(フォーム)/(メール) を前方一致で判定
const FUNNEL_STAGES = [
  ['set', 'setNew'],
  ['done', 'doneNew'],
  ['decided', 'decNew'],
  ['started', 'startNew'],
];

/* =========================================================================
 * Web API
 * ========================================================================= */
function doGet(e) {
  const month = (e && e.parameter && e.parameter.month) || currentMonthKey_();
  let json = CacheService.getScriptCache().get(CONFIG.CACHE_KEY + ':' + month);
  if (!json) json = readSummaryFromDrive_(month);
  if (!json) json = JSON.stringify({ error: 'summary not generated yet', month: month });
  return ContentService.createTextOutput(json).setMimeType(ContentService.MimeType.JSON);
}

// 統合ツール(obo-data-tool)が「Driveへ連携」したCSVを受け取る。
//   token … CONFIG.UPLOAD_TOKEN と一致必須
//   csv   … 統合済みCSV本文（フォームエンコードで送信＝CORSプリフライト回避）
// 受領後: TOTAL_FOLDER_ID に新ファイル保存 → そのまま追記＆当月集計まで実行（ダッシュボード即更新）。
function doPost(e) {
  try {
    const p = (e && e.parameter) || {};
    if (p.token !== CONFIG.UPLOAD_TOKEN) return jsonOut_({ ok: false, error: 'unauthorized' });
    const csv = p.csv;
    if (!csv) return jsonOut_({ ok: false, error: 'no csv body' });

    // type=senbatsu … 人選データCSV。1NsC65W形式へ整形＋人選ｽﾃｰﾀｽを4条件で算出し、当月人選シートを丸ごと置き換える。
    if (p.type === 'senbatsu') {
      const rows = writeSenbatsuSheet_(csv);
      let summary = null;
      try { summary = runDailyAggregation(); } catch (err) { Logger.log('post-aggregate failed: ' + err); }
      return jsonOut_({ ok: true, mode: 'senbatsu', rows: rows, month: summary && summary.month });
    }

    // 既定 … 総応募CSV。TOTAL_FOLDER_IDへ保存→追記＆当月集計。
    const name = '応募データ統合_' + Utilities.formatDate(new Date(), CONFIG.TZ, 'yyyyMMdd_HHmmss') + '.csv';
    DriveApp.getFolderById(CONFIG.TOTAL_FOLDER_ID).createFile(name, csv, 'text/csv'); // まず保存（失敗しても7:30トリガーが拾う）

    let summary = null;
    try { summary = runDailyAggregation(); } catch (err) { Logger.log('post-aggregate failed: ' + err); }
    return jsonOut_({
      ok: true,
      savedFile: name,
      month: summary && summary.month,
      offices: summary ? summary.offices.length : null,
    });
  } catch (err) {
    return jsonOut_({ ok: false, error: String(err) });
  }
}

function jsonOut_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

/* =========================================================================
 * メイン: 毎日の事前集計
 * ========================================================================= */
function runDailyAggregation(monthArg) {
  const month = monthArg || currentMonthKey_();

  // 0) 統合ツールが出した未処理CSVを総応募シート末尾へ追記（失敗しても集計は続行）
  try { appendNewTotalCsvs(); } catch (e) { Logger.log('append skipped: ' + e); }

  // 0.2) 媒体も電話も空の不要行を除去（人選CSV等が誤って総応募に混入した行を掃除）
  try { purgeJunkRows_(); } catch (e) { Logger.log('purge skipped: ' + e); }

  // 0.3) 同じ応募が二重追記された行を除去（再アップロード・連打しても重複しない）
  try { dedupeSheet_(); } catch (e) { Logger.log('dedupe skipped: ' + e); }

  // 0.5) シートの「対応オフィス」「新規/再応募」をGASで判定して書き込む（ツール任せにしない）
  try { fillDerivedColumns_(); } catch (e) { Logger.log('fillDerived skipped: ' + e); }

  // --- マスタ ---
  const prefToOffice = loadPrefToOffice_();          // { '東京都':'新宿オフィス', ... }
  const officePrefs = invertPrefMap_(prefToOffice);  // { '新宿オフィス':['東京都','埼玉県',...] }
  const targets = loadTargets_();                     // { '新宿オフィス':120, ... }

  // --- 入力 ---
  const totalRows = readSheetObjects_(CONFIG.TOTAL_SHEET_ID);              // 総応募(累積シート)
  const mcgRows = readSenbatsuRows_(); // 当月人選シート(1NsC65W)を行配列で（接触/歩留/人選の正データ）

  const totalPhoneSet = {};      // 総応募に存在する電話（電話応募判定用）
  const firstDateByPhone = {};   // 電話 → 初回応募日（累積シートでの重複判定）
  const judgeByPhone = {};       // 電話 → 'A'|'B'|'C'|'other'（⑤を4条件で判定）
  const dailyMap = {};
  const reDailySeen = {};        // 日次の再応募を電話ユニークにするための既出管理
  const rePhoneInMonth = {};     // 当月に再応募した電話（歩留の再応募コホート判定用）
  const range = monthRange_(month);

  // --- オフィス集計器（マスタ基準で初期化） ---
  const acc = {};
  Object.keys(officePrefs).forEach(office => {
    acc[office] = newOfficeAcc_(office, officePrefs[office], targets[office] || 0);
  });

  // 人選参照表: ⑤を4条件で判定し、電話→区分（A/B/C/other）を作る
  mcgRows.forEach(row => {
    const p = normPhone_(row[MCGI.phone]);
    if (p) judgeByPhone[p] = judgeFromRow_(row);
  });
  const isAB = phone => judgeByPhone[phone] === 'A' || judgeByPhone[phone] === 'B';

  // --- 重複判定: 累積シートを応募日昇順に走査し、電話の初出=新規・以降=再応募 ---
  const parsed = totalRows.map(r => ({
    office: r[COL.total.office] || prefToOffice[(r[COL.total.pref] || '').trim()],
    phone: normPhone_(r[COL.total.phone]),
    d: parseDate_(r[COL.total.applyDate]),
  })).filter(x => x.d);
  parsed.sort((a, b) => a.d - b.d);
  parsed.forEach(x => {
    if (x.phone) {
      totalPhoneSet[x.phone] = true;
      x.first = !firstDateByPhone[x.phone];          // この電話の初回行か（=新規 / 以降=再応募）
      if (x.first) firstDateByPhone[x.phone] = x.d;
    } else { x.first = true; }
  });

  // --- ① 総応募: 当月の新規/再応募・日次（再応募も電話ユニーク） ---
  const reUniqByOffice = {};
  parsed.forEach(x => {
    if (!x.office || !acc[x.office] || !inRange_(x.d, range.monthStart, range.monthEnd)) return;
    const key = fmtDate_(x.d);
    dailyMap[key] = dailyMap[key] || { new: 0, re: 0 };
    if (x.first) {                                    // 初回=新規（電話ユニーク）
      acc[x.office].overview.newApplications += 1;
      if (isAB(x.phone)) acc[x.office].overview.newAB += 1;
      dailyMap[key].new += 1;
    } else {                                          // 2回目以降=再応募（電話ユニーク）
      const set = reUniqByOffice[x.office] || (reUniqByOffice[x.office] = new Set());
      set.add(x.phone);
      rePhoneInMonth[x.phone] = true;                 // 当月の再応募者
      if (!reDailySeen[x.phone]) { reDailySeen[x.phone] = true; dailyMap[key].re += 1; } // 日次もユニーク
    }
  });
  Object.keys(reUniqByOffice).forEach(o => {
    const set = reUniqByOffice[o];
    acc[o].overview.reApplications = set.size;
    set.forEach(p => { if (isAB(p)) acc[o].overview.reAB += 1; }); // 再応募A+B（電話ユニーク）
  });

  // --- ⑤ MCG人選: 電話応募・接触数・歩留・人選（列はインデックス参照） ---
  const phoneAppSeen = {};       // office → Set(電話)：電話応募のユニーク化
  mcgRows.forEach(row => {
    const office = prefToOffice[(row[MCGI.pref] || '').toString().trim()];
    if (!office || !acc[office]) return;
    const phone = normPhone_(row[MCGI.phone]);
    const d = parseDate_(row[MCGI.applyDate]);
    const inMonth = inRange_(d, range.monthStart, range.monthEnd);
    const letter = judgeFromRow_(row);
    const ab = letter === 'A' || letter === 'B';

    // 電話応募 = MCGにあり総応募に無い電話（当月・電話でユニーク）→ 新規に加算
    if (inMonth && phone && !totalPhoneSet[phone]) {
      const seen = phoneAppSeen[office] || (phoneAppSeen[office] = {});
      if (!seen[phone]) {
        seen[phone] = true;
        acc[office].overview.phoneApplications += 1;
        acc[office].overview.newApplications += 1;
        if (ab) acc[office].overview.newAB += 1;
        firstDateByPhone[phone] = d; // 歩留でも当月の新規扱い
      }
    }

    // 接触数（当月応募）
    if (inMonth && (row[MCGI.contactStatus] || '').toString().trim().indexOf(CONTACT_PREFIX) === 0) {
      acc[office].overview.contacts += 1;
    }

    // 人選（当月応募・A/B/C/その他）
    if (inMonth) bumpSelection_(acc[office].selection, letter);

    // 歩留: コホート(初回応募日で判定) × 各ステージ「日付列が当月のもの」をカウント
    // 当月内応募・新規 ⊂ 2ヶ月以内応募・新規（当月含む直近2ヶ月）なので両方に加算しうる。
    const fd = firstDateByPhone[phone];
    const cohorts = [];
    if (fd) {
      if (inRange_(fd, range.monthStart, range.monthEnd)) cohorts.push('currentMonthNew');
      if (inRange_(fd, range.twoMonthStart, range.monthEnd)) cohorts.push('within2MonthsNew');
    }
    if (rePhoneInMonth[phone]) cohorts.push('reApplication'); // 当月に再応募した人のみ
    cohorts.forEach(c => {
      const f = acc[office].funnel[c];
      FUNNEL_STAGES.forEach(([outKey, idxKey]) => {
        const sd = parseDate_(row[MCGI[idxKey]]);
        if (inRange_(sd, range.monthStart, range.monthEnd)) f[outKey] += 1; // その日付が当月
      });
      if (ab && phone) f._abPhones.add(phone);
    });
  });

  // --- 仕上げ ---
  const elapsed = elapsedDays_(month), totalDays = daysInMonth_(month);
  Object.values(acc).forEach(o => {
    o.overview.forecast = elapsed > 0
      ? Math.round(o.overview.newApplications / elapsed * totalDays)
      : o.overview.newApplications;
    Object.values(o.funnel).forEach(f => { f.ab = f._abPhones.size; delete f._abPhones; });
  });

  const daily = Object.keys(dailyMap).sort().map(k => ({
    date: k, new: dailyMap[k].new, re: dailyMap[k].re, total: dailyMap[k].new + dailyMap[k].re,
  }));

  const summary = {
    generatedAt: new Date().toISOString(),
    month: month,
    daily: daily,
    offices: Object.values(acc).filter(hasAnyData_),
  };

  saveSummary_(month, JSON.stringify(summary));
  const sampleHeaders = totalRows[0] ? Object.keys(totalRows[0]).slice(0, 4).join(' | ') : '(none)';
  Logger.log('aggregated %s: offices=%s, dailyPoints=%s | totalRows=%s, mcgRows=%s, prefMap=%s, parsedInRange=%s | totalHeaders[0..3]=%s',
    month, summary.offices.length, daily.length,
    totalRows.length, mcgRows.length, Object.keys(prefToOffice).length,
    parsed.filter(x => inRange_(x.d, range.monthStart, range.monthEnd)).length, sampleHeaders);
  return summary;
}

/* 手元確認用: データのある月（例 2026-05）で実行 */
function runForMay2026() { return runDailyAggregation('2026-05'); }

/* =========================================================================
 * 区分・人選の判定
 * ========================================================================= */
// ⑤の行(配列)から人選を判定。4条件の該当数で A/B/C/other を返す。
//   有資格(福祉資格に「有資格」を含む) / 介護経験=有 / 勤務日数に「LT」を含む / 年齢60未満
//   4=A, 3=B, 2=C, 0-1=other
function judgeFromRow_(row) {
  let c = 0;
  if ((row[MCGI.qual] || '').toString().indexOf('有資格') >= 0) c++;
  if ((row[MCGI.exp] || '').toString().trim() === '有') c++;
  if ((row[MCGI.workdays] || '').toString().indexOf('LT') >= 0) c++;
  if (!(Number(row[MCGI.age]) >= 60)) c++;   // 60未満（空欄含む）
  if (c >= 4) return 'A';
  if (c === 3) return 'B';
  if (c === 2) return 'C';
  return 'other';
}

function bumpSelection_(sel, letter) {
  if (letter === 'A') sel.A += 1;
  else if (letter === 'B') sel.B += 1;
  else if (letter === 'C') sel.C += 1;
  else if (letter === 'other') sel.other += 1;
  else sel.unknown += 1;
}

// 人選ｽﾃｰﾀｽの表示ラベル（シート表記に合わせる）
function senbatsuLabel_(letter) {
  return { A: 'A人選（★★★★）', B: 'B人選（★★★☆）', C: 'C人選（★★☆☆）' }[letter] || 'その他';
}

/* =========================================================================
 * 当月人選シート(1NsC65W)の読み書き
 * ========================================================================= */
// 集計用に当月人選シートを行配列（ヘッダー除く）で返す。列はMCGI(列インデックス)準拠。
function readSenbatsuRows_() {
  const sh = SpreadsheetApp.openById(CONFIG.SENBATSU_SHEET_ID).getSheets()[0];
  const vals = sh.getDataRange().getValues();
  return vals.length < 2 ? [] : vals.slice(1);
}

// 人選CSV本文を 1NsC65W形式（先頭28列＋人選ｽﾃｰﾀｽ）へ整形し、人選ｽﾃｰﾀｽを4条件で算出して丸ごと置き換える。
function writeSenbatsuSheet_(csvText) {
  const SENBATSU_HEADER = ['応募日', '氏名', 'フリガナ', '電話番号', '年齢', '性別', '都道府県', '住所', '応募媒体', '接触ステータス', '登録日', '登録ステータス', '案件番号', '応募日', '人材番号', '所属', '自社人材担当者', '福祉資格', '福祉資格', '介護経験', '★新規就業ステータス', '★新規就業ステータス', '勤務日数', '勤務日数', '設定日（新規）', '実施日（新規）', '決定日（新規）', '開始日（新規）', '人選ｽﾃｰﾀｽ'];
  const W = SENBATSU_HEADER.length; // 29
  const data = Utilities.parseCsv((csvText || '').replace(/^﻿/, ''));
  const out = [SENBATSU_HEADER];
  for (let i = 1; i < data.length; i++) {
    const r = data[i];
    if (!r || !r.some(c => (c || '').toString().trim())) continue;
    const row = [];
    for (let k = 0; k < 28; k++) row.push(r[k] != null ? r[k] : ''); // 先頭28列をそのまま
    row.push(senbatsuLabel_(judgeFromRow_(r)));                       // 人選ｽﾃｰﾀｽ=4条件で算出
    out.push(row);
  }
  const sh = SpreadsheetApp.openById(CONFIG.SENBATSU_SHEET_ID).getSheets()[0];
  sh.clearContents();
  sh.getRange(1, 1, out.length, W).setValues(out);
  Logger.log('人選シート置換: %s 行', out.length - 1);
  return out.length - 1;
}

/* =========================================================================
 * 集計器
 * ========================================================================= */
function newOfficeAcc_(office, prefs, target) {
  const fnl = () => ({ set: 0, done: 0, decided: 0, started: 0, ab: 0, _abPhones: new Set() });
  return {
    office: office,
    prefectures: prefs,
    overview: { newApplications: 0, phoneApplications: 0, reApplications: 0, targetNew: target, forecast: 0, contacts: 0, newAB: 0, reAB: 0 },
    selection: { A: 0, B: 0, C: 0, other: 0, unknown: 0 },
    funnel: { currentMonthNew: fnl(), within2MonthsNew: fnl(), reApplication: fnl() },
  };
}

function hasAnyData_(o) {
  const v = o.overview;
  const sel = Object.values(o.selection).reduce((a, b) => a + b, 0);
  return v.newApplications || v.reApplications || v.contacts || v.targetNew || sel;
}

/* =========================================================================
 * マスタ
 * ========================================================================= */
// ヘッダー語から列を特定して2列を読む（先頭の空行/空列に依存しない）
function parseMaster_(sheetId, keysA, keysB) {
  const vals = readSheetMatrix_(sheetId);
  let hr = -1, ca = -1, cb = -1;
  for (let i = 0; i < vals.length; i++) {
    const row = vals[i].map(c => (c || '').toString().trim());
    const ia = row.findIndex(c => keysA.indexOf(c) >= 0);
    const ib = row.findIndex(c => keysB.indexOf(c) >= 0);
    if (ia >= 0 && ib >= 0) { hr = i; ca = ia; cb = ib; break; }
  }
  if (hr < 0) { Logger.log('master header not found: ' + sheetId); return []; }
  const out = [];
  for (let i = hr + 1; i < vals.length; i++) {
    const a = (vals[i][ca] || '').toString().trim();
    const b = (vals[i][cb] || '').toString().trim();
    if (a) out.push([a, b]);
  }
  return out;
}

// 対応表: 都道府県 → オフィス
function loadPrefToOffice_() {
  const map = {};
  parseMaster_(CONFIG.PREF_OFFICE_SHEET_ID, ['都道府県'], ['オフィス', 'オフィス名'])
    .forEach(([pref, office]) => { if (office) map[pref] = office; });
  return map;
}

// 目標: オフィス → 目標
function loadTargets_() {
  const map = {};
  parseMaster_(CONFIG.TARGET_SHEET_ID, ['オフィス', 'オフィス名'], ['目標', '目標新規'])
    .forEach(([office, t]) => { map[office] = Number(t) || 0; });
  return map;
}

function invertPrefMap_(prefToOffice) {
  const out = {};
  Object.keys(prefToOffice).forEach(pref => {
    const office = prefToOffice[pref];
    (out[office] = out[office] || []).push(pref);
  });
  return out;
}

/* =========================================================================
 * I/O
 * ========================================================================= */
function readLatestCsv_(folderId, charset) {
  const files = DriveApp.getFolderById(folderId).getFiles();
  let best = null;
  while (files.hasNext()) {
    const f = files.next();
    if (f.getName().toLowerCase().slice(-4) === '.csv' && (!best || f.getLastUpdated() > best.getLastUpdated())) best = f;
  }
  if (!best) { Logger.log('CSV not found in folder ' + folderId); return []; }
  return csvToObjects_(best.getBlob().getDataAsString(charset || 'UTF-8'));
}

function csvToObjects_(text) {
  const clean = (text || '').replace(/^﻿/, ''); // 先頭BOM除去
  const data = Utilities.parseCsv(clean);
  if (!data || data.length < 2) return [];
  const header = data[0].map(h => (h || '').replace(/^﻿/, '').trim());
  return data.slice(1).map(row => {
    const o = {};
    header.forEach((h, i) => { if (o[h] === undefined) o[h] = row[i]; }); // 重複ヘッダーは先頭優先
    return o;
  });
}

function readSheetMatrix_(sheetId) {
  const ss = SpreadsheetApp.openById(sheetId);
  const sh = ss.getSheets()[0];
  const vals = sh.getDataRange().getValues();
  Logger.log('master "%s" sheet="%s" rows=%s row0=%s row1=%s',
    ss.getName(), sh.getName(), vals.length, JSON.stringify(vals[0]), JSON.stringify(vals[1]));
  return vals;
}

// 先頭シートをヘッダー行キーのオブジェクト配列にする（総応募の累積シート用）
function readSheetObjects_(sheetId) {
  const sh = SpreadsheetApp.openById(sheetId).getSheets()[0];
  const vals = sh.getDataRange().getValues();
  if (vals.length < 2) return [];
  const header = vals[0].map(h => (h || '').toString().replace(/^﻿/, '').trim());
  return vals.slice(1).map(row => {
    const o = {};
    header.forEach((h, i) => { if (o[h] === undefined) o[h] = row[i]; });
    return o;
  });
}

// フォルダ内の最新更新CSVファイル（File）を返す
function latestCsvFile_(folderId) {
  const files = DriveApp.getFolderById(folderId).getFiles();
  let best = null;
  while (files.hasNext()) {
    const f = files.next();
    if (f.getName().toLowerCase().slice(-4) === '.csv' && (!best || f.getLastUpdated() > best.getLastUpdated())) best = f;
  }
  return best;
}

// 最新CSVを「データ行の配列(行=配列)」で返す（重複ヘッダーがある⑤用。ヘッダー行は除外）
function readLatestCsvMatrix_(folderId, charset) {
  const f = latestCsvFile_(folderId);
  if (!f) { Logger.log('CSV not found in folder ' + folderId); return []; }
  const data = Utilities.parseCsv((f.getBlob().getDataAsString(charset || 'UTF-8') || '').replace(/^﻿/, ''));
  return data.length < 2 ? [] : data.slice(1);
}

function saveSummary_(month, json) {
  CacheService.getScriptCache().put(CONFIG.CACHE_KEY + ':' + month, json, CONFIG.CACHE_TTL_SEC);
  const folder = DriveApp.getFolderById(CONFIG.OUTPUT_FOLDER_ID);
  const name = month + '_' + CONFIG.SUMMARY_FILENAME;
  const it = folder.getFilesByName(name);
  if (it.hasNext()) it.next().setContent(json);
  else folder.createFile(name, json, 'application/json');
}

function readSummaryFromDrive_(month) {
  const it = DriveApp.getFolderById(CONFIG.OUTPUT_FOLDER_ID).getFilesByName(month + '_' + CONFIG.SUMMARY_FILENAME);
  return it.hasNext() ? it.next().getBlob().getDataAsString('UTF-8') : null;
}

/* =========================================================================
 * 日付・文字列
 * ========================================================================= */
function currentMonthKey_() { return Utilities.formatDate(new Date(), CONFIG.TZ, 'yyyy-MM'); }

function monthRange_(month) {
  const [y, m] = month.split('-').map(Number);
  return {
    monthStart: new Date(y, m - 1, 1),
    monthEnd: new Date(y, m, 0, 23, 59, 59),
    twoMonthStart: new Date(y, m - 2, 1), // 当月含む直近2ヶ月＝前月1日〜当月末
  };
}

function daysInMonth_(month) { const [y, m] = month.split('-').map(Number); return new Date(y, m, 0).getDate(); }

function elapsedDays_(month) {
  const now = new Date();
  if (Utilities.formatDate(now, CONFIG.TZ, 'yyyy-MM') !== month) return daysInMonth_(month);
  return Number(Utilities.formatDate(now, CONFIG.TZ, 'd'));
}

function parseDate_(v) {
  if (!v) return null;
  if (v instanceof Date) return v;
  const m = v.toString().match(/(\d{4})[\/\-.](\d{1,2})[\/\-.](\d{1,2})/); // 年月日（ゼロ詰め有無・時刻付き対応）
  if (!m) return null;
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}

function fmtDate_(d) { return d ? Utilities.formatDate(d, CONFIG.TZ, 'yyyy-MM-dd') : ''; }
function inRange_(d, a, b) { return !!d && d >= a && d <= b; }
function notEmpty_(v) { return v !== null && v !== undefined && v.toString().trim() !== ''; }
function normPhone_(v) { return (v || '').toString().replace(/[^0-9]/g, ''); }

/* =========================================================================
 * 総応募シートへの追記（応募ツールのCSVを末尾へ追加）
 *   ※ 重複追記防止のため、処理済みCSVのファイルIDを記録する。
 *   ※ 既に同じデータがシートに入っている古いCSVを残したまま実行すると二重追記に
 *      なるので、フォルダには「新しく吐き出したCSV」だけを置く運用にする。
 * ========================================================================= */
function appendNewTotalCsvs() {
  const props = PropertiesService.getScriptProperties();
  const KEY = 'appendedCsvIds';
  const done = new Set(JSON.parse(props.getProperty(KEY) || '[]')); // 取込済みファイルIDの集合

  // フォルダ内の未処理CSVを集める（毎朝の新ファイルを取りこぼさない）
  const files = DriveApp.getFolderById(CONFIG.TOTAL_FOLDER_ID).getFiles();
  const pending = [];
  while (files.hasNext()) {
    const f = files.next();
    if (f.getName().toLowerCase().slice(-4) === '.csv' && !done.has(f.getId())) pending.push(f);
  }
  if (!pending.length) { Logger.log('追記対象の新規CSVなし'); return; }
  pending.sort((a, b) => a.getLastUpdated() - b.getLastUpdated()); // 古い順に追記して時系列を保つ

  const sh = SpreadsheetApp.openById(CONFIG.TOTAL_SHEET_ID).getSheets()[0];
  const sheetHeader = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0].map(h => (h || '').toString().trim());

  let appended = 0;
  pending.forEach(f => {
    const data = Utilities.parseCsv((f.getBlob().getDataAsString(CONFIG.CHARSET_TOTAL) || '').replace(/^﻿/, ''));
    if (data.length < 2) { Logger.log('CSVが空: ' + f.getName()); done.add(f.getId()); return; }
    const csvHeader = data[0].map(h => (h || '').replace(/^﻿/, '').trim());
    const idxByName = {};
    csvHeader.forEach((h, i) => { if (idxByName[h] === undefined) idxByName[h] = i; });
    // シート列名 → CSV列インデックス。名前一致が無ければ別名(HEADER_ALIASES)も探す。
    const colIndex = h => {
      if (idxByName[h] !== undefined) return idxByName[h];
      const alts = HEADER_ALIASES[h] || [];
      for (let k = 0; k < alts.length; k++) if (idxByName[alts[k]] !== undefined) return idxByName[alts[k]];
      return null;
    };
    // シートの列順に合わせて値を並べ替えて追記（CSVの列順が違っても安全）
    const rows = data.slice(1).map(r => sheetHeader.map(h => { const i = colIndex(h); return i == null ? '' : r[i]; }));
    if (rows.length) sh.getRange(sh.getLastRow() + 1, 1, rows.length, sheetHeader.length).setValues(rows);
    done.add(f.getId());
    appended += rows.length;
    Logger.log('追記 %s 行 (%s)', rows.length, f.getName());
  });
  props.setProperty(KEY, JSON.stringify(Array.from(done)));
  Logger.log('追記合計 %s 行 / %s ファイル', appended, pending.length);
}

// 初期化用: フォルダに今ある全CSVを「追記済み」として記録だけする（追記はしない）。
// 既に総応募シートへ取り込み済みのCSVが二重追記されるのを防ぐため、自動化の前に1回だけ実行する。
function markExistingCsvsProcessed() {
  const files = DriveApp.getFolderById(CONFIG.TOTAL_FOLDER_ID).getFiles();
  const ids = [];
  while (files.hasNext()) {
    const f = files.next();
    if (f.getName().toLowerCase().slice(-4) === '.csv') ids.push(f.getId());
  }
  PropertiesService.getScriptProperties().setProperty('appendedCsvIds', JSON.stringify(ids));
  Logger.log('追記済みとして記録: %s ファイル', ids.length);
}

/* =========================================================================
 * 不要行の除去（媒体も電話も空の行＝人選CSV等の誤混入を掃除）
 *   正規の総応募行は必ず媒体と電話を持つため、両方空の行は誤って混入したもの。
 * ========================================================================= */
function purgeJunkRows_() {
  const sh = SpreadsheetApp.openById(CONFIG.TOTAL_SHEET_ID).getSheets()[0];
  const lastRow = sh.getLastRow(), lastCol = sh.getLastColumn();
  if (lastRow < 3) return;
  const all = sh.getRange(1, 1, lastRow, lastCol).getValues();
  const header = all[0].map(h => (h || '').toString().trim());
  const idx = names => { for (let k = 0; k < names.length; k++) { const i = header.indexOf(names[k]); if (i >= 0) return i; } return -1; };
  const mIdx = idx([COL.total.media, '媒体']);
  const pIdx = idx([COL.total.phone, '連絡先TEL', '電話番号']);
  if (mIdx < 0 || pIdx < 0) { Logger.log('purge: 媒体/電話列なし'); return; }
  const kept = [all[0]];
  let removed = 0;
  for (let r = 1; r < all.length; r++) {
    const media = (all[r][mIdx] || '').toString().trim();
    const phone = normPhone_(all[r][pIdx]);
    if (!media && !phone) { removed++; continue; }
    kept.push(all[r]);
  }
  if (!removed) { Logger.log('purge: 不要行なし'); return; }
  sh.getRange(1, 1, kept.length, lastCol).setValues(kept);
  sh.getRange(kept.length + 1, 1, lastRow - kept.length, lastCol).clearContent();
  Logger.log('purge: %s 行を不要行として削除（%s→%s 行）', removed, lastRow - 1, kept.length - 1);
}

/* =========================================================================
 * 重複行の除去（同じ応募の二重追記を掃除）
 *   署名 = 応募日 | 電話 | 氏名 | 媒体（GASが付ける派生列は含めない）。
 *   同署名は最初の1件だけ残す。電話が空の行は誤削除を避けるため対象外（常に残す）。
 *   再アップロードや連打で全く同じ行が入っても、次の集計時に自動で掃除される。
 * ========================================================================= */
function dedupeSheet_() {
  const sh = SpreadsheetApp.openById(CONFIG.TOTAL_SHEET_ID).getSheets()[0];
  const lastRow = sh.getLastRow(), lastCol = sh.getLastColumn();
  if (lastRow < 3) return;
  const all = sh.getRange(1, 1, lastRow, lastCol).getValues();
  const header = all[0].map(h => (h || '').toString().trim());
  const idx = names => { for (let k = 0; k < names.length; k++) { const i = header.indexOf(names[k]); if (i >= 0) return i; } return -1; };
  const dIdx = idx([COL.total.applyDate, '応募日']);
  const pIdx = idx([COL.total.phone, '連絡先TEL', '電話番号']);
  const nIdx = idx(['氏名（漢字）', '氏名']);
  const mIdx = idx([COL.total.media, '媒体']);
  if (dIdx < 0 || pIdx < 0) { Logger.log('dedupe: キー列が見つからない date=%s phone=%s', dIdx, pIdx); return; }

  const seen = {};
  const kept = [all[0]];
  let removed = 0;
  for (let r = 1; r < all.length; r++) {
    const row = all[r];
    const phone = normPhone_(row[pIdx]);
    if (!phone) { kept.push(row); continue; } // 電話なしは判定困難なので常に残す
    const sig = [
      (row[dIdx] || '').toString().trim(),
      phone,
      nIdx >= 0 ? (row[nIdx] || '').toString().trim() : '',
      mIdx >= 0 ? (row[mIdx] || '').toString().trim() : '',
    ].join('|');
    if (seen[sig]) { removed++; continue; }
    seen[sig] = true;
    kept.push(row);
  }
  if (!removed) { Logger.log('dedupe: 重複なし'); return; }
  sh.getRange(1, 1, kept.length, lastCol).setValues(kept);
  sh.getRange(kept.length + 1, 1, lastRow - kept.length, lastCol).clearContent(); // 末尾の余剰行を消す
  Logger.log('dedupe: %s 行を重複として削除（%s→%s 行）', removed, lastRow - 1, kept.length - 1);
}

/* =========================================================================
 * シートの派生列を埋める（対応オフィス・新規/再応募）
 *   - 対応オフィス … マスタ(都道府県→オフィス)で判定。ダッシュボードと同じ基準。
 *   - 新規/再応募 … 累積シート全体を応募日昇順で見て、電話番号の初出=新規 / 以降=再応募。
 *   どちらの列も無ければ末尾に作る。連携・毎日トリガーのたびに全行を再計算（自己修正）。
 * ========================================================================= */
function fillDerivedColumns_() {
  const sh = SpreadsheetApp.openById(CONFIG.TOTAL_SHEET_ID).getSheets()[0];
  const lastRow = sh.getLastRow(), lastCol = sh.getLastColumn();
  if (lastRow < 2) return;
  const header = sh.getRange(1, 1, 1, lastCol).getValues()[0].map(h => (h || '').toString().trim());
  const findCol = names => { for (let k = 0; k < names.length; k++) { const i = header.indexOf(names[k]); if (i >= 0) return i; } return -1; };

  const prefIdx = findCol(['都道府県名', '都道府県']);
  const phoneIdx = findCol([COL.total.phone, '連絡先TEL', '電話番号']);
  const dateIdx = findCol([COL.total.applyDate, '応募日']);
  if (prefIdx < 0 || phoneIdx < 0 || dateIdx < 0) {
    Logger.log('fillDerived: 必要列が見つからない pref=%s phone=%s date=%s', prefIdx, phoneIdx, dateIdx);
    return;
  }

  // 出力先列（無ければ末尾に追加）
  let officeIdx = findCol(['対応オフィス', COL.total.office]); // 対応オフィス or 拠点
  let dupIdx = findCol(['新規/再応募', '重複判定']);
  let nextCol = lastCol;
  if (officeIdx < 0) { officeIdx = nextCol++; sh.getRange(1, officeIdx + 1).setValue('対応オフィス'); }
  if (dupIdx < 0) { dupIdx = nextCol++; sh.getRange(1, dupIdx + 1).setValue('新規/再応募'); }

  const prefToOffice = loadPrefToOffice_();
  const n = lastRow - 1;
  const prefCol = sh.getRange(2, prefIdx + 1, n, 1).getValues();
  const phoneCol = sh.getRange(2, phoneIdx + 1, n, 1).getValues();
  const dateCol = sh.getRange(2, dateIdx + 1, n, 1).getValues();
  const officeCur = officeIdx < lastCol ? sh.getRange(2, officeIdx + 1, n, 1).getValues() : null;

  // 重複判定: 応募日のある行を昇順に処理し、電話初出=新規 / 以降=再応募。日付なし行は後段で処理。
  const firstSeen = {};
  const dup = new Array(n);
  const dated = [];
  for (let i = 0; i < n; i++) { const d = parseDate_(dateCol[i][0]); if (d) dated.push({ i: i, d: d, phone: normPhone_(phoneCol[i][0]) }); }
  dated.sort((a, b) => a.d - b.d);
  dated.forEach(r => {
    if (!r.phone) { dup[r.i] = '新規'; return; }
    if (!firstSeen[r.phone]) { firstSeen[r.phone] = true; dup[r.i] = '新規'; } else { dup[r.i] = '再応募'; }
  });
  for (let i = 0; i < n; i++) {
    if (dup[i]) continue;
    const phone = normPhone_(phoneCol[i][0]);
    if (!phone) { dup[i] = '新規'; continue; }
    if (!firstSeen[phone]) { firstSeen[phone] = true; dup[i] = '新規'; } else { dup[i] = '再応募'; }
  }

  // 対応オフィス: マスタ優先（都道府県で判定）。都道府県が空/未対応なら既存値を維持。
  const officeOut = new Array(n);
  const dupOut = new Array(n);
  for (let i = 0; i < n; i++) {
    const pref = (prefCol[i][0] || '').toString().trim();
    const cur = officeCur ? (officeCur[i][0] || '').toString().trim() : '';
    officeOut[i] = [prefToOffice[pref] || cur || ''];
    dupOut[i] = [dup[i] || ''];
  }
  sh.getRange(2, officeIdx + 1, n, 1).setValues(officeOut);
  sh.getRange(2, dupIdx + 1, n, 1).setValues(dupOut);
  Logger.log('派生列を更新: 行=%s 対応オフィス列=%s 新規再応募列=%s', n, officeIdx + 1, dupIdx + 1);
}

/* =========================================================================
 * トリガー
 * ========================================================================= */
function installDailyTrigger() {
  ScriptApp.getProjectTriggers().forEach(t => {
    if (t.getHandlerFunction() === 'runDailyAggregation') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('runDailyAggregation').timeBased().everyDays(1)
    .atHour(CONFIG.DAILY_TRIGGER_HOUR).nearMinute(CONFIG.DAILY_TRIGGER_MINUTE).create();
}
