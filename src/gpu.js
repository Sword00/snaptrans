'use strict';
/**
 * 统一的渲染后端配置。
 *
 * 截图工具并不需要 GPU 加速，而透明遮罩窗口 + 远程桌面 / 虚拟机 / 受限沙箱里，
 * GPU 进程很容易直接崩掉，表现为刷屏的
 *   GPU process exited unexpectedly ... FATAL: GPU process isn't usable. Goodbye.
 * 之后整个应用退出。默认走软件渲染，稳得多。
 *
 * 确实需要硬件加速时，设环境变量 SNAPTRANS_GPU=1 即可恢复。
 *
 * 必须在 app ready 之前调用。
 */
function configureGpu(app) {
  // 部分受限环境（容器 / CI / 被安全软件包裹的终端）里，渲染进程会因沙箱直接崩，
  // 表现为加载任何页面都报 ERR_FAILED (-2)。此时加 --no-sandbox 即可。
  if (process.env.SNAPTRANS_NO_SANDBOX === '1') {
    app.commandLine.appendSwitch('no-sandbox');
    console.log('[gpu] 已启用 --no-sandbox（SNAPTRANS_NO_SANDBOX=1）');
  }

  if (process.env.SNAPTRANS_GPU === '1') {
    console.log('[gpu] 使用硬件加速（SNAPTRANS_GPU=1）');
    return false;
  }
  app.disableHardwareAcceleration();
  app.commandLine.appendSwitch('disable-gpu');
  app.commandLine.appendSwitch('disable-gpu-compositing');
  app.commandLine.appendSwitch('disable-gpu-sandbox');
  app.commandLine.appendSwitch('disable-accelerated-2d-canvas');
  return true;
}

module.exports = { configureGpu };
