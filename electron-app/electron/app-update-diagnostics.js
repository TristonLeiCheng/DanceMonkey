const fs = require('node:fs');
const path = require('node:path');

const STAGE_MESSAGES = {
  download: '更新包下载失败，请检查网络后重试。',
  checksum: '更新包校验失败，请重新检查更新以下载完整安装包。',
  extract: '更新包解压失败，请重新下载；若仍失败，请查看更新日志。',
  payload: '更新包内容校验失败，请查看更新日志后重试。',
  signature: '更新包签名校验失败，已保留当前应用。请使用签名有效的完整安装包。',
  copy: '更新文件准备失败，请检查磁盘空间和应用目录权限后重试。',
  launch: '更新安装程序启动失败，请重试并查看更新日志。',
};

function publicUpdateError(error, fallback) {
  if (error?.code === 'DM_MAC_UPDATE_INSTALL_LOCATION') return '请将应用移到可写的应用程序文件夹后重试。';
  if (error?.code === 'DM_PET_UPDATE_UNAVAILABLE') return error.message;
  if (error?.code === 'DM_UPDATE_SIGNATURE') return STAGE_MESSAGES.signature;
  if (error?.code === 'ENOSPC') return '磁盘空间不足，无法准备更新。请释放空间后重试。';
  return STAGE_MESSAGES[error?.updateStage] || fallback;
}

// Keep the most recent failure outside temporary downloads, which are cleaned up.
// Record command stderr (e.g. codesign/tar), never settings, download URLs or headers.
function recordUpdateFailure(userData, stage, error, version = '') {
  error.updateStage ||= stage;
  try {
    const directory = path.join(userData, 'update-logs');
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const redact = value => String(value || '').replace(/https?:\/\/[^\s"'<>]+/gi, '[URL]').slice(0, 12000);
    const detail = { at: new Date().toISOString(), stage: error.updateStage, version,
      code: error.code || '', message: redact(error.message), stderr: redact(error.stderr),
      cause: redact(error.cause?.message), stack: redact(error.stack) };
    fs.writeFileSync(path.join(directory, 'last-error.json'), JSON.stringify(detail, null, 2) + '\n', { mode: 0o600 });
  } catch (loggingError) { console.warn('Unable to record application update failure', loggingError.code); }
  return error;
}

module.exports = { publicUpdateError, recordUpdateFailure };
