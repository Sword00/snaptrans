'use strict';
/**
 * 数据目录重定向测试（需要 Electron —— 要 app.getPath / app.setPath）
 *
 *   npm run test:datadir
 *
 * 覆盖：validate 校验 / setCustom 写入引导文件 / 迁移不覆盖已有数据 /
 *       reset 解除重定向 / status 的「当前 vs 待生效」区分。
 *
 * ⚠️ 安全约束：这个脚本会往**真实**的默认数据目录写引导文件 datadir.txt。
 * 所以：
 *   1) 开跑前先确认没有已存在的引导文件，有就直接中止（绝不覆盖用户的真实设置）；
 *   2) 全程 try/finally，finally 里 reset() 并断言引导文件已删除；
 *   3) 不删任何用户文件，只往临时目录写。
 */
const { app } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');

const datadir = require(path.join(__dirname, '..', 'src', 'datadir'));

let pass = 0;
let fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log(`  \u2705 ${name}`); }
  else { fail++; console.log(`  \u274c ${name}${extra ? '  \u2192 ' + extra : ''}`); }
}

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'snaptrans-dd-'));

app.whenReady().then(async () => {
  let aborted = false;
  try {
    console.log(`[test] 默认数据目录 = ${datadir.DEFAULT_DIR}`);
    console.log(`[test] 引导文件      = ${datadir.BOOTSTRAP}`);
    console.log(`[test] 临时目录      = ${tmpRoot}`);
    console.log(`[test] app.name      = ${app.name}（用 node scripts/start.js <脚本> 启动时，`);
    console.log('         Electron 找不到 package.json，name 会退化成 Electron，');
    console.log('         所以这里的「默认目录」和真实程序用的 SnapTrans 目录不是同一个 ——');
    console.log('         这反而更安全：测试不会碰到你的真实配置。）');

    // ---------- 前置安全检查 ----------
    if (fs.existsSync(datadir.BOOTSTRAP)) {
      console.error('\n\u26a0 检测到已存在的引导文件（说明本机已配置过自定义数据目录）。');
      console.error('  为避免覆盖你的真实设置，测试中止。请先删掉它再跑测试：');
      console.error('  ' + datadir.BOOTSTRAP);
      aborted = true;
    }

    if (!aborted) {
    /* ---------- 1. validate ---------- */
    console.log('\n[1] validate 校验');
    ok('相对路径 → 拒绝', datadir.validate('foo/bar').ok === false, JSON.stringify(datadir.validate('foo/bar')));
    ok('空值 → 拒绝', datadir.validate('').ok === false);
    ok('默认目录 → 拒绝（无需更改）', datadir.validate(datadir.DEFAULT_DIR).ok === false,
      JSON.stringify(datadir.validate(datadir.DEFAULT_DIR)));

    const aFile = path.join(tmpRoot, 'a-file.txt');
    fs.writeFileSync(aFile, 'x');
    ok('指向一个文件 → 拒绝', datadir.validate(aFile).ok === false, JSON.stringify(datadir.validate(aFile)));

    const good = path.join(tmpRoot, 'data');
    const v = datadir.validate(good);
    ok('可写的临时目录 → 通过', v.ok === true, JSON.stringify(v));
    ok('通过时自动建出目录', fs.existsSync(good));
    ok('探针文件已清理干净', fs.readdirSync(good).length === 0, fs.readdirSync(good).join(','));

    /* ---------- 2. status 区分「当前」与「待生效」 ---------- */
    console.log('\n[2] status：当前目录 vs 重启后生效的目录');
    let st = datadir.status();
    ok('初始：dataDir = 默认目录', st.dataDir === datadir.DEFAULT_DIR, st.dataDir);
    ok('初始：dataDirCustom = false', st.dataDirCustom === false);
    ok('初始：没有待生效的切换', st.dataDirPending === '', st.dataDirPending);

    /* ---------- 3. setCustom ---------- */
    console.log('\n[3] setCustom：写引导文件 + 迁移');
    const r = datadir.setCustom(good);
    ok('setCustom 成功', r.ok === true, JSON.stringify(r));
    ok('引导文件已创建', fs.existsSync(datadir.BOOTSTRAP));
    ok('引导文件内容 = 目标目录',
      fs.readFileSync(datadir.BOOTSTRAP, 'utf8').trim() === good,
      fs.readFileSync(datadir.BOOTSTRAP, 'utf8').trim());
    ok('needRestart = true', r.needRestart === true);

    // 迁移：默认目录里的 settings.json 应被复制过去（只读源、写目标，不破坏原文件）
    const srcSettings = path.join(datadir.DEFAULT_DIR, 'settings.json');
    const dstSettings = path.join(good, 'settings.json');
    if (fs.existsSync(srcSettings)) {
      ok('settings.json 已迁移到新目录', fs.existsSync(dstSettings));
      ok('迁移内容与原文件一致',
        fs.readFileSync(dstSettings, 'utf8') === fs.readFileSync(srcSettings, 'utf8'));
      ok('原文件仍在（迁移是复制不是移动）', fs.existsSync(srcSettings));
    } else {
      console.log('  （默认目录暂无 settings.json，跳过迁移内容比对）');
    }

    st = datadir.status();
    ok('\u2605 dataDir 仍是旧目录（重启才生效）', st.dataDir === datadir.DEFAULT_DIR, st.dataDir);
    ok('\u2605 dataDirCustom = true（用户意图已记录）', st.dataDirCustom === true);
    ok('\u2605 dataDirPending = 新目录（界面据此提示重启）', st.dataDirPending === good, st.dataDirPending);

    /* ---------- 4. 不覆盖目标目录里已有的数据 ---------- */
    console.log('\n[4] 目标目录已有同名文件时不许覆盖');
    const good2 = path.join(tmpRoot, 'data2');
    fs.mkdirSync(good2, { recursive: true });
    const sentinel = path.join(good2, 'settings.json');
    fs.writeFileSync(sentinel, '{"sentinel":true}');
    datadir.setCustom(good2);
    ok('已有 settings.json 未被覆盖',
      fs.readFileSync(sentinel, 'utf8') === '{"sentinel":true}',
      fs.readFileSync(sentinel, 'utf8'));

    /* ---------- 5. reset ---------- */
    console.log('\n[5] reset：解除重定向');
    const rr = datadir.reset();
    ok('reset 成功', rr.ok === true, JSON.stringify(rr));
    ok('引导文件已删除', !fs.existsSync(datadir.BOOTSTRAP));
    st = datadir.status();
    ok('dataDirCustom 回到 false', st.dataDirCustom === false);
    // 注意：本进程里 current() 从头到尾没变过（setPath 只在启动时执行），
    // 所以 reset 之后「当前目录」本来就等于默认目录，不该有待生效的切换。
    ok('没有待生效的切换（current 本就是默认目录）', st.dataDirPending === '', JSON.stringify(st.dataDirPending));
    ok('reset().needRestart = false（同上）', rr.needRestart === false, String(rr.needRestart));
    ok('已迁移过去的数据不会被删掉', fs.existsSync(dstSettings) || !fs.existsSync(srcSettings));
    } // if (!aborted)
  } catch (e) {
    fail++;
    console.error('\n[test] 异常：', (e && e.stack) || e);
  } finally {
    // 无论如何都要把引导文件清掉，绝不污染真实环境
    try { datadir.reset(); } catch (_) { /* ignore */ }
    const dirty = fs.existsSync(datadir.BOOTSTRAP);
    console.log('\n[cleanup] 引导文件已清理：', dirty ? '\u274c 失败！请手动删除 ' + datadir.BOOTSTRAP : '\u2705 是');
    try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch (_) { /* ignore */ }

    console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
    app.exit(aborted ? 2 : (dirty || fail ? 1 : 0));
  }
}).catch((e) => {
  console.error('[test] 启动异常：', (e && e.stack) || e);
  app.exit(1);
});
