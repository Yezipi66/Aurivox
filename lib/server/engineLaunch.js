// Engine launch defaults: version, half-precision flag.
// These are the values server.js passes to the engine spawner on cold start.
//
// 这里没有 device：运行设备属于「使用者每次合成时选哪块卡」，由合成页的设备
//   下拉喂进 call.args 里标了 role="device" 的那一格，形状由名片声明
//   （device_format 与 choices）。一旦在这里给一个全局默认值，它会被当成
//   「每台引擎的高级设置默认值」并进参数面板，界面上选中的卡永远被它盖掉；
//   而且 cuda 这个值在没装 CUDA 的机器上会让引擎当场崩。

const ENGINE_LAUNCH_DEFAULTS = {
  version: "v2Pro",
  is_half: true,
};

module.exports = { ENGINE_LAUNCH_DEFAULTS };
