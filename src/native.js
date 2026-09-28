'use strict';
/**
 * Windows 原生输入模拟：长截图时用来滚动目标窗口。
 * 通过 PowerShell 调 user32.dll 的 SetCursorPos / mouse_event。
 */
const { execFile } = require('child_process');

const isWin = process.platform === 'win32';

function ps(script) {
  return new Promise((resolve, reject) => {
    if (!isWin) return reject(new Error('长截图目前仅支持 Windows'));
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { windowsHide: true, timeout: 8000 },
      (err, stdout, stderr) => {
        if (err) reject(new Error((stderr || err.message || '').trim() || 'PowerShell 执行失败'));
        else resolve(String(stdout || '').trim());
      }
    );
  });
}

const PREFIX = `
$ErrorActionPreference='Stop'
Add-Type -Namespace SnapT -Name Win -MemberDefinition '
[DllImport("user32.dll")] public static extern bool SetCursorPos(int X, int Y);
[DllImport("user32.dll")] public static extern void mouse_event(uint dwFlags, uint dx, uint dy, int dwData, System.UIntPtr dwExtraInfo);
[DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(int x, int y);
' -ErrorAction SilentlyContinue
`;

/** 在物理像素坐标 (x,y) 处滚动滚轮；delta<0 向下 */
async function scrollAt(x, y, delta) {
  const script = `${PREFIX}
[SnapT.Win]::SetCursorPos(${Math.round(x)}, ${Math.round(y)}) | Out-Null
Start-Sleep -Milliseconds 30
[SnapT.Win]::mouse_event(0x0800, 0, 0, ${Math.round(delta)}, [System.UIntPtr]::Zero)
`;
  await ps(script);
  return true;
}

/** 探测是否可用 */
async function probe() {
  try {
    await ps(`${PREFIX}\nWrite-Output 'ok'`);
    return true;
  } catch (e) {
    return false;
  }
}

module.exports = { scrollAt, probe, isWin };
