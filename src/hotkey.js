'use strict';
/**
 * 全局快捷键：安全校验 + 注册策略。
 *
 * 抽成独立模块有两个原因：
 *  1) 「先摘旧键再注册新键」这个顺序一旦写错，会静默把功能弄丢，值得单独测；
 *  2) 注册策略本身不依赖 Electron —— 注入一个 adapter 就能在纯 Node 下跑单测
 *     （见 scripts/hotkey-test.js）。
 */

const MODIFIERS = ['command', 'cmd', 'control', 'ctrl', 'commandorcontrol', 'cmdorctrl',
  'alt', 'option', 'altgr', 'shift', 'super', 'meta'];

const FKEY = /^F([1-9]|1[0-9]|2[0-4])$/;

/**
 * 这个快捷键是否「安全」。
 * 裸的字母 / 数字会被 Electron 注册成全局按键，直接把全系统的打字吞掉 —— 必须拦掉。
 * 规则：单键只允许 F1~F24；多键至少要有一个修饰键。
 */
function looksSafe(accel) {
  const parts = String(accel == null ? '' : accel)
    .split('+')
    .map((s) => s.trim())
    .filter(Boolean);
  if (!parts.length) return false;
  if (parts.length === 1) return FKEY.test(parts[0]);
  return parts.some((p) => MODIFIERS.includes(p.toLowerCase()));
}

/**
 * 创建一个快捷键注册器。
 *
 * @param adapter { register(accel, cb) -> bool, unregister(accel), isRegistered(accel) -> bool }
 * @param onFire  触发时的回调
 * @param log     日志函数（可选）
 */
function createRegistrar(adapter, onFire, log) {
  const say = log || (() => {});
  let active = '';

  const bind = (a) => {
    try {
      return !!adapter.register(a, onFire);
    } catch (e) {
      say('快捷键注册异常：', a, e.message);
      return false;
    }
  };

  return {
    /** 当前**实际注册成功**的键（可能和设置里的值不同） */
    get active() { return active; },

    /**
     * 注册快捷键。空值 = 主动关闭。
     *
     * ⚠️ 不能写成「先 unregisterAll 再注册新键」：新键若被别的程序占用，旧键已经没了，
     * 用户会从「快捷键冲突」直接变成「彻底没有快捷键」—— 改一次设置就把功能弄丢。
     * 正确顺序：先摘旧键 → 试新键 → 成功就完事，失败把旧键装回去。
     */
    register(accel) {
      const want = String(accel == null ? '' : accel).trim();

      // 空值 = 关闭快捷键
      if (!want) {
        if (active) { try { adapter.unregister(active); } catch (_) { /* ignore */ } }
        active = '';
        say('快捷键已关闭');
        return { ok: true, hotkey: '' };
      }

      if (!looksSafe(want)) {
        const error = `${want} 不是安全的快捷键：至少要带一个修饰键（Ctrl / Alt / Shift），或者用 F1~F24`;
        say('快捷键拒绝：', error);
        return { ok: false, hotkey: active, error, restored: active };
      }

      if (active === want && adapter.isRegistered(want)) {
        return { ok: true, hotkey: want };
      }

      // 先摘掉旧键，否则同一个键想重新注册会失败
      if (active) { try { adapter.unregister(active); } catch (_) { /* ignore */ } }

      if (bind(want)) {
        active = want;
        say('快捷键已注册：', want);
        return { ok: true, hotkey: want };
      }

      // 新键失败 → 把旧键装回去，别让用户彻底失去快捷键
      let restored = '';
      if (active) {
        if (bind(active)) restored = active;
        else active = '';
      }
      const error = `${want} 注册失败（可能被其他程序占用）`;
      say(error + (restored ? `，已恢复原快捷键 ${restored}` : ''));
      return { ok: false, hotkey: restored, error, restored };
    },
  };
}

module.exports = { looksSafe, createRegistrar, MODIFIERS, FKEY };
