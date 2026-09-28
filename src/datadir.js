'use strict';
/**
 * 应用数据目录重定向。
 *
 * 背景：Electron 的 userData 路径（settings.json / snaptrans.log / OCR 缓存都在这下面）
 * 只能在 app ready 之前改；而「自定义数据目录」这个设置本身又得存在某个地方 —— 鸡生蛋。
 *
 * 解法：用一个**固定位置**的引导文件记录自定义目录：
 *
 *     默认 userData/datadir.txt      （一行纯文本，内容是自定义目录的绝对路径）
 *
 * 启动流程：
 *     applyOverride()  读引导文件 → 校验 → app.setPath('userData', 自定义目录)
 *     之后 settings.init()、日志、OCR 缓存全部自动落到自定义目录，其它代码无感。
 *
 * 为什么引导文件放在**默认**目录、而不是放在自定义目录里：
 * 自定义目录一旦失效（盘符没了、目录被误删、网络盘掉线），我们还得能读到
 * 「用户原本想用哪个目录」，才能给出明确报错并安全退回默认目录。
 * 如果引导文件在自定义目录里，这种情况下程序会直接失联，连错都报不出来。
 */
const fs = require('fs');
const path = require('path');

const { app } = require('electron');

/** 默认数据目录（在 applyOverride 之前抓，之后 app.getPath('userData') 就变了） */
const DEFAULT_DIR = app.getPath('userData');

const BOOTSTRAP = path.join(DEFAULT_DIR, 'datadir.txt');

/** 换目录时要一起搬走的运行时产物（配置 + OCR 缓存） */
// 换数据目录时一并搬走的东西。注意这里只搬「用户资产」，
// 不搬可再生成的缓存：OCR 引擎已换成 PaddleOCR（模型随包发布），
// 旧的 tesseract-cache 目录不再需要，故意不迁移。
const MIGRATE = ['settings.json'];

let applied = null; // applyOverride() 的结果，供日志使用

function norm(p) {
  return path.resolve(String(p || '').trim());
}

/** Windows 下路径比较要忽略大小写和结尾分隔符 */
function samePath(a, b) {
  const f = (s) => norm(s).replace(/[\\/]+$/, '').toLowerCase();
  return f(a) === f(b);
}

function readBootstrap() {
  try {
    if (!fs.existsSync(BOOTSTRAP)) return '';
    return fs.readFileSync(BOOTSTRAP, 'utf8').trim();
  } catch (_) {
    return '';
  }
}

/**
 * 校验一个候选数据目录是否可用。
 * 返回 { ok, dir, error }
 */
function validate(dir) {
  // ⚠️ 必须在 norm() **之前**判空和判绝对路径。
  // path.resolve('') 会返回当前工作目录、path.resolve('foo/bar') 会补成绝对路径，
  // 先 resolve 再判 isAbsolute 的话这两个检查永远通过 —— 等于没校验。
  const raw = String(dir == null ? '' : dir).trim();
  if (!raw) return { ok: false, error: '目录为空' };
  if (!path.isAbsolute(raw)) return { ok: false, error: '必须是绝对路径' };

  const p = norm(raw);
  if (samePath(p, DEFAULT_DIR)) return { ok: false, error: '这就是默认目录，无需更改' };

  // 必须是目录（已存在的话）
  try {
    if (fs.existsSync(p) && !fs.statSync(p).isDirectory()) {
      return { ok: false, error: '该路径已存在且不是文件夹' };
    }
  } catch (e) {
    return { ok: false, error: `无法访问该路径：${e.message}` };
  }

  // 可写性探针：建目录 + 写一个临时文件再删掉
  try {
    fs.mkdirSync(p, { recursive: true });
    const probe = path.join(p, `.snaptrans-write-test-${process.pid}`);
    fs.writeFileSync(probe, 'ok');
    fs.unlinkSync(probe);
  } catch (e) {
    return { ok: false, error: `目录不可写：${e.message}` };
  }

  return { ok: true, dir: p };
}

/**
 * 启动时调用。必须在任何代码读写 userData 之前执行（日志、settings 都在 userData 下）。
 * 返回 { custom, dir, error }
 */
