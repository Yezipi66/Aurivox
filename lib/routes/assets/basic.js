// 角色列表。
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
