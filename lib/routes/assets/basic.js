// 资产路由注册：GET /api/assets 返回扫描器列出的音色资产清单。
// 判据是 assetScanner.listVoiceAssets() 的返回，失败时转成 clientError 的文案。
// 只读资产列表，不写任何资产，落盘与备份都不在这里发生。
module.exports = function register(router, ctx) {
 const { assetScanner, clientError } = ctx;

router.get("/api/assets", (req, res) => {
 try {
 const assets = assetScanner.listVoiceAssets();
 res.json({ ok: true, assets });
 } catch (err) {
 res.status(500).json({ error: clientError(err) });
 }
});

 return router;
};
