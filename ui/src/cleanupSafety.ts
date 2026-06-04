/**
 * Cleanup safety classifier for Windows file system paths.
 *
 * Pure function — no I/O, no side effects, no React dependencies.
 * Classification is heuristic and based on path strings only.
 * disk-insight does not recommend deletion; all guidance is for information only.
 *
 * Evaluation priority (first match wins):
 *   protected-system → recycle-bin → app-managed → temp-candidate
 *   → cache-candidate → dev-dependency → user-data → unknown
 */

// ── Types ─────────────────────────────────────────────────────────────────────

export type CleanupSafetyCategory =
  | 'protected-system'
  | 'app-managed'
  | 'user-data'
  | 'cache-candidate'
  | 'temp-candidate'
  | 'dev-dependency'
  | 'recycle-bin'
  | 'unknown';

export type CleanupSafetyTone =
  | 'strong-caution'
  | 'caution'
  | 'neutral'
  | 'review-candidate'
  | 'none';

export interface CleanupSafetyClassification {
  category: CleanupSafetyCategory;
  tone: CleanupSafetyTone;
  labelEn: string;
  labelJa: string;
  noteEn: string;
  noteJa: string;
}

// ── Label / note data ─────────────────────────────────────────────────────────

const CLASSIFICATIONS: Readonly<Record<CleanupSafetyCategory, CleanupSafetyClassification>> = {
  'protected-system': {
    category: 'protected-system',
    tone: 'strong-caution',
    labelEn: 'Protected system',
    labelJa: 'システム保護領域',
    noteEn: 'System-managed area. Avoid manual deletion.',
    noteJa: 'システム管理領域です。手動削除は避けてください。',
  },
  'recycle-bin': {
    category: 'recycle-bin',
    tone: 'review-candidate',
    labelEn: 'Recycle Bin',
    labelJa: 'ごみ箱',
    noteEn: 'Recycle Bin. Empty it from Windows if you intend to free space.',
    noteJa: 'ごみ箱です。容量を空けたい場合は Windows のごみ箱から空にしてください。',
  },
  'app-managed': {
    category: 'app-managed',
    tone: 'caution',
    labelEn: 'App-managed',
    labelJa: 'アプリ管理領域',
    noteEn: 'App-managed area. Prefer app settings or uninstaller.',
    noteJa: 'アプリ管理領域です。アプリの設定またはアンインストーラの利用を推奨します。',
  },
  'temp-candidate': {
    category: 'temp-candidate',
    tone: 'review-candidate',
    labelEn: 'Temp candidate',
    labelJa: '一時ファイル候補',
    noteEn: 'Temporary-file name. Review after closing related apps.',
    noteJa: '一時ファイルらしい名前です。関連アプリを閉じてから確認してください。',
  },
  'cache-candidate': {
    category: 'cache-candidate',
    tone: 'review-candidate',
    labelEn: 'Cache candidate',
    labelJa: 'キャッシュ候補',
    noteEn: 'Cache-like name. Review after closing related apps.',
    noteJa: 'キャッシュらしい名前です。関連アプリを閉じてから確認してください。',
  },
  'dev-dependency': {
    category: 'dev-dependency',
    tone: 'review-candidate',
    labelEn: 'Dev dependency',
    labelJa: '開発依存物',
    noteEn: 'Often re-generatable, but project-dependent. Review manually.',
    noteJa: '再生成可能なことが多いですが、プロジェクト依存です。手動で確認してください。',
  },
  'user-data': {
    category: 'user-data',
    tone: 'neutral',
    labelEn: 'User data',
    labelJa: 'ユーザーデータ',
    noteEn: 'User data. Delete only if you recognize it.',
    noteJa: 'ユーザーデータです。内容を理解している場合のみ削除してください。',
  },
  'unknown': {
    category: 'unknown',
    tone: 'none',
    labelEn: 'Unknown',
    labelJa: '不明',
    noteEn: 'Unknown. No cleanup guidance available.',
    noteJa: '不明です。クリーンアップの指針はありません。',
  },
};

// ── Path normalization ────────────────────────────────────────────────────────

