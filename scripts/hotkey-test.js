'use strict';
/**
 * 快捷键注册策略单测（纯 Node，不需要 Electron）
 *
 *   npm run test:hotkey
 *
 * 重点验证「改快捷键失败时不会把原来的键弄丢」。
 * 这个 bug 一旦出现是**静默**的：设置界面照样显示旧的快捷键，
 * 实际上一个都没注册，用户按了没反应还以为是程序坏了。
 */
const { looksSafe, createRegistrar } = require('../src/hotkey');

let pass = 0;
let fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log(`  \u2705 ${name}`); }
  else { fail++; console.log(`  \u274c ${name}${extra ? '  \u2192 ' + extra : ''}`); }
}

/* ---------- 1. 安全校验 ---------- */
console.log('\n[1] looksSafe —— 拦掉会把全系统打字吞掉的裸键');
const cases = [
  ['Alt+Shift+A', true],
  ['Ctrl+Alt+Q', true],
  ['CommandOrControl+Shift+Z', true],
  ['Super+Space', true],
  ['F9', true],
  ['F24', true],
  ['A', false],          // 裸字母：注册成全局键会吞掉所有输入
  ['1', false],
  ['Space', false],
  ['Enter', false],
  ['Ctrl+', false],      // 残缺表达式，不该放行
  ['', false],
  ['   ', false],
  [null, false],
  [undefined, false],
];
for (const [accel, want] of cases) {
  const got = looksSafe(accel);
  ok(`${JSON.stringify(accel)} \u2192 ${want}`, got === want, `实际 ${got}`);
}

/* ---------- 2. 注册与回滚 ---------- */
console.log('\n[2] 注册 / 回滚（假 adapter 模拟「该组合被别的程序占用」）');

const TAKEN = new Set(['Ctrl+Alt+Q']);
function makeAdapter() {
  const live = new Set();
  return {
    live,
    register(a) { if (TAKEN.has(a)) return false; live.add(a); return true; },
    unregister(a) { live.delete(a); },
    isRegistered(a) { return live.has(a); },
  };
}

const ad = makeAdapter();
const reg = createRegistrar(ad, () => {}, () => {});
let r;

r = reg.register('Alt+Shift+A');
ok('首次注册成功', r.ok && ad.isRegistered('Alt+Shift+A'), JSON.stringify(r));

r = reg.register('Ctrl+Alt+Q');
ok('注册被占用的键 → 返回失败', r.ok === false, JSON.stringify(r));
ok('\u2605 失败后原键仍在注册状态（这就是那个 bug 的判据）', ad.isRegistered('Alt+Shift+A'), `live=${[...ad.live]}`);
ok('失败的键确实没被注册', !ad.isRegistered('Ctrl+Alt+Q'));
ok('返回值带回原键，界面能显示', r.hotkey === 'Alt+Shift+A' && r.restored === 'Alt+Shift+A', JSON.stringify(r));
ok('reg.active 仍是原键', reg.active === 'Alt+Shift+A', reg.active);

r = reg.register('A');
ok('裸字母被拒绝', r.ok === false, JSON.stringify(r));
ok('\u2605 被拒绝后原键仍在', ad.isRegistered('Alt+Shift+A'), `live=${[...ad.live]}`);
ok('reg.active 没被清掉', reg.active === 'Alt+Shift+A', reg.active);

r = reg.register('Ctrl+Alt+F9');
ok('换成可用的新键 → 成功', r.ok && ad.isRegistered('Ctrl+Alt+F9'), JSON.stringify(r));
ok('旧键已被摘掉', !ad.isRegistered('Alt+Shift+A'), `live=${[...ad.live]}`);
ok('同时只有一个键存活', ad.live.size === 1, `live=${[...ad.live]}`);

r = reg.register('');
ok('空值 = 主动关闭', r.ok && !r.hotkey, JSON.stringify(r));
ok('关闭后没有残留注册', ad.live.size === 0, `live=${[...ad.live]}`);
ok('reg.active 已清空', reg.active === '');

r = reg.register('Alt+Shift+A');
ok('关闭后还能重新开启', r.ok && ad.isRegistered('Alt+Shift+A'), JSON.stringify(r));

/* ---------- 3. 一开始就没有旧键可回滚 ---------- */
console.log('\n[3] 一开始就没有旧键可回滚');
const ad2 = makeAdapter();
const reg2 = createRegistrar(ad2, () => {}, () => {});
r = reg2.register('Ctrl+Alt+Q');
ok('失败且无旧键 → ok:false', r.ok === false, JSON.stringify(r));
ok('不崩、也没有任何键残留', ad2.live.size === 0, `live=${[...ad2.live]}`);
ok('active 为空', reg2.active === '', reg2.active);

/* ---------- 4. 重复注册同一个键 ---------- */
console.log('\n[4] 重复注册同一个键');
const ad3 = makeAdapter();
const reg3 = createRegistrar(ad3, () => {}, () => {});
reg3.register('Alt+Shift+A');
r = reg3.register('Alt+Shift+A');
ok('幂等：再注册一次仍成功', r.ok && ad3.live.size === 1, JSON.stringify(r));

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
