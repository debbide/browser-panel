const { execFileSync, execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const config = require('../config');

// 版本号只在进程启动时解析一次。git describe 要 fork 一个进程，
// 而版本在运行期间不会变（改了代码得重启），没必要每次请求都去问一遍。
let cached = null;

const STAMP_FILE = path.join(config.paths.dataDir, 'version.json');
const GIT_DIR = path.join(config.paths.root, '.git');

function hasGitRepo() {
  try {
    return fs.existsSync(GIT_DIR);
  } catch {
    return false;
  }
}

/**
 * bp.sh 安装时写下的版本戳。tarball 部署的机器上没有 .git，git describe 什么都
 * 读不到，但安装脚本本身是从 GitHub release 取的 tag —— 那才是这份代码的真实
 * 版本，所以让它把 tag 留下来，面板直接读文件，不用联网也不用 git。
 */
function readStamp() {
  try {
    const raw = fs.readFileSync(STAMP_FILE, 'utf8');
    const data = JSON.parse(raw);
    const tag = data && data.tag ? String(data.tag).trim() : '';
    return tag || null;
  } catch {
    // 没装过（开发检出）、文件损坏、权限不足 —— 都往下降级
    return null;
  }
}

function readGitDescribe() {
  try {
    const out = execFileSync('git', ['describe', '--tags', '--always', '--dirty'], {
      cwd: config.paths.root,
      timeout: 3000,
      stdio: ['ignore', 'pipe', 'ignore'],
      encoding: 'utf8',
    });
    return out.trim() || null;
  } catch {
    // 没装 git、不是仓库、或者是打包分发的目录 —— 都走后面的降级，不能让面板起不来
    return null;
  }
}

/**
 * git describe 的输出有三种形态：
 *   v1.7.3              正好落在 tag 上
 *   v1.7.3-37-g56d15f4  tag 之后又提交了 37 次
 *   56d15f4             仓库里还没有任何 tag
 * 任意一种后面都可能跟 -dirty（工作区有未提交改动）。
 */
function parseDescribe(raw) {
  const dirty = raw.endsWith('-dirty');
  const base = dirty ? raw.slice(0, -'-dirty'.length) : raw;

  const ahead = /^(.*)-(\d+)-g([0-9a-f]+)$/.exec(base);
  if (ahead) {
    return { tag: ahead[1], ahead: Number(ahead[2]), commit: ahead[3], dirty };
  }
  if (/^[0-9a-f]{7,40}$/.test(base)) {
    return { tag: null, ahead: 0, commit: base, dirty };
  }
  return { tag: base, ahead: 0, commit: null, dirty };
}

// 侧边栏那一行的短标签：贴着 tag 就只显示 tag，超出就标出领先多少个提交。
function formatLabel({ tag, ahead, commit, dirty }) {
  let label;
  if (tag && ahead > 0) label = `${tag}+${ahead}`;
  else if (tag) label = tag;
  else if (commit) label = `#${commit}`;
  else label = 'dev';
  return dirty ? `${label}*` : label;
}

function readPackageVersion() {
  try {
    const pkg = require(path.join(config.paths.root, 'package.json'));
    return pkg && pkg.version ? String(pkg.version) : null;
  } catch {
    return null;
  }
}

function resolveVersion() {
  // 手工指定优先：镜像或压缩包部署时目录里没有 .git，靠这个把版本传进来
  const pinned = String(process.env.APP_VERSION || '').trim();
  if (pinned) {
    return { label: pinned, tag: pinned, ahead: 0, commit: null, dirty: false, source: 'env' };
  }

  // 装机脚本写的 tag 排在 git describe 前面：两者都在时，说明这份代码是 bp.sh
  // 按某个 release 铺上去的，本地 .git 的 tag 反而可能是旧检出留下的。
  const stamped = readStamp();
  if (stamped) {
    return { label: stamped, tag: stamped, ahead: 0, commit: null, dirty: false, source: 'stamp' };
  }

  const describe = readGitDescribe();
  if (describe) {
    const parsed = parseDescribe(describe);
    return { ...parsed, label: formatLabel(parsed), describe, source: 'git' };
  }

  const pkgVersion = readPackageVersion();
  if (pkgVersion) {
    return { label: `v${pkgVersion}`, tag: `v${pkgVersion}`, ahead: 0, commit: null, dirty: false, source: 'package' };
  }

  return { label: 'dev', tag: null, ahead: 0, commit: null, dirty: false, source: 'unknown' };
}

/**
 * git tag 是本地引用，git fetch 不带 --tags 时不一定会拉，git push 也默认不推，
 * 所以检出目录的 tag 很容易停在几个版本之前 —— describe 出来的版本号看着正常
 * 但其实是旧的，比不显示更容易误导人。启动时补一次 tag 同步来兜住这点。
 *
 * 只在这里联网，且不阻塞启动：失败、超时、离线都无所谓，大不了显示旧标签。
 * 请求路径上永远只读本地。
 */
function refreshTags() {
  if (String(process.env.PANEL_VERSION_FETCH_TAGS || '').trim() === '0') return;
  // tarball 部署没有 .git，跑 git 只会白白报错，它走的是上面的 stamp。
  if (!hasGitRepo()) return;

  execFile(
    'git',
    ['fetch', '--tags', '--quiet', '--force'],
    { cwd: config.paths.root, timeout: 15000, windowsHide: true },
    (error) => {
      // 拉完把缓存作废，下一次请求重新 describe 一遍就是新版本号。
      if (!error) cached = null;
    },
  );
}

function getVersion() {
  if (!cached) cached = resolveVersion();
  return cached;
}

module.exports = { getVersion, refreshTags };