function normalizePath(path: string): { full: string; segments: string[] } {
  const full = path
    .replace(/\//g, '\\')       // forward slashes → backslashes
    .replace(/\\{2,}/g, '\\')  // collapse duplicate separators
    .toLowerCase();
  // Segments: strip drive letter (X:), then split and drop empty parts
  const withoutDrive = full.replace(/^[a-z]:/, '');
  const segments = withoutDrive.split('\\').filter(s => s.length > 0);
  return { full, segments };
}

// ── Category checks ───────────────────────────────────────────────────────────

function checkProtectedSystem(full: string, segments: string[]): boolean {
  // Windows OS folder and everything beneath it
  if (/^[a-z]:\\windows(\\|$)/.test(full)) return true;
  // Shadow copies / restore points
  if (/^[a-z]:\\system volume information(\\|$)/.test(full)) return true;
  // Recovery partition folders
  if (/^[a-z]:\\recovery(\\|$)/.test(full)) return true;
  // Drive-root $ system folders (e.g. $WinREAgent, $Windows.~BT).
  // Exclude $Recycle.Bin — classified separately so it gets the correct tone.
  if (
    segments.length >= 1 &&
    segments[0].startsWith('$') &&
    segments[0] !== '$recycle.bin'
  ) return true;
  return false;
}

function checkRecycleBin(segments: string[]): boolean {
  return segments.some(s => s === '$recycle.bin');
}

function checkAppManaged(full: string): boolean {
  if (/^[a-z]:\\program files(\\|$)/.test(full)) return true;
  if (/^[a-z]:\\program files \(x86\)(\\|$)/.test(full)) return true;
  // ProgramData and all its subdirectories (including any nested Cache / Temp)
  // are kept as app-managed to err on the safe side.
  if (/^[a-z]:\\programdata(\\|$)/.test(full)) return true;
  return false;
}

function checkTempCandidate(segments: string[]): boolean {
  return segments.some(s => s === 'temp' || s === 'tmp');
}

function checkCacheCandidate(segments: string[]): boolean {
  return segments.some(s =>
    s === 'cache'       ||
    s === 'code cache'  ||
    s === 'gpucache'    ||
    s === '.cache'      ||
    s === 'localcache'  ||
    s === 'httpcache'   ||
    s === 'imagecache',
  );
}

function checkDevDependency(segments: string[]): boolean {
  return segments.some(s =>
    s === 'node_modules' ||
    s === '.git'         ||
    s === '.gradle'      ||
    s === '.cargo'       ||
    // Rust build output; "target" is a common English word — may cause false
    // positives for non-dev folders. Noted in the sample table.
    s === 'target',
  );
}

function checkUserData(full: string): boolean {
  // Any path at or beneath C:\Users\<username>
  return /^[a-z]:\\users\\[^\\]+(\\|$)/.test(full);
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Classify a Windows path for cleanup safety guidance.
 * Input may use forward or backward slashes; drive letter is not fixed.
 * Guidance is heuristic — disk-insight does not recommend deletion.
 */
export function classifyCleanupSafety(path: string): CleanupSafetyClassification {
  if (!path || typeof path !== 'string' || path.trim() === '') {
    return CLASSIFICATIONS['unknown'];
  }
  const { full, segments } = normalizePath(path);
  if (segments.length === 0) return CLASSIFICATIONS['unknown'];

  if (checkProtectedSystem(full, segments)) return CLASSIFICATIONS['protected-system'];
  if (checkRecycleBin(segments))            return CLASSIFICATIONS['recycle-bin'];
  if (checkAppManaged(full))                return CLASSIFICATIONS['app-managed'];
  if (checkTempCandidate(segments))         return CLASSIFICATIONS['temp-candidate'];
  if (checkCacheCandidate(segments))        return CLASSIFICATIONS['cache-candidate'];
  if (checkDevDependency(segments))         return CLASSIFICATIONS['dev-dependency'];
  if (checkUserData(full))                  return CLASSIFICATIONS['user-data'];

  return CLASSIFICATIONS['unknown'];
}

// ── Sample table ──────────────────────────────────────────────────────────────
// Used to verify classifier behaviour. The `note` column explains
// non-obvious cases or known edge decisions.

export interface CleanupSafetySample {
  path: string;
  expected: CleanupSafetyCategory;
  note?: string;
}

export const CLEANUP_SAFETY_SAMPLES: CleanupSafetySample[] = [
  // protected-system ──────────────────────────────────────────────────────────
  { path: 'C:\\Windows',                   expected: 'protected-system' },
  { path: 'C:\\Windows\\WinSxS',           expected: 'protected-system' },
  { path: 'C:\\Windows\\Installer',        expected: 'protected-system' },
  { path: 'C:\\Windows\\System32',         expected: 'protected-system' },
  { path: 'C:\\System Volume Information', expected: 'protected-system' },
  { path: 'C:\\Recovery',                  expected: 'protected-system' },
  { path: 'C:\\$WinREAgent',               expected: 'protected-system', note: '$-prefixed drive-root folder → protected-system' },
  { path: 'C:\\Windows\\Temp',             expected: 'protected-system', note: 'Temp under Windows: protected-system wins over temp-candidate' },

  // recycle-bin ───────────────────────────────────────────────────────────────
  { path: 'C:\\$Recycle.Bin',              expected: 'recycle-bin' },
  { path: 'D:\\$Recycle.Bin\\S-1-5-21-x', expected: 'recycle-bin' },

  // app-managed ───────────────────────────────────────────────────────────────
  { path: 'C:\\Program Files',             expected: 'app-managed' },
  { path: 'C:\\Program Files\\Foo',        expected: 'app-managed' },
  { path: 'C:\\Program Files (x86)',       expected: 'app-managed' },
  { path: 'C:\\Program Files (x86)\\Foo', expected: 'app-managed' },
  { path: 'C:\\ProgramData',               expected: 'app-managed' },
  { path: 'C:\\ProgramData\\SomeApp',      expected: 'app-managed' },
  { path: 'C:\\ProgramData\\Foo\\Cache',   expected: 'app-managed', note: 'ProgramData subtree stays app-managed (safe-side)' },
  { path: 'C:\\ProgramData\\Foo\\Temp',    expected: 'app-managed', note: 'ProgramData > Temp: app-managed wins (safe-side)' },

  // temp-candidate ────────────────────────────────────────────────────────────
  { path: 'C:\\Users\\iwadj\\AppData\\Local\\Temp', expected: 'temp-candidate' },
  { path: 'D:\\Temp',                      expected: 'temp-candidate' },
  { path: 'D:\\tmp',                       expected: 'temp-candidate' },
  { path: 'D:\\proj\\temp',               expected: 'temp-candidate', note: 'any path with a \\temp segment' },

  // cache-candidate ───────────────────────────────────────────────────────────
  { path: 'C:\\Users\\iwadj\\AppData\\Local\\Google\\Chrome\\User Data\\Default\\Cache',
    expected: 'cache-candidate' },
  { path: 'C:\\Users\\iwadj\\AppData\\Local\\Microsoft\\Edge\\User Data\\Default\\Cache',
    expected: 'cache-candidate' },
  { path: 'C:\\Users\\iwadj\\AppData\\Local\\Packages\\Microsoft.WindowsStore_abc\\LocalCache',
    expected: 'cache-candidate' },
  { path: 'D:\\proj\\.cache',              expected: 'cache-candidate' },
  { path: 'D:\\proj\\GPUCache',            expected: 'cache-candidate' },

  // dev-dependency ────────────────────────────────────────────────────────────
  { path: 'D:\\proj\\node_modules',       expected: 'dev-dependency' },
  { path: 'D:\\proj\\.git',               expected: 'dev-dependency' },
  { path: 'D:\\proj\\.gradle',            expected: 'dev-dependency' },
  { path: 'D:\\proj\\.cargo',             expected: 'dev-dependency' },
  { path: 'D:\\proj\\myapp\\target',      expected: 'dev-dependency', note: 'Rust build output; "target" is a common word — possible false positives' },

  // user-data ─────────────────────────────────────────────────────────────────
  { path: 'C:\\Users\\iwadj\\Documents',  expected: 'user-data' },
  { path: 'C:\\Users\\iwadj\\Pictures',   expected: 'user-data' },
  { path: 'C:\\Users\\iwadj\\Videos',     expected: 'user-data' },
  { path: 'C:\\Users\\iwadj\\Music',      expected: 'user-data' },
  { path: 'C:\\Users\\iwadj\\Desktop',    expected: 'user-data' },
  { path: 'C:\\Users\\iwadj\\Downloads',  expected: 'user-data', note: 'Downloads → user-data, not cache-candidate' },
  { path: 'C:\\Users\\iwadj\\VirtualBox VMs', expected: 'user-data' },
  { path: 'C:\\Users\\iwadj\\AppData\\Roaming\\SomeApp', expected: 'user-data', note: 'AppData\\Roaming → user-data (no more specific match)' },

  // unknown ───────────────────────────────────────────────────────────────────
  { path: 'D:\\misc\\foo',                expected: 'unknown' },
  { path: 'D:\\',                         expected: 'unknown', note: 'drive root has no classifiable segment' },
  { path: '',                             expected: 'unknown', note: 'empty path' },
  { path: 'D:\\build',                    expected: 'unknown', note: '"build" excluded from dev-dependency to avoid false positives' },
  { path: 'D:\\dist',                     expected: 'unknown', note: '"dist" excluded from dev-dependency to avoid false positives' },
];

/**
 * Run the sample table and log results. For manual development use only.
 * Never called by the production UI.
 */
export function runCleanupSafetyCheck(): void {
  const results = CLEANUP_SAFETY_SAMPLES.map(({ path, expected, note }) => {
    const got = classifyCleanupSafety(path).category;
    return { pass: got === expected, path, expected, got, note: note ?? '' };
  });
  const failures = results.filter(r => !r.pass);
  console.table(results);
  if (failures.length > 0) {
    console.error(
      `[cleanupSafety] ${failures.length} / ${results.length} sample(s) did not match expected`,
    );
  } else {
    console.log(`[cleanupSafety] All ${results.length} samples pass`);
  }
}