function applyOverride() {
  const raw = readBootstrap();
  if (!raw) {
    applied = { custom: false, dir: DEFAULT_DIR, error: '' };
    return applied;
  }

  const v = validate(raw);
  if (!v.ok) {
    // 引导文件指向了一个坏目录：退回默认，但**不删**引导文件，
    // 这样用户修好盘符/目录后重启就能恢复，而且日志里能看到原因。
    applied = { custom: false, dir: DEFAULT_DIR, error: `自定义数据目录不可用（${v.error}），已退回默认目录`, wanted: norm(raw) };
    return applied;
  }

  try {
    app.setPath('userData', v.dir);
    applied = { custom: true, dir: v.dir, error: '' };
  } catch (e) {
    applied = { custom: false, dir: DEFAULT_DIR, error: `设置数据目录失败（${e.message}），已退回默认目录` };
  }
  return applied;
}

/** 当前生效的数据目录 */
function current() {
  try { return app.getPath('userData'); } catch (_) { return DEFAULT_DIR; }
}

/** 递归复制（best-effort），返回复制的文件数 */
function copyInto(src, dest) {
  let n = 0;
  try {
    if (!fs.existsSync(src)) return 0;
    const st = fs.statSync(src);
    if (st.isDirectory()) {
      fs.mkdirSync(dest, { recursive: true });
      for (const name of fs.readdirSync(src)) {
        n += copyInto(path.join(src, name), path.join(dest, name));
      }
    } else {
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(src, dest);
      n++;
    }
  } catch (_) { /* 单个文件失败不影响整体 */ }
  return n;
}

/**
 * 设置自定义数据目录。会把配置和 OCR 缓存搬过去，然后需要重启才生效。
 * 返回 { ok, dir, moved, error }
 */
function setCustom(dir) {
  const v = validate(dir);
  if (!v.ok) return { ok: false, error: v.error };

  const from = current();
  let moved = 0;

  // 迁移：只在目标目录里还没有对应文件时才拷，避免覆盖用户已存在的数据
  for (const name of MIGRATE) {
    const src = path.join(from, name);
    const dest = path.join(v.dir, name);
    if (!fs.existsSync(src)) continue;
    if (fs.existsSync(dest)) continue;
    moved += copyInto(src, dest);
  }

  try {
    fs.mkdirSync(DEFAULT_DIR, { recursive: true });
    fs.writeFileSync(BOOTSTRAP, v.dir, 'utf8');
  } catch (e) {
    return { ok: false, error: `写入引导文件失败：${e.message}` };
  }

  return { ok: true, dir: v.dir, from, moved, needRestart: !samePath(v.dir, from) };
}

/** 恢复默认数据目录（同样需要重启）。不删除已迁移过去的数据，只解除重定向。 */
function reset() {
  try {
    if (fs.existsSync(BOOTSTRAP)) fs.unlinkSync(BOOTSTRAP);
  } catch (e) {
    return { ok: false, error: `删除引导文件失败：${e.message}` };
  }
  return { ok: true, dir: DEFAULT_DIR, from: current(), needRestart: !samePath(DEFAULT_DIR, current()) };
}

/** 轻量读取引导文件里配置的目录。不建目录、不写探针，可以随便调。 */
function configuredDir() {
  const raw = readBootstrap();
  if (!raw) return '';
  // 同样先判绝对路径再 resolve（见 validate 里的说明）
  return path.isAbsolute(raw) ? norm(raw) : '';
}

/**
 * 当前状态。字段名和渲染层读的一一对应（渲染层直接 spread 这个对象）。
 *
 * ⚠️ 注意区分三个概念，混起来界面就会显示错：
 *   dataDir        —— **现在**实际在用的目录（app.getPath('userData')）
 *   dataDirConfigured —— 引导文件里配的目录（用户意图，重启后才生效）
 *   dataDirPending —— 非空表示「重启后才会切到这儿」
 *
 * 改完目录但还没重启时，dataDir 仍是旧的、dataDirConfigured 已经是新的 ——
 * 如果拿 dataDir 去判断「是否自定义」，界面就会在改完之后显示「正在使用默认目录」。
 */
function status() {
  const cur = current();
  const want = configuredDir() || DEFAULT_DIR; // 重启后会生效的目录
  return {
    dataDir: cur,
    defaultDataDir: DEFAULT_DIR,
    dataDirCustom: !!configuredDir(),
    dataDirConfigured: configuredDir(),
    dataDirPending: samePath(want, cur) ? '' : want,
    dataDirBootstrap: BOOTSTRAP,
    dataDirApplied: applied,
  };
}

module.exports = {
  applyOverride, setCustom, reset, status, current, validate,
  configuredDir, DEFAULT_DIR, BOOTSTRAP,
};
