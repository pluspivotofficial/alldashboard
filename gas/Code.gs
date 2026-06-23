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
  media: 8,        // I 応募媒体
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
  if (e && e.parameter && e.parameter.analysis) { // 分析データ（LTV・2ヶ月用活用）
    const a = readAnalysisFromDrive_() || JSON.stringify({ error: 'analysis not generated yet' });
    return ContentService.createTextOutput(a).setMimeType(ContentService.MimeType.JSON);
  }
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
      const result = writeSenbatsuSheet_(csv);
      let summary = null;
      try { summary = runDailyAggregation(); } catch (err) { Logger.log('post-aggregate failed: ' + err); }
      return jsonOut_({ ok: true, mode: 'senbatsu', rows: result.rows, tally: result.tally, month: summary && summary.month });
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
  const officeArea = loadOfficeArea_();               // { '新宿オフィス':'関東', ... }（多数決）

  // --- 入力 ---
  const totalRows = readSheetObjects_(CONFIG.TOTAL_SHEET_ID);              // 総応募(累積シート)
  const mcgRows = readSenbatsuRows_(); // 当月人選シート(1NsC65W)を行配列で（接触/歩留/人選の正データ）

  const totalPhoneSet = {};      // 総応募に存在する電話（電話応募判定用）
  const firstDateByPhone = {};   // 電話 → 初回応募日（累積シートでの重複判定）
  const judgeByPhone = {};       // 電話 → 'A'|'B'|'C'|'other'（⑤を4条件で判定）
  const dailyMap = {};
  const mediaDailyMap = {};       // media -> date -> {new, re, ab}
  const md_ = (media, date) => {
    const m = mediaDailyMap[media] || (mediaDailyMap[media] = {});
    return m[date] || (m[date] = { new: 0, re: 0, ab: 0 });
  };
  const reDailySeen = {};        // 日次の再応募を電話ユニークにするための既出管理
  const rePhoneInMonth = {};     // 当月に再応募した電話（歩留の再応募コホート判定用）
  const range = monthRange_(month);

  // --- オフィス集計器（マスタ基準で初期化） ---
  const acc = {};
  Object.keys(officePrefs).forEach(office => {
    acc[office] = newOfficeAcc_(office, officePrefs[office], targets[office] || 0, officeArea[office] || '');
  });

  // --- 媒体×オフィス 集計器（出現したものを随時作成） ---
  const mediaMap = {};
  const macc_ = (media, office) => {
    media = media || '不明'; office = office || '不明';
    const m = mediaMap[media] || (mediaMap[media] = {});
    return m[office] || (m[office] = newMediaAcc_());
  };
  const reUniqMediaOffice = {}; // media -> office -> Set(phone)  再応募の電話ユニーク化

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
    media: normMedia_(r[COL.total.media]),
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
    dailyMap[key] = dailyMap[key] || { new: 0, re: 0, ab: 0 };
    const mo = macc_(x.media, x.office);
    if (x.first) {                                    // 初回=新規（電話ユニーク）
      acc[x.office].overview.newApplications += 1;
      mo.overview.newApplications += 1;
      dailyMap[key].new += 1;
      md_(x.media, key).new += 1;
      if (isAB(x.phone)) { acc[x.office].overview.newAB += 1; mo.overview.newAB += 1; dailyMap[key].ab += 1; md_(x.media, key).ab += 1; }
    } else {                                          // 2回目以降=再応募（電話ユニーク）
      const set = reUniqByOffice[x.office] || (reUniqByOffice[x.office] = new Set());
      const firstReInOffice = !set.has(x.phone);      // このオフィスでこの電話の初回再応募か
      set.add(x.phone);
      if (firstReInOffice) {                          // 初回再応募の媒体に1回だけ計上（オフィス合計と一致させる）
        const mm = reUniqMediaOffice[x.media] || (reUniqMediaOffice[x.media] = {});
        (mm[x.office] || (mm[x.office] = new Set())).add(x.phone);
      }
      rePhoneInMonth[x.phone] = true;                 // 当月の再応募者
      if (!reDailySeen[x.phone]) { reDailySeen[x.phone] = true; dailyMap[key].re += 1; md_(x.media, key).re += 1; } // 日次もユニーク
    }
  });
  Object.keys(reUniqByOffice).forEach(o => {
    const set = reUniqByOffice[o];
    acc[o].overview.reApplications = set.size;
    set.forEach(p => { if (isAB(p)) acc[o].overview.reAB += 1; }); // 再応募A+B（電話ユニーク）
  });
  Object.keys(reUniqMediaOffice).forEach(media => {
    Object.keys(reUniqMediaOffice[media]).forEach(office => {
      const set = reUniqMediaOffice[media][office];
      const mo = macc_(media, office);
      mo.overview.reApplications = set.size;
      set.forEach(p => { if (isAB(p)) mo.overview.reAB += 1; });
    });
  });

  // --- ⑤ MCG人選: 電話応募・接触数・歩留・人選（列はインデックス参照） ---
  const phoneAppSeen = {};       // office → Set(電話)：電話応募のユニーク化
  mcgRows.forEach(row => {
    const office = prefToOffice[(row[MCGI.pref] || '').toString().trim()];
    if (!office || !acc[office]) return;
    const phone = normPhone_(row[MCGI.phone]);
    const media = normMedia_(row[MCGI.media]);
    const mo = macc_(media, office);
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
        mo.overview.phoneApplications += 1;
        mo.overview.newApplications += 1;
        if (ab) { acc[office].overview.newAB += 1; mo.overview.newAB += 1; }
        firstDateByPhone[phone] = d; // 歩留でも当月の新規扱い
      }
    }

    // 接触数（当月応募）
    if (inMonth && (row[MCGI.contactStatus] || '').toString().trim().indexOf(CONTACT_PREFIX) === 0) {
      acc[office].overview.contacts += 1;
      mo.overview.contacts += 1;
    }

    // 当月に発生した設定/開始（応募月は問わない）→ 一覧の設定数/開始数 と ④開始の応募月分布
    if (inRange_(parseDate_(row[MCGI.setNew]), range.monthStart, range.monthEnd)) acc[office].overview.setMonth += 1;
    if (inRange_(parseDate_(row[MCGI.startNew]), range.monthStart, range.monthEnd)) {
      acc[office].overview.startedMonth += 1;
      const ad = parseDate_(row[MCGI.applyDate]);
      const k = ad ? Utilities.formatDate(ad, CONFIG.TZ, 'yyyy-MM') : '不明';
      acc[office].startedApply[k] = (acc[office].startedApply[k] || 0) + 1;
    }

    // 人選（当月応募・A/B/C/その他）
    if (inMonth) {
      bumpSelection_(acc[office].selection, letter); bumpSelection_(mo.selection, letter);
      // 人選別: グレード×新規/再・稼働(就業開始)。A/B/Cは応募者明細も保持。
      const g = (letter === 'A' || letter === 'B' || letter === 'C') ? letter : 'ou';
      const isRe = !!rePhoneInMonth[phone];
      const started = !!parseDate_(row[MCGI.startNew]);
      const bs = acc[office].bySelection[g];
      if (isRe) bs.re += 1; else bs.new += 1;
      if (started) bs.started += 1;
      if (g !== 'ou') {
        const qual = (row[MCGI.qual] || '').toString().indexOf('有資格') >= 0;
        const exp = (row[MCGI.exp] || '').toString().trim() === '有';
        const wd = (row[MCGI.workdays] || '').toString().indexOf('LT') >= 0;
        const ageOk = !(Number(row[MCGI.age]) >= 60);
        acc[office].applicants.push({
          name: (row[1] || '').toString().trim(), phone: (row[MCGI.phone] || '').toString().trim(),
          age: row[MCGI.age], pref: (row[MCGI.pref] || '').toString().trim(), media: media,
          grade: g, newRe: isRe ? 're' : 'new', started: started,
          startDate: started ? fmtDate_(parseDate_(row[MCGI.startNew])) : '',
          contact: (row[MCGI.contactStatus] || '').toString().replace(/\s+/g, ' ').trim(),
          qual: qual, exp: exp, wd: wd, ageOk: ageOk,
        });
      }
    }

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
      const fm = mo.funnel[c];
      FUNNEL_STAGES.forEach(([outKey, idxKey]) => {
        const sd = parseDate_(row[MCGI[idxKey]]);
        if (inRange_(sd, range.monthStart, range.monthEnd)) { f[outKey] += 1; fm[outKey] += 1; } // その日付が当月
      });
      if (ab && phone) { f._abPhones.add(phone); fm._abPhones.add(phone); }
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

  // 媒体集計の仕上げ: funnel ab を確定 → 媒体ごとに（オフィス内訳＋合計）を構築
  Object.keys(mediaMap).forEach(media => {
    Object.keys(mediaMap[media]).forEach(office => {
      Object.values(mediaMap[media][office].funnel).forEach(f => { f.ab = f._abPhones.size; delete f._abPhones; });
    });
  });
  const mediaDailyOut = media => {
    const dm = mediaDailyMap[media] || {};
    return Object.keys(dm).sort().map(k => ({ date: k, new: dm[k].new, re: dm[k].re, total: dm[k].new + dm[k].re, ab: dm[k].ab }));
  };
  const mediaOut = Object.keys(mediaMap).map(media => {
    const offices = Object.keys(mediaMap[media]).map(office => ({
      office: office,
      overview: mediaMap[media][office].overview,
      selection: mediaMap[media][office].selection,
      funnel: mediaMap[media][office].funnel,
    })).filter(mediaOfficeHasData_).sort((a, b) => b.overview.newApplications - a.overview.newApplications);
    const tot = sumMediaOffices_(offices);
    return { media: media, overview: tot.overview, selection: tot.selection, funnel: tot.funnel, offices: offices, daily: mediaDailyOut(media) };
  }).filter(m => m.offices.length > 0).sort((a, b) => b.overview.newApplications - a.overview.newApplications);

  const daily = Object.keys(dailyMap).sort().map(k => ({
    date: k, new: dailyMap[k].new, re: dailyMap[k].re, total: dailyMap[k].new + dailyMap[k].re, ab: dailyMap[k].ab,
  }));

  const summary = {
    generatedAt: new Date().toISOString(),
    month: month,
    daily: daily,
    offices: Object.values(acc).filter(hasAnyData_),
    media: mediaOut,
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
 * 分析: LTV（応募→各ステージ経過日数）／2ヶ月用活用（前月の歩留）
 *   履歴ソース = MCG_FOLDER_ID の最新CSV（Shift_JIS・【真子】集客項目出力、列はMCGI準拠）。
 *   新規/再応募 = 履歴内で電話番号の初出=新規/以降=再応募。
 *   LTV = 上下10%除外のトリム平均、対象=180日前〜20日前（直近20日は除外）。
 *   重いので本集計とは分離。runAnalysis を実行 → analysis.json 保存。
 * ========================================================================= */
function runAnalysis() {
  const today = new Date();
  const rows = readLatestCsvMatrix_(CONFIG.MCG_FOLDER_ID, CONFIG.CHARSET_MCG);
  const prefToOffice = loadPrefToOffice_();
  const officeArea = loadOfficeArea_();

  const recs = [];
  rows.forEach(r => {
    const d = parseDate_(r[MCGI.applyDate]);
    if (!d) return;
    const office = prefToOffice[(r[MCGI.pref] || '').toString().trim()] || '';
    recs.push({
      d: d, phone: normPhone_(r[MCGI.phone]), office: office, area: officeArea[office] || '(未割当)',
      set: parseDate_(r[MCGI.setNew]), done: parseDate_(r[MCGI.doneNew]),
      dec: parseDate_(r[MCGI.decNew]), start: parseDate_(r[MCGI.startNew]),
    });
  });
  recs.sort((a, b) => a.d - b.d);
  const seen = {};
  recs.forEach(x => { if (x.phone) { x.re = !!seen[x.phone]; seen[x.phone] = true; } else x.re = false; });

  const analysis = {
    generatedAt: new Date().toISOString(),
    records: recs.length,
    ltv: buildLtv_(recs, today),
    util2m: buildUtil2m_(recs, today),
  };
  saveAnalysis_(JSON.stringify(analysis));
  Logger.log('analysis: records=%s ltv=%s〜%s util2m=%s', recs.length, analysis.ltv.window.from, analysis.ltv.window.to, analysis.util2m.month);
  return analysis;
}

const DAY_MS = 86400000;
const LTV_STAGES = ['set', 'done', 'dec', 'start'];
function trimMean10_(arr) {
  if (!arr.length) return null;
  const s = arr.slice().sort((a, b) => a - b);
  const cut = Math.floor(s.length * 0.1);
  const t = (s.length - 2 * cut) > 0 ? s.slice(cut, s.length - cut) : s;
  return Math.round(t.reduce((a, b) => a + b, 0) / t.length * 10) / 10;
}
function ltvBucket_(map, key, area) {
  if (!map[key]) { map[key] = { area: area, new: {}, re: {} }; LTV_STAGES.forEach(k => { map[key].new[k] = []; map[key].re[k] = []; }); }
  return map[key];
}
function ltvFinalize_(map) {
  const out = {};
  Object.keys(map).forEach(key => {
    const m = map[key]; out[key] = { area: m.area, new: {}, re: {} };
    ['new', 're'].forEach(g => LTV_STAGES.forEach(k => { out[key][g][k] = { avg: trimMean10_(m[g][k]), n: m[g][k].length }; }));
  });
  return out;
}
function buildLtv_(recs, today) {
  const lo = new Date(today.getTime() - 180 * DAY_MS), hi = new Date(today.getTime() - 20 * DAY_MS);
  const off = {}, are = {};
  recs.forEach(x => {
    if (!(x.d >= lo && x.d <= hi) || !x.office) return;
    const g = x.re ? 're' : 'new';
    const ob = ltvBucket_(off, x.office, x.area), ab = ltvBucket_(are, x.area, x.area);
    LTV_STAGES.forEach(k => { const sd = x[k]; if (sd && sd >= x.d) { const days = Math.round((sd - x.d) / DAY_MS); ob[g][k].push(days); ab[g][k].push(days); } });
  });
  return { window: { from: fmtDate_(lo), to: fmtDate_(hi) }, offices: ltvFinalize_(off), areas: ltvFinalize_(are) };
}

function u2Bucket_(map, key, area) {
  if (!map[key]) map[key] = { area: area, new: { 応募: 0, 設定: 0, 実施: 0, 決定: 0, 開始: 0 }, re: { 応募: 0, 設定: 0, 実施: 0, 決定: 0, 開始: 0 } };
  return map[key];
}
function buildUtil2m_(recs, today) {
  const y = today.getFullYear(), m = today.getMonth();
  const lo = new Date(y, m - 1, 1), hi = new Date(y, m, 0, 23, 59, 59);
  const off = {}, are = {};
  recs.forEach(x => {
    if (!(x.d >= lo && x.d <= hi) || !x.office) return;
    const g = x.re ? 're' : 'new';
    [[off, x.office], [are, x.area]].forEach(pair => {
      const b = u2Bucket_(pair[0], pair[1], x.area);
      b[g].応募 += 1; if (x.set) b[g].設定 += 1; if (x.done) b[g].実施 += 1; if (x.dec) b[g].決定 += 1; if (x.start) b[g].開始 += 1;
    });
  });
  return { month: Utilities.formatDate(lo, CONFIG.TZ, 'yyyy-MM'), offices: off, areas: are };
}

function saveAnalysis_(json) {
  const folder = DriveApp.getFolderById(CONFIG.OUTPUT_FOLDER_ID);
  const it = folder.getFilesByName('analysis.json');
  if (it.hasNext()) it.next().setContent(json); else folder.createFile('analysis.json', json, 'application/json');
}
function readAnalysisFromDrive_() {
  const it = DriveApp.getFolderById(CONFIG.OUTPUT_FOLDER_ID).getFilesByName('analysis.json');
  return it.hasNext() ? it.next().getBlob().getDataAsString('UTF-8') : null;
}

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

/* 応募媒体の表記ゆれ・グルーピングを統合。
 *   友人紹介 ← 友人紹介（オーガニック）/ BS
 *   自社     ← 自社/自社（会員登録）/自社（電話）/自社（求人応募）等
 *   その他媒体 ← その他媒体 / タウンワーク
 *   キューメイト ← キューメイト系 / Indeed / 求人ボックス / バイトル(Pro) / 不明 / 空欄
 *   それ以外（マイナビ・e介護転職・エン派遣 等）は原文のまま。 */
function normMedia_(m) {
  const s = (m || '').toString().trim();
  if (s.indexOf('友人紹介') >= 0 || s === 'BS') return '友人紹介';
  if (s.indexOf('自社') >= 0) return '自社';
  if (s.indexOf('その他媒体') >= 0 || s.indexOf('タウンワーク') >= 0) return 'その他媒体';
  if (!s || s.indexOf('キューメイト') >= 0 || /indeed/i.test(s) ||
      s.indexOf('求人ボックス') >= 0 || s.indexOf('バイトル') >= 0 || s.indexOf('不明') >= 0) return 'キューメイト';
  return s;
}

// 媒体集計の空集計器（funnelは集計中のみ _abPhones を持つ）
function newMediaAcc_() {
  const fnl = () => ({ set: 0, done: 0, decided: 0, started: 0, ab: 0, _abPhones: new Set() });
  return {
    overview: { newApplications: 0, phoneApplications: 0, reApplications: 0, contacts: 0, newAB: 0, reAB: 0 },
    selection: { A: 0, B: 0, C: 0, other: 0, unknown: 0 },
    funnel: { currentMonthNew: fnl(), within2MonthsNew: fnl(), reApplication: fnl() },
  };
}

function mediaOfficeHasData_(mo) {
  const v = mo.overview, s = mo.selection;
  return v.newApplications || v.reApplications || v.contacts || (s.A + s.B + s.C + s.other + s.unknown);
}

// 媒体内の複数オフィス集計を合算して媒体合計を作る
function sumMediaOffices_(offices) {
  const overview = { newApplications: 0, phoneApplications: 0, reApplications: 0, contacts: 0, newAB: 0, reAB: 0 };
  const selection = { A: 0, B: 0, C: 0, other: 0, unknown: 0 };
  const zf = () => ({ set: 0, done: 0, decided: 0, started: 0, ab: 0 });
  const funnel = { currentMonthNew: zf(), within2MonthsNew: zf(), reApplication: zf() };
  offices.forEach(mo => {
    Object.keys(overview).forEach(k => overview[k] += mo.overview[k]);
    Object.keys(selection).forEach(k => selection[k] += mo.selection[k]);
    ['currentMonthNew', 'within2MonthsNew', 'reApplication'].forEach(c => {
      ['set', 'done', 'decided', 'started', 'ab'].forEach(k => funnel[c][k] += mo.funnel[c][k]);
    });
  });
  return { overview: overview, selection: selection, funnel: funnel };
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
// 戻り値 { rows, tally } … tally=1次判定の内訳 {A,B,C,other:{total,added}}。added=前回取り込みに無かった電話番号の件数。
function writeSenbatsuSheet_(csvText) {
  const SENBATSU_HEADER = ['応募日', '氏名', 'フリガナ', '電話番号', '年齢', '性別', '都道府県', '住所', '応募媒体', '接触ステータス', '登録日', '登録ステータス', '案件番号', '応募日', '人材番号', '所属', '自社人材担当者', '福祉資格', '福祉資格', '介護経験', '★新規就業ステータス', '★新規就業ステータス', '勤務日数', '勤務日数', '設定日（新規）', '実施日（新規）', '決定日（新規）', '開始日（新規）', '人選ｽﾃｰﾀｽ'];
  const W = SENBATSU_HEADER.length; // 29
  const sh = SpreadsheetApp.openById(CONFIG.SENBATSU_SHEET_ID).getSheets()[0];

  // 取り込み前の電話集合（「追加」=今回新しく増えた電話番号の判定用）
  const prevPhones = new Set();
  const prev = sh.getDataRange().getValues();
  for (let i = 1; i < prev.length; i++) { const ph = normPhone_(prev[i][3]); if (ph) prevPhones.add(ph); }

  const data = Utilities.parseCsv((csvText || '').replace(/^﻿/, ''));
  const out = [SENBATSU_HEADER];
  const tally = { A: { total: 0, added: 0 }, B: { total: 0, added: 0 }, C: { total: 0, added: 0 }, other: { total: 0, added: 0 } };
  for (let i = 1; i < data.length; i++) {
    const r = data[i];
    if (!r || !r.some(c => (c || '').toString().trim())) continue;
    const row = [];
    for (let k = 0; k < 28; k++) row.push(r[k] != null ? r[k] : ''); // 先頭28列をそのまま
    const letter = judgeFromRow_(r);                                 // 1次判定（4条件）
    row.push(senbatsuLabel_(letter));                                // 人選ｽﾃｰﾀｽ
    out.push(row);
    const key = (letter === 'A' || letter === 'B' || letter === 'C') ? letter : 'other';
    tally[key].total += 1;
    const ph = normPhone_(r[3]);
    if (!ph || !prevPhones.has(ph)) tally[key].added += 1;          // 前回に無い＝追加
  }
  sh.clearContents();
  sh.getRange(1, 1, out.length, W).setValues(out);
  Logger.log('人選シート置換: %s 行 (A%s/B%s/C%s/他%s)', out.length - 1, tally.A.total, tally.B.total, tally.C.total, tally.other.total);
  return { rows: out.length - 1, tally: tally };
}

/* =========================================================================
 * 集計器
 * ========================================================================= */
function newOfficeAcc_(office, prefs, target, area) {
  const fnl = () => ({ set: 0, done: 0, decided: 0, started: 0, ab: 0, _abPhones: new Set() });
  return {
    office: office,
    prefectures: prefs,
    area: area || '',
    overview: { newApplications: 0, phoneApplications: 0, reApplications: 0, targetNew: target, forecast: 0, contacts: 0, newAB: 0, reAB: 0, setMonth: 0, startedMonth: 0 },
    selection: { A: 0, B: 0, C: 0, other: 0, unknown: 0 },
    funnel: { currentMonthNew: fnl(), within2MonthsNew: fnl(), reApplication: fnl() },
    bySelection: { A: { new: 0, re: 0, started: 0 }, B: { new: 0, re: 0, started: 0 }, C: { new: 0, re: 0, started: 0 }, ou: { new: 0, re: 0, started: 0 } },
    startedApply: {}, // 当月に開始した人の「応募月(yyyy-MM)→件数」分布（④用）
    applicants: [], // A/B/C の応募者明細（条件フラグ付き）
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

// オフィス → エリア。オフィスが複数エリアにまたがる場合は都道府県の多数決で1エリアに割当。
function loadOfficeArea_() {
  const vals = readSheetMatrix_(CONFIG.PREF_OFFICE_SHEET_ID);
  let hr = -1, cOff = -1, cArea = -1;
  for (let i = 0; i < vals.length; i++) {
    const row = vals[i].map(c => (c || '').toString().trim());
    const io = row.findIndex(c => c === 'オフィス' || c === 'オフィス名');
    const ia = row.findIndex(c => c === 'エリア');
    if (io >= 0 && ia >= 0) { hr = i; cOff = io; cArea = ia; break; }
  }
  if (hr < 0) { Logger.log('エリア列が見つからない: ' + CONFIG.PREF_OFFICE_SHEET_ID); return {}; }
  const count = {}; // office -> {area: 件数}
  for (let i = hr + 1; i < vals.length; i++) {
    const off = (vals[i][cOff] || '').toString().trim(), area = (vals[i][cArea] || '').toString().trim();
    if (!off || !area) continue;
    (count[off] = count[off] || {})[area] = (count[off][area] || 0) + 1;
  }
  const map = {};
  Object.keys(count).forEach(off => { map[off] = Object.keys(count[off]).sort((a, b) => count[off][b] - count[off][a])[0]; });
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
  // Driveを先に保存（容量制限なし・確実に永続化）
  const folder = DriveApp.getFolderById(CONFIG.OUTPUT_FOLDER_ID);
  const name = month + '_' + CONFIG.SUMMARY_FILENAME;
  const it = folder.getFilesByName(name);
  if (it.hasNext()) it.next().setContent(json);
  else folder.createFile(name, json, 'application/json');
  // キャッシュは best-effort（100KB超で put が例外になるため、失敗時は古いキャッシュを消してDrive参照に倒す）
  const cache = CacheService.getScriptCache(), key = CONFIG.CACHE_KEY + ':' + month;
  try { cache.put(key, json, CONFIG.CACHE_TTL_SEC); }
  catch (e) { cache.remove(key); Logger.log('cache skipped (size?): ' + e); }
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
