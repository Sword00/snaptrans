/* 工具栏图标 —— 全部 24x24，线宽 1.7，随 currentColor 变色 */
(function () {
  'use strict';
  const S = (inner, extra) =>
    `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" ` +
    `stroke-linecap="round" stroke-linejoin="round" ${extra || ''}>${inner}</svg>`;

  window.ICONS = {
    // 矩形
    rect: S('<rect x="3.6" y="5.8" width="16.8" height="12.4" rx="1.6"/>'),
    // 椭圆
    ellipse: S('<ellipse cx="12" cy="12" rx="8.4" ry="6.4"/>'),
    // 表情
    emoji: S(
      '<circle cx="12" cy="12" r="8.6"/>' +
      '<circle cx="9.2" cy="10.2" r="1.05" fill="currentColor" stroke="none"/>' +
      '<circle cx="14.8" cy="10.2" r="1.05" fill="currentColor" stroke="none"/>' +
      '<path d="M8.6 14.3c.9 1.35 2.05 2.02 3.4 2.02s2.5-.67 3.4-2.02"/>'
    ),
    // 箭头
    arrow: S('<path d="M5.4 18.6 18 6"/><path d="M11.4 6H18v6.6"/>'),
    // 画笔
    pen: S(
      '<path d="M4.2 19.8 4.9 15.6 15.5 5a2.05 2.05 0 0 1 2.9 0l.6.6a2.05 2.05 0 0 1 0 2.9L8.4 19.1z"/>' +
      '<path d="M13.8 6.7 17.3 10.2"/>'
    ),
    // 马赛克
    mosaic: S(
      '<rect x="3.6" y="3.6" width="7.2" height="7.2" rx="1"/>' +
      '<rect x="13.2" y="3.6" width="7.2" height="7.2" rx="1"/>' +
      '<rect x="3.6" y="13.2" width="7.2" height="7.2" rx="1"/>' +
      '<rect x="13.2" y="13.2" width="7.2" height="7.2" rx="1"/>' +
      '<path d="M12 3.6v16.8M3.6 12h16.8" opacity=".45"/>'
    ),
    // 文字
    text: S(
      '<path d="M5 6.6V4.8h14v1.8"/>' +
      '<path d="M12 4.8v14.4"/>' +
      '<path d="M8.8 19.2h6.4"/>'
    ),
    // 翻译（文A）
    translate: S(
      '<text x="2.6" y="12.4" font-size="10.5" font-weight="600" ' +
      'font-family="\'Microsoft YaHei\',\'PingFang SC\',sans-serif" fill="currentColor" stroke="none">文</text>' +
      '<text x="12.2" y="21.2" font-size="11" font-weight="700" ' +
      'font-family="Arial,Helvetica,sans-serif" fill="currentColor" stroke="none">A</text>'
    ),
    // 提取文字
    ocr: S(
      '<path d="M3.4 8.2V5.6a2.2 2.2 0 0 1 2.2-2.2h2.6"/>' +
      '<path d="M15.8 3.4h2.6a2.2 2.2 0 0 1 2.2 2.2v2.6"/>' +
      '<path d="M20.6 15.8v2.6a2.2 2.2 0 0 1-2.2 2.2h-2.6"/>' +
      '<path d="M8.2 20.6H5.6a2.2 2.2 0 0 1-2.2-2.2v-2.6"/>' +
      '<path d="M8.4 16.4 12 7.6l3.6 8.8"/>' +
      '<path d="M9.7 13.4h4.6"/>'
    ),
    // 长截图
    longshot: S(
      '<rect x="6.4" y="2.8" width="11.2" height="18.4" rx="1.6" stroke-dasharray="3 2.2"/>' +
      '<path d="M12 8.4v7.2"/><path d="M9.6 13.2 12 15.6l2.4-2.4"/>'
    ),
    // 撤销
    undo: S('<path d="M4.6 9.4h9.2a5 5 0 0 1 0 10H8.6"/><path d="M8.2 5.6 4.6 9.4l3.6 3.8"/>'),
    // 重做
    redo: S('<path d="M19.4 9.4H10.2a5 5 0 0 0 0 10h5.2"/><path d="M15.8 5.6 19.4 9.4l-3.6 3.8"/>'),
    // 保存
    save: S('<path d="M12 3.6v11"/><path d="M7.6 10.4 12 14.8l4.4-4.4"/><path d="M4.6 17.4v1.4a2 2 0 0 0 2 2h10.8a2 2 0 0 0 2-2v-1.4"/>'),
    // 贴图
    pin: S(
      '<path d="M9 3.6h6l-.8 5.2 3.2 3.2H6.6l3.2-3.2z"/>' +
      '<path d="M12 12v8.4"/>'
    ),
    // 复制/转发
    share: S('<path d="M13.4 5.2 20.4 12l-7 6.8v-4.1c-5 0-8.2 1.6-10.4 5 .6-6.2 4.2-10.3 10.4-10.6z"/>'),
    // 关闭
    close: S('<path d="M6.4 6.4 17.6 17.6"/><path d="M17.6 6.4 6.4 17.6"/>'),
    // 确认
    check: S('<path d="M5 12.6 10 17.6 19.4 6.8"/>'),
    // 放大镜（取色/像素尺寸）
    zoom: S('<circle cx="10.6" cy="10.6" r="6.4"/><path d="M15.4 15.4 20.6 20.6"/>'),
  };
})();
