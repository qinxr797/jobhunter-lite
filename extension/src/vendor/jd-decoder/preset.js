/*
 * 黑话翻译官在求职插件里的默认底线，照《求职标准.md》定：
 * 纯净版：不预设薪资底线和加分方向，大小周要你自己定、每家都问无责底薪、不接受外派出差。
 * 卡片默认收成右下角一个小章，免得挡住页面上的按钮。
 */
(function (root) {
  const JDD = (root.JDD = root.JDD || {});
  JDD.PRESET = {
    minK: 0,
    bigSmallWeek: 'ask',
    singleRestVeto: true,
    noTravel: true,
    fresh: false,
    alwaysAskBase: true,
    plus: [],
    minus: ['主播', '电话销售'],
    startCollapsed: true,
    embedded: true,
  };
})(typeof globalThis !== 'undefined' ? globalThis : window);
